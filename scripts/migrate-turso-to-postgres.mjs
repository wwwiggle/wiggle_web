// Turso(운영 원본) → Supabase Postgres(web 스키마)로 데이터를 옮기고, 표마다 행 수와 내용 해시가 같은지 확인한다.
//
//   TURSO_DATABASE_URL=… TURSO_AUTH_TOKEN=… DATABASE_URL=… node scripts/migrate-turso-to-postgres.mjs [--truncate-target] [--verify-only]
//
// - Turso에는 SELECT만 한다. 원본은 바뀌지 않는다.
// - 대상에 행이 하나라도 있으면 멈춘다. 리허설을 다시 할 때만 --truncate-target으로 대상 web 표를 비운다.
// - 외래 키 순서(부모 → 자식)로 넣는다. 원본에 부모 없는 행이 있으면 그 표에서 멈추고 알려 준다.
// - 값은 출력하지 않는다. 표 이름·행 수·해시 일치 여부만 출력한다.
import { createHash } from "node:crypto";
import { createClient } from "@libsql/client";
import { createPostgresClient } from "../db/adapters/postgres-d1.ts";
import { postgresSchemaStatements, postgresSetupStatements } from "../db/postgres-schema.ts";

const args = new Set(process.argv.slice(2));
const truncateTarget = args.has("--truncate-target");
const verifyOnly = args.has("--verify-only");
const BATCH = 500;

const sourceUrl = process.env.TURSO_DATABASE_URL?.trim();
const targetUrl = process.env.DATABASE_URL?.trim();
if (!sourceUrl || !targetUrl) {
  console.error("TURSO_DATABASE_URL과 DATABASE_URL이 모두 필요해요.");
  process.exit(1);
}

const source = createClient({ url: sourceUrl, authToken: process.env.TURSO_AUTH_TOKEN, intMode: "number" });
const target = createPostgresClient(targetUrl, { max: 2 });

async function sourceTables() {
  const rows = (await source.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%__composite_pk'")).rows;
  const tables = [];
  for (const { name } of rows) {
    const columns = (await source.execute(`SELECT name, pk FROM pragma_table_info('${name}')`)).rows;
    const parents = (await source.execute(`SELECT DISTINCT "table" AS parent FROM pragma_foreign_key_list('${name}')`)).rows.map((row) => row.parent);
    const primaryKey = columns.filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk).map((column) => column.name);
    tables.push({ name, columns: columns.map((column) => column.name), primaryKey: primaryKey.length ? primaryKey : columns.map((column) => column.name), parents: parents.filter((parent) => parent !== name) });
  }
  return tables;
}

/* 부모 표가 먼저 오게 줄 세운다. */
function parentFirst(tables) {
  const byName = new Map(tables.map((table) => [table.name, table]));
  const ordered = [];
  const seen = new Set();
  const visit = (table, path = []) => {
    if (seen.has(table.name)) return;
    if (path.includes(table.name)) throw new Error(`외래 키가 돌고 있어요: ${[...path, table.name].join(" → ")}`);
    for (const parent of table.parents) if (byName.has(parent)) visit(byName.get(parent), [...path, table.name]);
    seen.add(table.name);
    ordered.push(table);
  };
  for (const table of tables) visit(table);
  return ordered;
}

const quote = (name) => `"${name.replace(/"/g, '""')}"`;

async function* sourcePages(table) {
  const order = table.primaryKey.map(quote).join(", ");
  for (let offset = 0; ; offset += BATCH) {
    const page = await source.execute({ sql: `SELECT ${table.columns.map(quote).join(", ")} FROM ${quote(table.name)} ORDER BY ${order} LIMIT ? OFFSET ?`, args: [BATCH, offset] });
    if (!page.rows.length) return;
    yield page.rows.map((row) => table.columns.map((column) => row[column] ?? null));
    if (page.rows.length < BATCH) return;
  }
}

async function* targetPages(table) {
  const order = table.primaryKey.map(quote).join(", ");
  for (let offset = 0; ; offset += BATCH) {
    const rows = await target.unsafe(`SELECT ${table.columns.map(quote).join(", ")} FROM web.${quote(table.name)} ORDER BY ${order} LIMIT ${BATCH} OFFSET ${offset}`);
    if (!rows.length) return;
    yield rows.map((row) => table.columns.map((column) => row[column] ?? null));
    if (rows.length < BATCH) return;
  }
}

/* 두 DB에서 같은 순서로 읽은 행의 해시. 정렬 규칙 차이를 피하려고 행마다 해시를 내고 정렬한 뒤 합친다. */
async function digest(pages) {
  const rowHashes = [];
  for await (const page of pages) for (const row of page) rowHashes.push(createHash("sha256").update(JSON.stringify(row)).digest("hex"));
  rowHashes.sort();
  return { count: rowHashes.length, hash: createHash("sha256").update(rowHashes.join("")).digest("hex").slice(0, 16) };
}

async function prepareTarget(tables) {
  await target.begin(async (tx) => {
    for (const statement of [...postgresSetupStatements]) await tx.unsafe(statement);
    await tx.unsafe("SET LOCAL search_path = web, public");
    for (const statement of postgresSchemaStatements) await tx.unsafe(statement);
  });
  const existing = [];
  for (const table of tables) {
    const [{ count }] = await target.unsafe(`SELECT COUNT(*)::int AS count FROM web.${quote(table.name)}`);
    if (count) existing.push(`${table.name}(${count})`);
  }
  if (!existing.length) return;
  if (!truncateTarget) throw new Error(`대상에 이미 행이 있어요: ${existing.join(", ")}. 리허설을 다시 할 때만 --truncate-target을 붙이세요.`);
  await target.unsafe(`TRUNCATE ${tables.map((table) => `web.${quote(table.name)}`).join(", ")} CASCADE`);
  console.log(`대상 표 ${tables.length}개를 비웠어요.`);
}

async function copy(table) {
  let copied = 0;
  for await (const page of sourcePages(table)) {
    const columns = table.columns.map(quote).join(", ");
    const values = page.map((row, rowIndex) => `(${row.map((_, columnIndex) => `$${rowIndex * row.length + columnIndex + 1}`).join(", ")})`).join(", ");
    try {
      await target.unsafe(`INSERT INTO web.${quote(table.name)} (${columns}) VALUES ${values}`, page.flat());
    } catch (cause) {
      throw new Error(`${table.name} 넣기 실패(${copied}행 뒤): ${cause instanceof Error ? cause.message : cause}`);
    }
    copied += page.length;
  }
  return copied;
}

let failed = false;
try {
  const tables = parentFirst(await sourceTables());
  console.log(`원본 표 ${tables.length}개: ${tables.map((table) => table.name).join(", ")}`);
  if (!verifyOnly) {
    await prepareTarget(tables);
    const started = Date.now();
    for (const table of tables) console.log(`옮김 ${table.name}: ${await copy(table)}행`);
    console.log(`옮기기 끝 (${Math.round((Date.now() - started) / 1000)}초)`);
  }
  console.log("확인: 표마다 행 수와 내용 해시를 비교해요.");
  for (const table of tables) {
    const [from, to] = await Promise.all([digest(sourcePages(table)), digest(targetPages(table))]);
    const same = from.count === to.count && from.hash === to.hash;
    if (!same) failed = true;
    console.log(`${same ? "같음" : "다름"} ${table.name}: 원본 ${from.count}행 / 대상 ${to.count}행`);
  }
  console.log(failed ? "결과: 다른 표가 있어요. 전환하지 마세요." : "결과: 모든 표가 같아요.");
} catch (cause) {
  failed = true;
  console.error(cause instanceof Error ? cause.message : cause);
} finally {
  source.close();
  await target.end({ timeout: 5 });
}
process.exit(failed ? 1 : 0);
