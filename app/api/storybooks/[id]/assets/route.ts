import { storybookEditorActor } from "@/lib/storybook-editor-auth";
import { bindings } from "@/db/runtime";
import { cleanText, id, jsonError, noStoreJson, randomToken, rateLimit, sameOrigin } from "@/lib/security";
import { ownedStorybook, storybookAssets } from "@/lib/storybook-store";

// Vercel Functions의 4.5MB 요청 한도 아래에서 raw PNG로 전송한다. base64 JSON은
// 같은 그림을 약 33% 키우므로 사용하지 않는다.
const MAX_UPLOAD_BYTES = 3_500_000;

function validatePng(bytes: Uint8Array) {
  if (bytes.length > MAX_UPLOAD_BYTES) return false;
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < signature.length || signature.some((value, index) => bytes[index] !== value)) return false;
  if (bytes.length < 24 || String.fromCharCode(...bytes.slice(12, 16)) !== "IHDR") return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16); const height = view.getUint32(20);
  return Boolean(width && height && width <= 4096 && height <= 4096 && width * height <= 16_000_000);
}

function publicAsset(asset: Awaited<ReturnType<typeof storybookAssets>>[number]) {
  const { objectKey: _objectKey, studentId: _studentId, ...value } = asset;
  void _objectKey;
  void _studentId;
  return value;
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!sameOrigin(request)) return jsonError("요청 출처를 확인할 수 없어요.", 403);
  const student = await storybookEditorActor(request);
  if (!student) return jsonError("학생 로그인이 필요해요.", 401);
  if (!(await rateLimit(`storybook-asset:${student.id}`, new URL(request.url).pathname.startsWith("/api/teacher/") ? 180 : 30, 60))) return jsonError("이미지를 너무 빠르게 추가하고 있어요.", 429);
  const storybookId = cleanText((await context.params).id, 80);
  if (!(await ownedStorybook(storybookId, student.id))) return jsonError("내 그림책이 아니거나 찾을 수 없어요.", 404);
  const currentAssets = await storybookAssets(storybookId, student.id);
  // Retained originals and prior cutouts are not visible-picture counts. Never use
  // this list's length to block new images; keep originals for undo and saved copies.
  const contentType = request.headers.get("content-type") ?? "";
  const payload = contentType.startsWith("application/json")
    ? await request.json().catch(() => ({})) as Record<string, unknown>
    : {};
  const sourceType = contentType.startsWith("image/png") ? "upload" : cleanText(payload.sourceType, 20);
  if (sourceType === "artwork") {
    const artworkId = cleanText(payload.artworkId, 80);
    const existing = currentAssets.find((asset) => asset.sourceType === "artwork" && asset.sourceArtworkId === artworkId);
    if (existing) return noStoreJson({ asset: publicAsset(existing), duplicate: true });
    const artwork = await bindings().DB.prepare(`SELECT id, final_image_key AS finalImageKey FROM artworks WHERE id = ? AND student_id = ? AND status = 'complete' AND final_image_key IS NOT NULL`).bind(artworkId, student.id).first<{ id: string; finalImageKey: string }>();
    if (!artwork) return jsonError("완성된 내 그림을 찾을 수 없어요.", 404);
    const object = await bindings().ARTWORKS.head(artwork.finalImageKey);
    if (!object) return jsonError("완성 그림 파일을 찾을 수 없어요.", 404);
    const assetId = id("asset");
    await bindings().DB.prepare(`INSERT INTO storybook_assets(id, storybook_id, student_id, source_type, source_artwork_id, object_key, content_type, byte_size) VALUES (?, ?, ?, 'artwork', ?, ?, ?, ?)`).bind(assetId, storybookId, student.id, artwork.id, artwork.finalImageKey, object.httpMetadata?.contentType ?? "image/png", object.size).run();
    const created = (await storybookAssets(storybookId, student.id)).find((asset) => asset.id === assetId);
    return created ? noStoreJson({ asset: publicAsset(created) }, { status: 201 }) : jsonError("이미지를 추가할 수 없어요.", 409);
  }
  if (sourceType !== "upload") return jsonError("추가할 이미지 종류를 확인해 주세요.");
  if (!contentType.startsWith("image/png")) return jsonError("PNG 이미지는 바이너리로 올려 주세요.", 415);
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_UPLOAD_BYTES) return jsonError("PNG 이미지가 너무 커요.", 413);
  const image = new Uint8Array(await request.arrayBuffer());
  if (!validatePng(image)) return jsonError("PNG 이미지가 아니거나 파일이 너무 커요.", image.length > MAX_UPLOAD_BYTES ? 413 : 415);
  const assetId = id("asset");
  const objectKey = `students/${student.id}/storybooks/${storybookId}/assets/${assetId}-${randomToken(8)}.png`;
  await bindings().ARTWORKS.put(objectKey, image, {
    httpMetadata: { contentType: "image/png", cacheControl: "private, max-age=300" },
    customMetadata: { studentId: student.id, storybookId, assetId, sourceType: "upload" },
  });
  try {
    await bindings().DB.prepare(`INSERT INTO storybook_assets(id, storybook_id, student_id, source_type, object_key, content_type, byte_size) VALUES (?, ?, ?, 'upload', ?, 'image/png', ?)`).bind(assetId, storybookId, student.id, objectKey, image.length).run();
  } catch (error) {
    await bindings().ARTWORKS.delete(objectKey).catch(() => undefined);
    throw error;
  }
  const created = (await storybookAssets(storybookId, student.id)).find((asset) => asset.id === assetId);
  return created ? noStoreJson({ asset: publicAsset(created) }, { status: 201 }) : jsonError("이미지를 추가할 수 없어요.", 409);
}
