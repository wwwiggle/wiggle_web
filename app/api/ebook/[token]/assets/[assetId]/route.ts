import { bindings } from "@/db/runtime";
import { cleanText, clientIp, jsonError, rateLimit } from "@/lib/security";
import { ebookAccess } from "@/lib/storybook-ebook";

export async function GET(request: Request, context: { params: Promise<{ token: string; assetId: string }> }) {
  if (!(await rateLimit(`ebook-asset:${clientIp(request)}`, 900, 60))) return jsonError("잠시 뒤에 다시 열어 주세요.", 429);
  const params = await context.params;
  const access = await ebookAccess(request, params.token);
  if (!access || access.viewer === null) return jsonError("볼 수 없는 그림이에요.", 404);
  const assetId = cleanText(params.assetId, 80);
  const asset = await bindings().DB.prepare(`SELECT object_key AS objectKey, content_type AS contentType FROM storybook_assets WHERE id = ? AND storybook_id = ? AND student_id = ?`).bind(assetId, access.book.storybookId, access.book.studentId).first<{ objectKey: string; contentType: string }>();
  if (!asset) return jsonError("볼 수 없는 그림이에요.", 404);
  const object = await bindings().ARTWORKS.get(asset.objectKey);
  if (!object) return jsonError("저장된 이미지 파일을 찾을 수 없어요.", 404);
  return new Response(await object.arrayBuffer(), {
    headers: {
      "content-type": object.httpMetadata?.contentType ?? asset.contentType,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
