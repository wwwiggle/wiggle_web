import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createTestDb } from "./harness/db.mjs";
import { consumeRateLimit, releaseRateLimit } from "../lib/rate-limit.ts";

async function fixture() {
  const handle = await createTestDb();
  await handle.DB.exec("CREATE TABLE rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0, window_ends_at TEXT NOT NULL)");
  return { mf: { dispose: () => handle.dispose() }, DB: handle.DB };
}

test("attempts past the cap are rejected within one window", async () => {
  const { mf, DB } = await fixture();
  try {
    const now = new Date("2026-07-28T09:00:00.000Z");
    const results = [];
    for (let attempt = 0; attempt < 5; attempt += 1) results.push(await consumeRateLimit(DB, "unlock:student_a", 3, 600, now));
    assert.deepEqual(results, [true, true, true, false, false]);
  } finally { await mf.dispose(); }
});

test("a parallel burst cannot slip past the cap", async () => {
  const { mf, DB } = await fixture();
  try {
    const now = new Date("2026-07-28T09:00:00.000Z");
    // 읽고-나서-증가하는 구현이면 40개가 모두 count 0을 읽어 전부 통과한다.
    const burst = await Promise.all(Array.from({ length: 40 }, () => consumeRateLimit(DB, "unlock:student_burst", 8, 600, now)));
    assert.equal(burst.filter(Boolean).length, 8, "동시 요청에서도 허용된 시도는 정확히 상한만큼이어야 한다");
    const stored = await DB.prepare("SELECT count FROM rate_limits WHERE key = 'unlock:student_burst'").first();
    assert.equal(stored.count, 40, "모든 시도가 원자적으로 계수되어야 한다");
  } finally { await mf.dispose(); }
});

test("a window boundary burst resets the counter exactly once", async () => {
  const { mf, DB } = await fixture();
  try {
    const now = new Date("2026-07-28T09:00:00.000Z");
    for (let attempt = 0; attempt < 8; attempt += 1) await consumeRateLimit(DB, "unlock:student_window", 8, 600, now);
    assert.equal(await consumeRateLimit(DB, "unlock:student_window", 8, 600, now), false);
    const afterWindow = new Date(now.getTime() + 600_001);
    const burst = await Promise.all(Array.from({ length: 20 }, () => consumeRateLimit(DB, "unlock:student_window", 8, 600, afterWindow)));
    assert.equal(burst.filter(Boolean).length, 8, "창이 새로 열려도 상한은 그대로여야 한다");
  } finally { await mf.dispose(); }
});

test("keys are independent and a success releases only its own counter", async () => {
  const { mf, DB } = await fixture();
  try {
    const now = new Date("2026-07-28T09:00:00.000Z");
    for (let attempt = 0; attempt < 8; attempt += 1) await consumeRateLimit(DB, "unlock:student_a", 8, 600, now);
    assert.equal(await consumeRateLimit(DB, "unlock:student_a", 8, 600, now), false);
    assert.equal(await consumeRateLimit(DB, "unlock:student_b", 8, 600, now), true, "다른 학생의 시도는 막히면 안 된다");
    await releaseRateLimit(DB, "unlock:student_a");
    assert.equal(await consumeRateLimit(DB, "unlock:student_a", 8, 600, now), true, "성공 인증 뒤에는 다시 시도할 수 있어야 한다");
    const others = await DB.prepare("SELECT count FROM rate_limits WHERE key = 'unlock:student_b'").first();
    assert.equal(others.count, 1);
  } finally { await mf.dispose(); }
});

test("student entry limits separate shared classroom IP traffic from per-target guessing", async () => {
  const route = await readFile(new URL("../app/api/student/route.ts", import.meta.url), "utf8");
  // 학교 NAT 뒤 한 학급 전체가 IP 하나로 보이므로 IP 한도는 학급 규모를 견뎌야 한다.
  assert.match(route, /const IP_ENTRY_LIMIT = (\d+)/);
  assert.ok(Number(route.match(/const IP_ENTRY_LIMIT = (\d+)/)[1]) >= 120);
  // 참여 코드 입장(2026-09-09)에는 대상(번호·프로필) 버킷이 없다 — 맞추기 전까지 대상을 모르므로
  // 학급 + IP 버킷(맞는 시도 포함 120회/10분)과 틀린 시도만 세는 상한이 무차별 대입을 막는다(2026-10-31).
  assert.doesNotMatch(route, /TARGET_ATTEMPT_LIMIT|targetAllowed|picturePassword/);
  assert.match(route, /const CLASSROOM_JOIN_LIMIT = 120;/);
  assert.match(route, /\{ seconds: 10 \* 60, classCode: 30, seatCode: 20 \}/);
  assert.match(route, /\{ seconds: 24 \* 60 \* 60, classCode: 150, seatCode: 80 \}/);
  // 학급 상한은 IP와 함께 묶는다. 학급 단독 버킷이면 한 클라이언트가 학급 전체를 잠글 수 있다.
  assert.match(route, /rateLimit\(`student-join-class:\$\{classroom\.id\}:\$\{requestIp\(request\)\}`/);
  // 형태 검증이 학급 상한보다 먼저 와야 잘못된 본문이 상한을 소비하지 못한다.
  assert.ok(route.indexOf("참여 코드 네 자리를 눌러 주세요") < route.indexOf("student-join-class:"));
});
