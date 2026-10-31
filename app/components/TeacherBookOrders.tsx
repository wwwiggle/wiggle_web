"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Logo } from "./Logo";
import { teacherRequest, postJson, jobLabel, type CompletedBook } from "./book-workflow-client";
import { PrintDimensions, RequestHistory } from "./PrintRequestDetails";
import { PRINT_LAYOUT_VERSION } from "@/lib/book-print-format";
import type { PrintSpec } from "@/lib/book-render";
import type { PrintLayout } from "@/lib/print-validation";
import type { PrintRequest } from "@/lib/print-requests";
import "./book-workflow.css";
type Job = { id: string; storybookId: string; revision: number; specUid: string; status: string; error: string | null; layoutJson: string | null; title: string };
type State = { configured: boolean; environment: string; configError: string; specs: PrintSpec[]; jobs: Job[] };
type Upload = { id: string; title: string; layout_json: string };
type Requests = { orders: PrintRequest[]; uploads: Upload[]; room: { grade: number | null; classNumber: number | null }; profile: { school_name: string } | null };
const emptyShipping = { recipientName: "", recipientPhone: "", postalCode: "", address1: "", address2: "", memo: "" };
export function TeacherBookOrders({ classroomId }: { classroomId: string }) {
  const [books, setBooks] = useState<CompletedBook[]>([]), [state, setState] = useState<State | null>(null), [requests, setRequests] = useState<Requests | null>(null);
  const [selected, setSelected] = useState<string[]>([]), [selectedUploads, setSelectedUploads] = useState<string[]>([]), [quantities, setQuantities] = useState<Record<string, number>>({});
  const specUid = "SQUAREBOOK_HC";
  const [shipping, setShipping] = useState(emptyShipping);
  const [school, setSchool] = useState(""), [grade, setGrade] = useState(""), [classNumber, setClassNumber] = useState(""), [notes, setNotes] = useState("");
  const [title, setTitle] = useState(""), [pageCount, setPageCount] = useState(24), [layout, setLayout] = useState<PrintLayout | null>(null);
  const [cover, setCover] = useState<File | null>(null), [inner, setInner] = useState<File | null>(null), [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const requestId = useRef<string | null>(null), initialized = useRef(false);
  const load = useCallback(async () => {
    const [library, production, r] = await Promise.all([teacherRequest<{ storybooks: CompletedBook[] }>(`/api/teacher/storybooks?classroomId=${classroomId}`), teacherRequest<State>(`/api/teacher/book-print?classroomId=${classroomId}`), teacherRequest<Requests>(`/api/teacher/print-requests?classroomId=${classroomId}`)]);
    setBooks(library.storybooks); setState(production); setRequests(r);
    if (!initialized.current) { initialized.current = true; setSchool(r.profile?.school_name ?? ""); setGrade(String(r.room.grade ?? "")); setClassNumber(String(r.room.classNumber ?? "")); }
  }, [classroomId]);
  useEffect(() => { void load().catch((e) => setError(e.message)); }, [load]);
  const currentJob = (book: CompletedBook) => state?.jobs.find((j) => j.storybookId === book.id && j.revision === book.revision && j.specUid === specUid && (j.status !== "ready" || (j.layoutJson && JSON.parse(j.layoutJson).sourceLayoutVersion === PRINT_LAYOUT_VERSION)));
  const selectedBooks = books.filter((b) => selected.includes(b.id));
  const ready = selected.length + selectedUploads.length > 0 && selected.length + selectedUploads.length <= 50 && selectedBooks.every((b) => currentJob(b)?.status === "ready");
  function changed() { setConfirmed(false); requestId.current = null; }
  async function action(fn: () => Promise<void>) { setBusy(true); setError(""); setNotice(""); try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : "요청을 처리하지 못했어요."); } finally { await load().catch(() => {}); setBusy(false); } }
  async function prepare() {
    await teacherRequest("/api/teacher/book-print", postJson({ action: "prepare", classroomId, storybookIds: selected, specUid }));
    for (;;) { const result = await teacherRequest<{ done: boolean }>("/api/teacher/book-print/process", postJson({ classroomId })); await load(); if (result.done) break; }
  }
  async function upload() {
    if (!cover || !inner) throw new Error("표지와 내지 PDF를 모두 선택해 주세요.");
    const started = await teacherRequest<{ id: string }>("/api/teacher/print-uploads", postJson({ action: "start", classroomId, title, specUid, pageCount, coverBytes: cover.size, innerBytes: inner.size }));
    for (const [kind, file] of [["cover", cover], ["inner", inner]] as const) {
      for (let offset = 0, part = 0; offset < file.size; offset += 3_000_000, part++) {
        setNotice(`${title} · ${kind === "cover" ? "표지" : "내지"} 전송 중 ${Math.round(offset / file.size * 100)}%`);
        await teacherRequest(`/api/teacher/print-uploads?id=${started.id}&kind=${kind}&part=${part}`, { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: file.slice(offset, offset + 3_000_000) });
      }
    }
    await teacherRequest("/api/teacher/print-uploads", postJson({ action: "finish", classroomId, id: started.id }));
    setSelectedUploads((old) => [...old, started.id]); changed(); setNotice("표지·내지 모든 페이지의 규격 검사를 통과했어요. 주문 요청서에 추가했습니다.");
  }
  return <main className="book-desk">
    <header className="book-desk-header"><Logo /><a className="small-button" href={`/teacher/class/${classroomId}/books`}>← 완성 그림책 · 피드백</a><a className="small-button" href="/teacher">내 학급</a></header>
    <section className="book-desk-hero print-hero"><div><p className="eyebrow">우리 반 작은 출판사</p><h1>우리 반 그림책<br />제작을 요청해요.</h1><p>완성한 책 또는 직접 준비한 표지·내지를 보내 주세요.<br />위글 운영자가 원고와 요청서를 확인한 뒤 발주합니다.</p></div><div className="print-book-stack" aria-hidden="true"><div>나의<br />첫 그림책<small>WIGGLE CLASSROOM</small></div></div></section>
    {error && <p className="error-box" role="alert">{error}</p>}{notice && <p className="book-notice" role="status">{notice}</p>}
    {!state?.configured && <p className="book-notice">운영자가 제작 서비스 연결을 준비 중입니다. 연결이 완료되면 최신 판형과 정확한 크기를 확인하고 제작을 요청할 수 있어요.</p>}
    {state?.configError && <p className="error-box">제작 규격을 불러오지 못했어요. 잠시 뒤 다시 확인해 주세요.</p>}
    <fieldset disabled={busy} className="print-form-fieldset"><div className="book-order-layout"><div>
      <section className="book-panel"><p className="eyebrow">01 · 원고 준비</p><h2>제작할 책을 선택해요</h2><p className="book-field">고화질 스퀘어북 (하드커버) · 243 × 248mm · 24~130쪽 (2쪽 단위)</p>
      <p className="book-muted">첫 번째 쪽은 앞표지 PDF, 2쪽부터 마지막 쪽까지는 내지 PDF로 자동 분리합니다. 뒤표지는 무지로 두며, 내지의 제작 규격(최소 24쪽·짝수)에 맞춰 끝에 빈 쪽이 추가될 수 있어요. 준비한 PDF를 꼭 열어 확인해 주세요.</p>
      <label className="book-check"><input type="checkbox" checked={books.length > 0 && selected.length === books.length} onChange={(e) => { setSelected(e.target.checked ? books.map((b) => b.id) : []); changed(); }} />우리 반 전체 선택</label>
      <div className="book-order-list">{books.map((b) => { const job = currentJob(b); return <article key={b.id}><label className="book-check"><input type="checkbox" checked={selected.includes(b.id)} onChange={(e) => { setSelected((s) => e.target.checked ? [...s, b.id] : s.filter((v) => v !== b.id)); changed(); }} /><span><b>{b.title}</b><small>{b.seatNumber}번 {b.realName ?? b.nickname} · 원본 {b.pageCount}쪽</small></span></label><label className="book-quantity">수량<input aria-label={`${b.title} 수량`} type="number" min="1" max="200" value={quantities[b.id] ?? 1} onChange={(e) => { setQuantities((q) => ({ ...q, [b.id]: Number(e.target.value) })); changed(); }} /></label><div className="book-order-item-status"><span className={`book-status status-${job?.status}`}>{jobLabel(job?.status)}</span>{job?.layoutJson && <><PrintDimensions layout={JSON.parse(job.layoutJson)} /><a className="small-button" href={`/api/teacher/book-print/${job.id}?kind=cover`}>표지 PDF</a><a className="small-button" href={`/api/teacher/book-print/${job.id}?kind=inner`}>내지 PDF</a></>}{job?.error && <p className="book-job-error">{job.error}</p>}</div></article>; })}</div>
      {!books.length && <p>완성 그림책이 아직 없어요. 아래에서 직접 준비한 PDF를 넣을 수도 있어요.</p>}
      <button className="button primary" disabled={!state?.configured || !selected.length || selected.length > 50} onClick={() => void action(prepare)}>선택한 책 인쇄 준비 · 재시도</button>
      </section>
      <section className="book-panel"><h2>표지·내지 PDF 직접 첨부</h2><p>책마다 두 파일을 추가해 한 번에 요청할 수 있어요. 파일당 최대 30MB입니다.</p>
      <label className="book-field">책 이름<input value={title} maxLength={100} onChange={(e) => setTitle(e.target.value)} /></label>
      <label className="book-field">내지 인쇄 쪽 수 (표지 제외)<input type="number" min="1" max="500" value={pageCount} onChange={(e) => { setPageCount(Number(e.target.value)); setLayout(null); }} /></label>
      <button className="small-button" disabled={!state?.configured} onClick={() => void action(async () => setLayout(await teacherRequest<PrintLayout>(`/api/teacher/print-requests?classroomId=${classroomId}&specUid=${encodeURIComponent(specUid)}&pageCount=${pageCount}`)))}>필요한 PDF 크기 확인</button>
      {layout && <><PrintDimensions layout={layout} /><label className="book-field">표지 PDF<input type="file" accept="application/pdf,.pdf" onChange={(e) => setCover(e.target.files?.[0] ?? null)} /></label><label className="book-field">내지 PDF<input type="file" accept="application/pdf,.pdf" onChange={(e) => setInner(e.target.files?.[0] ?? null)} /></label><button className="button secondary" disabled={!title || !cover || !inner} onClick={() => void action(upload)}>모든 페이지 검사하고 추가</button></>}
      {requests?.uploads.map((u) => <article className="book-panel" key={u.id}><label className="book-check"><input type="checkbox" checked={selectedUploads.includes(u.id)} onChange={(e) => { setSelectedUploads((old) => e.target.checked ? [...old, u.id] : old.filter((v) => v !== u.id)); changed(); }} />{u.title} · 규격 검사 완료</label><label className="book-quantity">수량<input type="number" min="1" max="200" value={quantities[u.id] ?? 1} onChange={(e) => { setQuantities((q) => ({ ...q, [u.id]: Number(e.target.value) })); changed(); }} /></label><PrintDimensions layout={JSON.parse(u.layout_json)} /></article>)}
      </section>
      <section className="book-panel"><p className="eyebrow">02 · 주문 요청서</p><h2>학교와 배송 정보</h2><div className="book-shipping-grid"><label className="book-field">학교<input value={school} maxLength={100} onChange={(e) => { setSchool(e.target.value); changed(); }} /></label><label className="book-field">학년<input type="number" min="1" max="12" value={grade} onChange={(e) => { setGrade(e.target.value); changed(); }} /></label><label className="book-field">반<input type="number" min="1" max="99" value={classNumber} onChange={(e) => { setClassNumber(e.target.value); changed(); }} /></label>
      {(Object.keys(emptyShipping) as (keyof typeof emptyShipping)[]).map((key) => <label key={key} className={`book-field field-${key}`}>{{ recipientName: "수령인", recipientPhone: "연락처", postalCode: "우편번호", address1: "주소", address2: "상세주소", memo: "배송 메모" }[key]}<input value={shipping[key]} maxLength={key === "recipientPhone" ? 20 : key === "postalCode" ? 5 : key === "recipientName" ? 100 : 200} onChange={(e) => { setShipping((s) => ({ ...s, [key]: e.target.value })); changed(); }} /></label>)}</div><label className="book-field">운영자에게 요청할 내용<textarea value={notes} maxLength={1000} onChange={(e) => { setNotes(e.target.value); changed(); }} /></label></section>
    </div><aside className="book-panel book-order-summary"><p className="eyebrow">03 · 운영자에게 제출</p><h2>주문 요청 모아보기</h2><p>{selected.length + selectedUploads.length}종 · {[...selected, ...selectedUploads].reduce((n, id) => n + (quantities[id] ?? 1), 0)}권</p><p>표지·내지 원고 사본과 요청서가 위글 관리자에게 전달됩니다. 실제 발주는 운영자가 확인한 후 진행해요.</p><label className="book-check"><input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />모든 PDF의 페이지 크기·글·그림·빈 쪽, 수량과 배송지를 확인했습니다.</label><button className="button primary full" disabled={!ready || !confirmed} onClick={() => void action(async () => { requestId.current ??= crypto.randomUUID(); await teacherRequest("/api/teacher/print-requests", postJson({ requestId: requestId.current, classroomId, schoolName: school, grade: Number(grade), classNumber: Number(classNumber), notes, shipping, confirmed, items: [...selectedBooks.map((b) => ({ jobId: currentJob(b)!.id, quantity: quantities[b.id] ?? 1 })), ...selectedUploads.map((id) => ({ uploadId: id, quantity: quantities[id] ?? 1 }))] })); setSelected([]); setSelectedUploads([]); changed(); setNotice("운영자에게 제작 요청서를 보냈어요. 아래에서 접수 상태를 확인하세요."); })}>운영자에게 제작 요청 보내기</button><p className="book-muted">규격이 맞지 않는 PDF는 요청할 수 없어요. 제작사 허용 오차는 ±1mm이며 회전·잘림 없는 원고가 필요합니다.</p></aside></div></fieldset>
    <section className="book-panel"><div className="book-section-heading"><h2>제작 요청 이력</h2><button className="small-button" disabled={busy} onClick={() => void action(load)}>새로 확인</button></div>{requests?.orders.map((r) => <RequestHistory key={r.id} request={r} />)}{!requests?.orders.length && <p>아직 제출한 요청서가 없어요.</p>}</section>
  </main>;
}
