"use client";
import { useEffect, useRef, useState } from "react";
import type { PdfResizeMode, PdfResizeResult } from "@/lib/pdf-resize";
import "./book-workflow.css";
import "./pdf-resize-tool.css";

const PRESETS = [
  { id: "sweetbook", label: "스위트북 스퀘어북 내지 243×248 + 도련 3mm", widthMm: 243, heightMm: 248, bleedMm: 3 },
  { id: "square210", label: "정사각 210×210", widthMm: 210, heightMm: 210, bleedMm: 0 },
  { id: "a4", label: "A4 세로 210×297", widthMm: 210, heightMm: 297, bleedMm: 0 },
  { id: "a5", label: "A5 세로 148×210", widthMm: 148, heightMm: 210, bleedMm: 0 },
  { id: "custom", label: "직접 입력", widthMm: 0, heightMm: 0, bleedMm: 0 },
] as const;
const MODES: { value: PdfResizeMode; label: string; hint: string }[] = [
  { value: "fit", label: "맞춤", hint: "그림을 하나도 자르지 않고 같은 비율로 키우거나 줄입니다. 비율이 다르면 빈칸이 생깁니다." },
  { value: "fill", label: "채우기", hint: "빈칸 없이 같은 비율로 채웁니다. 비율이 다르면 가장자리가 잘립니다." },
  { value: "stretch", label: "늘리기", hint: "가로·세로를 따로 맞춰 꽉 채웁니다. 비율이 다르면 그림이 조금 찌그러집니다." },
];
type SourceInfo = { name: string; bytes: Uint8Array; pageCount: number; sizes: string };
const fileSize = (bytes: number) => bytes < 1_000_000 ? `${Math.max(1, Math.round(bytes / 1024))}KB` : `${(bytes / 1024 / 1024).toFixed(2)}MB`;
const sides = (v: { left: number; right: number; top: number; bottom: number }) => v.left + v.right + v.top + v.bottom === 0 ? "없음" : `좌 ${v.left} · 우 ${v.right} · 위 ${v.top} · 아래 ${v.bottom}`;

async function renderPage(bytes: Uint8Array, pageNumber: number, canvas: HTMLCanvasElement, trimInsetMm?: number) {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.min.mjs";
  // pdf.js transfers the buffer to its worker, so hand it a copy.
  const task = pdfjs.getDocument({ data: bytes.slice(), cMapUrl: "/pdfjs/cmaps/", cMapPacked: true, standardFontDataUrl: "/pdfjs/standard_fonts/", wasmUrl: "/pdfjs/wasm/" });
  try {
    const pdf = await task.promise;
    const page = await pdf.getPage(Math.min(Math.max(1, pageNumber), pdf.numPages));
    const base = page.getViewport({ scale: 1 }), scale = 420 * Math.min(2, window.devicePixelRatio || 1) / Math.max(base.width, base.height);
    const viewport = page.getViewport({ scale });
    canvas.width = Math.round(viewport.width); canvas.height = Math.round(viewport.height);
    const context = canvas.getContext("2d");
    if (!context) return;
    await page.render({ canvas, canvasContext: context, viewport }).promise;
    if (trimInsetMm) {
      const inset = trimInsetMm * 72 / 25.4 * scale;
      context.setLineDash([6, 4]); context.lineWidth = 1.5; context.strokeStyle = "#e0245e";
      context.strokeRect(inset, inset, canvas.width - 2 * inset, canvas.height - 2 * inset);
    }
  } finally { await task.destroy(); }
}

export function PdfResizeTool() {
  const [source, setSource] = useState<SourceInfo | null>(null);
  const [preset, setPreset] = useState<(typeof PRESETS)[number]["id"]>("sweetbook");
  const [widthMm, setWidthMm] = useState("243"), [heightMm, setHeightMm] = useState("248"), [bleedMm, setBleedMm] = useState("3");
  const [mode, setMode] = useState<PdfResizeMode>("fit");
  const [placeInto, setPlaceInto] = useState<"trim" | "bleed">("trim");
  const [sourceBleed, setSourceBleed] = useState<"keep" | "clip">("keep");
  const [background, setBackground] = useState("#ffffff"), [noBackground, setNoBackground] = useState(false);
  const [pageRange, setPageRange] = useState("");
  const [result, setResult] = useState<(PdfResizeResult & { url: string; fileName: string; bleedMm: number }) | null>(null);
  const [previewPage, setPreviewPage] = useState(1);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  const beforeCanvas = useRef<HTMLCanvasElement>(null), afterCanvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => () => { if (result) URL.revokeObjectURL(result.url); }, [result]);
  useEffect(() => {
    if (source && beforeCanvas.current) void renderPage(source.bytes, previewPage, beforeCanvas.current).catch(() => setMessage("원본 미리보기를 그리지 못했어요."));
  }, [source, previewPage]);
  useEffect(() => {
    if (result && afterCanvas.current) void renderPage(result.bytes, previewPage, afterCanvas.current, result.bleedMm).catch(() => setMessage("결과 미리보기를 그리지 못했어요."));
  }, [result, previewPage]);

  function choosePreset(id: (typeof PRESETS)[number]["id"]) {
    setPreset(id);
    const chosen = PRESETS.find((p) => p.id === id);
    if (chosen && id !== "custom") { setWidthMm(String(chosen.widthMm)); setHeightMm(String(chosen.heightMm)); setBleedMm(String(chosen.bleedMm)); }
  }

  async function chooseFile(file: File | undefined) {
    setResult(null); setMessage(""); setSource(null); setPreviewPage(1);
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".pdf") || file.size > 200_000_000) { setMessage("200MB 이하의 PDF를 골라 주세요."); return; }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const { PDFDocument } = await import("pdf-lib");
      const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true });
      if (pdf.isEncrypted) { setMessage("암호가 걸린 PDF는 바꿀 수 없어요. 암호를 푼 PDF를 넣어 주세요."); return; }
      const counts = new Map<string, number>();
      for (const page of pdf.getPages()) {
        const box = page.getTrimBox(), turned = page.getRotation().angle % 180 !== 0;
        const [w, h] = [box.width, box.height].map((v) => Math.round(v * 25.4 / 72 * 10) / 10);
        const key = turned ? `${h}×${w}mm` : `${w}×${h}mm`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      setSource({ name: file.name, bytes, pageCount: pdf.getPageCount(), sizes: [...counts].map(([size, n]) => `${size} ${n}쪽`).join(", ") });
    } catch { setMessage("PDF를 읽지 못했어요. 손상되지 않은 PDF인지 확인해 주세요."); }
  }

  async function convert() {
    if (!source) return;
    setBusy(true); setMessage("");
    try {
      const { parsePageRange, resizePdf } = await import("@/lib/pdf-resize");
      const w = Number(widthMm), h = Number(heightMm), b = Number(bleedMm);
      const converted = await resizePdf(source.bytes, {
        widthMm: w, heightMm: h, bleedMm: b, mode, placeInto, sourceBleed,
        background: noBackground ? null : background,
        pages: pageRange.trim() ? parsePageRange(pageRange, source.pageCount) : undefined,
      });
      const url = URL.createObjectURL(new Blob([converted.bytes.slice()], { type: "application/pdf" }));
      setResult({ ...converted, url, bleedMm: b, fileName: `${source.name.replace(/\.pdf$/i, "")}_${w}x${h}${b ? `_도련${b}` : ""}.pdf` });
      setMessage(`${converted.pages.length}/${converted.pageCount}쪽을 바꿨어요.`);
    } catch (e) { setResult(null); setMessage(e instanceof Error ? e.message : "바꾸지 못했어요."); }
    finally { setBusy(false); }
  }

  const changed = () => setResult(null);
  return <main className="book-desk pdf-resize-tool">
    <section className="book-panel">
      <p className="eyebrow">시험용 · 파일은 이 브라우저 밖으로 나가지 않아요</p>
      <h1>PDF 판형 바꾸기</h1>
      <p>쪽을 그림으로 다시 그리지 않고 크기만 바꿉니다. 사진은 원본 그대로, 글자와 선은 벡터 그대로 남습니다.</p>
      <label className="book-field">PDF 파일<input type="file" accept="application/pdf,.pdf" onChange={(e) => void chooseFile(e.target.files?.[0])} /></label>
      {source && <p className="book-muted">{source.name} · {source.pageCount}쪽 · {source.sizes}</p>}
    </section>

    <section className="book-panel" aria-label="변환 설정">
      <h2>바꿀 크기</h2>
      <label className="book-field">판형<select value={preset} onChange={(e) => { choosePreset(e.target.value as typeof preset); changed(); }}>{PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select></label>
      <div className="pdf-resize-sizes">
        <label className="book-field">가로(mm)<input inputMode="decimal" value={widthMm} onChange={(e) => { setWidthMm(e.target.value); setPreset("custom"); changed(); }} /></label>
        <label className="book-field">세로(mm)<input inputMode="decimal" value={heightMm} onChange={(e) => { setHeightMm(e.target.value); setPreset("custom"); changed(); }} /></label>
        <label className="book-field">도련(mm)<input inputMode="decimal" value={bleedMm} onChange={(e) => { setBleedMm(e.target.value); setPreset("custom"); changed(); }} /></label>
      </div>
      <fieldset className="pdf-resize-choice"><legend>비율이 다를 때</legend>
        {MODES.map((m) => <label key={m.value}><input type="radio" name="mode" checked={mode === m.value} onChange={() => { setMode(m.value); changed(); }} /><span><b>{m.label}</b><small>{m.hint}</small></span></label>)}
      </fieldset>
      <fieldset className="pdf-resize-choice"><legend>원본 크기를 맞출 선</legend>
        <label><input type="radio" name="into" checked={placeInto === "trim"} onChange={() => { setPlaceInto("trim"); changed(); }} /><span><b>재단선</b><small>원본 재단 크기를 새 재단 크기에 맞춥니다.</small></span></label>
        <label><input type="radio" name="into" checked={placeInto === "bleed"} onChange={() => { setPlaceInto("bleed"); changed(); }} /><span><b>도련 끝</b><small>도련 없는 원본을 도련까지 채울 때. 재단하면 도련만큼 더 잘립니다.</small></span></label>
      </fieldset>
      <fieldset className="pdf-resize-choice"><legend>원본에 도련 그림이 있으면</legend>
        <label><input type="radio" name="source-bleed" checked={sourceBleed === "keep"} onChange={() => { setSourceBleed("keep"); changed(); }} /><span><b>살려서 빈칸에 쓰기</b></span></label>
        <label><input type="radio" name="source-bleed" checked={sourceBleed === "clip"} onChange={() => { setSourceBleed("clip"); changed(); }} /><span><b>원본 재단선에서 자르기</b></span></label>
      </fieldset>
      <div className="pdf-resize-sizes">
        <label className="book-field">배경색<input type="color" value={background} disabled={noBackground} onChange={(e) => { setBackground(e.target.value); changed(); }} /></label>
        <label className="book-check pdf-resize-inline"><input type="checkbox" checked={noBackground} onChange={(e) => { setNoBackground(e.target.checked); changed(); }} />배경 칠하지 않기</label>
        <label className="book-field">쪽 범위(비우면 전부)<input placeholder="예: 1-3, 5" value={pageRange} onChange={(e) => { setPageRange(e.target.value); changed(); }} /></label>
      </div>
      <button className="button primary" disabled={!source || busy} onClick={() => void convert()}>{busy ? "바꾸는 중…" : "판형 바꾸기"}</button>
      {message && <p role="status">{message}</p>}
    </section>

    {source && <section className="book-panel" aria-label="미리보기">
      <div className="book-section-heading"><h2>미리보기</h2>
        <label className="book-field pdf-resize-inline">쪽<input type="number" min={1} max={source.pageCount} value={previewPage} onChange={(e) => setPreviewPage(Math.min(source.pageCount, Math.max(1, Number(e.target.value) || 1)))} /></label></div>
      <div className="pdf-resize-previews">
        <figure><canvas ref={beforeCanvas} /><figcaption>원본</figcaption></figure>
        <figure>{result ? <canvas ref={afterCanvas} /> : <div className="pdf-resize-empty">설정을 고르고 ‘판형 바꾸기’를 눌러 주세요.</div>}<figcaption>결과{result && result.bleedMm > 0 ? " · 분홍 점선이 재단선" : ""}</figcaption></figure>
      </div>
    </section>}

    {result && <section className="book-panel" aria-label="결과">
      <div className="book-section-heading"><h2>결과</h2><a className="button primary" href={result.url} download={result.fileName}>PDF 내려받기</a></div>
      <p className="book-muted">{result.fileName} · {fileSize(result.bytes.length)} (원본 {fileSize(source!.bytes.length)})</p>
      <div className="pdf-resize-table"><table>
        <thead><tr><th>쪽</th><th>원본</th><th>배율</th><th>그림 크기</th><th>재단으로 잘리는 원본(mm)</th><th>빈칸(mm)</th></tr></thead>
        <tbody>{result.pages.map((p) => <tr key={p.page}><td>{p.page}{p.rotation ? ` (${p.rotation}°)` : ""}</td><td>{p.sourceMm.join("×")}</td><td>{p.scale[0] === p.scale[1] ? p.scale[0] : p.scale.join(" / ")}</td><td>{p.placedMm.join("×")}</td><td>{sides(p.cutSourceMm)}</td><td>{sides(p.gapMm)}{p.droppedAnnotations ? ` · 링크 ${p.droppedAnnotations}개 제거` : ""}</td></tr>)}</tbody>
      </table></div>
      <p className="book-muted">배율이 1보다 크면 사진의 실제 해상도(ppi)가 그만큼 낮아지고, 작으면 높아집니다. 사진 데이터 자체는 바뀌지 않습니다.</p>
    </section>}
  </main>;
}
