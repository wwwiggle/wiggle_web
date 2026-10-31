import { requireAdmin } from "@/lib/admin";
import { allBookOrders, bookOrderSettings, saveBookOrderNote, saveBookOrderSettings, updateBookOrderStatus } from "@/lib/book-orders";
import { jsonError, noStoreJson, rateLimit, sameOrigin } from "@/lib/security";

export async function GET() {
  if (!await requireAdmin()) return jsonError("관리자 권한이 필요해요.", 403);
  const [orders, settings] = await Promise.all([allBookOrders(), bookOrderSettings()]);
  return noStoreJson({ orders, settings });
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return jsonError("요청 출처 오류", 403);
  const admin = await requireAdmin(); if (!admin) return jsonError("관리자 권한이 필요해요.", 403);
  if (!await rateLimit(`admin-book-orders:${admin.id}`, 60, 60)) return jsonError("잠시 후 다시 시도해 주세요.", 429);
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return jsonError("요청 내용을 읽지 못했어요.");
  try {
    if (body.action === "settings") return noStoreJson({ settings: await saveBookOrderSettings(body.settings, admin.email) });
    if (body.action === "status") { await updateBookOrderStatus(String(body.id ?? ""), String(body.status ?? ""), body.note); return noStoreJson({ ok: true }); }
    if (body.action === "note") { await saveBookOrderNote(String(body.id ?? ""), body.note); return noStoreJson({ ok: true }); }
    return jsonError("알 수 없는 요청이에요.");
  } catch (error) {
    return jsonError(error instanceof Error && /[가-힣]/.test(error.message) ? error.message : "처리하지 못했어요.");
  }
}
