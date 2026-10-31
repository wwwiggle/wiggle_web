import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createTestDb, testPostgresUrl } from "./harness/db.mjs";
import {
  createFamilyHandoffInvite,
  createFamilyShare,
  exchangeFamilyInvite,
  peekFamilyInvite,
  FAMILY_HANDOFF_TTL_SECONDS,
  FAMILY_INITIAL_INVITE_TTL_SECONDS,
  familySecurityHeaders,
  familySessionCookieHeader,
  resolveFamilySession,
  revokeFamilyShare,
} from "../lib/family-sharing.ts";
import { buildWeeklyGrowthReport, canonicalEvaluationPolicyText, compactFamilyPolicyText, containsFamilyPii, containsQualitativeEvaluation, containsQuantifiedEvaluation, emailJoinedFamilyPolicyText, isAllowedFamilyEvidence, normalizeFamilyPolicyText, redactFamilyText } from "../lib/growth-reports.ts";
import { sha256 } from "../lib/token-crypto.ts";
import { subscriptionCapability, verifyAndApplySubscriptionWebhook } from "../lib/subscriptions.ts";
import { upgradeMvp3Schema } from "../lib/mvp3-schema-upgrade.ts";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const TOKEN_A = "A".repeat(43); const TOKEN_B = "B".repeat(43); const TOKEN_C = "C".repeat(43);
const TOKEN_D = "D".repeat(43); const TOKEN_E = "E".repeat(43); const TOKEN_F = "F".repeat(43);
const TOKEN_G = "G".repeat(43); const TOKEN_H = "H".repeat(43); const TOKEN_I = "I".repeat(43);
const TOKEN_J = "J".repeat(43); const TOKEN_K = "K".repeat(43); const TOKEN_L = "L".repeat(43);

async function fixture() {
  // 이 테스트는 아래 fixtureSql로 필요한 표를 직접 세우므로 빈 DB를 받는다.
  const handle = await createTestDb();
  const DB = handle.DB;
  const fixtureSql = `
    CREATE TABLE teachers (id TEXT PRIMARY KEY, email TEXT NOT NULL, display_name TEXT NOT NULL);
    CREATE TABLE classrooms (id TEXT PRIMARY KEY, teacher_id TEXT NOT NULL, display_name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE student_profiles (id TEXT PRIMARY KEY, classroom_id TEXT NOT NULL, nickname TEXT NOT NULL, animal TEXT NOT NULL, archived_at TEXT);
    CREATE TABLE artworks (id TEXT PRIMARY KEY, student_id TEXT NOT NULL, classroom_id TEXT NOT NULL, status TEXT NOT NULL, final_image_key TEXT, ops_json TEXT NOT NULL, completed_at TEXT);
    CREATE TABLE reflections (artwork_id TEXT PRIMARY KEY, favorite_part TEXT NOT NULL, favorite_reason TEXT NOT NULL, spoken_description TEXT NOT NULL, story_text TEXT NOT NULL);
    CREATE TABLE coaching_events (id TEXT PRIMARY KEY, artwork_id TEXT NOT NULL, student_answer TEXT, created_at TEXT NOT NULL);
    CREATE TABLE coaching_event_details (event_id TEXT PRIMARY KEY, new_elements_json TEXT NOT NULL DEFAULT '[]');
    CREATE TABLE family_share_links (id TEXT PRIMARY KEY, teacher_id TEXT NOT NULL, student_id TEXT NOT NULL, scope TEXT NOT NULL, approval_kind TEXT NOT NULL, guardian_consent_at TEXT NOT NULL, consent_method TEXT NOT NULL, attested_by_teacher_id TEXT NOT NULL, report_start_at TEXT NOT NULL, report_end_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT, view_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE family_share_invites (token_hash TEXT PRIMARY KEY, link_id TEXT NOT NULL, kind TEXT NOT NULL, expires_at TEXT NOT NULL, consumed_at TEXT, consumed_session_hash TEXT UNIQUE, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE family_share_sessions (token_hash TEXT PRIMARY KEY, link_id TEXT NOT NULL, expires_at TEXT NOT NULL, last_used_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE family_share_artworks (link_id TEXT NOT NULL, artwork_id TEXT NOT NULL, position INTEGER NOT NULL, approved_at TEXT NOT NULL, PRIMARY KEY(link_id, artwork_id), UNIQUE(link_id, position));
    CREATE TABLE subscription_entitlements (teacher_id TEXT PRIMARY KEY, plan_code TEXT NOT NULL DEFAULT 'free', status TEXT NOT NULL DEFAULT 'disabled', provider TEXT, external_customer_ref TEXT, external_subscription_ref TEXT, current_period_end TEXT, provider_event_at TEXT, provider_event_id TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE subscription_webhook_events (provider TEXT NOT NULL, event_id TEXT NOT NULL, payload_hash TEXT NOT NULL, occurred_at TEXT NOT NULL, signature_verified INTEGER NOT NULL, stale INTEGER NOT NULL DEFAULT 0, processed_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(provider, event_id));
    INSERT INTO teachers(id, email, display_name) VALUES ('teacher_owner', 'teacher@example.com', 'Owner'), ('teacher_other', 'other@example.com', 'Other');
    INSERT INTO classrooms(id, teacher_id, display_name, active) VALUES ('class_owner', 'teacher_owner', '별빛초등학교 1반', 1), ('class_other', 'teacher_other', 'Other class', 1);
    INSERT INTO student_profiles(id, classroom_id, nickname, animal) VALUES ('student_owner', 'class_owner', '민수', '🐰'), ('student_other', 'class_other', 'Other', '🐻');
    INSERT INTO artworks(id, student_id, classroom_id, status, final_image_key, ops_json, completed_at) VALUES
      ('artwork_one', 'student_owner', 'class_owner', 'complete', 'private/one.png', '{"schemaVersion":1,"rendererVersion":1,"size":1024,"ops":[]}', '2026-07-21T00:00:00.000Z'),
      ('artwork_two', 'student_owner', 'class_owner', 'complete', 'private/two.png', '{"schemaVersion":1,"rendererVersion":1,"size":1024,"ops":[]}', '2026-07-22T00:00:00.000Z'),
      ('artwork_draft', 'student_owner', 'class_owner', 'drawing', NULL, '{"schemaVersion":1,"rendererVersion":1,"size":1024,"ops":[]}', NULL),
      ('artwork_other', 'student_other', 'class_other', 'complete', 'private/other.png', '{"schemaVersion":1,"rendererVersion":1,"size":1024,"ops":[]}', '2026-07-22T00:00:00.000Z');
    INSERT INTO reflections(artwork_id, favorite_part, favorite_reason, spoken_description, story_text) VALUES
      ('artwork_one', '나무', '색이 이어져서', '민수는 별빛초등학교 1반에서 그렸고 teacher@example.com student_secret', ''),
      ('artwork_two', '자전거', '길이 이어져서', '자전거로 수박을 배달했어요. 🚲', '');
    INSERT INTO coaching_events(id, artwork_id, student_answer, created_at) VALUES ('event_one', 'artwork_one', '토끼를 더했어요.', '2026-07-21T06:00:00.000Z');
    INSERT INTO coaching_event_details(event_id, new_elements_json) VALUES ('event_one', '["토끼"]');
  `;
  try { await DB.batch(fixtureSql.split(";").map((statement) => statement.trim()).filter(Boolean).map((statement) => DB.prepare(statement))); } catch (error) { await handle.dispose(); throw error; }
  return { handle, DB };
}

function shareInput(overrides = {}) {
  return {
    teacherId: "teacher_owner",
    classroomId: "class_owner",
    studentId: "student_owner",
    artworkIds: ["artwork_one"],
    guardianConsentConfirmed: true,
    consentMethod: "paper",
    now: new Date("2026-07-22T12:00:00.000Z"),
    tokenFactory: () => TOKEN_A,
    ...overrides,
  };
}

test("family shares fail closed without auditable guardian prior consent and store hash-only invitations", async () => {
  const { handle, DB } = await fixture();
  try {
    assert.equal((await createFamilyShare(DB, shareInput({ guardianConsentConfirmed: false }))).reason, "guardian_consent_required");
    assert.equal((await createFamilyShare(DB, shareInput({ guardianConsentConfirmed: undefined }))).reason, "guardian_consent_required");
    assert.equal((await createFamilyShare(DB, shareInput({ consentMethod: "teacher_confirm" }))).reason, "invalid_consent_method");
    assert.equal((await createFamilyShare(DB, shareInput({ teacherId: "teacher_other" }))).reason, "forbidden");
    assert.equal((await createFamilyShare(DB, shareInput({ artworkIds: ["artwork_other"] }))).reason, "artwork_forbidden");
    assert.equal((await createFamilyShare(DB, shareInput({ artworkIds: ["artwork_draft"] }))).reason, "artwork_forbidden");
    assert.equal((await createFamilyShare(DB, shareInput({ artworkIds: ["artwork_one", "artwork_one"] }))).reason, "invalid_scope");

    const created = await createFamilyShare(DB, shareInput({ artworkIds: ["artwork_one", "artwork_two"] }));
    assert.equal(created.ok, true); assert.equal(created.scope, "bundle"); assert.equal(created.inviteToken, TOKEN_A); assert.equal(created.inviteExpiresAt, "2026-07-22T12:10:00.000Z"); assert.equal(created.expiresAt, "2026-07-29T12:00:00.000Z");
    const stored = await DB.prepare("SELECT approval_kind AS approvalKind, guardian_consent_at AS consentAt, consent_method AS consentMethod, attested_by_teacher_id AS attestedBy, scope FROM family_share_links WHERE id = ?").bind(created.linkId).first();
    assert.deepEqual(stored, { approvalKind: "guardian", consentAt: "2026-07-22T12:00:00.000Z", consentMethod: "paper", attestedBy: "teacher_owner", scope: "bundle" });
    const invite = await DB.prepare("SELECT token_hash AS tokenHash, kind, consumed_at AS consumedAt FROM family_share_invites WHERE link_id = ?").bind(created.linkId).first();
    assert.equal(invite.tokenHash, await sha256(TOKEN_A)); assert.notEqual(invite.tokenHash, TOKEN_A); assert.equal(invite.kind, "initial"); assert.equal(invite.consumedAt, null);
    assert.equal(JSON.stringify(await DB.prepare("SELECT * FROM family_share_links WHERE id = ?").bind(created.linkId).first()).includes(TOKEN_A), false);
    const collision = await createFamilyShare(DB, shareInput({ artworkIds: ["artwork_one"], consentMethod: "phone" }));
    assert.equal(collision.reason, "save_failed"); assert.equal((await DB.prepare("SELECT COUNT(*) AS count FROM family_share_links").first()).count, 1);
  } finally { await handle.dispose(); }
});

// 옛 Turso 운영 DB의 모양을 고치는 SQLite 전용 경로다. Postgres는 처음부터 최종 모양으로 세워 이 경로를 타지 않는다.
test("rejected early MVP3 schemas upgrade idempotently and invalidate unaudited legacy links", { skip: testPostgresUrl ? "SQLite 전용 업그레이드" : false }, async () => {
  // 초기 MVP3 스키마를 그대로 재현해야 하므로 앱 스키마가 없는 빈 DB에서 시작한다.
  const handle = await createTestDb();
  const DB = handle.DB;
  try {
    const sql = `
      CREATE TABLE teachers (id TEXT PRIMARY KEY);
      CREATE TABLE student_profiles (id TEXT PRIMARY KEY);
      CREATE TABLE artworks (id TEXT PRIMARY KEY);
      CREATE TABLE family_share_links (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, teacher_id TEXT NOT NULL, student_id TEXT NOT NULL, scope TEXT NOT NULL, approval_kind TEXT NOT NULL, report_start_at TEXT NOT NULL, report_end_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT, view_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE family_share_artworks (link_id TEXT NOT NULL, artwork_id TEXT NOT NULL, position INTEGER NOT NULL, approved_at TEXT NOT NULL, PRIMARY KEY(link_id, artwork_id), UNIQUE(link_id, position));
      CREATE TABLE subscription_entitlements (teacher_id TEXT PRIMARY KEY, plan_code TEXT NOT NULL DEFAULT 'free', status TEXT NOT NULL DEFAULT 'disabled', provider TEXT, external_customer_ref TEXT, external_subscription_ref TEXT, current_period_end TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE subscription_webhook_events (provider TEXT NOT NULL, event_id TEXT NOT NULL, payload_hash TEXT NOT NULL, signature_verified INTEGER NOT NULL, processed_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(provider, event_id));
      INSERT INTO teachers(id) VALUES ('teacher_owner');
      INSERT INTO student_profiles(id) VALUES ('student_owner');
      INSERT INTO artworks(id) VALUES ('artwork_one');
      INSERT INTO family_share_links(id, token_hash, teacher_id, student_id, scope, approval_kind, report_start_at, report_end_at, expires_at) VALUES ('share_legacy', 'old_hash', 'teacher_owner', 'student_owner', 'artwork', 'teacher', '2026-07-15T00:00:00.000Z', '2026-07-22T00:00:00.000Z', '2026-07-29T00:00:00.000Z');
      INSERT INTO family_share_artworks(link_id, artwork_id, position, approved_at) VALUES ('share_legacy', 'artwork_one', 0, '2026-07-22T00:00:00.000Z');
      INSERT INTO subscription_entitlements(teacher_id, plan_code, status, provider) VALUES ('teacher_owner', 'portfolio', 'active', 'mock');
      INSERT INTO subscription_webhook_events(provider, event_id, payload_hash, signature_verified, processed_at, created_at) VALUES ('mock', 'event_legacy_1', 'hash', 1, '2026-07-22T00:00:00.000Z', '2026-07-22T00:00:00.000Z');
    `;
    await DB.batch(sql.split(";").map((statement) => statement.trim()).filter(Boolean).map((statement) => DB.prepare(statement)));
    await upgradeMvp3Schema(DB); await upgradeMvp3Schema(DB);
    const familyColumns = (await DB.prepare("PRAGMA table_info(family_share_links)").all()).results.map((item) => item.name);
    assert.equal(familyColumns.includes("token_hash"), false); assert.equal(familyColumns.includes("guardian_consent_at"), true);
    const legacy = await DB.prepare("SELECT approval_kind AS approvalKind, guardian_consent_at AS consentAt, consent_method AS consentMethod, revoked_at AS revokedAt FROM family_share_links WHERE id = 'share_legacy'").first();
    assert.equal(legacy.approvalKind, "legacy_invalid"); assert.equal(legacy.consentAt, ""); assert.equal(legacy.consentMethod, "legacy_invalid"); assert.ok(legacy.revokedAt);
    assert.equal((await DB.prepare("SELECT COUNT(*) AS count FROM family_share_artworks WHERE link_id = 'share_legacy'").first()).count, 1);
    assert.equal((await DB.prepare("SELECT provider_event_at AS eventAt, provider_event_id AS eventId FROM subscription_entitlements WHERE teacher_id = 'teacher_owner'").first()).eventAt, null);
    const oldEvent = await DB.prepare("SELECT occurred_at AS occurredAt, stale FROM subscription_webhook_events WHERE event_id = 'event_legacy_1'").first();
    assert.equal(oldEvent.occurredAt, "2026-07-22T00:00:00.000Z"); assert.equal(oldEvent.stale, 1);
  } finally { await handle.dispose(); }
});

test("family invitations exchange once, sessions stay link-bound, and revoke or expiry invalidates access", async () => {
  const { handle, DB } = await fixture();
  try {
    const now = new Date("2026-07-22T12:00:00.000Z");
    const created = await createFamilyShare(DB, shareInput());
    assert.equal(created.ok, true);
    assert.equal((await exchangeFamilyInvite(DB, "bad-token", { now })).ok, false);
    const exchanges = await Promise.all([
      exchangeFamilyInvite(DB, TOKEN_A, { now, sessionTokenFactory: () => TOKEN_B }),
      exchangeFamilyInvite(DB, TOKEN_A, { now, sessionTokenFactory: () => TOKEN_C }),
    ]);
    assert.equal(exchanges.filter((item) => item.ok).length, 1);
    const winningSession = exchanges.find((item) => item.ok).sessionToken;
    assert.equal((await exchangeFamilyInvite(DB, TOKEN_A, { now, sessionTokenFactory: () => TOKEN_D })).reason, "invite_unavailable");
    const share = await resolveFamilySession(DB, winningSession, now);
    assert.equal(share.linkId, created.linkId); assert.deepEqual(share.artworks.map((item) => item.finalImageKey), ["private/one.png"]);
    await DB.prepare("UPDATE family_share_links SET consent_method = 'teacher_confirm' WHERE id = ?").bind(created.linkId).run();
    assert.equal(await resolveFamilySession(DB, winningSession, now), null);
    await DB.prepare("UPDATE family_share_links SET consent_method = 'paper', guardian_consent_at = '' WHERE id = ?").bind(created.linkId).run();
    assert.equal(await resolveFamilySession(DB, winningSession, now), null);
    await DB.prepare("UPDATE family_share_links SET guardian_consent_at = ? WHERE id = ?").bind(now.toISOString(), created.linkId).run();

    const handoff = await createFamilyHandoffInvite(DB, winningSession, { now, tokenFactory: () => TOKEN_D });
    assert.equal(handoff.ok, true); assert.equal(handoff.inviteToken, TOKEN_D); assert.equal(handoff.expiresAt, "2026-07-22T12:10:00.000Z");
    const handoffExchanges = await Promise.all([
      exchangeFamilyInvite(DB, TOKEN_D, { now, sessionTokenFactory: () => TOKEN_E }),
      exchangeFamilyInvite(DB, TOKEN_D, { now, sessionTokenFactory: () => TOKEN_F }),
    ]);
    assert.equal(handoffExchanges.filter((item) => item.ok).length, 1);
    const handoffSession = handoffExchanges.find((item) => item.ok).sessionToken;
    assert.equal((await resolveFamilySession(DB, handoffSession, now)).linkId, created.linkId);

    assert.equal(FAMILY_INITIAL_INVITE_TTL_SECONDS, 600); assert.equal(FAMILY_HANDOFF_TTL_SECONDS, 600);
    const boundary599 = await createFamilyShare(DB, shareInput({ artworkIds: ["artwork_two"], tokenFactory: () => TOKEN_G }));
    assert.equal(boundary599.ok, true);
    assert.equal((await DB.prepare("SELECT expires_at AS expiresAt FROM family_share_invites WHERE link_id = ?").bind(boundary599.linkId).first()).expiresAt, "2026-07-22T12:10:00.000Z");
    const at599 = new Date(now.getTime() + 599_000);
    const boundaryExchanges = await Promise.all([
      exchangeFamilyInvite(DB, TOKEN_G, { now: at599, sessionTokenFactory: () => TOKEN_H }),
      exchangeFamilyInvite(DB, TOKEN_G, { now: at599, sessionTokenFactory: () => TOKEN_I }),
    ]);
    assert.equal(boundaryExchanges.filter((item) => item.ok).length, 1, "an initial invite is valid at 599 seconds and remains one-use under concurrency");
    const boundary600 = await createFamilyShare(DB, shareInput({ artworkIds: ["artwork_two"], tokenFactory: () => TOKEN_J }));
    assert.equal(boundary600.ok, true);
    assert.equal((await exchangeFamilyInvite(DB, TOKEN_J, { now: new Date(now.getTime() + 600_000), sessionTokenFactory: () => TOKEN_K })).ok, false, "an initial invite is expired at exactly 600 seconds");
    const expiringHandoff = await createFamilyHandoffInvite(DB, winningSession, { now, tokenFactory: () => TOKEN_K });
    assert.equal(expiringHandoff.ok, true); assert.equal(expiringHandoff.expiresAt, "2026-07-22T12:10:00.000Z");
    assert.equal((await exchangeFamilyInvite(DB, TOKEN_K, { now: new Date(now.getTime() + 600_000), sessionTokenFactory: () => TOKEN_L })).ok, false, "a handoff invite is also expired at 600 seconds");
    assert.equal(await revokeFamilyShare(DB, { teacherId: "teacher_other", classroomId: "class_owner", linkId: created.linkId }), false);
    assert.equal(await revokeFamilyShare(DB, { teacherId: "teacher_owner", classroomId: "class_owner", linkId: created.linkId }), true);
    assert.equal(await resolveFamilySession(DB, winningSession, now), null);
    assert.equal(await resolveFamilySession(DB, handoffSession, now), null);

    const expired = await createFamilyShare(DB, shareInput({ artworkIds: ["artwork_two"], tokenFactory: () => TOKEN_F }));
    assert.equal(expired.ok, true);
    await DB.prepare("UPDATE family_share_links SET expires_at = ? WHERE id = ?").bind("2026-07-22T11:59:59.000Z", expired.linkId).run();
    assert.equal((await exchangeFamilyInvite(DB, TOKEN_F, { now, sessionTokenFactory: () => TOKEN_E })).ok, false);
  } finally { await handle.dispose(); }
});

test("peeking an invite never consumes it, so a link preview cannot burn the guardian's one-use link", async () => {
  const { handle, DB } = await fixture();
  try {
    const now = new Date("2026-07-22T12:00:00.000Z");
    const created = await createFamilyShare(DB, shareInput());
    assert.equal(created.ok, true);
    for (let visit = 0; visit < 3; visit += 1) {
      const peeked = await peekFamilyInvite(DB, TOKEN_A, { now });
      assert.equal(peeked.ok, true); assert.equal(peeked.linkId, created.linkId);
    }
    const stillPending = await DB.prepare("SELECT consumed_at AS consumedAt, consumed_session_hash AS sessionHash FROM family_share_invites WHERE link_id = ?").bind(created.linkId).first();
    assert.equal(stillPending.consumedAt, null); assert.equal(stillPending.sessionHash, null);
    assert.equal((await DB.prepare("SELECT COUNT(*) AS count FROM family_share_sessions").first()).count, 0);

    const opened = await exchangeFamilyInvite(DB, TOKEN_A, { now, sessionTokenFactory: () => TOKEN_B });
    assert.equal(opened.ok, true);
    assert.equal((await peekFamilyInvite(DB, TOKEN_A, { now })).reason, "invite_unavailable");
    assert.equal((await peekFamilyInvite(DB, "bad-token", { now })).reason, "invalid_invite");
    const afterExpiry = new Date(now.getTime() + 600_000);
    const later = await createFamilyShare(DB, shareInput({ artworkIds: ["artwork_two"], tokenFactory: () => TOKEN_G }));
    assert.equal(later.ok, true);
    assert.equal((await peekFamilyInvite(DB, TOKEN_G, { now: afterExpiry })).reason, "invite_unavailable");
  } finally { await handle.dispose(); }
});

test("weekly growth reports canonicalize evasions before redaction and policy checks", async () => {
  const { handle, DB } = await fixture();
  try {
    const created = await createFamilyShare(DB, shareInput({ artworkIds: ["artwork_one", "artwork_two"] }));
    assert.equal(created.ok, true);
    await DB.batch([
      DB.prepare("UPDATE reflections SET spoken_description = ? WHERE artwork_id = 'artwork_one'").bind("sco\u200Bre 99 student_\u200Bsecret teacher\u200B@example.com"),
      DB.prepare("INSERT INTO coaching_events(id, artwork_id, student_answer, created_at) VALUES ('event_evasion_one', 'artwork_one', ?, '2026-07-21T07:00:00.000Z')").bind("s c.o/r_e 99"),
      DB.prepare("INSERT INTO coaching_events(id, artwork_id, student_answer, created_at) VALUES ('event_evasion_two', 'artwork_one', ?, '2026-07-21T08:00:00.000Z')").bind("rаnк 1"),
      DB.prepare("INSERT INTO coaching_events(id, artwork_id, student_answer, created_at) VALUES ('event_evasion_three', 'artwork_one', ?, '2026-07-21T09:00:00.000Z')").bind("tаlеnt"),
      DB.prepare("INSERT INTO coaching_events(id, artwork_id, student_answer, created_at) VALUES ('event_evasion_four', 'artwork_one', ?, '2026-07-21T10:00:00.000Z')").bind("９９％ 최고"),
    ]);
    const report = await buildWeeklyGrowthReport(DB, { linkId: created.linkId, studentId: "student_owner", reportStartAt: "2026-07-15T12:00:00.000Z", reportEndAt: "2026-07-22T12:00:00.000Z", sensitiveValues: ["민수", "별빛초등학교 1반", "teacher@example.com"] });
    const serialized = JSON.stringify(report);
    assert.match(serialized, /질문 뒤에 새로운 요소/); assert.match(serialized, /자전거로 수박을 배달/); assert.match(serialized, /🚲/); assert.match(serialized, /#artwork-1/);
    assert.doesNotMatch(serialized, /student_secret|teacher@example\.com|sco.?re|rаnк|tаlеnt|９９|최고/iu);
    assert.doesNotMatch(serialized, /민수|별빛초등학교|teacher_owner|class_owner|artwork_one/);
    assert.equal(compactFamilyPolicyText("s\u0000 c . o / r _ e"), "score");
    assert.equal(compactFamilyPolicyText("ｐｅｒｃｅｎｔａｇｅ"), "percentage");
    assert.equal(redactFamilyText("student_\u200Bx7k29 teacher\u200B@example.com 새싹초등학교", []), "[개인정보 제외]");
  } finally { await handle.dispose(); }
});

test("family evidence excludes reconstructable PII split across every child evidence source", async () => {
  const { handle, DB } = await fixture();
  try {
    const sensitiveValues = ["민수", "별빛초등학교 1반", "teacher@example.com"];
    const created = await createFamilyShare(DB, shareInput({ artworkIds: ["artwork_one", "artwork_two"] }));
    assert.equal(created.ok, true);
    const build = () => buildWeeklyGrowthReport(DB, { linkId: created.linkId, studentId: "student_owner", reportStartAt: "2026-07-15T12:00:00.000Z", reportEndAt: "2026-07-22T12:00:00.000Z", sensitiveValues });
    const reflectionCases = [
      ["favorite_part", "민 \u200B 수"],
      ["favorite_reason", "student - _ - \u200B secret"],
      ["spoken_description", "teacher \u200B @ example . com"],
      ["story_text", "별빛 \u200B 초등 - 학교 1 / 반"],
    ];
    for (const [column, value] of reflectionCases) {
      await DB.prepare("UPDATE reflections SET favorite_part = '', favorite_reason = '', spoken_description = '', story_text = '' WHERE artwork_id = 'artwork_one'").run();
      await DB.prepare(`UPDATE reflections SET ${column} = ? WHERE artwork_id = 'artwork_one'`).bind(value).run();
      const report = await build();
      assert.equal(report.childWords.some((item) => containsFamilyPii(item.text, sensitiveValues)), false, `${column} must not emit reconstructable PII`);
      assert.equal(compactFamilyPolicyText(JSON.stringify(report.childWords)).includes(compactFamilyPolicyText(value)), false);
      assert.ok(report.childWords.some((item) => item.text === "자전거로 수박을 배달했어요. 🚲"), "normal Korean and emoji evidence remains visible");
    }
    await DB.prepare("UPDATE reflections SET favorite_part = '', favorite_reason = '', spoken_description = '', story_text = '' WHERE artwork_id = 'artwork_one'").run();
    await DB.prepare("UPDATE coaching_events SET student_answer = ? WHERE id = 'event_one'").bind("class \u200B - _ owner").run();
    const eventReport = await build();
    assert.equal(eventReport.childWords.some((item) => containsFamilyPii(item.text, sensitiveValues)), false, "student_answer must not emit reconstructable PII");
    assert.equal(eventReport.childWords.some((item) => compactFamilyPolicyText(item.text).includes("classowner")), false);

    const shortEmailSources = [
      ["favorite_part", "a @ b . co"],
      ["favorite_reason", "ab \u200B @ c . io"],
      ["spoken_description", "가 @ 나 . 한국"],
      ["story_text", "a\u200B @ b . co"],
    ];
    await DB.prepare("UPDATE coaching_events SET student_answer = '토끼를 더했어요.' WHERE id = 'event_one'").run();
    for (const [column, value] of shortEmailSources) {
      await DB.prepare("UPDATE reflections SET favorite_part = '', favorite_reason = '', spoken_description = '', story_text = '' WHERE artwork_id = 'artwork_one'").run();
      await DB.prepare(`UPDATE reflections SET ${column} = ? WHERE artwork_id = 'artwork_one'`).bind(value).run();
      const serialized = JSON.stringify(await build());
      assert.equal(compactFamilyPolicyText(serialized).includes(compactFamilyPolicyText(value)), false, `${column} must exclude a short joined email`);
    }
    await DB.prepare("UPDATE reflections SET favorite_part = '', favorite_reason = '', spoken_description = '', story_text = '' WHERE artwork_id = 'artwork_one'").run();
    await DB.prepare("UPDATE coaching_events SET student_answer = ? WHERE id = 'event_one'").bind("a \u200B @ b . co").run();
    assert.equal(compactFamilyPolicyText(JSON.stringify(await build())).includes("abco"), false, "student_answer must exclude a short joined email");

    const splitPii = [
      "a@b.co",
      "a @ b . co",
      "a\u200B @ b . co",
      "ab@c.io",
      "가 @ 나 . 한국",
      "é \u200B @ 例 . 公司",
      "student _ secret",
      "student-_-secret",
      "student \u200B _ secret",
      "teacher @ example.com",
      "teacher \u200B @ example . com",
      "민 수",
      "민 \u200B 수",
      "별빛 초등 학교 1 반",
      "별빛\u200B 초등-학교 1/반",
    ];
    for (const value of splitPii) {
      assert.equal(containsFamilyPii(value, sensitiveValues), true, value);
      assert.equal(redactFamilyText(value, sensitiveValues), "[개인정보 제외]");
    }
    assert.equal(emailJoinedFamilyPolicyText("teacher \u200B / @ / example . com"), "teacher@examplecom");
    assert.equal(emailJoinedFamilyPolicyText("a \u200B / @ / b . co"), "a@bco");
    assert.equal(containsFamilyPii("자전거로 수박을 배달했어요. 🚲", sensitiveValues), false);
    assert.equal(redactFamilyText("자전거로 수박을 배달했어요. 🚲", sensitiveValues), "자전거로 수박을 배달했어요. 🚲");
  } finally { await handle.dispose(); }
});

test("family evidence excludes quantified evaluations across all child evidence sources but keeps ordinary counts", async () => {
  const { handle, DB } = await fixture();
  try {
    const sensitiveValues = ["민수", "별빛초등학교 1반", "teacher@example.com"];
    const created = await createFamilyShare(DB, shareInput({ artworkIds: ["artwork_one", "artwork_two"] }));
    assert.equal(created.ok, true);
    const build = () => buildWeeklyGrowthReport(DB, { linkId: created.linkId, studentId: "student_owner", reportStartAt: "2026-07-15T12:00:00.000Z", reportEndAt: "2026-07-22T12:00:00.000Z", sensitiveValues });
    const evaluationVariants = [
      "창의력 87점", "87 점", "87/100", "1등", "평가 4등급", "A+", "A-", "A", "grade A", "A grade",
      "A\u034F+", "A\uFE0F+", "A\u0301+", "B+", "B\u0301\u034F+", "C\uFE0F-",
      "D\u0301\u0301\u034F\uFE0F+", "E\uFE0F\u20E3+", "grade B\u034F+", "C\u0301- grade", "F\u20E3-",
      "별 5개", "⭐ 5개", "5 stars", "star rating 5", "grade 4", "rating 5", "87 out of 100",
      "90 percentile", "상위 10%", "100점 만점", "총점 87/100",
    ];
    assert.equal(canonicalEvaluationPolicyText("A\u034F\uFE0F\u0301+"), "a+");
    assert.equal(canonicalEvaluationPolicyText("B\u20E3-"), "b-");
    for (const value of evaluationVariants) assert.equal(containsQuantifiedEvaluation(value), true, value);
    const sources = ["favorite_part", "favorite_reason", "spoken_description", "story_text", "student_answer"];
    for (const source of sources) {
      for (const value of evaluationVariants) {
        await DB.batch([
          DB.prepare("UPDATE reflections SET favorite_part = '', favorite_reason = '', spoken_description = '', story_text = '' WHERE artwork_id = 'artwork_one'"),
          DB.prepare("UPDATE coaching_events SET student_answer = '' WHERE id = 'event_one'"),
        ]);
        if (source === "student_answer") await DB.prepare("UPDATE coaching_events SET student_answer = ? WHERE id = 'event_one'").bind(value).run();
        else await DB.prepare(`UPDATE reflections SET ${source} = ? WHERE artwork_id = 'artwork_one'`).bind(value).run();
        const report = await build();
        assert.equal(report.childWords.some((item) => normalizeFamilyPolicyText(item.text) === normalizeFamilyPolicyText(value)), false, `${source} leaked ${value}`);
        assert.equal(report.childWords.some((item) => containsQuantifiedEvaluation(item.text)), false, `${source} retained quantified evaluation context`);
      }
    }
    await DB.prepare("UPDATE reflections SET favorite_part = '', favorite_reason = '', spoken_description = ?, story_text = '' WHERE artwork_id = 'artwork_one'").bind("자전거 2대를 그렸어요. 🚲").run();
    await DB.prepare("UPDATE coaching_events SET student_answer = '' WHERE id = 'event_one'").run();
    const normalReport = await build();
    assert.equal(containsQuantifiedEvaluation("자전거 2대를 그렸어요. 🚲"), false);
    assert.equal(containsQuantifiedEvaluation("무지개와 ⭐을 그렸어요."), false);
    assert.ok(normalReport.childWords.some((item) => item.text === "자전거 2대를 그렸어요. 🚲"));
  } finally { await handle.dispose(); }
});

test("family evidence excludes score, rank, talent, diagnosis and praise judgments from every child evidence source", async () => {
  const { handle, DB } = await fixture();
  try {
    const sensitiveValues = ["민수", "별빛초등학교 1반", "teacher@example.com"];
    const created = await createFamilyShare(DB, shareInput({ artworkIds: ["artwork_one", "artwork_two"] }));
    assert.equal(created.ok, true);
    const build = () => buildWeeklyGrowthReport(DB, { linkId: created.linkId, studentId: "student_owner", reportStartAt: "2026-07-15T12:00:00.000Z", reportEndAt: "2026-07-22T12:00:00.000Z", sensitiveValues });
    const policyExamples = [
      "구십 점이에요", "백점이에요", "열 점 중 아홉 점", "평점은 다섯", "별점 다섯", "five points",
      "일등했어요", "첫 번째예요", "first place", "top of the class", "상위권이에요", "best in class",
      "타고난 화가예요", "미술에 재주가 있어요", "born artist", "natural ability", "artist potential", "exceptional drawing ability",
      "연령보다 발달이 앞서요", "전문가 수준이에요", "초보 수준이에요", "advanced for age", "developmentally advanced", "expert level",
      "참 잘했어요", "멋진 작품이에요", "칭찬할 만한 그림이에요", "excellent drawing", "amazing work", "brilliant picture",
    ];
    const evasiveVariants = [
      "구\u034F십...점이에요", "평점\u200B: 다\u0301섯", "five...points", "첫 / 번째예요", "first / place",
      "상\uFE0F 위\u200B 권이에요", "타고\u0301난 / 화가예요", "natural\u034F / ability", "exceptional\uFE0F drawing...ability",
      "전문가\u0301 - 수준이에요", "advanced / for \u200B age", "developmentally\u034F / advanced",
      "참\u200B, 잘\u0301했어요", "멋진\uFE0F / 작품이에요", "ex.cell.ent draw.ing", "brilli\u0301\u034F\uFE0Fant...picture",
    ];
    const disallowedEvidence = [...policyExamples, ...evasiveVariants];
    for (const value of disallowedEvidence) {
      assert.equal(containsQualitativeEvaluation(value), true, value);
      assert.equal(isAllowedFamilyEvidence(value, sensitiveValues), false, value);
    }

    const sources = ["favorite_part", "favorite_reason", "spoken_description", "story_text", "student_answer"];
    for (const source of sources) {
      for (const value of disallowedEvidence) {
        await DB.batch([
          DB.prepare("UPDATE reflections SET favorite_part = '', favorite_reason = '', spoken_description = '', story_text = '' WHERE artwork_id = 'artwork_one'"),
          DB.prepare("UPDATE coaching_events SET student_answer = '' WHERE id = 'event_one'"),
        ]);
        if (source === "student_answer") await DB.prepare("UPDATE coaching_events SET student_answer = ? WHERE id = 'event_one'").bind(value).run();
        else await DB.prepare(`UPDATE reflections SET ${source} = ? WHERE artwork_id = 'artwork_one'`).bind(value).run();
        const report = await build();
        assert.equal(report.childWords.some((item) => compactFamilyPolicyText(item.text).includes(compactFamilyPolicyText(value))), false, `${source} leaked ${value}`);
      }
    }

    const allowedEvidence = [
      "질문 뒤에 새로운 요소를 추가했어요.",
      "자전거 2대를 그렸어요. 🚲",
      "아이가 그림 속 사건을 자기 말로 설명했어요.",
    ];
    for (const value of allowedEvidence) {
      assert.equal(containsQualitativeEvaluation(value), false, value);
      assert.equal(isAllowedFamilyEvidence(value, sensitiveValues), true, value);
    }
    await DB.prepare("UPDATE reflections SET favorite_part = '', favorite_reason = '', spoken_description = ?, story_text = '' WHERE artwork_id = 'artwork_one'").bind(allowedEvidence[1]).run();
    await DB.prepare("UPDATE coaching_events SET student_answer = ? WHERE id = 'event_one'").bind(allowedEvidence[2]).run();
    const normalReport = await build();
    assert.ok(normalReport.observations.some((item) => item.text.includes("질문 뒤에 새로운 요소")));
    assert.ok(normalReport.childWords.some((item) => item.text === allowedEvidence[1]));
    assert.ok(normalReport.childWords.some((item) => item.text === allowedEvidence[2]));
  } finally { await handle.dispose(); }
});

function providerFor(event) {
  return { id: "mock", createCheckout: async () => ({ url: "https://invalid" }), verifyWebhook: async () => event };
}

function webhookRequest(eventId) {
  return new Request("https://example.test/webhook", { method: "POST", body: `signed:${eventId}`, headers: { "x-signature": "verified-by-provider" } });
}

test("subscription webhooks apply only the newest verified provider event with deterministic ties", async () => {
  const { handle, DB } = await fixture();
  try {
    assert.equal(subscriptionCapability().enabled, false);
    const spoofed = providerFor(null);
    assert.equal((await verifyAndApplySubscriptionWebhook(DB, spoofed, webhookRequest("spoof"))).reason, "invalid_signature");
    const malformed = { id: "event_invalid_time", type: "entitlement.updated", occurredAt: "banana", teacherId: "teacher_owner", planCode: "portfolio", status: "active" };
    assert.equal((await verifyAndApplySubscriptionWebhook(DB, providerFor(malformed), webhookRequest(malformed.id))).reason, "invalid_signature");

    const active = { id: "event_active_200", type: "entitlement.updated", occurredAt: "2026-07-22T12:00:00.000Z", teacherId: "teacher_owner", planCode: "portfolio", status: "active" };
    assert.deepEqual(await verifyAndApplySubscriptionWebhook(DB, providerFor(active), webhookRequest(active.id)), { ok: true, duplicate: false, stale: false });
    assert.deepEqual(await verifyAndApplySubscriptionWebhook(DB, providerFor(active), webhookRequest(active.id)), { ok: true, duplicate: true, stale: false });
    const canceled = { ...active, id: "event_cancel_300", occurredAt: "2026-07-22T13:00:00.000Z", status: "canceled" };
    assert.equal((await verifyAndApplySubscriptionWebhook(DB, providerFor(canceled), webhookRequest(canceled.id))).stale, false);
    const staleActive = { ...active, id: "event_active_100", occurredAt: "2026-07-22T11:00:00.000Z" };
    assert.deepEqual(await verifyAndApplySubscriptionWebhook(DB, providerFor(staleActive), webhookRequest(staleActive.id)), { ok: true, duplicate: false, stale: true });
    let entitlement = await DB.prepare("SELECT status, provider_event_at AS providerEventAt, provider_event_id AS providerEventId FROM subscription_entitlements WHERE teacher_id = 'teacher_owner'").first();
    assert.deepEqual(entitlement, { status: "canceled", providerEventAt: canceled.occurredAt, providerEventId: canceled.id });
    const staleRow = await DB.prepare("SELECT stale, processed_at AS processedAt FROM subscription_webhook_events WHERE event_id = ?").bind(staleActive.id).first();
    assert.equal(staleRow.stale, 1); assert.ok(staleRow.processedAt);

    const tieLow = { ...active, id: "event_equal_aaaa", occurredAt: "2026-07-22T14:00:00.000Z", status: "active" };
    const tieHigh = { ...active, id: "event_equal_zzzz", occurredAt: tieLow.occurredAt, status: "past_due" };
    const tieResults = await Promise.all([
      verifyAndApplySubscriptionWebhook(DB, providerFor(tieHigh), webhookRequest(tieHigh.id)),
      verifyAndApplySubscriptionWebhook(DB, providerFor(tieLow), webhookRequest(tieLow.id)),
    ]);
    assert.equal(tieResults.every((result) => result.ok), true);
    entitlement = await DB.prepare("SELECT status, provider_event_at AS providerEventAt, provider_event_id AS providerEventId FROM subscription_entitlements WHERE teacher_id = 'teacher_owner'").first();
    assert.deepEqual(entitlement, { status: "past_due", providerEventAt: tieHigh.occurredAt, providerEventId: tieHigh.id });

    const missing = { ...active, id: "event_missing_999", teacherId: "teacher_missing" };
    assert.equal((await verifyAndApplySubscriptionWebhook(DB, providerFor(missing), webhookRequest(missing.id))).reason, "invalid_target");
    assert.equal((await DB.prepare("SELECT COUNT(*) AS count FROM subscription_webhook_events WHERE event_id = ?").bind(missing.id).first()).count, 0);
  } finally { await handle.dispose(); }
});

test("routes and UI preserve token-free family history, consent, no-store, and disabled-provider boundaries", async () => {
  const headers = familySecurityHeaders();
  assert.equal(headers.get("cache-control"), "no-store, max-age=0"); assert.equal(headers.get("referrer-policy"), "no-referrer"); assert.equal(headers.get("x-frame-options"), "DENY"); assert.match(headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.equal(familySessionCookieHeader(TOKEN_B, "2026-07-22T13:00:00.000Z", new Date("2026-07-22T12:00:00.000Z")), `wiggle_family=${TOKEN_B}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=3600`);
  const [exchangeRoute, sessionRoute, inviteRoute, familyPage, teacherRoute, teacherUi, edgeHeaders, familyUi, subscriptionRoute, webhookRoute, schema, runtime, migration] = await Promise.all([
    read("../app/family/[token]/route.ts"), read("../app/api/family/session/route.ts"), read("../app/api/family/invite/route.ts"), read("../app/family/view/page.tsx"), read("../app/api/teacher/route.ts"), read("../app/components/TeacherApp.tsx"), read("../next.config.ts"), read("../app/components/FamilyView.tsx"), read("../app/api/subscription/route.ts"), read("../app/api/subscription/webhook/route.ts"), read("../db/schema.ts"), read("../db/runtime.ts"), read("../drizzle/0003_perfect_smasher.sql"),
  ]);
  assert.match(exchangeRoute, /exchangeFamilyInvite/); assert.match(exchangeRoute, /status: 303/); assert.match(exchangeRoute, /familySessionCookieHeader/); assert.match(exchangeRoute, /\/family\/view/);
  // 1회용 초대는 사람이 누른 POST에서만 소비된다. GET은 확인 화면만 그린다.
  assert.match(exchangeRoute, /export async function GET[\s\S]*?peekFamilyInvite/);
  assert.doesNotMatch(exchangeRoute.slice(exchangeRoute.indexOf("export async function GET"), exchangeRoute.indexOf("export async function POST")), /exchangeFamilyInvite|set-cookie/);
  assert.match(exchangeRoute, /export async function POST[\s\S]*?sameOrigin\(request\)/);
  assert.match(sessionRoute, /familyCookieToken/); assert.match(sessionRoute, /resolveFamilySession/); assert.match(sessionRoute, /family-session:/);
  assert.match(inviteRoute, /createFamilyHandoffInvite/); assert.match(inviteRoute, /family-handoff:/); assert.match(familyPage, /<FamilyView \/>/); assert.doesNotMatch(familyPage, /params|token/);
  assert.doesNotMatch(familyUi, /location\.href|encodeURIComponent\(token\)|FamilyView\(\{ token/); assert.match(familyUi, /\/api\/family\/invite/); assert.match(familyUi, /navigator\.share/);
  assert.match(teacherRoute, /guardianConsentConfirmed/); assert.match(teacherRoute, /consentMethod/); assert.match(teacherUi, /실제 보호자의 사전 동의/); assert.match(teacherUi, /school_portal/);
  assert.match(teacherUi, /familySharePanelOpen/); assert.match(teacherUi, /setFamilySharePanelOpen\(true\)/); assert.match(teacherUi, /!familySharePanelOpen/); assert.match(teacherUi, /나중에 하기/);
  // 전역 보안 헤더는 워커 프록시 대신 next.config headers()가 재현한다 (경로별 실측은 배포 검증에서).
  assert.match(edgeHeaders, /referrer-policy/); assert.match(edgeHeaders, /x-frame-options/); assert.match(edgeHeaders, /content-security-policy/);
  // 선생님 음성 귓속말은 2026-09-14 사용자 지시("음성 귓속말 기능 코드는 아예 제거해줘")로 코드째 지웠다. 되살아나지 않게 막는다.
  const { existsSync } = await import("node:fs");
  for (const gone of ["../app/api/voice/route.ts", "../lib/voice-whisper.ts", "../lib/voice-whisper-validation.ts", "../app/components/VoiceWhisper.tsx"]) assert.equal(existsSync(new URL(gone, import.meta.url)), false, gone);
  assert.doesNotMatch(runtime, /WHISPER_RELAY/);
  assert.match(teacherUi, /async function sendPreviewMessage/); assert.match(teacherUi, /studentId: recipientId/); assert.match(teacherUi, /학생에게 메시지/); assert.match(teacherUi, /학생 화면에 보냈어요/);
  assert.match(subscriptionRoute, /SUBSCRIPTIONS_DISABLED/); assert.match(webhookRoute, /verifyAndApplySubscriptionWebhook/);
  assert.match(schema + runtime + migration, /guardian_consent_at/); assert.match(schema + runtime + migration, /family_share_sessions/); assert.match(schema + runtime + migration, /provider_event_at/); assert.match(schema + runtime + migration, /occurred_at/);
});
