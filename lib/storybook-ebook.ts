import "server-only";
import { randomBytes } from "node:crypto";
import { bindings, ensureSchema } from "@/db/runtime";
import { requireTeacher, studentFromRequest } from "@/lib/security";
import { loadBookImages, type WorkflowBook } from "@/lib/book-workflow";
import { viewPdf } from "@/lib/book-render";
import { validateStorybookDocument } from "@/lib/storybook-model";

// One unguessable link per book. A link never grants access by itself unless the class teacher
// has switched on sharing after recording guardian consent; otherwise only the author (student
// session) and the class teacher can open it. Sequential IDs are never used in the URL.
export const EBOOK_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32}$/;
export const EBOOK_CONSENT_METHODS = ["paper", "in_person", "phone", "school_portal"] as const;
export type EbookConsentMethod = (typeof EBOOK_CONSENT_METHODS)[number];
export type EbookViewer = "owner" | "teacher" | "public";

const newToken = () => randomBytes(24).toString("base64url");

export type EbookLink = { token: string; shared: boolean; sharedAt: string | null; consentMethod: EbookConsentMethod | null };
type LinkRow = { token: string; shared: number; sharedAt: string | null; consentMethod: EbookConsentMethod | null };
const toLink = (row: LinkRow): EbookLink => ({ token: row.token, shared: row.shared === 1, sharedAt: row.sharedAt, consentMethod: row.consentMethod });

export async function ebookLink(storybookId: string): Promise<EbookLink> {
  await ensureSchema();
  const db = bindings().DB;
  await db.prepare(`INSERT OR IGNORE INTO storybook_ebook_links(storybook_id, token) VALUES (?, ?)`).bind(storybookId, newToken()).run();
  const row = await db.prepare(`SELECT token, shared, shared_at AS sharedAt, consent_method AS consentMethod FROM storybook_ebook_links WHERE storybook_id = ?`).bind(storybookId).first<LinkRow>();
  if (!row) throw new Error("ebook 링크를 만들지 못했어요.");
  return toLink(row);
}

/** A new link makes the old one stop working. Sharing is switched off and must be re-confirmed. */
export async function rotateEbookLink(storybookId: string) {
  await ebookLink(storybookId);
  await bindings().DB.prepare(`UPDATE storybook_ebook_links SET token = ?, shared = 0, shared_by_teacher_id = NULL, consent_method = NULL, guardian_consent_at = NULL, shared_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE storybook_id = ?`).bind(newToken(), storybookId).run();
  return ebookLink(storybookId);
}

export async function setEbookSharing(storybookId: string, teacherId: string, consentMethod: EbookConsentMethod | null) {
  await ebookLink(storybookId);
  if (consentMethod) {
    await bindings().DB.prepare(`UPDATE storybook_ebook_links SET shared = 1, shared_by_teacher_id = ?, consent_method = ?, guardian_consent_at = CURRENT_TIMESTAMP, shared_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE storybook_id = ?`).bind(teacherId, consentMethod, storybookId).run();
  } else {
    await bindings().DB.prepare(`UPDATE storybook_ebook_links SET shared = 0, updated_at = CURRENT_TIMESTAMP WHERE storybook_id = ?`).bind(storybookId).run();
  }
  return ebookLink(storybookId);
}

export type EbookBookRow = { token: string; shared: number; storybookId: string; studentId: string; classroomId: string; title: string; documentJson: string; status: "draft" | "complete"; updatedAt: string; teacherId: string };

/** Returns the book and who is looking, or null when this request may not see it. */
export async function ebookAccess(request: Request, token: string): Promise<{ book: EbookBookRow; viewer: EbookViewer } | { book: EbookBookRow; viewer: null; editing: true } | null> {
  if (!EBOOK_TOKEN_PATTERN.test(token)) return null;
  await ensureSchema();
  const book = await bindings().DB.prepare(`SELECT l.token, l.shared, b.id AS storybookId, b.student_id AS studentId, b.classroom_id AS classroomId, b.title, b.document_json AS documentJson, b.status, b.updated_at AS updatedAt, c.teacher_id AS teacherId FROM storybook_ebook_links l JOIN storybooks b ON b.id = l.storybook_id JOIN classrooms c ON c.id = b.classroom_id JOIN student_profiles s ON s.id = b.student_id WHERE l.token = ? AND c.active = 1 AND s.archived_at IS NULL`).bind(token).first<EbookBookRow>();
  if (!book) return null;
  if (request.headers.get("authorization")) {
    const student = await studentFromRequest(request);
    if (student?.id === book.studentId) return { book, viewer: "owner" };
  }
  const teacher = await requireTeacher();
  if (teacher?.id === book.teacherId) return { book, viewer: "teacher" };
  if (book.shared === 1) return book.status === "complete" ? { book, viewer: "public" } : { book, viewer: null, editing: true };
  return null;
}

export function ebookDocument(book: EbookBookRow) {
  try { return validateStorybookDocument(JSON.parse(book.documentJson)); } catch { return null; }
}

export async function ebookPdf(book: EbookBookRow) {
  const workflow: WorkflowBook = { id: book.storybookId, classroomId: book.classroomId, studentId: book.studentId, revision: 0, documentJson: book.documentJson, title: book.title, grade: null, classNumber: null, seatNumber: null, realName: null };
  const { document, images } = await loadBookImages(workflow, 1800);
  return viewPdf(images, document.format, book.title);
}

/** Download name: title only — never the child's name. */
export function ebookPdfFilename(title: string) {
  const safe = title.normalize("NFC").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/g, "").slice(0, 60) || "그림책";
  return `${safe}.pdf`;
}
