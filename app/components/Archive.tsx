"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { PaidLock } from "./PaidLock";
import { DRAWING_LOCKED } from "@/lib/feature-locks";
import { deactivateProfile, studentFetch } from "@/lib/client-session";
import { Logo } from "./Logo";
import { FLIP_MS, flipAnnouncement, FlipDirection, FlipPhase, settleIndex, stepIndex, swipeDirection } from "./ArchiveFlip";

type ArchiveArtwork = { id: string; title: string; learningMode: string; lessonSlug: string | null; status: string; hasImage: number | boolean; updatedAt: string; completedAt: string | null };

/* 그림 한 장의 미리보기 주소를 받아 둔다.
 * full=true면 완성본 원본을 받는다 — 큰 쪽에서 256px 썸네일을 키우면 뭉개진다.
 * 넘김 중에는 "가는 그림"과 "오는 그림"이 동시에 필요해서, 컴포넌트 안이 아니라
 * 화면 전체가 같이 쓰는 주머니에 담아 둔다. 같은 그림을 두 번 내려받지 않는다. */
function useArtworkImages() {
  const cache = useRef(new Map<string, string>());
  const inflight = useRef(new Map<string, Promise<string>>());
  const [, bump] = useState(0);

  useEffect(() => {
    const urls = cache.current;
    return () => { for (const url of urls.values()) URL.revokeObjectURL(url); urls.clear(); };
  }, []);

  const load = useCallback((artwork: ArchiveArtwork, full: boolean) => {
    const key = `${artwork.id}:${full ? "full" : "thumb"}`;
    const known = cache.current.get(key);
    if (known) return Promise.resolve(known);
    const running = inflight.current.get(key);
    if (running) return running;
    if (!artwork.hasImage) return Promise.reject(new Error("no image"));
    const task = studentFetch(`/api/artworks/${encodeURIComponent(artwork.id)}/image${full ? "?variant=final" : ""}`)
      .then(async (response) => {
        if (!response.ok) throw new Error("preview unavailable");
        const blob = await response.blob();
        if (!blob.type.startsWith("image/")) throw new Error("invalid preview");
        const url = URL.createObjectURL(blob);
        cache.current.set(key, url);
        bump((value) => value + 1);
        return url;
      })
      .finally(() => { inflight.current.delete(key); });
    inflight.current.set(key, task);
    return task;
  }, []);

  const peek = useCallback((artwork: ArchiveArtwork | null, full: boolean) => (artwork ? cache.current.get(`${artwork.id}:${full ? "full" : "thumb"}`) ?? "" : ""), []);
  return { load, peek };
}

function ArtworkThumb({ artwork, load, peek }: { artwork: ArchiveArtwork; load: ReturnType<typeof useArtworkImages>["load"]; peek: ReturnType<typeof useArtworkImages>["peek"] }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => { if (artwork.hasImage) load(artwork, false).catch(() => setFailed(true)); }, [artwork, load]);
  const url = peek(artwork, false);
  if (url) return <img src={url} alt="" aria-hidden="true" />;
  // 아직 저장된 그림이 없는 것과 불러오기에 실패한 것은 다르다 — 같은 표로 보이면 아이가 헷갈린다.
  if (failed) return <span aria-hidden="true">🖼️</span>;
  return <span aria-hidden="true">{artwork.status === "complete" ? "🌟" : "✏️"}</span>;
}

export function Archive() {
  const [data, setData] = useState<{ student: { nickname: string; animal: string }; artworks: ArchiveArtwork[] } | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [nextOffset, setNextOffset] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const loadingRef = useRef(false);
  const images = useArtworkImages();
  const liveId = useId();

  const loadArchive = useCallback(async (offset = 0, append = false) => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoadingMore(true); setError("");
    try {
      const response = await studentFetch(`/api/student?artworkOffset=${offset}`);
      const value = await response.json() as { student: { nickname: string; animal: string }; artworks: ArchiveArtwork[]; artworkHasMore?: boolean; artworkNextOffset?: number; error?: string };
      if (!response.ok) {
        if (response.status === 401) location.replace("/join");
        else throw new Error(value.error ?? "그림을 불러오지 못했어요.");
        return;
      }
      setData((current) => {
        if (!append || !current) return { student: value.student, artworks: value.artworks };
        const known = new Set(current.artworks.map((item) => item.id));
        return { student: value.student, artworks: [...current.artworks, ...value.artworks.filter((item) => !known.has(item.id))] };
      });
      setHasMore(Boolean(value.artworkHasMore));
      setNextOffset(value.artworkNextOffset ?? offset + value.artworks.length);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "그림을 불러오지 못했어요.");
    } finally {
      loadingRef.current = false;
      setLoadingMore(false);
      setLoading(false);
    }
  }, []);

  const [leaving, setLeaving] = useState(false);
  const [selectedId, setSelectedId] = useState("");
  const [flip, setFlip] = useState<{ phase: FlipPhase; direction: FlipDirection; fromId: string } | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const flipTimers = useRef<number[]>([]);

  useEffect(() => { void loadArchive(); }, [loadArchive]);
  useEffect(() => () => { for (const id of flipTimers.current) window.clearTimeout(id); }, []);

  async function leaveClass() {
    if (leaving) return;
    setLeaving(true);
    await deactivateProfile().catch(() => undefined);
    location.replace("/join");
  }

  // 매 렌더마다 새 배열이 되면 아래 useCallback이 매번 새로 만들어진다.
  const artworks = useMemo(() => data?.artworks ?? [], [data]);
  const index = settleIndex(artworks.map((artwork) => artwork.id), selectedId);
  const selected = index >= 0 ? artworks[index] : null;
  const drawing = selected?.status !== "complete";
  const many = artworks.length > 1;
  const busy = flip !== null;

  // 큰 쪽에 걸 그림은 미리 받아 둔다. 준비 전에 빈 종이로 돌지 않게 하려는 것이다.
  useEffect(() => { if (selected) images.load(selected, true).catch(() => undefined); }, [images, selected]);

  /* 목록 클릭·이전/다음·스와이프·키보드가 모두 이 하나로 들어온다.
   * 넘기는 동안 들어온 추가 입력은 버린다 — 큐를 만들면 마지막에 엉뚱한 그림이 열린다. */
  const goTo = useCallback((targetId: string, direction: FlipDirection) => {
    if (busy) return;
    const target = artworks.find((artwork) => artwork.id === targetId);
    const from = selected;
    if (!target || !from || target.id === from.id) return;
    const finish = () => {
      setSelectedId(target.id);
      setFlip(null);
      const at = artworks.findIndex((artwork) => artwork.id === target.id);
      setAnnouncement(flipAnnouncement(at, artworks.length, target.title));
    };
    const reduced = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduced) { finish(); return; }
    setFlip({ phase: "preparing", direction, fromId: from.id });
    // 대상 그림을 받은 뒤에 돈다. 실패해도 현재 그림은 그대로 두고 조용히 바꾼다.
    images.load(target, true).catch(() => undefined).then(() => {
      setFlip((current) => (current ? { ...current, phase: "turning" } : null));
      // animationend만 믿지 않는다 — 탭이 뒤로 가거나 애니메이션이 취소돼도 반드시 정착해야 한다.
      flipTimers.current.push(window.setTimeout(finish, FLIP_MS + 60));
    });
  }, [artworks, busy, images, selected]);

  const move = useCallback((direction: FlipDirection) => {
    const at = stepIndex(index, direction, artworks.length);
    if (at === index) return;
    goTo(artworks[at].id, direction);
  }, [artworks, goTo, index]);

  const pickFromList = (targetId: string) => {
    const at = artworks.findIndex((artwork) => artwork.id === targetId);
    if (at < 0 || at === index) return;
    goTo(targetId, at > index ? "next" : "prev");
  };

  // 화살표는 그림 뷰어에 초점이 있을 때만 받는다. 전역 키 입력을 가로채지 않는다.
  const onViewerKeyDown = (event: React.KeyboardEvent) => {
    if (!many || busy) return;
    if (event.key === "ArrowRight") { event.preventDefault(); move("next"); }
    if (event.key === "ArrowLeft") { event.preventDefault(); move("prev"); }
  };

  const swipe = useRef<{ id: number; x: number; y: number } | null>(null);
  const onPaperPointerDown = (event: React.PointerEvent) => {
    if (!many || busy || event.isPrimary === false) return;
    if ((event.target as HTMLElement).closest("button,a")) return;
    swipe.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
  };
  const onPaperPointerUp = (event: React.PointerEvent) => {
    const start = swipe.current;
    swipe.current = null;
    if (!start || start.id !== event.pointerId) return;
    const direction = swipeDirection(event.clientX - start.x, event.clientY - start.y);
    if (direction) move(direction);
  };
  const onPaperPointerCancel = () => { swipe.current = null; };

  const fromArtwork = flip ? artworks.find((artwork) => artwork.id === flip.fromId) ?? null : null;
  const selectedUrl = images.peek(selected, true);
  const fromUrl = images.peek(fromArtwork, true);

  /* 학생 홈이 없어져(2026-09-12) 이 화면이 도화지 밖의 유일한 자리다.
   * 2026-09-20 GPT 인계(archive-sketchbook-handoff v2)대로 펼친 스케치북으로 바꿨다.
   * 책·종이·질감은 인계받은 그림 자산이고, 글자·단추·목록·아이 그림은 모두 실제 DOM이다 —
   * 시안 전체를 배경으로 깔고 투명 버튼을 얹지 않는다. 「새 그림」은 인계 지시대로 뺐다. */
  return <main className="archive-book-page">
    <header className="app-header"><Logo /><nav className="archive-actions" aria-label="내 그림 메뉴">
      {/* 2026-09-26: 아이의 집이 「그림 자리」(/student)가 되면서 여기로 들어오는 길은 생겼는데
          돌아가는 길이 없어 막다른 곳이 됐다. 먼저 두어 되돌아가기가 첫 선택이 되게 한다. */}
      <a className="small-button" href="/student"><span aria-hidden="true">←</span>내 그림 자리</a>
      <a className="small-button" href="/student/books"><span aria-hidden="true">📖</span>그림책</a>
      <button type="button" className="small-button archive-finish" onClick={() => void leaveClass()} disabled={leaving}><span aria-hidden="true">📕</span>{leaving ? "나가는 중…" : "수업 마치기"}</button>
    </nav></header>

    {error && <p className="error-box archive-book-error" role="alert">{error} <button type="button" onClick={() => void loadArchive()}>다시 시도</button></p>}

    <div className="archive-stage">
      <div className={`archive-book${flip ? ` is-${flip.phase} is-${flip.direction}` : ""}`}>
        {/* 책은 장식이다. 읽을 것과 누를 것은 모두 아래 DOM에 있다. */}
        <img className="archive-book-shell" src="/archive-book/book-open-blank.webp" alt="" aria-hidden="true" width={1810} height={869} />

        <section className="archive-book-list" aria-label="내 그림 목록">
          <h1>{data ? `${data.student.nickname}의 그림 모음` : "내 그림 모음"}</h1>
          {loading && !data ? <p className="archive-book-empty">그림을 불러오는 중이에요…</p>
            : artworks.length ? <>
              <ul>
                {artworks.map((artwork) => (
                  <li key={artwork.id}>
                    <button type="button" aria-current={selected?.id === artwork.id ? "true" : undefined} disabled={busy} onClick={() => pickFromList(artwork.id)}>
                      <span className="archive-book-thumb"><ArtworkThumb artwork={artwork} load={images.load} peek={images.peek} /></span>
                      <span className="archive-book-meta">
                        <b>{artwork.title}</b>
                        <time dateTime={artwork.completedAt ?? artwork.updatedAt}>{new Date(artwork.completedAt ?? artwork.updatedAt).toLocaleDateString("ko-KR")}</time>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              {hasMore && <button type="button" className="button secondary archive-more-button" disabled={loadingMore} onClick={() => void loadArchive(nextOffset, true)}>{loadingMore ? "불러오는 중…" : "이전 그림 더 보기"}</button>}
            </> : <p className="archive-book-empty">아직 저장된 그림이 없어요.</p>}
        </section>

        <section className="archive-book-view" aria-label="고른 그림">
          {selected ? <>
            <div className="archive-book-head">
              <h2>{selected.title}</h2>
              <p className="archive-book-status"><span className="archive-book-status-icon" aria-hidden="true">{drawing ? "✏️" : "🌟"}</span><span>{drawing ? "그리는 중" : "완성"}</span></p>
            </div>

            <div
              className="archive-book-paper"
              style={{ touchAction: "pan-y pinch-zoom" }}
              tabIndex={many ? 0 : -1}
              onKeyDown={onViewerKeyDown}
              onPointerDown={onPaperPointerDown}
              onPointerUp={onPaperPointerUp}
              onPointerCancel={onPaperPointerCancel}
            >
              {selectedUrl ? <img src={selectedUrl} alt={`${selected.title} 그림`} /> : <span aria-hidden="true">{drawing ? "✏️" : "🌟"}</span>}
              {/* 도는 낱장. 원본과 겹치는 초점을 만들지 않으려고 화면에서 숨긴 복제다. */}
              {flip && <div className="archive-leaf" aria-hidden="true" inert>
                <div className="archive-leaf-face is-out">
                  <img className="archive-leaf-paper" src="/archive-book/book-page-right.webp" alt="" />
                  {fromUrl && <img className="archive-leaf-art" src={fromUrl} alt="" />}
                </div>
                <div className="archive-leaf-face is-in">
                  <img className="archive-leaf-paper" src="/archive-book/book-page-right.webp" alt="" />
                  {selectedUrl && <img className="archive-leaf-art" src={selectedUrl} alt="" />}
                </div>
              </div>}
            </div>

            {many && <div className="archive-book-pager">
              <button type="button" className="archive-pager-button" onClick={() => move("prev")} disabled={busy || index <= 0} aria-label="이전 그림 보기"><span aria-hidden="true">‹</span></button>
              <span className="archive-pager-count">{index + 1} / {artworks.length}</span>
              <button type="button" className="archive-pager-button" onClick={() => move("next")} disabled={busy || index >= artworks.length - 1} aria-label="다음 그림 보기"><span aria-hidden="true">›</span></button>
            </div>}

            {drawing && DRAWING_LOCKED
              ? <PaidLock className="button primary child-primary-action archive-book-open"><span aria-hidden="true">✏️</span>이어 그리기</PaidLock>
              : <a className="button primary child-primary-action archive-book-open" href={drawing ? `/student/draw/${selected.id}` : `/student/archive/${selected.id}`}>
                <span aria-hidden="true">{drawing ? "✏️" : "👀"}</span>{drawing ? "이어 그리기" : "다시 보기"}
              </a>}
          </> : <p className="archive-book-empty">{loading ? "그림을 불러오는 중이에요…" : "그림을 그리면 여기에 모여요."}</p>}
        </section>
      </div>
    </div>

    <p className="sr-only" id={liveId} role="status" aria-live="polite">{announcement}</p>
  </main>;
}
