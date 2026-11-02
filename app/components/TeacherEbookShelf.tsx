"use client";

// 우리 반 ebook 서재(2026-11-02 사용자 지시): ebook 단추 하나로 학생들이 완성한 그림책을 모두 꽂아 보여 주고,
// 한 권을 누르면 그 자리에서 두 쪽 펼침 책으로 열린다. 닫으면 서재로 돌아온다(주소의 ?book= 으로 뒤로 가기도 된다).
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { requestEbookLink } from "@/lib/ebook-client";
import { EbookViewer } from "./EbookViewer";
import { Logo } from "./Logo";
import { teacherRequest, type CompletedBook } from "./book-workflow-client";
import "./teacher-ebook-shelf.css";

const studentLabel = (book: CompletedBook) => `${book.seatNumber ? `${book.seatNumber}번 ` : ""}${book.realName || book.nickname}`;

export function TeacherEbookShelf({ classroomId }: { classroomId: string }) {
  const [books, setBooks] = useState<CompletedBook[] | null>(null);
  const [className, setClassName] = useState("");
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<{ bookId: string; token: string } | null>(null);
  const [opening, setOpening] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    teacherRequest<{ classroom: { displayName: string }; storybooks: CompletedBook[] }>(`/api/teacher/storybooks?classroomId=${encodeURIComponent(classroomId)}`, { signal: controller.signal })
      .then(data => { setBooks(data.storybooks); setClassName(data.classroom.displayName); })
      .catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "그림책을 불러오지 못했어요."); });
    return () => controller.abort();
  }, [classroomId]);

  const openBook = useCallback(async (bookId: string, push = true) => {
    setOpening(bookId); setError("");
    try {
      const link = await requestEbookLink(bookId, { teacher: true });
      setOpen({ bookId, token: link.token });
      if (push) { const url = new URL(location.href); url.searchParams.set("book", bookId); history.pushState({ book: bookId }, "", url); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "그림책을 열지 못했어요."); }
    finally { setOpening(""); }
  }, []);

  const close = useCallback(() => {
    if (new URL(location.href).searchParams.has("book")) history.back();
    else setOpen(null);
  }, []);

  // 주소에 ?book=이 있으면 그 책을 바로 연다(책 상세 화면의 ebook 단추). 뒤로 가기는 서재로 돌아온다.
  const openRef = useRef(open);
  useEffect(() => { openRef.current = open; }, [open]);
  useEffect(() => {
    const sync = () => {
      const bookId = new URL(location.href).searchParams.get("book");
      if (!bookId) { setOpen(null); return; }
      if (openRef.current?.bookId !== bookId) void openBook(bookId, false);
    };
    sync();
    window.addEventListener("popstate", sync); return () => window.removeEventListener("popstate", sync);
  }, [openBook]);

  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow; document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previous; };
  }, [open]);

  const sorted = useMemo(() => (books ?? []).slice().sort((a, b) => (a.seatNumber ?? Infinity) - (b.seatNumber ?? Infinity) || (a.completedAt < b.completedAt ? 1 : -1)), [books]);
  const filtered = sorted.filter(book => !query.trim() || `${book.title} ${studentLabel(book)}`.includes(query.trim()));
  // 한 칸에 6권씩 꽂아 선반처럼 보인다(좁은 화면은 CSS가 줄을 바꾼다).
  const students = new Set(sorted.map(book => book.studentId)).size;

  return <main className="ebook-shelf-page">
    <header className="ebook-shelf-header"><Logo /><a className="small-button" href={`/teacher/class/${classroomId}/books`}>← 그림책 목록</a><a className="small-button" href={`/teacher/class/${classroomId}?view=archive`}>수업실</a></header>
    <section className="ebook-shelf-hero">
      <div><p className="eyebrow">{className || "우리 반"} · ebook 서재</p><h1>완성한 그림책을 펼쳐 읽어요</h1><p>책을 누르면 실제 책처럼 두 쪽씩 펼쳐져요. 오른쪽 쪽을 누르거나 밀면 다음 장으로 넘어가요.</p></div>
      {books && <div className="ebook-shelf-count"><b>{books.length}</b><span>권 · 학생 {students}명</span></div>}
    </section>
    {error && <p className="error-box" role="alert">{error}</p>}
    {books === null ? !error && <div className="ebook-shelf-loading" role="status">{Array.from({ length: 6 }, (_, index) => <i key={index} />)}</div>
      : books.length === 0 ? <p className="book-empty">아직 완성한 그림책이 없어요. 학생이 「그림책 완성하기」를 누르면 여기에 꽂혀요.</p>
      : <>
        {books.length > 6 && <label className="ebook-shelf-search"><span>찾기</span><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="제목이나 학생 이름" /></label>}
        <ul className="ebook-shelf" aria-label="완성한 그림책">
          {filtered.map((book, index) => {
            const asset = book.cover.imageAssetId || book.cover.backgroundAssetId;
            return <li key={book.id} style={{ "--tilt": `${((index * 37) % 5 - 2) * 0.35}deg` } as CSSProperties}>
              <button type="button" className="ebook-shelf-book" disabled={Boolean(opening)} onClick={() => void openBook(book.id)} aria-label={`${studentLabel(book)}의 「${book.title || "제목 없음"}」 펼쳐 읽기`}>
                <span className="ebook-shelf-cover" style={{ background: book.cover.background }}>
                  {asset && <img src={`/api/teacher/storybooks/${book.id}/assets/${asset}`} alt="" loading="lazy" decoding="async" />}
                  <span className="ebook-shelf-cover-title">{book.cover.text || book.title || "제목 없음"}</span>
                  {opening === book.id && <span className="ebook-shelf-opening">펼치는 중…</span>}
                </span>
                <b>{book.title || "제목 없음"}</b>
                <small>{studentLabel(book)} · {book.pageCount}쪽</small>
              </button>
            </li>;
          })}
        </ul>
        {!filtered.length && <p className="book-empty">「{query}」에 맞는 그림책이 없어요.</p>}
      </>}
    {open && <div className="ebook-shelf-reader"><EbookViewer key={open.token} token={open.token} onClose={close} /></div>}
  </main>;
}
