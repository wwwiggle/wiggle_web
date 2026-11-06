"use client";
// 그림책 주문서(2026-11-06 다시 짬). 왼쪽에서 책·권수·받는 곳을 차례로 적으면 오른쪽 견적이 바로 바뀐다.
// 주문 전에도 견적서를 미리 띄워 인쇄할 수 있다(학교 결재가 주문보다 먼저인 경우가 많다).
// 적던 내용은 이 브라우저에만 남겨 두고(localStorage), 주문이 들어가면 지운다.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Logo } from "./Logo";
import { postJson, teacherRequest } from "./book-workflow-client";
import { BOOK_ORDER_STATUS_LABELS, MAX_COPIES_PER_BOOK, orderDate, quoteTotals, unitPriceFor, won, type BookOrderSettings } from "@/lib/book-order-pricing";
import { BOOK_PRINT_PRODUCTS, BOOK_PRINT_SPEC_UID } from "@/lib/book-print-format";
import type { BookOrderView } from "@/lib/book-orders";
import "./order-desk.css";

type OrderBook = { id: string; title: string; seatNumber: number | null; realName: string | null; nickname: string; innerPages: number; printPages: number | null };
type DeskData = { ready: boolean; settings: BookOrderSettings | null; books: OrderBook[]; orders: BookOrderView[]; room: { name: string; school: string; grade: number | null; classNumber: number | null } };
type Shipping = typeof emptyShipping;
type Draft = { quantities: Record<string, number>; school: string; grade: string; classNumber: string; shipping: Shipping; notes: string };
const emptyShipping = { recipientName: "", recipientPhone: "", postalCode: "", address1: "", address2: "", memo: "" };
const product = BOOK_PRINT_PRODUCTS[BOOK_PRINT_SPEC_UID];
const SPEC = [
  ["크기", `${product.trimWidthMm} × ${product.trimHeightMm}mm 정사각`],
  ["제본", "하드커버 · PUR 무선제본 (잘 펼쳐지고 튼튼해요)"],
  ["쪽 수", `${product.pageMin}~${product.pageMax}쪽, 책마다 자동으로 맞춰요. 모자라면 뒤에 흰 쪽을 넣어요.`],
  ["인쇄", "양면 컬러 · 고화질"],
];
const SAMPLES = ["/samples/whale.jpg", "/samples/house.jpg", "/samples/rocket.jpg"];
const draftKey = (classroomId: string) => `kkumtle-order-draft:${classroomId}`;
const clamp = (value: number) => Math.max(0, Math.min(MAX_COPIES_PER_BOOK, Math.floor(Number.isFinite(value) ? value : 0)));
const author = (book: OrderBook) => `${book.seatNumber ? `${book.seatNumber}번 ` : ""}${book.realName ?? book.nickname}`;

function readDraft(classroomId: string): Draft | null {
  try { const raw = localStorage.getItem(draftKey(classroomId)); return raw ? JSON.parse(raw) as Draft : null; } catch { return null; }
}
function writeDraft(classroomId: string, draft: Draft | null) {
  try { if (draft) localStorage.setItem(draftKey(classroomId), JSON.stringify(draft)); else localStorage.removeItem(draftKey(classroomId)); } catch { /* 저장이 막힌 브라우저면 그냥 넘어간다 */ }
}

export function TeacherBookOrderDesk({ classroomId }: { classroomId: string }) {
  const router = useRouter();
  const [data, setData] = useState<DeskData | null>(null);
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [school, setSchool] = useState(""), [grade, setGrade] = useState(""), [classNumber, setClassNumber] = useState("");
  const [shipping, setShipping] = useState(emptyShipping), [notes, setNotes] = useState(""), [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [restored, setRestored] = useState(false);
  const [preview, setPreview] = useState(false), [resetAsk, setResetAsk] = useState(false), [bulk, setBulk] = useState(1);
  const requestId = useRef<string | null>(null), initialized = useRef(false);

  const load = useCallback(async () => {
    const value = await teacherRequest<DeskData>(`/api/teacher/book-orders?classroomId=${encodeURIComponent(classroomId)}`);
    setData(value);
    if (initialized.current) return;
    initialized.current = true;
    const draft = readDraft(classroomId), ids = new Set(value.books.filter((book) => book.printPages !== null).map((book) => book.id));
    if (draft) {
      setQuantities(Object.fromEntries(Object.entries(draft.quantities ?? {}).filter(([id, count]) => ids.has(id) && count > 0).map(([id, count]) => [id, clamp(count)])));
      setSchool(draft.school ?? ""); setGrade(draft.grade ?? ""); setClassNumber(draft.classNumber ?? "");
      setShipping({ ...emptyShipping, ...draft.shipping }); setNotes(draft.notes ?? ""); setRestored(true);
    } else {
      setSchool(value.room.school); setGrade(value.room.grade ? String(value.room.grade) : ""); setClassNumber(value.room.classNumber ? String(value.room.classNumber) : "");
    }
  }, [classroomId]);
  useEffect(() => { void load().catch((cause) => setError(cause instanceof Error ? cause.message : "주문 화면을 불러오지 못했어요.")); }, [load]);
  useEffect(() => {
    if (initialized.current) writeDraft(classroomId, { quantities, school, grade, classNumber, shipping, notes });
  }, [classroomId, quantities, school, grade, classNumber, shipping, notes]);

  // 무엇이든 바꾸면 확인 체크와 주문 번호를 새로 받는다(같은 번호로 다른 내용이 저장되지 않게).
  function changed() { setConfirmed(false); requestId.current = null; }
  const printable = useMemo(() => (data?.books ?? []).filter((book) => book.printPages !== null), [data]);
  const chosen = useMemo(() => printable.filter((book) => (quantities[book.id] ?? 0) > 0), [printable, quantities]);
  const settings = data?.settings ?? null;
  const totals = settings ? quoteTotals(chosen.map((book) => ({ printPages: book.printPages!, quantity: quantities[book.id] })), settings) : null;
  const lastShipping = data?.orders.find((order) => order.document.shipping.address1)?.document.shipping;
  const freeLeft = settings && totals && settings.freeShippingQuantity > 0 && totals.shipping > 0 ? settings.freeShippingQuantity - totals.quantity : 0;

  function setQuantity(id: string, value: number) { setQuantities((old) => ({ ...old, [id]: clamp(value) })); changed(); }
  function setEvery(value: number) { setQuantities(Object.fromEntries(printable.map((book) => [book.id, clamp(value)]))); changed(); }
  function editShipping(key: keyof Shipping, value: string) { setShipping((old) => ({ ...old, [key]: value })); changed(); }
  function reset() {
    setQuantities({}); setShipping(emptyShipping); setNotes(""); setResetAsk(false); setRestored(false); changed();
    if (data) { setSchool(data.room.school); setGrade(data.room.grade ? String(data.room.grade) : ""); setClassNumber(data.room.classNumber ? String(data.room.classNumber) : ""); }
  }

  async function submit() {
    setBusy(true); setError("");
    try {
      requestId.current ??= crypto.randomUUID();
      const result = await teacherRequest<{ id: string }>("/api/teacher/book-orders", postJson({
        requestId: requestId.current, classroomId, schoolName: school, grade: Number(grade), classNumber: Number(classNumber), shipping, notes, confirmed,
        items: chosen.map((book) => ({ storybookId: book.id, quantity: quantities[book.id] })),
      }));
      writeDraft(classroomId, null); initialized.current = false;
      router.push(`/teacher/book-orders/${encodeURIComponent(result.id)}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "주문을 보내지 못했어요.");
      setBusy(false);
    }
  }

  async function cancel(order: BookOrderView) {
    if (!window.confirm(`주문 ${order.order_number}을 취소할까요? 결제 전 주문만 취소할 수 있어요.`)) return;
    setBusy(true); setError("");
    try { await teacherRequest("/api/teacher/book-orders", postJson({ action: "cancel", id: order.id })); await load(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "주문을 취소하지 못했어요."); }
    finally { setBusy(false); }
  }

  const missing = [!chosen.length && "책", !school.trim() && "학교", !grade && "학년", !classNumber && "반",
    (!shipping.recipientName.trim() || !shipping.recipientPhone.trim()) && "받는 분", (!/^\d{5}$/.test(shipping.postalCode) || !shipping.address1.trim()) && "주소"].filter(Boolean) as string[];
  const canSubmit = !!data?.ready && !missing.length && confirmed && !busy;
  const room = `${school || "학교"} ${grade || "○"}학년 ${classNumber || "○"}반`;

  return <main className="od">
    <header className="od-top"><Logo /><nav aria-label="주문 화면 이동"><a href={`/teacher/class/${classroomId}/books`}>완성 그림책</a><a href="/teacher">내 학급</a></nav></header>
    <div className="od-title">
      <div><p>{data?.room.name ?? "우리 반"}</p><h1>그림책 주문서</h1></div>
      <p className="od-title-note">책과 권수, 받는 곳만 적으면 끝이에요. 견적서는 주문 전에도 뽑을 수 있어요.</p>
    </div>
    {error && <p className="od-error" role="alert">{error}</p>}
    {data && !data.ready && <p className="od-note" role="status">운영자가 가격과 계좌를 정하는 중이에요. 정해지면 이 화면에서 바로 주문할 수 있어요.</p>}
    {!data && !error && <p className="od-loading">주문서를 펴는 중…</p>}
    {restored && <p className="od-note" role="status">지난번에 적다 만 주문서를 이어서 보여 드려요. <button type="button" className="od-link" onClick={() => setResetAsk(true)}>새로 쓰기</button></p>}

    {data && <div className="od-grid"><fieldset className="od-form" disabled={busy || !data.ready}>
      <section className="od-product" aria-label="상품 안내">
        <div className="od-samples">{SAMPLES.map((src) => <img key={src} src={src} alt="" loading="lazy" />)}</div>
        <div><h2>하드커버 정사각 그림책</h2><dl className="od-spec">{SPEC.map(([name, text]) => <div key={name}><dt>{name}</dt><dd>{text}</dd></div>)}</dl></div>
      </section>

      <section className="od-step" aria-labelledby="od-books"><h2 id="od-books"><span>1</span>책과 권수</h2>
        {!!printable.length && <div className="od-bulk">
          <span>모든 책을</span>
          <Stepper label="모든 책 권수" value={bulk} min={1} onChange={setBulk} />
          <span>권씩</span>
          <button type="button" className="od-btn" onClick={() => setEvery(bulk)}>맞추기</button>
          {chosen.length > 0 && <button type="button" className="od-link" onClick={() => setEvery(0)}>모두 빼기</button>}
        </div>}
        {!!data.books.length && <div className="od-table-scroll"><table className="od-books">
          <thead><tr><th scope="col">책</th><th scope="col">쪽</th><th scope="col">1권</th><th scope="col">권수</th><th scope="col">금액</th></tr></thead>
          <tbody>{data.books.map((book) => {
            const quantity = quantities[book.id] ?? 0, unit = settings && book.printPages !== null ? unitPriceFor(book.printPages, settings) : null;
            return <tr key={book.id} className={quantity > 0 ? "on" : book.printPages === null ? "off" : ""}>
              <th scope="row"><label><input type="checkbox" disabled={book.printPages === null} checked={quantity > 0} onChange={(event) => setQuantity(book.id, event.target.checked ? Math.max(1, bulk) : 0)} /><span><b>{book.title}</b><small>{author(book)}</small></span></label></th>
              <td>{book.printPages === null ? <small>쪽이 너무 많아요</small> : book.printPages}</td>
              <td>{unit === null ? "—" : won(unit)}</td>
              <td>{book.printPages === null ? "—" : <Stepper label={`${book.title} 권수`} value={quantity} min={0} onChange={(value) => setQuantity(book.id, value)} />}</td>
              <td>{unit !== null && quantity > 0 ? won(unit * quantity) : ""}</td>
            </tr>;
          })}</tbody>
        </table></div>}
        {!data.books.length && <p className="od-empty">아직 완성한 그림책이 없어요. <a href={`/teacher/class/${classroomId}/books`}>그림책을 먼저 만들어 주세요.</a></p>}
      </section>

      <section className="od-step" aria-labelledby="od-ship"><h2 id="od-ship"><span>2</span>받는 곳</h2>
        {lastShipping && <button type="button" className="od-btn od-reuse" onClick={() => { setShipping({ ...emptyShipping, ...lastShipping }); changed(); }}>지난 주문 배송지 그대로 쓰기</button>}
        <div className="od-fields">
          <label className="w2">학교<input value={school} maxLength={40} onChange={(event) => { setSchool(event.target.value); changed(); }} /></label>
          <label>학년<select value={grade} onChange={(event) => { setGrade(event.target.value); changed(); }}><option value="">고르기</option>{[1, 2, 3, 4, 5, 6].map((value) => <option key={value} value={value}>{value}학년</option>)}</select></label>
          <label>반<input type="number" inputMode="numeric" min="1" max="99" value={classNumber} onChange={(event) => { setClassNumber(event.target.value); changed(); }} /></label>
          <label className="w2">받는 분<input value={shipping.recipientName} maxLength={100} autoComplete="name" onChange={(event) => editShipping("recipientName", event.target.value)} /></label>
          <label className="w2">연락처<input value={shipping.recipientPhone} maxLength={20} inputMode="tel" autoComplete="tel" placeholder="010-0000-0000" onChange={(event) => editShipping("recipientPhone", event.target.value)} /></label>
          <label>우편번호<input value={shipping.postalCode} maxLength={5} inputMode="numeric" autoComplete="postal-code" placeholder="5자리" onChange={(event) => editShipping("postalCode", event.target.value.replace(/\D/g, ""))} /></label>
          <label className="w3">주소<input value={shipping.address1} maxLength={200} autoComplete="address-line1" placeholder="학교 도로명 주소" onChange={(event) => editShipping("address1", event.target.value)} /></label>
          <label className="w2">상세 주소<input value={shipping.address2} maxLength={200} autoComplete="address-line2" placeholder="예: 본관 2층 교무실" onChange={(event) => editShipping("address2", event.target.value)} /></label>
          <label className="w2">배송 메모<input value={shipping.memo} maxLength={200} placeholder="예: 행정실에 맡겨 주세요" onChange={(event) => editShipping("memo", event.target.value)} /></label>
        </div>
      </section>

      <section className="od-step" aria-labelledby="od-memo"><h2 id="od-memo"><span>3</span>남길 말 <small>안 적어도 돼요</small></h2>
        <textarea value={notes} maxLength={1000} rows={3} onChange={(event) => { setNotes(event.target.value); changed(); }} placeholder="예: 12월 15일 학예회 전에 받고 싶어요." />
      </section>

      <section className="od-step" aria-labelledby="od-pay"><h2 id="od-pay"><span>4</span>결제</h2>
        <ul className="od-pay">
          <li><b>온라인 결제</b>카드(학교 구매카드 포함) · 계좌이체 · 간편결제. 주문하면 나오는 견적서 화면에서 바로 해요.</li>
          <li><b>계좌 입금</b>견적서에 적힌 계좌로 {settings?.depositDays ? `${settings.depositDays}일 안에 ` : ""}보내 주세요. 입금이 확인되면 만들기 시작해요.</li>
        </ul>
      </section>
    </fieldset>

    <aside className="od-receipt" aria-label="견적">
      <h2>견적</h2>
      <p className="od-receipt-room">{room}</p>
      {chosen.length > 0 ? <ul className="od-lines">{chosen.map((book) => <li key={book.id}><span>{book.title}<small> × {quantities[book.id]}</small></span><span>{settings ? won(unitPriceFor(book.printPages!, settings) * quantities[book.id]) : ""}</span></li>)}</ul>
        : <p className="od-receipt-empty">왼쪽에서 책을 고르면 여기에 적혀요.</p>}
      {totals && settings && <dl className="od-sum">
        <div><dt>책값 ({totals.quantity}권)</dt><dd>{won(totals.subtotal)}</dd></div>
        <div><dt>배송비</dt><dd>{totals.quantity ? totals.shipping ? won(totals.shipping) : "무료" : "—"}</dd></div>
        <div><dt>{settings.vatIncluded ? "부가세 (포함)" : "부가세 10%"}</dt><dd>{won(totals.vat)}</dd></div>
        <div className="od-total"><dt>합계</dt><dd>{won(totals.total)}</dd></div>
      </dl>}
      {freeLeft > 0 && <p className="od-hint">{freeLeft}권 더 담으면 배송비가 무료예요.</p>}
      {missing.length > 0 && data.ready && <p className="od-hint">아직 안 적은 것: {missing.join(", ")}</p>}
      <label className="od-confirm"><input type="checkbox" disabled={!data.ready || busy} checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />책, 권수, 받는 곳을 다시 봤어요.</label>
      <button type="button" className="od-btn od-primary" disabled={!canSubmit} onClick={() => void submit()}>{busy ? "주문 넣는 중…" : "주문하기"}</button>
      <button type="button" className="od-btn" disabled={!settings || !chosen.length} onClick={() => setPreview(true)}>견적서 미리 보기</button>
      {resetAsk ? <p className="od-reset">적은 것을 다 지울까요? <button type="button" className="od-link" onClick={reset}>지우기</button> <button type="button" className="od-link" onClick={() => setResetAsk(false)}>그만두기</button></p>
        : <button type="button" className="od-link od-reset" onClick={() => setResetAsk(true)}>처음부터 다시</button>}
      {settings && (settings.supplier.phone || settings.supplier.email) && <p className="od-ask">궁금한 점은 {[settings.supplier.phone, settings.supplier.email].filter(Boolean).join(" · ")}</p>}
    </aside></div>}

    {data && totals && chosen.length > 0 && <div className="od-bar"><span>{totals.quantity}권 · <b>{won(totals.total)}</b></span><button type="button" onClick={() => document.querySelector(".od-receipt")?.scrollIntoView({ behavior: "smooth" })}>견적 보고 주문하기</button></div>}

    <section className="od-history" aria-labelledby="od-history"><div className="od-history-head"><h2 id="od-history">주문한 내역</h2><button type="button" className="od-link" disabled={busy} onClick={() => void load().catch(() => {})}>새로 확인</button></div>
      {data && data.orders.length > 0 && <div className="od-table-scroll"><table className="od-orders">
        <thead><tr><th scope="col">주문번호</th><th scope="col">주문일</th><th scope="col">내용</th><th scope="col">금액</th><th scope="col">상태</th><th scope="col"><span className="od-sr">할 일</span></th></tr></thead>
        <tbody>{data.orders.map((order) => <tr key={order.id}>
          <td>{order.order_number}</td><td>{orderDate(order.created_at)}</td>
          <td>{order.document.items[0]?.title}{order.document.items.length > 1 && ` 외 ${order.document.items.length - 1}종`} · {order.quote.totals.quantity}권{order.admin_note && <small>{order.admin_note}</small>}</td>
          <td>{won(order.quote.totals.total)}</td>
          <td><span className={`od-state s-${order.status}`}>{order.status === "awaiting_deposit" ? "결제 대기" : BOOK_ORDER_STATUS_LABELS[order.status]}</span></td>
          <td><a href={`/teacher/book-orders/${encodeURIComponent(order.id)}`}>견적서</a>{order.status === "awaiting_deposit" && <button type="button" className="od-link" disabled={busy} onClick={() => void cancel(order)}>취소</button>}</td>
        </tr>)}</tbody>
      </table></div>}
      {data && !data.orders.length && <p className="od-empty">아직 주문한 책이 없어요.</p>}
      <p className="od-legacy">인쇄용 PDF 원고를 따로 만들어 두셨다면 <a href={`/teacher/class/${classroomId}/books/print-request`}>원고 파일로 제작 요청</a>을 쓰세요.</p>
    </section>

    {preview && settings && totals && <QuotePreview settings={settings} room={room} books={chosen} quantities={quantities} totals={totals} shipping={shipping} notes={notes} onClose={() => setPreview(false)} />}
  </main>;
}

function Stepper({ label, value, min, onChange }: { label: string; value: number; min: number; onChange: (value: number) => void }) {
  return <span className="od-stepper">
    <button type="button" aria-label={`${label} 하나 빼기`} disabled={value <= min} onClick={() => onChange(Math.max(min, value - 1))}>−</button>
    <input aria-label={label} type="number" inputMode="numeric" min={min} max={MAX_COPIES_PER_BOOK} value={value} onChange={(event) => onChange(Math.max(min, clamp(Number(event.target.value))))} />
    <button type="button" aria-label={`${label} 하나 더하기`} disabled={value >= MAX_COPIES_PER_BOOK} onClick={() => onChange(value + 1)}>+</button>
  </span>;
}

// 주문 전 견적서. 주문번호·입금 기한이 없는 것만 빼면 주문 뒤 견적서(BookOrderQuote)와 같은 내용이다.
function QuotePreview({ settings, room, books, quantities, totals, shipping, notes, onClose }: {
  settings: BookOrderSettings; room: string; books: OrderBook[]; quantities: Record<string, number>; totals: ReturnType<typeof quoteTotals>; shipping: Shipping; notes: string; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null), supplier = settings.supplier;
  useEffect(() => {
    const element = dialog.current; if (!element) return;
    // 여기서 close()를 부르면 close 이벤트가 onClose를 불러 창이 바로 닫힌다(개발 모드는 effect를 두 번 돌린다). 닫기는 언마운트에 맡긴다.
    if (!element.open) element.showModal();
    document.body.classList.add("od-printing-preview");
    return () => document.body.classList.remove("od-printing-preview");
  }, []);
  return <dialog ref={dialog} className="od-preview" onClose={onClose} aria-label="견적서 미리 보기">
    <div className="od-preview-tools"><button type="button" className="od-btn od-primary" onClick={() => window.print()}>인쇄 · PDF로 저장</button><button type="button" className="od-btn" onClick={onClose}>닫기</button></div>
    <article className="od-sheet">
      <h1>견 적 서</h1>
      <p className="od-sheet-meta"><span>발행일 {orderDate(new Date().toISOString())}</span><span>주문 전 미리 보기 · 주문하면 주문번호가 붙어요</span></p>
      <div className="od-sheet-parties">
        <section><h2>받는 곳</h2><p><b>{room}</b> 귀하</p><p>아래와 같이 견적합니다.</p></section>
        <section><h2>공급자</h2><dl>
          <div><dt>상호</dt><dd>{supplier.name}</dd></div>
          {supplier.ceo && <div><dt>대표자</dt><dd>{supplier.ceo}</dd></div>}
          {supplier.businessNumber && <div><dt>사업자번호</dt><dd>{supplier.businessNumber}</dd></div>}
          {supplier.address && <div><dt>주소</dt><dd>{supplier.address}</dd></div>}
          {supplier.phone && <div><dt>연락처</dt><dd>{supplier.phone}</dd></div>}
        </dl></section>
      </div>
      <p className="od-sheet-sum">합계 금액 <b>{won(totals.total)}</b> <small>({settings.vatIncluded ? "부가세 포함" : "부가세 별도 금액 포함"})</small></p>
      <div className="od-table-scroll"><table className="od-sheet-table">
        <thead><tr><th>번호</th><th>품목</th><th>규격</th><th>수량</th><th>단가</th><th>금액</th></tr></thead>
        <tbody>{books.map((book, index) => { const unit = unitPriceFor(book.printPages!, settings); return <tr key={book.id}><td>{index + 1}</td><td>{book.title}</td><td>{product.label} · {book.printPages}쪽</td><td>{quantities[book.id]}권</td><td>{won(unit)}</td><td>{won(unit * quantities[book.id])}</td></tr>; })}</tbody>
        <tfoot>
          <tr><th colSpan={5}>책값 소계 ({totals.quantity}권)</th><td>{won(totals.subtotal)}</td></tr>
          <tr><th colSpan={5}>배송비</th><td>{totals.shipping ? won(totals.shipping) : "무료"}</td></tr>
          <tr><th colSpan={5}>공급가액</th><td>{won(totals.supply)}</td></tr>
          <tr><th colSpan={5}>부가세</th><td>{won(totals.vat)}</td></tr>
          <tr className="od-sheet-total"><th colSpan={5}>합계</th><td>{won(totals.total)}</td></tr>
        </tfoot>
      </table></div>
      {shipping.address1 && <p className="od-sheet-ship">배송지: ({shipping.postalCode}) {shipping.address1} {shipping.address2} · {shipping.recipientName} {shipping.recipientPhone}</p>}
      {notes && <p className="od-sheet-ship">요청 사항: {notes}</p>}
      {settings.note && <p className="od-sheet-note">{settings.note}</p>}
    </article>
  </dialog>;
}
