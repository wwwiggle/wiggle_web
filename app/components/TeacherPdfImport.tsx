"use client";
import { useCallback, useEffect, useState } from "react";
import { teacherRequest } from "./book-workflow-client";
type Student = { id: string; seatNumber: number; realName: string };
type Draft = { id: string; title: string; seatNumber: number; realName: string };
type Upload = { key: string; file: File; studentId: string; authorName: string; title: string; status: string; bookId?: string; error?: string };
/** studio: 그림책 공방(lib/product-mode.ts) — 명단에서 고르는 대신 지은이 이름을 적는다(없으면 명단에 더해진다). */
export function TeacherPdfImport({ classroomId, onImported, studio = false }: { classroomId: string; onImported: () => Promise<unknown>; studio?: boolean }) {
  const [students, setStudents] = useState<Student[]>([]), [drafts, setDrafts] = useState<Draft[]>([]);
  const [uploads, setUploads] = useState<Upload[]>([]), [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  const load = useCallback(async () => {
    const data = await teacherRequest<{ students: Student[]; drafts: Draft[] }>(`/api/teacher/book-import?classroomId=${classroomId}`);
    setStudents(data.students); setDrafts(data.drafts);
  }, [classroomId]);
  useEffect(() => { void load().catch((e) => setMessage(e.message)); }, [load]);
  async function run() {
    setBusy(true);
    try {
      const { importBookPdf } = await import("@/lib/import-book-pdf");
      for (const upload of uploads.filter((u) => u.status !== "complete")) {
        try {
          setUploads((list) => list.map((u) => u.key === upload.key ? { ...u, status: "processing", error: undefined } : u));
          const bookId = await importBookPdf(upload.file, classroomId, studio ? { authorName: upload.authorName } : { studentId: upload.studentId }, upload.title, setMessage);
          setUploads((list) => list.map((u) => u.key === upload.key ? { ...u, status: "complete", bookId } : u));
        } catch (e) {
          setUploads((list) => list.map((u) => u.key === upload.key ? { ...u, status: "failed", error: e instanceof Error ? e.message : "가져오기 실패" } : u));
        }
      }
      setMessage("가져오기가 끝났어요. 책별 결과를 확인해 주세요.");
      await onImported(); await load();
    } catch (e) { setMessage(e instanceof Error ? e.message : "PDF를 읽지 못했어요."); }
    finally { setBusy(false); }
  }
  return <section className="book-panel pdf-import-panel">
    <div className="book-section-heading"><div><p className="eyebrow">PDF로 만든 그림책도 함께</p><h2>PDF 그림책 가져오기</h2>{studio ? <p>완성한 그림책 PDF를 올리면 쪽마다 그림으로 들어와요. 지은이와 제목을 적으면 바로 편집하고 주문할 수 있어요.</p> : <><p>학생이 그림책을 완성하지 않아도, 선생님이 준비한 PDF를 가져와 그림책 제작을 요청할 수 있어요.</p><p>학생과 제목을 지정하면 피드백·인쇄 주문·그림책 편집에 사용할 수 있어요.</p></>}</div><label className="button secondary">PDF 파일 선택<input className="sr-only" type="file" accept="application/pdf,.pdf" multiple disabled={busy || (!studio && !students.length)} onChange={(e) => {
      const files = Array.from(e.target.files ?? []); e.target.value = "";
      if (files.length + uploads.length > 50) { setMessage("한 번에 최대 50권을 선택해 주세요."); return; }
      setUploads((list) => [...list, ...files.map((file) => ({ key: crypto.randomUUID(), file, studentId: "", authorName: "", title: file.name.replace(/\.pdf$/i, "").slice(0, 60), status: "pending" }))]);
    }} /></label></div>
    <p className="book-muted">파일당 300MB. 가져오기에는 쪽 수 제한이 없으며, 인쇄 주문에는 별도의 제작 규격(내지 24~130쪽, 2쪽 단위)이 적용됩니다. 모든 쪽을 비율 유지·여백 포함 이미지로 가져옵니다. 원본 PDF 글자는 개별 편집되지 않습니다. 가져온 뒤 이야기·그림을 추가하거나 배경을 교체하고, 쪽을 추가·삭제·재배열할 수 있어요. 원본 PDF 파일은 별도로 보관해 주세요.</p>
    {!studio && !students.length && <p><a href={`/teacher/class/${classroomId}`}>수업실 명단에 학생 번호·이름을 먼저 등록해 주세요.</a></p>}
    {uploads.map((u) => <div className="pdf-import-row" key={u.key}><b>{u.file.name}</b>{studio ? <label className="book-field">지은이<input maxLength={20} list={`authors-${classroomId}`} placeholder="예: 김하늘" disabled={busy || u.status === "complete"} value={u.authorName} onChange={(e) => setUploads((list) => list.map((v) => v.key === u.key ? { ...v, authorName: e.target.value } : v))} /></label> : <label className="book-field">학생<select disabled={busy || u.status === "complete"} value={u.studentId} onChange={(e) => setUploads((list) => list.map((v) => v.key === u.key ? { ...v, studentId: e.target.value } : v))}><option value="">학생을 선택해 주세요</option>{students.map((s) => <option key={s.id} value={s.id}>{s.seatNumber}번 {s.realName}</option>)}</select></label>}<label className="book-field">그림책 제목<input maxLength={60} disabled={busy || u.status === "complete"} value={u.title} onChange={(e) => setUploads((list) => list.map((v) => v.key === u.key ? { ...v, title: e.target.value } : v))} /></label><span>{u.status === "complete" ? "가져오기 완료" : u.status === "failed" ? "가져오기 실패" : u.status === "processing" ? "가져오는 중" : "대기"}</span>{u.bookId && <a className="small-button" href={`/teacher/class/${classroomId}/books/${u.bookId}/edit`}>그림책 수정</a>}{!busy && <button className="small-button" onClick={() => setUploads((list) => list.filter((v) => v.key !== u.key))}>목록에서 빼기</button>}{u.error && <p className="error-box" role="alert">{u.error}</p>}</div>)}
    {!!uploads.length && <button className="button primary" disabled={busy || uploads.every((u) => u.status === "complete") || uploads.some((u) => !(studio ? u.authorName.trim() : u.studentId) || !u.title.trim())} onClick={() => void run()}>{busy ? "PDF 가져오는 중…" : "선택한 PDF 가져오기"}</button>}
    {studio && <datalist id={`authors-${classroomId}`}>{students.map((s) => <option key={s.id} value={s.realName} />)}</datalist>}
    {message && <p role="status">{message}</p>}{busy && <p>이 화면을 열어 두세요. 파일별로 순서대로 처리합니다.</p>}
    {!!drafts.length && <details><summary>편집 중인 책 · {drafts.length}권</summary><p>수정 또는 중단된 가져오기 내용입니다. 편집기에서 확인 후 완성하기를 눌러 주세요.</p><ul className="book-draft-list">{drafts.map((d) => <li key={d.id}><span>{d.seatNumber}번 {d.realName} · {d.title || "제목 짓는 중"}</span><a className="small-button" href={`/teacher/class/${classroomId}/books/${d.id}/edit`}>이어서 수정</a></li>)}</ul></details>}
  </section>;
}
