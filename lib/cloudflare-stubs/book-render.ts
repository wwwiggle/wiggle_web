// Cloudflare Workers 빌드용 대체 모듈(next.config.ts의 WIGGLE_TARGET=cloudflare).
// Workers에서는 resvg·sharp가 돌지 않아 그림책 그리기는 그리기 서버(render-service, RENDER_SERVICE_URL)가 한다.
// lib/book-render-service.ts는 RENDER_SERVICE_URL이 없을 때만 이 모듈을 부르므로, 여기까지 오면 설정이 빠진 것이다.
export { downloadResponse, feedbackFilename, printPageCount, wrapText, type BookIdentity, type PrintCoverOptions, type PrintSize, type PrintSpec } from "@/lib/book-render-shared";

function missingRenderService(): never {
  throw new Error("그림책 그리기 서버 설정(RENDER_SERVICE_URL)이 없어요. 관리자에게 알려 주세요.");
}

export const renderBookPages = async (): Promise<Buffer[]> => missingRenderService();
export const viewPdf = async (): Promise<Uint8Array> => missingRenderService();
export const printPdfs = async (): Promise<{ cover: Uint8Array; inner: Uint8Array; pageCount: number; addedPages: number }> => missingRenderService();
export const feedbackPdf = async (): Promise<Uint8Array> => missingRenderService();
