import { bindings } from "@/db/runtime";
import { jsonError, noStoreJson, requireTeacher } from "@/lib/security";
import { workflowBook } from "@/lib/book-workflow";
import { downloadResponse, feedbackFilename } from "@/lib/book-render-shared";
import { bookFeedbackPdf } from "@/lib/book-render-service";
import { parseFeedbackExport } from "@/lib/feedback-export";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const teacher = await requireTeacher(); if (!teacher) return jsonError("교사 로그인이 필요해요.", 401);
  const job = await bindings().DB.prepare(`SELECT * FROM book_feedback_jobs WHERE id = ? AND teacher_id = ? AND status = 'complete'`).bind((await context.params).id, teacher.id).first<{ storybook_id: string; revision: number; rubric_json: string; feedback_json: string; rubric_version: string; title: string }>();
  if (!job) return jsonError("완성된 피드백을 찾을 수 없어요.", 404);
  const book = await workflowBook(teacher.id, job.storybook_id);
  if (!book) return jsonError("그림책 접근 권한이 없어요.", 403);
  if (book.revision !== job.revision) return jsonError("그림책이 수정되었어요. 최신 완성본의 피드백을 다시 요청해 주세요.", 409);
  const rubric = JSON.parse(job.rubric_json), feedback = JSON.parse(job.feedback_json);
  if (new URL(request.url).searchParams.get("format") !== "pdf") return noStoreJson({ rubric, feedback, version: job.rubric_version, title: job.title });
  try { return downloadResponse(await bookFeedbackPdf({ ...book, title: job.title }, rubric, feedback, job.rubric_version, parseFeedbackExport(new URL(request.url).searchParams, rubric)), feedbackFilename({ ...book, title: job.title })); }
  catch (error) { return jsonError(error instanceof Error ? error.message : "PDF를 만들지 못했어요."); }
}
