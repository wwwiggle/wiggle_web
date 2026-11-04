"use client";
// 카드 결제(2026-11-04 그림책 공방). 견적서 화면에서 토스페이먼츠 결제창을 열고, 결제창은 /teacher/book-orders/[id]/pay로 돌아온다.
// 계좌 입금(견적서)과 함께 둔다 — 학교는 계좌이체·세금계산서가 필요한 경우가 많다.
import { useEffect, useRef, useState } from "react";
import { teacherRequest } from "./book-workflow-client";
import { won } from "@/lib/book-order-pricing";

type Widgets = {
  setAmount(amount: { currency: "KRW"; value: number }): Promise<void>;
  renderPaymentMethods(options: { selector: string; variantKey: string }): Promise<unknown>;
  renderAgreement(options: { selector: string; variantKey: string }): Promise<unknown>;
  requestPayment(options: Record<string, string>): Promise<void>;
};
declare global {
  interface Window { TossPayments?: (clientKey: string) => { widgets(options: { customerKey: string }): Widgets } }
}
type PaymentSetup = { ready: boolean; clientKey?: string; customerKey?: string; amount?: number; orderName?: string; customerEmail?: string; customerName?: string };

const TOSS_SDK = "https://js.tosspayments.com/v2/standard";
function loadTossSdk() {
  if (window.TossPayments) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = TOSS_SDK; script.onload = () => resolve(); script.onerror = () => reject(new Error("결제창을 불러오지 못했어요. 새로고침해 주세요."));
    document.head.appendChild(script);
  });
}

export function BookOrderCardPayment({ orderId }: { orderId: string }) {
  const [setup, setSetup] = useState<PaymentSetup | null>(null), [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const widgets = useRef<Widgets | null>(null);
  useEffect(() => { void teacherRequest<PaymentSetup>(`/api/book-orders/${encodeURIComponent(orderId)}/payment`).then(setSetup).catch(() => setSetup({ ready: false })); }, [orderId]);
  useEffect(() => {
    if (!open || !setup?.ready || !setup.clientKey || !setup.customerKey) return;
    let cancelled = false;
    loadTossSdk().then(async () => {
      if (cancelled || !window.TossPayments) return;
      const w = window.TossPayments(setup.clientKey!).widgets({ customerKey: setup.customerKey! });
      await w.setAmount({ currency: "KRW", value: setup.amount! });
      await Promise.all([w.renderPaymentMethods({ selector: "#book-order-payment-method", variantKey: "DEFAULT" }), w.renderAgreement({ selector: "#book-order-payment-agreement", variantKey: "AGREEMENT" })]);
      if (!cancelled) widgets.current = w;
    }).catch((cause) => setError(cause instanceof Error ? cause.message : "결제창을 불러오지 못했어요."));
    return () => { cancelled = true; widgets.current = null; };
  }, [open, setup]);
  if (!setup?.ready) return null;
  async function pay() {
    if (!widgets.current) { setError("결제창이 아직 준비되지 않았어요."); return; }
    setBusy(true); setError("");
    try {
      const back = `${location.origin}/teacher/book-orders/${encodeURIComponent(orderId)}/pay`;
      await widgets.current.requestPayment({ orderId, orderName: setup!.orderName ?? "그림책", successUrl: back, failUrl: `${back}?failed=1`, customerEmail: setup!.customerEmail ?? "", customerName: setup!.customerName ?? "" });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "결제를 시작하지 못했어요."); setBusy(false); }
  }
  return <section className="book-panel quote-screen-only" aria-labelledby="card-payment-title">
    <h2 id="card-payment-title">카드로 바로 결제</h2>
    <p>계좌 입금 대신 카드(학교 구매카드 포함)로 {won(setup.amount ?? 0)}을 결제할 수 있어요. 결제하면 바로 제작을 시작해요.</p>
    {!open ? <button type="button" className="button primary" onClick={() => setOpen(true)}>카드 결제 열기</button> : <>
      <div id="book-order-payment-method" /><div id="book-order-payment-agreement" />
      <button type="button" className="button primary full" disabled={busy} onClick={() => void pay()}>{busy ? "결제창 여는 중…" : `${won(setup.amount ?? 0)} 결제하기`}</button>
    </>}
    {error && <p className="error-box" role="alert">{error}</p>}
  </section>;
}
