import { bindings } from "@/db/runtime";
import { requireTeacher, sameOrigin, noStoreJson, jsonError, rateLimit, cleanText, id } from "@/lib/security";
import { emptyStorybookDocument, DEFAULT_STORYBOOK_FORMAT, STORYBOOK_FORMATS, type StorybookFormat } from "@/lib/storybook-model";
import { bookClassroom } from "@/lib/book-workflow";
import { studioAuthor } from "@/lib/studio-authors";
export async function GET(request: Request) {
  const teacher = await requireTeacher();
  if (!teacher) return jsonError("교사 로그인이 필요해요.", 401);
  const classroomId = new URL(request.url).searchParams.get("classroomId") ?? "";
  if (!await bookClassroom(teacher.id, classroomId)) return jsonError("학급 권한이 없어요.", 403);
  const students = await bindings().DB.prepare(`SELECT id, seat_number AS seatNumber, real_name AS realName FROM student_profiles WHERE classroom_id=? AND archived_at IS NULL AND seat_number IS NOT NULL ORDER BY seat_number`).bind(classroomId).all();
  const drafts = await bindings().DB.prepare(`SELECT b.id,b.title,b.revision,s.seat_number AS seatNumber,s.real_name AS realName FROM storybooks b JOIN student_profiles s ON s.id=b.student_id WHERE b.classroom_id=? AND b.status='draft' AND s.archived_at IS NULL ORDER BY b.updated_at DESC LIMIT 200`).bind(classroomId).all();
  return noStoreJson({ students: students.results, drafts: drafts.results });
}
export async function POST(request: Request) {
  if (!sameOrigin(request)) return jsonError("요청 출처를 확인해 주세요.", 403);
  const teacher = await requireTeacher();
  if (!teacher) return jsonError("교사 로그인이 필요해요.", 401);
  if (!await rateLimit(`book-import:${teacher.id}`, 50, 60)) return jsonError("잠시 후 다시 올려 주세요.", 429);
  const raw = await request.json().catch(() => ({}));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return jsonError("입력 값을 확인해 주세요.");
  const data = raw as { classroomId?: string; studentId?: string; authorName?: string; title?: string; bookId?: string; format: StorybookFormat; pageCount: number };
  if (typeof data.classroomId !== "string" || (typeof data.studentId !== "string" && typeof data.authorName !== "string")) return jsonError("학급과 학생을 선택해 주세요.");
  if (!await bookClassroom(teacher.id, data.classroomId ?? "")) return jsonError("학급 권한이 없어요.", 403);
  // 그림책 공방: 명단에서 고르지 않고 지은이 이름을 적으면 명단 자리를 찾거나 만든다(lib/studio-authors.ts).
  if (typeof data.studentId !== "string") {
    const author = await studioAuthor(data.classroomId, data.authorName);
    if ("error" in author) return jsonError(author.error ?? "지은이 이름을 적어 주세요.");
    data.studentId = author.id;
  }
  const student = await bindings().DB.prepare(`SELECT id FROM student_profiles WHERE id=? AND classroom_id=? AND archived_at IS NULL AND seat_number IS NOT NULL`).bind(data.studentId ?? "", data.classroomId).first<{ id: string }>();
  if (!student) return jsonError("이 그림책의 학생을 학급 명단에서 선택해 주세요.", 400);
  if (!STORYBOOK_FORMATS.includes(data.format) || !Number.isSafeInteger(data.pageCount) || data.pageCount < 1) return jsonError("PDF의 형식과 쪽 수를 확인해 주세요.");
  if (typeof data.bookId !== "string" || !/^storybook_[a-f0-9]{32}$/.test(data.bookId)) return jsonError("업로드 요청 번호가 올바르지 않아요.");
  const title = cleanText(data.title, 60);
  if (!title) return jsonError("그림책 제목을 입력해 주세요.");
  const db = bindings().DB;
  const prior = await db.prepare(`SELECT id, student_id AS studentId, classroom_id AS classroomId FROM storybooks WHERE id=?`).bind(data.bookId).first<{ id: string; studentId: string; classroomId: string }>();
  if (prior) {
    if (prior.studentId !== student.id || prior.classroomId !== data.classroomId) return jsonError("다른 업로드 요청 번호예요.", 409);
    return noStoreJson({ id: prior.id }, { status: 200 });
  }
  const doc = emptyStorybookDocument(DEFAULT_STORYBOOK_FORMAT, id("page"), id("element"));
  doc.pages[0].elements[0].text = "";
  await db.prepare(`INSERT INTO storybooks(id,student_id,classroom_id,title,document_json,schema_version) VALUES(?,?,?,?,?,1)`).bind(data.bookId, student.id, data.classroomId, title, JSON.stringify(doc)).run();
  return noStoreJson({ id: data.bookId }, { status: 201 });
}
