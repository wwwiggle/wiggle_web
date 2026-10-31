import "server-only";
import { bindings } from "@/db/runtime";
import { createHash, randomUUID } from "node:crypto";
import { defaultRubric, feedbackPrompt, rubricVersion, validateFeedback, type Rubric } from "@/lib/book-rubric";
import { validateStorybookDocument } from "@/lib/storybook-model";
import type { BookIdentity } from "@/lib/book-render-shared";
import { bookPageImages, type BookRenderSource } from "@/lib/book-render-service";

export async function bookClassroom(teacherId: string, classroomId: string) {
  return bindings().DB.prepare(`SELECT c.id, c.display_name AS displayName, s.grade, s.class_number AS classNumber, s.rubric_json AS rubricJson, s.rubric_filename AS rubricFilename FROM classrooms c LEFT JOIN classroom_book_settings s ON s.classroom_id = c.id WHERE c.id = ? AND c.teacher_id = ? AND c.active = 1`).bind(classroomId, teacherId).first<{ id: string; displayName: string; grade: number | null; classNumber: number | null; rubricJson: string | null; rubricFilename: string | null }>();
}
export async function activeRubric(teacherId: string, classroomId: string) {
  const room = await bookClassroom(teacherId, classroomId);
  if (!room) throw new Error("이 학급에 접근할 권한이 없어요.");
  const rubric: Rubric = room.rubricJson ? JSON.parse(room.rubricJson) : await defaultRubric();
  const prompt = await feedbackPrompt(rubric);
  // Prompt edits also invalidate cached feedback.
  const version = createHash("sha256").update(rubricVersion(rubric) + prompt).digest("hex");
  return { room, rubric, prompt, version };
}
export type WorkflowBook = BookIdentity & { id: string; classroomId: string; studentId: string; revision: number; documentJson: string };
export async function workflowBook(teacherId: string, bookId: string) {
  return bindings().DB.prepare(`SELECT b.id, b.classroom_id AS classroomId, b.student_id AS studentId, b.revision, b.document_json AS documentJson, b.title, s.seat_number AS seatNumber, s.real_name AS realName, x.grade, x.class_number AS classNumber FROM storybooks b JOIN classrooms c ON c.id = b.classroom_id JOIN student_profiles s ON s.id = b.student_id LEFT JOIN classroom_book_settings x ON x.classroom_id = c.id WHERE b.id = ? AND c.teacher_id = ? AND c.active = 1 AND s.archived_at IS NULL AND b.status = 'complete' AND b.completed_at IS NOT NULL`).bind(bookId, teacherId).first<WorkflowBook>();
}
export function selectedBookIds(value: unknown) {
  if (!Array.isArray(value) || !value.length || value.length > 50 || value.some((v) => typeof v !== "string" || !/^storybook_[a-zA-Z0-9_-]{8,64}$/.test(v)) || new Set(value).size !== value.length) throw new Error("완성 그림책 1~50권을 중복 없이 선택해 주세요.");
  return value as string[];
}
/** 그릴 책 문서와 그림 저장소 키. 그림 소유·용량 확인은 여기서 하고, 그림을 읽고 그리는 일은 book-render-service가 한다. */
export async function bookRenderSource(book: WorkflowBook): Promise<BookRenderSource> {
  const doc = validateStorybookDocument(JSON.parse(book.documentJson));
  if (!doc) throw new Error("그림책 문서가 올바르지 않아요.");
  const needed = new Set(doc.pages.flatMap((p) => [p.backgroundAssetId, ...p.elements.map((e) => e.assetId)]).filter((v): v is string => Boolean(v)));
  const assetKeys: Record<string, string> = {};
  let total = 0;
  for (const assetId of needed) {
    const row = await bindings().DB.prepare(`SELECT object_key AS objectKey, byte_size AS byteSize FROM storybook_assets WHERE id = ? AND storybook_id = ? AND student_id = ?`).bind(assetId, book.id, book.studentId).first<{ objectKey: string; byteSize: number }>();
    if (!row || row.byteSize > 4_500_000 || (total += row.byteSize) > 80_000_000) throw new Error("이미지를 모두 읽을 수 없어요. 누락 또는 책 전체 용량(80MB)을 확인해 주세요.");
    assetKeys[assetId] = row.objectKey;
  }
  return { document: doc, assetKeys };
}

export async function loadBookImages(book: WorkflowBook, width = 1200) {
  const source = await bookRenderSource(book);
  return { document: source.document, images: await bookPageImages(source, width) };
}

export async function enqueueFeedback(teacherId: string, classroomId: string, ids: string[]) {
  const config = await activeRubric(teacherId, classroomId);
  const books: WorkflowBook[] = [];
  for (const id of ids) {
    const book = await workflowBook(teacherId, id);
    if (!book || book.classroomId !== classroomId) throw new Error("선택에 다른 학급 또는 미완성 그림책이 있어요.");
    books.push(book);
  }
  const db = bindings().DB;
  await db.batch(books.map((book) => db.prepare(`INSERT INTO book_feedback_jobs(id, storybook_id, classroom_id, teacher_id, revision, rubric_version, rubric_json, prompt, document_json, title) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(storybook_id, teacher_id, revision, rubric_version) DO UPDATE SET status = CASE WHEN book_feedback_jobs.status IN ('failed','waiting_key') THEN 'queued' ELSE book_feedback_jobs.status END, error = NULL`).bind(randomUUID(), book.id, classroomId, teacherId, book.revision, config.version, JSON.stringify(config.rubric), config.prompt, book.documentJson, book.title)));
  return books.length;
}

export function feedbackConfigured() { return Boolean(process.env.OPENAI_API_KEY?.trim()); }
export async function callBookFeedback(prompt: string, texts: string[], images: Buffer[], rubric: Rubric, fetchImpl: typeof fetch = fetch) {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) throw new Error("OPENAI_API_KEY를 서버 환경 변수에 넣어 주세요.");
  const model = process.env.BOOK_FEEDBACK_MODEL || process.env.OPENAI_MODEL || "gpt-5.6-sol";
  const schema = { type: "object", additionalProperties: false, required: ["criteria", "summary"], properties: {
    criteria: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "score", "feedback", "pages"], properties: { id: { type: "string" }, score: { type: "number" }, feedback: { type: "string" }, pages: { type: "array", items: { type: "integer" } } } } }, summary: { type: "string" },
  } };
  const response = await fetchImpl("https://api.openai.com/v1/responses", { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, signal: AbortSignal.timeout(120_000), body: JSON.stringify({ model, store: false, instructions: prompt, max_output_tokens: 9000, reasoning: { effort: "low" }, input: [{ role: "user", content: images.flatMap((image, i) => [{ type: "input_text", text: `${i + 1}쪽 원문 (평가 자료):\n${texts[i]}` }, { type: "input_image", image_url: `data:image/jpeg;base64,${image.toString("base64")}`, detail: "high" }]) }], text: { format: { type: "json_schema", name: "storybook_feedback", strict: true, schema } } }) });
  if (!response.ok) throw new Error(response.status === 429 ? "AI 한도 또는 요청 제한에 도달했어요. 잠시 뒤 재시도해 주세요." : `AI 연결 오류(${response.status}). 서버의 키와 모델 설정을 확인해 주세요.`);
  const data = await response.json() as { status?: string; output?: { content?: { type: string; text?: string }[] }[] };
  if (data.status !== "completed") throw new Error("AI 응답이 완성되지 않았어요. 재시도해 주세요.");
  const text = (data.output ?? []).flatMap((o) => o.content ?? []).filter((c) => c.type === "output_text").map((c) => c.text ?? "").join("");
  return validateFeedback(JSON.parse(text), rubric, images.length);
}

export async function processFeedback(teacherId: string, classroomId: string) {
  const db = bindings().DB;
  if (!await bookClassroom(teacherId, classroomId)) throw new Error("학급 권한이 없어요.");
  if (!feedbackConfigured()) {
    await db.prepare(`UPDATE book_feedback_jobs SET status = 'waiting_key' WHERE teacher_id = ? AND classroom_id = ? AND status = 'queued'`).bind(teacherId, classroomId).run();
    return { done: true, waitingKey: true };
  }
  const lease = randomUUID();
  const claimed = await db.prepare(`UPDATE book_feedback_jobs SET status = 'processing', lease = ?, attempts = attempts + 1, updated_at = CURRENT_TIMESTAMP WHERE id = (SELECT id FROM book_feedback_jobs WHERE teacher_id = ? AND classroom_id = ? AND (status IN ('queued','waiting_key') OR (status = 'processing' AND updated_at < datetime('now','-5 minutes'))) ORDER BY created_at, id LIMIT 1) RETURNING *`).bind(lease, teacherId, classroomId).first<{ id: string; storybook_id: string; revision: number; rubric_json: string; prompt: string; document_json: string }>();
  if (!claimed) return { done: true };
  try {
    const book = await workflowBook(teacherId, claimed.storybook_id);
    if (!book || book.revision !== claimed.revision) throw new Error("요청 후 그림책이 변경되었어요. 최신 완성본으로 다시 요청해 주세요.");
    const { document, images } = await loadBookImages({ ...book, documentJson: claimed.document_json });
    const feedback = await callBookFeedback(claimed.prompt, document.pages.map((p) => p.elements.filter((e) => e.type === "text").map((e) => e.text).join("\n")), images, JSON.parse(claimed.rubric_json));
    const latest = await workflowBook(teacherId, book.id);
    if (!latest || latest.revision !== claimed.revision) throw new Error("평가 중 그림책이 변경되었어요. 최신 완성본으로 다시 요청해 주세요.");
    await db.prepare(`UPDATE book_feedback_jobs SET status = 'complete', feedback_json = ?, error = NULL, lease = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND lease = ?`).bind(JSON.stringify(feedback), claimed.id, lease).run();
    return { done: false, id: claimed.id, status: "complete" };
  } catch (error) {
    const message = error instanceof Error && !/fetch|JSON|Unexpected|Abort/i.test(error.message) ? error.message : "피드백을 완성하지 못했어요. 잠시 뒤 재시도해 주세요.";
    await db.prepare(`UPDATE book_feedback_jobs SET status = 'failed', error = ?, lease = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND lease = ?`).bind(message.slice(0, 300), claimed.id, lease).run();
    return { done: false, id: claimed.id, status: "failed" };
  }
}
