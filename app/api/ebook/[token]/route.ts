import { clientIp, jsonError, noStoreJson, rateLimit } from "@/lib/security";
import { ebookAccess, ebookDocument, ebookLink } from "@/lib/storybook-ebook";

export async function GET(request: Request, context: { params: Promise<{ token: string }> }) {
  if (!(await rateLimit(`ebook-view:${clientIp(request)}`, 120, 60))) return jsonError("잠시 뒤에 다시 열어 주세요.", 429);
  const token = (await context.params).token;
  const access = await ebookAccess(request, token);
  // Unknown token and "not allowed" look the same, so a link cannot be probed.
  if (!access) return jsonError("볼 수 없는 그림책이에요. 링크를 확인하거나 선생님께 물어봐 주세요.", 404);
  if (access.viewer === null) return jsonError("작가가 그림책을 고치는 중이에요. 다 고치면 다시 볼 수 있어요.", 409);
  const document = ebookDocument(access.book);
  if (!document) return jsonError("저장된 그림책을 안전하게 펼칠 수 없어요.", 422);
  const { book, viewer } = access;
  // The public view carries no names, school or class — only the book itself.
  const share = viewer === "public" ? undefined : await ebookLink(book.storybookId);
  return noStoreJson({
    viewer,
    storybook: { title: book.title, status: book.status, updatedAt: book.updatedAt, document, ...(viewer === "public" ? {} : { id: book.storybookId }) },
    ...(share ? { share: { shared: share.shared, sharedAt: share.sharedAt, consentMethod: share.consentMethod } } : {}),
  });
}
