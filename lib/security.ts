import "server-only";
import { pbkdf2 } from "node:crypto";
import { cookies } from "next/headers";
import { bindings, ensureSchema } from "@/db/runtime";
import { id, sha256 } from "@/lib/token-crypto";
import { consumeRateLimit, rateLimitReached as reachedRateLimit, releaseRateLimit } from "@/lib/rate-limit";
import { isLocalDevelopmentRequest } from "@/lib/runtime/environment";

export { id, randomToken, sha256 } from "@/lib/token-crypto";

export const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_KEY_BYTES = 32;

export async function deriveSecret(value: string, salt: string) {
  const key = await new Promise<Buffer>((resolve, reject) => {
    pbkdf2(value, salt, PBKDF2_ITERATIONS, PBKDF2_KEY_BYTES, "sha256", (error, derivedKey) => {
      if (error) reject(error); else resolve(derivedKey);
    });
  });
  return key.toString("hex");
}

function equalConstantTime(left: string, right: string) {
  if (left.length !== right.length) return false;
  let value = 0;
  for (let i = 0; i < left.length; i += 1) value |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return value === 0;
}

export async function verifySecret(value: string, salt: string, expected: string) {
  return equalConstantTime(await deriveSecret(value, salt), expected);
}

export type TeacherIdentity = { id: string; email: string; displayName: string; source: "google" | "local" };

// 구글 OAuth 콜백이 검증한 이메일만 이 함수에 도달한다. 예전 SIWC의
// oai-* 헤더 신뢰 경로는 Sites 프록시 밖에서는 클라이언트가 헤더를 위조해
// 임의 교사로 로그인할 수 있으므로 복원하면 안 된다.
export async function upsertGoogleTeacher(email: string, displayName: string): Promise<TeacherIdentity | null> {
  await ensureSchema();
  const teacherId = id("teacher");
  await bindings().DB.prepare(
    `INSERT INTO teachers(id, email, display_name, credential_hash, credential_salt) VALUES (?, ?, ?, '', '') ON CONFLICT(email) DO UPDATE SET display_name = excluded.display_name`,
  ).bind(teacherId, email, displayName).run();
  const row = await bindings().DB.prepare(`SELECT id, email, display_name AS displayName FROM teachers WHERE email = ?`).bind(email).first<{ id: string; email: string; displayName: string }>();
  return row ? { ...row, source: "google" } : null;
}

export async function requireTeacher(): Promise<TeacherIdentity | null> {
  // 쿠키를 먼저 읽는다: 빌드 때 미리 그리는 페이지(/admin 등)가 여기서 동적 페이지로 판정돼, 빌드가 DB에 닿지 않는다.
  const token = (await cookies()).get("wiggle_teacher")?.value;
  if (!token) return null;
  await ensureSchema();
  const tokenHash = await sha256(token);
  const now = new Date().toISOString();
  const row = await bindings().DB.prepare(
    `SELECT t.id, t.email, t.display_name AS displayName FROM teacher_sessions s JOIN teachers t ON t.id = s.teacher_id WHERE s.token_hash = ? AND s.expires_at > ?`,
  ).bind(tokenHash, now).first<{ id: string; email: string; displayName: string }>();
  if (row) await bindings().DB.prepare(`UPDATE teacher_sessions SET last_used_at = ? WHERE token_hash = ?`).bind(now, tokenHash).run();
  return row ? { ...row, source: "local" } : null;
}

export function isLocalDemoRequest(request: Request) {
  return isLocalDevelopmentRequest(request);
}

export async function revokeTeacherSession() {
  const cookieStore = await cookies();
  const token = cookieStore.get("wiggle_teacher")?.value;
  if (token) await bindings().DB.prepare(`DELETE FROM teacher_sessions WHERE token_hash = ?`).bind(await sha256(token)).run();
  cookieStore.delete("wiggle_teacher");
}

export async function studentFromRequest(request: Request) {
  await ensureSchema();
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!token) return null;
  const tokenHash = await sha256(token);
  const now = new Date().toISOString();
  const row = await bindings().DB.prepare(
    `SELECT s.id, s.classroom_id AS classroomId, s.nickname, s.animal, c.display_name AS classroomName FROM device_sessions d JOIN student_profiles s ON s.id = d.student_id AND s.archived_at IS NULL JOIN classrooms c ON c.id = s.classroom_id AND c.active = 1 WHERE d.token_hash = ? AND d.expires_at > ? AND d.revoked_at IS NULL`,
  ).bind(tokenHash, now).first<{ id: string; classroomId: string; nickname: string; animal: string; classroomName: string }>();
  if (row) {
    await bindings().DB.batch([
      bindings().DB.prepare(`UPDATE device_sessions SET last_used_at = ? WHERE token_hash = ?`).bind(now, tokenHash),
      bindings().DB.prepare(`UPDATE student_profiles SET last_activity_at = ? WHERE id = ?`).bind(now, row.id),
    ]);
  }
  return row ?? null;
}

export function jsonError(message: string, status = 400) {
  return noStoreJson({ error: message }, { status });
}

export function noStoreJson(data: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("cache-control", "no-store, max-age=0");
  headers.set("pragma", "no-cache");
  return Response.json(data, { ...init, headers });
}

export function cleanText(value: unknown, max: number) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

export function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite === "cross-site") return false;
  return !origin || origin === new URL(request.url).origin;
}

// IP 판정은 의존성 0 모듈에 두어 테스트가 Next 런타임 없이 직접 검증할 수 있게 한다.
// (확장자를 붙여야 Node 타입 스트리핑에서도 이 파일을 직접 로드할 수 있다.)
export { clientIp } from "./client-ip.ts";

export async function rateLimit(key: string, max: number, seconds: number) {
  await ensureSchema();
  return consumeRateLimit(bindings().DB, key, max, seconds);
}

export async function rateLimitReached(key: string, max: number) {
  await ensureSchema();
  return reachedRateLimit(bindings().DB, key, max);
}

export async function clearRateLimit(key: string) {
  await ensureSchema();
  await releaseRateLimit(bindings().DB, key);
}
