"use client";
// 운영 관리 · 그림책 주문(2026-10-31): 입금 확인 → 제작 중 → 발송 완료, 그리고 가격·입금 계좌 설정.
import { useCallback, useEffect, useState } from "react";
import { postJson, teacherRequest } from "./book-workflow-client";
import { BOOK_ORDER_NEXT, BOOK_ORDER_STATUS_LABELS, orderDate, won, type BookOrderSettings, type BookOrderStatus } from "@/lib/book-order-pricing";
import type { BookOrderView } from "@/lib/book-orders";

const blankSettings: BookOrderSettings = { basePrice: 0, extraPagePrice: 0, shippingFee: 0, freeShippingQuantity: 0, vatIncluded: true, depositDays: 7, bank: { bankName: "", accountNumber: "", accountHolder: "" }, supplier: { name: "", ceo: "", businessNumber: "", address: "", phone: "", email: "" }, note: "" };
const nextLabel: Record<BookOrderStatus, string> = { awaiting_deposit: "", paid: "입금 확인", producing: "제작 시작", shipped: "발송 완료", canceled: "주문 취소" };
const filters: [string, string][] = [["open", "처리 중"], ["awaiting_deposit", "입금 대기"], ["paid", "입금 확인"], ["producing", "제작 중"], ["shipped", "발송 완료"], ["canceled", "취소"], ["all", "전체"]];

export function AdminBookOrders() {
  const [orders, setOrders] = useState<BookOrderView[] | null>(null), [settings, setSettings] = useState<BookOrderSettings>(blankSettings);
  const [filter, setFilter] = useState("open"), [selected, setSelected] = useState(""), [note, setNote] = useState("");
  const [busy, setBusy] = useState(""), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const load = useCallback(async () => {
    const value = await teacherRequest<{ orders: BookOrderView[]; settings: BookOrderSettings | null }>("/api/admin/book-orders");
    setOrders(value.orders);
    return value;
  }, []);
  useEffect(() => { void load().then((value) => { if (value.settings) setSettings(value.settings); }).catch((cause) => setError(cause instanceof Error ? cause.message : "주문을 불러오지 못했어요.")); }, [load]);

  async function run(key: string, fn: () => Promise<void>, done: string) {
    setBusy(key); setError(""); setNotice("");
    try { await fn(); setNotice(done); await load(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "처리하지 못했어요."); }
    finally { setBusy(""); }
  }

  const shown = (orders ?? []).filter((order) => filter === "all" || (filter === "open" ? !["shipped", "canceled"].includes(order.status) : order.status === filter));
  const order = orders?.find((value) => value.id === selected) ?? null;
  const unpaid = (orders ?? []).filter((value) => value.status === "awaiting_deposit");
  const money = (key: "basePrice" | "extraPagePrice" | "shippingFee" | "freeShippingQuantity" | "depositDays", label: string, suffix: string) => <label className="book-field">{label}<span className="admin-money-input"><input type="number" min="0" inputMode="numeric" value={settings[key]} onChange={(event) => setSettings((old) => ({ ...old, [key]: Number(event.target.value) }))} /><small>{suffix}</small></span></label>;

  return <div className="admin-book-orders">
    {error && <p className="error-box" role="alert">{error}</p>}{notice && <p className="book-notice" role="status">{notice}</p>}
    <div className="admin-metrics"><article><span>입금 대기</span><strong>{unpaid.length}건</strong><small>{won(unpaid.reduce((sum, value) => sum + value.quote.totals.total, 0))}</small></article><article><span>제작·발송 준비</span><strong>{(orders ?? []).filter((value) => value.status === "paid" || value.status === "producing").length}건</strong></article><article><span>발송 완료</span><strong>{(orders ?? []).filter((value) => value.status === "shipped").length}건</strong></article></div>
    <div className="admin-orders">
      <section className="book-panel"><h2>그림책 주문</h2>
        <nav className="book-toolbar" aria-label="주문 상태">{filters.map(([key, label]) => <button key={key} type="button" className={`small-button ${filter === key ? "is-active" : ""}`} aria-pressed={filter === key} onClick={() => setFilter(key)}>{label}</button>)}</nav>
        {orders === null && <p>주문을 불러오는 중…</p>}
        {shown.map((value) => <button type="button" className={`admin-request-card ${selected === value.id ? "selected" : ""}`} key={value.id} onClick={() => { setSelected(value.id); setNote(value.admin_note); }}>
          <b>{value.order_number} · {value.document.classroom.school} {value.document.classroom.grade}학년 {value.document.classroom.classNumber}반</b>
          <span>{value.document.teacher.name} · {value.document.items.length}종 / {value.quote.totals.quantity}권 · {won(value.quote.totals.total)}</span>
          <span className={`book-order-status status-${value.status}`}>{BOOK_ORDER_STATUS_LABELS[value.status]}</span>
          <small>{orderDate(value.created_at, true)} · 입금자명 {value.quote.depositorName}</small>
        </button>)}
        {orders !== null && !shown.length && <p className="book-empty">이 상태의 주문이 없어요.</p>}
      </section>
      <section className="book-panel"><h2>주문 처리</h2>
        {order ? <>
          <p><b>{order.order_number}</b> · <span className={`book-order-status status-${order.status}`}>{BOOK_ORDER_STATUS_LABELS[order.status]}</span></p>
          <p>{order.document.classroom.school} {order.document.classroom.grade}학년 {order.document.classroom.classNumber}반 · {order.document.teacher.name} ({order.document.teacher.email})</p>
          <p>입금할 금액 <b>{won(order.quote.totals.total)}</b> · 입금자명 <b>{order.quote.depositorName}</b> · 기한 {orderDate(order.quote.depositDueAt)}</p>
          <ul className="admin-order-items">{order.document.items.map((item) => <li key={item.storybookId}>{item.title} · {item.printPages}쪽 · {item.quantity}권 · {won(item.amount)}</li>)}</ul>
          <p>배송: {order.document.shipping.recipientName} · {order.document.shipping.recipientPhone}<br />({order.document.shipping.postalCode}) {order.document.shipping.address1} {order.document.shipping.address2}{order.document.shipping.memo && <><br />메모: {order.document.shipping.memo}</>}</p>
          {order.document.notes && <p>요청 사항: {order.document.notes}</p>}
          <p className="book-muted">{order.paid_at && `입금 확인 ${orderDate(order.paid_at, true)} · `}{order.shipped_at && `발송 ${orderDate(order.shipped_at, true)} · `}{order.canceled_at && `취소 ${orderDate(order.canceled_at, true)}`}</p>
          <label className="book-field">운영자 메모 (선생님 화면에도 보여요 · 운송장 번호 등)<input value={note} maxLength={300} onChange={(event) => setNote(event.target.value)} /></label>
          <div className="book-toolbar">
            <a className="small-button" href={`/teacher/book-orders/${encodeURIComponent(order.id)}`}>견적서 열기</a>
            <button type="button" className="small-button" disabled={!!busy} onClick={() => void run("note", () => teacherRequest("/api/admin/book-orders", postJson({ action: "note", id: order.id, note })).then(() => undefined), "메모를 저장했어요.")}>메모만 저장</button>
            {BOOK_ORDER_NEXT[order.status].map((next) => <button key={next} type="button" className={`button ${next === "canceled" ? "secondary" : "primary"}`} disabled={!!busy} onClick={() => {
              if (next === "canceled" && !window.confirm(`${order.order_number} 주문을 취소할까요?`)) return;
              if (next === "paid" && !window.confirm(`${order.quote.depositorName} 이름으로 ${won(order.quote.totals.total)}이 들어온 것을 확인했나요?`)) return;
              void run(next, () => teacherRequest("/api/admin/book-orders", postJson({ action: "status", id: order.id, status: next, note })).then(() => undefined), `${BOOK_ORDER_STATUS_LABELS[next]}(으)로 바꿨어요.`);
            }}>{nextLabel[next]}</button>)}
          </div>
        </> : <p className="book-empty">왼쪽에서 주문을 고르세요.</p>}
      </section>
    </div>
    <section className="book-panel"><h2>가격 · 입금 계좌 · 견적서 공급자</h2><p>단가·은행·계좌번호·예금주·상호를 모두 넣어야 선생님이 주문할 수 있어요. 이미 낸 견적서는 그때의 가격·계좌 그대로 남아요.</p>
      <form className="admin-order-settings" onSubmit={(event) => { event.preventDefault(); void run("settings", async () => { const value = await teacherRequest<{ settings: BookOrderSettings }>("/api/admin/book-orders", postJson({ action: "settings", settings })); setSettings(value.settings); }, "가격과 입금 계좌를 저장했어요."); }}>
        <fieldset><legend>가격</legend>
          {money("basePrice", "1권 기본 가격 (24쪽까지)", "원")}
          {money("extraPagePrice", "24쪽보다 2쪽 늘 때마다 더하는 가격", "원")}
          {money("shippingFee", "배송비 (주문 한 건)", "원")}
          {money("freeShippingQuantity", "이 권수 이상이면 배송비 무료 (0 = 없음)", "권")}
          {money("depositDays", "입금 기한", "일")}
          <label className="book-check"><input type="checkbox" checked={settings.vatIncluded} onChange={(event) => setSettings((old) => ({ ...old, vatIncluded: event.target.checked }))} />위 가격에 부가세가 포함돼 있어요 (끄면 합계에 10%를 더해요)</label>
        </fieldset>
        <fieldset><legend>입금 계좌</legend>
          {(["bankName", "accountNumber", "accountHolder"] as const).map((key) => <label key={key} className="book-field">{{ bankName: "은행", accountNumber: "계좌번호", accountHolder: "예금주" }[key]}<input value={settings.bank[key]} maxLength={60} inputMode={key === "accountNumber" ? "numeric" : undefined} onChange={(event) => setSettings((old) => ({ ...old, bank: { ...old.bank, [key]: event.target.value } }))} /></label>)}
        </fieldset>
        <fieldset><legend>견적서 공급자</legend>
          {(["name", "ceo", "businessNumber", "address", "phone", "email"] as const).map((key) => <label key={key} className="book-field">{{ name: "상호 (필수)", ceo: "대표자", businessNumber: "사업자등록번호", address: "주소", phone: "연락처", email: "이메일" }[key]}<input value={settings.supplier[key]} maxLength={200} onChange={(event) => setSettings((old) => ({ ...old, supplier: { ...old.supplier, [key]: event.target.value } }))} /></label>)}
          <label className="book-field">견적서 안내 문구 (선택)<textarea value={settings.note} maxLength={500} onChange={(event) => setSettings((old) => ({ ...old, note: event.target.value }))} placeholder="예: 입금 확인 후 약 2주 안에 발송해요." /></label>
        </fieldset>
        <button className="button primary" disabled={!!busy}>{busy === "settings" ? "저장 중…" : "가격 · 계좌 저장"}</button>
      </form>
    </section>
  </div>;
}
