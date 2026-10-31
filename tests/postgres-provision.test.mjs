import assert from "node:assert/strict";
import test from "node:test";
import { createPostgresClient, PostgresD1 } from "../db/adapters/postgres-d1.ts";
import { expectedPostgresShape, onceUntilSuccess, provisionPostgres } from "../db/postgres-provision.ts";
import { provisionSchema } from "../db/runtime.ts";
import { createTestDb, testPostgresUrl } from "./harness/db.mjs";

// 2026-11-01 운영 전환 직후: 서버 여러 대가 함께 깨어나 스키마 세우기를 동시에 돌리다 "tuple concurrently updated"가 났고,
// 실패를 기억한 서버가 학생 입장을 계속 500으로 돌려줬다. 동시에 깨어나도 안전하고, 실패해도 다음 요청에서 다시 시도해야 한다.

const postgresOnly = { skip: testPostgresUrl ? false : "npm run test:postgres에서만 돈다" };

test("서버 여러 대가 빈 DB에서 동시에 깨어나도 스키마 세우기가 충돌하지 않는다", postgresOnly, async () => {
  const handle = await createTestDb();
  const servers = Array.from({ length: 8 }, () => createPostgresClient(handle.url, { max: 1 }));
  try {
    const results = await Promise.all(servers.map((sql) => provisionPostgres(sql)));
    assert.equal(results.filter(Boolean).length >= 1, true, "적어도 한 서버는 세웠다");
    // 다 세워진 뒤에는 구조 변경 없이 조회만 한다.
    assert.equal(await provisionPostgres(servers[0]), false);
    // 앱 경로(provisionSchema)도 동시에 여러 번 불러도 된다.
    await Promise.all(servers.map((sql) => provisionSchema(new PostgresD1(sql))));
  } finally {
    await Promise.all(servers.map((sql) => sql.end({ timeout: 5 })));
    await handle.dispose();
  }
});

test("이미 있는 표에 새로 더한 칸은 다음에 깨어날 때 붙는다", postgresOnly, async () => {
  const handle = await createTestDb();
  const sql = createPostgresClient(handle.url, { max: 1 });
  try {
    await provisionPostgres(sql);
    await sql.unsafe("ALTER TABLE web.classrooms DROP COLUMN current_episode_id");
    assert.equal(await provisionPostgres(sql), true);
    const [column] = await sql.unsafe("SELECT column_name FROM information_schema.columns WHERE table_schema = 'web' AND table_name = 'classrooms' AND column_name = 'current_episode_id'");
    assert.ok(column);
    assert.equal(await provisionPostgres(sql), false);
  } finally {
    await sql.end({ timeout: 5 });
    await handle.dispose();
  }
});

test("스키마 세우기가 한 번 실패해도 기억하지 않고 다음 요청에서 다시 한다", async () => {
  let calls = 0;
  const gate = onceUntilSuccess(async () => {
    calls += 1;
    if (calls === 1) throw new Error("tuple concurrently updated");
  });
  await assert.rejects(gate(), /tuple concurrently updated/);
  await gate();
  await gate();
  assert.equal(calls, 2, "성공한 뒤에는 다시 하지 않는다");
});

test("기대하는 스키마 모양을 표·칸·인덱스로 읽는다", () => {
  const shape = expectedPostgresShape();
  assert.ok(shape.tables.get("classrooms").some((column) => column.name === "current_episode_id"));
  assert.ok(!shape.tables.get("artwork_versions").some((column) => column.name.startsWith("UNIQUE")));
  assert.ok(shape.indexes.has("artworks_completed_episode_unique"));
});
