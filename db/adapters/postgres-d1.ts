/**
 * D1 호환 Postgres(Supabase) 어댑터.
 *
 * 호출부는 D1(SQLite) 문법과 API를 그대로 쓴다. Turso 어댑터와 같은 계약을 지키면서,
 * SQLite와 Postgres의 차이 중 호출부 전체에 퍼진 것만 여기서 한 번에 맞춘다:
 * - `?` 자리표시자 → `$1, $2 …`
 * - `CURRENT_TIMESTAMP` → `sqlite_now()` (SQLite와 같은 'YYYY-MM-DD HH:MM:SS' 텍스트. 시각 칸이 TEXT라 형식이 섞이면 비교가 깨진다)
 * - `datetime(x)` → `CAST(x AS timestamptz)` (형식이 다른 두 시각을 비교할 때만 쓰인다)
 * - `CHAR(9)` → `chr(9)` (별명 비교에서 공백 문자를 지울 때 쓴다)
 * - `json_array_length(x, '$.k')`·`json_extract(x, '$.k')` → Postgres JSON 연산자 (JSON은 TEXT 칸에 들어 있다)
 * - `x IS NOT 2` → `x IS DISTINCT FROM 2`
 * - `datetime('now','-5 minutes')` → 같은 형식의 Postgres 시각 텍스트
 * - 바깥 쿼리가 안쪽 camelCase 별칭을 따옴표 없이 부르는 곳도 같은 이름으로 맞춘다
 * - `AS camelCase` 별칭 → `AS "camelCase"` (Postgres는 따옴표 없는 이름을 소문자로 바꾼다)
 * - 결과의 true/false → 1/0, 정수(bigint)·numeric → JS number (SQLite·D1과 같은 모양)
 * - 매개변수 true/false → 1/0, undefined → null (D1과 같다)
 * - batch()는 한 트랜잭션, meta.changes는 문장별 영향 행 수
 * 문자열 리터럴('…')과 따옴표 이름("…") 안은 바꾸지 않는다.
 */
import postgres, { type Sql } from "postgres";
import type { D1LikeResult } from "./turso-d1.ts";

type Value = string | number | bigint | boolean | null | undefined | Uint8Array | ArrayBuffer;
type Executor = Pick<Sql, "unsafe">;

const ALIAS = /\bAS\s+([A-Za-z_][A-Za-z0-9_]*)/gi;
const DATETIME = /\bdatetime\(\s*([^()]+?)\s*\)/gi;

/** 리터럴·따옴표 이름 밖의 SQL 조각에만 fn을 적용한다. */
function outsideQuotes(sql: string, fn: (part: string) => string): string {
  let out = "";
  let index = 0;
  while (index < sql.length) {
    const quote = sql.slice(index).search(/['"]/);
    if (quote < 0) return out + fn(sql.slice(index));
    const start = index + quote;
    out += fn(sql.slice(index, start));
    const mark = sql[start];
    let end = start + 1;
    while (end < sql.length) {
      if (sql[end] === mark && sql[end + 1] === mark) end += 2;
      else if (sql[end] === mark) break;
      else end += 1;
    }
    out += sql.slice(start, end + 1);
    index = end + 1;
  }
  return out;
}

// 대상은 칸 이름이나 COALESCE(칸, '{}'). json_extract는 지금 숫자 값(판 버전)에만 쓰여 numeric으로 꺼낸다.
const JSON_PATH = /\bjson_(array_length|extract)\(\s*([A-Za-z_][\w.]*|COALESCE\(\s*[A-Za-z_][\w.]*\s*,\s*'\{\}'\s*\))\s*,\s*'\$\.([A-Za-z_]\w*)'\s*\)/gi;

// datetime('now','-5 minutes'): 오래 멈춘 작업을 다시 잡을 때 쓴다. 같은 'YYYY-MM-DD HH:MM:SS' 텍스트로 만들어 TEXT 칸과 그대로 비교한다.
const NOW_MINUS = /\bdatetime\(\s*'now'\s*,\s*'-(\d+) (minutes|hours|days)'\s*\)/gi;

export function toPostgresSql(sql: string): string {
  let position = 0;
  const source = sql
    .replace(JSON_PATH, (_match, fn: string, column: string, key: string) =>
      fn.toLowerCase() === "extract" ? `CAST(CAST(${column} AS json)->>'${key}' AS numeric)` : `json_array_length(CAST(${column} AS json)->'${key}')`,
    )
    .replace(NOW_MINUS, (_match, amount: string, unit: string) => `to_char(timezone('UTC', now()) - interval '${amount} ${unit}', 'YYYY-MM-DD HH24:MI:SS')`);
  const aliases = new Set<string>();
  outsideQuotes(source, (part) => {
    for (const match of part.matchAll(ALIAS)) if (/[A-Z]/.test(match[1])) aliases.add(match[1]);
    return part;
  });
  const bareAlias = aliases.size ? new RegExp(`(?<![."\\w$])(${[...aliases].join("|")})(?![\\w"(])`, "g") : null;
  return outsideQuotes(source, (part) =>
    part
      // `? IS NULL`만 있으면 Postgres가 매개변수 타입을 정하지 못한다. 이런 자리에는 문자열 ID가 온다.
      .replace(/\?(\s+IS\s+(?:NOT\s+)?NULL\b)/gi, "CAST(? AS text)$1")
      .replace(/\?/g, () => `$${++position}`)
      .replace(/\bCURRENT_TIMESTAMP\b/gi, "sqlite_now()")
      .replace(DATETIME, "CAST($1 AS timestamptz)")
      .replace(/\bCHAR\((\d+)\)/g, "chr($1)")
      // SQLite의 `x IS NOT 2`(값 비교, NULL 포함) = Postgres의 IS DISTINCT FROM
      .replace(/\bIS\s+NOT\s+(\d+)\b/gi, "IS DISTINCT FROM $1")
      .replace(ALIAS, (match, name: string) => (/[A-Z]/.test(name) ? `AS "${name}"` : match))
      .replace(bareAlias ?? /$^/, (name) => `"${name}"`),
  );
}

function toParameter(value: Value): string | number | bigint | null | Uint8Array {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return value;
}

function toRow(row: Record<string, unknown>): Record<string, unknown> {
  for (const key of Object.keys(row)) {
    if (typeof row[key] === "boolean") row[key] = row[key] ? 1 : 0;
  }
  return row;
}

function toD1Result<T>(rows: Record<string, unknown>[] & { count?: number }): D1LikeResult<T> {
  const changes = rows.count ?? 0;
  return {
    results: rows.map((row) => toRow({ ...row }) as T),
    success: true,
    meta: { changes, last_row_id: 0, duration: 0, rows_read: rows.length, rows_written: changes },
  };
}

export class PostgresPreparedStatement {
  private readonly sql: string;
  private readonly args: Value[];
  private readonly executor: () => Executor;

  constructor(executor: () => Executor, sql: string, args: Value[] = []) {
    this.executor = executor;
    this.sql = sql;
    this.args = args;
  }

  bind(...values: Value[]): PostgresPreparedStatement {
    return new PostgresPreparedStatement(this.executor, this.sql, values);
  }

  async execute(executor: Executor = this.executor()) {
    const text = toPostgresSql(this.sql);
    try {
      const rows = await executor.unsafe(text, this.args.map(toParameter) as never[]);
      return rows as unknown as Record<string, unknown>[] & { count?: number };
    } catch (cause) {
      // 어느 문장이 깨졌는지 서버 기록에서 바로 보이게 한다. 값은 싣지 않는다(자리표시자만 있는 SQL).
      if (cause instanceof Error) cause.message = `${cause.message} — SQL: ${text.replace(/\s+/g, " ").slice(0, 300)}`;
      throw cause;
    }
  }

  async first<T = unknown>(): Promise<T | null> {
    const rows = await this.execute();
    return rows[0] === undefined ? null : (toRow({ ...rows[0] }) as T);
  }

  async all<T = unknown>(): Promise<D1LikeResult<T>> {
    return toD1Result<T>(await this.execute());
  }

  async run<T = unknown>(): Promise<D1LikeResult<T>> {
    return toD1Result<T>(await this.execute());
  }
}

export class PostgresD1 {
  private readonly client: Sql | (() => Sql);

  /** 고정 클라이언트(Vercel·로컬·테스트) 또는 요청마다 클라이언트를 돌려주는 함수(Cloudflare Workers). */
  constructor(client: Sql | (() => Sql)) {
    this.client = client;
  }

  get sql(): Sql {
    return typeof this.client === "function" && !("unsafe" in this.client) ? (this.client as () => Sql)() : (this.client as Sql);
  }

  prepare(sql: string): PostgresPreparedStatement {
    return new PostgresPreparedStatement(() => this.sql, sql);
  }

  async batch(statements: PostgresPreparedStatement[]): Promise<D1LikeResult[]> {
    return this.sql.begin(async (tx) => {
      const results: D1LikeResult[] = [];
      for (const statement of statements) results.push(toD1Result(await statement.execute(tx)));
      return results;
    }) as Promise<D1LikeResult[]>;
  }

  async exec(sql: string): Promise<void> {
    await this.sql.unsafe(sql).simple();
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }
}

// int8(20)·numeric(1700)은 문자열로 오는데, D1·Turso는 number를 돌려줬다(JSON 직렬화와 비교 코드가 그 모양에 기댄다).
const numberTypes = {
  int8: { to: 20, from: [20], serialize: (value: number | bigint) => String(value), parse: (value: string) => Number(value) },
  numeric: { to: 1700, from: [1700], serialize: (value: number) => String(value), parse: (value: string) => Number(value) },
};

/**
 * 연결 문자열은 Supabase 연결 풀러(트랜잭션 모드, 6543) 주소를 쓴다. 풀러는 준비된 문장을 이어 쓰지 못해 prepare를 끈다.
 * 꿈틀 웹 테이블은 web 스키마에 있다. 운영 역할에는 search_path를 역할 설정으로 걸어 두고(풀러가 시작 매개변수를 넘기지 않을 수 있다),
 * 직접 연결(로컬·테스트)에서는 시작 매개변수로도 건다.
 */
export function createPostgresClient(url: string, options: { max?: number } = {}): Sql {
  return postgres(url, {
    prepare: false,
    max: options.max ?? 5,
    idle_timeout: 20,
    connect_timeout: 10,
    onnotice: () => undefined,
    connection: { search_path: "web,public" },
    types: numberTypes as never,
  });
}

/**
 * Cloudflare Workers에서는 한 요청이 연 연결(소켓)을 다른 요청이 쓸 수 없다("Cannot perform I/O on behalf of a different request").
 * 그래서 Workers에서는 요청마다 연결을 하나 만들고(요청 문맥을 키로) 그 요청 안에서만 쓴다. 요청이 끝나면 Workers가 소켓을 닫는다.
 * Vercel·로컬·테스트(Node)는 지금처럼 연결 하나를 돌려 쓴다.
 */
export function createPostgresD1(url: string, options?: { max?: number; requestScope?: () => object }): PostgresD1 {
  if (!options?.requestScope) return new PostgresD1(createPostgresClient(url, options));
  const scope = options.requestScope;
  const clients = new WeakMap<object, Sql>();
  return new PostgresD1(() => {
    const key = scope();
    let client = clients.get(key);
    if (!client) {
      client = createPostgresClient(url, { max: 1 });
      clients.set(key, client);
    }
    return client;
  });
}
