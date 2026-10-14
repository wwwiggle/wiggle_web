"use client";

import { memo, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { StorybookCrop, StorybookDocument, StorybookElement, StorybookPage } from "@/lib/storybook-model";
import { Logo } from "./Logo";
import { StorybookTextInput } from "./StorybookTextInput";
import { AuthenticatedImage, AuthenticatedImageCache } from "./AuthenticatedImage";
import { useStorybookPrint } from "./useStorybookPrint";
import "./storybook-editing.css";

type TeacherBook = { id: string; classroomId: string; classroomName: string; studentId: string; nickname: string; animal: string; title: string; completedAt: string; document: StorybookDocument };
type TeacherAsset = { id: string; sourceType: string; contentType: string };

function imageCropStyle(crop?: StorybookCrop): CSSProperties {
  if (!crop) return { inset: 0, width: "100%", height: "100%", objectFit: "contain" };
  return { left: `${-crop.x / crop.width * 100}%`, top: `${-crop.y / crop.height * 100}%`, width: `${100 / crop.width}%`, height: `${100 / crop.height}%`, objectFit: "fill" };
}

export const BookPage = memo(function BookPage({ bookId, format, page, assetIds, assetBase = "/api/teacher/storybooks" }: { bookId: string; format: StorybookDocument["format"]; page: StorybookPage; assetIds?: Set<string>; assetBase?: string }) {
  const assetUrl = (assetId: string) => `${assetBase}/${bookId}/assets/${assetId}`;
  const renderElement = (element: StorybookElement) => <div className={`teacher-story-element ${element.type} ${element.type === "text" ? "storybook-stage-element" : ""}`} key={element.id} style={{ left: `${element.x * 100}%`, top: `${element.y * 100}%`, width: `${element.width * 100}%`, height: `${element.height * 100}%`, transform: `rotate(${element.rotation}deg)`, zIndex: element.type === "text" ? 10_002 : element.zIndex + 1, opacity: element.opacity, color: element.color, textAlign: element.align }}>
    {element.type === "image" && element.assetId && (!assetIds || assetIds.has(element.assetId)) ? <AuthenticatedImage src={assetUrl(element.assetId)} alt="그림책 그림" style={imageCropStyle(element.crop)} /> : element.type === "text" ? <StorybookTextInput element={element} format={format} interactive={false} /> : null}
  </div>;
  return <div className={`teacher-story-page format-${format}`} style={{ background: page.background }}>
    {page.backgroundAssetId && (!assetIds || assetIds.has(page.backgroundAssetId)) && <AuthenticatedImage className="teacher-story-background" src={assetUrl(page.backgroundAssetId)} alt="그림책 배경" />}
    {page.elements.slice().sort((a, b) => a.zIndex - b.zIndex).map(renderElement)}
  </div>;
});

export function TeacherStorybookPreview({ classroomId, storybookId }: { classroomId: string; storybookId: string }) {
  const [book, setBook] = useState<TeacherBook | null>(null);
  const [assets, setAssets] = useState<TeacherAsset[]>([]);
  const [pageIndex, setPageIndex] = useState(0);
  const [error, setError] = useState("");
  const [printAttempt, setPrintAttempt] = useState(0);
  const printRoot = useRef<HTMLElement>(null);
  const printStatus = useStorybookPrint(printRoot, book?.document, printAttempt);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      let response = await fetch(`/api/teacher/storybooks/${encodeURIComponent(storybookId)}`, { cache: "no-store", signal: controller.signal });
      if (response.status === 401 && location.hostname === "localhost") {
        await fetch("/api/teacher", { cache: "no-store", signal: controller.signal });
        response = await fetch(`/api/teacher/storybooks/${encodeURIComponent(storybookId)}`, { cache: "no-store", signal: controller.signal });
      }
      const data = await response.json() as { storybook?: TeacherBook; assets?: TeacherAsset[]; error?: string };
      if (!response.ok || !data.storybook) throw new Error(data.error ?? "완성 그림책을 펼치지 못했어요.");
      if (data.storybook.classroomId !== classroomId) throw new Error("이 학급의 그림책이 아니에요.");
      setBook(data.storybook); setAssets(data.assets ?? []);
    })().catch((cause) => { if (!(cause instanceof DOMException && cause.name === "AbortError")) setError(cause instanceof Error ? cause.message : "완성 그림책을 펼치지 못했어요."); });
    return () => controller.abort();
  }, [classroomId, storybookId]);

  const assetIds = useMemo(() => new Set(assets.map((asset) => asset.id)), [assets]);
  if (!book) return <main className="teacher-storybook-shell"><header className="teacher-storybook-header"><Logo /><a className="small-button" href={`/teacher/class/${classroomId}/books`}>← 그림책 목록</a></header>{error ? <p className="error-box">{error}</p> : <div className="loading-card">완성 그림책을 펼치는 중…</div>}</main>;
  const page = book.document.pages[pageIndex];

  return <main className="teacher-book-preview-shell" data-print-ready={printStatus.ready}>
    <header className="teacher-book-preview-header"><Logo /><a className="small-button" href={`/teacher/class/${classroomId}/books`}>← 그림책 목록</a><div><p>{book.animal} {book.nickname} · {book.classroomName}</p><h1>{book.title}</h1></div><button type="button" className="button primary" disabled={!printStatus.ready} onClick={() => { if (printStatus.ready) window.print(); }}>PDF로 저장 · 인쇄</button></header>
    <div className="teacher-print-status" role={printStatus.failedPages.length || printStatus.timedOut ? "alert" : "status"}>
      {printStatus.ready ? "모든 쪽의 그림과 글꼴이 준비됐어요. PDF로 저장할 수 있어요." : printStatus.failedPages.length || printStatus.timedOut ? <><p>{printStatus.failedPages.length ? `${printStatus.failedPages.join("·")}쪽의 그림을 준비하지 못했어요.` : "글꼴을 준비하는 데 시간이 오래 걸리고 있어요."} 그림이 빠진 PDF가 저장되지 않도록 잠시 멈췄어요.</p><button type="button" className="small-button" onClick={() => setPrintAttempt(value => value + 1)}>인쇄 준비 다시 시도</button></> : `PDF에 넣을 그림을 준비하고 있어요. ${printStatus.loaded}/${printStatus.total}개 완료 · 모든 그림과 글꼴이 준비되면 저장할 수 있어요.`}
    </div>
    <p className="teacher-print-blocked">아직 그림책 인쇄가 준비되지 않았어요. 인쇄 창을 닫고, 그림책 화면에서 준비 완료를 확인한 뒤 ‘PDF로 저장 · 인쇄’를 눌러 주세요.</p>
    <section className="teacher-book-reader" aria-label={`${book.title} 그림책 미리보기`}>
      <button type="button" aria-label="이전 쪽" disabled={pageIndex === 0} onClick={() => setPageIndex((value) => value - 1)}>‹</button>
      <div className="teacher-book-current"><BookPage bookId={book.id} format={book.document.format} page={page} assetIds={assetIds} /><footer><b>{pageIndex + 1} / {book.document.pages.length}</b><span>{new Date(book.completedAt).toLocaleString("ko-KR", { dateStyle: "long", timeStyle: "short" })} 완성</span></footer></div>
      <button type="button" aria-label="다음 쪽" disabled={pageIndex === book.document.pages.length - 1} onClick={() => setPageIndex((value) => value + 1)}>›</button>
    </section>
    <nav className="teacher-book-thumbnails" aria-label="그림책 쪽 선택">{book.document.pages.map((item, index) => <button type="button" className={index === pageIndex ? "active" : ""} aria-current={index === pageIndex ? "page" : undefined} onClick={() => setPageIndex(index)} key={item.id}><span style={{ background: item.background }}>{index + 1}</span></button>)}</nav>
    <AuthenticatedImageCache key={printAttempt}><section ref={printRoot} className="teacher-print-pages" aria-hidden="true">{book.document.pages.map((item, index) => <article key={item.id}><BookPage bookId={book.id} format={book.document.format} page={item} assetIds={assetIds} /><footer>{book.title} · {book.animal} {book.nickname} · {index + 1}/{book.document.pages.length}</footer></article>)}</section></AuthenticatedImageCache>
  </main>;
}
