/**
 * 통합 테스트용 Next 서버 하네스 (Miniflare `dispatchFetch` 대체).
 *
 * 테스트 파일마다 서버 하나를 띄우고, 그 서버에 자기만의 파일 DB와 작품 디렉터리를 준다.
 * 테스트는 `server.fetch("/api/student", …)`로 진짜 HTTP 요청을 보내고, `server.DB`로
 * 같은 DB를 직접 시드한다 — 예전 하네스의 `getD1Database("DB")`와 같은 역할이다.
 *
 * 전제: `next build`가 끝나 있어야 한다(`npm test`가 build를 먼저 돌린다).
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTestDb, testPostgresUrl } from "./db.mjs";

const PROJECT_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const READY_TIMEOUT_MS = 90_000;

async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function waitForReady(origin, child, log) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`서버가 조기 종료했어요 (exit ${child.exitCode})\n${log.join("")}`);
    try {
      const response = await fetch(`${origin}/api/health`, { method: "GET" });
      // 404여도 서버가 응답한 것이므로 준비 완료로 본다.
      if (response.status) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`서버가 ${READY_TIMEOUT_MS}ms 안에 뜨지 않았어요\n${log.join("")}`);
}

/**
 * @returns {Promise<{origin: string, DB: object, fetch: Function, logs: () => string, dispose: () => Promise<void>}>}
 */
export async function startTestServer({ env: extraEnv } = {}) {
  const workDir = await mkdtemp(path.join(tmpdir(), "wiggle-test-server-"));
  const databaseUrl = `file:${path.join(workDir, "server.db")}`;
  // Postgres로 돌릴 때는 DB를 먼저 만들어 서버와 테스트가 같은 DB를 보게 한다(DATABASE_URL이 Turso보다 앞선다).
  const postgresDb = testPostgresUrl ? await createTestDb() : null;
  const artworksDir = path.join(workDir, "artworks");
  const port = await freePort();
  // 호스트 이름을 localhost로 맞춘다. 127.0.0.1로 띄우면 서버가 계산하는 자기 출처와
  // 요청의 origin 헤더가 어긋나 앱의 sameOrigin 검사에 걸린다.
  const origin = `http://localhost:${port}`;

  const child = spawn(
    process.execPath,
    [path.join(PROJECT_ROOT, "node_modules", "next", "dist", "bin", "next"), "start", "--port", String(port), "--hostname", "localhost"],
    {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        NODE_ENV: "production",
        WIGGLE_APP_ENV: "test",
        WIGGLE_DATA_ENV: "test",
        // 상위 셸이 Vercel 관련 값을 가지고 있어도 하네스는 반드시 격리된 test로 판정한다.
        VERCEL: "",
        VERCEL_ENV: "",
        TURSO_DATABASE_URL: databaseUrl,
        TURSO_AUTH_TOKEN: "",
        DATABASE_URL: postgresDb ? postgresDb.url : "",
        ARTWORKS_FS_DIR: artworksDir,
        // .env.local에 운영 R2 자격증명이 살아 있어도 테스트가 운영 버킷을 물지 않게 막는다.
        // Next는 process.env에 이미 있는 키를 .env.local로 덮어쓰지 않는다.
        R2_S3_ENDPOINT: "",
        R2_S3_BUCKET: "",
        R2_S3_ACCESS_KEY_ID: "",
        R2_S3_SECRET_ACCESS_KEY: "",
        ...extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const log = [];
  child.stdout.on("data", (chunk) => log.push(String(chunk)));
  child.stderr.on("data", (chunk) => log.push(String(chunk)));

  let handle;
  try {
    await waitForReady(origin, child, log);
    handle = postgresDb ?? await createTestDb({ url: databaseUrl });
  } catch (cause) {
    child.kill("SIGKILL");
    await postgresDb?.dispose().catch(() => {});
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
    throw cause;
  }

  return {
    origin,
    DB: handle.DB,
    logs: () => log.join(""),
    // 기본으로 동일 출처 헤더를 붙인다 — 앱의 sameOrigin 검사를 통과해야 실제 흐름이 된다.
    fetch(pathname, init = {}) {
      const headers = { origin, ...(init.headers ?? {}) };
      return fetch(new URL(pathname, origin), { ...init, headers });
    },
    async dispose() {
      // 실패 원인을 볼 때: WIGGLE_TEST_SERVER_LOG=폴더 로 서버 기록을 남긴다.
      if (process.env.WIGGLE_TEST_SERVER_LOG) {
        await writeFile(path.join(process.env.WIGGLE_TEST_SERVER_LOG, `server-${port}.log`), log.join("")).catch(() => {});
      }
      // 서버를 먼저 끈다 — Postgres는 연결이 남아 있으면 테스트 DB를 지우기 어렵다.
      child.kill("SIGKILL");
      await new Promise((resolve) => child.once("exit", resolve));
      await handle.dispose().catch(() => {});
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
    },
  };
}
