"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { StorybookDocument, StorybookPage } from "@/lib/storybook-model";
import { BookFlip, type BookSpread } from "./BookFlip";

export function StorybookReader({ title, document, initialPage, homeHref, onClose, onPageChange, renderPage }: {
  title: string; document: StorybookDocument; initialPage: number; homeHref: string;
  onClose: () => void; onPageChange: (index: number) => void; renderPage: (page: StorybookPage) => ReactNode;
}) {
  // 2026-11-02: ebook과 같은 두 쪽 책 넘기기(BookFlip). 앞표지 홀로 → 2–3쪽, 4–5쪽 … → 뒷표지 홀로.
  const [position, setPosition] = useState<{ spread: BookSpread; index: number; total: number } | null>(null);
  const dialog = useRef<HTMLDivElement>(null), closeButton = useRef<HTMLButtonElement>(null);
  const onSpread = useCallback((spread: BookSpread, index: number, total: number) => {
    setPosition({ spread, index, total });
    onPageChange(spread.right ?? spread.left ?? 0);
  }, [onPageChange]);
  useEffect(() => {
    const previous = window.document.activeElement as HTMLElement | null;
    closeButton.current?.focus();
    return () => { previous?.focus(); };
  }, []);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); }
      if (event.key === "Tab") {
        const items = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href]') ?? [])];
        const first = items[0], end = items.at(-1);
        if (event.shiftKey && window.document.activeElement === first) { event.preventDefault(); end?.focus(); }
        if (!event.shiftKey && window.document.activeElement === end) { event.preventDefault(); first?.focus(); }
      }
    };
    window.addEventListener("keydown", handler); return () => window.removeEventListener("keydown", handler);
  });
  return <div ref={dialog} className="storybook-preview storybook-reader ebook-flip" role="dialog" aria-modal="true" aria-label="그림책 미리보기">
    <header><b>{title || "제목을 지어 주세요"}</b><div><a className="small-button" href={homeHref}>첫 화면으로</a><button ref={closeButton} type="button" className="small-button" onClick={onClose}>편집으로 돌아가기</button></div></header>
    <BookFlip document={document} initialPage={initialPage} renderContent={page => renderPage(page)} onChange={onSpread} pageNumbers maxHeight="calc(100dvh - 150px)" />
    <footer aria-live="polite">{position ? `${position.spread.label} · ${position.index + 1} / ${position.total}` : ""} · 전체 {document.pages.length}쪽 <small>화살표 또는 손가락으로 책장을 넘겨요</small></footer>
  </div>;
}
