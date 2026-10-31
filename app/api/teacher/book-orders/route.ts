import { bindings } from "@/db/runtime";
import { bookClassroom } from "@/lib/book-workflow";
import { bookOrderSettings, cancelBookOrder, createBookOrder, orderableBooks, teacherBookOrders } from "@/lib/book-orders";
import { bookOrderSettingsReady } from "@/lib/book-order-pricing";
import { cleanText, jsonError, noStoreJson, rateLimit, requireTeacher, sameOrigin } from "@/lib/security";

// 교사: 우리 반 완성 그림책 목록·가격·입금 계좌·주문 내역을 한 번에 읽는다.
export async function GET(request: Request) {
  const teacher = await requireTeacher(); if (!teacher) return jsonError("로그인이 필요해요.", 401);
  const classroomId = cleanText(new URL(request.url).searchParams.get("classroomId"), 40);
  const room = await bookClassroom(teacher.id, classroomId); if (!room) return jsonError("학급 권한이 없어요.", 403);
  const [settings, books, orders, profile] = await Promise.all([
    bookOrderSettings(), orderableBooks(teacher.id, classroomId), teacherBookOrders(teacher.id, classroomId),
    bindings().DB.prepare(`SELECT school_name AS schoolName FROM classroom_profiles WHERE classroom_id = ?`).bind(classroomId).first<{ schoolName: string }>(),
  ]);
  return noStoreJson({
    ready: bookOrderSettingsReady(settings),
    settings: bookOrderSettingsReady(settings) ? settings : null,
    books, orders,
    room: { name: room.displayName, school: profile?.schoolName ?? "", grade: room.grade, classNumber: room.classNumber },
  });
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return jsonError("요청 출처 오류", 403);
  const teacher = await requireTeacher(); if (!teacher) return jsonError("로그인이 필요해요.", 401);
  if (!await rateLimit(`book-order:${teacher.id}`, 20, 60)) return jsonError("잠시 후 다시 시도해 주세요.", 429);
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return jsonError("주문 내용을 읽지 못했어요.");
  try {
    if (body.action === "cancel") { await cancelBookOrder(teacher.id, String(body.id ?? "")); return noStoreJson({ ok: true }); }
    return noStoreJson(await createBookOrder(teacher, body), { status: 201 });
  } catch (error) {
    return jsonError(error instanceof Error && /[가-힣]/.test(error.message) ? error.message : "주문을 저장하지 못했어요. 같은 화면에서 다시 눌러 주세요.");
  }
}
