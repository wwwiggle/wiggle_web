/**
 * DB 고르기. DATABASE_URL(Postgres)이 있으면 Supabase, 없으면 지금까지처럼 Turso.
 *
 * 2026-10-31 Turso → Supabase 이사 중이라 두 길을 함께 둔다. 운영 전환은 Vercel 환경 변수에 DATABASE_URL을 넣는 것으로 하고,
 * 문제가 생기면 지우기만 하면 Turso로 돌아간다. 이사가 끝나면 Turso 길을 걷어 낸다.
 */
import { assertDataEnvironment, runtimeEnvironment, type EnvironmentSource, type WiggleRuntimeEnvironment } from "../../lib/runtime/environment.ts";
import { createPostgresD1, type PostgresD1 } from "./postgres-d1.ts";
import { createTursoD1, type TursoD1 } from "./turso-d1.ts";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function createDatabase(
  environment: WiggleRuntimeEnvironment = runtimeEnvironment(),
  source: EnvironmentSource = process.env,
): TursoD1 | PostgresD1 {
  const url = source.DATABASE_URL?.trim();
  if (!url) return createTursoD1(environment, source);

  assertDataEnvironment(environment, source);
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    throw new Error("DATABASE_URL 형식이 올바르지 않아요.");
  }
  // Turso 길과 같은 경계: 로컬·테스트가 원격(운영) DB에 쓰는 사고를 막는다(2026-08-19 실제 사고).
  if ((environment === "local" || environment === "test") && !LOCAL_HOSTS.has(host)) {
    throw new Error(`${environment} 환경에서는 원격 DATABASE_URL을 사용할 수 없어요.`);
  }
  if ((environment === "preview" || environment === "production") && LOCAL_HOSTS.has(host)) {
    throw new Error(`${environment} 환경에서는 로컬 DATABASE_URL을 사용할 수 없어요.`);
  }
  return createPostgresD1(url);
}
