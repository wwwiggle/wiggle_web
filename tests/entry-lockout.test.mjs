import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { decayedStrikes, ENTRY_FAIL_LIMIT, ENTRY_FAIL_LIMIT_LATE, ENTRY_LOCK_STEPS_SECONDS, ENTRY_STRIKE_RESET_SECONDS, failLimitFor, lockMessage, lockRemainingSeconds, lockSecondsFor, normalizeDeviceKey } from "../lib/entry-lockout.ts";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

/* 입장 코드 잠금 (2026-09-21 사용자 결정).
 * 다섯 번 틀리면 그 **기기만** 잠깐 쉰다. 이 시험이 지키는 핵심은 "잠금 단위가 기기"라는 것이다 —
 * 학교는 반 전체가 공인 IP 하나를 쓰므로, IP로 잠그면 한 아이 때문에 교실 전체가 못 들어간다. */

test("5번 20초 · 5번 1분 · 5번 3분 · 그 뒤 3번 10분", () => {
  // 2026-09-22 사용자 결정. 단계마다 쉬는 시간뿐 아니라 "몇 번 틀려야 잠기는지"도 달라진다.
  assert.equal(ENTRY_FAIL_LIMIT, 5);
  assert.equal(ENTRY_FAIL_LIMIT_LATE, 3);
  assert.deepEqual([...ENTRY_LOCK_STEPS_SECONDS], [20, 60, 180, 600]);
  // 아직 안 잠겼거나 한두 번 잠겼으면 다섯 번이다.
  assert.equal(failLimitFor(0), 5);
  assert.equal(failLimitFor(1), 5);
  assert.equal(failLimitFor(2), 5);
  // 세 번 잠긴 뒤부터는 세 번만 틀려도 잠근다 — 거기까지 갔으면 찍고 있을 가능성이 크다.
  assert.equal(failLimitFor(3), 3);
  assert.equal(failLimitFor(7), 3);
  // 쉬는 시간
  assert.equal(lockSecondsFor(1), 20);
  assert.equal(lockSecondsFor(2), 60);
  assert.equal(lockSecondsFor(3), 180);
  assert.equal(lockSecondsFor(4), 600);
  // 마지막 칸을 넘어도 끝없이 늘지 않는다.
  assert.equal(lockSecondsFor(9), 600);
});

test("한참 조용했으면 단계가 처음으로 돌아간다", () => {
  // 없으면 아침에 한 번 잠긴 아이가 오후에 첫 실수로 3분을 기다린다(2026-09-22 사용자 보고).
  const now = Date.parse("2026-09-22T10:00:00.000Z");
  const recent = new Date(now - 60_000).toISOString();
  const old = new Date(now - (ENTRY_STRIKE_RESET_SECONDS + 1) * 1000).toISOString();
  assert.equal(ENTRY_STRIKE_RESET_SECONDS, 5 * 60, "5분 조용하면 처음으로(2026-09-22 사용자 결정)");
  assert.equal(decayedStrikes(2, recent, now), 2, "방금 전 기록은 그대로 센다");
  assert.equal(decayedStrikes(2, old, now), 0, "오래됐으면 처음부터");
  assert.equal(lockSecondsFor(decayedStrikes(2, old, now) + 1), 20, "되돌아간 뒤 첫 잠금은 20초");
});

test("남은 시간은 0 아래로 내려가지 않는다", () => {
  const now = Date.parse("2026-09-21T00:00:00.000Z");
  assert.equal(lockRemainingSeconds(new Date(now + 30_000).toISOString(), now), 30);
  assert.equal(lockRemainingSeconds(new Date(now - 30_000).toISOString(), now), 0);
  assert.equal(lockRemainingSeconds(null, now), 0);
});

test("기기 식별자는 안전한 글자만 받는다", () => {
  // 이 값이 그대로 저장소 키가 되므로 좁게 받는다.
  assert.equal(normalizeDeviceKey("abcd1234efgh5678"), "abcd1234efgh5678");
  assert.equal(normalizeDeviceKey("짧음"), "");
  assert.equal(normalizeDeviceKey("has space and/slash"), "");
  assert.equal(normalizeDeviceKey("x".repeat(65)), "");
  assert.equal(normalizeDeviceKey(undefined), "");
});

test("아이에게 보여 줄 문구는 분과 초를 섞지 않는다", () => {
  assert.match(lockMessage(45), /45초 뒤에/);
  assert.match(lockMessage(180), /3분 뒤에/);
  assert.match(lockMessage(20), /20초 뒤에/);
  // 기다리는 동안 갈 곳을 알려 준다.
  assert.match(lockMessage(45), /선생님을 불러도 돼요/);
});

test("잠금 단위는 IP가 아니라 기기다", async () => {
  const [route, client] = await Promise.all([
    read("../app/api/student/route.ts"),
    read("../lib/student-entry-client.ts"),
  ]);
  // 기기 키로 세고, 기기 키로 잠근다.
  assert.match(route, /const deviceKey = await entryDeviceKey\(request, payload\.deviceKey\);/);
  // 식별값을 빼고 보내도 잠금을 피하지 못하게, 없으면 IP에서 만든 키로 센다(2026-10-31).
  assert.match(route, /return normalizeDeviceKey\(value\) \|\| `ip-\$\{\(await sha256\(requestIp\(request\)\)\)\.slice\(0, 40\)\}`;/);
  assert.match(route, /FROM entry_lockouts WHERE device_key = \?/);
  // 브라우저가 스스로 만들어 보관한다. 저장소를 못 쓰면 입장 자체를 막지는 않는다.
  assert.match(client, /export function entryDeviceKey/);
  assert.match(client, /crypto\.getRandomValues/);
  assert.match(client, /return "";/);
});

test("수업 코드와 참여 코드가 같은 계수를 쓴다", async () => {
  const route = await read("../app/api/student/route.ts");
  // 따로 세면 둘을 번갈아 찍어 두 배로 시도할 수 있다.
  const join = route.slice(route.indexOf('if (action === "join")'));
  const noted = [...join.matchAll(/noteEntryFailure\(deviceKey, (null|classroom\.id)\)/g)].map((m) => m[1]);
  assert.deepEqual(noted, ["null", "classroom.id"], "수업 코드 틀림과 참여 코드 틀림 둘 다 센다");
});

test("잠긴 기기는 맞는 코드도 통과시키지 않고, 맞히면 계수를 지운다", async () => {
  const route = await read("../app/api/student/route.ts");
  // 맞는지 확인해 주는 것 자체가 찍기를 돕는다 — 잠금 확인이 코드 조회보다 먼저다.
  const join = route.slice(route.indexOf('if (action === "join")'));
  assert.ok(join.indexOf("lockState(deviceKey)") < join.indexOf("classroomForEntry"), "잠금 확인이 먼저");
  // 다섯 번째에 맞힌 아이가 벌을 받으면 안 된다.
  assert.match(join, /await clearEntryFailures\(deviceKey\);/);
});

test("선생님 화면이 잠긴 기기를 손들기처럼 알려 준다", async () => {
  const [teacherRoute, workspace] = await Promise.all([
    read("../app/api/teacher/route.ts"),
    read("../app/components/TeacherWorkspace.tsx"),
  ]);
  // 잠금은 기기 단위라 누구인지는 알 수 없다 — 몇 대가 막혔는지만 알린다.
  assert.match(teacherRoute, /FROM entry_lockouts WHERE classroom_id = \? AND locked_until > \?/);
  assert.match(teacherRoute, /entryLocks: lockedRow\?\.n \?\? 0/);
  // 손들기와 같은 줄에 서서 세 탭 어디서나 보인다.
  assert.match(workspace, /entryLocks > 0 && <span className="tcw-entry-lock">/);
  assert.match(workspace, /입장이 잠긴 기기 \{entryLocks\}대/);
  // 손든 사람이 없어도 잠긴 기기가 있으면 줄이 뜬다.
  assert.match(workspace, /if \(!raised\.length && entryLocks <= 0\) return null;/);
});

test("선생님이 학급 잠금을 한꺼번에 풀 수 있다", async () => {
  const [teacherRoute, settings] = await Promise.all([
    read("../app/api/teacher/route.ts"),
    read("../app/components/TeacherRosterSettings.tsx"),
  ]);
  // 잠금은 기기 단위라 서버가 어느 아이인지 모른다 — 학급 단위로만 풀 수 있다.
  assert.match(teacherRoute, /action === "clearEntryLocks"/);
  assert.match(teacherRoute, /DELETE FROM entry_lockouts WHERE classroom_id = \?/);
  assert.match(settings, /입장 잠금 풀기/);
});

test("잠기기 전에 남은 횟수를 미리 알려 준다", async () => {
  const [route, join] = await Promise.all([
    read("../app/api/student/route.ts"),
    read("../app/components/JoinClient.tsx"),
  ]);
  // 다섯 번째에 갑자기 막히면 아이가 무슨 일인지 모른다(2026-09-21 사용자 요청).
  assert.match(route, /attemptsLeft: limit - fails/);
  assert.match(route, /const limit = failLimitFor\(state\.strikes\);/);
  // 기기 키가 없으면 세지 않는다 — 0을 보내면 "남은 횟수 0"으로 읽힌다.
  assert.match(route, /\.\.\.\(failure\.attemptsLeft \? \{ attemptsLeft: failure\.attemptsLeft \} : \{\}\)/);
  // 2026-09-22 사용자 지시: 틀림이 쌓이는 화면은 시안 1의 연초록 안내다(빨간 경고 상자를 쓰지 않는다).
  assert.match(join, /const codeErrorNotice = errorKind === "code";/);
  assert.match(join, /앞으로 \$\{attemptsLeft\}번 더 틀리면 잠깐 쉬어요\./);
  assert.match(join, /참여 코드가 맞는지 다시 확인해 봐/);
});

test("잠기면 숫자판을 잠그고 옆에 기다림 카드를 세운다", async () => {
  const [join, css] = await Promise.all([
    read("../app/components/JoinClient.tsx"),
    read("../app/globals.css"),
  ]);
  // 2026-09-22 사용자 시안. 숫자판을 치우면 아이가 무엇을 기다리는지 잃고,
  // 안내를 아래에 덧붙이면 화면이 갑자기 늘어나 단추가 밀린다 — 그래서 옆으로 세운다.
  assert.match(join, /const waiting = errorKind === "locked" && lockLeft > 0;/);
  assert.match(join, /className="entry-wait-panel"/);
  assert.match(join, /잠깐 기다리는 동안/);
  assert.match(join, /후에 다시 입력할 수 있어요\./);
  // 숫자판은 남되 눌리지 않고, 보내기 단추가 남은 시간을 말한다.
  assert.match(join, /disabled=\{waiting\} onClick=\{\(\) => pressKey\(digit\)\}/);
  assert.match(join, /waiting \? "잠시 기다리는 중" : busy/);
  // 잠긴 동안에도 선생님께 도움을 청할 길이 남는다.
  // 실제로 메시지를 보내는 기능이 아니므로 기존 문구를 쓴다(인계 지시) — 허위 "요청 완료"를 만들지 않는다.
  assert.match(join, /선생님 불러요/);
  // 좁은 화면에서는 옆에 세울 자리가 없어 위아래로 쌓는다.
  assert.match(css, /\.entry-code-layout\.is-waiting \{ flex-direction:column;/);
});

test("잠금 기록이 스키마에 있다", async () => {
  const runtime = await read("../db/runtime.ts");
  assert.match(runtime, /CREATE TABLE IF NOT EXISTS entry_lockouts/);
  assert.match(runtime, /device_key TEXT PRIMARY KEY/);
});
