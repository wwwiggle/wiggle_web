import { bindings } from "@/db/runtime";
import { isAdmin } from "@/lib/admin";
import { requireTeacher, jsonError, noStoreJson } from "@/lib/security";
import { readPrintFile, type PrintRequest, type RequestDocument } from "@/lib/print-requests";
import { downloadResponse } from "@/lib/book-render-shared";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const teacher = await requireTeacher(); if (!teacher) return jsonError("로그인이 필요해요.", 401);
  const row = await bindings().DB.prepare(`SELECT * FROM print_requests WHERE id = ?`).bind((await context.params).id).first<PrintRequest>();
  if (!row || (!isAdmin(teacher) && row.teacher_id !== teacher.id)) return jsonError("요청서 권한이 없어요.", 404);
  const url = new URL(request.url), document: RequestDocument = JSON.parse(row.document_json);
  if (url.searchParams.get("kind") === "detail") return noStoreJson(row);
  if (url.searchParams.get("kind") === "request") return new Response(JSON.stringify({ requestId: row.id, environment: row.environment, submittedAt: row.created_at, ...document }, null, 2), { headers: { "content-type": "application/json; charset=utf-8", "content-disposition": `attachment; filename="request-${row.id}.json"`, "cache-control": "no-store" } });
  const item = document.items.find((i) => i.id === url.searchParams.get("item"));
  const kind = url.searchParams.get("kind");
  if (!item || (kind !== "cover" && kind !== "inner")) return jsonError("파일을 찾을 수 없어요.", 404);
  return downloadResponse(await readPrintFile(item[kind]), `${item.title}_${kind === "cover" ? "표지" : "내지"}.pdf`);
}
