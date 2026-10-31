import { sha256 } from "./token-crypto.ts";

export type EntitlementStatus = "disabled" | "active" | "past_due" | "canceled";
export type VerifiedSubscriptionEvent = {
  id: string;
  type: "entitlement.updated";
  occurredAt: string;
  teacherId: string;
  planCode: string;
  status: EntitlementStatus;
  externalCustomerRef?: string | null;
  externalSubscriptionRef?: string | null;
  currentPeriodEnd?: string | null;
};

export interface SubscriptionProvider {
  readonly id: string;
  createCheckout(input: { teacherId: string; planCode: string; returnUrl: string }): Promise<{ url: string }>;
  verifyWebhook(input: { payload: string; headers: Headers }): Promise<VerifiedSubscriptionEvent | null>;
}

export function subscriptionCapability() {
  const requested = process.env.WIGGLE_SUBSCRIPTIONS_ENABLED === "true";
  return { enabled: false as const, requested, reason: requested ? "provider-not-configured" : "disabled-by-default" };
}

export function configuredSubscriptionProvider(): SubscriptionProvider | null {
  // A provider must be explicitly registered after pricing, legal terms, secrets and webhook rules are chosen.
  return null;
}

function validEvent(event: VerifiedSubscriptionEvent) {
  return /^[A-Za-z0-9_-]{8,160}$/.test(event.id)
    && Number.isFinite(Date.parse(event.occurredAt))
    && /^teacher_[A-Za-z0-9_-]{4,80}$/.test(event.teacherId)
    && /^[a-z0-9_-]{2,40}$/.test(event.planCode)
    && ["disabled", "active", "past_due", "canceled"].includes(event.status);
}

export async function verifyAndApplySubscriptionWebhook(DB: D1Database, provider: SubscriptionProvider, request: Request) {
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > 256_000) return { ok: false as const, reason: "payload_too_large" as const };
  const payload = await request.text();
  if (payload.length > 256_000) return { ok: false as const, reason: "payload_too_large" as const };
  const event = await provider.verifyWebhook({ payload, headers: request.headers });
  if (!event || event.type !== "entitlement.updated" || !validEvent(event)) return { ok: false as const, reason: "invalid_signature" as const };
  const occurredAt = new Date(event.occurredAt).toISOString();
  const payloadHash = await sha256(payload);
  const results = await DB.batch([
    DB.prepare(`INSERT INTO subscription_webhook_events(provider, event_id, payload_hash, occurred_at, signature_verified) VALUES (?, ?, ?, ?, 1) ON CONFLICT DO NOTHING`)
      .bind(provider.id, event.id, payloadHash, occurredAt),
    DB.prepare(`INSERT INTO subscription_entitlements(teacher_id, plan_code, status, provider, external_customer_ref, external_subscription_ref, current_period_end, provider_event_at, provider_event_id, updated_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP
      WHERE EXISTS (SELECT 1 FROM subscription_webhook_events WHERE provider = ? AND event_id = ? AND payload_hash = ? AND signature_verified = 1 AND processed_at IS NULL)
        AND EXISTS (SELECT 1 FROM teachers WHERE id = ?)
      ON CONFLICT(teacher_id) DO UPDATE SET plan_code = excluded.plan_code, status = excluded.status, provider = excluded.provider,
        external_customer_ref = excluded.external_customer_ref, external_subscription_ref = excluded.external_subscription_ref,
        current_period_end = excluded.current_period_end, provider_event_at = excluded.provider_event_at,
        provider_event_id = excluded.provider_event_id, updated_at = CURRENT_TIMESTAMP
      WHERE subscription_entitlements.provider_event_at IS NULL
        OR excluded.provider_event_at > subscription_entitlements.provider_event_at
        OR (excluded.provider_event_at = subscription_entitlements.provider_event_at AND excluded.provider_event_id > COALESCE(subscription_entitlements.provider_event_id, ''))`)
      .bind(event.teacherId, event.planCode, event.status, provider.id, event.externalCustomerRef ?? null, event.externalSubscriptionRef ?? null, event.currentPeriodEnd ?? null, occurredAt, event.id, provider.id, event.id, payloadHash, event.teacherId),
    DB.prepare(`UPDATE subscription_webhook_events SET processed_at = CURRENT_TIMESTAMP,
        stale = CASE WHEN EXISTS (SELECT 1 FROM subscription_entitlements WHERE teacher_id = ? AND provider_event_at = ? AND provider_event_id = ?) THEN 0 ELSE 1 END
      WHERE provider = ? AND event_id = ? AND payload_hash = ? AND signature_verified = 1 AND processed_at IS NULL
        AND EXISTS (SELECT 1 FROM teachers WHERE id = ?)`)
      .bind(event.teacherId, occurredAt, event.id, provider.id, event.id, payloadHash, event.teacherId),
  ]);
  const stored = await DB.prepare(`SELECT processed_at AS processedAt, stale FROM subscription_webhook_events WHERE provider = ? AND event_id = ? AND payload_hash = ? AND signature_verified = 1`).bind(provider.id, event.id, payloadHash).first<{ processedAt: string | null; stale: number }>();
  if (stored?.processedAt) return { ok: true as const, duplicate: !results[0]?.meta.changes, stale: Boolean(stored.stale) };
  await DB.prepare(`DELETE FROM subscription_webhook_events WHERE provider = ? AND event_id = ? AND payload_hash = ? AND processed_at IS NULL`).bind(provider.id, event.id, payloadHash).run();
  return { ok: false as const, reason: "invalid_target" as const };
}
