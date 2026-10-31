"use client";
// 그림책 주문(2026-10-31): 완성 그림책 고르기 → 권수·배송지 → 주문하면 바로 견적서와 입금 계좌를 받는다.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Logo } from "./Logo";
import { postJson, teacherRequest } from "./book-workflow-client";
import { BOOK_ORDER_STATUS_LABELS, MAX_COPIES_PER_BOOK, orderDate, quoteTotals, unitPriceFor, won, type BookOrderSettings } from "@/lib/book-order-pricing";
import type { BookOrderView } from "@/lib/book-orders";
import "./book-workflow.css";
import "./book-order.css";

type OrderBook = { id: string; title: string; seatNumber: number | null; realName: string | null; nickname: string; innerPages: number; printPages: number | null };
type DeskData = { ready: boolean; settings: BookOrderSettings | null; books: OrderBook[]; orders: BookOrderView[]; room: { name: string; school: string; grade: number | null; classNumber: number | null } };
const emptyShipping = { recipientName: "", recipientPhone: "", postalCode: "", address1: "", address2: "", memo: "" };
const shippingLabels: Record<keyof typeof emptyShipping, string> = { recipientName: "받는 분", recipientPhone: "연락처", postalCode: "우편번호 (5자리)", address1: "주소", address2: "상세 주소", memo: "배송 메모" };

export function TeacherBookOrderDesk({ classroomId }: { classroomId: string }) {
  const router = useRouter();
  const [data, setData] = useState<DeskData | null>(null);
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [school, setSchool] = useState(""), [grade, setGrade] = useState(""), [classNumber, setClassNumber] = useState("");
  const [shipping, setShipping] = useState(emptyShipping), [notes, setNotes] = useState(""), [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const requestId = useRef<string | null>(null), initialized = useRef(false);

  const load = useCallback(async () => {
    const value = await teacherRequest<DeskData>(`/api/teacher/book-orders?classroomId=${encodeURIComponent(classroomId)}`);
    setData(value);
    if (!initialized.current) {
      initialized.current = true;
      setSchool(value.room.school); setGrade(value.room.grade ? String(value.room.grade) : ""); setClassNumber(value.room.classNumber ? String(value.room.classNumber) : "");
    }
  }, [classroomId]);
  useEffect(() => { void load().catch((cause) => setError(cause instanceof Error ? cause.message : "주문 화면을 불러오지 못했어요.")); }, [load]);

  // 무엇이든 바꾸면 확인 체크와 주문 번호를 새로 받는다(같은 번호로 다른 내용이 저장되지 않게).
  function changed() { setConfirmed(false); requestId.current = null; }
  const chosen = useMemo(() => (data?.books ?? []).filter((book) => (quantities[book.id] ?? 0) > 0 && book.printPages !== null), [data, quantities]);
  const totals = data?.settings ? quoteTotals(chosen.map((book) => ({ printPages: book.printPages!, quantity: quantities[book.id] })), data.settings) : null;
  const allChosen = !!data?.books.length && data.books.every((book) => book.printPages === null || (quantities[book.id] ?? 0) > 0);

  function setQuantity(id: string, value: number) {
    setQuantities((old) => ({ ...old, [id]: Math.max(0, Math.min(MAX_COPIES_PER_BOOK, Math.floor(Number.isFinite(value) ? value : 0))) }));
    changed();
  }
  function chooseAll(on: boolean) {
    setQuantities(Object.fromEntries((data?.books ?? []).filter((book) => book.printPages !== null).map((book) => [book.id, on ? Math.max(1, quantities[book.id] ?? 0) : 0])));
    changed();
  }

  async function submit() {
    setBusy(true); setError("");
    try {
      requestId.current ??= crypto.randomUUID();
      const result = await teacherRequest<{ id: string }>("/api/teacher/book-orders", postJson({
        requestId: requestId.current, classroomId, schoolName: school, grade: Number(grade), classNumber: Number(classNumber), shipping, notes, confirmed,
        items: chosen.map((book) => ({ storybookId: book.id, quantity: quantities[book.id] })),
      }));
      router.push(`/teacher/book-orders/${encodeURIComponent(result.id)}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "주문을 보내지 못했어요.");
      setBusy(false);
    }
  }

  async function cancel(order: BookOrderView) {
    if (!window.confirm(`주문 ${order.order_number}을 취소할까요? 입금 전 주문만 취소할 수 있어요.`)) return;
    setBusy(true); setError("");
    try { await teacherRequest("/api/teacher/book-orders", postJson({ action: "cancel", id: order.id })); await load(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "주문을 취소하지 못했어요."); }
    finally { setBusy(false); }
  }

  const canSubmit = !!data?.ready && chosen.length > 0 && confirmed && !!school.trim() && !!grade && !!classNumber && !busy;
  return <main className="book-desk book-order-desk">
    <header className="book-desk-header"><Logo /><a className="small-button" href={`/teacher/class/${classroomId}/books`}>← 완성 그림책</a><a className="small-button" href="/teacher">내 학급</a></header>
    <section className="book-desk-hero print-hero"><div><p className="eyebrow">우리 반 그림책 주문</p><h1>완성한 그림책을<br />진짜 책으로 받아요.</h1><p>책과 권수를 고르고 배송지를 적으면 바로 견적서가 나와요.<br />견적서의 계좌로 입금하면 확인 후 제작해 보내 드려요.</p></div><div className="print-book-stack" aria-hidden="true"><div>나의<br />첫 그림책<small>WIGGLE CLASSROOM</small></div></div></section>
    <ol className="book-order-steps" aria-label="주문 순서"><li>책·권수 고르기</li><li>주문하고 견적서 받기</li><li>계좌로 입금</li><li>입금 확인 후 제작·발송</li></ol>
    {error && <p className="error-box" role="alert">{error}</p>}
    {data && !data.ready && <p className="book-notice" role="status">운영자가 가격과 입금 계좌를 준비하고 있어요. 준비가 끝나면 이 화면에서 바로 주문할 수 있어요.</p>}
    {!data && !error && <p className="loading-card">주문 화면을 준비하는 중…</p>}
    {data && <fieldset disabled={busy || !data.ready} className="print-form-fieldset"><div className="book-order-layout"><div>
      <section className="book-panel"><p className="eyebrow">01 · 책 고르기</p><h2>주문할 그림책과 권수</h2>
        <p className="book-muted">{BOOK_FORMAT_TEXT} 앞뒤 표지를 뺀 속지가 24쪽보다 적으면 빈 쪽을 더해 24쪽으로 만들어요.</p>
        {!!data.books.length && <label className="book-check"><input type="checkbox" checked={allChosen} onChange={(event) => chooseAll(event.target.checked)} />우리 반 완성 그림책 모두 1권씩</label>}
        <div className="book-order-list">{data.books.map((book) => {
          const quantity = quantities[book.id] ?? 0;
          return <article key={book.id} className={quantity > 0 ? "chosen" : ""}>
            <label className="book-check"><input type="checkbox" disabled={book.printPages === null} checked={quantity > 0} onChange={(event) => setQuantity(book.id, event.target.checked ? 1 : 0)} /><span><b>{book.title}</b><small>{book.seatNumber ? `${book.seatNumber}번 ` : ""}{book.realName ?? book.nickname} · {book.printPages === null ? "쪽 수가 너무 많아 인쇄할 수 없어요" : `인쇄 ${book.printPages}쪽`}</small></span></label>
            <label className="book-quantity">권수<input aria-label={`${book.title} 권수`} type="number" min="0" max={MAX_COPIES_PER_BOOK} value={quantity} disabled={book.printPages === null} onChange={(event) => setQuantity(book.id, Number(event.target.value))} /></label>
            {data.settings && book.printPages !== null && <span className="book-order-price">1권 {won(unitPriceFor(book.printPages, data.settings))}</span>}
          </article>;
        })}</div>
        {!data.books.length && <p className="book-empty">아직 완성된 그림책이 없어요. 학생이 그림책을 완성하면 여기에 나타나요.</p>}
      </section>
      <section className="book-panel"><p className="eyebrow">02 · 받는 곳</p><h2>학교와 배송 정보</h2>
        <div className="book-shipping-grid">
          <label className="book-field">학교<input value={school} maxLength={40} onChange={(event) => { setSchool(event.target.value); changed(); }} /></label>
          <label className="book-field">학년<select value={grade} onChange={(event) => { setGrade(event.target.value); changed(); }}><option value="">선택</option>{[1, 2, 3, 4, 5, 6].map((value) => <option key={value} value={value}>{value}학년</option>)}</select></label>
          <label className="book-field">반<input type="number" min="1" max="99" value={classNumber} onChange={(event) => { setClassNumber(event.target.value); changed(); }} /></label>
          {(Object.keys(emptyShipping) as (keyof typeof emptyShipping)[]).map((key) => <label key={key} className={`book-field field-${key}`}>{shippingLabels[key]}<input value={shipping[key]} inputMode={key === "recipientPhone" || key === "postalCode" ? "numeric" : undefined} maxLength={key === "recipientPhone" ? 20 : key === "postalCode" ? 5 : key === "recipientName" ? 100 : 200} onChange={(event) => { setShipping((old) => ({ ...old, [key]: event.target.value })); changed(); }} /></label>)}
        </div>
        <label className="book-field">운영자에게 남길 말 (선택)<textarea value={notes} maxLength={1000} onChange={(event) => { setNotes(event.target.value); changed(); }} placeholder="예: 학기 말 행사 전까지 받고 싶어요" /></label>
      </section>
    </div>
    <aside className="book-panel book-order-summary"><p className="eyebrow">03 · 견적 미리 보기</p><h2>주문 금액</h2>
      {totals && data.settings ? <dl className="book-order-totals">
        <div><dt>그림책</dt><dd>{chosen.length}종 · {totals.quantity}권</dd></div>
        <div><dt>책값</dt><dd>{won(totals.subtotal)}</dd></div>
        <div><dt>배송비</dt><dd>{totals.shipping ? won(totals.shipping) : totals.quantity ? "무료" : "—"}</dd></div>
        {!data.settings.vatIncluded && <div><dt>부가세 (10%)</dt><dd>{won(totals.vat)}</dd></div>}
        <div className="total"><dt>입금할 금액</dt><dd>{won(totals.total)}</dd></div>
      </dl> : <p className="book-muted">가격이 정해지면 여기에서 금액을 미리 볼 수 있어요.</p>}
      {data.settings?.vatIncluded && <p className="book-muted">부가세가 포함된 금액이에요.{data.settings.freeShippingQuantity > 0 && ` ${data.settings.freeShippingQuantity}권 이상이면 배송비가 무료예요.`}</p>}
      <label className="book-check"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />고른 책·권수와 배송지를 확인했어요.</label>
      <button type="button" className="button primary full" disabled={!canSubmit} onClick={() => void submit()}>{busy ? "주문 보내는 중…" : "주문하고 견적서 받기"}</button>
      <p className="book-muted">주문하면 견적서와 입금 계좌가 바로 나와요. 입금 전에는 주문을 취소할 수 있어요.</p>
    </aside></div></fieldset>}
    <section className="book-panel"><div className="book-section-heading"><h2>주문 내역</h2><button type="button" className="small-button" disabled={busy} onClick={() => void load().catch(() => {})}>새로 확인</button></div>
      {data?.orders.map((order) => <article className="book-order-history" key={order.id}>
        <div><b>{order.order_number}</b><span className={`book-order-status status-${order.status}`}>{BOOK_ORDER_STATUS_LABELS[order.status]}</span></div>
        <p>{order.document.items.length}종 · {order.quote.totals.quantity}권 · {won(order.quote.totals.total)} · {orderDate(order.created_at)}</p>
        {order.admin_note && <p className="book-muted">운영자 메모: {order.admin_note}</p>}
        <div className="book-toolbar"><a className="small-button" href={`/teacher/book-orders/${encodeURIComponent(order.id)}`}>견적서 보기</a>{order.status === "awaiting_deposit" && <button type="button" className="small-button" disabled={busy} onClick={() => void cancel(order)}>주문 취소</button>}</div>
      </article>)}
      {data && !data.orders.length && <p className="book-empty">아직 주문한 그림책이 없어요.</p>}
    </section>
    <p className="book-muted book-order-legacy">표지·내지 PDF 원고를 직접 만들어 두셨다면 <a href={`/teacher/class/${classroomId}/books/print-request`}>원고 파일로 제작 요청</a>을 쓸 수 있어요.</p>
  </main>;
}

const BOOK_FORMAT_TEXT = "하드커버 정사각 그림책 (243 × 248mm).";
