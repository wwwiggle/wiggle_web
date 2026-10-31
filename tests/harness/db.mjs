/**
 * 통합 테스트용 D1 호환 DB 하네스 (Miniflare `d1Databases` 대체).
 *
 * 예전에는 Miniflare가 워커를 부팅해 D1을 내줬지만, Vercel 재플랫폼 뒤로는 실행 경로가
 * Next + Turso(libSQL)다. 테스트도 같은 어댑터를 통과해야 어댑터 계약(batch 원자성,
 * meta.changes, PRAGMA 재작성)이 실제로 검증된다.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTursoClientFromUrl, TursoD1 } from "../../db/adapters/turso-d1.ts";
import { createPostgresClient, PostgresD1 } from "../../db/adapters/postgres-d1.ts";
import { provisionSchema } from "../../db/runtime.ts";
import { postgresSetupStatements } from "../../db/postgres-schema.ts";

/**
 * Postgres로 돌리는 경우(`npm run test:postgres`): scripts/test-postgres.mjs가 띄운 내장 Postgres 주소가
 * WIGGLE_TEST_POSTGRES_URL로 온다. 테스트 DB마다 데이터베이스를 새로 만들어 서로 섞이지 않게 한다.
 */
export const testPostgresUrl = process.env.WIGGLE_TEST_POSTGRES_URL?.trim() || "";

async function createPostgresTestDb() {
  const name = `wiggle_t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const admin = createPostgresClient(testPostgresUrl, { max: 1 });
  await admin.unsafe(`CREATE DATABASE ${name}`);
  const url = new URL(testPostgresUrl);
  url.pathname = `/${name}`;
  const DB = new PostgresD1(createPostgresClient(url.toString()));
  // 스키마 없이 SQLite 문장을 직접 세우는 테스트도 sqlite_now()를 쓸 수 있게 기반만 먼저 깐다.
  for (const statement of postgresSetupStatements) await DB.sql.unsafe(statement);
  return {
    DB,
    url: url.toString(),
    async dispose() {
      await DB.close().catch(() => {});
      await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => {});
      await admin.end({ timeout: 5 }).catch(() => {});
    },
  };
}

// 파일 DB만 쓰는 이유: 서버 프로세스와 테스트가 같은 DB를 봐야 하고, :memory:는
// 연결마다 별개 DB라 그 공유가 성립하지 않는다. 단독 DB가 필요한 테스트도 같은 함수를 쓴다.
export async function createTestDb({ url } = {}) {
  if (testPostgresUrl && !url) return createPostgresTestDb();
  let directory;
  let databaseUrl = url;
  if (!databaseUrl) {
    directory = await mkdtemp(path.join(tmpdir(), "wiggle-test-db-"));
    databaseUrl = `file:${path.join(directory, "test.db")}`;
  }
  const client = createTursoClientFromUrl(databaseUrl);
  const DB = new TursoD1(client);
  return {
    DB,
    url: databaseUrl,
    async dispose() {
      client.close();
      if (directory) await removeQuietly(directory);
    },
  };
}

// Windows는 close() 직후에도 잠깐 파일 핸들을 붙들고 있어 unlink가 EBUSY로 튄다.
// 임시 디렉터리 삭제는 검증 대상이 아니므로 몇 번 재시도한 뒤 조용히 포기한다.
async function removeQuietly(directory) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(directory, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
}

// 앱이 실제로 쓰는 스키마 전체를 세운다 (ensureSchema와 같은 정본 경로).
export async function createSchemaDb(options) {
  const handle = await createTestDb(options);
  await provisionSchema(handle.DB);
  return handle;
}

// 테스트 사이에 행만 비운다 (스키마는 유지). 서버를 다시 띄우지 않고 격리를 만든다.
export async function resetRows(DB) {
  if (DB instanceof PostgresD1) {
    const tables = await DB.sql`SELECT tablename FROM pg_tables WHERE schemaname = 'web' ORDER BY tablename`;
    if (tables.length) await DB.sql.unsafe(`TRUNCATE ${tables.map((row) => `web."${row.tablename}"`).join(", ")} CASCADE`);
    return;
  }
  const tables = await DB.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
  ).all();
  const names = tables.results.map((row) => row.name);
  if (!names.length) return;
  await DB.batch([
    DB.prepare("PRAGMA defer_foreign_keys = ON"),
    ...names.map((name) => DB.prepare(`DELETE FROM "${name}"`)),
  ]);
}
