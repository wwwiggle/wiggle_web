import { BOOK_PRINT_SPEC_UID, PRINT_LAYOUT_VERSION, assertBookPrintSpec, assertBookPrintSize } from "@/lib/book-print-format";
import "server-only";
import { randomUUID, createHash } from "node:crypto";
import { bindings } from "@/db/runtime";
import { cleanText, type TeacherIdentity } from "@/lib/security";
import { bookClassroom, workflowBook } from "@/lib/book-workflow";
import { printObjectKey, validateShipping, type PrintJob } from "@/lib/book-print-workflow";
import { printEnvironment, sweetbook, SweetbookError } from "@/lib/sweetbook";
import { printPageCount, type PrintSpec, type PrintSize } from "@/lib/book-render-shared";
import { validatePrintPdf, type PrintLayout, type PageMeasurement } from "@/lib/print-validation";

export type RequestItem = { id: string; title: string; quantity: number; layout: PrintLayout; cover: string; inner: string; coverHash: string; innerHash: string; measurements: { cover: PageMeasurement[]; inner: PageMeasurement[] } };
export type RequestDocument = { teacher: { name: string; email: string }; classroom: { id: string; name: string; school: string; grade: number; classNumber: number }; shipping: ReturnType<typeof validateShipping>; notes: string; items: RequestItem[] };
export type PrintRequest = { id: string; teacher_id: string; classroom_id: string; environment: string; document_json: string; status: string; provider_json: string | null; error: string | null; lease: string | null; lease_at: number | null; order_started_at: number | null; created_at: string };
export type ProviderState = { estimate?: { paidCreditAmount: number; totalAmount: number; creditBalance: number; creditSufficient: boolean }; estimatedAt?: number; result?: { orderUid: string; orderStatusDisplay?: string; trackingNumber?: string }; items?: { bookUid: string; quantity: number }[] };
export function requestListRow(row: PrintRequest) {
  const doc: RequestDocument = JSON.parse(row.document_json);
  return { ...row, document_json: JSON.stringify({ teacher: doc.teacher, classroom: doc.classroom, items: doc.items.map(({ id, title, quantity }) => ({ id, title, quantity })) }) };
}
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export const uploadKey = (id: string, kind: string) => `print-uploads/${id}/${kind}.pdf`;
export async function readPrintFile(key: string) {
  const object = await bindings().ARTWORKS.get(key);
  if (!object) throw new Error("인쇄 파일을 찾을 수 없어요.");
  return new Uint8Array(await object.arrayBuffer());
}
export async function calculatedLayout(specUid: string, pageCount: number): Promise<PrintLayout> {
  if (specUid !== BOOK_PRINT_SPEC_UID) throw new Error("판형을 선택해 주세요.");
  const spec = await sweetbook<PrintSpec>(`/book-specs/${encodeURIComponent(specUid)}`);
  if (!Number.isInteger(pageCount) || printPageCount(pageCount, spec) !== pageCount) throw new Error(`내지는 ${spec.pageMin}~${spec.pageMax}쪽, ${spec.pageIncrement}쪽 단위로 입력해 주세요.`);
  assertBookPrintSpec(spec);
  const size = await sweetbook<PrintSize>(`/book-specs/${encodeURIComponent(specUid)}/calculated-size?pages=${pageCount}`);
  assertBookPrintSize(size, pageCount);
  return { spec, size, pageCount };
}
export async function submitPrintRequest(teacher: TeacherIdentity, body: Record<string, unknown>) {
  const db = bindings().DB, classroomId = cleanText(body.classroomId, 40), requestId = String(body.requestId);
  if (!/^[a-f0-9-]{36}$/.test(requestId)) throw new Error("요청 번호가 올바르지 않아요.");
  const room = await bookClassroom(teacher.id, classroomId);
  if (!room) throw new Error("학급 권한이 없어요.");
  const existing = await db.prepare(`SELECT id, teacher_id FROM print_requests WHERE id = ?`).bind(requestId).first<{ id: string; teacher_id: string }>();
  if (existing) { if (existing.teacher_id !== teacher.id) throw new Error("다른 요청 번호를 사용해 주세요."); return { id: existing.id }; }
  const school = cleanText(body.schoolName, 100), grade = Number(body.grade), classNumber = Number(body.classNumber);
  if (!school || !Number.isInteger(grade) || grade < 1 || grade > 12 || !Number.isInteger(classNumber) || classNumber < 1 || classNumber > 99) throw new Error("학교·학년·반을 입력해 주세요.");
  if (body.confirmed !== true) throw new Error("원고 크기와 내용을 확인해 주세요.");
  const shipping = validateShipping(body.shipping);
  const sources = body.items as { jobId?: string; uploadId?: string; quantity: number }[];
  if (!Array.isArray(sources) || !sources.length || sources.length > 50 || new Set(sources.map((s) => s.jobId ?? s.uploadId)).size !== sources.length) throw new Error("중복 없이 1~50종을 선택해 주세요.");
  const items: RequestItem[] = [];
  // Unique staging keys mean a concurrent retry cannot overwrite an accepted snapshot.
  for (const source of sources) {
    if (!Number.isInteger(source.quantity) || source.quantity < 1 || source.quantity > 200 || !!source.jobId === !!source.uploadId) throw new Error("책별 수량은 1~200권이어야 해요.");
    let title: string, layout: PrintLayout, coverKey: string, innerKey: string;
    if (source.jobId) {
      const job = await db.prepare(`SELECT * FROM book_print_jobs WHERE id = ? AND teacher_id = ? AND classroom_id = ? AND environment = ? AND status = 'ready'`).bind(source.jobId, teacher.id, classroomId, printEnvironment()).first<PrintJob>();
      const book = job && await workflowBook(teacher.id, job.storybook_id);
      if (!job || !book || book.revision !== job.revision || !job.layout_json) throw new Error("최신 완성본의 PDF를 먼저 준비해 주세요.");
      if (JSON.parse(job.layout_json).sourceLayoutVersion !== PRINT_LAYOUT_VERSION) throw new Error("표지·내지 구분이 바뀌었어요. 인쇄 준비를 다시 눌러 주세요.");
      title = book.title; layout = JSON.parse(job.layout_json); coverKey = printObjectKey(job.id, "cover"); innerKey = printObjectKey(job.id, "inner");
    } else {
      const upload = await db.prepare(`SELECT * FROM print_uploads WHERE id = ? AND teacher_id = ? AND classroom_id = ? AND environment = ? AND status = 'ready'`).bind(String(source.uploadId), teacher.id, classroomId, printEnvironment()).first<{ id: string; title: string; layout_json: string }>();
      if (!upload) throw new Error("검사를 통과한 표지·내지 파일을 선택해 주세요.");
      title = upload.title; layout = JSON.parse(upload.layout_json); coverKey = uploadKey(upload.id, "cover"); innerKey = uploadKey(upload.id, "inner");
    }
    const cover = await readPrintFile(coverKey), inner = await readPrintFile(innerKey);
    const measurements = { cover: await validatePrintPdf(cover, "cover", layout), inner: await validatePrintPdf(inner, "inner", layout) };
    const id = randomUUID(), prefix = `print-requests/${requestId}/${id}`;
    await bindings().ARTWORKS.put(`${prefix}/cover.pdf`, cover, { httpMetadata: { contentType: "application/pdf" } });
    await bindings().ARTWORKS.put(`${prefix}/inner.pdf`, inner, { httpMetadata: { contentType: "application/pdf" } });
    items.push({ id, title, quantity: source.quantity, layout, cover: `${prefix}/cover.pdf`, inner: `${prefix}/inner.pdf`, coverHash: hash(cover), innerHash: hash(inner), measurements });
  }
  const document: RequestDocument = { teacher: { name: teacher.displayName, email: teacher.email }, classroom: { id: room.id, name: room.displayName, school, grade, classNumber }, shipping, notes: cleanText(body.notes, 1000), items };
  try {
    await db.batch([
      db.prepare(`INSERT INTO print_requests(id, teacher_id, classroom_id, environment, document_json) VALUES (?, ?, ?, ?, ?)`).bind(requestId, teacher.id, classroomId, printEnvironment(), JSON.stringify(document)),
      ...items.map((item) => db.prepare(`INSERT INTO print_request_items(id, request_id, document_json) VALUES (?, ?, ?)`).bind(item.id, requestId, JSON.stringify(item))),
      db.prepare(`INSERT INTO classroom_profiles(classroom_id, school_name) VALUES (?, ?) ON CONFLICT(classroom_id) DO UPDATE SET school_name = excluded.school_name`).bind(classroomId, school),
      db.prepare(`INSERT INTO classroom_book_settings(classroom_id, grade, class_number) VALUES (?, ?, ?) ON CONFLICT(classroom_id) DO UPDATE SET grade = excluded.grade, class_number = excluded.class_number`).bind(classroomId, grade, classNumber),
    ]);
  } catch (error) {
    const retry = await db.prepare(`SELECT id FROM print_requests WHERE id = ? AND teacher_id = ?`).bind(requestId, teacher.id).first();
    if (!retry) throw error;
  }
  return { id: requestId };
}

async function providerUpload(uid: string, kind: string, bytes: Uint8Array) {
  try { await sweetbook(`/books/${encodeURIComponent(uid)}/${kind}`, { method: "POST", file: bytes }); }
  catch (e) { if (!(e instanceof SweetbookError) || e.status !== 409) throw e; await sweetbook(`/books/${encodeURIComponent(uid)}/${kind}`, { method: "PUT", file: bytes }); }
}
export async function operatePrintRequest(id: string, action: string, confirmed: boolean) {
  const db = bindings().DB, lease = randomUUID(), now = Date.now();
  const request = await db.prepare(`UPDATE print_requests SET lease = ?, lease_at = ? WHERE id = ? AND environment = ? AND (lease IS NULL OR lease_at < ?) RETURNING *`).bind(lease, now, id, printEnvironment(), now - 10 * 60_000).first<PrintRequest>();
  if (!request) throw new Error("다른 관리자가 처리 중이거나 현재 제작 환경의 요청이 아니에요. 잠시 후 다시 확인해 주세요.");
  const doc: RequestDocument = JSON.parse(request.document_json), state: ProviderState = request.provider_json ? JSON.parse(request.provider_json) : {};
  const save = async (status: string) => { await db.prepare(`UPDATE print_requests SET status = ?, provider_json = ?, error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND lease = ?`).bind(status, JSON.stringify(state), id, lease).run(); };
  try {
    if (request.status === "submitted") {
      if (action === "refresh" && state.result?.orderUid) { state.result = await sweetbook(`/orders/${encodeURIComponent(state.result.orderUid)}`); await save("submitted"); }
      return state;
    }
    if (action === "prepare") {
      if (request.order_started_at) throw new Error("발주 결과를 먼저 같은 요청으로 확인해 주세요.");
      const rows = await db.prepare(`SELECT * FROM print_request_items WHERE request_id = ? ORDER BY id`).bind(id).all<{ id: string; document_json: string; book_uid: string | null; remote_started_at: number | null; ready: number }>();
      // One book per call avoids a bulk order exceeding serverless time limits.
      const row = rows.results.find((r) => !r.ready);
      if (row) {
        const item: RequestItem = JSON.parse(row.document_json);
        const current = await calculatedLayout(item.layout.spec.bookSpecUid, item.layout.pageCount);
        const cover = await readPrintFile(item.cover), inner = await readPrintFile(item.inner);
        if (hash(cover) !== item.coverHash || hash(inner) !== item.innerHash) throw new Error("접수 당시 원고와 파일이 달라요. 발주를 중지했어요.");
        await validatePrintPdf(cover, "cover", current); await validatePrintPdf(inner, "inner", current);
        let uid = row.book_uid;
        if (!uid) {
          if (row.remote_started_at && now - row.remote_started_at > 20 * 3600_000) throw new Error("책 생성 결과가 오래 미확인 상태예요. 제작사 포털에서 외부 참조번호를 확인해야 해요.");
          await db.prepare(`UPDATE print_request_items SET remote_started_at = COALESCE(remote_started_at, ?) WHERE id = ?`).bind(now, row.id).run();
          const book = await sweetbook<{ bookUid: string }>("/books", { method: "POST", key: row.id, body: { title: item.title, bookSpecUid: item.layout.spec.bookSpecUid, pageCount: item.layout.pageCount, creationType: "PDF_UPLOAD", externalRef: row.id } });
          if (!book.bookUid) throw new Error("제작사 책 번호를 확인하지 못했어요."); uid = book.bookUid;
          await db.prepare(`UPDATE print_request_items SET book_uid = ? WHERE id = ?`).bind(uid, row.id).run();
        }
        await providerUpload(uid, "pdf-cover", cover); await providerUpload(uid, "pdf-contents", inner);
        await sweetbook(`/books/${encodeURIComponent(uid)}/finalization`, { method: "POST", body: {} });
        await db.prepare(`UPDATE print_request_items SET ready = 1 WHERE id = ?`).bind(row.id).run();
        await save("preparing"); return { ...state, done: false };
      }
      state.items = rows.results.map((r) => ({ bookUid: r.book_uid!, quantity: (JSON.parse(r.document_json) as RequestItem).quantity }));
      if (!state.items.length || state.items.some((i) => !i.bookUid)) throw new Error("제작 원고 준비가 완료되지 않았어요.");
      state.estimate = await sweetbook("/orders/estimate", { method: "POST", body: { items: state.items, shipping: doc.shipping } });
      if (!state.estimate || !Number.isFinite(state.estimate.paidCreditAmount) || state.estimate.paidCreditAmount < 0 || typeof state.estimate.creditSufficient !== "boolean") throw new Error("제작사 견적을 확인하지 못했어요.");
      state.estimatedAt = now; await save("quoted"); return { ...state, done: true };
    }
    if (action !== "order" || !confirmed || !state.items || !state.estimate) throw new Error("원고·수량·배송지·차감 금액 확인이 필요해요.");
    if (!request.order_started_at) {
      if (request.status !== "quoted" || now - (state.estimatedAt ?? 0) > 10 * 60_000) throw new Error("견적을 새로 확인해 주세요 (유효 시간 10분).");
      const fresh = await sweetbook<NonNullable<ProviderState["estimate"]>>("/orders/estimate", { method: "POST", body: { items: state.items, shipping: doc.shipping } });
      if (fresh.paidCreditAmount !== state.estimate.paidCreditAmount || !fresh.creditSufficient) throw new Error("금액 또는 잔액이 달라졌어요. 견적을 다시 확인해 주세요.");
    } else if (now - request.order_started_at > 20 * 3600_000) throw new Error("결과 미확인 발주가 오래되었어요. 새 발주 대신 제작사 포털에서 외부 참조번호로 확인해 주세요.");
    await db.prepare(`UPDATE print_requests SET status = 'submitting', order_started_at = COALESCE(order_started_at, ?) WHERE id = ? AND lease = ?`).bind(now, id, lease).run();
    try {
      state.result = await sweetbook("/orders", { method: "POST", key: id, body: { items: state.items, shipping: doc.shipping, externalRef: id } });
      if (!state.result?.orderUid) throw new Error("제작사 주문 번호가 없어요.");
      await save("submitted"); return state;
    } catch { await save("uncertain"); throw new Error("발주 결과 미확인: 새 주문을 만들지 말고 같은 요청으로 확인해 주세요."); }
  } catch (error) {
    const message = error instanceof Error && /[가-힣]/.test(error.message) ? error.message : "제작사 연결이 중단됐어요. 같은 요청으로 다시 시도해 주세요.";
    await db.prepare(`UPDATE print_requests SET error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND lease = ?`).bind(message, id, lease).run();
    throw new Error(message);
  } finally { await db.prepare(`UPDATE print_requests SET lease = NULL, lease_at = NULL WHERE id = ? AND lease = ?`).bind(id, lease).run(); }
}
