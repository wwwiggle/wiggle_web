import assert from "node:assert/strict";
import test, { after } from "node:test";
import { resetRows } from "./harness/db.mjs";
import { startTestServer } from "./harness/server.mjs";
import { nicknameKeySql, nicknameMatchKey, nicknameRateKeyPart } from "../lib/nickname.ts";
import { FALLBACK_NICKNAME, NICKNAME_IDEAS, pickDifferentNickname } from "../lib/nickname-ideas.ts";

const ANIMALS = ["🐰", "🐻", "🦊", "🐯", "🐼", "🐶", "🐱", "🐨", "🦁", "🐸", "🐧", "🐹", "🐷", "🐵", "🐮", "🐑", "🦒", "🐘", "🦉", "🦦"];

// Next 서버 기동은 프로세스 하나 값이라 테스트마다 띄우면 비싸다. 파일 하나에 서버 하나만 띄우고,
// 테스트가 끝날 때마다 행을 비워 격리한다. 학급 코드 4321은 UNIQUE라 초기화 없이는 두 번째 시드가 깨진다.
let booting;

async function sharedServer() {
  if (!booting) booting = bootServer();
  return booting;
}

async function bootServer() {
  const server = await startTestServer();
  // 스키마는 서버가 첫 요청을 받을 때 세운다. 시드보다 먼저 한 번 찔러 테이블을 만들어 둔다.
  const initialized = await server.fetch("/api/student", studentRequest({ action: "unsupported" }));
  assert.equal(initialized.status, 400);
  return server;
}

after(async () => {
  if (booting) await booting.then((server) => server.dispose(), () => {});
});

function studentRequest(body, ip = "203.0.113.60") {
  // 주소는 x-forwarded-for로 흉내 낸다. cf-connecting-ip는 Cloudflare가 사라져 앱이 더 이상 믿지 않는다.
  return {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  };
}

async function seedClassroom(DB, suffix, seats = 1) {
  await DB.batch([
    DB.prepare(`INSERT INTO teachers(id, email, display_name) VALUES ('teacher_${suffix}', '${suffix}@example.com', 'Spacing')`),
    DB.prepare(`INSERT INTO classrooms(id, teacher_id, display_name, class_code, join_token) VALUES ('class_${suffix}', 'teacher_${suffix}', '공백 학급', '4321', 'join_${suffix}')`),
    // 입장은 선생님 명단의 번호로만 한다. 빈 자리를 미리 만들어 둔다.
    ...Array.from({ length: seats }, (_, index) => DB.prepare(`INSERT INTO student_profiles(id, classroom_id, seat_number, real_name, entry_code, claimed_at, nickname, animal, last_activity_at) VALUES ('student_${suffix}_${index + 1}', 'class_${suffix}', ${index + 1}, '학생${index + 1}', '${String(index + 1).repeat(4)}', NULL, '${index + 1}번', '❔', '2026-09-07T00:00:00.000Z')`)),
  ]);
  return "class_" + suffix;
}

test("nickname match key ignores every whitespace difference but never merges different Korean characters", () => {
  assert.equal(nicknameMatchKey("토끼 화가"), "토끼화가");
  assert.equal(nicknameMatchKey("  토끼   화가  "), "토끼화가");
  assert.equal(nicknameMatchKey("토끼\t화가"), "토끼화가");
  assert.equal(nicknameMatchKey("토끼 화가"), "토끼화가");
  assert.equal(nicknameMatchKey("토끼　화가"), "토끼화가");
  assert.notEqual(nicknameMatchKey("토기 화가"), nicknameMatchKey("토끼 화가"));
  assert.equal(nicknameRateKeyPart("  Rabbit  화가 "), "rabbit화가");
  // SQL 식은 저장된 별명에서 같은 공백 집합을 지운다. migration 없이 기존 행을 찾는 근거.
  for (const escaped of ["' '", "CHAR(9)", "CHAR(10)", "CHAR(13)", "CHAR(160)", "CHAR(12288)"]) {
    assert.ok(nicknameKeySql("nickname").includes(escaped), escaped);
  }
});

test("every animal offers at least 10 unique, easy-to-read nickname ideas", () => {
  const allKeys = new Set();
  for (const animal of ANIMALS) {
    const ideas = NICKNAME_IDEAS[animal];
    assert.ok(Array.isArray(ideas), `${animal} has ideas`);
    assert.ok(ideas.length >= 10, `${animal} has ${ideas.length} ideas`);
    for (const idea of ideas) {
      // 초등학생이 읽기 쉬운 한글 낱말과 단일 공백만 사용하고, 입력 상한 16자를 넘지 않는다.
      assert.match(idea, /^[가-힣]+( [가-힣]+)*$/, idea);
      assert.ok(idea.length >= 2 && idea.length <= 16, idea);
      // 공백을 지운 비교 기준으로도 전체 후보가 서로 다른 별명이어야 한다.
      const key = nicknameRateKeyPart(idea);
      assert.ok(!allKeys.has(key), `duplicate idea: ${idea}`);
      allKeys.add(key);
    }
  }
  assert.equal(Object.keys(NICKNAME_IDEAS).length, ANIMALS.length);
});

test("the dice never repeats the current nickname and cycles through far more than two ideas", () => {
  for (const animal of ANIMALS) {
    const ideas = NICKNAME_IDEAS[animal];
    for (const current of ideas) {
      const seen = new Set();
      for (let step = 0; step < 100; step += 1) {
        const next = pickDifferentNickname(ideas, current, step / 100);
        assert.notEqual(next, current, `${animal} repeated ${current}`);
        assert.ok(ideas.includes(next));
        seen.add(next);
      }
      assert.equal(seen.size, ideas.length - 1, `${animal} from ${current} reaches every other idea`);
    }
  }
  // 연속으로 눌러도 두 별명만 왕복하지 않는다: 결정적 roll 순서로 6번 눌러 4개 이상 등장.
  const ideas = NICKNAME_IDEAS["🐰"];
  let current = ideas[0];
  const sequence = [];
  const rolls = [0.05, 0.35, 0.65, 0.95, 0.15, 0.55];
  for (const roll of rolls) {
    current = pickDifferentNickname(ideas, current, roll);
    sequence.push(current);
  }
  assert.ok(new Set(sequence).size >= 4, sequence.join(", "));
  for (let i = 1; i < sequence.length; i += 1) assert.notEqual(sequence[i], sequence[i - 1]);
  // 후보가 하나뿐인 경계에서도 현재 별명을 그대로 돌려주지 않는다.
  assert.equal(pickDifferentNickname(["토끼 화가"], "토끼 화가", 0.5), FALLBACK_NICKNAME);
  assert.equal(pickDifferentNickname(["가", "나"], "가", 1), "나");
});

/* 입장과 재입장이 참여 코드로 바뀌면서(2026-09-09) 별명 중복·공백 변형으로 프로필을 찾던
 * 계약은 사라졌다. 코드가 이미 한 사람을 가리키므로 별명이 겹쳐도 상관없다.
 * 위의 순수 함수 테스트는 그대로 둔다 — 첫 입장의 동물에 붙는 기본 별명에 여전히 쓰인다.
 * 여기서는 그 자리를 대신할 실제 계약, 즉 코드 재입장과 무차별 대입 차단을 검증한다. */

test("참여 코드로만 재입장하고, 별명이 겹쳐도 서로 다른 학생이다", async (context) => {
  const server = await sharedServer();
  context.after(() => resetRows(server.DB));
  const DB = server.DB;
  await seedClassroom(DB, "codeentry", 2);

  // 두 아이가 같은 동물(같은 기본 별명)을 골라도 코드가 다르면 다른 학생이다.
  const first = await server.fetch("/api/student", studentRequest({ action: "join", entry: "4321", entryCode: "1111", animal: "🐰" }, "203.0.113.61"));
  assert.equal(first.status, 201);
  const second = await server.fetch("/api/student", studentRequest({ action: "join", entry: "4321", entryCode: "2222", animal: "🐰" }, "203.0.113.62"));
  assert.equal(second.status, 201);
  const firstPayload = await first.json();
  const secondPayload = await second.json();
  assert.equal(firstPayload.student.nickname, secondPayload.student.nickname);
  assert.notEqual(firstPayload.student.id, secondPayload.student.id);

  // 재입장은 자기 코드로만 된다.
  const recovered = await server.fetch("/api/student", studentRequest({ action: "join", entry: "4321", entryCode: "1111" }, "203.0.113.63"));
  assert.equal(recovered.status, 200);
  assert.equal((await recovered.json()).student.id, firstPayload.student.id);
  assert.equal((await DB.prepare("SELECT COUNT(*) AS count FROM student_profiles").first()).count, 2);
});

test("같은 코드로 동시에 들어와도 자리는 하나이고, 늦은 쪽도 같은 학생으로 들어온다", async (context) => {
  const server = await sharedServer();
  context.after(() => resetRows(server.DB));
  const DB = server.DB;
  await seedClassroom(DB, "codeclaim", 1);

  const joined = await server.fetch("/api/student", studentRequest({ action: "join", entry: "4321", entryCode: "1111", animal: "🐰" }, "203.0.113.70"));
  assert.equal(joined.status, 201);
  const mine = (await joined.json()).student;

  // 남이(혹은 내 두 번째 태블릿이) 같은 코드로 동물을 다시 골라도 동물·별명은 처음 것이 남는다.
  const late = await server.fetch("/api/student", studentRequest({ action: "join", entry: "4321", entryCode: "1111", animal: "🐻" }, "203.0.113.71"));
  assert.equal(late.status, 200);
  const latePayload = await late.json();
  assert.equal(latePayload.student.id, mine.id);
  assert.equal(latePayload.student.animal, "🐰");
  assert.equal((await DB.prepare("SELECT COUNT(*) AS count FROM student_profiles WHERE claimed_at IS NOT NULL").first()).count, 1);

  // 명단에 없는 코드는 404로만 답하고 누가 있는지 알려 주지 않는다.
  const missing = await server.fetch("/api/student", studentRequest({ action: "join", entry: "4321", entryCode: "9999", animal: "🐰" }, "203.0.113.73"));
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error, "참여 코드를 다시 확인해 주세요.");
});

test("한 학급에 코드를 반복해서 틀리면 그 IP는 학급 버킷에서 잠긴다", async (context) => {
  const server = await sharedServer();
  context.after(() => resetRows(server.DB));
  const DB = server.DB;
  await seedClassroom(DB, "ratelimit", 1);

  // 틀린 시도 상한은 학급 + IP 20회/10분(2026-10-31). 기기 식별값을 매번 바꿔 기기 잠금을 피해도
  // 같은 IP에서 20번 틀리면 맞는 코드도 막힌다.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const failed = await server.fetch("/api/student", studentRequest({ action: "join", entry: "4321", entryCode: String(9000 + attempt), deviceKey: `rotating-${String(attempt).padStart(4, "0")}` }, "203.0.113.90"));
    assert.equal(failed.status, 404, `attempt ${attempt}`);
  }
  const blocked = await server.fetch("/api/student", studentRequest({ action: "join", entry: "4321", entryCode: "1111", animal: "🐰" }, "203.0.113.90"));
  assert.equal(blocked.status, 429);
  // 다른 IP(다른 교실)는 여전히 들어온다.
  const other = await server.fetch("/api/student", studentRequest({ action: "join", entry: "4321", entryCode: "1111", animal: "🐰" }, "203.0.113.91"));
  assert.equal(other.status, 201);
});
