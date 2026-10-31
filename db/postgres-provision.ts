/**
 * Postgres(Supabase) 스키마 세우기. 서버가 깨어날 때마다 불린다(ensureSchema).
 *
 * 2026-11-01 운영 전환 직후 "tuple concurrently updated"로 학생 입장이 500이 났다. 서버 여러 대가 함께 깨어나
 * CREATE OR REPLACE FUNCTION 같은 구조 변경을 동시에 돌린 탓이다. 그래서:
 * 1. 이미 다 세워져 있으면(표·칸·인덱스·함수가 모두 있으면) 구조 변경을 아예 하지 않는다 — 평소에는 조회 하나로 끝난다.
 * 2. 무언가 빠졌을 때만 트랜잭션 잠금(pg_advisory_xact_lock)을 잡고 한 서버만 세운다. 잠금을 기다린 서버는 다시 확인해
 *    이미 세워졌으면 그냥 나간다. 연결 풀러(트랜잭션 모드)라 세션 잠금이 아니라 트랜잭션 잠금을 쓴다.
 * 3. SQLite 스키마에 칸을 더해 db/postgres-schema.ts의 CREATE TABLE에도 칸을 더하면, 이미 있는 표에는
 *    ALTER TABLE … ADD COLUMN IF NOT EXISTS로 그 칸을 붙인다(CREATE TABLE IF NOT EXISTS는 있는 표를 건너뛰므로).
 */
import type { Sql, TransactionSql } from "postgres";
import { postgresSchemaStatements, postgresSetupStatements } from "./postgres-schema.ts";

const SCHEMA = "web";
const LOCK_KEY = "wiggle_web.schema";

type Shape = { tables: Map<string, { name: string; definition: string }[]>; indexes: Set<string> };

function splitTopLevel(body: string) {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of body) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else current += char;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/** db/postgres-schema.ts에서 기대하는 표·칸·인덱스. */
export function expectedPostgresShape(statements = postgresSchemaStatements): Shape {
  const tables: Shape["tables"] = new Map();
  const indexes = new Set<string>();
  for (const statement of statements) {
    const table = /^CREATE TABLE IF NOT EXISTS ([a-z_]+) \(([\s\S]*)\)$/.exec(statement);
    if (table) {
      const columns = splitTopLevel(table[2])
        .filter((part) => !/^(PRIMARY|UNIQUE|FOREIGN|CHECK|CONSTRAINT)\b/i.test(part))
        .map((definition) => ({ name: definition.split(/\s+/)[0], definition }));
      tables.set(table[1], columns);
      continue;
    }
    const index = /^CREATE (?:UNIQUE )?INDEX IF NOT EXISTS ([a-z_]+) /.exec(statement);
    if (index) indexes.add(index[1]);
  }
  return { tables, indexes };
}

type Query = Pick<Sql, "unsafe"> | Pick<TransactionSql, "unsafe">;

/** 빠진 칸(표 → 칸 정의)과, 표·인덱스·함수가 하나라도 빠졌는지. */
async function missingParts(query: Query, shape: Shape) {
  const [columns, indexes, functions] = await Promise.all([
    query.unsafe(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = $1`, [SCHEMA]),
    query.unsafe(`SELECT indexname FROM pg_indexes WHERE schemaname = $1`, [SCHEMA]),
    query.unsafe(`SELECT to_regprocedure('${SCHEMA}.sqlite_now()') IS NOT NULL AS ok`),
  ]);
  const present = new Map<string, Set<string>>();
  for (const row of columns as unknown as { table_name: string; column_name: string }[]) {
    if (!present.has(row.table_name)) present.set(row.table_name, new Set());
    present.get(row.table_name)!.add(row.column_name);
  }
  const presentIndexes = new Set((indexes as unknown as { indexname: string }[]).map((row) => row.indexname));
  let structural = !(functions as unknown as { ok: boolean }[])[0]?.ok;
  const missingColumns: { table: string; definition: string }[] = [];
  for (const [table, expected] of shape.tables) {
    const have = present.get(table);
    if (!have) {
      structural = true;
      continue;
    }
    for (const column of expected) if (!have.has(column.name)) missingColumns.push({ table, definition: column.definition });
  }
  for (const index of shape.indexes) if (!presentIndexes.has(index)) structural = true;
  return { structural, missingColumns, complete: !structural && !missingColumns.length };
}

/** 스키마를 세운다. 이미 다 있으면 false(구조 변경 없음), 세웠으면 true. */
export async function provisionPostgres(sql: Sql, shape = expectedPostgresShape()): Promise<boolean> {
  if ((await missingParts(sql, shape)).complete) return false;
  return sql.begin(async (tx) => {
    await tx.unsafe(`SELECT pg_advisory_xact_lock(hashtext($1))`, [LOCK_KEY]);
    // 잠금을 기다리는 동안 다른 서버가 다 세웠을 수 있다.
    const missing = await missingParts(tx, shape);
    if (missing.complete) return false;
    if (missing.structural) {
      for (const statement of [...postgresSetupStatements, ...postgresSchemaStatements]) await tx.unsafe(statement);
    }
    for (const column of missing.missingColumns) {
      await tx.unsafe(`ALTER TABLE ${SCHEMA}.${column.table} ADD COLUMN IF NOT EXISTS ${column.definition}`);
    }
    return true;
  }) as Promise<boolean>;
}

/**
 * 한 번 성공하면 다시 하지 않고, 실패하면 기억하지 않는 문.
 * 실패를 기억하면 그 서버는 꺼질 때까지 모든 요청이 같은 오류로 실패한다(2026-11-01 운영 사고).
 */
export function onceUntilSuccess(task: () => Promise<void>) {
  let ready: Promise<void> | undefined;
  return () => {
    if (!ready) {
      ready = task().catch((error) => {
        ready = undefined;
        throw error;
      });
    }
    return ready;
  };
}
