import { requestListRow, type PrintRequest } from "@/lib/print-requests";
import os from "node:os";
import { bindings } from "@/db/runtime";
import { requireAdmin } from "@/lib/admin";
import { jsonError, noStoreJson, sameOrigin, rateLimit } from "@/lib/security";
import { runtimeEnvironment } from "@/lib/runtime/environment";
let sample: { idle: number; total: number; cpu: NodeJS.CpuUsage; time: number } | null = null;
function resources() {
  const cpus = os.cpus(), idle = cpus.reduce((n, c) => n + c.times.idle, 0), total = cpus.reduce((n, c) => n + Object.values(c.times).reduce((a, b) => a + b, 0), 0);
  const now = Date.now(), cpu = process.cpuUsage(), previous = sample;
  sample = { idle, total, cpu, time: now };
  const hosted = ["production", "preview"].includes(runtimeEnvironment());
  const cpuPercent = previous && now > previous.time ? hosted ? Math.min(100, ((cpu.user - previous.cpu.user + cpu.system - previous.cpu.system) / ((now - previous.time) * 1000 * Math.max(1, cpus.length))) * 100) : total > previous.total ? 100 * (1 - (idle - previous.idle) / (total - previous.total)) : null : null;
  const totalMemory = os.totalmem(), usedMemory = hosted ? process.memoryUsage().rss : totalMemory - os.freemem();
  // os.totalmem in serverless may describe a shared host, not the function allocation.
  const allocationMb = Number(process.env.AWS_LAMBDA_FUNCTION_MEMORY_SIZE ?? process.env.ADMIN_FUNCTION_MEMORY_MB);
  const memoryLimit = hosted ? Number.isFinite(allocationMb) && allocationMb > 0 ? allocationMb * 1024 * 1024 : null : totalMemory;
  return { scope: hosted ? "현재 함수 인스턴스 (전체 Vercel 사용량 아님)" : "로컬 서버 전체", cores: cpus.length, cpuPercent, usedMemory, memoryLimit, ramPercent: memoryLimit ? usedMemory / memoryLimit * 100 : null, processRss: process.memoryUsage().rss, sampledAt: now };
}
export async function GET() {
  if (!await requireAdmin()) return jsonError("관리자 계정으로 로그인해 주세요.", 403);
  const db = bindings().DB, cutoff = Date.now() - 90_000;
  const teachers = await db.prepare(`SELECT t.id, t.email, t.display_name AS name, t.created_at AS createdAt, (SELECT COUNT(*) FROM classrooms c WHERE c.teacher_id = t.id AND c.active = 1) AS classroomCount, EXISTS(SELECT 1 FROM participant_presence p WHERE p.actor_key = 'teacher:' || t.id AND p.seen_at > ?) AS online FROM teachers t ORDER BY t.created_at DESC`).bind(cutoff).all();
  const classrooms = await db.prepare(`SELECT c.id, c.display_name AS name, c.active, t.display_name AS teacherName, t.email, p.school_name AS school, b.grade, b.class_number AS classNumber, COUNT(s.id) AS rosterCount, SUM(CASE WHEN s.claimed_at IS NOT NULL THEN 1 ELSE 0 END) AS joinedCount, SUM(CASE WHEN presence.seen_at > ? AND c.active = 1 THEN 1 ELSE 0 END) AS onlineCount FROM classrooms c JOIN teachers t ON t.id = c.teacher_id LEFT JOIN classroom_profiles p ON p.classroom_id = c.id LEFT JOIN classroom_book_settings b ON b.classroom_id = c.id LEFT JOIN student_profiles s ON s.classroom_id = c.id AND s.archived_at IS NULL LEFT JOIN participant_presence presence ON presence.actor_key = 'student:' || s.id GROUP BY c.id, t.display_name, t.email, p.school_name, b.grade, b.class_number ORDER BY c.created_at DESC`).bind(cutoff).all();
  const participants = await db.prepare(`SELECT s.id, s.nickname, s.seat_number AS seatNumber, s.classroom_id AS classroomId, p.seen_at AS seenAt FROM participant_presence p JOIN student_profiles s ON p.actor_key = 'student:' || s.id JOIN classrooms c ON c.id = s.classroom_id WHERE p.seen_at > ? AND s.archived_at IS NULL AND c.active = 1 ORDER BY s.classroom_id, s.seat_number`).bind(cutoff).all();
  const orders = await db.prepare(`SELECT id, teacher_id, classroom_id, environment, document_json, status, provider_json, error, created_at FROM print_requests ORDER BY created_at DESC LIMIT 200`).all<PrintRequest>();
  const setting = await db.prepare(`SELECT value_json FROM operations_settings WHERE id = 'capacity'`).first<{ value_json: string }>();
  return noStoreJson({ teachers: teachers.results, classrooms: classrooms.results, participants: participants.results, orders: orders.results.map(requestListRow), resources: resources(), capacity: setting ? JSON.parse(setting.value_json) : null, presenceWindowSeconds: 90 });
}
export async function POST(request: Request) {
  if (!sameOrigin(request)) return jsonError("요청 출처 오류", 403);
  const admin = await requireAdmin(); if (!admin) return jsonError("관리자 권한이 필요해요.", 403);
  if (!await rateLimit(`admin-settings:${admin.id}`, 10, 60)) return jsonError("잠시 후 다시 시도해 주세요.", 429);
  const body = await request.json().catch(() => null) as { maximum: number; basis: string } | null;
  if (!body || !Number.isInteger(body.maximum) || body.maximum < 1 || body.maximum > 100000 || typeof body.basis !== "string" || body.basis.trim().length < 3 || body.basis.length > 500) return jsonError("최대 인원과 부하 테스트 근거를 입력해 주세요.");
  await bindings().DB.prepare(`INSERT INTO operations_settings(id, value_json) VALUES ('capacity', ?) ON CONFLICT(id) DO UPDATE SET value_json = excluded.value_json`).bind(JSON.stringify({ maximum: body.maximum, basis: body.basis.trim(), updatedAt: new Date().toISOString(), updatedBy: admin.email })).run();
  return noStoreJson({ ok: true });
}
