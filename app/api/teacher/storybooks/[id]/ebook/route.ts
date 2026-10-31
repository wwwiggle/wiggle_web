import { bindings } from "@/db/runtime";
import { cleanText, jsonError, noStoreJson, rateLimit, requireTeacher, sameOrigin } from "@/lib/security";
import { EBOOK_CONSENT_METHODS, ebookLink, rotateEbookLink, setEbookSharing, type EbookConsentMethod } from "@/lib/storybook-ebook";

// Class teacher controls for one book's ebook link:
//   link    – get or create the link
//   share   – allow anyone with the link (requires guardian consent attestation)
//   unshare – back to author + teacher only
//   rotate  – issue a new link; the old one stops working and sharing is switched off
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!sameOrigin(request)) return jsonError("요청 출처를 확인할 수 없어요.", 403);
  const teacher = await requireTeacher();
  if (!teacher) return jsonError("교사 로그인이 필요해요.", 401);
  if (!(await rateLimit(`teacher-write:${teacher.id}`, 120, 60))) return jsonError("요청이 너무 빨라요. 잠깐 기다려 주세요.", 429);
  const storybookId = cleanText((await context.params).id, 80);
  const book = await bindings().DB.prepare(`SELECT b.id, b.status FROM storybooks b JOIN classrooms c ON c.id = b.classroom_id JOIN student_profiles s ON s.id = b.student_id WHERE b.id = ? AND c.teacher_id = ? AND c.active = 1 AND s.archived_at IS NULL`).bind(storybookId, teacher.id).first<{ id: string; status: string }>();
  if (!book) return jsonError("이 학급의 그림책을 찾을 수 없어요.", 404);
  const payload = await request.json().catch(() => ({})) as Record<string, unknown>;
  const action = cleanText(payload.action, 20) || "link";
  let link;
  if (action === "link") link = await ebookLink(book.id);
  else if (action === "rotate") link = await rotateEbookLink(book.id);
  else if (action === "unshare") link = await setEbookSharing(book.id, teacher.id, null);
  else if (action === "share") {
    const method = cleanText(payload.consentMethod, 20) as EbookConsentMethod;
    if (payload.guardianConsent !== true || !EBOOK_CONSENT_METHODS.includes(method)) return jsonError("보호자 동의를 받은 방법을 고르고, 동의를 확인했다고 체크해 주세요.");
    if (book.status !== "complete") return jsonError("완성한 그림책만 링크로 공유할 수 있어요.");
    link = await setEbookSharing(book.id, teacher.id, method);
  } else return jsonError("알 수 없는 요청이에요.");
  return noStoreJson({ token: link.token, path: `/ebook/${link.token}`, shared: link.shared, sharedAt: link.sharedAt, consentMethod: link.consentMethod });
}
