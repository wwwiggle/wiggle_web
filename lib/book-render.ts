import { assertBookPrintSpec, assertBookPrintSize } from "@/lib/book-print-format";
import "server-only";
import { readFile } from "node:fs/promises";
import { Resvg } from "@resvg/resvg-js";
import sharp from "sharp";
import { degrees, PDFDocument, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { storybookAspectRatio, type StorybookDocument } from "@/lib/storybook-model";
import { spineFontSizeMm } from "@/lib/storybook-structure";
import type { BookFeedback, Rubric } from "@/lib/book-rubric";
import { defaultFeedbackExport, feedbackExportContent, type FeedbackExportOptions } from "@/lib/feedback-export";
import { fittedStoryText, STORY_TEXT_LINE_HEIGHT } from "@/lib/storybook-text";

export const FONT_PATH = `${process.cwd()}/public/fonts/NanumGothic-Regular.ttf`;
const escape = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
export function wrapText(text: string, width: number, measure: (s: string) => number) {
  const lines: string[] = [];
  for (const paragraph of text.replace(/\r/g, "").split("\n")) {
    let line = "";
    for (const char of paragraph) {
      if (line && measure(line + char) > width) { lines.push(line); line = ""; }
      line += char;
    }
    lines.push(line);
  }
  return lines;
}

// Uses the saved geometry, z-order, opacity, rotation and crop; never a text-only assessment.
export async function renderBookPages(document: StorybookDocument, assets: Map<string, Buffer>, width = 1200) {
  const ratio = storybookAspectRatio(document.format);
  const height = Math.round(width / ratio);
  const pdf = await PDFDocument.create(); pdf.registerFontkit(fontkit);
  const font = await pdf.embedFont(await readFile(FONT_PATH), { subset: false });
  const dataUrls = new Map<string, string>();
  for (const [id, data] of assets) dataUrls.set(id, `data:image/png;base64,${(await sharp(data).resize({ width: 2400, height: 2400, fit: "inside", withoutEnlargement: true }).png().toBuffer()).toString("base64")}`);
  function image(id: string) { const url = dataUrls.get(id); if (!url) throw new Error("그림책의 이미지가 누락되었어요. 원본을 확인해 주세요."); return url; }
  const result: Buffer[] = [];
  for (const page of document.pages) {
    let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="${page.background}"/>`;
    if (page.backgroundAssetId) svg += `<image href="${image(page.backgroundAssetId)}" width="${width}" height="${height}" preserveAspectRatio="xMidYMid slice"/>`;
    for (const el of [...page.elements].sort((a, b) => (a.type === "text" ? 10002 : a.zIndex) - (b.type === "text" ? 10002 : b.zIndex))) {
      const x = el.x * width, y = el.y * height, w = el.width * width, h = el.height * height;
      if (el.type === "image" && el.assetId) {
        const crop = el.crop;
        svg += `<g opacity="${el.opacity}" transform="rotate(${el.rotation} ${x + w / 2} ${y + h / 2})"><svg x="${x}" y="${y}" width="${w}" height="${h}" overflow="hidden"><image href="${image(el.assetId)}" x="${crop ? -crop.x / crop.width * w : 0}" y="${crop ? -crop.y / crop.height * h : 0}" width="${crop ? w / crop.width : w}" height="${crop ? h / crop.height : h}" preserveAspectRatio="${crop ? "none" : "xMidYMid meet"}"/></svg></g>`;
      } else if (el.type === "text") {
        const { size, lines } = fittedStoryText(el.text === "여기에 이야기를 써 보세요" ? "" : el.text ?? "", (el.fontSize ?? 0.045) * width, w - width * 4 / 1024, h - width * 4 / 1024, (s, fontSize) => font.widthOfTextAtSize(s, fontSize));
        const spare = Math.max(0, h - width * 4 / 1024 - lines.length * size * STORY_TEXT_LINE_HEIGHT);
        const offset = el.verticalAlign === "top" ? 0 : el.verticalAlign === "bottom" ? spare : spare / 2;
        const anchor = el.align === "center" ? "middle" : el.align === "right" ? "end" : "start";
        const textX = el.align === "center" ? w / 2 : el.align === "right" ? w - width * 2 / 1024 : width * 2 / 1024;
        svg += `<svg x="${x}" y="${y}" width="${w}" height="${h}"><text font-family="NanumGothic" font-size="${size}" fill="${el.color}" text-anchor="${anchor}">${lines.map((s, i) => `<tspan x="${textX}" y="${offset + width * 2 / 1024 + size + i * size * STORY_TEXT_LINE_HEIGHT}">${escape(s)}</tspan>`).join("")}</text></svg>`;
      }
    }
    svg += "</svg>";
    const png = new Resvg(svg, { font: { fontFiles: [FONT_PATH], loadSystemFonts: false, defaultFontFamily: "NanumGothic" } }).render().asPng();
    result.push(await sharp(png).jpeg({ quality: 92 }).toBuffer());
  }
  return result;
}

export type BookIdentity = { grade: number | null; classNumber: number | null; seatNumber: number | null; realName: string | null; title: string };
export function feedbackFilename(identity: BookIdentity) {
  const safe = (s: string) => s.normalize("NFC").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/g, "").slice(0, 65) || "제목없음";
  return `${identity.seatNumber ? identity.seatNumber + "_" : ""}${safe(identity.realName || "학생")}_${safe(identity.title)}_피드백.pdf`;
}
export function downloadResponse(bytes: Uint8Array, filename: string, contentType = "application/pdf") {
  return new Response(new Uint8Array(bytes), { headers: { "content-type": contentType, "cache-control": "private, no-store", "content-disposition": `attachment; filename="download.pdf"; filename*=UTF-8''${encodeURIComponent(filename)}`, "x-content-type-options": "nosniff" } });
}

export async function feedbackPdf(identity: BookIdentity, rubric: Rubric, feedback: BookFeedback, version: string, options: FeedbackExportOptions = defaultFeedbackExport(rubric)) {
  feedbackFilename(identity);
  const pdf = await PDFDocument.create(); pdf.registerFontkit(fontkit);
  const font = await pdf.embedFont(await readFile(FONT_PATH), { subset: false });
  pdf.setTitle(`${identity.title} - ${rubric.title}`);
  let page = pdf.addPage([595.28, 841.89]); let y = 0;
  const ink = rgb(.13, .15, .20), purple = rgb(.39, .22, .80), pale = rgb(.966, .952, .995);
  function header() {
    page.drawRectangle({ x: 36, y: 724, width: 523, height: 81, color: pale });
    page.drawRectangle({ x: 36, y: 803, width: 523, height: 3, color: purple });
    page.drawText(`${identity.seatNumber ? identity.seatNumber + "번 " : ""}${identity.realName || "학생"}`, { x: 48, y: 780, font, size: 10, color: ink });
    page.drawText("그림책 피드백", { x: 48, y: 751, font, size: 19, color: purple });
    y = 699;
  }
  function textBlock(text: string, size: number, color = ink, gap = 8) {
    for (const line of wrapText(text, 495, (s) => font.widthOfTextAtSize(s, size))) {
      if (y < 65) { page = pdf.addPage([595.28, 841.89]); header(); }
      page.drawText(line, { x: 50, y, font, size, color }); y -= size * 1.6;
    }
    y -= gap;
  }
  const content = feedbackExportContent(rubric, feedback, options);
  header(); textBlock(identity.title, 13); textBlock(rubric.title, 10); textBlock("선생님 피드백 · AI 초안 (교사 검토용)", 9);
  content.criteria.forEach((criterion, index) => {
    const item = criterion.result;
    if (y < 135) { page = pdf.addPage([595.28, 841.89]); header(); }
    textBlock(`${index + 1}. ${criterion.name}${options.scores ? `   ${item.score} / ${Math.max(...criterion.levels.map(l => l.score))}점` : ""}`, 10, purple, 3);
    textBlock(item.feedback, 10, ink, 7);
    if (options.pages) textBlock(`근거: ${item.pages.join(", ")}쪽`, 9);
  });
  if (options.scores && content.criteria.length) textBlock(`${content.partial ? "선택 영역 합계" : "총점"} ${content.total} / ${content.maximum}점`, 12, purple);
  if (options.summary) { textBlock("종합 의견 · 다음에 해 볼 일", 12, purple); textBlock(feedback.summary, 10); }
  pdf.getPages().forEach((p, i) => p.drawText(`루브릭 ${version.slice(0, 12)}   ·   ${i + 1} / ${pdf.getPageCount()}`, { x: 40, y: 32, font, size: 8, color: rgb(.5, .5, .55) }));
  return pdf.save();
}

export type PrintSize = { coverWidthMm: number; coverHeightMm: number; innerWidthMm: number; innerHeightMm: number; spineWidthMm: number };
export type PrintSpec = { bookSpecUid: string; name: string; pageMin: number; pageMax: number; pageIncrement: number; bindingType: string; innerTrimWidthMm: number; innerTrimHeightMm: number; hingeGapMm?: number; caseWrapMarginMm?: number; bleedMm?: number };
export function printPageCount(original: number, spec: PrintSpec) {
  if (![spec.pageMin, spec.pageMax, spec.pageIncrement].every((n) => Number.isInteger(n) && n > 0) || spec.pageMax > 500) throw new Error("제작사의 페이지 규격을 확인하지 못했어요.");
  const count = Math.ceil(Math.max(original, spec.pageMin) / spec.pageIncrement) * spec.pageIncrement;
  if (count > spec.pageMax) throw new Error("선택한 판형의 최대 쪽 수를 넘었어요.");
  return count;
}
/** Rendered page order: images[0] is the front cover; with backCover the last image is the back cover. */
export type PrintCoverOptions = { backCover?: boolean; spine?: { title: string; author: string; publisher?: string } };
export async function printPdfs(images: Buffer[], spec: PrintSpec, size: PrintSize, title: string, options: PrintCoverOptions = {}) {
  assertBookPrintSpec(spec);
  const backImage = options.backCover && images.length > 1 ? images[images.length - 1] : undefined;
  const innerImages = images.slice(1, backImage ? -1 : undefined);
  const count = printPageCount(innerImages.length, spec);
  assertBookPrintSize(size, count);
  const pt = (mm: number) => mm * 72 / 25.4;
  if (![size.coverWidthMm, size.coverHeightMm, size.innerWidthMm, size.innerHeightMm, spec.innerTrimWidthMm, spec.innerTrimHeightMm].every((n) => Number.isFinite(n) && n > 0 && n < 2000)) throw new Error("인쇄 크기 응답이 올바르지 않아요.");
  const inner = await PDFDocument.create(), cover = await PDFDocument.create();
  inner.setTitle(title); cover.setTitle(`${title} 표지`);
  const spread = spec.bindingType.toUpperCase() === "LAYFLAT";
  for (let i = 0; i < count; i += spread ? 2 : 1) {
    const p = inner.addPage([pt(size.innerWidthMm), pt(size.innerHeightMm)]);
    for (let j = 0; j < (spread ? 2 : 1); j++) {
      const src = innerImages[i + j];
      p.setTrimBox(pt(3), pt(3), pt(243), pt(248));
      p.setBleedBox(0, 0, p.getWidth(), p.getHeight());
      if (!src) continue;
      // Fit the saved page inside the trim without distortion. Extend its edge pixels
      // through the 3mm bleed, so trimming cannot expose an accidental white border.
      const trimW = 2430, trimH = 2480, bleed = 30;
      const trimmed = await sharp(src).resize(trimW, trimH, { fit: "contain", background: "#ffffff" }).extend({ top: bleed, bottom: bleed, left: bleed, right: bleed, extendWith: "copy" }).jpeg({ quality: 95 }).toBuffer();
      const full = await inner.embedJpg(trimmed);
      p.drawImage(full, { x: 0, y: 0, width: p.getWidth(), height: p.getHeight() });
      p.setTrimBox(pt(3), pt(3), pt(243), pt(248));
      p.setBleedBox(0, 0, p.getWidth(), p.getHeight());
    }
  }
  const p = cover.addPage([pt(size.coverWidthMm), pt(size.coverHeightMm)]);
  p.drawRectangle({ x: 0, y: 0, width: p.getWidth(), height: p.getHeight(), color: rgb(.96, .94, .89) });
  const hinge = spec.hingeGapMm ?? 0;
  // Spread layout: back cover (left) | spine | front cover (right). Panels are centred around the
  // spine; artwork remains within trim and a 10mm safety margin.
  const panelW = pt(spec.innerTrimWidthMm), panelH = pt(spec.innerTrimHeightMm);
  const center = p.getWidth() / 2, spineHalf = pt(size.spineWidthMm / 2 + hinge);
  for (const [src, x] of [[images[0], center + spineHalf], [backImage, center - spineHalf - panelW]] as const) {
    if (!src) continue;
    const img = await cover.embedJpg(src), margin = pt(10);
    const scale = Math.min((panelW - margin * 2) / img.width, (panelH - margin * 2) / img.height);
    p.drawImage(img, { x: x + (panelW - img.width * scale) / 2, y: (p.getHeight() - img.height * scale) / 2, width: img.width * scale, height: img.height * scale });
  }
  const spineFont = spineFontSizeMm(size.spineWidthMm);
  const spineText = [options.spine?.title, options.spine?.author].map(value => value?.trim() ?? "").filter(Boolean).join("   ");
  const publisher = options.spine?.publisher?.trim() ?? "";
  if (spineFont && (spineText || publisher)) {
    cover.registerFontkit(fontkit);
    const font = await cover.embedFont(await readFile(FONT_PATH), { subset: true });
    const color = rgb(0.16, 0.2, 0.18);
    // Korean spines read top to bottom: the baseline runs downward along the spine centre line.
    // 제목·지은이는 가운데, 펴낸 곳(Ficture)은 아래쪽 끝에 둔다.
    const top = (p.getHeight() + panelH) / 2 - pt(12), bottom = (p.getHeight() - panelH) / 2 + pt(12);
    let publisherTop = bottom;
    if (publisher) {
      const size = pt(spineFont) * 0.8, width = font.widthOfTextAtSize(publisher, size);
      publisherTop = bottom + width;
      p.drawText(publisher, { x: center - size * 0.36, y: publisherTop, size, font, color, rotate: degrees(-90) });
      publisherTop += pt(8);
    }
    if (spineText) {
      const available = top - publisherTop;
      let fontSize = pt(spineFont);
      while (fontSize > pt(2.5) && font.widthOfTextAtSize(spineText, fontSize) > available) fontSize *= 0.92;
      const textWidth = Math.min(available, font.widthOfTextAtSize(spineText, fontSize));
      p.drawText(spineText, { x: center - fontSize * 0.36, y: (top + publisherTop + textWidth) / 2, size: fontSize, font, color, rotate: degrees(-90) });
    }
  }
  return { cover: await cover.save(), inner: await inner.save(), pageCount: count, addedPages: count - innerImages.length };
}

/** Screen/download PDF: every page at the book's own proportions (243 × 248mm), no headers, footers or page numbers. */
export async function viewPdf(images: Buffer[], format: StorybookDocument["format"], title: string) {
  const pt = (mm: number) => mm * 72 / 25.4;
  const width = 243, height = format === "squarebook-hc" ? 248 : Math.round(243 / storybookAspectRatio(format) * 100) / 100;
  const pdf = await PDFDocument.create();
  pdf.setTitle(title || "그림책"); pdf.setCreator("Wiggle"); pdf.setProducer("Wiggle");
  for (const image of images) {
    const page = pdf.addPage([pt(width), pt(height)]);
    const embedded = await pdf.embedJpg(image);
    page.drawImage(embedded, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });
  }
  return pdf.save();
}
