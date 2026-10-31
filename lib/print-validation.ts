import { PDFDocument, PDFName, PDFNumber } from "pdf-lib";
import type { PrintSize, PrintSpec } from "@/lib/book-render-shared";
export type PrintLayout = { spec: PrintSpec; size: PrintSize; pageCount: number; originalPages?: number; addedPages?: number };
export type PageMeasurement = { page: number; widthMm: number; heightMm: number };
export async function validatePrintPdf(bytes: Uint8Array, kind: "cover" | "inner", layout: PrintLayout) {
  if (!bytes.length || bytes.length > 30_000_000 || !Buffer.from(bytes.subarray(0, 8)).toString().startsWith("%PDF-")) throw new Error("PDF 파일은 30MB 이하여야 해요.");
  let pdf: PDFDocument;
  try { pdf = await PDFDocument.load(bytes); } catch { throw new Error("암호가 없고 손상되지 않은 PDF를 넣어 주세요."); }
  const expectedCount = kind === "cover" ? 1 : layout.pageCount / (layout.spec.bindingType.toUpperCase() === "LAYFLAT" ? 2 : 1);
  const width = kind === "cover" ? layout.size.coverWidthMm : layout.size.innerWidthMm;
  const height = kind === "cover" ? layout.size.coverHeightMm : layout.size.innerHeightMm;
  if (![width, height].every((n) => Number.isFinite(n) && n > 0 && n < 2000)) throw new Error("제작사의 페이지 크기를 확인하지 못했어요.");
  if (pdf.getPageCount() !== expectedCount) throw new Error(`${kind === "cover" ? "표지" : "내지"}는 PDF ${expectedCount}페이지여야 해요. 현재 ${pdf.getPageCount()}페이지입니다.`);
  const measurements: PageMeasurement[] = [];
  for (const [i, page] of pdf.getPages().entries()) {
    const unit = page.node.get(PDFName.of("UserUnit"));
    if (unit && (!(unit instanceof PDFNumber) || unit.asNumber() !== 1)) throw new Error(`${i + 1}페이지의 PDF 단위를 기본값(1)으로 저장해 주세요.`);
    const box = page.getMediaBox(), crop = page.getCropBox();
    const w = box.width * 25.4 / 72, h = box.height * 25.4 / 72;
    if (page.getRotation().angle % 360 !== 0 || Math.abs(w - width) > 1 || Math.abs(h - height) > 1 || [crop.x - box.x, crop.y - box.y, crop.width - box.width, crop.height - box.height].some((v) => Math.abs(v) > 0.1)) throw new Error(`${kind === "cover" ? "표지" : "내지"} ${i + 1}페이지: ${w.toFixed(2)} × ${h.toFixed(2)}mm. 필요한 크기는 ${width} × ${height}mm입니다. 회전·잘림 없이 규격에 맞춰야 주문할 수 있어요 (제작사 허용 오차 ±1mm).`);
    measurements.push({ page: i + 1, widthMm: Math.round(w * 100) / 100, heightMm: Math.round(h * 100) / 100 });
  }
  return measurements;
}
