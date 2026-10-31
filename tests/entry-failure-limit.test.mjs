import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { after } from "node:test";
import { resetRows } from "./harness/db.mjs";
import { startTestServer } from "./harness/server.mjs";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

// 2026-10-31 점검: 기기 잠금은 브라우저가 보낸 식별값에 기대므로 값을 바꿔 가며 보내면 피할 수 있었다.
// 틀린 시도만 세는 서버 쪽 상한이 그 빈틈을 막는지 진짜 HTTP 요청으로 확인한다.
let booting;

async function sharedServer() {
  if (!booting) booting = bootServer();
  return booting;
}

async function bootServer() {
  const server = await startTestServer();
  const initialized = await server.fetch("/api/student", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "unsupported" }),
  });
  assert.equal(initialized.status, 400);
  return server;
}

after(async () => {
  if (booting) await booting.then((server) => server.dispose(), () => {});
});

async function seedClass(DB, { id = "class_guard", code = "5101", seatCode = "1234" } = {}) {
  await DB.batch([
    DB.prepare("INSERT OR IGNORE INTO teachers(id, email, display_name) VALUES ('teacher_guard', 'guard@example.com', 'Guard')"),
    DB.prepare("INSERT INTO classrooms(id, teacher_id, display_name, class_code, join_token) VALUES (?, 'teacher_guard', '지킴 반', ?, ?)").bind(id, code, `join_${id}`),
    DB.prepare("INSERT INTO student_profiles(id, classroom_id, seat_number, real_name, entry_code, claimed_at, nickname, animal, last_activity_at) VALUES (?, ?, 1, '김민준', ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), '용감한 토끼', '🐰', strftime('%Y-%m-%dT%H:%M:%fZ','now'))").bind(`student_${id}`, id, seatCode),
  ]);
}

let deviceSerial = 0;
function freshDeviceKey() {
  deviceSerial += 1;
  return `rotating-device-${String(deviceSerial).padStart(6, "0")}`;
}

function post(server, body, ip) {
  return server.fetch("/api/student", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

test("바꿔 가며 보낸 기기 식별값으로는 참여 코드 틀린 시도 상한을 피하지 못한다", async (context) => {
  const server = await sharedServer();
  context.after(() => resetRows(server.DB));
  await seedClass(server.DB);
  const ip = "203.0.113.71";

  // 기기 잠금은 다섯 번째 실패에 걸리므로, 매번 새 식별값을 보내 그 잠금을 피한다.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const wrong = await post(server, { action: "join", entry: "5101", entryCode: String(2000 + attempt), deviceKey: freshDeviceKey() }, ip);
    assert.equal(wrong.status, 404, `시도 ${attempt + 1}`);
  }
  // 상한에 닿은 뒤에는 맞는 코드도 확인해 주지 않는다.
  const blocked = await post(server, { action: "join", entry: "5101", entryCode: "1234", deviceKey: freshDeviceKey() }, ip);
  assert.equal(blocked.status, 429);
  assert.match((await blocked.json()).error, /너무 많이 틀렸어요/);

  // 같은 학교 와이파이(같은 IP)의 다른 반은 막히지 않는다.
  await seedClass(server.DB, { id: "class_other", code: "5102", seatCode: "4321" });
  const otherClass = await post(server, { action: "join", entry: "5102", entryCode: "4321", deviceKey: freshDeviceKey() }, ip);
  assert.equal(otherClass.status, 200);

  // 다른 IP의 같은 반 아이도 들어온다.
  const otherIp = await post(server, { action: "join", entry: "5101", entryCode: "1234", deviceKey: freshDeviceKey() }, "198.51.100.9");
  assert.equal(otherIp.status, 200);
});

test("맞게 들어온 시도는 틀린 시도 상한을 쓰지 않는다", async (context) => {
  const server = await sharedServer();
  context.after(() => resetRows(server.DB));
  await seedClass(server.DB);
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const joined = await post(server, { action: "join", entry: "5101", entryCode: "1234", deviceKey: freshDeviceKey() }, "203.0.113.72");
    assert.equal(joined.status, 200, `입장 ${attempt + 1}`);
  }
  const failures = await server.DB.prepare("SELECT COUNT(*) AS count FROM rate_limits WHERE key LIKE 'entry-fail:%'").first();
  assert.equal(failures.count, 0);
});

test("기기 식별값을 빼고 보내도 기기 잠금이 걸린다", async (context) => {
  const server = await sharedServer();
  context.after(() => resetRows(server.DB));
  await seedClass(server.DB);
  const ip = "203.0.113.73";
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const wrong = await post(server, { action: "join", entry: "5101", entryCode: String(3000 + attempt) }, ip);
    assert.equal(wrong.status, 404, `시도 ${attempt + 1}`);
  }
  const locked = await post(server, { action: "join", entry: "5101", entryCode: "3999" }, ip);
  assert.equal(locked.status, 429);
  assert.equal((await locked.json()).code, "ENTRY_LOCKED");
});

test("수업 코드 찍기는 입장 확인(entryStatus)으로도 상한에 걸린다", async (context) => {
  const server = await sharedServer();
  context.after(() => resetRows(server.DB));
  await seedClass(server.DB);
  const ip = "203.0.113.74";
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const wrong = await post(server, { action: "entryStatus", entry: String(6000 + attempt) }, ip);
    assert.equal(wrong.status, 404, `시도 ${attempt + 1}`);
  }
  const blocked = await post(server, { action: "entryStatus", entry: "5101" }, ip);
  assert.equal(blocked.status, 429);
  // join도 같은 계수를 본다.
  const join = await post(server, { action: "join", entry: "5101", entryCode: "1234", deviceKey: freshDeviceKey() }, ip);
  assert.equal(join.status, 429);
});

test("선생님의 입장 잠금 풀기가 그 반 참여 코드 계수만 지운다", async () => {
  const route = await read("../app/api/teacher/route.ts");
  const block = route.slice(route.indexOf('if (action === "clearEntryLocks")'), route.indexOf('if (action === "lowerHand")'));
  assert.match(block, /const failurePrefix = `entry-fail:seatCode:\$\{classroomId\}:`;/);
  assert.match(block, /DELETE FROM rate_limits WHERE substr\(key, 1, \?\) = \?/);
  // 학급 소유 확인을 지난 뒤에만 이 동작에 닿는다.
  assert.ok(route.indexOf("ownedClassroom(teacher.id, classroomId)") < route.indexOf('if (action === "clearEntryLocks")'));
});
