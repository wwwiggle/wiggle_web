import { downloadResponse } from "@/lib/book-render-shared";
import { jsonError, rateLimit } from "@/lib/security";
import { ebookAccess, ebookPdf, ebookPdfFilename } from "@/lib/storybook-ebook";

export const maxDuration = 120;

// Square (243 × 248mm) download generated on the server — no browser print headers, footers or page numbers.
// Only the author and the class teacher may download; a shared link is view-only.
export async function GET(request: Request, context: { params: Promise<{ token: string }> }) {
  const access = await ebookAccess(request, (await context.params).token);
  if (!access || access.viewer === null || access.viewer === "public") return jsonError("PDF를 받을 수 없는 그림책이에요.", 404);
  if (!(await rateLimit(`ebook-pdf:${access.book.storybookId}`, 6, 600))) return jsonError("PDF를 너무 자주 만들고 있어요. 잠시 뒤에 다시 받아 주세요.", 429);
  try {
    const bytes = await ebookPdf(access.book);
    return downloadResponse(bytes, ebookPdfFilename(access.book.title));
  } catch (error) {
    return jsonError(error instanceof Error && /[가-힣]/.test(error.message) ? error.message : "PDF를 만들지 못했어요. 잠시 뒤에 다시 받아 주세요.", 500);
  }
}
