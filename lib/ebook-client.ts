import { ebookFetch } from "@/lib/storybook-editor-fetch";

export type EbookLinkResponse = { token: string; path: string; shared: boolean; sharedAt?: string | null; consentMethod?: string | null };
export const EBOOK_CONSENT_LABELS: Record<string, string> = { paper: "가정통신문·서면 동의서", in_person: "직접 만나서", phone: "전화", school_portal: "학교 알림 앱·누리집" };

/** Students ask for their own book's link; teachers use the class route, which also controls sharing. */
export async function requestEbookLink(bookId: string, options: { teacher?: boolean; action?: "link" | "share" | "unshare" | "rotate"; consentMethod?: string; guardianConsent?: boolean } = {}) {
  const path = options.teacher ? `/api/teacher/storybooks/${encodeURIComponent(bookId)}/ebook` : `/api/storybooks/${encodeURIComponent(bookId)}/ebook`;
  const response = await ebookFetch(path, { method: "POST", body: JSON.stringify({ action: options.action ?? "link", consentMethod: options.consentMethod, guardianConsent: options.guardianConsent }) });
  const data = await response.json().catch(() => ({})) as EbookLinkResponse & { error?: string };
  if (!response.ok || !data.token) throw new Error(data.error ?? "ebook 링크를 만들지 못했어요.");
  return data;
}

export function absoluteEbookUrl(path: string) {
  return new URL(path, window.location.origin).href;
}

export async function copyEbookLink(path: string) {
  const url = absoluteEbookUrl(path);
  try { await navigator.clipboard.writeText(url); return true; } catch { window.prompt("이 주소를 복사해 주세요.", url); return false; }
}

/** Square PDF made on the server; downloaded as a file so no browser print header/footer is added. */
export async function downloadEbookPdf(token: string, title: string) {
  const response = await ebookFetch(`/api/ebook/${encodeURIComponent(token)}/pdf`);
  if (!response.ok) {
    const data = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(data.error ?? "PDF를 만들지 못했어요.");
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = window.document.createElement("a");
  anchor.href = url; anchor.download = `${(title || "그림책").replace(/[<>:"/\|?*\u0000-\u001f]/g, "_").slice(0, 60)}.pdf`;
  window.document.body.appendChild(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
