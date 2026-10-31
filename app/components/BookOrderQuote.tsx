"use client";
// 견적서(2026-10-31). 주문 직후 이 화면으로 온다. 인쇄하거나 PDF로 저장해 학교 결재에 붙일 수 있다.
import { useEffect, useState } from "react";
import { Logo } from "./Logo";
import { teacherRequest } from "./book-workflow-client";
import { BOOK_ORDER_STATUS_LABELS, orderDate, won } from "@/lib/book-order-pricing";
import type { BookOrderView } from "@/lib/book-orders";
import "./book-workflow.css";
import "./book-order.css";

export function BookOrderQuote({ orderId }: { orderId: string }) {
  const [order, setOrder] = useState<BookOrderView | null>(null), [admin, setAdmin] = useState(false), [owner, setOwner] = useState(true);
  const [error, setError] = useState(""), [copied, setCopied] = useState("");
  useEffect(() => {
    void teacherRequest<{ order: BookOrderView; admin: boolean; owner: boolean }>(`/api/book-orders/${encodeURIComponent(orderId)}`)
      .then((value) => { setOrder(value.order); setAdmin(value.admin); setOwner(value.owner); })
      .catch((cause) => setError(cause instanceof Error ? cause.message : "견적서를 불러오지 못했어요."));
  }, [orderId]);

  async function copy(label: string, value: string) {
    try { await navigator.clipboard.writeText(value); setCopied(label); setTimeout(() => setCopied(""), 2000); }
    catch { setCopied(""); window.prompt("아래 내용을 복사해 주세요.", value); }
  }

  if (error) return <main className="book-desk"><header className="book-desk-header"><Logo /><a className="small-button" href="/teacher">내 학급</a></header><p className="error-box" role="alert">{error}</p></main>;
  if (!order) return <main className="book-desk"><p className="loading-card">견적서를 펼치는 중…</p></main>;
  const { document: doc, quote } = order, canceled = order.status === "canceled";
  // 주문한 선생님은 주문 화면으로, 남의 주문을 연 운영자는 관리 화면으로 돌아간다.
  const fromAdmin = admin && !owner;
  const back = fromAdmin ? "/admin" : `/teacher/class/${encodeURIComponent(order.classroom_id)}/books/orders`;
  return <main className="book-desk book-quote-page">
    <header className="book-desk-header quote-screen-only"><Logo /><a className="small-button" href={back}>← {fromAdmin ? "운영 관리" : "주문 화면"}</a><button type="button" className="button primary" onClick={() => window.print()}>🖨️ 인쇄 · PDF로 저장</button></header>
    <p className={`book-order-banner quote-screen-only status-${order.status}`} role="status">
      {order.status === "awaiting_deposit" ? <>아래 계좌로 <b>{won(quote.totals.total)}</b>을 {orderDate(quote.depositDueAt)}까지 입금해 주세요. 입금이 확인되면 제작을 시작해요.</>
        : canceled ? "취소된 주문이에요. 이 견적서로 입금하지 마세요."
          : <>지금 상태: <b>{BOOK_ORDER_STATUS_LABELS[order.status]}</b>{order.admin_note && ` · ${order.admin_note}`}</>}
    </p>
    <article className={`book-quote-sheet ${canceled ? "canceled" : ""}`} aria-label="견적서">
      <h1>견 적 서</h1>
      <div className="quote-meta"><p>주문번호 <b>{order.order_number}</b></p><p>발행일 {orderDate(quote.issuedAt)}</p><p>입금 기한 {orderDate(quote.depositDueAt)}</p></div>
      <div className="quote-parties">
        <section><h2>받는 분</h2><p><b>{doc.classroom.school} {doc.classroom.grade}학년 {doc.classroom.classNumber}반</b></p><p>{doc.teacher.name} 선생님 귀하</p><p>{doc.teacher.email}</p><p className="quote-lead">아래와 같이 견적합니다.</p></section>
        <section><h2>공급자</h2><dl>
          <div><dt>상호</dt><dd>{quote.supplier.name}</dd></div>
          {quote.supplier.ceo && <div><dt>대표자</dt><dd>{quote.supplier.ceo}</dd></div>}
          {quote.supplier.businessNumber && <div><dt>사업자등록번호</dt><dd>{quote.supplier.businessNumber}</dd></div>}
          {quote.supplier.address && <div><dt>주소</dt><dd>{quote.supplier.address}</dd></div>}
          {quote.supplier.phone && <div><dt>연락처</dt><dd>{quote.supplier.phone}</dd></div>}
          {quote.supplier.email && <div><dt>이메일</dt><dd>{quote.supplier.email}</dd></div>}
        </dl></section>
      </div>
      <p className="quote-sum">합계 금액 <b>{won(quote.totals.total)}</b> <small>({quote.vatIncluded ? "부가세 포함" : "부가세 별도 금액 포함"})</small></p>
      <div className="quote-table-scroll"><table className="quote-table">
        <thead><tr><th>번호</th><th>품목</th><th>규격</th><th>수량</th><th>단가</th><th>금액</th></tr></thead>
        <tbody>{doc.items.map((item, index) => <tr key={item.storybookId}><td>{index + 1}</td><td>{item.title}</td><td>{doc.product} · {item.printPages}쪽</td><td>{item.quantity}권</td><td>{won(item.unitPrice)}</td><td>{won(item.amount)}</td></tr>)}</tbody>
        <tfoot>
          <tr><th colSpan={5}>책값 소계 ({quote.totals.quantity}권)</th><td>{won(quote.totals.subtotal)}</td></tr>
          <tr><th colSpan={5}>배송비</th><td>{quote.totals.shipping ? won(quote.totals.shipping) : "무료"}</td></tr>
          <tr><th colSpan={5}>공급가액</th><td>{won(quote.totals.supply)}</td></tr>
          <tr><th colSpan={5}>부가세</th><td>{won(quote.totals.vat)}</td></tr>
          <tr className="total"><th colSpan={5}>합계</th><td>{won(quote.totals.total)}</td></tr>
        </tfoot>
      </table></div>
      <section className="quote-deposit"><h2>입금 계좌</h2>
        <dl>
          <div><dt>은행</dt><dd>{quote.bank.bankName}</dd></div>
          <div><dt>계좌번호</dt><dd><b>{quote.bank.accountNumber}</b><button type="button" className="small-button quote-screen-only" onClick={() => void copy("account", quote.bank.accountNumber)}>{copied === "account" ? "복사했어요" : "복사"}</button></dd></div>
          <div><dt>예금주</dt><dd>{quote.bank.accountHolder}</dd></div>
          <div><dt>입금할 금액</dt><dd><b>{won(quote.totals.total)}</b><button type="button" className="small-button quote-screen-only" onClick={() => void copy("amount", String(quote.totals.total))}>{copied === "amount" ? "복사했어요" : "복사"}</button></dd></div>
          <div><dt>입금자명</dt><dd><b>{quote.depositorName}</b> <small>(학교 이름 + 주문번호 끝 4자리)</small></dd></div>
          <div><dt>입금 기한</dt><dd>{orderDate(quote.depositDueAt)}</dd></div>
        </dl>
      </section>
      <section className="quote-shipping"><h2>배송지</h2><p>{doc.shipping.recipientName} · {doc.shipping.recipientPhone}</p><p>({doc.shipping.postalCode}) {doc.shipping.address1} {doc.shipping.address2}</p>{doc.shipping.memo && <p>배송 메모: {doc.shipping.memo}</p>}{doc.notes && <p>요청 사항: {doc.notes}</p>}</section>
      {quote.note && <p className="quote-note">{quote.note}</p>}
      <p className="quote-footnote">입금이 확인되면 제작을 시작하며, 진행 상황은 꿈틀 선생님 화면의 「그림책 주문」에서 볼 수 있어요.</p>
    </article>
  </main>;
}
