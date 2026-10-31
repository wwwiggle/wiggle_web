import { isAdmin } from "@/lib/admin";
import { classroomProfileInput, type ClassroomProfile } from "@/lib/classroom-profile";
import { cookies } from "next/headers";
import { bindings, randomEntryCode } from "@/db/runtime";
import { bytesToDataUrl } from "@/lib/image-data";
import { ensureLocalAutoTeacher, ensureLocalTeacher } from "@/lib/dev-only/demo-seed";
import { issueTeacherSession } from "@/lib/auth/teacher-session";
import { cleanText, clientIp, id, isLocalDemoRequest, jsonError, noStoreJson, randomToken, rateLimit, requireTeacher, revokeTeacherSession, sameOrigin } from "@/lib/security";
import { prepareTeacherMessageInsert, validateTeacherMessageTarget } from "@/lib/teacher-messages";
import { createFamilyShare, revokeFamilyShare } from "@/lib/family-sharing";
import { activityLabel, DEFAULT_ACTIVITY_KEY, normalizeActivityKey } from "@/lib/lesson-content";
import { nicknameKeySql } from "@/lib/nickname";
import { rotateClassroomEntry, updateClassroomAdmission, upsertTeacherView } from "@/lib/teacher-classroom-mutations";
import { HAND_RAISE_TTL_MS, MARK_NOTE_MAX, validateMarkStrokes } from "@/lib/teacher-marks";

type ClassroomRow = { id: string; displayName: string; classCode: string; joinToken: string; admissionOpen: number; currentActivity: string; studentCount: number; updatedAt: string };

function presentClassroom<T extends { currentActivity: string }>(classroom: T) {
  const currentActivityKey = normalizeActivityKey(classroom.currentActivity);
  return { ...classroom, currentActivity: activityLabel(currentActivityKey), currentActivityKey, currentActivityLabel: activityLabel(currentActivityKey) };
}

function clientKey(request: Request, scope: string) {
  return `${scope}:${clientIp(request)}`;
}

async function localAutoTeacher(request: Request) {
  if (!isLocalDemoRequest(request)) return null;
  const teacher = await ensureLocalAutoTeacher();
  const session = await issueTeacherSession(teacher.id);
  (await cookies()).set("wiggle_teacher", session.token, {
    httpOnly: true,
    secure: false,
    sameSite: "strict",
    path: "/",
    expires: session.expires,
  });
  return { ...teacher, source: "local" as const };
}

async function uniqueClassCode() {
  const db = bindings().DB;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const code = String(1000 + Math.floor(Math.random() * 9000));
    const row = await db.prepare(`SELECT id FROM classrooms WHERE class_code = ?`).bind(code).first();
    if (!row) return code;
  }
  throw new Error("새 수업 코드를 만들지 못했어요.");
}

async function ownedClassroom(teacherId: string, classroomId: string) {
  const classroom = await bindings().DB.prepare(`SELECT id, display_name AS displayName, class_code AS classCode, join_token AS joinToken, admission_open AS admissionOpen, current_activity AS currentActivity FROM classrooms WHERE id = ? AND teacher_id = ? AND active = 1`).bind(classroomId, teacherId).first<{ id: string; displayName: string; classCode: string; joinToken: string; admissionOpen: number; currentActivity: string }>();
  return classroom ? presentClassroom(classroom) : null;
}

async function toDataUrl(key: string | null) {
  if (!key) return null;
  const object = await bindings().ARTWORKS.get(key);
  if (!object) return null;
  const bytes = new Uint8Array(await object.arrayBuffer());
  // 바이트마다 문자열을 이어 붙이면 썸네일 한 장에 수십만 번의 재할당이 생긴다.
  // 학생 수만큼 6초마다 반복되는 경로라 청크 변환(bytesToDataUrl)으로 CPU 시간을 줄인다.
  return bytesToDataUrl(bytes, object.httpMetadata?.contentType === "image/jpeg" ? "image/jpeg" : "image/png");
}

type ArtworkArchiveRow = {
  id: string; studentId: string; nickname: string; animal: string; seatNumber: number | null; realName: string | null;
  title: string; status: string; updatedAt: string; completedAt: string | null; imageKey: string | null;
};

// Keyset pagination keeps newly saved pictures at the start without shifting the next page.
// The cursor contains ordering values only; every page repeats the owner and active-roster checks.
function parseArchiveCursor(value: string | null): { updatedAt: string; id: string } | null | false {
  if (!value) return null;
  if (value.length > 512) return false;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!Array.isArray(parsed) || parsed.length !== 2) return false;
    const [updatedAt, artworkId] = parsed;
    if (typeof updatedAt !== "string" || !updatedAt || updatedAt.length > 40 || typeof artworkId !== "string" || !artworkId || artworkId.length > 80) return false;
    return { updatedAt, id: artworkId };
  } catch { return false; }
}

async function classroomArtworkArchive(url: URL, teacherId: string, classroomId: string) {
  const db = bindings().DB;
  const studentId = cleanText(url.searchParams.get("studentId"), 40);
  const cursor = parseArchiveCursor(url.searchParams.get("cursor"));
  if (cursor === false) return jsonError("작품 목록을 처음부터 다시 열어 주세요.");
  const limit = Math.min(48, Math.max(1, Number.parseInt(url.searchParams.get("limit") ?? "24", 10) || 24));
  const rosterWhere = `a.classroom_id = ? AND s.classroom_id = a.classroom_id AND s.archived_at IS NULL AND c.teacher_id = ? AND c.active = 1`;
  const rosterValues: (string | number)[] = [classroomId, teacherId];
  if (studentId) {
    const student = await db.prepare(`SELECT s.id FROM student_profiles s JOIN classrooms c ON c.id = s.classroom_id WHERE s.id = ? AND s.classroom_id = ? AND s.archived_at IS NULL AND c.teacher_id = ? AND c.active = 1`).bind(studentId, classroomId, teacherId).first();
    if (!student) return jsonError("이 학급의 학생 기록을 찾을 수 없어요.", 404);
  }
  const studentWhere = studentId ? " AND s.id = ?" : "";
  if (studentId) rosterValues.push(studentId);
  const filteredWhere = rosterWhere + studentWhere;
  const filteredValues = [...rosterValues];
  const cursorWhere = cursor ? " AND (a.updated_at < ? OR (a.updated_at = ? AND a.id < ?))" : "";
  const pageValues = [...filteredValues, ...(cursor ? [cursor.updatedAt, cursor.updatedAt, cursor.id] : []), limit + 1];
  const from = `FROM artworks a JOIN student_profiles s ON s.id = a.student_id JOIN classrooms c ON c.id = a.classroom_id`;
  const [rows, total] = await Promise.all([
    db.prepare(`SELECT a.id, a.student_id AS studentId, s.nickname, s.animal, s.seat_number AS seatNumber, s.real_name AS realName, a.title, a.status, a.updated_at AS updatedAt, a.completed_at AS completedAt, COALESCE(a.thumbnail_key, a.final_image_key) AS imageKey ${from} WHERE ${filteredWhere}${cursorWhere} ORDER BY a.updated_at DESC, a.id DESC LIMIT ?`).bind(...pageValues).all<ArtworkArchiveRow>(),
    db.prepare(`SELECT COUNT(*) AS count ${from} WHERE ${filteredWhere}`).bind(...filteredValues).first<{ count: number }>(),
  ]);
  const page = rows.results.slice(0, limit);
  const artworks = await Promise.all(page.map(async ({ imageKey, ...artwork }) => ({ ...artwork, thumbnail: await toDataUrl(imageKey) })));
  const hasMore = rows.results.length > limit;
  const last = page.at(-1);
  return noStoreJson({ artworks, total: Number(total?.count ?? 0), hasMore, nextCursor: hasMore && last ? Buffer.from(JSON.stringify([last.updatedAt, last.id])).toString("base64url") : null });
}

/* 선생님 미리보기의 거의 실시간 보기(2026-09-14). 썸네일(256px)이 아니라 그림 문서 자체를 내려
 * 선생님 화면이 같은 렌더러로 원본 크기로 다시 그린다. 미리보기가 열린 동안에만 3초마다 부른다.
 * 가장 최근 작품과, 그 작품에 보낸 가장 최근 표시(답 포함)를 함께 준다. */
async function liveStudentView(teacherId: string, classroomId: string, studentId: string, known: { artworkId: string; revision: number | null }) {
  const db = bindings().DB;
  const artwork = await db.prepare(`SELECT a.id, a.title, a.status, a.revision, a.updated_at AS updatedAt FROM artworks a JOIN student_profiles s ON s.id = a.student_id JOIN classrooms c ON c.id = s.classroom_id WHERE s.id = ? AND s.classroom_id = ? AND s.archived_at IS NULL AND a.classroom_id = s.classroom_id AND c.teacher_id = ? AND c.active = 1 ORDER BY a.updated_at DESC, a.id DESC LIMIT 1`).bind(studentId, classroomId, teacherId).first<{ id: string; title: string; status: string; revision: number; updatedAt: string }>();
  if (!artwork) {
    const student = await db.prepare(`SELECT 1 FROM student_profiles s JOIN classrooms c ON c.id = s.classroom_id WHERE s.id = ? AND s.classroom_id = ? AND s.archived_at IS NULL AND c.teacher_id = ? AND c.active = 1`).bind(studentId, classroomId, teacherId).first();
    return student ? noStoreJson({ artwork: null, mark: null }) : jsonError("이 학급의 학생 기록을 찾을 수 없어요.", 404);
  }
  // 선생님 화면은 1초마다 부른다. 이미 가진 저장 번호와 같으면 그림 문서(최대 1.25MB)를 다시 읽거나 보내지 않는다.
  const unchanged = known.artworkId === artwork.id && known.revision === artwork.revision;
  const [opsRow, mark] = await Promise.all([
    unchanged ? Promise.resolve(null) : db.prepare(`SELECT ops_json AS opsJson FROM artworks WHERE id = ?`).bind(artwork.id).first<{ opsJson: string }>(),
    db.prepare(`SELECT id, strokes_json AS strokesJson, note, answer, answered_at AS answeredAt, created_at AS createdAt FROM teacher_marks WHERE student_id = ? AND artwork_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`).bind(studentId, artwork.id).first<{ id: string; strokesJson: string; note: string; answer: string | null; answeredAt: string | null; createdAt: string }>(),
  ]);
  return noStoreJson({
    artwork: { ...artwork, document: opsRow ? JSON.parse(opsRow.opsJson) : null, unchanged },
    mark: mark ? { id: mark.id, strokes: JSON.parse(mark.strokesJson), note: mark.note, answer: mark.answer, answeredAt: mark.answeredAt, createdAt: mark.createdAt } : null,
  });
}

export async function GET(request: Request) {
  const teacher = await requireTeacher() ?? await localAutoTeacher(request);
  if (!teacher) return noStoreJson({ error: "교사 로그인이 필요해요.", localDemo: isLocalDemoRequest(request) }, { status: 401 });
  const url = new URL(request.url);
  const classroomId = cleanText(url.searchParams.get("classroomId"), 40);
  const db = bindings().DB;
  if (!classroomId) {
    const result = await db.prepare(`SELECT c.id, c.display_name AS displayName, c.class_code AS classCode, c.join_token AS joinToken, c.admission_open AS admissionOpen, c.current_activity AS currentActivity, c.updated_at AS updatedAt, COUNT(s.id) AS studentCount FROM classrooms c LEFT JOIN student_profiles s ON s.classroom_id = c.id AND s.archived_at IS NULL WHERE c.teacher_id = ? AND c.active = 1 GROUP BY c.id ORDER BY c.created_at DESC`).bind(teacher.id).all<ClassroomRow>();
    return noStoreJson({ teacher: { ...teacher, isAdmin: isAdmin(teacher) }, classrooms: result.results.map(presentClassroom) });
  }

  const classroom = await ownedClassroom(teacher.id, classroomId);
  if (!classroom) return jsonError("이 학급을 볼 권한이 없어요.", 403);
  if (url.searchParams.get("artworks") === "1") return classroomArtworkArchive(url, teacher.id, classroomId);
  const liveStudentId = cleanText(url.searchParams.get("liveStudentId"), 40);
  if (liveStudentId) {
    const knownRevision = Number.parseInt(url.searchParams.get("knownRevision") ?? "", 10);
    return liveStudentView(teacher.id, classroomId, liveStudentId, { artworkId: cleanText(url.searchParams.get("knownArtworkId"), 80), revision: Number.isInteger(knownRevision) ? knownRevision : null });
  }
  const historyStudentId = cleanText(url.searchParams.get("studentId"), 40);
  if (historyStudentId) {
    const ownedStudent = await db.prepare(`SELECT s.id, s.nickname, s.animal FROM student_profiles s JOIN classrooms c ON c.id = s.classroom_id WHERE s.id = ? AND s.classroom_id = ? AND s.archived_at IS NULL AND c.teacher_id = ? AND c.active = 1`).bind(historyStudentId, classroomId, teacher.id).first<{ id: string; nickname: string; animal: string }>();
    if (!ownedStudent) return jsonError("이 학급의 학생 기록을 찾을 수 없어요.", 404);
    const offset = Math.max(0, Number.parseInt(url.searchParams.get("historyOffset") ?? "0", 10) || 0);
    const pageSize = 12;
    const rows = await db.prepare(`SELECT a.id, a.title, a.topic, a.learning_mode AS learningMode, a.lesson_slug AS lessonSlug, a.status, a.current_step AS currentStep, a.updated_at AS updatedAt, a.completed_at AS completedAt, COALESCE(a.thumbnail_key, a.final_image_key) AS imageKey FROM artworks a WHERE a.student_id = ? AND a.classroom_id = ? ORDER BY a.updated_at DESC, a.id DESC LIMIT ? OFFSET ?`).bind(historyStudentId, classroomId, pageSize + 1, offset).all<{ id: string; title: string; topic: string; learningMode: string; lessonSlug: string | null; status: string; currentStep: number; updatedAt: string; completedAt: string | null; imageKey: string | null }>();
    const page = rows.results.slice(0, pageSize);
    const artworks = await Promise.all(page.map(async ({ imageKey, ...artwork }) => ({ ...artwork, thumbnail: await toDataUrl(imageKey) })));
    return noStoreJson({ student: ownedStudent, artworks, hasMore: rows.results.length > pageSize, nextOffset: offset + page.length });
  }
  type StudentRow = { id: string; nickname: string; animal: string; seatNumber: number | null; realName: string | null; entryCode: string | null; claimedAt: string | null; createdAt: string; lastActivityAt: string; artworkId: string | null; artworkTitle: string | null; status: string | null; currentStep: number | null; revision: number | null; thumbnailKey: string | null; handRaisedAt: string | null; artworkUpdatedAt: string | null; completedArtworkId: string | null; artworkCount: number; drawingArtworkCount: number; completedArtworkCount: number; duplicateNicknameCount: number };
  const students = await db.prepare(`SELECT s.id, s.nickname, s.animal, s.seat_number AS seatNumber, s.real_name AS realName, s.entry_code AS entryCode, s.claimed_at AS claimedAt, s.created_at AS createdAt, s.last_activity_at AS lastActivityAt, a.id AS artworkId, a.title AS artworkTitle, a.status, a.current_step AS currentStep, a.revision, a.thumbnail_key AS thumbnailKey, a.updated_at AS artworkUpdatedAt, (SELECT a3.id FROM artworks a3 WHERE a3.student_id = s.id AND a3.classroom_id = s.classroom_id AND a3.status = 'complete' AND a3.final_image_key IS NOT NULL ORDER BY a3.completed_at DESC, a3.id DESC LIMIT 1) AS completedArtworkId, (SELECT COUNT(*) FROM artworks ac WHERE ac.student_id = s.id AND ac.classroom_id = s.classroom_id) AS artworkCount, (SELECT COUNT(*) FROM artworks ad WHERE ad.student_id = s.id AND ad.classroom_id = s.classroom_id AND ad.status = 'drawing') AS drawingArtworkCount, (SELECT COUNT(*) FROM artworks af WHERE af.student_id = s.id AND af.classroom_id = s.classroom_id AND af.status = 'complete') AS completedArtworkCount, (SELECT COUNT(*) FROM student_profiles sd WHERE sd.classroom_id = s.classroom_id AND sd.archived_at IS NULL AND lower(${nicknameKeySql("sd.nickname")}) = lower(${nicknameKeySql("s.nickname")})) AS duplicateNicknameCount, h.raised_at AS handRaisedAt FROM student_profiles s LEFT JOIN hand_raises h ON h.student_id = s.id AND h.raised_at > ? LEFT JOIN artworks a ON a.id = (SELECT a2.id FROM artworks a2 WHERE a2.student_id = s.id ORDER BY a2.updated_at DESC LIMIT 1) WHERE s.classroom_id = ? AND s.archived_at IS NULL ORDER BY s.seat_number IS NULL, s.seat_number, lower(s.nickname), s.id`).bind(new Date(Date.now() - HAND_RAISE_TTL_MS).toISOString(), classroomId).all<StudentRow>();
  // 회차 개념이 사라져(2026-09-12) 오늘 수업은 학생별 **최근 그림**을 보여 준다.
  const thumbnailCache = new Map<string, Promise<string | null>>();
  const thumbnailFor = (key: string | null) => {
    if (!key) return Promise.resolve(null);
    if (!thumbnailCache.has(key)) thumbnailCache.set(key, toDataUrl(key));
    return thumbnailCache.get(key)!;
  };
  const hydrated = await Promise.all(students.results.map(async ({ thumbnailKey, duplicateNicknameCount, ...student }: StudentRow) => {
    const thumbnail = await thumbnailFor(thumbnailKey);
    const sessionArtwork = student.artworkId
      ? { id: student.artworkId, title: student.artworkTitle, status: student.status, currentStep: student.currentStep, revision: student.revision, updatedAt: student.artworkUpdatedAt, thumbnail }
      : null;
    return { ...student, duplicateNickname: duplicateNicknameCount > 1, thumbnail, sessionArtwork };
  }));
  const archivedStudents = await db.prepare(`SELECT s.id, s.nickname, s.animal, s.seat_number AS seatNumber, s.real_name AS realName, s.last_activity_at AS lastActivityAt, s.archived_at AS archivedAt, COUNT(a.id) AS artworkCount FROM student_profiles s LEFT JOIN artworks a ON a.student_id = s.id WHERE s.classroom_id = ? AND s.archived_at IS NOT NULL GROUP BY s.id ORDER BY s.archived_at DESC, lower(s.nickname)`).bind(classroomId).all<{ id: string; nickname: string; animal: string; seatNumber: number | null; realName: string | null; lastActivityAt: string; archivedAt: string; artworkCount: number }>();
  const messages = await db.prepare(`SELECT m.id, m.student_id AS studentId, m.body, m.created_at AS createdAt, s.nickname, COUNT(r.student_id) AS seenCount FROM teacher_messages m LEFT JOIN student_profiles s ON s.id = m.student_id LEFT JOIN message_receipts r ON r.message_id = m.id WHERE m.classroom_id = ? GROUP BY m.id, s.nickname ORDER BY m.created_at DESC, m.id DESC LIMIT 30`).bind(classroomId).all();
  const familyLinks = await db.prepare(`SELECT l.id, l.student_id AS studentId, l.scope, l.expires_at AS expiresAt, l.revoked_at AS revokedAt, l.created_at AS createdAt, COUNT(f.artwork_id) AS artworkCount FROM family_share_links l JOIN student_profiles s ON s.id = l.student_id LEFT JOIN family_share_artworks f ON f.link_id = l.id WHERE l.teacher_id = ? AND s.classroom_id = ? GROUP BY l.id ORDER BY l.created_at DESC LIMIT 50`).bind(teacher.id, classroomId).all();
  /* 지금 입장이 잠긴 기기 수. 손들기처럼 선생님이 알아차릴 수 있어야 한다(2026-09-22 사용자 결정) —
   * 잠금은 기기 단위라 누구인지는 알 수 없고, 몇 대가 막혀 있는지만 알린다. */
  const lockedRow = await db.prepare(`SELECT COUNT(*) AS n FROM entry_lockouts WHERE classroom_id = ? AND locked_until > ?`).bind(classroomId, new Date().toISOString()).first<{ n: number }>();
  // serverNow: 손든 뒤 얼마나 기다렸는지를 교사 화면이 서버 시계 기준으로 계산하게 한다.
  // 교사 기기 시계가 틀어져 있어도 "3분째"가 어긋나지 않는다.
  const profileRow = await db.prepare(`SELECT p.school_name AS schoolName, b.grade FROM classrooms c LEFT JOIN classroom_profiles p ON p.classroom_id = c.id LEFT JOIN classroom_book_settings b ON b.classroom_id = c.id WHERE c.id = ?`).bind(classroomId).first<{ schoolName: string | null; grade: number | null }>();
  return noStoreJson({ teacher: { ...teacher, isAdmin: isAdmin(teacher) }, classroom, profile: { schoolName: profileRow?.schoolName ?? "", grade: profileRow?.grade ?? null }, students: hydrated, archivedStudents: archivedStudents.results, messages: messages.results, familyLinks: familyLinks.results, entryLocks: lockedRow?.n ?? 0, serverNow: new Date().toISOString() });
}

/* 교사가 입력하는 학급 명단. 번호는 학급 안에서 고유하고, 실명은 담임에게만 보인다.
 * 상한을 두는 이유: 한 번의 요청으로 학급에 무한히 행을 넣지 못하게 한다. */
const MAX_ROSTER_SIZE = 60;
const MAX_SEAT_NUMBER = 99;
/* 아이가 첫 입장 때 직접 고르기 전까지 쓰는 자리표시. 아이 화면에 실명이 새지 않게
 * 번호만 쓴다. NOT NULL 컬럼이라 빈 값을 넣을 수 없다. */
const UNCLAIMED_ANIMAL = "❔";

type RosterEntry = { seatNumber: number; realName: string };

function parseRoster(value: unknown): { entries: RosterEntry[] } | { error: string } {
  if (!Array.isArray(value)) return { error: "명단을 확인해 주세요." };
  if (!value.length) return { error: "학생을 한 명 이상 넣어 주세요." };
  if (value.length > MAX_ROSTER_SIZE) return { error: `한 번에 ${MAX_ROSTER_SIZE}명까지 넣을 수 있어요.` };
  const entries: RosterEntry[] = [];
  const seen = new Set<number>();
  for (const raw of value) {
    if (!raw || typeof raw !== "object") return { error: "명단을 확인해 주세요." };
    const item = raw as { seatNumber?: unknown; realName?: unknown };
    const seatNumber = Number(item.seatNumber);
    if (!Number.isInteger(seatNumber) || seatNumber < 1 || seatNumber > MAX_SEAT_NUMBER) return { error: `번호는 1부터 ${MAX_SEAT_NUMBER}까지 적어 주세요.` };
    if (seen.has(seatNumber)) return { error: `${seatNumber}번이 두 번 있어요.` };
    seen.add(seatNumber);
    const realName = cleanText(item.realName, 20);
    if (realName.length < 1) return { error: `${seatNumber}번 이름을 적어 주세요.` };
    entries.push({ seatNumber, realName });
  }
  return { entries };
}

/** Writes (or, when updating, clears) the optional school name and grade. */
function classroomProfileStatements(db: ReturnType<typeof bindings>["DB"], classroomId: string, profile: ClassroomProfile, update = false) {
  const statements = [];
  if (profile.schoolName) statements.push(db.prepare(`INSERT INTO classroom_profiles(classroom_id, school_name) VALUES (?, ?) ON CONFLICT(classroom_id) DO UPDATE SET school_name = excluded.school_name`).bind(classroomId, profile.schoolName));
  else if (update) statements.push(db.prepare(`DELETE FROM classroom_profiles WHERE classroom_id = ?`).bind(classroomId));
  if (profile.grade !== null || update) statements.push(db.prepare(`INSERT INTO classroom_book_settings(classroom_id, grade) VALUES (?, ?) ON CONFLICT(classroom_id) DO UPDATE SET grade = excluded.grade, updated_at = CURRENT_TIMESTAMP`).bind(classroomId, profile.grade));
  return statements;
}

function insertRosterRow(db: ReturnType<typeof bindings>["DB"], classroomId: string, entry: RosterEntry, entryCode: string) {
  // 자리는 비어 있고(claimed_at NULL) 참여 코드가 붙어 있다. 아이는 이 코드 하나로 들어온다.
  return db.prepare(`INSERT INTO student_profiles(id, classroom_id, seat_number, real_name, entry_code, claimed_at, nickname, animal, last_activity_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`)
    .bind(id("student"), classroomId, entry.seatNumber, entry.realName, entryCode, `${entry.seatNumber}번`, UNCLAIMED_ANIMAL, new Date().toISOString());
}

/* 아이별 참여 코드 네 자리(2026-09-12에 여섯 자리에서 줄임). 반은 QR이나 수업 코드로 먼저
 * 정해지므로 코드는 학급 안에서만 겹치지 않으면 된다. 부분 유니크 인덱스가 뒤를 받치지만,
 * 배치 전체가 실패하지 않게 여기서 먼저 피한다. */
async function freshEntryCodes(db: ReturnType<typeof bindings>["DB"], classroomId: string, count: number) {
  const taken = await db.prepare(`SELECT entry_code AS entryCode FROM student_profiles WHERE classroom_id = ? AND archived_at IS NULL AND entry_code IS NOT NULL`).bind(classroomId).all<{ entryCode: string }>();
  const used = new Set(taken.results.map((row) => row.entryCode));
  const codes: string[] = [];
  while (codes.length < count) {
    const code = randomEntryCode();
    if (used.has(code)) continue;
    used.add(code); codes.push(code);
  }
  return codes;
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return jsonError("요청 출처를 확인할 수 없어요.", 403);
  const payload = await request.json().catch(() => ({})) as Record<string, unknown>;
  const action = cleanText(payload.action, 30);
  if (action === "login") {
    if (!isLocalDemoRequest(request)) return jsonError("배포 환경에서는 구글 로그인만 사용할 수 있어요.", 401);
    if (!(await rateLimit(clientKey(request, "teacher-login"), 8, 10 * 60))) return jsonError("잠시 후 다시 시도해 주세요.", 429);
    const email = cleanText(payload.email, 120).toLowerCase();
    const pin = cleanText(payload.pin, 32);
    if (!/^\S+@\S+\.\S+$/.test(email) || pin.length < 8) return jsonError("로컬 이메일과 8자 이상 PIN을 입력해 주세요.");
    const teacherId = await ensureLocalTeacher(email, pin, email.split("@")[0].slice(0, 40) || "로컬 선생님");
    if (!teacherId) return jsonError("이메일이나 접속 PIN을 확인해 주세요.", 401);
    const session = await issueTeacherSession(teacherId);
    (await cookies()).set("wiggle_teacher", session.token, { httpOnly: true, secure: new URL(request.url).protocol === "https:", sameSite: "strict", path: "/", expires: session.expires });
    return noStoreJson({ ok: true });
  }

  const teacher = await requireTeacher() ?? await localAutoTeacher(request);
  if (!teacher) return jsonError("교사 로그인이 필요해요.", 401);
  if (!(await rateLimit(`teacher-write:${teacher.id}`, 120, 60))) return jsonError("요청이 너무 빨라요. 잠깐 쉬어 주세요.", 429);
  const db = bindings().DB;

  if (action === "logout") {
    await revokeTeacherSession();
    return noStoreJson({ ok: true });
  }
  if (action === "createClassroom") {
    const displayName = cleanText(payload.displayName, 30);
    if (displayName.length < 2) return jsonError("학급 이름을 두 글자 이상 적어 주세요.");
    // 명단은 필수다. 입장은 명단의 번호로만 하므로, 명단 없는 학급은 아무도 못 들어온다.
    const parsedRoster = parseRoster(payload.roster);
    if ("error" in parsedRoster) return jsonError(parsedRoster.error);
    const roster = parsedRoster.entries;
    // 학교·학년은 선생님(성인)이 학급을 만들 때 한 번만 받는다(선택 항목). 학생은 입력하지 않고,
    // 학생 화면·ebook·AI 요청에는 싣지 않는다 — 인쇄 주문서 자동 채움과 수업 관리용이다(2026-10-31).
    const profile = classroomProfileInput(payload);
    if ("error" in profile) return jsonError(profile.error);
    const classroom = { id: id("class"), classCode: await uniqueClassCode(), joinToken: randomToken(18) };
    const codes = await freshEntryCodes(db, classroom.id, roster.length);
    await db.batch([
      db.prepare(`INSERT INTO classrooms(id, teacher_id, display_name, class_code, join_token, admission_open, active, current_activity) VALUES (?, ?, ?, ?, ?, 1, 1, ?)`).bind(classroom.id, teacher.id, displayName, classroom.classCode, classroom.joinToken, DEFAULT_ACTIVITY_KEY),
      ...roster.map((entry, index) => insertRosterRow(db, classroom.id, entry, codes[index])),
      ...classroomProfileStatements(db, classroom.id, profile),
    ]);
    // 참여 코드는 교사 화면(명단·코드표)에서만 본다. 학생 응답에는 절대 싣지 않는다.
    return noStoreJson({ classroom, rosterSize: roster.length, entryCodes: roster.map((entry, index) => ({ seatNumber: entry.seatNumber, entryCode: codes[index] })) }, { status: 201 });
  }

  const classroomId = cleanText(payload.classroomId, 40);
  const classroom = await ownedClassroom(teacher.id, classroomId);
  if (!classroom) return jsonError("이 학급을 바꿀 권한이 없어요.", 403);
  if (action === "deleteClassroom") {
    const results = await db.batch([
      db.prepare(`UPDATE classrooms SET active = 0, admission_open = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND teacher_id = ? AND active = 1`).bind(classroomId, teacher.id),
      db.prepare(`UPDATE device_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE revoked_at IS NULL AND student_id IN (SELECT id FROM student_profiles WHERE classroom_id = ?)`).bind(classroomId),
      db.prepare(`UPDATE family_share_links SET revoked_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE revoked_at IS NULL AND teacher_id = ? AND student_id IN (SELECT id FROM student_profiles WHERE classroom_id = ?)`).bind(teacher.id, classroomId),
      db.prepare(`DELETE FROM teacher_views WHERE classroom_id = ?`).bind(classroomId),
      db.prepare(`DELETE FROM hand_raises WHERE classroom_id = ?`).bind(classroomId),
    ]);
    return noStoreJson({ deleted: Boolean(results[0]?.meta.changes), classroomId });
  }
  if (action === "addStudents") {
    const parsed = parseRoster(payload.roster);
    if ("error" in parsed) return jsonError(parsed.error);
    // 이미 쓰고 있는 번호와 부딪히면 통째로 거절한다. 일부만 들어가면 교사가
    // 무엇이 들어갔는지 알 수 없어 명단이 조용히 어긋난다.
    const taken = await db.prepare(`SELECT seat_number AS seatNumber FROM student_profiles WHERE classroom_id = ? AND archived_at IS NULL AND seat_number IS NOT NULL`).bind(classroomId).all<{ seatNumber: number }>();
    const used = new Set(taken.results.map((row) => row.seatNumber));
    const clash = parsed.entries.find((entry) => used.has(entry.seatNumber));
    if (clash) return jsonError(`${clash.seatNumber}번은 이미 우리 반에 있어요.`, 409);
    if (used.size + parsed.entries.length > MAX_ROSTER_SIZE) return jsonError(`한 학급은 ${MAX_ROSTER_SIZE}명까지예요.`);
    const codes = await freshEntryCodes(db, classroomId, parsed.entries.length);
    await db.batch(parsed.entries.map((entry, index) => insertRosterRow(db, classroomId, entry, codes[index])));
    return noStoreJson({ added: parsed.entries.length }, { status: 201 });
  }
  if (action === "updateClassroomProfile") {
    const profile = classroomProfileInput(payload);
    if ("error" in profile) return jsonError(profile.error);
    await db.batch(classroomProfileStatements(db, classroomId, profile, true));
    return noStoreJson({ ok: true, profile });
  }
  if (action === "updateStudent") {
    const studentId = cleanText(payload.studentId, 40);
    const parsed = parseRoster([{ seatNumber: payload.seatNumber, realName: payload.realName }]);
    if ("error" in parsed) return jsonError(parsed.error);
    const [entry] = parsed.entries;
    const clash = await db.prepare(`SELECT id FROM student_profiles WHERE classroom_id = ? AND seat_number = ? AND archived_at IS NULL AND id <> ?`).bind(classroomId, entry.seatNumber, studentId).first<{ id: string }>();
    if (clash) return jsonError(`${entry.seatNumber}번은 이미 우리 반에 있어요.`, 409);
    // 아이가 고른 별명은 건드리지 않는다. 아직 아무도 안 쓴 자리만 번호 표시를 따라 바꾼다.
    const updated = await db.prepare(`UPDATE student_profiles SET seat_number = ?, real_name = ?, nickname = CASE WHEN claimed_at IS NULL THEN ? ELSE nickname END WHERE id = ? AND classroom_id = ? AND archived_at IS NULL AND EXISTS (SELECT 1 FROM classrooms c WHERE c.id = student_profiles.classroom_id AND c.teacher_id = ? AND c.active = 1)`).bind(entry.seatNumber, entry.realName, `${entry.seatNumber}번`, studentId, classroomId, teacher.id).run();
    if (!updated.meta.changes) return jsonError("고칠 학생을 찾지 못했어요.", 404);
    return noStoreJson({ updated: true, studentId });
  }
  if (action === "archiveStudent") {
    const studentId = cleanText(payload.studentId, 40);
    const activeOwnedStudent = `EXISTS (SELECT 1 FROM classrooms c WHERE c.id = student_profiles.classroom_id AND c.teacher_id = ? AND c.active = 1)`;
    const results = await db.batch([
      // 클라이언트가 new Date()로 파싱하므로 ISO-8601로 저장한다. CURRENT_TIMESTAMP의
      // 'YYYY-MM-DD HH:MM:SS'는 Safari에서 Invalid Date, V8에서는 로컬 시각으로 오독된다.
      db.prepare(`UPDATE student_profiles SET archived_at = ? WHERE id = ? AND classroom_id = ? AND archived_at IS NULL AND ${activeOwnedStudent}`).bind(new Date().toISOString(), studentId, classroomId, teacher.id),
      db.prepare(`UPDATE device_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE student_id = ? AND revoked_at IS NULL AND EXISTS (SELECT 1 FROM student_profiles s JOIN classrooms c ON c.id = s.classroom_id WHERE s.id = ? AND s.classroom_id = ? AND s.archived_at IS NOT NULL AND c.teacher_id = ? AND c.active = 1)`).bind(studentId, studentId, classroomId, teacher.id),
      db.prepare(`UPDATE family_share_links SET revoked_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE student_id = ? AND teacher_id = ? AND revoked_at IS NULL AND EXISTS (SELECT 1 FROM student_profiles s WHERE s.id = ? AND s.classroom_id = ? AND s.archived_at IS NOT NULL)`).bind(studentId, teacher.id, studentId, classroomId),
      db.prepare(`DELETE FROM teacher_views WHERE student_id = ? AND classroom_id = ? AND teacher_id = ?`).bind(studentId, classroomId, teacher.id),
      db.prepare(`DELETE FROM hand_raises WHERE student_id = ? AND classroom_id = ?`).bind(studentId, classroomId),
    ]);
    if (!results[0]?.meta.changes) return jsonError("삭제할 학생을 찾지 못했어요.", 404);
    return noStoreJson({ archived: true, studentId });
  }
  if (action === "restoreStudent") {
    const studentId = cleanText(payload.studentId, 40);
    const restored = await db.prepare(`UPDATE student_profiles SET archived_at = NULL, last_activity_at = ? WHERE id = ? AND classroom_id = ? AND archived_at IS NOT NULL AND EXISTS (SELECT 1 FROM classrooms c WHERE c.id = student_profiles.classroom_id AND c.teacher_id = ? AND c.active = 1)`).bind(new Date().toISOString(), studentId, classroomId, teacher.id).run();
    if (!restored.meta.changes) return jsonError("복원할 학생을 찾지 못했어요.", 404);
    return noStoreJson({ restored: true, studentId });
  }
  if (action === "createFamilyShare") {
    const studentId = cleanText(payload.studentId, 40);
    const artworkIds = Array.isArray(payload.artworkIds) ? payload.artworkIds.map((value) => cleanText(value, 80)).filter(Boolean) : [];
    const result = await createFamilyShare(db, { teacherId: teacher.id, classroomId, studentId, artworkIds, guardianConsentConfirmed: payload.guardianConsentConfirmed === true, consentMethod: cleanText(payload.consentMethod, 30), expiresInDays: Number(payload.expiresInDays) || 7 });
    if (!result.ok) return jsonError(result.reason === "guardian_consent_required" ? "확인된 보호자 사전 동의 기록이 필요해요." : result.reason === "invalid_consent_method" ? "보호자 동의 확인 방법을 다시 골라 주세요." : result.reason === "artwork_forbidden" ? "완성되고 승인할 작품만 공유할 수 있어요." : result.reason === "invalid_scope" ? "공유할 작품을 다시 골라 주세요." : "가족 링크를 만들 권한이 없어요.", result.reason === "forbidden" ? 403 : 400);
    return noStoreJson({ share: { id: result.linkId, token: result.inviteToken, scope: result.scope, linkExpiresAt: result.expiresAt, inviteExpiresAt: result.inviteExpiresAt } }, { status: 201 });
  }
  if (action === "revokeFamilyShare") {
    const revoked = await revokeFamilyShare(db, { teacherId: teacher.id, classroomId, linkId: cleanText(payload.linkId, 50) });
    if (!revoked) return jsonError("취소할 가족 링크를 찾지 못했어요.", 404);
    return noStoreJson({ revoked: true });
  }
  if (action === "sendMessage") {
    const studentId = cleanText(payload.studentId, 40) || null;
    const validated = await validateTeacherMessageTarget(db, { teacherId: teacher.id, classroomId, studentId, body: payload.body });
    if (!validated.ok && validated.reason === "empty_body") return jsonError("보낼 말을 적어 주세요.");
    if (!validated.ok) return jsonError(validated.reason === "student_forbidden" ? "이 학급 학생이 아니에요." : "이 학급을 바꿀 권한이 없어요.", 403);
    const inserted = await prepareTeacherMessageInsert(db, validated.target).run();
    if (!inserted.meta.changes) return jsonError("메시지 대상을 다시 확인해 주세요.", 403);
    // 한 아이에게 말을 건넸으면 그 아이의 든 손에 답한 것이다.
    if (studentId) await db.prepare(`DELETE FROM hand_raises WHERE student_id = ? AND classroom_id = ?`).bind(studentId, classroomId).run();
    return noStoreJson({ messageId: validated.target.messageId }, { status: 201 });
  }
  if (action === "toggleAdmission") {
    const updated = await updateClassroomAdmission(db, { teacherId: teacher.id, classroomId, open: Boolean(payload.open) });
    if (!updated) return jsonError("활성 학급을 다시 확인해 주세요.", 403);
    return noStoreJson({ open: Boolean(payload.open) });
  }
  if (action === "rotateCode") {
    const classCode = await uniqueClassCode();
    const joinToken = randomToken(18);
    const updated = await rotateClassroomEntry(db, { teacherId: teacher.id, classroomId, classCode, joinToken });
    if (!updated) return jsonError("활성 학급을 다시 확인해 주세요.", 403);
    return noStoreJson({ classCode, joinToken });
  }
  if (action === "viewStudent") {
    const studentId = cleanText(payload.studentId, 40);
    const student = await db.prepare(`SELECT id FROM student_profiles WHERE id = ? AND classroom_id = ? AND archived_at IS NULL`).bind(studentId, classroomId).first();
    if (!student) return jsonError("이 학급 학생이 아니에요.", 403);
    const expiresAt = new Date(Date.now() + 20_000).toISOString();
    const viewed = await upsertTeacherView(db, { teacherId: teacher.id, classroomId, studentId, expiresAt });
    if (!viewed) return jsonError("활성 학급의 학생을 다시 확인해 주세요.", 403);
    return noStoreJson({ viewing: true, expiresAt });
  }
  if (action === "sendMark") {
    // 선생님 표시: 그리는 중인 그림에만 보낸다. 아이 원본 ops는 건드리지 않는다.
    const studentId = cleanText(payload.studentId, 40);
    const artworkId = cleanText(payload.artworkId, 80);
    const strokes = validateMarkStrokes(payload.strokes);
    if (!strokes) return jsonError("표시를 다시 그려 주세요.");
    const note = cleanText(payload.note, MARK_NOTE_MAX);
    const target = await db.prepare(`SELECT a.status FROM artworks a JOIN student_profiles s ON s.id = a.student_id JOIN classrooms c ON c.id = s.classroom_id WHERE a.id = ? AND s.id = ? AND s.classroom_id = ? AND a.classroom_id = s.classroom_id AND s.archived_at IS NULL AND c.teacher_id = ? AND c.active = 1`).bind(artworkId, studentId, classroomId, teacher.id).first<{ status: string }>();
    if (!target) return jsonError("이 학급 학생의 그림이 아니에요.", 403);
    if (target.status === "complete") return jsonError("완성한 그림에는 표시를 보낼 수 없어요.", 409);
    const markId = id("mark");
    const now = new Date().toISOString();
    // 아이 화면에는 한 번에 표시 하나만 뜬다. 답하지 않은 옛 표시는 새 표시로 바뀐 것으로 닫는다.
    await db.batch([
      db.prepare(`UPDATE teacher_marks SET answer = 'replaced', answered_at = ? WHERE student_id = ? AND answered_at IS NULL`).bind(now, studentId),
      db.prepare(`INSERT INTO teacher_marks(id, classroom_id, student_id, teacher_id, artwork_id, strokes_json, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(markId, classroomId, studentId, teacher.id, artworkId, JSON.stringify(strokes), note, now),
      // 표시를 보냈으면 선생님이 손든 아이에게 답한 것이다.
      db.prepare(`DELETE FROM hand_raises WHERE student_id = ? AND classroom_id = ?`).bind(studentId, classroomId),
    ]);
    return noStoreJson({ markId, createdAt: now }, { status: 201 });
  }
  if (action === "clearMark") {
    const studentId = cleanText(payload.studentId, 40);
    await db.prepare(`UPDATE teacher_marks SET answer = 'cleared', answered_at = ? WHERE student_id = ? AND classroom_id = ? AND answered_at IS NULL`).bind(new Date().toISOString(), studentId, classroomId).run();
    return noStoreJson({ cleared: true });
  }
  /* 입장 잠금 풀기(2026-09-21). 잠금은 기기 단위라 서버가 어느 아이인지 알 수 없다 —
   * 그래서 이 학급에서 걸린 잠금을 한꺼번에 푼다. 3분을 기다리게 두면 아이가 수업에서 빠진다. */
  if (action === "clearEntryLocks") {
    const result = await db.prepare(`DELETE FROM entry_lockouts WHERE classroom_id = ?`).bind(classroomId).run();
    // 이 반 참여 코드의 틀린 시도 상한(학급+IP 단위)도 함께 비운다. 접두어 비교라 다른 반 계수는 남는다.
    const failurePrefix = `entry-fail:seatCode:${classroomId}:`;
    await db.prepare(`DELETE FROM rate_limits WHERE substr(key, 1, ?) = ?`).bind(failurePrefix.length, failurePrefix).run();
    return noStoreJson({ cleared: result.meta.changes ?? 0 });
  }

  if (action === "lowerHand") {
    const studentId = cleanText(payload.studentId, 40);
    await db.prepare(`DELETE FROM hand_raises WHERE student_id = ? AND classroom_id = ?`).bind(studentId, classroomId).run();
    return noStoreJson({ lowered: true });
  }
  if (action === "rotateEntryCode") {
    // 코드 종이가 새어 나갔거나 잃어버렸을 때 교사가 그 아이 코드만 새로 뽑는다. 그림·별명은 그대로다.
    const studentId = cleanText(payload.studentId, 40);
    const [entryCode] = await freshEntryCodes(db, classroomId, 1);
    const updated = await db.prepare(`UPDATE student_profiles SET entry_code = ? WHERE id = ? AND classroom_id = ? AND archived_at IS NULL AND EXISTS (SELECT 1 FROM classrooms c WHERE c.id = student_profiles.classroom_id AND c.teacher_id = ? AND c.active = 1)`).bind(entryCode, studentId, classroomId, teacher.id).run();
    if (!updated.meta.changes) return jsonError("활성 학급의 학생을 다시 확인해 주세요.", 403);
    return noStoreJson({ studentId, entryCode });
  }
  return jsonError("지원하지 않는 요청이에요.");
}
