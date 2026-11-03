// Changes the page size of a PDF without rasterizing it (lib/pdf-resize.ts).
// node scripts/resize-pdf.mjs <in.pdf> <out.pdf> --size 243x248 [--bleed 3] [--mode fit|fill|stretch]
//   [--into trim|bleed] [--source-bleed keep|clip] [--background #ffffff|none] [--pages 1-3,5]
// Preset: --preset sweetbook (243x248, bleed 3, stretch, into bleed — 2026-11-03 사용자 결정).
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { parsePageRange, resizePdf } from "../lib/pdf-resize.ts";

const PRESETS = { sweetbook: { size: "243x248", bleed: "3", mode: "stretch", into: "bleed" } };
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { size: { type: "string" }, bleed: { type: "string" }, mode: { type: "string" }, into: { type: "string" }, "source-bleed": { type: "string" }, background: { type: "string" }, pages: { type: "string" }, preset: { type: "string" } },
});
const [input, output] = positionals;
const preset = values.preset ? PRESETS[values.preset] : {};
if (!input || !output || !preset) {
  console.error("사용법: node scripts/resize-pdf.mjs <입력.pdf> <출력.pdf> --size 243x248 [--bleed 3] [--mode fit|fill|stretch] [--into trim|bleed] [--source-bleed keep|clip] [--background #ffffff|none] [--pages 1-3,5] [--preset sweetbook]");
  process.exit(2);
}
const option = (key, fallback) => values[key] ?? preset[key] ?? fallback;
const [widthMm, heightMm] = String(option("size", "")).toLowerCase().split("x").map(Number);
const bytes = await readFile(input);
const background = option("background", "#ffffff");
const { PDFDocument } = await import("pdf-lib");
const pageCount = values.pages ? (await PDFDocument.load(bytes, { ignoreEncryption: true })).getPageCount() : 0;
const result = await resizePdf(bytes, {
  widthMm, heightMm,
  bleedMm: Number(option("bleed", "0")),
  mode: option("mode", "fit"),
  placeInto: option("into", "trim"),
  sourceBleed: option("source-bleed", "keep"),
  background: background === "none" ? null : background,
  pages: values.pages ? parsePageRange(values.pages, pageCount) : undefined,
});
await writeFile(output, result.bytes);
const side = (v) => `좌${v.left} 우${v.right} 위${v.top} 아래${v.bottom}`;
for (const p of result.pages) {
  console.log(`${p.page}쪽: ${p.sourceMm.join("×")}mm${p.rotation ? ` (회전 ${p.rotation}°)` : ""} → 배율 ${p.scale[0] === p.scale[1] ? p.scale[0] : p.scale.join("/")}, 그림 ${p.placedMm.join("×")}mm | 재단으로 잘리는 원본(mm) ${side(p.cutSourceMm)} | 빈칸(mm) ${side(p.gapMm)}${p.droppedAnnotations ? ` | 링크·입력칸 ${p.droppedAnnotations}개 제거` : ""}`);
}
const squash = Math.max(0, ...result.pages.map((p) => Math.abs(p.scale[0] / p.scale[1] - 1) * 100));
if (squash > 3) console.log(`주의: 그림이 가로·세로 비율로 최대 ${squash.toFixed(1)}% 눌립니다. --mode fit 또는 fill도 비교해 보세요.`);
console.log(`완료: ${output} (${result.pages.length}/${result.pageCount}쪽 변환, ${(result.bytes.length / 1024).toFixed(0)}KB)`);
