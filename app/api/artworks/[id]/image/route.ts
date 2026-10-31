import { DRAWING_LOCKED, drawingLockedResponse } from "@/lib/feature-locks";
import { bindings } from "@/db/runtime";
import { cleanText, jsonError, noStoreJson, randomToken, rateLimit, sameOrigin, studentFromRequest } from "@/lib/security";

type ArtworkImage = {
  thumbnailKey: string | null;
  finalImageKey: string | null;
};

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const student = await studentFromRequest(request);
  if (!student) return jsonError("학생 로그인이 필요해요.", 401);

  const artworkId = cleanText((await context.params).id, 80);
  const artwork = await bindings().DB.prepare(`
    SELECT thumbnail_key AS thumbnailKey, final_image_key AS finalImageKey
    FROM artworks
    WHERE id = ? AND student_id = ?
  `).bind(artworkId, student.id).first<ArtworkImage>();

  if (!artwork) return jsonError("내 그림을 찾을 수 없어요.", 404);
  // 목록 화면은 작은 썸네일을 우선한다. 완성 작품 상세만 명시적으로 원본을 요청해
  // iPad 보관함에서 수십 장의 대용량 PNG를 한꺼번에 내려받지 않게 한다.
  const variant = new URL(request.url).searchParams.get("variant");
  const imageKey = variant === "final"
    ? artwork.finalImageKey ?? artwork.thumbnailKey
    : artwork.thumbnailKey ?? artwork.finalImageKey;
  if (!imageKey) return jsonError("아직 그림 미리보기가 없어요.", 404);

  const object = await bindings().ARTWORKS.get(imageKey);
  if (!object) return jsonError("저장된 그림 파일을 찾을 수 없어요.", 404);

  return new Response(await object.arrayBuffer(), {
    headers: {
      "content-type": object.httpMetadata?.contentType ?? "image/png",
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

// Vercel Functions의 요청 본문 한도(4.5MB) 때문에 완성 PNG(≤3.5MB)는 base64 JSON에
// 싣지 못한다. 완성 저장 전에 이 경로로 raw 바이너리를 후보 키로 올리고, 완성 저장
// JSON은 그 키만 참조한다. 후보 객체는 완성 저장이 DB 커밋에 성공하기 전에는 어떤
// 화면에서도 발견되지 않고, 커밋 실패 시 보상 삭제로 회수된다.
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const MAX_FINAL_IMAGE_BYTES = 3_500_000;

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  // 그림 그리기는 유료 요금제 기능으로 잠겨 있다(lib/feature-locks.ts). 읽기(GET)는 그림책·보관함이 쓰므로 그대로 둔다.
  if (DRAWING_LOCKED) return drawingLockedResponse();
  if (!sameOrigin(request)) return jsonError("요청 출처를 확인할 수 없어요.", 403);
  const student = await studentFromRequest(request);
  if (!student) return jsonError("학생 로그인이 필요해요.", 401);
  if (!(await rateLimit(`artwork-image:${student.id}`, 30, 10 * 60))) return jsonError("그림 올리기가 너무 빨라요. 잠깐 기다려 주세요.", 429);

  const url = new URL(request.url);
  if (url.searchParams.get("kind") !== "final") return jsonError("올릴 그림 종류가 올바르지 않아요.");
  const requestId = cleanText(url.searchParams.get("requestId"), 80);
  if (!/^[a-zA-Z0-9_-]{12,80}$/.test(requestId)) return jsonError("저장 요청 번호가 올바르지 않아요.");

  const artworkId = cleanText((await context.params).id, 80);
  const artwork = await bindings().DB.prepare(`SELECT id, status FROM artworks WHERE id = ? AND student_id = ?`).bind(artworkId, student.id).first<{ id: string; status: string }>();
  if (!artwork) return jsonError("내 그림이 아니거나 찾을 수 없어요.", 404);
  if (artwork.status === "complete") return noStoreJson({ error: "완성한 작품은 새 사본으로 이어 그려 주세요.", code: "ARTWORK_COMPLETE" }, { status: 409 });

  if (!(request.headers.get("content-type") ?? "").startsWith("image/png")) return jsonError("PNG 그림만 올릴 수 있어요.", 415);
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length > MAX_FINAL_IMAGE_BYTES) return jsonError("완성 그림 파일이 너무 커요.", 413);
  if (bytes.length < PNG_MAGIC.length || PNG_MAGIC.some((value, index) => bytes[index] !== value)) return jsonError("PNG 그림만 올릴 수 있어요.", 415);

  const key = `students/${student.id}/artworks/${artworkId}/objects/upload-${requestId}-${randomToken(10)}-final.png`;
  await bindings().ARTWORKS.put(key, bytes, {
    httpMetadata: { contentType: "image/png", cacheControl: "private, max-age=300" },
    customMetadata: { studentId: student.id, artworkId, requestId, state: "candidate", kind: "final" },
  });
  return noStoreJson({ ok: true, key }, { status: 201 });
}
