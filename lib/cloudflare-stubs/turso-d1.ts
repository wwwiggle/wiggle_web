// Cloudflare Workers 빌드용 대체 모듈(db/adapters/turso-d1.ts 자리). Workers에서는 Turso를 쓰지 않는다 — DB는 Supabase(DATABASE_URL)다.
// Next가 @libsql/client를 바깥 모듈로 남겨 두면 Workers 번들이 그 이름을 풀지 못하므로, Turso 어댑터 파일째 바꾼다.
export type D1LikeResult<T = unknown> = {
  results: T[];
  success: true;
  meta: { changes: number; last_row_id: number; duration: number; rows_read: number; rows_written: number };
};

export class TursoD1 {}

export function createTursoClientFromUrl(): never {
  throw new Error("Cloudflare에서는 DATABASE_URL(Supabase)이 필요해요.");
}

export function createTursoD1(): TursoD1 {
  throw new Error("Cloudflare에서는 DATABASE_URL(Supabase)이 필요해요.");
}
