import { activeProfile, studentFetch } from "@/lib/client-session";

/** ebook routes accept the author's student session, the teacher cookie, or (when shared) nothing at all. */
export function ebookFetch(path: string, init: RequestInit = {}) {
  const profile = activeProfile();
  if (profile) return studentFetch(path, init, profile);
  const headers = new Headers(init.headers);
  if (typeof init.body === "string" && !headers.has("content-type")) headers.set("content-type", "application/json");
  return fetch(path, { ...init, headers, cache: "no-store" });
}

export function storybookEditorFetch(path: string, init: RequestInit = {}) {
  if (path.startsWith("/api/ebook/")) return ebookFetch(path, init);
  if (!path.startsWith("/api/teacher/")) return studentFetch(path, init);
  const headers = new Headers(init.headers);
  if (typeof init.body === "string" && !headers.has("content-type")) headers.set("content-type", "application/json");
  return fetch(path, { ...init, headers, cache: "no-store" });
}
