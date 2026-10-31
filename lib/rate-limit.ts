// 검사와 증가를 한 문장으로 처리한다. 읽은 뒤 따로 증가시키면 동시 요청이 모두
// 증가 전 count를 읽어 상한을 넘겨 통과한다(무차별 대입 방어선이 무력화된다).
const CONSUME_SQL = `INSERT INTO rate_limits(key, count, window_ends_at) VALUES (?, 1, ?)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE WHEN rate_limits.window_ends_at <= ? THEN 1 ELSE rate_limits.count + 1 END,
       window_ends_at = CASE WHEN rate_limits.window_ends_at <= ? THEN ? ELSE rate_limits.window_ends_at END
     RETURNING count`;

// 공격자가 고른 값이 키에 들어가는 지점(가족 초대 토큰 등)이 있어 버킷 수가 무한히 늘 수 있다.
// 새 키가 생길 때마다 만료된 행을 조금씩 걷어내 저장 공간이 영구히 쌓이지 않게 한다.
const SWEEP_LIMIT = 200;

export async function consumeRateLimit(DB: D1Database, key: string, max: number, seconds: number, now = new Date()) {
  const at = now.toISOString();
  const ends = new Date(now.getTime() + seconds * 1000).toISOString();
  const row = await DB.prepare(CONSUME_SQL).bind(key, ends, at, at, ends).first<{ count: number }>();
  const count = row?.count ?? 1;
  if (count === 1) {
    try { await DB.prepare(`DELETE FROM rate_limits WHERE key IN (SELECT key FROM rate_limits WHERE window_ends_at <= ? LIMIT ?)`).bind(at, SWEEP_LIMIT).run(); }
    catch { /* 청소 실패가 요청을 막지 않는다 */ }
  }
  return count <= max;
}

// 틀린 시도만 세는 버킷용: 올리지 않고 이미 상한에 닿았는지만 본다. 상한에 닿은 뒤에는
// 맞는 코드도 확인해 주지 않아야 하므로, 코드를 대조하기 전에 이것으로 먼저 막는다.
export async function rateLimitReached(DB: D1Database, key: string, max: number, now = new Date()) {
  const row = await DB.prepare(`SELECT count FROM rate_limits WHERE key = ? AND window_ends_at > ?`).bind(key, now.toISOString()).first<{ count: number }>();
  return (row?.count ?? 0) >= max;
}

// 성공한 인증은 시도 카운터를 비운다. 대상 단위 한도가 무차별 대입만 막고
// 같은 태블릿을 정상적으로 여러 번 여는 아이를 잠그지 않게 한다.
export async function releaseRateLimit(DB: D1Database, key: string) {
  await DB.prepare(`DELETE FROM rate_limits WHERE key = ?`).bind(key).run();
}
