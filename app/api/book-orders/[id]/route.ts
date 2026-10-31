import { isAdmin } from "@/lib/admin";
import { bookOrder } from "@/lib/book-orders";
import { jsonError, noStoreJson, requireTeacher } from "@/lib/security";

// 견적서 한 건. 주문한 교사와 운영자만 본다. 다른 사람에게는 있는지조차 알리지 않는다(404).
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const teacher = await requireTeacher(); if (!teacher) return jsonError("로그인이 필요해요.", 401);
  const order = await bookOrder((await context.params).id);
  if (!order || (order.teacher_id !== teacher.id && !isAdmin(teacher))) return jsonError("주문을 찾을 수 없어요.", 404);
  return noStoreJson({ order, admin: isAdmin(teacher), owner: order.teacher_id === teacher.id });
}
