"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowRight } from "lucide-react";
import type { Student, WorkspaceArtwork } from "./TeacherApp";
import { DRAWING_LOCKED } from "@/lib/feature-locks";
import { PaidLock } from "./PaidLock";
import "./TeacherWorkArchive.css";

type Artwork = WorkspaceArtwork & { studentId: string; nickname: string; realName: string | null; seatNumber: number | null; completedAt: string | null };
type Archive = { artworks: Artwork[]; total: number; hasMore: boolean; nextCursor: string | null };
type Book = { id: string; title: string; studentId: string; nickname: string; completedAt: string; pageCount: number; cover: { background: string; backgroundAssetId: string | null; imageAssetId: string | null; text: string } };
function dateLabel(value: string) { return new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`).toLocaleDateString("ko-KR"); }

export function TeacherWorkArchive({ classroomId, students, onOpenArtwork }: { classroomId: string; students: Student[]; onOpenArtwork: (studentId: string, artwork: WorkspaceArtwork) => void }) {
  const [studentId, setStudentId] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [archive, setArchive] = useState<Archive | null>(null);
  const [books, setBooks] = useState<Book[]>([]);
  const [booksLoading, setBooksLoading] = useState(true);
  const [booksError, setBooksError] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  const request = useRef(0);
  const activeController = useRef<AbortController | null>(null);
  function query(cursor?: string) {
    const params = new URLSearchParams({ classroomId, artworks: "1", limit: expanded ? "24" : "4" });
    if (studentId) params.set("studentId", studentId);
    if (cursor) params.set("cursor", cursor);
    return `/api/teacher?${params}`;
  }
  const requestUrl = query();
  useEffect(() => {
    // 그림은 유료 요금제 기능이라(2026-11-02 사용자 지시) 잠겨 있으면 그림 목록을 아예 부르지 않는다 — 화면도 빨라진다.
    if (DRAWING_LOCKED) { setLoading(false); return; }
    const controller = new AbortController(); activeController.current?.abort(); activeController.current = controller;
    const id = ++request.current;
    setLoading(true); setError(""); setArchive(null);
    fetch(requestUrl, { cache: "no-store", signal: controller.signal }).then(async (response) => { const data = await response.json() as Archive & { error?: string }; if (!response.ok) throw new Error(data.error ?? "작품을 불러오지 못했어요."); if (id === request.current) setArchive(data); }).catch((cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "작품을 불러오지 못했어요."); }).finally(() => { if (id === request.current) setLoading(false); });
    return () => { controller.abort(); };
  }, [requestUrl, retry]);
  useEffect(() => {
    const controller = new AbortController(); setBooksLoading(true); setBooksError("");
    fetch(`/api/teacher/storybooks?classroomId=${encodeURIComponent(classroomId)}`, { cache: "no-store", signal: controller.signal }).then(async (response) => { const data = await response.json() as { storybooks?: Book[]; error?: string }; if (!response.ok) throw new Error(data.error ?? "그림책을 불러오지 못했어요."); setBooks(data.storybooks ?? []); }).catch((cause) => { if (!controller.signal.aborted) setBooksError(cause instanceof Error ? cause.message : "그림책을 불러오지 못했어요."); }).finally(() => { if (!controller.signal.aborted) setBooksLoading(false); });
    return () => controller.abort();
  }, [classroomId, retry]);
  async function more() {
    if (!archive?.nextCursor || loading) return;
    const id = ++request.current; const controller = new AbortController(); activeController.current = controller; setLoading(true); setError("");
    try { const response = await fetch(query(archive.nextCursor), { cache: "no-store", signal: controller.signal }); const data = await response.json() as Archive & { error?: string }; if (!response.ok) throw new Error(data.error ?? "이전 그림을 불러오지 못했어요."); if (id === request.current) setArchive((previous) => ({ ...data, artworks: [...(previous?.artworks ?? []), ...data.artworks.filter((item: Artwork) => !previous?.artworks.some((prior) => prior.id === item.id))] })); }
    catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "이전 그림을 불러오지 못했어요."); }
    finally { if (id === request.current) setLoading(false); }
  }
  const filteredBooks = books.filter((book) => !studentId || book.studentId === studentId);
  return <section className="twa" aria-label="작품과 그림책">
    <header className="twa-heading"><div><h2>작품 · 그림책</h2><p>학생들이 그린 그림과 완성한 책을 모아 봐요.</p></div><label><span className="sr-only">학생으로 작품과 그림책 거르기</span><select value={studentId} onChange={(event) => setStudentId(event.target.value)}><option value="">모든 학생</option>{students.map((student) => <option key={student.id} value={student.id}>{student.seatNumber} {student.realName ?? student.nickname}</option>)}</select></label></header>
    {DRAWING_LOCKED ? <><div className="twa-section-heading"><h3>최근 그림</h3><div><PaidLock className="twa-locked-button" message="학생 그림 모아 보기는 유료 요금제 기능이에요.">전체 그림 보기<ArrowRight size={16} /></PaidLock></div></div>
      <PaidLock className="twa-locked-panel" message="학생 그림 모아 보기는 유료 요금제 기능이에요."><span>학생 그림 모아 보기</span></PaidLock></> : <>
    <div className="twa-section-heading"><h3>{expanded ? "모든 그림" : "최근 그림"}{archive && <small>{archive.total}개</small>}</h3><div><button type="button" onClick={() => setExpanded((value) => !value)}>{expanded ? "최근 그림만 보기" : "전체 그림 보기"}<ArrowRight size={16} /></button></div></div>
    {error && <p className="tcw-error" role="alert">{error}<button onClick={() => setRetry((value) => value + 1)}>다시 불러오기</button></p>}
    {loading && !archive && <p className="twa-loading" role="status">그림을 모으는 중…</p>}
    {archive?.artworks.length ? <div className="twa-grid">{archive.artworks.map((artwork) => <article key={artwork.id}><button className="tcw-artwork" onClick={() => onOpenArtwork(artwork.studentId, artwork)} aria-label={`${artwork.realName ?? artwork.nickname}의 ${artwork.title} 크게 보기`}>{artwork.thumbnail ? <img src={artwork.thumbnail} alt={artwork.title} /> : <span>저장된 미리보기가 없어요</span>}</button><div className="twa-artwork-title"><h4>{artwork.title}</h4><span className={`tcw-status ${artwork.status === "complete" ? "is-complete" : ""}`}>{artwork.status === "complete" ? "완성" : "그리는 중"}</span></div><p>{artwork.seatNumber} {artwork.realName ?? artwork.nickname}</p><small>{dateLabel(artwork.updatedAt)}</small></article>)}</div> : !loading && !error && <div className="tcw-empty"><h3>아직 저장된 그림이 없어요</h3><p>학생이 그림을 저장하면 여기에 모여요.</p></div>}
    {expanded && archive?.hasMore && <div className="twa-more"><button disabled={loading} onClick={() => void more()}>{loading ? "불러오는 중…" : "이전 그림 더 보기"}</button></div>}
    </>}
    <section className="twa-books"><div className="twa-section-heading"><h3>완성 그림책 <small>{filteredBooks.length}권</small></h3><div className="twa-book-links"><a href={`/teacher/class/${classroomId}/books/ebooks`} className="tcw-link-button tcw-primary">📖 ebook</a><a href={`/teacher/class/${classroomId}/books`} className="twa-text-link">전체 그림책 보기<ArrowRight size={16} /></a></div></div>
      {booksError && <p className="tcw-error" role="alert">{booksError}<button onClick={() => setRetry((value) => value + 1)}>다시 불러오기</button></p>}
      {booksLoading ? <p className="twa-loading">그림책을 모으는 중…</p> : filteredBooks.length ? <div className="twa-book-grid">{filteredBooks.slice(0, 3).map((book) => { const asset = book.cover.imageAssetId ?? book.cover.backgroundAssetId; const student = students.find((entry) => entry.id === book.studentId); return <article key={book.id}><a className="twa-cover" style={{ backgroundColor: book.cover.background }} href={`/teacher/class/${classroomId}/books/${book.id}`} aria-label={`${book.title} 책 열기`}>{asset && <img src={`/api/teacher/storybooks/${book.id}/assets/${asset}`} alt="" />}<span>{book.cover.text || book.title}</span></a><div><h4>{book.title}</h4><p>{student?.realName ?? book.nickname} · {book.pageCount}쪽</p><small>{dateLabel(book.completedAt)} 완성</small><a className="tcw-link-button" href={`/teacher/class/${classroomId}/books/${book.id}`}>책 열기<ArrowRight size={16} /></a></div></article>; })}</div> : !booksError && <div className="tcw-empty"><h3>아직 완성한 그림책이 없어요</h3><p>학생이 그림책 작업실에서 완성하면 여기에 나타나요.</p></div>}
    </section>
  </section>;
}
