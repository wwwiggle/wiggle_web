import "server-only";

// 토스페이먼츠 결제 승인(2026-11-04 그림책 공방). 꿈틀 그림책(kkumtle-book lib/toss.ts)과 같은 방식이다.
// https://docs.tosspayments.com/reference#결제-승인
// TOSS_API_BASE는 시험에서 가짜 토스 서버를 가리킬 때만 쓴다.

export type TossPayment = { paymentKey: string; orderId: string; status: string; totalAmount: number; method?: string; approvedAt?: string };

export class TossError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export function tossClientKey() {
  return process.env.TOSS_CLIENT_KEY?.trim() ?? "";
}

export function tossReady() {
  return Boolean(tossClientKey() && process.env.TOSS_SECRET_KEY?.trim());
}

async function call<T>(path: string, body: unknown, idempotencyKey: string): Promise<T> {
  const secret = process.env.TOSS_SECRET_KEY?.trim();
  if (!secret) throw new TossError("NOT_CONFIGURED", "카드 결제가 아직 준비되지 않았어요.");
  const base = process.env.TOSS_API_BASE?.trim() || "https://api.tosspayments.com";
  const response = await fetch(`${base}/v1${path}`, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${secret}:`).toString("base64")}`,
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const data = (await response.json().catch(() => ({}))) as T & { code?: string; message?: string };
  if (!response.ok) throw new TossError(data.code ?? `HTTP_${response.status}`, data.message ?? "결제를 확인하지 못했어요.");
  return data;
}

/** 손님 인증이 끝난 결제를 승인한다. 같은 키로 다시 부르면 토스가 같은 결과를 돌려준다. */
export function confirmPayment(paymentKey: string, orderId: string, amount: number) {
  return call<TossPayment>("/payments/confirm", { paymentKey, orderId, amount }, `confirm-${orderId}`);
}

export function cancelPayment(paymentKey: string, cancelReason: string) {
  return call<TossPayment>(`/payments/${encodeURIComponent(paymentKey)}/cancel`, { cancelReason }, `cancel-${paymentKey}`);
}
