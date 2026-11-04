import { bookOrder, bookOrderName, payBookOrderByCard } from "@/lib/book-orders";
import { tossClientKey, tossReady } from "@/lib/toss";
import { jsonError, noStoreJson, rateLimit, requireTeacher, sameOrigin } from "@/lib/security";

// 카드 결제(2026-11-04 그림책 공방). GET: 결제창을 여는 값, POST: 결제창에서 돌아온 결제를 승인한다. 주문한 교사만.
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const teacher = await requireTeacher(); if (!teacher) return jsonError("로그인이 필요해요.", 401);
  const order = await bookOrder((await context.params).id);
  if (!order || order.teacher_id !== teacher.id) return jsonError("주문을 찾을 수 없어요.", 404);
  if (!tossReady()) return noStoreJson({ ready: false });
  return noStoreJson({ ready: order.status === "awaiting_deposit", clientKey: tossClientKey(), customerKey: teacher.id, amount: order.quote.totals.total, orderName: bookOrderName(order), customerEmail: order.document.teacher.email, customerName: order.document.teacher.name });
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!sameOrigin(request)) return jsonError("요청 출처를 확인해 주세요.", 403);
  const teacher = await requireTeacher(); if (!teacher) return jsonError("로그인이 필요해요.", 401);
  if (!await rateLimit(`book-order-pay:${teacher.id}`, 20, 60)) return jsonError("잠시 뒤 다시 시도해 주세요.", 429);
  const body = await request.json().catch(() => ({}));
  try {
    return noStoreJson(await payBookOrderByCard(teacher.id, (await context.params).id, body && typeof body === "object" ? body as Record<string, unknown> : {}));
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "결제를 확인하지 못했어요.", 400);
  }
}
