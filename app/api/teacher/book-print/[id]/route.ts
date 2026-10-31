import { bindings } from "@/db/runtime";
import { jsonError, requireTeacher } from "@/lib/security";
import { workflowBook } from "@/lib/book-workflow";
import { printObjectKey, type PrintJob } from "@/lib/book-print-workflow";
import { downloadResponse } from "@/lib/book-render";
import { PRINT_LAYOUT_VERSION } from "@/lib/book-print-format";
import { printEnvironment } from "@/lib/sweetbook";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const teacher = await requireTeacher(); if (!teacher) return jsonError("교사 로그인이 필요해요.", 401);
  const job = await bindings().DB.prepare(`SELECT * FROM book_print_jobs WHERE id = ? AND teacher_id = ? AND environment = ?`).bind((await context.params).id, teacher.id, printEnvironment()).first<PrintJob>();
  if (!job || !await workflowBook(teacher.id, job.storybook_id)) return jsonError("이 인쇄 파일에 접근할 권한이 없어요.", 404);
  if (job.status !== "ready" || !job.layout_json || JSON.parse(job.layout_json).sourceLayoutVersion !== PRINT_LAYOUT_VERSION) return jsonError("표지·내지 인쇄 준비를 다시 눌러 주세요.", 409);
  const kind = new URL(request.url).searchParams.get("kind") === "cover" ? "cover" : "inner";
  const file = await bindings().ARTWORKS.get(printObjectKey(job.id, kind));
  if (!file) return jsonError("인쇄용 파일을 먼저 준비해 주세요.", 404);
  return downloadResponse(new Uint8Array(await file.arrayBuffer()), `${kind === "cover" ? "표지" : "내지"}_${job.id.slice(0, 8)}.pdf`);
}
