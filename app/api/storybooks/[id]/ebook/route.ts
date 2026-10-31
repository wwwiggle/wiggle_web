import { cleanText, jsonError, noStoreJson, rateLimit, sameOrigin, studentFromRequest } from "@/lib/security";
import { ownedStorybook } from "@/lib/storybook-store";
import { ebookLink } from "@/lib/storybook-ebook";

// The author gets (or creates) the book's ebook link. Turning on sharing beyond the author and
// the class teacher is a teacher-only action that records guardian consent.
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!sameOrigin(request)) return jsonError("요청 출처를 확인할 수 없어요.", 403);
  const student = await studentFromRequest(request);
  if (!student) return jsonError("학생 로그인이 필요해요.", 401);
  if (!(await rateLimit(`ebook-link:${student.id}`, 60, 60))) return jsonError("잠시 뒤에 다시 눌러 주세요.", 429);
  const book = await ownedStorybook(cleanText((await context.params).id, 80), student.id);
  if (!book) return jsonError("내 그림책이 아니거나 찾을 수 없어요.", 404);
  const link = await ebookLink(book.id);
  return noStoreJson({ token: link.token, path: `/ebook/${link.token}`, shared: link.shared });
}
