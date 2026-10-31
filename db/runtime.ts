import { operationsSchema } from "@/lib/operations-schema";
import { bookProductionSchema } from "@/lib/book-production-schema";
import { createArtworksStore } from "@/db/adapters/artworks-store";
import { createDatabase } from "@/db/adapters/database";
import { PostgresD1 } from "@/db/adapters/postgres-d1";
import { postgresSchemaStatements, postgresSetupStatements } from "@/db/postgres-schema";
import { upgradeMvp3Schema } from "@/lib/mvp3-schema-upgrade";
import { runtimeEnvironment } from "@/lib/runtime/environment";

export interface WiggleEnv {
  DB: D1Database;
  ARTWORKS: R2Bucket;
}

let cachedEnv: WiggleEnv | undefined;

export function bindings(): WiggleEnv {
  if (!cachedEnv) {
    const environment = runtimeEnvironment();
    // 어댑터는 D1/R2에서 실제로 쓰는 표면만 구현한다. 전체 인터페이스 타입은
    // 호출부 38곳의 제네릭 시그니처를 보존하기 위해 여기서 한 번만 좁혀 단언한다.
    cachedEnv = {
      DB: createDatabase(environment) as unknown as D1Database,
      ARTWORKS: createArtworksStore(environment) as unknown as R2Bucket,
    };
  }
  return cachedEnv;
}

const schemaStatements = [
  `CREATE TABLE IF NOT EXISTS teachers (id TEXT PRIMARY KEY NOT NULL, email TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, credential_hash TEXT, credential_salt TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS teacher_sessions (token_hash TEXT PRIMARY KEY NOT NULL, teacher_id TEXT NOT NULL REFERENCES teachers(id) ON DELETE CASCADE, expires_at TEXT NOT NULL, last_used_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS classrooms (id TEXT PRIMARY KEY NOT NULL, teacher_id TEXT NOT NULL REFERENCES teachers(id), display_name TEXT NOT NULL, class_code TEXT NOT NULL UNIQUE, join_token TEXT NOT NULL UNIQUE, admission_open INTEGER NOT NULL DEFAULT 1, active INTEGER NOT NULL DEFAULT 1, current_activity TEXT NOT NULL DEFAULT '자유롭게 그리기', current_arc_id TEXT, current_episode_id TEXT, starts_at TEXT, ends_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS student_profiles (id TEXT PRIMARY KEY NOT NULL, classroom_id TEXT NOT NULL REFERENCES classrooms(id), seat_number INTEGER, real_name TEXT, entry_code TEXT, claimed_at TEXT, nickname TEXT NOT NULL, animal TEXT NOT NULL, last_activity_at TEXT NOT NULL, archived_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS recovery_credentials (student_id TEXT PRIMARY KEY NOT NULL REFERENCES student_profiles(id) ON DELETE CASCADE, picture_hash TEXT NOT NULL, picture_salt TEXT NOT NULL, personal_qr_hash TEXT NOT NULL, reset_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS device_sessions (token_hash TEXT PRIMARY KEY NOT NULL, student_id TEXT NOT NULL REFERENCES student_profiles(id) ON DELETE CASCADE, expires_at TEXT NOT NULL, last_used_at TEXT NOT NULL, revoked_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS artworks (id TEXT PRIMARY KEY NOT NULL, student_id TEXT NOT NULL REFERENCES student_profiles(id), classroom_id TEXT NOT NULL REFERENCES classrooms(id), title TEXT NOT NULL, topic TEXT NOT NULL, learning_mode TEXT NOT NULL, lesson_slug TEXT, guide_variant INTEGER NOT NULL DEFAULT 0, arc_id TEXT, episode_id TEXT, arc_version INTEGER, intent TEXT NOT NULL DEFAULT '', ops_json TEXT NOT NULL DEFAULT '[]', schema_version INTEGER NOT NULL DEFAULT 1, renderer_version INTEGER NOT NULL DEFAULT 1, revision INTEGER NOT NULL DEFAULT 0, current_step INTEGER NOT NULL DEFAULT 0, version_count INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'drawing', thumbnail_key TEXT, final_image_key TEXT, last_mutation_id TEXT, completed_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS artwork_versions (id TEXT PRIMARY KEY NOT NULL, artwork_id TEXT NOT NULL REFERENCES artworks(id) ON DELETE CASCADE, sequence INTEGER NOT NULL, ops_json TEXT NOT NULL, image_key TEXT, reason TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(artwork_id, sequence))`,
  `CREATE TABLE IF NOT EXISTS artwork_mutations (request_id TEXT NOT NULL, artwork_id TEXT NOT NULL REFERENCES artworks(id) ON DELETE CASCADE, student_id TEXT NOT NULL REFERENCES student_profiles(id) ON DELETE CASCADE, result_revision INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(artwork_id, student_id, request_id))`,
  `CREATE TABLE IF NOT EXISTS storybooks (id TEXT PRIMARY KEY NOT NULL, student_id TEXT NOT NULL REFERENCES student_profiles(id) ON DELETE CASCADE, classroom_id TEXT NOT NULL REFERENCES classrooms(id) ON DELETE CASCADE, title TEXT NOT NULL, document_json TEXT NOT NULL, schema_version INTEGER NOT NULL DEFAULT 1, revision INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'draft', last_mutation_id TEXT, completed_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS storybook_assets (id TEXT PRIMARY KEY NOT NULL, storybook_id TEXT NOT NULL REFERENCES storybooks(id) ON DELETE CASCADE, student_id TEXT NOT NULL REFERENCES student_profiles(id) ON DELETE CASCADE, source_type TEXT NOT NULL, source_artwork_id TEXT REFERENCES artworks(id) ON DELETE SET NULL, object_key TEXT NOT NULL, content_type TEXT NOT NULL, byte_size INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS storybook_mutations (request_id TEXT NOT NULL, storybook_id TEXT NOT NULL REFERENCES storybooks(id) ON DELETE CASCADE, student_id TEXT NOT NULL REFERENCES student_profiles(id) ON DELETE CASCADE, result_revision INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(storybook_id, student_id, request_id))`,
  `CREATE TABLE IF NOT EXISTS storybook_presence (student_id TEXT PRIMARY KEY NOT NULL REFERENCES student_profiles(id) ON DELETE CASCADE, storybook_id TEXT NOT NULL REFERENCES storybooks(id) ON DELETE CASCADE, page_id TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS storybook_advice (id TEXT PRIMARY KEY NOT NULL, storybook_id TEXT NOT NULL REFERENCES storybooks(id) ON DELETE CASCADE, teacher_id TEXT NOT NULL REFERENCES teachers(id) ON DELETE CASCADE, page_id TEXT NOT NULL, page_number INTEGER NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL, seen_at TEXT)`,
  `CREATE INDEX IF NOT EXISTS storybook_advice_book_idx ON storybook_advice(storybook_id, created_at)`,
  // 그림책 ebook 보기 링크(2026-10-31). 토큰은 추측할 수 없는 값이고, 열 때마다 본인·담임·공유 켜짐을 다시 확인한다.
  // 외부 공유(shared=1)는 담임이 보호자 동의를 확인했다고 기록한 뒤에만 켜진다. 기본은 꺼짐.
  `CREATE TABLE IF NOT EXISTS storybook_ebook_links (storybook_id TEXT PRIMARY KEY NOT NULL REFERENCES storybooks(id) ON DELETE CASCADE, token TEXT NOT NULL UNIQUE, shared INTEGER NOT NULL DEFAULT 0, shared_by_teacher_id TEXT REFERENCES teachers(id) ON DELETE SET NULL, consent_method TEXT, guardian_consent_at TEXT, shared_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS storybook_feedback_requests (id TEXT PRIMARY KEY NOT NULL, storybook_id TEXT NOT NULL REFERENCES storybooks(id) ON DELETE CASCADE, classroom_id TEXT NOT NULL REFERENCES classrooms(id) ON DELETE CASCADE, teacher_id TEXT NOT NULL REFERENCES teachers(id) ON DELETE CASCADE, status TEXT NOT NULL DEFAULT 'waiting_rubric', rubric_version TEXT, feedback_json TEXT, requested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, completed_at TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(storybook_id, teacher_id))`,
  `CREATE TABLE IF NOT EXISTS coaching_events (id TEXT PRIMARY KEY NOT NULL, artwork_id TEXT NOT NULL REFERENCES artworks(id) ON DELETE CASCADE, actor TEXT NOT NULL, question TEXT NOT NULL, student_answer TEXT, applied_hint TEXT, before_version_id TEXT, after_version_id TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS coaching_event_details (event_id TEXT PRIMARY KEY NOT NULL REFERENCES coaching_events(id) ON DELETE CASCADE, response_kind TEXT NOT NULL, choices_json TEXT NOT NULL DEFAULT '[]', guide_steps_json TEXT NOT NULL DEFAULT '[]', new_elements_json TEXT NOT NULL DEFAULT '[]', growth_event TEXT, current_step INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'open', updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS reflections (artwork_id TEXT PRIMARY KEY NOT NULL REFERENCES artworks(id) ON DELETE CASCADE, favorite_part TEXT NOT NULL, favorite_reason TEXT NOT NULL, spoken_description TEXT NOT NULL DEFAULT '', story_text TEXT NOT NULL DEFAULT '', next_suggestion TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS teacher_messages (id TEXT PRIMARY KEY NOT NULL, classroom_id TEXT NOT NULL REFERENCES classrooms(id), student_id TEXT REFERENCES student_profiles(id), teacher_id TEXT NOT NULL REFERENCES teachers(id), body TEXT NOT NULL, reference_url TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS message_receipts (message_id TEXT NOT NULL REFERENCES teacher_messages(id) ON DELETE CASCADE, student_id TEXT NOT NULL REFERENCES student_profiles(id) ON DELETE CASCADE, seen_at TEXT NOT NULL, PRIMARY KEY(message_id, student_id))`,
  `CREATE TABLE IF NOT EXISTS teacher_views (teacher_id TEXT NOT NULL REFERENCES teachers(id) ON DELETE CASCADE, classroom_id TEXT NOT NULL REFERENCES classrooms(id) ON DELETE CASCADE, student_id TEXT NOT NULL REFERENCES student_profiles(id) ON DELETE CASCADE, expires_at TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(teacher_id, student_id))`,
  `CREATE TABLE IF NOT EXISTS teacher_marks (id TEXT PRIMARY KEY NOT NULL, classroom_id TEXT NOT NULL REFERENCES classrooms(id) ON DELETE CASCADE, student_id TEXT NOT NULL REFERENCES student_profiles(id) ON DELETE CASCADE, teacher_id TEXT NOT NULL REFERENCES teachers(id) ON DELETE CASCADE, artwork_id TEXT NOT NULL REFERENCES artworks(id) ON DELETE CASCADE, strokes_json TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', answer TEXT, answered_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  // 입장 코드를 거듭 틀린 기기를 잠깐 쉬게 한다(2026-09-21). 잠금 단위가 IP가 아니라 기기인 이유는
  // 학교가 반 전체로 공인 IP 하나를 쓰기 때문이다 — IP로 잠그면 교실 전체가 함께 막힌다.
  `CREATE TABLE IF NOT EXISTS entry_lockouts (device_key TEXT PRIMARY KEY NOT NULL, classroom_id TEXT, fails INTEGER NOT NULL DEFAULT 0, strikes INTEGER NOT NULL DEFAULT 0, locked_until TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  // 오래된 행 청소가 전체 스캔이 되지 않게 한다.
  `CREATE INDEX IF NOT EXISTS entry_lockouts_updated_idx ON entry_lockouts(updated_at)`,
  `CREATE TABLE IF NOT EXISTS hand_raises (student_id TEXT PRIMARY KEY NOT NULL REFERENCES student_profiles(id) ON DELETE CASCADE, classroom_id TEXT NOT NULL REFERENCES classrooms(id) ON DELETE CASCADE, raised_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS teacher_coaching_drafts (id TEXT PRIMARY KEY NOT NULL, teacher_id TEXT NOT NULL REFERENCES teachers(id) ON DELETE CASCADE, classroom_id TEXT NOT NULL REFERENCES classrooms(id) ON DELETE CASCADE, student_id TEXT NOT NULL REFERENCES student_profiles(id) ON DELETE CASCADE, artwork_id TEXT NOT NULL REFERENCES artworks(id) ON DELETE CASCADE, body TEXT NOT NULL, observation TEXT NOT NULL, next_action TEXT NOT NULL, model TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft', approved_message_id TEXT REFERENCES teacher_messages(id), approved_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY NOT NULL, count INTEGER NOT NULL, window_ends_at TEXT NOT NULL)`,
  // 만료 행 청소가 전체 스캔이 되지 않게 한다. 키에 외부 입력이 섞이는 지점이 있어 행 수가 커질 수 있다.
  `CREATE INDEX IF NOT EXISTS rate_limits_window_idx ON rate_limits(window_ends_at)`,
  `CREATE TABLE IF NOT EXISTS family_share_links (id TEXT PRIMARY KEY NOT NULL, teacher_id TEXT NOT NULL REFERENCES teachers(id) ON DELETE CASCADE, student_id TEXT NOT NULL REFERENCES student_profiles(id) ON DELETE CASCADE, scope TEXT NOT NULL, approval_kind TEXT NOT NULL, guardian_consent_at TEXT NOT NULL, consent_method TEXT NOT NULL, attested_by_teacher_id TEXT NOT NULL REFERENCES teachers(id), report_start_at TEXT NOT NULL, report_end_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT, view_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS family_share_invites (token_hash TEXT PRIMARY KEY NOT NULL, link_id TEXT NOT NULL REFERENCES family_share_links(id) ON DELETE CASCADE, kind TEXT NOT NULL, expires_at TEXT NOT NULL, consumed_at TEXT, consumed_session_hash TEXT UNIQUE, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS family_share_sessions (token_hash TEXT PRIMARY KEY NOT NULL, link_id TEXT NOT NULL REFERENCES family_share_links(id) ON DELETE CASCADE, expires_at TEXT NOT NULL, last_used_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS family_share_artworks (link_id TEXT NOT NULL REFERENCES family_share_links(id) ON DELETE CASCADE, artwork_id TEXT NOT NULL REFERENCES artworks(id) ON DELETE CASCADE, position INTEGER NOT NULL, approved_at TEXT NOT NULL, PRIMARY KEY(link_id, artwork_id), UNIQUE(link_id, position))`,
  `CREATE TABLE IF NOT EXISTS subscription_entitlements (teacher_id TEXT PRIMARY KEY NOT NULL REFERENCES teachers(id) ON DELETE CASCADE, plan_code TEXT NOT NULL DEFAULT 'free', status TEXT NOT NULL DEFAULT 'disabled', provider TEXT, external_customer_ref TEXT, external_subscription_ref TEXT, current_period_end TEXT, provider_event_at TEXT, provider_event_id TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS subscription_webhook_events (provider TEXT NOT NULL, event_id TEXT NOT NULL, payload_hash TEXT NOT NULL, occurred_at TEXT NOT NULL, signature_verified INTEGER NOT NULL, stale INTEGER NOT NULL DEFAULT 0, processed_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(provider, event_id))`,
  `CREATE INDEX IF NOT EXISTS teacher_sessions_teacher_idx ON teacher_sessions(teacher_id, expires_at)`,
  `CREATE INDEX IF NOT EXISTS students_classroom_idx ON student_profiles(classroom_id, last_activity_at)`,
  `CREATE INDEX IF NOT EXISTS device_sessions_student_idx ON device_sessions(student_id, expires_at)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS recovery_personal_qr_uq ON recovery_credentials(personal_qr_hash)`,
  `CREATE INDEX IF NOT EXISTS artworks_student_idx ON artworks(student_id, updated_at)`,
  `CREATE INDEX IF NOT EXISTS artworks_classroom_idx ON artworks(classroom_id, updated_at)`,
  `CREATE INDEX IF NOT EXISTS artwork_mutations_artwork_idx ON artwork_mutations(artwork_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS storybooks_student_idx ON storybooks(student_id, updated_at)`,
  `CREATE INDEX IF NOT EXISTS storybooks_classroom_idx ON storybooks(classroom_id, updated_at)`,
  `CREATE INDEX IF NOT EXISTS storybook_assets_book_idx ON storybook_assets(storybook_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS storybook_assets_student_idx ON storybook_assets(student_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS storybook_mutations_book_idx ON storybook_mutations(storybook_id, created_at)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS storybook_feedback_book_teacher_uq ON storybook_feedback_requests(storybook_id, teacher_id)`,
  `CREATE INDEX IF NOT EXISTS storybook_feedback_classroom_idx ON storybook_feedback_requests(classroom_id, status, requested_at)`,
  `CREATE INDEX IF NOT EXISTS coaching_details_status_idx ON coaching_event_details(status, updated_at)`,
  `CREATE INDEX IF NOT EXISTS messages_classroom_idx ON teacher_messages(classroom_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS message_receipts_student_idx ON message_receipts(student_id, seen_at)`,
  `CREATE INDEX IF NOT EXISTS teacher_views_student_idx ON teacher_views(student_id, expires_at)`,
  `CREATE INDEX IF NOT EXISTS teacher_marks_student_idx ON teacher_marks(student_id, answered_at, created_at)`,
  `CREATE INDEX IF NOT EXISTS hand_raises_classroom_idx ON hand_raises(classroom_id, raised_at)`,
  `CREATE INDEX IF NOT EXISTS teacher_drafts_owner_idx ON teacher_coaching_drafts(teacher_id, classroom_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS teacher_drafts_student_idx ON teacher_coaching_drafts(student_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS family_share_teacher_idx ON family_share_links(teacher_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS family_share_student_idx ON family_share_links(student_id, expires_at)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS family_invite_session_uq ON family_share_invites(consumed_session_hash)`,
  `CREATE INDEX IF NOT EXISTS family_invite_link_idx ON family_share_invites(link_id, expires_at)`,
  `CREATE INDEX IF NOT EXISTS family_session_link_idx ON family_share_sessions(link_id, expires_at)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS family_share_position_uq ON family_share_artworks(link_id, position)`,
  `CREATE INDEX IF NOT EXISTS family_share_artwork_idx ON family_share_artworks(artwork_id)`,
];

const expectedMutationPrimaryKey = ["artwork_id", "student_id", "request_id"];
const mutationTableReplacement = "artwork_mutations__composite_pk";

type TableColumn = { name: string; pk: number };

async function mutationTableShape(DB: D1Database, tableName = "artwork_mutations") {
  const [columns, definition] = await Promise.all([
    DB.prepare(`PRAGMA table_info(${tableName})`).all<TableColumn>(),
    DB.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`).bind(tableName).first<{ sql: string }>(),
  ]);
  const primaryKey = columns.results
    .filter((column) => column.pk > 0)
    .sort((left, right) => left.pk - right.pk)
    .map((column) => column.name);
  return { columns: columns.results, definition: definition?.sql ?? "", primaryKey };
}

async function ensureArtworkMutationPrimaryKey(DB: D1Database) {
  const shape = await mutationTableShape(DB);
  if (!shape.definition) return;

  const hasExpectedPrimaryKey = expectedMutationPrimaryKey.every((column, index) => shape.primaryKey[index] === column)
    && shape.primaryKey.length === expectedMutationPrimaryKey.length;
  const definitionHasExpectedKey = /PRIMARY\s+KEY\s*\(\s*[`"]?artwork_id[`"]?\s*,\s*[`"]?student_id[`"]?\s*,\s*[`"]?request_id[`"]?\s*\)/i.test(shape.definition);
  if (hasExpectedPrimaryKey && definitionHasExpectedKey) return;

  const requiredColumns = ["request_id", "artwork_id", "student_id", "result_revision"];
  if (!requiredColumns.every((name) => shape.columns.some((column) => column.name === name))) {
    throw new Error("artwork_mutations 테이블 구조를 안전하게 업그레이드할 수 없어요.");
  }
  const createdAtExpression = shape.columns.some((column) => column.name === "created_at") ? "created_at" : "CURRENT_TIMESTAMP";

  // D1 batch is atomic: the legacy table remains intact if any replacement step fails.
  await DB.batch([
    DB.prepare(`DROP TABLE IF EXISTS ${mutationTableReplacement}`),
    DB.prepare(`CREATE TABLE ${mutationTableReplacement} (request_id TEXT NOT NULL, artwork_id TEXT NOT NULL REFERENCES artworks(id) ON DELETE CASCADE, student_id TEXT NOT NULL REFERENCES student_profiles(id) ON DELETE CASCADE, result_revision INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(artwork_id, student_id, request_id))`),
    DB.prepare(`INSERT OR IGNORE INTO ${mutationTableReplacement}(request_id, artwork_id, student_id, result_revision, created_at) SELECT request_id, artwork_id, student_id, result_revision, ${createdAtExpression} FROM artwork_mutations`),
    DB.prepare(`DROP INDEX IF EXISTS artwork_mutations_artwork_idx`),
    DB.prepare(`DROP TABLE artwork_mutations`),
    DB.prepare(`ALTER TABLE ${mutationTableReplacement} RENAME TO artwork_mutations`),
    DB.prepare(`CREATE INDEX IF NOT EXISTS artwork_mutations_artwork_idx ON artwork_mutations(artwork_id, created_at)`),
  ]);

  const upgraded = await mutationTableShape(DB);
  const upgradedPrimaryKey = upgraded.primaryKey.join(",");
  const index = await DB.prepare(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'artwork_mutations_artwork_idx'`).first<{ sql: string }>();
  if (upgradedPrimaryKey !== expectedMutationPrimaryKey.join(",") || !index?.sql) {
    throw new Error("artwork_mutations 복합 기본키 업그레이드를 확인하지 못했어요.");
  }
}

// 스키마 생성을 DB 인자로 분리해 두면 통합 테스트가 자기 DB에 같은 스키마를 세울 수 있다.
// ensureSchema()는 프로세스당 한 번만 도는 캐시 래퍼일 뿐, 내용은 이 함수가 정본이다.
export async function provisionSchema(DB: D1Database) {
  // Postgres(Supabase)는 처음부터 최종 모양으로 세운다. 아래 SQLite 업그레이드 분기(PRAGMA·ALTER)는 Turso 운영 DB의 옛 모양을 위한 것이다.
  if (DB instanceof PostgresD1) return provisionPostgresSchema(DB);
  await DB.batch(schemaStatements.map((statement) => DB.prepare(statement)));
  await DB.batch(bookProductionSchema.map((statement) => DB.prepare(statement)));
  await DB.batch(operationsSchema.map((statement) => DB.prepare(statement)));
  await upgradeMvp3Schema(DB);
  const artworkColumns = await DB.prepare(`PRAGMA table_info(artworks)`).all<{ name: string }>();
  if (!artworkColumns.results.some((column) => column.name === "last_mutation_id")) await DB.prepare(`ALTER TABLE artworks ADD COLUMN last_mutation_id TEXT`).run();
  if (!artworkColumns.results.some((column) => column.name === "lesson_slug")) await DB.prepare(`ALTER TABLE artworks ADD COLUMN lesson_slug TEXT`).run();
  // 회차 귀속(AD-10): 작품 생성 시점에 고정되는 세 컬럼. 기존 운영 테이블에는 조건부 ALTER가 유일한 경로다.
  if (!artworkColumns.results.some((column) => column.name === "arc_id")) await DB.prepare(`ALTER TABLE artworks ADD COLUMN arc_id TEXT`).run();
  if (!artworkColumns.results.some((column) => column.name === "episode_id")) await DB.prepare(`ALTER TABLE artworks ADD COLUMN episode_id TEXT`).run();
  if (!artworkColumns.results.some((column) => column.name === "arc_version")) await DB.prepare(`ALTER TABLE artworks ADD COLUMN arc_version INTEGER`).run();
  // 팀 계약(AD-10): (student, arc, episode)에 완성 작품은 최대 하나 — 책 팀이 어느 그림을 쪽에 걸지
  // 스스로 판단하지 않게 하는 DB 보장. 레거시 행은 arc_id가 NULL이라 부분 인덱스 대상 밖이다.
  // IFNULL 정규화를 쓰면 모든 레거시 완성작이 한 슬롯에서 충돌하므로 쓰지 않는다 (Story 3.4).
  await DB.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS artworks_completed_episode_unique ON artworks(student_id, arc_id, episode_id) WHERE status = 'complete' AND arc_id IS NOT NULL AND episode_id IS NOT NULL`).run();
  // 학급 포인터(아크·회차)는 기존 운영 classrooms 테이블에 뒤늦게 추가된 컬럼이다.
  // CREATE TABLE IF NOT EXISTS는 이미 있는 테이블에 무시되므로, 이 분기가 없으면
  // 로컬·테스트(새 DB)는 통과하고 운영만 `no such column`으로 500이 난다 (AD-2).
  const classroomColumns = await DB.prepare(`PRAGMA table_info(classrooms)`).all<{ name: string }>();
  if (!classroomColumns.results.some((column) => column.name === "current_arc_id")) await DB.prepare(`ALTER TABLE classrooms ADD COLUMN current_arc_id TEXT`).run();
  if (!classroomColumns.results.some((column) => column.name === "current_episode_id")) await DB.prepare(`ALTER TABLE classrooms ADD COLUMN current_episode_id TEXT`).run();
  if (!artworkColumns.results.some((column) => column.name === "guide_variant")) await DB.prepare(`ALTER TABLE artworks ADD COLUMN guide_variant INTEGER NOT NULL DEFAULT 0`).run();
  const studentColumns = await DB.prepare(`PRAGMA table_info(student_profiles)`).all<{ name: string }>();
  if (!studentColumns.results.some((column) => column.name === "archived_at")) await DB.prepare(`ALTER TABLE student_profiles ADD COLUMN archived_at TEXT`).run();
  // 교사 명단(번호·실명)과 자리 사용 여부. 기존 학생 행은 번호·실명이 없고 claimed_at을 채워 둔다.
  if (!studentColumns.results.some((column) => column.name === "seat_number")) await DB.prepare(`ALTER TABLE student_profiles ADD COLUMN seat_number INTEGER`).run();
  if (!studentColumns.results.some((column) => column.name === "real_name")) await DB.prepare(`ALTER TABLE student_profiles ADD COLUMN real_name TEXT`).run();
  if (!studentColumns.results.some((column) => column.name === "claimed_at")) {
    await DB.prepare(`ALTER TABLE student_profiles ADD COLUMN claimed_at TEXT`).run();
    // 이미 있는 학생은 스스로 만든 프로필이므로 처음부터 자리를 쓰고 있던 것으로 본다.
    await DB.prepare(`UPDATE student_profiles SET claimed_at = created_at WHERE claimed_at IS NULL`).run();
  }
  await DB.prepare(`CREATE INDEX IF NOT EXISTS students_classroom_archived_idx ON student_profiles(classroom_id, archived_at, nickname)`).run();
  // 같은 학급 안에서 번호는 하나뿐. 빠진 학생의 번호는 다시 쓸 수 있게 archived는 제외한다.
  await DB.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS students_classroom_seat_uq ON student_profiles(classroom_id, seat_number) WHERE seat_number IS NOT NULL AND archived_at IS NULL`).run();
  // 아이별 참여 코드(2026-09-09). 수업 코드 → 참여 코드 6자리로 바로 자기 도화지에 들어온다.
  // 교사 화면에 그대로 보여 줘야 하므로 해시가 아니라 평문이다(수업 코드와 같은 등급의 값).
  if (!studentColumns.results.some((column) => column.name === "entry_code")) await DB.prepare(`ALTER TABLE student_profiles ADD COLUMN entry_code TEXT`).run();
  await backfillEntryCodes(DB);
  await DB.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS students_classroom_entry_code_uq ON student_profiles(classroom_id, entry_code) WHERE entry_code IS NOT NULL AND archived_at IS NULL`).run();
  await ensureArtworkMutationPrimaryKey(DB);
}

async function provisionPostgresSchema(DB: PostgresD1) {
  await DB.sql.begin(async (tx) => {
    for (const statement of [...postgresSetupStatements, ...postgresSchemaStatements]) await tx.unsafe(statement);
  });
  await backfillEntryCodes(DB as unknown as D1Database);
}

/* 아이별 참여 코드 네 자리(2026-09-12 사용자 결정, 종전 여섯 자리에서 줄임).
 * 여섯 자리는 저학년이 누르기 벅찼다. 반이 QR로 먼저 정해지므로 코드는 학급 안에서만
 * 고유하면 되고, 만 개 중 한 반은 수십 개다 — 찍어 맞추기는 학급+IP 한도(60회/10분)가 막는다. */
export function randomEntryCode() {
  return String(1000 + Math.floor(Math.random() * 9000));
}

// 코드가 없거나 형식이 옛것인 활성 학생의 코드를 채운다.
// 학급 안에서만 겹치지 않으면 된다 — 반은 QR이나 수업 코드로 먼저 정해진다.
async function backfillEntryCodes(DB: D1Database) {
  // 코드가 없는 행과, 네 자리가 아닌 옛 여섯 자리 코드를 함께 다시 발급한다.
  const missing = await DB.prepare(`SELECT id, classroom_id AS classroomId FROM student_profiles WHERE archived_at IS NULL AND (entry_code IS NULL OR length(entry_code) <> 4)`).all<{ id: string; classroomId: string }>();
  if (!missing.results.length) return;
  const taken = await DB.prepare(`SELECT classroom_id AS classroomId, entry_code AS entryCode FROM student_profiles WHERE entry_code IS NOT NULL AND length(entry_code) = 4 AND archived_at IS NULL`).all<{ classroomId: string; entryCode: string }>();
  const used = new Set(taken.results.map((row) => `${row.classroomId}:${row.entryCode}`));
  const statements = missing.results.map((row) => {
    let code = randomEntryCode();
    while (used.has(`${row.classroomId}:${code}`)) code = randomEntryCode();
    used.add(`${row.classroomId}:${code}`);
    return DB.prepare(`UPDATE student_profiles SET entry_code = ? WHERE id = ?`).bind(code, row.id);
  });
  for (let offset = 0; offset < statements.length; offset += 50) await DB.batch(statements.slice(offset, offset + 50));
}

let ready: Promise<void> | undefined;

export async function ensureSchema() {
  if (!ready) ready = provisionSchema(bindings().DB);
  return ready;
}
