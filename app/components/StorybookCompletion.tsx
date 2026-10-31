"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { StorybookDocument, StorybookPage } from "@/lib/storybook-model";
import { copyEbookLink, downloadEbookPdf, requestEbookLink, type EbookLinkResponse } from "@/lib/ebook-client";
import "./book-structure.css";

/** Shown right after "그림책 완성하기": cover preview, ebook view, link copy and square PDF download. */
export function StorybookCompletion({ bookId, title, document, teacherClassroomId, renderPage, onClose, onPreview }: {
  bookId: string; title: string; document: StorybookDocument; teacherClassroomId?: string;
  renderPage: (page: StorybookPage) => ReactNode; onClose: () => void; onPreview: () => void;
}) {
  const [link, setLink] = useState<EbookLinkResponse | null>(null);
  const [busy, setBusy] = useState<"" | "link" | "pdf">("");
  const [message, setMessage] = useState("");
  const firstButton = useRef<HTMLButtonElement>(null);
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; });
  useEffect(() => {
    const previous = window.document.activeElement as HTMLElement | null;
    firstButton.current?.focus();
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); closeRef.current(); } };
    window.addEventListener("keydown", key);
    return () => { window.removeEventListener("keydown", key); previous?.focus(); };
  }, []);

  async function ensureLink() {
    if (link) return link;
    const next = await requestEbookLink(bookId, { teacher: Boolean(teacherClassroomId) });
    setLink(next); return next;
  }
  async function run(kind: "link" | "pdf", task: () => Promise<void>) {
    if (busy) return;
    setBusy(kind); setMessage("");
    try { await task(); } catch (cause) { setMessage(cause instanceof Error ? cause.message : "잠시 뒤에 다시 눌러 주세요."); }
    finally { setBusy(""); }
  }
  const cover = document.pages[0];
  return <div className="storybook-modal-backdrop" role="presentation" onMouseDown={onClose}>
    <section className="storybook-completion" role="dialog" aria-modal="true" aria-labelledby="storybook-completion-title" onMouseDown={event => event.stopPropagation()}>
      <header><p className="eyebrow">그림책 완성</p><h2 id="storybook-completion-title">『{title || "나의 그림책"}』을 완성했어요!</h2></header>
      <div className="storybook-completion-body">
        <div className="storybook-completion-cover" aria-label="앞표지 미리보기">{cover && <div className={`storybook-stage preview format-${document.format}`} style={{ background: cover.background }}><div className="storybook-stage-content">{renderPage(cover)}</div></div>}</div>
        <div className="storybook-completion-actions">
          <button ref={firstButton} type="button" className="button primary full" disabled={Boolean(busy)} onClick={() => void run("link", async () => { const next = await ensureLink(); window.location.href = next.path; })}>📖 ebook으로 보기</button>
          <button type="button" className="button secondary full" disabled={Boolean(busy)} onClick={() => void run("link", async () => { const next = await ensureLink(); const copied = await copyEbookLink(next.path); setMessage(`${copied ? "링크를 복사했어요. " : ""}${next.shared ? "링크를 가진 사람은 누구나 볼 수 있어요." : "이 링크는 나와 선생님만 열 수 있어요."}`); })}>🔗 링크 복사</button>
          <button type="button" className="button secondary full" disabled={Boolean(busy)} onClick={() => void run("pdf", async () => { const next = await ensureLink(); await downloadEbookPdf(next.token, title); setMessage("정사각형 PDF를 내려받았어요."); })}>{busy === "pdf" ? "PDF 만드는 중…" : "⬇️ PDF 다운로드"}</button>
          <button type="button" className="button secondary full" onClick={onPreview}>책장 넘겨 보기</button>
          <p className="storybook-completion-note">다시 고치면 ‘만드는 중’으로 돌아가요. 지금 모습을 남기려면 먼저 전체 복제를 해 두세요.</p>
          {message && <p className="storybook-completion-message" role="status">{message}</p>}
        </div>
      </div>
      <footer><button type="button" className="small-button" onClick={onClose}>편집으로 돌아가기</button></footer>
    </section>
  </div>;
}
