"use client";
import { useState } from "react";

const byName = new Intl.Collator("ko", { numeric: true });

/**
 * 그림책 공방(2026-11-04): 아이들 그림 사진·스캔 여러 장으로 새 그림책을 만든다. 파일 이름 순서(1, 2, … 10)가 쪽 순서이고,
 * 만든 뒤 편집기에서 순서를 바꾸고 글·그림을 더한다. 지은이 이름은 학급 명단에 없으면 더해진다(lib/studio-authors.ts).
 */
export function TeacherPhotoImport({ classroomId, onImported }: { classroomId: string; onImported: () => Promise<unknown> }) {
  const [files, setFiles] = useState<File[]>([]), [title, setTitle] = useState(""), [authorName, setAuthorName] = useState("");
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(""), [error, setError] = useState(""), [bookId, setBookId] = useState("");
  async function run() {
    setBusy(true); setError(""); setBookId("");
    try {
      const { importBookImages } = await import("@/lib/import-book-pdf");
      const id = await importBookImages(files, classroomId, { authorName }, title, setMessage);
      setBookId(id); setMessage(`${files.length}쪽 그림책을 만들었어요. 편집기에서 순서·글·표지를 다듬어 주세요.`); setFiles([]);
      await onImported();
    } catch (e) { setError(e instanceof Error ? e.message : "사진을 가져오지 못했어요."); setMessage(""); }
    finally { setBusy(false); }
  }
  return <section className="book-panel pdf-import-panel" aria-labelledby="photo-import-title">
    <div className="book-section-heading"><div><p className="eyebrow">사진·스캔으로 만들기</p><h2 id="photo-import-title">그림 사진으로 새 그림책</h2><p>아이들 그림을 찍거나 스캔한 파일을 한 번에 골라요. 한 장이 한 쪽이 되고, 파일 이름 순서대로 들어가요.</p></div>
      <label className="button secondary">사진·스캔 선택<input className="sr-only" type="file" accept="image/*" multiple disabled={busy} onChange={(e) => {
        const picked = Array.from(e.target.files ?? []).filter((file) => file.type.startsWith("image/")); e.target.value = "";
        setFiles((list) => [...list, ...picked].sort((a, b) => byName.compare(a.name, b.name))); setBookId(""); setMessage("");
      }} /></label></div>
    {!!files.length && <>
      <p className="book-muted">{files.length}장 · {files.slice(0, 6).map((file) => file.name).join(", ")}{files.length > 6 ? ` 외 ${files.length - 6}장` : ""}</p>
      <div className="pdf-import-row"><label className="book-field">지은이<input maxLength={20} placeholder="예: 김하늘" disabled={busy} value={authorName} onChange={(e) => setAuthorName(e.target.value)} /></label><label className="book-field">그림책 제목<input maxLength={60} disabled={busy} value={title} onChange={(e) => setTitle(e.target.value)} /></label>{!busy && <button type="button" className="small-button" onClick={() => setFiles([])}>선택 비우기</button>}</div>
      <button type="button" className="button primary" disabled={busy || !authorName.trim() || !title.trim()} onClick={() => void run()}>{busy ? "그림책 만드는 중…" : `${files.length}장으로 그림책 만들기`}</button>
    </>}
    {message && <p role="status">{message}</p>}{busy && <p>이 화면을 열어 두세요. 한 장씩 올려요.</p>}
    {error && <p className="error-box" role="alert">{error}</p>}
    {bookId && <a className="button primary" href={`/teacher/class/${classroomId}/books/${bookId}/edit`}>그림책 편집하기 →</a>}
  </section>;
}
