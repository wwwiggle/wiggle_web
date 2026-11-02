// Changes PDF page sizes without redrawing anything. Each page keeps its original content streams,
// images (byte-identical, no recompression) and fonts; it only gains a wrapping `q … cm … Q` and new
// Media/Crop/Bleed/Trim boxes. Runs the same in the browser and in Node (pdf-lib only).
import { PDFArray, PDFDocument, PDFName, PDFNumber, degrees, type PDFPage } from "pdf-lib";

const PT_PER_MM = 72 / 25.4;

/** fit: whole trim visible, uniform scale. fill: no gaps, uniform scale, edges cut. stretch: separate x/y scale. */
export type PdfResizeMode = "fit" | "fill" | "stretch";

export type PdfResizeOptions = {
  widthMm: number;
  heightMm: number;
  /** Bleed added on every side of the output trim box. */
  bleedMm?: number;
  mode?: PdfResizeMode;
  /** Where the source trim box lands: inside the output trim box, or stretched to the outer bleed edge. */
  placeInto?: "trim" | "bleed";
  /** "keep" shows the source's own bleed art around its trim box when there is room; "clip" cuts at the source trim. */
  sourceBleed?: "keep" | "clip";
  /** Fill colour for the whole output page behind the content (#rrggbb), or null for none. */
  background?: string | null;
  /** 1-based page numbers to convert; other pages stay as they are. Omit for every page. */
  pages?: number[];
};

export type PdfResizePageReport = {
  page: number;
  sourceMm: [number, number];
  rotation: number;
  scale: [number, number];
  /** Size of the source trim box after scaling. */
  placedMm: [number, number];
  /** Source art beyond the output trim on each side, in source millimetres: what the trim cut removes. */
  cutSourceMm: { left: number; right: number; top: number; bottom: number };
  /** Output trim area not covered by the source trim box (filled by source bleed art or the background). */
  gapMm: { left: number; right: number; top: number; bottom: number };
  /** Removed link/form annotations (they would point at the old positions). */
  droppedAnnotations: number;
};

export type PdfResizeResult = { bytes: Uint8Array; pageCount: number; pages: PdfResizePageReport[] };

type Matrix = [number, number, number, number, number, number];
const multiply = (m: Matrix, n: Matrix): Matrix => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
const num = (v: number) => String(Math.round(v * 1e6) / 1e6);
const mm = (pt: number) => Math.round(pt / PT_PER_MM * 100) / 100;
const positive = (v: number) => Math.max(0, mm(v));

function rgbFromHex(hex: string) {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) throw new Error("배경색은 #ffffff 형식으로 넣어 주세요.");
  const value = parseInt(match[1], 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255].map((c) => num(c / 255)).join(" ");
}

/** Parses "1-3, 5" into sorted unique page numbers within 1..pageCount. */
export function parsePageRange(text: string, pageCount: number) {
  const pages = new Set<number>();
  for (const part of text.split(",").map((v) => v.trim()).filter(Boolean)) {
    const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(part);
    if (!match) throw new Error(`쪽 범위를 읽지 못했어요: ${part}`);
    const from = Number(match[1]), to = Number(match[2] ?? match[1]);
    if (from < 1 || to < from || to > pageCount) throw new Error(`쪽 범위는 1~${pageCount} 안에서 넣어 주세요: ${part}`);
    for (let p = from; p <= to; p++) pages.add(p);
  }
  return [...pages].sort((a, b) => a - b);
}

export async function resizePdf(input: Uint8Array | ArrayBuffer, options: PdfResizeOptions): Promise<PdfResizeResult> {
  const { widthMm, heightMm, bleedMm = 0, mode = "fit", placeInto = "trim", sourceBleed = "keep", background = "#ffffff" } = options;
  if (![widthMm, heightMm].every((v) => Number.isFinite(v) && v >= 10 && v <= 2000)) throw new Error("가로·세로는 10~2000mm로 넣어 주세요.");
  if (!Number.isFinite(bleedMm) || bleedMm < 0 || bleedMm > 20) throw new Error("도련은 0~20mm로 넣어 주세요.");
  if (!["fit", "fill", "stretch"].includes(mode) || !["trim", "bleed"].includes(placeInto) || !["keep", "clip"].includes(sourceBleed)) throw new Error("변환 방식을 확인해 주세요.");
  const fill = background === null ? "" : rgbFromHex(background);

  let pdf: PDFDocument;
  try { pdf = await PDFDocument.load(input, { updateMetadata: false }); } catch (error) {
    throw new Error(error instanceof Error && /encrypt/i.test(error.message) ? "암호가 걸린 PDF는 바꿀 수 없어요. 암호를 푼 PDF를 넣어 주세요." : "PDF를 읽지 못했어요. 손상되지 않은 PDF인지 확인해 주세요.");
  }
  const all = pdf.getPages();
  const selected = new Set(options.pages ?? all.map((_, i) => i + 1));
  if ([...selected].some((p) => !Number.isInteger(p) || p < 1 || p > all.length)) throw new Error(`쪽 번호는 1~${all.length} 안에서 골라 주세요.`);

  const W = widthMm * PT_PER_MM, H = heightMm * PT_PER_MM, B = bleedMm * PT_PER_MM;
  const reports: PdfResizePageReport[] = [];
  for (const [index, page] of all.entries()) {
    if (selected.has(index + 1)) reports.push(resizePage(pdf, page, index + 1, { W, H, B, mode, placeInto, sourceBleed, fill }));
  }
  return { bytes: await pdf.save(), pageCount: all.length, pages: reports };
}

function resizePage(pdf: PDFDocument, page: PDFPage, pageNumber: number, o: { W: number; H: number; B: number; mode: PdfResizeMode; placeInto: "trim" | "bleed"; sourceBleed: "keep" | "clip"; fill: string }): PdfResizePageReport {
  const { W, H, B } = o, MW = W + 2 * B, MH = H + 2 * B;
  const unitValue = page.node.get(PDFName.of("UserUnit"));
  const unit = unitValue instanceof PDFNumber ? unitValue.asNumber() : 1;
  const crop = page.getCropBox(), trim = page.getTrimBox(); // pdf-lib falls back to the crop box when TrimBox is absent
  const rotation = ((page.getRotation().angle % 360) + 360) % 360;
  if (rotation % 90) throw new Error(`${pageNumber}쪽의 회전 값(${rotation}°)을 읽지 못했어요.`);
  // Source sizes are in source units; the scale below converts them, so UserUnit only matters for reporting.
  const [sw, sh] = rotation % 180 ? [trim.height, trim.width] : [trim.width, trim.height];
  const target = o.placeInto === "bleed" ? { x: 0, y: 0, w: MW, h: MH } : { x: B, y: B, w: W, h: H };
  let sx = target.w / sw, sy = target.h / sh;
  if (o.mode === "fit") sx = sy = Math.min(sx, sy);
  else if (o.mode === "fill") sx = sy = Math.max(sx, sy);
  const ox = target.x + (target.w - sw * sx) / 2, oy = target.y + (target.h - sh * sy) / 2;

  // Source trim origin → (0,0), then bake the page /Rotate in (clockwise display rotation), then scale and place.
  const rotate: Record<number, Matrix> = { 0: [1, 0, 0, 1, 0, 0], 90: [0, -1, 1, 0, 0, trim.width], 180: [-1, 0, 0, -1, trim.width, trim.height], 270: [0, 1, -1, 0, trim.height, 0] };
  const matrix = multiply([sx, 0, 0, sy, ox, oy], multiply(rotate[rotation], [1, 0, 0, 1, -trim.x, -trim.y]));
  const clip = o.sourceBleed === "clip" ? trim : crop;
  const backdrop = o.fill ? `q ${o.fill} rg 0 0 ${num(MW)} ${num(MH)} re f Q\n` : "";
  const start = pdf.context.flateStream(`${backdrop}q ${matrix.map(num).join(" ")} cm ${[clip.x, clip.y, clip.width, clip.height].map(num).join(" ")} re W n\n`);
  const end = pdf.context.flateStream("\nQ\n");
  page.node.wrapContentStreams(pdf.context.register(start), pdf.context.register(end));

  const annots = page.node.Annots();
  page.node.delete(PDFName.of("Annots"));
  page.node.delete(PDFName.of("UserUnit"));
  page.node.delete(PDFName.of("ArtBox"));
  page.setRotation(degrees(0));
  page.setMediaBox(0, 0, MW, MH);
  page.setCropBox(0, 0, MW, MH);
  page.setBleedBox(0, 0, MW, MH);
  page.setTrimBox(B, B, W, H);

  const placedW = sw * sx, placedH = sh * sy;
  const left = ox - B, bottom = oy - B, right = W - left - placedW, top = H - bottom - placedH;
  return {
    page: pageNumber,
    sourceMm: [mm(sw * unit), mm(sh * unit)],
    rotation,
    scale: [Math.round(sx / unit * 1e4) / 1e4, Math.round(sy / unit * 1e4) / 1e4],
    placedMm: [mm(placedW), mm(placedH)],
    cutSourceMm: { left: positive(-left / sx * unit), right: positive(-right / sx * unit), top: positive(-top / sy * unit), bottom: positive(-bottom / sy * unit) },
    gapMm: { left: positive(left), right: positive(right), top: positive(top), bottom: positive(bottom) },
    droppedAnnotations: annots instanceof PDFArray ? annots.size() : 0,
  };
}
