"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Logo } from "./Logo";
import { postJson, teacherRequest } from "./book-workflow-client";
import "./book-workflow.css";

export function BookOrderPaymentReturn({ orderId }: { orderId: string }) {
  const router = useRouter(), started = useRef(false);
  const [error, setError] = useState("");
  const back = `/teacher/book-orders/${encodeURIComponent(orderId)}`;
  useEffect(() => {
    if (started.current) return; started.current = true;
    const query = new URLSearchParams(location.search);
    if (query.get("failed")) { setError(query.get("message") || "결제를 마치지 못했어요."); return; }
    teacherRequest(`/api/book-orders/${encodeURIComponent(orderId)}/payment`, postJson({ paymentKey: query.get("paymentKey"), orderId: query.get("orderId"), amount: Number(query.get("amount")) }))
      .then(() => router.replace(`${back}?paid=1`), (cause: unknown) => setError(cause instanceof Error ? cause.message : "결제를 확인하지 못했어요."));
  }, [orderId, router, back]);
  return <main className="book-desk"><header className="book-desk-header"><Logo /></header><section className="book-panel">
    <h1>{error ? "결제를 마치지 못했어요" : "결제를 확인하고 있어요"}</h1>
    {error ? <><p className="error-box" role="alert">{error}</p><a className="button primary" href={back}>견적서로 돌아가기</a></> : <p>잠시만 기다려 주세요. 창을 닫지 마세요.</p>}
  </section></main>;
}
