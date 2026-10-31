import assert from "node:assert/strict";
import test from "node:test";
import { createTursoClientFromUrl, TursoD1 } from "../db/adapters/turso-d1.ts";
import { toPostgresSql } from "../db/adapters/postgres-d1.ts";
import { postgresSchemaStatements } from "../db/postgres-schema.ts";
import { provisionSchema } from "../db/runtime.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Turso → Supabase 이사 동안 두 스키마를 함께 둔다(2026-10-31). SQLite에 칸·테이블을 더하고 Postgres에 빠뜨리면
// DATABASE_URL로 바꾸는 순간 운영에서만 `column does not exist`가 난다. 여기서 칸 구성이 같은지 먼저 잡는다.
function postgresColumns() {
  const tables = new Map();
  for (const statement of postgresSchemaStatements) {
    const match = /^CREATE TABLE IF NOT EXISTS ([a-z_]+) \((.*)\)$/s.exec(statement);
    if (!match) continue;
    const columns = [];
    let depth = 0;
    let current = "";
    for (const char of match[2]) {
      if (char === "(") depth += 1;
      if (char === ")") depth -= 1;
      if (char === "," && depth === 0) { columns.push(current.trim()); current = ""; } else current += char;
    }
    columns.push(current.trim());
    tables.set(match[1], columns.filter((column) => !/^(PRIMARY|UNIQUE|FOREIGN|CHECK|CONSTRAINT)\b/i.test(column)).map((column) => column.split(/\s+/)[0]));
  }
  return tables;
}

test("Postgres 스키마는 SQLite 최종 스키마와 테이블·칸 구성이 같다", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "wiggle-schema-"));
  const client = createTursoClientFromUrl(`file:${path.join(directory, "schema.db")}`);
  try {
    await provisionSchema(new TursoD1(client));
    const sqliteTables = (await client.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")).rows.map((row) => row.name);
    const postgres = postgresColumns();
    assert.deepEqual([...postgres.keys()].sort(), sqliteTables);
    for (const table of sqliteTables) {
      const columns = (await client.execute(`SELECT name FROM pragma_table_info('${table}')`)).rows.map((row) => row.name);
      assert.deepEqual(postgres.get(table), columns, table);
    }
  } finally {
    client.close();
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
});

test("SQL 변환은 문자열 안을 건드리지 않고 SQLite 습관을 Postgres로 옮긴다", () => {
  assert.equal(
    toPostgresSql("SELECT a.created_at AS createdAt FROM t WHERE id = ? AND note = 'why? CURRENT_TIMESTAMP' AND b IS NOT 2 ORDER BY createdAt"),
    `SELECT a.created_at AS "createdAt" FROM t WHERE id = $1 AND note = 'why? CURRENT_TIMESTAMP' AND b IS DISTINCT FROM 2 ORDER BY "createdAt"`,
  );
  assert.equal(toPostgresSql("UPDATE t SET at = CURRENT_TIMESTAMP WHERE ? IS NULL OR x = ?"), "UPDATE t SET at = sqlite_now() WHERE CAST($1 AS text) IS NULL OR x = $2");
  assert.equal(toPostgresSql("SELECT json_array_length(b.doc, '$.pages') AS pageCount"), `SELECT json_array_length(CAST(b.doc AS json)->'pages') AS "pageCount"`);
  assert.match(toPostgresSql("WHERE updated_at < datetime('now','-5 minutes')"), /interval '5 minutes'/);
});

// DB 이사 기간에는 앱과 테스트가 두 DB에서 모두 돌아야 한다. SQLite에만 있는 문법을 새로 쓰면 Postgres에서만 깨진다
// (2026-11-01 PR #38 테스트 준비 코드가 그랬다). 두 DB 공통으로 쓰는 법:
// INSERT OR IGNORE → INSERT … ON CONFLICT DO NOTHING, strftime(…'now') → JS new Date().toISOString() 바인딩, COLLATE NOCASE → lower().
test("앱·테스트 코드에 SQLite 전용 문법을 새로 쓰지 않는다", async () => {
  const { readdir, readFile } = await import("node:fs/promises");
  // SQLite 전용 경로를 일부러 다루는 파일만 예외: 옛 Turso 스키마 업그레이드, Turso 어댑터 시험, 옛 마이그레이션 원문을 확인하는 보안 회귀 시험.
  const allowed = new Set(["db/runtime.ts", "tests/turso-adapters.test.mjs", "tests/security-regressions.test.mjs", "tests/postgres-schema.test.mjs"]);
  const offenders = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = `${directory}/${entry.name}`;
      if (entry.isDirectory()) { if (entry.name !== "node_modules") await walk(file); continue; }
      if (!/\.(ts|tsx|mjs)$/.test(entry.name) || allowed.has(file)) continue;
      const text = await readFile(file, "utf8");
      if (/INSERT OR (IGNORE|REPLACE)|strftime\(|COLLATE NOCASE/.test(text)) offenders.push(file);
    }
  }
  for (const directory of ["app", "lib", "db", "tests"]) await walk(directory);
  assert.deepEqual(offenders, []);
});
