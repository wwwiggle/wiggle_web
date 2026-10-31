"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { storybookAspectRatio, type StorybookCrop, type StorybookDocument, type StorybookElement, type StorybookPage } from "@/lib/storybook-model";
import { ebookViews } from "@/lib/storybook-structure";
import { ebookFetch } from "@/lib/storybook-editor-fetch";
import { copyEbookLink, downloadEbookPdf, EBOOK_CONSENT_LABELS, requestEbookLink } from "@/lib/ebook-client";
import { AuthenticatedImage, AuthenticatedImageCache } from "./AuthenticatedImage";
import { StorybookTextInput } from "./StorybookTextInput";
import { Logo } from "./Logo";
import "./storybook-editing.css";
import "./book-structure.css";

type Viewer = "owner" | "teacher" | "public";
type Share = { shared: boolean; sharedAt: string | null; consentMethod: string | null };
type EbookData = { viewer: Viewer; storybook: { id?: string; title: string; status: "draft" | "complete"; updatedAt: string; document: StorybookDocument }; share?: Share };

function imageCropStyle(crop?: StorybookCrop): CSSProperties {
  if (!crop) return { inset: 0, width: "100%", height: "100%", objectFit: "contain" };
  return { left: `${-crop.x / crop.width * 100}%`, top: `${-crop.y / crop.height * 100}%`, width: `${100 / crop.width}%`, height: `${100 / crop.height}%`, objectFit: "fill" };
}

export function EbookViewer({ token }: { token: string }) {
  return <AuthenticatedImageCache><EbookViewerContent token={token} /></AuthenticatedImageCache>;
}

function EbookViewerContent({ token }: { token: string }) {
  const [data, setData] = useState<EbookData | null>(null);
  const [error, setError] = useState("");
  const [spread, setSpread] = useState(false);
  // The visible page, not the view number, is the state: switching between one and two pages keeps the place.
  const [anchorPage, setAnchorPage] = useState(0);
  const [turn, setTurn] = useState<{ page: number; direction: 1 | -1 } | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [consentMethod, setConsentMethod] = useState("");
  const [consentChecked, setConsentChecked] = useState(false);
  const turnLock = useRef(false), timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const swipe = useRef<{ x: number; y: number } | null>(null);
  const shell = useRef<HTMLElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    void ebookFetch(`/api/ebook/${encodeURIComponent(token)}`, { signal: controller.signal }).then(async response => {
      const body = await response.json().catch(() => ({})) as EbookData & { error?: string };
      if (!response.ok || !body.storybook) throw new Error(body.error ?? "그림책을 펼치지 못했어요.");
      setData(body);
    }).catch(cause => { if (!(cause instanceof DOMException && cause.name === "AbortError")) setError(cause instanceof Error ? cause.message : "그림책을 펼치지 못했어요."); });
    return () => controller.abort();
  }, [token]);

  useEffect(() => {
    const query = window.matchMedia("(min-width: 900px) and (min-aspect-ratio: 5/4)");
    const update = () => setSpread(query.matches);
    update(); query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  const document = data?.storybook.document;
  const views = useMemo(() => document ? ebookViews(document, spread) : [], [document, spread]);
  const viewIndex = Math.max(0, views.findIndex(view => view.pages.includes(anchorPage)));

  function navigate(direction: 1 | -1) {
    const next = viewIndex + direction;
    if (next < 0 || next >= views.length || turnLock.current) return;
    const from = views[viewIndex];
    turnLock.current = true;
    setTurn({ page: direction > 0 ? from.pages[from.pages.length - 1] : from.pages[0], direction });
    setAnchorPage(views[next].pages[0]);
    timer.current = setTimeout(() => { setTurn(null); turnLock.current = false; }, 520);
  }
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement | null)?.matches("input, select, textarea")) return;
      if (event.key === "ArrowRight") { event.preventDefault(); navigate(1); }
      if (event.key === "ArrowLeft") { event.preventDefault(); navigate(-1); }
    };
    window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key);
  });

  async function toggleFullscreen() {
    try {
      if (window.document.fullscreenElement) await window.document.exitFullscreen();
      else await shell.current?.requestFullscreen();
    } catch { setMessage("이 기기에서는 전체 화면을 쓸 수 없어요."); }
  }

  async function act(task: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setMessage("");
    try { await task(); } catch (cause) { setMessage(cause instanceof Error ? cause.message : "잠시 뒤에 다시 눌러 주세요."); }
    finally { setBusy(false); }
  }

  if (!data || !document) return <main className="ebook-message"><Logo />{error ? <p className="error-box" role="alert">{error}</p> : <div className="loading-card">그림책을 펼치는 중…</div>}</main>;

  const bookId = data.storybook.id;
  const assetUrl = (assetId: string) => `/api/ebook/${encodeURIComponent(token)}/assets/${encodeURIComponent(assetId)}`;
  const renderElement = (element: StorybookElement) => <div key={element.id} className={`storybook-stage-element ${element.type}`} style={{ left: `${element.x * 100}%`, top: `${element.y * 100}%`, width: `${element.width * 100}%`, height: `${element.height * 100}%`, transform: `rotate(${element.rotation}deg)`, zIndex: element.type === "text" ? 10_002 : element.zIndex + 1, opacity: element.opacity, color: element.color, textAlign: element.align }}>
    {element.type === "image" && element.assetId ? <AuthenticatedImage src={assetUrl(element.assetId)} alt="그림책 그림" style={imageCropStyle(element.crop)} /> : element.type === "text" ? <StorybookTextInput element={element} format={document.format} interactive={false} /> : null}
  </div>;
  const pageView = (index: number, extra = "") => {
    const page: StorybookPage | undefined = document.pages[index];
    return <div className={`storybook-stage preview reader-page format-${document.format} ${extra}`} style={{ background: page?.background ?? "#faf8f1" }}>
      {page && <div className="storybook-stage-content">
        {page.backgroundAssetId && <AuthenticatedImage className="storybook-page-background" src={assetUrl(page.backgroundAssetId)} alt="그림책 쪽 배경" />}
        {page.elements.slice().sort((a, b) => a.zIndex - b.zIndex).map(renderElement)}
      </div>}
    </div>;
  };
  const view = views[Math.min(viewIndex, views.length - 1)];
  const twoUp = view.pages.length === 2;
  const share = data.share;

  return <main ref={shell} className={`storybook-preview storybook-reader ebook-viewer ${spread ? "ebook-spread" : "ebook-single"}`} aria-label={`${data.storybook.title || "그림책"} ebook`}>
    <header>
      <b>{data.storybook.title || "제목 없는 그림책"}</b>
      <div>
        {data.viewer === "owner" && <a className="small-button" href="/student/books">내 그림책</a>}
        {data.viewer === "teacher" && <a className="small-button" href="/teacher">선생님 화면</a>}
        {data.viewer !== "public" && bookId && <button type="button" className="small-button" disabled={busy} onClick={() => void act(async () => { const copied = await copyEbookLink(`/ebook/${token}`); setMessage(`${copied ? "링크를 복사했어요. " : ""}${share?.shared ? "링크를 가진 사람은 누구나 볼 수 있어요." : "이 링크는 작가와 선생님만 열 수 있어요."}`); })}><span className="ebook-icon" aria-hidden="true">🔗 </span>링크 복사</button>}
        {data.viewer !== "public" && <button type="button" className="small-button" disabled={busy} onClick={() => void act(async () => { await downloadEbookPdf(token, data.storybook.title); setMessage("정사각형 PDF를 내려받았어요."); })}><span className="ebook-icon" aria-hidden="true">⬇️ </span>PDF</button>}
        <button type="button" className="small-button" onClick={() => void toggleFullscreen()}><span className="ebook-icon" aria-hidden="true">⛶ </span>전체 화면</button>
      </div>
    </header>
    {data.viewer !== "public" && data.storybook.status === "draft" && <p className="ebook-banner" role="status">아직 만드는 중인 그림책이에요. 저장된 모습까지 보여요.</p>}
    {message && <p className="ebook-banner" role="status">{message}</p>}
    {data.viewer === "teacher" && bookId && share && <details className="ebook-share">
      <summary>공유 설정 · {share.shared ? "링크를 가진 누구나 볼 수 있음" : "작가와 선생님만"}</summary>
      {share.shared ? <div>
        <p>보호자 동의({EBOOK_CONSENT_LABELS[share.consentMethod ?? ""] ?? "기록됨"}{share.sharedAt ? `, ${new Date(share.sharedAt.replace(" ", "T") + (share.sharedAt.includes("Z") ? "" : "Z")).toLocaleDateString("ko-KR")}` : ""})를 확인하고 공유를 켰어요. 링크를 받은 사람은 로그인 없이 볼 수 있어요. 학생 이름·학교는 화면에 나오지 않지만, 책 안에 적힌 글은 그대로 보여요.</p>
        <button type="button" className="button secondary" disabled={busy} onClick={() => void act(async () => { const next = await requestEbookLink(bookId, { teacher: true, action: "unshare" }); setData({ ...data, share: { shared: next.shared, sharedAt: next.sharedAt ?? null, consentMethod: next.consentMethod ?? null } }); setMessage("공유를 껐어요. 이제 작가와 선생님만 볼 수 있어요."); })}>공유 끄기</button>
      </div> : <div>
        <p>기본은 작가와 선생님만 볼 수 있어요. 가족 등 다른 사람에게 링크로 보여 주려면 보호자 동의를 받은 뒤 켜 주세요. {data.storybook.status !== "complete" && "완성한 그림책만 공유할 수 있어요."}</p>
        <label>동의 받은 방법<select value={consentMethod} onChange={event => setConsentMethod(event.target.value)}><option value="">고르기</option>{Object.entries(EBOOK_CONSENT_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label className="book-check"><input type="checkbox" checked={consentChecked} onChange={event => setConsentChecked(event.target.checked)} />이 그림책을 링크로 공유하는 것에 보호자 동의를 받았어요.</label>
        <button type="button" className="button primary" disabled={busy || !consentMethod || !consentChecked || data.storybook.status !== "complete"} onClick={() => void act(async () => { const next = await requestEbookLink(bookId, { teacher: true, action: "share", consentMethod, guardianConsent: true }); setData({ ...data, share: { shared: next.shared, sharedAt: next.sharedAt ?? null, consentMethod: next.consentMethod ?? null } }); setMessage("링크 공유를 켰어요."); })}>링크 공유 켜기</button>
      </div>}
      <button type="button" className="text-button" disabled={busy} onClick={() => { if (window.confirm("새 링크를 만들면 지금 링크는 더 이상 열리지 않고, 공유도 꺼져요. 바꿀까요?")) void act(async () => { const next = await requestEbookLink(bookId, { teacher: true, action: "rotate" }); window.location.replace(next.path); }); }}>새 링크로 바꾸기</button>
    </details>}
    <div className="reader-scene" style={{ "--page-ratio": storybookAspectRatio(document.format) } as CSSProperties}>
      <button className="reader-arrow" type="button" aria-label="이전 쪽" disabled={viewIndex === 0} onClick={() => navigate(-1)}>‹</button>
      <div className={`reader-spread${twoUp ? "" : " is-cover"}`} onPointerDown={event => { swipe.current = { x: event.clientX, y: event.clientY }; event.currentTarget.setPointerCapture(event.pointerId); }} onPointerCancel={() => { swipe.current = null; }} onPointerUp={event => { const start = swipe.current; swipe.current = null; if (start && Math.abs(event.clientX - start.x) > 45 && Math.abs(event.clientX - start.x) > Math.abs(event.clientY - start.y) * 1.5) navigate(event.clientX < start.x ? 1 : -1); }}>
        {twoUp ? <>{pageView(view.pages[0], "reader-left")}{pageView(view.pages[1], "reader-right")}</> : pageView(view.pages[0], "reader-right")}
        {turn && twoUp && <div key={`${turn.page}-${turn.direction}`} aria-hidden="true" className={`reader-turn ${turn.direction > 0 ? "turn-forward" : "turn-back"}`}>{pageView(turn.page)}</div>}
      </div>
      <button className="reader-arrow" type="button" aria-label="다음 쪽" disabled={viewIndex === views.length - 1} onClick={() => navigate(1)}>›</button>
    </div>
    <footer aria-live="polite">{view.label} · {viewIndex + 1} / {views.length} <small>화살표·키보드·손가락으로 책장을 넘겨요</small></footer>
  </main>;
}
