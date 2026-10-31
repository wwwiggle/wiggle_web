import assert from "node:assert/strict";
import test from "node:test";
import { startTestServer } from "./harness/server.mjs";

// DB 이사 당일 점검 모드: 상태 확인만 열고 나머지 API는 503으로 멈춘다. 꺼져 있으면 아무 영향이 없다.
test("점검 모드는 상태 확인을 뺀 API를 503으로 막고, 끄면 평소대로 돈다", async () => {
  const paused = await startTestServer({ env: { WIGGLE_MAINTENANCE: "1" } });
  try {
    const health = await paused.fetch("/api/health");
    assert.equal(health.status, 200);
    for (const [path, init] of [
      ["/api/student", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "join", entry: "1234", entryCode: "1234" }) }],
      ["/api/student", {}],
      ["/api/teacher", {}],
    ]) {
      const response = await paused.fetch(path, init);
      assert.equal(response.status, 503, path);
      assert.equal(response.headers.get("retry-after"), "300");
      const body = await response.json();
      assert.equal(body.maintenance, true);
      assert.match(body.error, /점검 중/);
    }
  } finally {
    await paused.dispose();
  }

  const open = await startTestServer();
  try {
    const response = await open.fetch("/api/student", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "nothing" }) });
    assert.notEqual(response.status, 503);
  } finally {
    await open.dispose();
  }
});
