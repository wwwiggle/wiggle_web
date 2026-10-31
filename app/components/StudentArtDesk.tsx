"use client";

import { useEffect, useState } from "react";
import { PaidLock } from "./PaidLock";
import { DRAWING_LOCKED, DRAWING_LOCKED_MESSAGE, PAID_PLAN_LABEL } from "@/lib/feature-locks";
import { deactivateProfile, studentFetch } from "@/lib/client-session";
import { AuthenticatedImage, AuthenticatedImageCache } from "./AuthenticatedImage";
import { Logo } from "./Logo";
import { StorybookDuplicateButton } from "./StorybookDuplicateButton";
import "./StudentArtDesk.css";

/* 참여 코드 뒤에 아이가 서는 자리 (2026-09-25 사용자 결정 — 코덱스 인계
 * `docs/design-assets/student-art-desk-handoff-20260923/`, 시안 `reference/selected-art-desk.png`).
 *
 * 종전에는 코드가 맞으면 그리던 그림이나 새 도화지로 **곧장** 넘어갔다. 그래서 아이가
 * 자기 그림이 몇 장인지, 만든 그림책이 있는지 볼 자리가 없었고, 그리던 그림이 있으면
 * 새 그림을 그릴 방법도 없었다. 이제 갈림길은 저장된 그림 수 하나다.
 *   0장  → 중간 화면 없이 바로 새 도화지 (처음 들어온 아이를 세워 두지 않는다)
 *   1장~ → 이 화면. 내 그림 + 새 그림 그리기 + 내 그림책이 한자리에 있다.
 * 그리던 그림은 **아이가 목록에서 직접** 「이어 그리기」를 고른다. 자동으로 열지 않는다.
 *
 * 시안은 위치·분위기 참고용이다. 화면 전체를 배경으로 깔지 않는다 — 장식은 분리된
 * 에셋으로 모서리에만 놓고, 그림·책·제목·행동은 모두 실제 데이터와 DOM이다. */

export type DeskArtwork = { id: string; title: string; status: string; hasImage: number | boolean; updatedAt: string; completedAt: string | null };
export type DeskStorybook = { id: string; title: string; pageCount: number; status: string; updatedAt: string };

/** 목록에 몇 장까지 펴 놓을지. 나머지는 기존 보관함으로 보낸다 — 여기서 전부 받지 않는다. */
export const DESK_ARTWORK_LIMIT = 3;

const DRAWING = (artwork: DeskArtwork) => artwork.status !== "complete";

/** 카드 한 장이 통째로 링크다. 안에 또 링크나 단추를 넣지 않는다(인계 지시 — 중첩 금지). */
function ArtworkCard({ artwork }: { artwork: DeskArtwork }) {
  const drawing = DRAWING(artwork);
  // 그림 그리기가 잠기면(유료 요금제) 「내 그림」 칸 전체를 잠근다 — 그리는 중·완성 그림 모두(2026-11-01 사용자 지시).
  const locked = DRAWING_LOCKED;
  const Card = locked ? "span" : "a";
  return <Card className={`desk-art-card${locked ? " paid-lock" : ""}`} {...(locked ? { "aria-disabled": true, title: DRAWING_LOCKED_MESSAGE } : { href: drawing ? `/student/draw/${encodeURIComponent(artwork.id)}` : `/student/archive/${encodeURIComponent(artwork.id)}` })}>
    <span className="desk-art-paper">
      {artwork.hasImage
        ? <AuthenticatedImage className="desk-art-image" src={`/api/artworks/${encodeURIComponent(artwork.id)}/image`} alt={`${artwork.title} 그림`} lazy />
        : <span className="desk-art-image is-blank" aria-hidden="true">🎨</span>}
      {/* 상태는 색만으로 구분하지 않는다 — 글자로 적는다. */}
      <span className={`desk-art-badge${drawing ? " is-drawing" : ""}`}>{drawing ? "그리는 중" : "완성"}</span>
    </span>
    <span className="desk-art-foot">
      <span className="desk-art-meta">
        <b>{artwork.title}</b>
        <time dateTime={artwork.completedAt ?? artwork.updatedAt}>{deskDate(artwork.completedAt ?? artwork.updatedAt)}</time>
      </span>
      {/* 시안대로 제목·날짜는 왼쪽, 행동은 같은 줄 오른쪽이다. 세로로 쌓으면 카드가 길어져
          한 줄에 네 장이 들어가지 않는다. */}
      <span className="desk-art-go">{locked ? <>🔒 {PAID_PLAN_LABEL}</> : <>{drawing ? "이어 그리기" : "그림 보기"} <span aria-hidden="true">›</span></>}</span>
    </span>
  </Card>;
}

function BookCard({ book, index }: { book: DeskStorybook; index: number }) {
  return <article className="desk-book-item"><a className="desk-book-card" href={`/student/books/${encodeURIComponent(book.id)}`}>
    {/* 표지 썸네일은 목록 응답에 없다(인계 확인). 임의의 아이 그림을 만들어 넣지 않고 빈 책 틀만 쓴다.
        틀 색은 시안처럼 번갈아 쓴다 — 책을 구분하는 정보가 아니라 장식이라 제목이 따로 적혀 있다. */}
    <span className="desk-book-frame" aria-hidden="true">
      <img src={`/student-desk/book-cover-frame-${index % 2 ? "yellow" : "green"}.svg`} alt="" width={248} height={248} />
    </span>
    <span className="desk-book-meta">
      <b title={book.title || "이름 없는 그림책"}>{book.title || "이름 없는 그림책"}</b>
      <small>{book.pageCount}쪽 · {book.status === "complete" ? "완성" : "만드는 중"}</small>
      <span className="desk-art-go">그림책 보기 <span aria-hidden="true">›</span></span>
    </span>
  </a><StorybookDuplicateButton bookId={book.id} /></article>;
}

function deskDate(value: string) {
  // CURRENT_TIMESTAMP('YYYY-MM-DD HH:MM:SS')는 Safari에서 Invalid Date라 ISO로 맞춘다.
  const date = new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString("ko-KR");
}

export function StudentArtDesk({ nickname, artworks, artworkTotal }: { nickname: string; artworks: DeskArtwork[]; artworkTotal: number }) {
  const [books, setBooks] = useState<DeskStorybook[] | null>(null);
  const [bookError, setBookError] = useState("");
  const [leaving, setLeaving] = useState(false);

  // 그림책은 따로 받는다. 실패해도 그림 목록은 그대로 쓴다 — 이 구역만 안내를 보여 준다.
  useEffect(() => {
    let cancelled = false;
    void studentFetch("/api/storybooks")
      .then(async (response) => {
        const data = await response.json() as { storybooks?: DeskStorybook[]; error?: string };
        if (!response.ok) throw new Error(data.error ?? "그림책을 불러오지 못했어요.");
        if (!cancelled) setBooks(data.storybooks ?? []);
      })
      .catch((cause) => { if (!cancelled) { setBooks([]); setBookError(cause instanceof Error ? cause.message : "그림책을 불러오지 못했어요."); } });
    return () => { cancelled = true; };
  }, []);

  async function leaveClass() {
    if (leaving) return;
    setLeaving(true);
    await deactivateProfile().catch(() => undefined);
    location.replace("/join");
  }

  const shown = artworks.slice(0, DESK_ARTWORK_LIMIT);
  const shownBooks = books ?? [];

  return <AuthenticatedImageCache>
    <main className="student-art-desk">
      {/* 모서리 장식. 본문 뒤에 있고 초점·클릭을 받지 않는다. 좁은 화면에서는 CSS가 숨긴다. */}
      <div className="desk-decor" aria-hidden="true">
        <img className="desk-decor-plant" src="/student-desk/plant-left.webp" alt="" width={1295} height={1214} />
        {/* 메모지 글자는 그림에 굽지 않고 HTML로 올린다(인계 지시 — 그림 속 메모지는 비어 있다). */}
        <span className="desk-decor-stationery">
          <img src="/student-desk/stationery-top-right.webp" alt="" width={1536} height={1024} />
          <span className="desk-memo">오늘도<br />멋진 그림<br />기다릴게!</span>
        </span>
        <img className="desk-decor-notebook" src="/student-desk/notebook-bottom-right.webp" alt="" width={1222} height={1287} />
        <img className="desk-decor-crayons" src="/student-desk/crayons-edge.webp" alt="" width={1536} height={1024} />
      </div>

      <header className="app-header desk-header">
        <Logo />
        <button type="button" className="small-button desk-finish" disabled={leaving} onClick={() => void leaveClass()}>
          <span aria-hidden="true">📕</span>{leaving ? "나가는 중…" : "수업 마치기"}
        </button>
      </header>

      <div className="desk-body">
        <div className="desk-title">
          <h1>{nickname}의 그림 자리</h1>
          {/* 시안은 짧은 노란 밑줄과 안내가 한 줄에 나란히 있다. */}
          <p><span className="desk-title-rule" aria-hidden="true" />오늘은 무엇을 해 볼까?</p>
        </div>

        <section className="desk-section" aria-labelledby="desk-art-title">
          <div className="desk-section-head">
            <h2 id="desk-art-title"><img src="/student-desk/icon-my-art.svg" alt="" aria-hidden="true" width={28} height={28} />내 그림</h2>
            {artworkTotal > shown.length && (DRAWING_LOCKED ? <PaidLock className="desk-more" badge={false}>🔒 내 그림 모두 보기 ({artworkTotal}장)</PaidLock> : <a className="desk-more" href="/student/archive">내 그림 모두 보기 ({artworkTotal}장)</a>)}
          </div>
          <ul className="desk-art-row">
            {/* 모든 화면 크기에서 새 그림이 시각·탭 순서의 맨 앞이다. */}
            <li className="desk-new-item">
              {DRAWING_LOCKED
                ? <PaidLock className="desk-new-card">
                  <img src="/student-desk/icon-new-drawing.svg" alt="" aria-hidden="true" width={72} height={72} />
                  <b>새 그림 그리기</b>
                </PaidLock>
                : <a className="desk-new-card" href="/student/draw/new?mode=free">
                  <img src="/student-desk/icon-new-drawing.svg" alt="" aria-hidden="true" width={72} height={72} />
                  <b>새 그림 그리기</b>
                </a>}
            </li>
            {shown.map((artwork) => <li key={artwork.id}><ArtworkCard artwork={artwork} /></li>)}
          </ul>
        </section>

        <section className="desk-section" aria-labelledby="desk-book-title">
          <div className="desk-section-head">
            <h2 id="desk-book-title"><img src="/student-desk/icon-my-books.svg" alt="" aria-hidden="true" width={28} height={28} />내 그림책</h2>
            {books !== null && !bookError && <a className="desk-more" href="/student/books">내 그림책 모두 보기 ({books.length}권)</a>}
          </div>
          {books === null && <p className="desk-book-empty">그림책을 찾는 중…</p>}
          {bookError && <p role="alert">{bookError}</p>}
          {books !== null && !bookError && !books.length && <p className="desk-book-empty">아직 만든 그림책이 없어요.</p>}
          <h3>만드는 중인 그림책 ({shownBooks.filter(book => book.status !== "complete").length}권)</h3>
          <ul className="desk-book-row">
            <li><a className="desk-new-book" href="/student/books?create=1"><img src="/student-desk/icon-my-books.svg" alt="" width={48} height={48} /><b>새 그림책 만들기</b><span>새로운 이야기를 시작해요</span></a></li>
            {shownBooks.filter(book => book.status !== "complete").map((book, index) => <li key={book.id}><BookCard book={book} index={index} /></li>)}
          </ul>
          <h3>완성된 그림책 ({shownBooks.filter(book => book.status === "complete").length}권)</h3>
          <p className="desk-book-empty">전체 복제를 누르면 원본을 남겨 두고 새 책에서 고칠 수 있어요.</p>
          <ul className="desk-book-row">{shownBooks.filter(book => book.status === "complete").map((book, index) => <li key={book.id}><BookCard book={book} index={index} /></li>)}</ul>
        </section>
      </div>
    </main>
  </AuthenticatedImageCache>;
}
