import { createHash } from "node:crypto";
import { bindings } from "@/db/runtime";
import { cleanText, jsonError, noStoreJson, rateLimit, sameOrigin } from "@/lib/security";
import { storybookEditorActor } from "@/lib/storybook-editor-auth";
import { ownedStorybook, storybookAssets } from "@/lib/storybook-store";
import type { StorybookDocument } from "@/lib/storybook-model";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!sameOrigin(request)) return jsonError("요청 출처를 확인할 수 없어요.", 403);
  const student = await storybookEditorActor(request);
  if (!student) return jsonError("로그인이 필요해요.", 401);
  const sourceId = cleanText((await context.params).id, 80);
  const source = await ownedStorybook(sourceId, student.id);
  if (!source) return jsonError("내 그림책이 아니거나 찾을 수 없어요.", 404);
  const payload = await request.json().catch(() => ({})) as Record<string, unknown>;
  const copyId = cleanText(payload.copyId, 80);
  if (!/^storybook_[a-f0-9]{32}$/.test(copyId) || copyId === sourceId) return jsonError("복제 요청 번호가 올바르지 않아요.");
  // The client keeps this ID for retries. A lost response cannot create a second copy.
  const prior = await ownedStorybook(copyId, student.id);
  if (prior) return noStoreJson({ storybook: { id: prior.id }, duplicate: true });
  if (!(await rateLimit(`storybook-duplicate:${student.id}`, 20, 60))) return jsonError("복제가 너무 빨라요. 잠깐 기다려 주세요.", 429);
  const assets = await storybookAssets(source.id, student.id);
  const assetIds = new Map(assets.map(asset => [asset.id, `asset_${createHash("sha256").update(`${copyId}:${asset.id}`).digest("hex").slice(0, 32)}`]));
  const document = JSON.parse(source.documentJson) as StorybookDocument;
  const referenced = document.pages.flatMap(page => [page.backgroundAssetId, ...page.elements.filter(element => element.type === "image").map(element => element.assetId)]).filter(Boolean);
  if (referenced.some(id => !assetIds.has(id!))) return jsonError("원본의 그림 파일 정보를 확인해 주세요. 원본은 그대로 보관돼요.", 409);
  // Copy every field and page verbatim; never pass old books through an authoring normalizer.
  for (const page of document.pages) {
    if (page.backgroundAssetId) page.backgroundAssetId = assetIds.get(page.backgroundAssetId)!;
    for (const element of page.elements) if (element.assetId) element.assetId = assetIds.get(element.assetId)!;
  }
  const db = bindings().DB;
  const title = cleanText(payload.title, 60) || `${source.title || "그림책"} - 복사본`.slice(0, 60);
  // Images are immutable objects (the same model as artwork import). Each copy has its own
  // asset rows; editing uploads a new object, never overwrites or deletes the source object.
  await db.batch([
    db.prepare(`INSERT INTO storybooks(id, student_id, classroom_id, title, document_json, schema_version, status) SELECT ?, ?, ?, ?, ?, ?, 'draft' WHERE EXISTS (SELECT 1 FROM storybooks WHERE id = ? AND student_id = ? AND revision = ?) ON CONFLICT DO NOTHING`)
      .bind(copyId, student.id, source.classroomId, title, JSON.stringify(document), source.schemaVersion, source.id, student.id, source.revision),
    ...assets.map(asset => db.prepare(`INSERT INTO storybook_assets(id, storybook_id, student_id, source_type, source_artwork_id, object_key, content_type, byte_size) SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM storybooks WHERE id = ? AND student_id = ?) ON CONFLICT DO NOTHING`)
      .bind(assetIds.get(asset.id)!, copyId, student.id, asset.sourceType, asset.sourceArtworkId, asset.objectKey, asset.contentType, asset.byteSize, copyId, student.id)),
  ]);
  const copied = await ownedStorybook(copyId, student.id);
  if (!copied) return jsonError("원본이 바뀌었어요. 다시 복제해 주세요.", 409);
  return noStoreJson({ storybook: { id: copied.id } }, { status: 201 });
}
