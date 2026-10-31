import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { after } from "node:test";
import { resetRows } from "./harness/db.mjs";
import { PostgresD1 } from "../db/adapters/postgres-d1.ts";
import { startTestServer } from "./harness/server.mjs";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

// Next 서버 기동은 프로세스 하나 값이라 테스트마다 띄우면 비싸다. 파일 하나에 서버 하나만 띄우고,
// 테스트가 끝날 때마다 resetDatabase로 격리한다. 세 테스트가 모두 수업 코드 4999를 쓰므로 초기화는 필수다.
let booting;

async function sharedServer() {
  if (!booting) booting = bootServer();
  return booting;
}

async function bootServer() {
  const server = await startTestServer();
  // 스키마는 서버가 첫 요청을 받을 때 세운다. 시드보다 먼저 한 번 찔러 테이블을 만들어 둔다.
  const initialized = await server.fetch("/api/student", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "unsupported" }),
  });
  assert.equal(initialized.status, 400);
  return server;
}

after(async () => {
  if (booting) await booting.then((server) => server.dispose(), () => {});
});

// 이 파일은 실패를 강제하려고 트리거를 만든다. 트리거는 행이 아니라 스키마라 resetRows가 지우지 않으므로
// 다음 테스트로 새지 않게 여기서 먼저 떨어뜨린다.
async function resetDatabase(DB) {
  if (DB instanceof PostgresD1) {
    const triggers = await DB.sql`SELECT trigger_name AS name, event_object_table AS "table" FROM information_schema.triggers WHERE trigger_schema = 'web' GROUP BY 1, 2`;
    for (const trigger of triggers) await dropTrigger(DB, trigger.name, trigger.table);
  } else {
    const triggers = await DB.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger'`).all();
    for (const trigger of triggers.results) await DB.prepare(`DROP TRIGGER IF EXISTS "${trigger.name}"`).run();
  }
  await resetRows(DB);
}

/* 실패를 강제하는 트리거. abort는 문장을 실패시키고(SQLite RAISE(ABORT)), ignore는 그 행만 조용히 건너뛴다(RAISE(IGNORE)).
 * Postgres는 트리거 함수가 따로 있어야 해 문장이 둘이다. */
function triggerStatements(DB, name, timing, table, mode) {
  if (!(DB instanceof PostgresD1)) {
    const raise = mode === "abort" ? "RAISE(ABORT, 'forced device session failure')" : "RAISE(IGNORE)";
    return [DB.prepare(`CREATE TRIGGER ${name} ${timing} ON ${table} BEGIN SELECT ${raise}; END`)];
  }
  const body = mode === "abort" ? "RAISE EXCEPTION 'forced device session failure'" : "RETURN NULL";
  return [
    DB.prepare(`CREATE OR REPLACE FUNCTION ${name}_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${body}; END $$`),
    DB.prepare(`CREATE TRIGGER ${name} ${timing} ON ${table} FOR EACH ROW EXECUTE FUNCTION ${name}_fn()`),
  ];
}

async function dropTrigger(DB, name, table) {
  if (!(DB instanceof PostgresD1)) return DB.prepare(`DROP TRIGGER ${name}`).run();
  await DB.sql.unsafe(`DROP TRIGGER IF EXISTS ${name} ON ${table}; DROP FUNCTION IF EXISTS ${name}_fn()`).simple();
}

function joinRequest(ip = "203.0.113.40") {
  // 주소는 x-forwarded-for로 흉내 낸다. cf-connecting-ip는 Cloudflare가 사라져 앱이 더 이상 믿지 않는다.
  return {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify({ action: "join", entry: "4999", entryCode: "1234", animal: "🐰" }),
  };
}

/* 선생님이 미리 만들어 둔 빈 자리. 아이는 이 자리를 차지할 뿐 프로필을 새로 만들지 않는다. */
function seatRow(DB, classroomId, id = "student_seat1") {
  return DB.prepare(`INSERT INTO student_profiles(id, classroom_id, seat_number, real_name, entry_code, claimed_at, nickname, animal, last_activity_at) VALUES (?, ?, 1, '김민준', '1234', NULL, '1번', '❔', ?)`).bind(id, classroomId, new Date().toISOString());
}

async function count(DB, table) {
  return (await DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first()).count;
}

test("a failed device-session insert rolls back the entire join and a retry creates one profile", async (context) => {
  const server = await sharedServer();
  context.after(() => resetDatabase(server.DB));

  const DB = server.DB;
  await DB.batch([
    DB.prepare("INSERT INTO teachers(id, email, display_name) VALUES ('teacher_atomic', 'atomic@example.com', 'Atomic')"),
    DB.prepare("INSERT INTO classrooms(id, teacher_id, display_name, class_code, join_token) VALUES ('class_atomic', 'teacher_atomic', '원자성 반', '4999', 'join_atomic')"),
    ...triggerStatements(DB, "fail_device_session", "BEFORE INSERT", "device_sessions", "abort"),
  ]);
  await seatRow(DB, "class_atomic").run();

  const failed = await server.fetch("/api/student", joinRequest());
  assert.equal(failed.status, 500);
  assert.match(failed.headers.get("content-type") ?? "", /application\/json/);
  assert.match(failed.headers.get("cache-control") ?? "", /no-store/);
  assert.deepEqual(await failed.json(), { error: "입장을 처리하지 못했어요. 잠시 뒤 다시 해 주세요." });
  // 자리는 선생님이 만든 것이라 남지만, 차지되지 않아야 한다 — 세션도 없어야 한다.
  assert.equal(await count(DB, "student_profiles"), 1);
  assert.equal((await DB.prepare("SELECT claimed_at AS claimedAt FROM student_profiles").first()).claimedAt, null);
  assert.equal(await count(DB, "device_sessions"), 0);

  await dropTrigger(DB, "fail_device_session", "device_sessions");
  const retried = await server.fetch("/api/student", joinRequest());
  assert.equal(retried.status, 201);
  const payload = await retried.json();
  assert.equal(payload.student.nickname, "솔이");
  assert.ok(payload.deviceToken);
  for (const table of ["student_profiles", "device_sessions"]) assert.equal(await count(DB, table), 1, table);
});

test("join batches the seat claim with the session and re-entry keeps session issuance", async () => {
  const route = await read("../app/api/student/route.ts");
  const join = route.slice(route.indexOf('if (action === "join")'), route.indexOf('return jsonError("지원하지 않는 요청이에요.");'));
  // 자리 차지·세션은 한 배치다. 나뉘면 중간 실패에서 자리만 차지돼 세션 없는 아이가 생긴다.
  assert.match(join, /const seatResults = await bindings\(\)\.DB\.batch\(\[[\s\S]*student_profiles[\s\S]*device_sessions[\s\S]*\]\)/);
  assert.match(join, /UPDATE student_profiles SET nickname = \?, animal = \?, claimed_at = \?, last_activity_at = \? WHERE id = \? AND claimed_at IS NULL AND archived_at IS NULL AND EXISTS \(SELECT 1 FROM classrooms WHERE id = \? AND active = 1 AND admission_open = 1\)/);
  assert.match(join, /device_sessions[^`]*WHERE EXISTS \(SELECT 1 FROM student_profiles WHERE id = \? AND classroom_id = \? AND claimed_at = \? AND archived_at IS NULL\)/);
  // 0행일 때 이유를 갈라 준다: 같은 코드가 먼저 차지했으면 재입장, 학급이 닫혔으면 403.
  assert.match(join, /if \(!nowClaimed\?\.claimedAt\) return jsonError\("입장이 닫혔어요\. 선생님께 확인해 주세요\.", 403\)/);
  assert.match(route, /INSERT INTO device_sessions[^`]*WHERE EXISTS \(SELECT 1 FROM student_profiles s JOIN classrooms c ON c\.id = s\.classroom_id WHERE s\.id = \? AND s\.archived_at IS NULL AND c\.active = 1\)/);
  assert.match(route, /if \(!inserted\.meta\.changes\) return null/);
  assert.match(join, /const device = await issueDeviceSession\(seat\.id\);[\s\S]*if \(!device\) return jsonError\("이 학급은 더 이상 이용할 수 없어요\. 선생님께 확인해 주세요\.", 403\)/);
  assert.equal((route.match(/const device = await issueDeviceSession\(/g) ?? []).length, 1);
  // 입장은 명단 코드로만 한다. 아이가 스스로 프로필을 만들던 경로와 그림 비밀번호는 남아 있으면 안 된다.
  assert.doesNotMatch(join, /allowDuplicate|PROFILE_EXISTS|picturePassword|recovery_credentials/);
  assert.match(join, /code: "NO_ROSTER"/);
});

test("join returns 403 without residue when the atomic classroom guard loses", async (context) => {
  const server = await sharedServer();
  context.after(() => resetDatabase(server.DB));

  const DB = server.DB;
  await DB.batch([
    DB.prepare("INSERT INTO teachers(id, email, display_name) VALUES ('teacher_race', 'race@example.com', 'Race')"),
    DB.prepare("INSERT INTO classrooms(id, teacher_id, display_name, class_code, join_token) VALUES ('class_race', 'teacher_race', 'Race class', '4999', 'join_race')"),
  ]);
  await seatRow(DB, "class_race").run();
  // 자리 차지는 INSERT가 아니라 UPDATE다 — 가드가 지는 상황을 UPDATE 트리거로 흉내 낸다.
  await DB.batch(triggerStatements(DB, "close_class_before_join", "BEFORE UPDATE", "student_profiles", "ignore"));

  const response = await server.fetch("/api/student", joinRequest("203.0.113.41"));
  assert.equal(response.status, 403);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  assert.deepEqual(await response.json(), { error: "입장이 닫혔어요. 선생님께 확인해 주세요." });
  assert.equal((await DB.prepare("SELECT claimed_at AS claimedAt FROM student_profiles").first()).claimedAt, null);
  assert.equal(await count(DB, "device_sessions"), 0);
});

test("re-entry returns 403 when the atomic active-class guard loses", async (context) => {
  const server = await sharedServer();
  context.after(() => resetDatabase(server.DB));

  const DB = server.DB;
  await DB.batch([
    DB.prepare("INSERT INTO teachers(id, email, display_name) VALUES ('teacher_session_race', 'session-race@example.com', 'Session race')"),
    DB.prepare("INSERT INTO classrooms(id, teacher_id, display_name, class_code, join_token) VALUES ('class_session_race', 'teacher_session_race', 'Session race class', '4999', 'join_session_race')"),
  ]);
  await seatRow(DB, "class_session_race").run();

  const joined = await server.fetch("/api/student", joinRequest("203.0.113.42"));
  assert.equal(joined.status, 201);
  await DB.batch([
    DB.prepare("UPDATE device_sessions SET revoked_at = CURRENT_TIMESTAMP"),
    ...triggerStatements(DB, "close_class_before_session", "BEFORE INSERT", "device_sessions", "ignore"),
  ]);

  const recovered = await server.fetch("/api/student", joinRequest("203.0.113.44"));
  assert.equal(recovered.status, 403);
  assert.deepEqual(await recovered.json(), { error: "이 학급은 더 이상 이용할 수 없어요. 선생님께 확인해 주세요." });
  assert.equal((await DB.prepare("SELECT COUNT(*) AS count FROM device_sessions WHERE revoked_at IS NULL").first()).count, 0);
});
