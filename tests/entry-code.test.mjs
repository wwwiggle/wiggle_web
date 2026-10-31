import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { after } from "node:test";
import { resetRows } from "./harness/db.mjs";
import { startTestServer } from "./harness/server.mjs";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

/* 아이별 참여 코드 입장(2026-09-09 사용자 결정).
 * 수업 코드로 반을 확인한 뒤 명단의 참여 코드 네 자리 하나로 자기 도화지에 들어온다.
 * 번호 입력·그림 비밀번호는 1~2학년이 매번 기억해야 해서 없앴다. 코드가 곧 자리라
 * 다음 회차에 같은 코드를 넣으면 같은 학생 ID로 돌아온다(지난 그림을 찾을 필요가 없다).
 * 코드는 교사 화면(명단·코드표)에만 보이고 학생 응답에는 절대 실리지 않는다. */

let booting;
async function sharedServer() {
  if (!booting) booting = bootServer();
  return booting;
}
async function bootServer() {
  const server = await startTestServer();
  const initialized = await server.fetch("/api/student", studentRequest({ action: "unsupported" }));
  assert.equal(initialized.status, 400);
  return server;
}
after(async () => {
  if (booting) await booting.then((server) => server.dispose(), () => {});
});

function studentRequest(body, ip = "203.0.113.160") {
  return { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip }, body: JSON.stringify(body) };
}

async function seedClassroom(DB, suffix, codes = ["1111"]) {
  await DB.batch([
    DB.prepare(`INSERT INTO teachers(id, email, display_name) VALUES ('teacher_${suffix}', '${suffix}@example.com', 'Codes')`),
    DB.prepare(`INSERT INTO classrooms(id, teacher_id, display_name, class_code, join_token) VALUES ('class_${suffix}', 'teacher_${suffix}', '코드 학급', '4321', 'join_${suffix}')`),
    ...codes.map((code, index) => DB.prepare(`INSERT INTO student_profiles(id, classroom_id, seat_number, real_name, entry_code, claimed_at, nickname, animal, last_activity_at) VALUES ('student_${suffix}_${index + 1}', 'class_${suffix}', ${index + 1}, '학생${index + 1}', '${code}', NULL, '${index + 1}번', '❔', '2026-09-09T00:00:00.000Z')`)),
  ]);
  return `class_${suffix}`;
}

test("참여 코드 하나로 들어오고, 같은 코드는 다음에도 같은 학생이다", async (context) => {
  const server = await sharedServer();
  context.after(() => resetRows(server.DB));
  await seedClassroom(server.DB, "code1", ["1111", "2222"]);

  // 코드가 맞지만 처음이면 세션 없이 firstTime만 돌려준다 — 아이는 동물 하나만 고른다.
  const first = await server.fetch("/api/student", studentRequest({ action: "join", entry: "4321", entryCode: "1111" }, "203.0.113.161"));
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { classroomName: "코드 학급", firstTime: true });

  const claimed = await server.fetch("/api/student", studentRequest({ action: "join", entry: "4321", entryCode: "1111", animal: "🐻" }, "203.0.113.162"));
  assert.equal(claimed.status, 201);
  const claimedPayload = await claimed.json();
  assert.ok(claimedPayload.deviceToken);
  // 별명은 동물의 기본 별명이다. 실명·번호·코드는 학생 응답에 없다.
  assert.deepEqual(claimedPayload.student, { id: "student_code1_1", nickname: "보리", animal: "🐻", classroomName: "코드 학급" });
  assert.doesNotMatch(JSON.stringify(claimedPayload), /학생1|entryCode|1111|seatNumber/);

  // 재입장: 다른 기기에서 같은 코드를 넣으면 같은 학생 ID, 동물을 다시 묻지 않는다.
  const again = await server.fetch("/api/student", studentRequest({ action: "join", entry: "4321", entryCode: "1111" }, "203.0.113.163"));
  assert.equal(again.status, 200);
  const againPayload = await again.json();
  assert.equal(againPayload.student.id, "student_code1_1");
  assert.equal(againPayload.student.animal, "🐻");
  assert.ok(againPayload.deviceToken && againPayload.deviceToken !== claimedPayload.deviceToken);

  // 다른 코드는 다른 학생이다. 학급 QR 토큰으로 들어와도 같다.
  const other = await server.fetch("/api/student", studentRequest({ action: "join", entry: "join_code1", entryCode: "2222", animal: "🐰" }, "203.0.113.164"));
  assert.equal(other.status, 201);
  assert.equal((await other.json()).student.id, "student_code1_2");
  assert.equal((await server.DB.prepare("SELECT COUNT(*) AS count FROM student_profiles").first()).count, 2);
});

test("틀린 코드는 404로만 답하고 명단을 알려 주지 않으며, 지운 학생의 코드는 죽는다", async (context) => {
  const server = await sharedServer();
  context.after(() => resetRows(server.DB));
  await seedClassroom(server.DB, "code2", ["3333", "4444"]);

  const wrong = await server.fetch("/api/student", studentRequest({ action: "join", entry: "4321", entryCode: "9999", animal: "🐰" }, "203.0.113.170"));
  assert.equal(wrong.status, 404);
  // 기기 식별값이 없어도 IP로 만든 키로 기기 잠금을 센다(2026-10-31) — 남은 횟수를 함께 알려 준다.
  assert.deepEqual(await wrong.json(), { error: "참여 코드를 다시 확인해 주세요.", code: "ENTRY_CODE", attemptsLeft: 4 });

  const short = await server.fetch("/api/student", studentRequest({ action: "join", entry: "4321", entryCode: "33" }, "203.0.113.171"));
  assert.equal(short.status, 400);

  await server.DB.prepare("UPDATE student_profiles SET archived_at = '2026-09-09T01:00:00.000Z' WHERE id = 'student_code2_1'").run();
  const archived = await server.fetch("/api/student", studentRequest({ action: "join", entry: "4321", entryCode: "3333", animal: "🐰" }, "203.0.113.172"));
  assert.equal(archived.status, 404);
  // 명단이 통째로 비면(모두 삭제) 코드가 맞아도 준비 중 화면으로 보낸다.
  await server.DB.prepare("UPDATE student_profiles SET archived_at = '2026-09-09T01:00:00.000Z' WHERE id = 'student_code2_2'").run();
  const noRoster = await server.fetch("/api/student", studentRequest({ action: "join", entry: "4321", entryCode: "4444", animal: "🐰" }, "203.0.113.173"));
  assert.equal(noRoster.status, 409);
  assert.equal((await noRoster.json()).code, "NO_ROSTER");
});

test("교사는 명단에서 코드를 보고 새로 뽑을 수 있고, 옛 코드는 바로 죽는다", async (context) => {
  const server = await sharedServer();
  context.after(() => resetRows(server.DB));
  const DB = server.DB;
  const { randomUUID } = await import("node:crypto");
  const { sha256 } = await import("../lib/token-crypto.ts");
  const token = randomUUID(); const now = new Date();
  await DB.batch([
    DB.prepare(`INSERT INTO teachers(id, email, display_name, credential_hash, credential_salt) VALUES ('teacher_code3', 'code3@example.com', 'Codes', '', '')`),
    DB.prepare(`INSERT INTO teacher_sessions(token_hash, teacher_id, expires_at, last_used_at) VALUES (?, 'teacher_code3', ?, ?)`).bind(await sha256(token), new Date(now.getTime() + 8 * 60 * 60 * 1000).toISOString(), now.toISOString()),
  ]);
  const teacherHeaders = { "content-type": "application/json", cookie: `wiggle_teacher=${token}` };

  // 학급을 만들면 자리마다 네 자리 코드가 붙고, 같은 반 안에서 겹치지 않는다.
  const created = await server.fetch("/api/teacher", { method: "POST", headers: teacherHeaders, body: JSON.stringify({ action: "createClassroom", displayName: "코드 발급반", roster: [{ seatNumber: 1, realName: "김민준" }, { seatNumber: 2, realName: "이서연" }] }) });
  assert.equal(created.status, 201);
  const createdPayload = await created.json();
  assert.equal(createdPayload.entryCodes.length, 2);
  for (const row of createdPayload.entryCodes) assert.match(row.entryCode, /^\d{4}$/);
  assert.notEqual(createdPayload.entryCodes[0].entryCode, createdPayload.entryCodes[1].entryCode);
  const classroom = createdPayload.classroom;

  const detail = await (await server.fetch(`/api/teacher?classroomId=${classroom.id}`, { headers: teacherHeaders })).json();
  const seat1 = detail.students.find((student) => student.seatNumber === 1);
  assert.equal(seat1.entryCode, createdPayload.entryCodes.find((row) => row.seatNumber === 1).entryCode);

  // 학생 추가도 코드를 붙인다.
  const added = await server.fetch("/api/teacher", { method: "POST", headers: teacherHeaders, body: JSON.stringify({ action: "addStudents", classroomId: classroom.id, roster: [{ seatNumber: 3, realName: "박지호" }] }) });
  assert.equal(added.status, 201);
  const afterAdd = await (await server.fetch(`/api/teacher?classroomId=${classroom.id}`, { headers: teacherHeaders })).json();
  assert.equal(new Set(afterAdd.students.map((student) => student.entryCode)).size, 3);

  // 아이가 그 코드로 들어온 뒤 교사가 코드를 새로 뽑으면, 옛 코드는 죽고 새 코드로 같은 학생에게 돌아온다.
  const joined = await server.fetch("/api/student", studentRequest({ action: "join", entry: classroom.classCode, entryCode: seat1.entryCode, animal: "🐰" }, "203.0.113.180"));
  assert.equal(joined.status, 201);
  const studentId = (await joined.json()).student.id;
  const rotated = await server.fetch("/api/teacher", { method: "POST", headers: teacherHeaders, body: JSON.stringify({ action: "rotateEntryCode", classroomId: classroom.id, studentId }) });
  assert.equal(rotated.status, 200);
  const { entryCode: newCode } = await rotated.json();
  assert.match(newCode, /^\d{4}$/);
  assert.notEqual(newCode, seat1.entryCode);
  const oldCode = await server.fetch("/api/student", studentRequest({ action: "join", entry: classroom.classCode, entryCode: seat1.entryCode }, "203.0.113.181"));
  assert.equal(oldCode.status, 404);
  const newEntry = await server.fetch("/api/student", studentRequest({ action: "join", entry: classroom.classCode, entryCode: newCode }, "203.0.113.182"));
  assert.equal(newEntry.status, 200);
  assert.equal((await newEntry.json()).student.id, studentId);

  // 다른 교사는 코드를 뽑지 못한다.
  const stranger = await server.fetch("/api/teacher", { method: "POST", headers: teacherHeaders, body: JSON.stringify({ action: "rotateEntryCode", classroomId: "class_nobody", studentId }) });
  assert.equal(stranger.status, 403);
});

test("코드가 없거나 옛 여섯 자리인 학생 행은 스키마가 네 자리로 채워 준다", async () => {
  const { createSchemaDb } = await import("./harness/db.mjs");
  const db = await createSchemaDb();
  try {
    await db.DB.batch([
      db.DB.prepare(`INSERT INTO teachers(id, email, display_name) VALUES ('t_legacy', 'legacy@example.com', 'Legacy')`),
      db.DB.prepare(`INSERT INTO classrooms(id, teacher_id, display_name, class_code, join_token) VALUES ('c_legacy', 't_legacy', '옛 반', '4321', 'join_legacy')`),
      db.DB.prepare(`INSERT INTO student_profiles(id, classroom_id, seat_number, real_name, entry_code, claimed_at, nickname, animal, last_activity_at) VALUES ('s_legacy_1', 'c_legacy', 1, '옛 학생', '654321', '2026-09-01T00:00:00.000Z', '토끼 화가', '🐰', '2026-09-01T00:00:00.000Z')`),
      db.DB.prepare(`INSERT INTO student_profiles(id, classroom_id, claimed_at, nickname, animal, last_activity_at) VALUES ('s_legacy_2', 'c_legacy', '2026-08-01T00:00:00.000Z', '곰돌 화가', '🐻', '2026-08-01T00:00:00.000Z')`),
    ]);
    const { provisionSchema } = await import("../db/runtime.ts");
    await provisionSchema(db.DB);
    const rows = await db.DB.prepare(`SELECT id, entry_code AS entryCode FROM student_profiles ORDER BY id`).all();
    assert.equal(rows.results.length, 2);
    for (const row of rows.results) assert.match(row.entryCode ?? "", /^\d{4}$/, row.id);
    assert.notEqual(rows.results[0].entryCode, rows.results[1].entryCode);
  } finally { await db.dispose(); }
});

test("학생 화면은 코드 수첩 하나와 동물 고르기만 그리고, 명단·실명은 어디에도 없다", async () => {
  const [join, student, teacherUi, teacherCss] = await Promise.all([
    read("../app/components/JoinClient.tsx"),
    read("../app/api/student/route.ts"),
    read("../app/components/TeacherRosterSettings.tsx"),
    read("../app/components/TeacherRosterSettings.css"),
  ]);
  assert.match(join, /className="entry-code-input"/);
  assert.match(join, /maxLength=\{ENTRY_CODE_LENGTH\}/);
  // QR로 채운 코드는 상태 반영 전에 제출되므로 코드를 인자로 받는다. 기본값은 여전히 키패드 입력이다.
  assert.match(join, /action: "join", entry, entryCode: code,/);
  assert.match(join, /async function submit\(chosenAnimal = "", code = codeInput\)/);
  assert.match(join, /if \(data\.firstTime\) \{ claimCode\.current = code; setMode\("animal"\)/);
  assert.match(join, /내 참여 코드를 눌러요/);
  assert.match(join, /withGwaWa\(chosen\.name\)\} 시작하기/);
  // 없앤 것들: 번호 입력, 그림 비밀번호, 별명 타이핑, 프로필 목록.
  assert.doesNotMatch(join, /seatStatus|picturePassword|switchProfile|recover|nickname-row|realName|deviceProfiles/);
  assert.doesNotMatch(student, /real_name|picturePassword|verifySecret|seatStatus|switchProfile/);
  // 코드는 정규식과 길이를 서버가 검사하고, 학급 + 코드로만 찾는다.
  assert.match(student, /if \(!\/\^\\d\{4\}\$\/\.test\(entryCode\)\)/);
  assert.match(student, /WHERE classroom_id = \? AND entry_code = \? AND archived_at IS NULL/);
  // 자리 차지와 세션은 한 배치다.
  assert.match(student, /const seatResults = await bindings\(\)\.DB\.batch\(\[[\s\S]*student_profiles[\s\S]*device_sessions[\s\S]*\]\)/);
  // 교사 명단은 코드를 보여 주고, 복사·새로 뽑기·코드표 인쇄가 있다.
  assert.match(teacherUi, /student\.entryCode/);
  assert.match(teacherUi, /rotateEntryCode/);
  assert.match(teacherUi, /코드표 인쇄/);
  assert.match(teacherCss, /\.trs-entry-code/);
});
