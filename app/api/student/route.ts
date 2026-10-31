import { bindings, ensureSchema } from "@/db/runtime";
import { cleanText, clientIp, isLocalDemoRequest, jsonError, noStoreJson, randomToken, rateLimit, sameOrigin, sha256, studentFromRequest } from "@/lib/security";
import { decayedStrikes, failLimitFor, lockMessage, lockRemainingSeconds, lockSecondsFor, normalizeDeviceKey } from "@/lib/entry-lockout";
import { FALLBACK_NICKNAME, NICKNAME_IDEAS } from "@/lib/nickname-ideas";
import { activityLabel, normalizeActivityKey } from "@/lib/lesson-content";
import { ensureLocalStorybookStudent } from "@/lib/dev-only/demo-seed";
import { HAND_RAISE_TTL_MS, isMarkAnswer } from "@/lib/teacher-marks";

async function prepareDeviceSession() {
  const token = randomToken(32); const now = new Date();
  const expiresAt = new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString();
  const tokenHash = await sha256(token);
  const lastUsedAt = now.toISOString();
  return { token, expiresAt, tokenHash, lastUsedAt };
}

async function issueDeviceSession(studentId: string) {
  const db = bindings().DB;
  const device = await prepareDeviceSession();
  const inserted = await db.prepare(`INSERT INTO device_sessions(token_hash, student_id, expires_at, last_used_at) SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM student_profiles s JOIN classrooms c ON c.id = s.classroom_id WHERE s.id = ? AND s.archived_at IS NULL AND c.active = 1)`).bind(device.tokenHash, studentId, device.expiresAt, device.lastUsedAt, studentId).run();
  if (!inserted.meta.changes) return null;
  return { token: device.token, expiresAt: device.expiresAt };
}

async function classroomForEntry(codeOrToken: string) {
  return bindings().DB.prepare(`SELECT id, display_name AS displayName, class_code AS classCode, admission_open AS admissionOpen FROM classrooms WHERE active = 1 AND (class_code = ? OR join_token = ?)`).bind(codeOrToken, codeOrToken).first<{ id: string; displayName: string; classCode: string; admissionOpen: number }>();
}

// 학교 Wi-Fi는 NAT 뒤라 한 학급 전체가 공인 IP 하나로 보인다. IP 한도는 학급 규모를
// 견딜 만큼 넉넉히 두고, 무차별 대입은 대상(학생·프로필) 단위 한도로 막는다.
const IP_ENTRY_LIMIT = 180;
const IP_ENTRY_WINDOW_SECONDS = 10 * 60;
const CLASSROOM_JOIN_LIMIT = 60;

const requestIp = clientIp;
function entryRateKey(request: Request) { return `student-entry:${requestIp(request)}`; }
function ipAllowed(request: Request) { return rateLimit(entryRateKey(request), IP_ENTRY_LIMIT, IP_ENTRY_WINDOW_SECONDS); }
function presentedToken(request: Request) { return request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? ""; }

export async function GET(request: Request) {
  const student = await studentFromRequest(request);
  if (!student) return jsonError("이 기기의 학생 정보를 찾지 못했어요.", 401);
  const db = bindings().DB;
  const url = new URL(request.url);
  const artworkOffset = Math.max(0, Number.parseInt(url.searchParams.get("artworkOffset") ?? "0", 10) || 0);
  const artworkPageSize = 40;
  // 학생 홈은 12초마다 이 응답을 다시 부른다. 서로 의존하지 않는 조회를 순서대로 await 하면
  // D1 왕복이 그대로 쌓이므로 한 번에 보내고, 현재 활동 작품만 학급 활동을 읽은 뒤 이어서 조회한다.
  const now = new Date().toISOString();
  const [artworkRows, classroom, latestUnfinishedArtwork, artworkTotalRow, messages, teacherView, markRow, handRow] = await Promise.all([
    db.prepare(`SELECT id, title, topic, learning_mode AS learningMode, lesson_slug AS lessonSlug, status, current_step AS currentStep, revision, CASE WHEN thumbnail_key IS NOT NULL OR final_image_key IS NOT NULL THEN 1 ELSE 0 END AS hasImage, updated_at AS updatedAt, completed_at AS completedAt FROM artworks WHERE student_id = ? ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`).bind(student.id, artworkPageSize + 1, artworkOffset).all(),
    db.prepare(`SELECT current_activity AS currentActivity FROM classrooms WHERE id = ?`).bind(student.classroomId).first<{ currentActivity: string }>(),
    db.prepare(`SELECT id, title, learning_mode AS learningMode, lesson_slug AS lessonSlug, status, current_step AS currentStep, updated_at AS updatedAt FROM artworks WHERE student_id = ? AND status <> 'complete' ORDER BY updated_at DESC, id DESC LIMIT 1`).bind(student.id).first(),
    db.prepare(`SELECT COUNT(*) AS count FROM artworks WHERE student_id = ?`).bind(student.id).first<{ count: number }>(),
    db.prepare(`SELECT id, body, createdAt, audience, seenAt FROM (SELECT m.id, m.body, m.created_at AS createdAt, CASE WHEN m.student_id IS NULL THEN 'all' ELSE 'student' END AS audience, r.seen_at AS seenAt FROM teacher_messages m LEFT JOIN message_receipts r ON r.message_id = m.id AND r.student_id = ? WHERE m.classroom_id = ? AND (m.student_id IS NULL OR m.student_id = ?) ORDER BY m.created_at DESC, m.id DESC LIMIT 50) recent ORDER BY createdAt ASC, id ASC`).bind(student.id, student.classroomId, student.id).all<{ id: string; body: string; createdAt: string; audience: string; seenAt: string | null }>(),
    db.prepare(`SELECT 1 FROM teacher_views WHERE student_id = ? AND classroom_id = ? AND expires_at > ? LIMIT 1`).bind(student.id, student.classroomId, now).first(),
    // 선생님 표시는 답하지 않은 가장 최근 것 하나만 아이 화면에 뜬다. 선생님 실명·학급 명단은 싣지 않는다.
    db.prepare(`SELECT id, artwork_id AS artworkId, strokes_json AS strokesJson, note, created_at AS createdAt FROM teacher_marks WHERE student_id = ? AND classroom_id = ? AND answered_at IS NULL ORDER BY created_at DESC, id DESC LIMIT 1`).bind(student.id, student.classroomId).first<{ id: string; artworkId: string; strokesJson: string; note: string; createdAt: string }>(),
    db.prepare(`SELECT 1 FROM hand_raises WHERE student_id = ? AND raised_at > ? LIMIT 1`).bind(student.id, new Date(Date.now() - HAND_RAISE_TTL_MS).toISOString()).first(),
  ]);
  const artworks = artworkRows.results.slice(0, artworkPageSize);
  const currentActivityKey = normalizeActivityKey(classroom?.currentActivity);
  // 레슨 카탈로그·커리큘럼 은퇴 — 활동은 free 하나뿐이라 최근 그림만 조회한다.
  const currentActivityArtwork = await db.prepare(`SELECT id, title, learning_mode AS learningMode, lesson_slug AS lessonSlug, status, current_step AS currentStep, updated_at AS updatedAt FROM artworks WHERE student_id = ? AND learning_mode = 'free' ORDER BY updated_at DESC, id DESC LIMIT 1`).bind(student.id).first();
  const artworkTotal = Number(artworkTotalRow?.count ?? 0);
  const teacherViewing = Boolean(teacherView);
  const teacherMark = markRow ? { id: markRow.id, artworkId: markRow.artworkId, strokes: JSON.parse(markRow.strokesJson), note: markRow.note, createdAt: markRow.createdAt } : null;
  return noStoreJson({ student, artworks, artworkTotal, currentActivityArtwork, latestUnfinishedArtwork, artworkHasMore: artworkRows.results.length > artworkPageSize, artworkNextOffset: artworkOffset + artworks.length, messages: messages.results, teacherViewing, teacherMark, handRaised: Boolean(handRow), currentActivityKey, currentActivityLabel: activityLabel(currentActivityKey) });
}

async function studentPost(request: Request) {
  if (!sameOrigin(request)) return jsonError("요청 출처를 확인할 수 없어요.", 403);
  await ensureSchema();
  const payload = await request.json().catch(() => ({})) as Record<string, unknown>;
  const action = cleanText(payload.action, 30);

  if (action === "localStorybookDemo") {
    if (!isLocalDemoRequest(request)) return jsonError("로컬 체험에서만 사용할 수 있어요.", 404);
    if (!(await rateLimit(`local-storybook-demo:${requestIp(request)}`, 12, 60))) return jsonError("체험 준비가 너무 빨라요. 잠시 후 다시 해 주세요.", 429);
    const student = await ensureLocalStorybookStudent();
    const demoSession = await issueDeviceSession(student.id);
    if (!demoSession) return jsonError("체험 학생을 준비하지 못했어요.", 500);
    return noStoreJson({ student, deviceToken: demoSession.token, expiresAt: demoSession.expiresAt });
  }

  if (action === "logout") {
    const student = await studentFromRequest(request);
    if (!student) return jsonError("활성 학생 세션이 없어요.", 401);
    const token = presentedToken(request);
    await bindings().DB.prepare(`UPDATE device_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE token_hash = ? AND student_id = ?`).bind(await sha256(token), student.id).run();
    return noStoreJson({ ok: true });
  }

  if (action === "ackTeacherMessage") {
    const student = await studentFromRequest(request);
    if (!student) return jsonError("활성 학생 세션이 없어요.", 401);
    const messageId = cleanText(payload.messageId, 80);
    if (!messageId) return jsonError("확인할 선생님 말씀을 찾지 못했어요.", 400);
    const db = bindings().DB;
    const accessible = await db.prepare(`SELECT 1 FROM teacher_messages WHERE id = ? AND classroom_id = ? AND (student_id IS NULL OR student_id = ?) LIMIT 1`).bind(messageId, student.classroomId, student.id).first();
    if (!accessible) return jsonError("확인할 선생님 말씀을 찾지 못했어요.", 404);
    await db.prepare(`INSERT INTO message_receipts(message_id, student_id, seen_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT DO NOTHING`).bind(messageId, student.id).run();
    return noStoreJson({ ok: true });
  }

  if (action === "answerMark") {
    // 아이는 선생님 표시에 큰 버튼 두 개로만 답한다. 글자 입력은 받지 않는다.
    const student = await studentFromRequest(request);
    if (!student) return jsonError("활성 학생 세션이 없어요.", 401);
    const markId = cleanText(payload.markId, 80);
    if (!markId || !isMarkAnswer(payload.answer)) return jsonError("답을 다시 골라 주세요.", 400);
    const updated = await bindings().DB.prepare(`UPDATE teacher_marks SET answer = ?, answered_at = ? WHERE id = ? AND student_id = ? AND classroom_id = ? AND answered_at IS NULL`).bind(payload.answer, new Date().toISOString(), markId, student.id, student.classroomId).run();
    return noStoreJson({ ok: true, answered: Boolean(updated.meta.changes) });
  }

  if (action === "raiseHand") {
    const student = await studentFromRequest(request);
    if (!student) return jsonError("활성 학생 세션이 없어요.", 401);
    if (!(await rateLimit(`hand-raise:${student.id}`, 30, 10 * 60))) return jsonError("잠깐 기다렸다가 다시 눌러 줘.", 429);
    const db = bindings().DB;
    if (payload.raised === true) await db.prepare(`INSERT INTO hand_raises(student_id, classroom_id, raised_at) VALUES (?, ?, ?) ON CONFLICT(student_id) DO UPDATE SET classroom_id = excluded.classroom_id, raised_at = excluded.raised_at`).bind(student.id, student.classroomId, new Date().toISOString()).run();
    else await db.prepare(`DELETE FROM hand_raises WHERE student_id = ?`).bind(student.id).run();
    return noStoreJson({ ok: true, handRaised: payload.raised === true });
  }

  if (action === "ackTeacherMessages") {
    const student = await studentFromRequest(request);
    if (!student) return jsonError("활성 학생 세션이 없어요.", 401);
    const rawMessageIds = Array.isArray(payload.messageIds) ? payload.messageIds.slice(0, 100) : [];
    const messageIds = [...new Set(rawMessageIds
      .filter((value): value is string => typeof value === "string")
      .map((value) => cleanText(value, 80))
      .filter(Boolean))].slice(0, 50);
    if (!messageIds.length) return jsonError("확인할 선생님 말씀을 찾지 못했어요.", 400);

    const db = bindings().DB;
    const placeholders = messageIds.map(() => "?").join(", ");
    const accessible = await db.prepare(`SELECT id FROM teacher_messages WHERE id IN (${placeholders}) AND classroom_id = ? AND (student_id IS NULL OR student_id = ?)`)
      .bind(...messageIds, student.classroomId, student.id)
      .all<{ id: string }>();
    if (accessible.results.length !== messageIds.length) return jsonError("확인할 선생님 말씀을 찾지 못했어요.", 404);

    await db.batch(messageIds.map((messageId) => db.prepare(`INSERT INTO message_receipts(message_id, student_id, seen_at)
      SELECT ?, ?, CURRENT_TIMESTAMP
      WHERE EXISTS (SELECT 1 FROM teacher_messages WHERE id = ? AND classroom_id = ? AND (student_id IS NULL OR student_id = ?)) ON CONFLICT DO NOTHING`)
      .bind(messageId, student.id, messageId, student.classroomId, student.id)));
    return noStoreJson({ ok: true, acknowledged: messageIds.length });
  }

  if (action === "entryStatus") {
    if (!(await ipAllowed(request))) return jsonError("입장 확인이 많아요. 잠시 후 다시 해 주세요.", 429);
    const entry = cleanText(payload.entry, 80);
    const classroom = await classroomForEntry(entry);
    if (!classroom) return jsonError("수업 코드를 다시 확인해 주세요.", 404);
    if (!classroom.admissionOpen) return jsonError("선생님이 입장을 열 때까지 기다려 주세요.", 403);
    const existing = await bindings().DB.prepare(`SELECT 1 FROM student_profiles WHERE classroom_id = ? AND archived_at IS NULL LIMIT 1`).bind(classroom.id).first();
    // 선생님이 명단을 만든 학급이면 아이는 자기 번호를 입력한다. 명단 자체(번호·이름 목록)는
    // 절대 돌려주지 않는다 — 수업 코드를 아는 사람에게 반 전체 실명이 노출되기 때문이다.
    const roster = await bindings().DB.prepare(`SELECT 1 FROM student_profiles WHERE classroom_id = ? AND archived_at IS NULL AND seat_number IS NOT NULL LIMIT 1`).bind(classroom.id).first();
    // 학급 인원이나 프로필 목록은 노출하지 않고, 신규/기존 입장 화면을 고르는 데 필요한
    // 최소 상태만 돌려준다. 수업 코드와 QR은 모두 classroomForEntry에서 같은 방식으로 처리한다.
    return noStoreJson({ classroomName: classroom.displayName, hasProfiles: Boolean(existing), hasRoster: Boolean(roster) });
  }

  /* 입장 코드 잠금(2026-09-21). 수업 코드와 아이 참여 코드가 **같은 계수**를 쓴다 —
   * 따로 세면 둘을 번갈아 찍어 두 배로 시도할 수 있다. */
  async function lockState(deviceKey: string) {
    if (!deviceKey) return { locked: 0, fails: 0, strikes: 0 };
    const row = await bindings().DB.prepare(`SELECT fails, strikes, locked_until AS lockedUntil, updated_at AS updatedAt FROM entry_lockouts WHERE device_key = ?`).bind(deviceKey).first<{ fails: number; strikes: number; lockedUntil: string | null; updatedAt: string | null }>();
    // 한참 뒤의 실수는 새 실수다 — 오래 조용했으면 단계와 계수를 처음으로 되돌린다.
    const strikes = decayedStrikes(row?.strikes ?? 0, row?.updatedAt ?? null);
    return { locked: lockRemainingSeconds(row?.lockedUntil ?? null), fails: strikes === 0 && (row?.strikes ?? 0) > 0 ? 0 : row?.fails ?? 0, strikes };
  }
  async function noteEntryFailure(deviceKey: string, classroomId: string | null) {
    if (!deviceKey) return { seconds: 0, attemptsLeft: 0 };
    const now = new Date();
    const state = await lockState(deviceKey);
    const fails = state.fails + 1;
    // 몇 번 틀려야 잠기는지는 지금까지 몇 번 잠겼는지에 달렸다(세 번 잠긴 뒤부터는 세 번).
    const limit = failLimitFor(state.strikes);
    if (fails < limit) {
      await bindings().DB.prepare(`INSERT INTO entry_lockouts(device_key, classroom_id, fails, strikes, locked_until, updated_at) VALUES (?, ?, ?, ?, NULL, ?) ON CONFLICT(device_key) DO UPDATE SET classroom_id = excluded.classroom_id, fails = excluded.fails, updated_at = excluded.updated_at`).bind(deviceKey, classroomId, fails, state.strikes, now.toISOString()).run();
      // 몇 번 남았는지 알려 준다 — 아이가 갑자기 막히지 않고 미리 안다(2026-09-21 사용자 요청).
      return { seconds: 0, attemptsLeft: limit - fails };
    }
    // 정해진 횟수에 이르면 잠근다. 되풀이될수록 쉬는 시간이 길어진다.
    const strikes = state.strikes + 1;
    const seconds = lockSecondsFor(strikes);
    const until = new Date(now.getTime() + seconds * 1000).toISOString();
    await bindings().DB.prepare(`INSERT INTO entry_lockouts(device_key, classroom_id, fails, strikes, locked_until, updated_at) VALUES (?, ?, 0, ?, ?, ?) ON CONFLICT(device_key) DO UPDATE SET classroom_id = excluded.classroom_id, fails = 0, strikes = excluded.strikes, locked_until = excluded.locked_until, updated_at = excluded.updated_at`).bind(deviceKey, classroomId, strikes, until, now.toISOString()).run();
    return { seconds, attemptsLeft: 0 };
  }
  /** 맞게 들어왔으면 계수를 지운다 — 다섯 번째에 맞힌 아이가 벌을 받으면 안 된다. */
  async function clearEntryFailures(deviceKey: string) {
    if (!deviceKey) return;
    await bindings().DB.prepare(`DELETE FROM entry_lockouts WHERE device_key = ?`).bind(deviceKey).run();
  }

  if (action === "join") {
    if (!(await ipAllowed(request))) return jsonError("입장 시도가 많아요. 잠시 후 다시 해 주세요.", 429);
    // 잠긴 기기는 코드를 맞게 넣어도 통과시키지 않는다. 맞는지 확인해 주는 것 자체가 찍기를 돕는다.
    const deviceKey = normalizeDeviceKey(payload.deviceKey);
    const lock = await lockState(deviceKey);
    if (lock.locked > 0) return noStoreJson({ error: lockMessage(lock.locked), code: "ENTRY_LOCKED", retryAfterSeconds: lock.locked }, { status: 429 });
    const entry = cleanText(payload.entry, 80); const classroom = await classroomForEntry(entry);
    if (!classroom) {
      const failure = await noteEntryFailure(deviceKey, null);
      if (failure.seconds) return noStoreJson({ error: lockMessage(failure.seconds), code: "ENTRY_LOCKED", retryAfterSeconds: failure.seconds }, { status: 429 });
      return noStoreJson({ error: "수업 코드를 다시 확인해 주세요.", code: "ENTRY_CODE", ...(failure.attemptsLeft ? { attemptsLeft: failure.attemptsLeft } : {}) }, { status: 404 });
    }
    if (!classroom.admissionOpen) return jsonError("선생님이 입장을 열 때까지 기다려 주세요.", 403);

    // 입장은 선생님 명단의 참여 코드 하나로 한다(2026-09-09 사용자 결정). 번호 + 그림 비밀번호는
    // 아이가 매번 기억해야 해서 없앴다. 코드는 종이에 적혀 있고, 코드가 곧 그 아이의 자리라
    // 다음 회차에 같은 코드를 넣으면 같은 학생 ID로 돌아온다. 명단 자체는 절대 돌려주지 않는다.
    const rosterRow = await bindings().DB.prepare(`SELECT 1 FROM student_profiles WHERE classroom_id = ? AND archived_at IS NULL AND seat_number IS NOT NULL LIMIT 1`).bind(classroom.id).first();
    if (!rosterRow) return noStoreJson({ error: "선생님이 아직 우리 반 명단을 넣지 않았어요. 선생님께 말해 주세요.", code: "NO_ROSTER" }, { status: 409 });
    const entryCode = cleanText(payload.entryCode, 4);
    if (!/^\d{4}$/.test(entryCode)) return jsonError("참여 코드 네 자리를 눌러 주세요.");
    // 학급 상한은 IP와 함께 묶는다. 학급 단독 버킷은 한 클라이언트가 학급 전체를 잠그는 통로가 된다.
    // 네 자리 만 개 중 한 반 코드는 수십 개다. 학급+IP 버킷(60회/10분)이 찍어 맞추기를 막는다.
    if (!(await rateLimit(`student-join-class:${classroom.id}:${requestIp(request)}`, CLASSROOM_JOIN_LIMIT, IP_ENTRY_WINDOW_SECONDS))) return jsonError("이 수업의 입장 시도가 많아요. 선생님께 알려 주세요.", 429);
    const seat = await bindings().DB.prepare(`SELECT id, nickname, animal, claimed_at AS claimedAt FROM student_profiles WHERE classroom_id = ? AND entry_code = ? AND archived_at IS NULL`).bind(classroom.id, entryCode).first<{ id: string; nickname: string; animal: string; claimedAt: string | null }>();
    if (!seat) {
      const failure = await noteEntryFailure(deviceKey, classroom.id);
      if (failure.seconds) return noStoreJson({ error: lockMessage(failure.seconds), code: "ENTRY_LOCKED", retryAfterSeconds: failure.seconds }, { status: 429 });
      return noStoreJson({ error: "참여 코드를 다시 확인해 주세요.", code: "ENTRY_CODE", ...(failure.attemptsLeft ? { attemptsLeft: failure.attemptsLeft } : {}) }, { status: 404 });
    }
    // 여기까지 왔으면 두 코드가 모두 맞다. 쌓인 실패를 지운다.
    await clearEntryFailures(deviceKey);

    if (!seat.claimedAt) {
      // 첫 입장은 동물 하나만 고른다. 별명은 그 동물의 기본 별명이다 — 아이가 글자를 치지 않는다.
      const animal = cleanText(payload.animal, 12);
      const ideas = NICKNAME_IDEAS[animal];
      if (!ideas) return noStoreJson({ classroomName: classroom.displayName, firstTime: true });
      const nickname = ideas[0] ?? FALLBACK_NICKNAME;
      const claimedAt = new Date().toISOString();
      const device = await prepareDeviceSession();
      // 자리 차지와 세션을 한 배치로 묶는다. 나눠 쓰면 중간에 실패했을 때 자리는 차지됐는데 세션이 없다.
      // 세션 INSERT는 방금 쓴 claimed_at에 묶여, 같은 코드로 동시에 들어온 다른 기기가 먼저
      // 차지했으면 아무것도 넣지 않는다 — 그 기기는 아래 재입장 경로로 세션을 받는다.
      const seatResults = await bindings().DB.batch([
        bindings().DB.prepare(`UPDATE student_profiles SET nickname = ?, animal = ?, claimed_at = ?, last_activity_at = ? WHERE id = ? AND claimed_at IS NULL AND archived_at IS NULL AND EXISTS (SELECT 1 FROM classrooms WHERE id = ? AND active = 1 AND admission_open = 1)`).bind(nickname, animal, claimedAt, claimedAt, seat.id, classroom.id),
        bindings().DB.prepare(`INSERT INTO device_sessions(token_hash, student_id, expires_at, last_used_at) SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM student_profiles WHERE id = ? AND classroom_id = ? AND claimed_at = ? AND archived_at IS NULL)`).bind(device.tokenHash, seat.id, device.expiresAt, device.lastUsedAt, seat.id, classroom.id, claimedAt),
      ]);
      // 아이 화면에는 별명만 보낸다. 실명은 담임 교사 화면에만 있다.
      if (seatResults[0]?.meta.changes) return noStoreJson({ student: { id: seat.id, nickname, animal, classroomName: classroom.displayName }, deviceToken: device.token, expiresAt: device.expiresAt }, { status: 201 });
      // 0행이면 이유를 가른다: 같은 코드의 다른 기기가 먼저 차지했으면 그대로 재입장, 학급이 닫혔으면 403.
      const nowClaimed = await bindings().DB.prepare(`SELECT nickname, animal, claimed_at AS claimedAt FROM student_profiles WHERE id = ? AND archived_at IS NULL`).bind(seat.id).first<{ nickname: string; animal: string; claimedAt: string | null }>();
      if (!nowClaimed?.claimedAt) return jsonError("입장이 닫혔어요. 선생님께 확인해 주세요.", 403);
      seat.nickname = nowClaimed.nickname; seat.animal = nowClaimed.animal;
    }
    // 재입장: 코드가 곧 자리라 별명·비밀번호를 다시 묻지 않는다.
    const device = await issueDeviceSession(seat.id);
    if (!device) return jsonError("이 학급은 더 이상 이용할 수 없어요. 선생님께 확인해 주세요.", 403);
    return noStoreJson({ student: { id: seat.id, nickname: seat.nickname, animal: seat.animal, classroomName: classroom.displayName }, deviceToken: device.token, expiresAt: device.expiresAt });
  }

  return jsonError("지원하지 않는 요청이에요.");
}

export async function POST(request: Request) {
  try {
    return await studentPost(request);
  } catch (error) {
    console.error("Unexpected student API error", error);
    return jsonError("입장을 처리하지 못했어요. 잠시 뒤 다시 해 주세요.", 500);
  }
}
