import { bindings } from "@/db/runtime";
import { familyCookieToken, familyJson, resolveFamilySession } from "@/lib/family-sharing";
import { buildWeeklyGrowthReport } from "@/lib/growth-reports";
import { bytesToDataUrl, isImageMimeType } from "@/lib/image-data";
import { validateDrawDocument } from "@/lib/drawing-model";
import { clientIp, rateLimit, sha256 } from "@/lib/security";

function clientAddress(request: Request) {
  return clientIp(request);
}

async function imageDataUrl(key: string) {
  const object = await bindings().ARTWORKS.get(key);
  if (!object || object.size > 3_500_000) return null;
  const bytes = new Uint8Array(await object.arrayBuffer());
  // 바이트 단위 문자열 결합 대신 청크 변환을 쓴다. 가족 화면은 최대 12장을 한 번에 싣는다.
  // 저장된 형식을 그대로 쓴다. 하드코딩해 두면 언젠가 완성본 형식을 바꿀 때 여기만 조용히 깨진다
  // (2026-09-26 썸네일을 WebP로 옮기며 같은 종류의 자리를 두 곳 더 찾았다). 지금 완성본은 PNG다.
  const stored = object.httpMetadata?.contentType;
  return bytesToDataUrl(bytes, isImageMimeType(stored) ? stored : "image/png");
}

function publicTimelapseOps(serialized: string) {
  try {
    const document = validateDrawDocument(JSON.parse(serialized));
    if (!document) return [];
    return document.ops.map((operation) => ({
      type: operation.type,
      tool: operation.tool,
      color: operation.color,
      width: operation.width,
      points: operation.points,
      smoothed: operation.smoothed,
      squareEraser: operation.squareEraser,
      shape: operation.shape,
      filled: operation.filled,
      sticker: operation.sticker,
      textObjectId: operation.textObjectId,
      objectId: operation.objectId,
      text: operation.text,
      textKind: operation.textKind,
      fontSize: operation.fontSize,
      deleted: operation.deleted,
    }));
  } catch {
    return [];
  }
}

export async function GET(request: Request) {
  const sessionToken = familyCookieToken(request);
  const limiterKey = await sha256(`${clientAddress(request)}:${sessionToken.slice(0, 12)}`);
  if (!(await rateLimit(`family-session:${limiterKey}`, 45, 60))) return familyJson({ error: "잠시 뒤 다시 확인해 주세요." }, { status: 429 });
  const share = await resolveFamilySession(bindings().DB, sessionToken);
  if (!share) return familyJson({ error: "가족 공유 세션이 만료되었거나 취소되었어요." }, { status: 404 });
  const images = await Promise.all(share.artworks.map((artwork) => imageDataUrl(artwork.finalImageKey)));
  if (images.some((image) => !image)) return familyJson({ error: "공유 작품을 준비하지 못했어요." }, { status: 404 });
  const report = await buildWeeklyGrowthReport(bindings().DB, {
    linkId: share.linkId,
    studentId: share.studentId,
    reportStartAt: share.reportStartAt,
    reportEndAt: share.reportEndAt,
    sensitiveValues: share.sensitiveValues,
  });
  return familyJson({
    family: { animal: share.animal, scope: share.scope, expiresAt: share.expiresAt },
    artworks: share.artworks.map((artwork, index) => ({
      position: artwork.position + 1,
      anchor: `artwork-${artwork.position + 1}`,
      imageDataUrl: images[index],
      timelapseOps: publicTimelapseOps(artwork.opsJson),
    })),
    report,
  });
}
