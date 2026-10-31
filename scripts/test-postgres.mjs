// 전체 테스트를 Postgres(Supabase와 같은 엔진)로 돌린다: `npm run test:postgres`.
// 내장 Postgres 17을 임시 폴더에 띄우고, 테스트 하네스가 테스트 DB마다 데이터베이스를 새로 만든다.
// Turso 전용 동작(PRAGMA·SQLite 업그레이드)을 확인하는 테스트는 POSTGRES_SKIP에 두고 건너뛴다.
import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";

const POSTGRES_SKIP = new Set(["turso-adapters.test.mjs", "legacy-migration.test.mjs"]);

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const directory = await mkdtemp(path.join(tmpdir(), "wiggle-test-pg-"));
const port = await freePort();
const password = "wiggle-test";
const pg = new EmbeddedPostgres({
  databaseDir: directory,
  user: "postgres",
  password,
  port,
  persistent: false,
  postgresFlags: ["-c", "max_connections=400", "-c", "fsync=off"],
  onLog: () => {},
});

let code = 1;
try {
  await pg.initialise();
  await pg.start();
  const only = process.argv.slice(2);
  const files = only.length
    ? only
    : (await readdir("tests")).filter((name) => name.endsWith(".test.mjs") && !POSTGRES_SKIP.has(name)).sort().map((name) => path.join("tests", name));
  code = await new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "./tests/harness/register.mjs", "--test", ...files], {
      stdio: "inherit",
      env: { ...process.env, WIGGLE_TEST_POSTGRES_URL: `postgres://postgres:${password}@127.0.0.1:${port}/postgres` },
    });
    child.once("exit", (exitCode) => resolve(exitCode ?? 1));
  });
} finally {
  await pg.stop().catch(() => {});
  await rm(directory, { recursive: true, force: true }).catch(() => {});
}
process.exit(code);
