import { storybookEditorActor } from "@/lib/storybook-editor-auth";
import { bindings } from "@/db/runtime";
import { MAX_STORYBOOK_PAGES, storybookCompletionError, validateStorybookDocument } from "@/lib/storybook-model";
import { cleanText, jsonError, noStoreJson, rateLimit, sameOrigin } from "@/lib/security";
import { ownedStorybook, priorStorybookMutation, storybookAssets, storybookAssetIds, storybookResponse } from "@/lib/storybook-store";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const student = await storybookEditorActor(request);
  if (!student) return jsonError("학생 로그인이 필요해요.", 401);
  const storybookId = cleanText((await context.params).id, 80);
  const book = await ownedStorybook(storybookId, student.id);
  if (!book) return jsonError("내 그림책이 아니거나 찾을 수 없어요.", 404);
  return noStoreJson(storybookResponse(book, await storybookAssets(storybookId, student.id)));
}

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!sameOrigin(request)) return jsonError("요청 출처를 확인할 수 없어요.", 403);
  const student = await storybookEditorActor(request);
  if (!student) return jsonError("학생 로그인이 필요해요.", 401);
  if (!(await rateLimit(`storybook-save:${student.id}`, 90, 60))) return jsonError("저장이 너무 빨라요. 잠깐 기다려 주세요.", 429);
  const storybookId = cleanText((await context.params).id, 80);
  const payload = await request.json().catch(() => ({})) as Record<string, unknown>;
  const requestId = cleanText(payload.requestId, 80);
  if (!/^[a-zA-Z0-9_-]{12,80}$/.test(requestId)) return jsonError("저장 요청 번호가 올바르지 않아요.");
  const previous = await priorStorybookMutation(requestId, storybookId, student.id);
  if (previous) return noStoreJson({ ok: true, revision: previous.resultRevision, duplicate: true });
  const book = await ownedStorybook(storybookId, student.id);
  if (!book) return jsonError("내 그림책이 아니거나 찾을 수 없어요.", 404);
  const expectedRevision = Number(payload.expectedRevision);
  if (!Number.isInteger(expectedRevision) || expectedRevision !== book.revision) return noStoreJson({ error: "다른 저장이 먼저 반영됐어요. 새로고침해 주세요.", code: "REVISION_CONFLICT", serverRevision: book.revision }, { status: 409 });
  const document = validateStorybookDocument(payload.document);
  if (!document) return jsonError("그림책 페이지 데이터가 올바르지 않아요.");
  // Imported/legacy books may already exceed the student creation limit. Let the student
  // edit every existing page without forcing a destructive shortening of their book.
  const previousPageCount = (JSON.parse(book.documentJson) as { pages: unknown[] }).pages.length;
  if (!new URL(request.url).pathname.startsWith("/api/teacher/") && document.pages.length > Math.max(MAX_STORYBOOK_PAGES, previousPageCount)) return jsonError("그림책 페이지 데이터가 올바르지 않아요.");
  const referencedAssets = new Set(document.pages.flatMap((page) => [
    ...(page.backgroundAssetId ? [page.backgroundAssetId] : []),
    ...page.elements.filter((element) => element.type === "image").map((element) => element.assetId as string),
  ]));
  if (referencedAssets.size) {
    const ownedAssets = await storybookAssetIds(storybookId, student.id);
    if ([...referencedAssets].some((assetId) => !ownedAssets.has(assetId))) return jsonError("다른 그림책의 이미지는 사용할 수 없어요.", 403);
  }
  const title = typeof payload.title === "string" ? cleanText(payload.title, 60) : book.title;
  const complete = payload.complete === true;
  const completionError = complete && storybookCompletionError(title, document.pages.length, !new URL(request.url).pathname.startsWith("/api/teacher/"));
  if (completionError) return jsonError(completionError);
  const newRevision = book.revision + 1;
  const db = bindings().DB;
  const results = await db.batch([
    db.prepare(`UPDATE storybooks SET title = ?, document_json = ?, revision = ?, status = CASE WHEN ? = 1 THEN 'complete' ELSE 'draft' END, completed_at = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE NULL END, last_mutation_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND student_id = ? AND revision = ?`).bind(title, JSON.stringify(document), newRevision, complete ? 1 : 0, complete ? 1 : 0, requestId, storybookId, student.id, expectedRevision),
    db.prepare(`INSERT INTO storybook_mutations(request_id, storybook_id, student_id, result_revision) SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM storybooks WHERE id = ? AND student_id = ? AND revision = ? AND last_mutation_id = ?) ON CONFLICT DO NOTHING`).bind(requestId, storybookId, student.id, newRevision, storybookId, student.id, newRevision, requestId),
  ]);
  if (!results[0]?.meta.changes) {
    const duplicate = await priorStorybookMutation(requestId, storybookId, student.id);
    if (duplicate) return noStoreJson({ ok: true, revision: duplicate.resultRevision, duplicate: true });
    const current = await ownedStorybook(storybookId, student.id);
    return noStoreJson({ error: "다른 저장이 먼저 반영됐어요. 새로고침해 주세요.", code: "REVISION_CONFLICT", serverRevision: current?.revision }, { status: 409 });
  }
  return noStoreJson({ ok: true, revision: newRevision, status: complete ? "complete" : "draft" });
}
