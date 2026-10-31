// 그림책 렌더링의 가벼운 부분: 타입, 쪽 수 계산, 다운로드 응답, 줄 나누기.
// 무거운 그리기(resvg·sharp)는 lib/book-render.ts에 있고, Cloudflare 이사 뒤에는 그리기 서버(render-service)에서만 돈다.
// 웹 서버 코드는 이 파일을 불러 무거운 모듈이 번들에 끌려 들어가지 않게 한다.

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

export type BookIdentity = { grade: number | null; classNumber: number | null; seatNumber: number | null; realName: string | null; title: string };
export function feedbackFilename(identity: BookIdentity) {
  const safe = (s: string) => s.normalize("NFC").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/g, "").slice(0, 65) || "제목없음";
  return `${identity.seatNumber ? identity.seatNumber + "_" : ""}${safe(identity.realName || "학생")}_${safe(identity.title)}_피드백.pdf`;
}
export function downloadResponse(bytes: Uint8Array, filename: string, contentType = "application/pdf") {
  return new Response(new Uint8Array(bytes), { headers: { "content-type": contentType, "cache-control": "private, no-store", "content-disposition": `attachment; filename="download.pdf"; filename*=UTF-8''${encodeURIComponent(filename)}`, "x-content-type-options": "nosniff" } });
}

export type PrintSize = { coverWidthMm: number; coverHeightMm: number; innerWidthMm: number; innerHeightMm: number; spineWidthMm: number };
export type PrintSpec = { bookSpecUid: string; name: string; pageMin: number; pageMax: number; pageIncrement: number; bindingType: string; innerTrimWidthMm: number; innerTrimHeightMm: number; hingeGapMm?: number; caseWrapMarginMm?: number; bleedMm?: number };
export function printPageCount(original: number, spec: PrintSpec) {
  if (![spec.pageMin, spec.pageMax, spec.pageIncrement].every((n) => Number.isInteger(n) && n > 0) || spec.pageMax > 500) throw new Error("제작사의 페이지 규격을 확인하지 못했어요.");
  const count = Math.ceil(Math.max(original, spec.pageMin) / spec.pageIncrement) * spec.pageIncrement;
  if (count > spec.pageMax) throw new Error("선택한 판형의 최대 쪽 수를 넘었어요.");
  return count;
}
export type PrintCoverOptions = { backCover?: boolean; spine?: { title: string; author: string; publisher?: string } };
