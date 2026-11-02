"use client";

// 두 쪽 펼침 책 넘기기(2026-11-02 사용자 지시: "그림책은 항상 두 페이지씩 … 실제 책처럼 겉표지 넘기고 책 읽듯이").
// 1쪽(앞표지)은 닫힌 책처럼 홀로, 그다음 2–3쪽, 4–5쪽 … 두 쪽씩, 마지막 뒷표지는 닫힌 책 뒷면처럼 홀로 보인다.
// 책장은 앞면·뒷면이 있는 종이 한 장으로 넘어간다: 오른쪽 쪽이 등(가운데)을 축으로 돌아 다음 펼침의 왼쪽 쪽이 된다.
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { storybookAspectRatio, type StorybookDocument, type StorybookPage } from "@/lib/storybook-model";
import { bookSpreads, spreadOfPage, type BookSpread } from "@/lib/storybook-structure";
import "./book-flip.css";

export type { BookSpread } from "@/lib/storybook-structure";

const TURN_MS = 680;
type Turn = { from: number; to: number; direction: 1 | -1 };

export function BookFlip({ document, renderContent, initialPage = 0, onChange, pageNumbers = false, maxHeight = "calc(100dvh - 190px)" }: {
  document: StorybookDocument;
  renderContent: (page: StorybookPage, index: number) => ReactNode;
  initialPage?: number;
  onChange?: (spread: BookSpread, index: number, total: number) => void;
  pageNumbers?: boolean;
  /** 책(두 쪽) 높이의 최댓값. 화면 머리·바닥 줄을 뺀 높이를 준다. */
  maxHeight?: string;
}) {
  const spreads = useMemo(() => bookSpreads(document), [document]);
  const [index, setIndex] = useState(() => spreadOfPage(spreads, initialPage));
  const [turn, setTurn] = useState<Turn | null>(null);
  const turnRef = useRef<Turn | null>(null);
  // 넘기는 중에 더 누른 횟수(+는 앞으로, -는 뒤로). 누른 만큼 이어서 넘긴다.
  const queued = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const swipe = useRef<{ x: number; y: number; at: number } | null>(null);
  const safeIndex = Math.min(index, spreads.length - 1);
  const ratio = storybookAspectRatio(document.format);

  useEffect(() => { onChange?.(spreads[safeIndex], safeIndex, spreads.length); }, [safeIndex, spreads, onChange]);
  useEffect(() => () => clearTimeout(timer.current), []);

  function finish(to: number) {
    turnRef.current = null; setTurn(null); setIndex(to);
    // 넘기는 동안 한 번 더 누르면 끝난 뒤 바로 이어서 넘긴다(빠르게 넘겨도 씹히지 않게).
    const pending = queued.current;
    if (pending) { const direction: 1 | -1 = pending > 0 ? 1 : -1; queued.current -= direction; requestAnimationFrame(() => go(direction, to)); }
  }

  function go(direction: 1 | -1, from = safeIndex) {
    if (turnRef.current) { queued.current = Math.sign(queued.current) === -direction ? direction : Math.max(-4, Math.min(4, queued.current + direction)); return; }
    const to = from + direction;
    if (to < 0 || to >= spreads.length) { queued.current = 0; return; }
    const reduce = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce) { setIndex(to); return; }
    const next = { from, to, direction };
    turnRef.current = next; setTurn(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => finish(to), TURN_MS + 40);
  }

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement | null)?.matches("input, select, textarea, [contenteditable='true']")) return;
      if (event.key === "ArrowRight" || event.key === "PageDown") { event.preventDefault(); go(1); }
      if (event.key === "ArrowLeft" || event.key === "PageUp") { event.preventDefault(); go(-1); }
      if (event.key === "Home") { event.preventDefault(); setIndex(0); }
      if (event.key === "End") { event.preventDefault(); setIndex(spreads.length - 1); }
    };
    window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key);
  });

  const page = (pageIndex: number | null, side: "left" | "right", paper: boolean) => {
    if (pageIndex === null) return paper ? <div className={`flip-page flip-${side} is-blank`} /> : null;
    const storyPage = document.pages[pageIndex];
    return <div className={`flip-page flip-${side} storybook-stage preview format-${document.format}`} style={{ background: storyPage?.background ?? "#faf8f1" }}>
      {storyPage && <div className="storybook-stage-content">{renderContent(storyPage, pageIndex)}</div>}
      {pageNumbers && storyPage && <span className="flip-page-number">{pageIndex + 1}</span>}
    </div>;
  };

  const current = spreads[safeIndex];
  // 넘기는 동안: 아래에 깔린 두 쪽 + 넘어가는 종이 한 장(앞면·뒷면).
  // 왼쪽·오른쪽 자리를 어느 펼침에서 가져오는지. 빈 자리는 그 펼침이 속지일 때만 흰 종이로 채운다(닫힌 책의 빈 쪽은 비워 둔다).
  let leftFrom = current, rightFrom = current, leaf: { front: number | null; back: number | null } | null = null;
  let target = current;
  if (turn) {
    const from = spreads[turn.from], to = spreads[turn.to];
    target = to;
    if (turn.direction > 0) { leftFrom = from; rightFrom = to; leaf = { front: from.right, back: to.left }; }
    else { leftFrom = to; rightFrom = from; leaf = { front: from.left, back: to.right }; }
  }
  const staticLeft = leftFrom.left, staticRight = rightFrom.right;
  // 닫힌 책(앞표지·뒷표지)은 가운데로 옮겨 보인다. 넘기는 동안 함께 미끄러진다.
  const shift = target.kind === "front" ? "is-closed-front" : target.kind === "back" ? "is-closed-back" : "";

  return <div className="flip-scene" style={{ "--page-ratio": ratio, "--flip-max-h": maxHeight, "--flip-ms": `${TURN_MS}ms` } as CSSProperties}>
    <button className="flip-arrow" type="button" aria-label="이전 쪽" disabled={safeIndex === 0 && !turn} onClick={() => go(-1)}>‹</button>
    <div className="flip-viewport"
      onPointerDown={event => { swipe.current = { x: event.clientX, y: event.clientY, at: Date.now() }; }}
      onPointerCancel={() => { swipe.current = null; }}
      onPointerUp={event => {
        const start = swipe.current; swipe.current = null;
        if (!start) return;
        const dx = event.clientX - start.x, dy = event.clientY - start.y;
        if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.4) { go(dx < 0 ? 1 : -1); return; }
        // 가볍게 누르면 책처럼: 오른쪽 쪽은 앞으로, 왼쪽 쪽은 뒤로.
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8 && Date.now() - start.at < 500) {
          const rect = event.currentTarget.getBoundingClientRect();
          go(event.clientX > rect.left + rect.width / 2 ? 1 : -1);
        }
      }}>
      <div className={`flip-book ${shift}`.trim()}>
        <div className="flip-half flip-half-left">{page(staticLeft, "left", leftFrom.kind === "inner")}</div>
        <div className="flip-half flip-half-right">{page(staticRight, "right", rightFrom.kind === "inner")}</div>
        {(current.kind === "inner" || turn) && <div className="flip-spine" aria-hidden="true" />}
        {turn && leaf && <div key={`${turn.from}-${turn.to}`} aria-hidden="true" className={`flip-leaf ${turn.direction > 0 ? "flip-forward" : "flip-backward"}`}>
          <div className="flip-face flip-face-front">{page(leaf.front, turn.direction > 0 ? "right" : "left", true)}<i className="flip-shade" /></div>
          <div className="flip-face flip-face-back">{page(leaf.back, turn.direction > 0 ? "left" : "right", true)}<i className="flip-shade" /></div>
        </div>}
        {/* 앞뒤 펼침의 쪽을 미리 그려 둔다(보이지 않음). 그림을 미리 받아 두어 넘기는 순간 빈 종이가 보이지 않는다. */}
        <div className="flip-half flip-prefetch" aria-hidden="true">{[safeIndex - 1, safeIndex + 1, safeIndex + 2].flatMap(near => spreads[near] ? [spreads[near].left, spreads[near].right] : []).filter((pageIndex): pageIndex is number => pageIndex !== null && pageIndex !== current.left && pageIndex !== current.right).map(pageIndex => <div key={pageIndex} className="flip-prefetch-page">{page(pageIndex, "right", false)}</div>)}</div>
      </div>
    </div>
    <button className="flip-arrow" type="button" aria-label="다음 쪽" disabled={safeIndex === spreads.length - 1 && !turn} onClick={() => go(1)}>›</button>
  </div>;
}
