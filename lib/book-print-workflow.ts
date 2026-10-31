import { BOOK_PRINT_SPEC_UID, PRINT_LAYOUT_VERSION } from "@/lib/book-print-format";
import { validatePrintPdf } from "@/lib/print-validation";
import "server-only";
import { randomUUID } from "node:crypto";
import { bindings } from "@/db/runtime";
import { bookClassroom, workflowBook, loadBookImages } from "@/lib/book-workflow";
import { printPdfs, printPageCount, type PrintSize, type PrintSpec } from "@/lib/book-render";
import { printEnvironment, sweetbook, SweetbookError } from "@/lib/sweetbook";
import { hasBackCover, innerPageIndexes, spineLabel } from "@/lib/storybook-structure";
import type { StorybookDocument } from "@/lib/storybook-model";

/** Pages that go inside the book block: everything except the front cover and a marked back cover. */
export function printableInnerCount(documentJson: string) {
  return innerPageIndexes(JSON.parse(documentJson) as StorybookDocument).length;
}

export const printObjectKey = (jobId: string, kind: "cover" | "inner") => `book-print/${jobId}/${kind}.pdf`;
export type PrintJob = { id: string; storybook_id: string; teacher_id: string; classroom_id: string; revision: number; environment: string; spec_uid: string; status: string; book_uid: string | null; layout_json: string | null; created_at: string };
export async function enqueuePrint(teacherId: string, classroomId: string, ids: string[], specUid: string) {
  if (!await bookClassroom(teacherId, classroomId)) throw new Error("학급 권한이 없어요.");
  if (specUid !== BOOK_PRINT_SPEC_UID) throw new Error("판형을 선택해 주세요.");
  const spec = await sweetbook<PrintSpec>(`/book-specs/${encodeURIComponent(specUid)}`);
  const books = [];
  for (const id of ids) {
    const book = await workflowBook(teacherId, id);
    if (!book || book.classroomId !== classroomId) throw new Error("다른 학급 또는 미완성 그림책이 포함되어 있어요.");
    printPageCount(printableInnerCount(book.documentJson), spec);
    books.push(book);
  }
  const db = bindings().DB;
  await db.batch(books.map((book) => db.prepare(`INSERT INTO book_print_jobs(id, storybook_id, classroom_id, teacher_id, revision, environment, spec_uid) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(storybook_id, teacher_id, revision, environment, spec_uid) DO UPDATE SET status = CASE WHEN (book_print_jobs.status = 'failed' OR (book_print_jobs.status = 'ready' AND json_extract(COALESCE(book_print_jobs.layout_json, '{}'), '$.sourceLayoutVersion') IS NOT ${PRINT_LAYOUT_VERSION})) THEN 'queued' ELSE book_print_jobs.status END, error = NULL`).bind(randomUUID(), book.id, classroomId, teacherId, book.revision, printEnvironment(), specUid)));
}
export async function processPrint(teacherId: string, classroomId: string) {
  if (!await bookClassroom(teacherId, classroomId)) throw new Error("학급 권한이 없어요.");
  const db = bindings().DB, lease = randomUUID();
  const job = await db.prepare(`UPDATE book_print_jobs SET status = 'processing', lease = ?, updated_at = CURRENT_TIMESTAMP WHERE id = (SELECT id FROM book_print_jobs WHERE teacher_id = ? AND classroom_id = ? AND environment = ? AND (status = 'queued' OR (status = 'processing' AND updated_at < datetime('now','-10 minutes'))) ORDER BY created_at, id LIMIT 1) RETURNING *`).bind(lease, teacherId, classroomId, printEnvironment()).first<PrintJob>();
  if (!job) return { done: true };
  try {
    const book = await workflowBook(teacherId, job.storybook_id);
    if (!book || book.revision !== job.revision) throw new Error("완성본이 변경되었어요. 최신 책으로 다시 준비해 주세요.");
    const spec = await sweetbook<PrintSpec>(`/book-specs/${encodeURIComponent(job.spec_uid)}`);
    const originalCount = JSON.parse(book.documentJson).pages.length;
    const count = printPageCount(printableInnerCount(book.documentJson), spec);
    const size = await sweetbook<PrintSize>(`/book-specs/${encodeURIComponent(job.spec_uid)}/calculated-size?pages=${count}`);
    const { document, images } = await loadBookImages(book, 2600);
    const backCover = hasBackCover(document);
    const pdfs = await printPdfs(images, spec, size, book.title, { backCover, spine: spineLabel(book.title, document) });
    await validatePrintPdf(pdfs.cover, "cover", { spec, size, pageCount: pdfs.pageCount });
    await validatePrintPdf(pdfs.inner, "inner", { spec, size, pageCount: pdfs.pageCount });
    await bindings().ARTWORKS.put(printObjectKey(job.id, "cover"), pdfs.cover, { httpMetadata: { contentType: "application/pdf" } });
    await bindings().ARTWORKS.put(printObjectKey(job.id, "inner"), pdfs.inner, { httpMetadata: { contentType: "application/pdf" } });
    const layout = { spec, size, pageCount: pdfs.pageCount, addedPages: pdfs.addedPages, originalPages: originalCount, coverPages: backCover ? 2 : 1, innerSourcePages: originalCount - (backCover ? 2 : 1), sourceLayoutVersion: PRINT_LAYOUT_VERSION };
    await db.prepare(`UPDATE book_print_jobs SET layout_json = ? WHERE id = ? AND lease = ?`).bind(JSON.stringify(layout), job.id, lease).run();
    const latest = await workflowBook(teacherId, book.id);
    if (!latest || latest.revision !== job.revision) throw new Error("준비 중 원본이 바뀌었어요. 최신 책으로 다시 준비해 주세요.");
    await db.prepare(`UPDATE book_print_jobs SET status = 'ready', error = NULL, lease = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND lease = ?`).bind(job.id, lease).run();
    return { done: false, id: job.id, status: "ready" };
  } catch (error) {
    const message = error instanceof SweetbookError || (error instanceof Error && /[가-힣]/.test(error.message)) ? error.message : "제작 준비 응답이 늦거나 연결이 끊겼어요. 같은 요청으로 다시 시도해 주세요.";
    await db.prepare(`UPDATE book_print_jobs SET status = 'failed', error = ?, lease = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND lease = ?`).bind(message, job.id, lease).run();
    return { done: false, id: job.id, status: "failed" };
  }
}

export type Shipping = { recipientName: string; recipientPhone: string; postalCode: string; address1: string; address2: string; memo: string };
export function validateShipping(value: unknown): Shipping {
  const data = value as Shipping;
  if (!data || typeof data !== "object") throw new Error("배송지를 입력해 주세요.");
  const result = {} as Shipping;
  for (const [field, max] of Object.entries({ recipientName: 100, recipientPhone: 20, postalCode: 10, address1: 200, address2: 200, memo: 200 })) {
    const v = data[field as keyof Shipping];
    if (typeof v !== "string" || v.length > max || /[\u0000-\u001f]/.test(v)) throw new Error("배송지 입력 길이와 문자를 확인해 주세요.");
    result[field as keyof Shipping] = v.trim();
  }
  if (!result.recipientName || !/^[0-9+() -]{8,20}$/.test(result.recipientPhone) || !/^\d{5}$/.test(result.postalCode) || result.address1.length < 5) throw new Error("수령인·연락처·5자리 우편번호·주소를 확인해 주세요.");
  return result;
}
