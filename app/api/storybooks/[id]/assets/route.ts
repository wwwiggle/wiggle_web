import { storybookEditorActor } from "@/lib/storybook-editor-auth";
import { bindings } from "@/db/runtime";
import { cleanText, id, jsonError, noStoreJson, randomToken, rateLimit, sameOrigin } from "@/lib/security";
import { ownedStorybook, storybookAsset, storybookArtworkAsset, type StorybookAssetRow } from "@/lib/storybook-store";

// Vercel Functions의 4.5MB 요청 한도 아래에서 raw PNG·JPEG로 전송한다. base64 JSON은
// 같은 그림을 약 33% 키우므로 사용하지 않는다.
// 2026-11-02: 투명한 곳이 없는 그림(사진 등)은 JPEG로 받는다. 같은 2048px 그림이 PNG 2~4MB → JPEG 수백 KB라
// 올리기·내려받기가 몇 배 빨라진다. 인쇄·PDF는 sharp가 어떤 형식이든 PNG로 바꿔 그린다(lib/book-render.ts).
const MAX_UPLOAD_BYTES = 3_500_000;
const MAX_SIDE = 4096, MAX_PIXELS = 16_000_000;
const UPLOAD_TYPES = { "image/png": "png", "image/jpeg": "jpg" } as const;
type UploadType = keyof typeof UPLOAD_TYPES;
function uploadType(contentType: string): UploadType | null {
  const type = contentType.split(";")[0].trim().toLowerCase();
  return type in UPLOAD_TYPES ? type as UploadType : null;
}
const sizeOk = (width: number, height: number) => Boolean(width && height && width <= MAX_SIDE && height <= MAX_SIDE && width * height <= MAX_PIXELS);

function validatePng(bytes: Uint8Array) {
  if (bytes.length > MAX_UPLOAD_BYTES) return false;
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < signature.length || signature.some((value, index) => bytes[index] !== value)) return false;
  if (bytes.length < 24 || String.fromCharCode(...bytes.slice(12, 16)) !== "IHDR") return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16); const height = view.getUint32(20);
  return sizeOk(width, height);
}

/** JPEG 표식(FFD8)과 SOF 머리말의 가로·세로를 확인한다. */
function validateJpeg(bytes: Uint8Array) {
  if (bytes.length > MAX_UPLOAD_BYTES || bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return false;
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) { offset++; continue; }
    const marker = bytes[offset + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xff) { offset += marker === 0xff ? 1 : 2; continue; }
    const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
    if (length < 2) return false;
    // SOF0~SOF15 (DHT C4, JPG C8, DAC CC 제외)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = (bytes[offset + 5] << 8) | bytes[offset + 6];
      const width = (bytes[offset + 7] << 8) | bytes[offset + 8];
      return sizeOk(width, height);
    }
    if (marker === 0xda || marker === 0xd9) return false;
    offset += 2 + length;
  }
  return false;
}

function publicAsset(asset: StorybookAssetRow) {
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
  // Keep all originals without imposing a picture count quota or reading the full list.
  const contentType = request.headers.get("content-type") ?? "";
  const payload = contentType.startsWith("application/json")
    ? await request.json().catch(() => ({})) as Record<string, unknown>
    : {};
  const imageType = uploadType(contentType);
  const sourceType = imageType ? "upload" : cleanText(payload.sourceType, 20);
  if (sourceType === "artwork") {
    const artworkId = cleanText(payload.artworkId, 80);
    const existing = await storybookArtworkAsset(storybookId, student.id, artworkId);
    if (existing) return noStoreJson({ asset: publicAsset(existing), duplicate: true });
    const artwork = await bindings().DB.prepare(`SELECT id, final_image_key AS finalImageKey FROM artworks WHERE id = ? AND student_id = ? AND status = 'complete' AND final_image_key IS NOT NULL`).bind(artworkId, student.id).first<{ id: string; finalImageKey: string }>();
    if (!artwork) return jsonError("완성된 내 그림을 찾을 수 없어요.", 404);
    const object = await bindings().ARTWORKS.head(artwork.finalImageKey);
    if (!object) return jsonError("완성 그림 파일을 찾을 수 없어요.", 404);
    const assetId = id("asset");
    await bindings().DB.prepare(`INSERT INTO storybook_assets(id, storybook_id, student_id, source_type, source_artwork_id, object_key, content_type, byte_size) VALUES (?, ?, ?, 'artwork', ?, ?, ?, ?)`).bind(assetId, storybookId, student.id, artwork.id, artwork.finalImageKey, object.httpMetadata?.contentType ?? "image/png", object.size).run();
    const created = await storybookAsset(storybookId, student.id, assetId);
    return created ? noStoreJson({ asset: publicAsset(created) }, { status: 201 }) : jsonError("이미지를 추가할 수 없어요.", 409);
  }
  if (sourceType !== "upload") return jsonError("추가할 이미지 종류를 확인해 주세요.");
  if (!imageType) return jsonError("PNG·JPEG 이미지는 바이너리로 올려 주세요.", 415);
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_UPLOAD_BYTES) return jsonError("이미지가 너무 커요.", 413);
  const image = new Uint8Array(await request.arrayBuffer());
  const valid = imageType === "image/png" ? validatePng(image) : validateJpeg(image);
  if (!valid) return jsonError("PNG·JPEG 이미지가 아니거나 파일이 너무 커요.", image.length > MAX_UPLOAD_BYTES ? 413 : 415);
  const assetId = id("asset");
  const objectKey = `students/${student.id}/storybooks/${storybookId}/assets/${assetId}-${randomToken(8)}.${UPLOAD_TYPES[imageType]}`;
  await bindings().ARTWORKS.put(objectKey, image, {
    httpMetadata: { contentType: imageType, cacheControl: "private, max-age=300" },
    customMetadata: { studentId: student.id, storybookId, assetId, sourceType: "upload" },
  });
  try {
    await bindings().DB.prepare(`INSERT INTO storybook_assets(id, storybook_id, student_id, source_type, object_key, content_type, byte_size) VALUES (?, ?, ?, 'upload', ?, ?, ?)`).bind(assetId, storybookId, student.id, objectKey, imageType, image.length).run();
  } catch (error) {
    await bindings().ARTWORKS.delete(objectKey).catch(() => undefined);
    throw error;
  }
  const created = await storybookAsset(storybookId, student.id, assetId);
  return created ? noStoreJson({ asset: publicAsset(created) }, { status: 201 }) : jsonError("이미지를 추가할 수 없어요.", 409);
}
