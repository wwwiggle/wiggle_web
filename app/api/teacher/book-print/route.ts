import { BOOK_PRINT_SPEC_UID } from "@/lib/book-print-format";
import { bindings } from "@/db/runtime";
import { cleanText, jsonError, noStoreJson, requireTeacher, sameOrigin, rateLimit } from "@/lib/security";
import { bookClassroom, selectedBookIds } from "@/lib/book-workflow";
import { enqueuePrint } from "@/lib/book-print-workflow";
import { printConfigured, printEnvironment, sweetbook } from "@/lib/sweetbook";
import type { PrintSpec } from "@/lib/book-render-shared";

export const maxDuration = 120;
export async function GET(request: Request) {
  const teacher = await requireTeacher(); if (!teacher) return jsonError("교사 로그인이 필요해요.", 401);
  const classroomId = cleanText(new URL(request.url).searchParams.get("classroomId"), 40);
  if (!await bookClassroom(teacher.id, classroomId)) return jsonError("학급 권한이 없어요.", 403);
  const db = bindings().DB;
  const jobs = await db.prepare(`SELECT p.id, p.storybook_id AS storybookId, p.revision, p.spec_uid AS specUid, p.status, p.error, p.layout_json AS layoutJson, b.title FROM book_print_jobs p JOIN storybooks b ON b.id = p.storybook_id WHERE p.teacher_id = ? AND p.classroom_id = ? AND p.environment = ? ORDER BY p.created_at DESC, p.rowid DESC LIMIT 1000`).bind(teacher.id, classroomId, printEnvironment()).all();
  let specs: PrintSpec[] = [], configError = "";
  if (printConfigured()) {
    try { specs = await sweetbook<PrintSpec[]>("/book-specs"); if (!Array.isArray(specs)) throw new Error("판형 목록 응답을 확인해 주세요."); specs = specs.filter((spec) => spec.bookSpecUid === BOOK_PRINT_SPEC_UID); }
    catch (error) { configError = error instanceof Error ? error.message : "판형 목록을 불러오지 못했어요."; }
  }
  return noStoreJson({ configured: printConfigured(), environment: printEnvironment(), specs, configError, jobs: jobs.results });
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return jsonError("요청 출처를 확인할 수 없어요.", 403);
  const teacher = await requireTeacher(); if (!teacher) return jsonError("교사 로그인이 필요해요.", 401);
  if (!await rateLimit(`book-print:${teacher.id}`, 60, 60)) return jsonError("잠시 뒤 다시 시도해 주세요.", 429);
  try {
    const body = await request.json() as { classroomId: string; action: string; storybookIds: unknown; specUid: string; items: unknown; shipping: unknown; orderId: string; confirmed: boolean };
    const classroomId = cleanText(body.classroomId, 40);
    if (!await bookClassroom(teacher.id, classroomId)) return jsonError("학급 권한이 없어요.", 403);
    if (body.action === "prepare") {
      await enqueuePrint(teacher.id, classroomId, selectedBookIds(body.storybookIds), body.specUid);
      return noStoreJson({ ok: true }, { status: 202 });
    }
    return jsonError("실제 발주는 관리자만 실행할 수 있어요. 주문 요청서를 제출해 주세요.", 403);
  } catch (error) { return jsonError(error instanceof Error && /[가-힣]/.test(error.message) ? error.message : "주문 처리 중 연결을 확인하지 못했어요.", 400); }
}
