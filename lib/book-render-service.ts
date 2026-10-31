/**
 * 그림책 그리기·PDF 만들기를 어디서 할지 고른다.
 *
 * - RENDER_SERVICE_URL이 없으면(지금 Vercel·로컬·테스트) 이 서버 안에서 lib/book-render.ts로 직접 그린다.
 * - 있으면 그리기 서버(render-service/, Cloudflare Containers)에 맡긴다. Cloudflare Workers에서는 resvg·sharp가 돌지 않고,
 *   책 한 권의 그림(최대 80MB)을 Worker 메모리(128MB)에 모으면 터질 수 있어서다. 그리기 서버는 그림을 저장소에서 직접 읽는다.
 * 어느 쪽이든 같은 lib/book-render.ts가 그리므로 결과가 같다(tests/render-service.test.mjs).
 */
import "server-only";
import { timingSafeEqual } from "node:crypto";
import type { StorybookDocument } from "@/lib/storybook-model";
import type { BookFeedback, Rubric } from "@/lib/book-rubric";
import type { FeedbackExportOptions } from "@/lib/feedback-export";
import type { BookIdentity, PrintCoverOptions, PrintSize, PrintSpec } from "@/lib/book-render-shared";

/** 그릴 책: 검증된 문서와, 문서가 쓰는 그림 ID → 저장소 키. */
export type BookRenderSource = { document: StorybookDocument; assetKeys: Record<string, string> };
export type PrintPdfs = { cover: Uint8Array; inner: Uint8Array; pageCount: number; addedPages: number };

export const RENDER_SECRET_HEADER = "x-render-secret";
const TIMEOUT_MS = 170_000;

type Config = { url: string; secret: string; fetch: typeof fetch };
let override: Config | null | undefined;

/** 테스트가 그리기 서버 길을 강제로 켤 때만 쓴다. */
export function setRenderServiceForTests(config: Config | null | undefined) {
  override = config;
}

function config(): Config | null {
  if (override !== undefined) return override;
  const url = process.env.RENDER_SERVICE_URL?.trim();
  if (!url) return null;
  const secret = process.env.RENDER_SERVICE_SECRET?.trim();
  if (!secret) throw new Error("RENDER_SERVICE_SECRET이 설정되지 않았어요.");
  return { url: url.replace(/\/+$/, ""), secret, fetch };
}

async function call(path: string, body: unknown): Promise<Response> {
  const service = config()!;
  const response = await service.fetch(`${service.url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", [RENDER_SECRET_HEADER]: service.secret },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) {
    const message = await response.json().then((data) => (data as { error?: string }).error, () => undefined);
    // 그리기 서버가 돌려준 한국어 안내는 그대로 보여 준다(그림 누락·용량 초과 등). 나머지는 일반 문구.
    throw new Error(message && /[가-힣]/.test(message) ? message : `그림책을 그리지 못했어요(${response.status}). 잠시 뒤 다시 해 주세요.`);
  }
  return response;
}

async function loadAssets(source: BookRenderSource) {
  const { bindings } = await import("@/db/runtime");
  const assets = new Map<string, Buffer>();
  for (const [assetId, key] of Object.entries(source.assetKeys)) {
    const object = await bindings().ARTWORKS.get(key);
    if (!object) throw new Error("그림책 이미지가 누락되었어요.");
    assets.set(assetId, Buffer.from(await object.arrayBuffer()));
  }
  return assets;
}

// 무거운 모듈은 직접 그릴 때만 불러온다. 그리기 서버를 쓰는 배포에서는 끌려 들어오지 않게 한다.
const renderer = () => import("@/lib/book-render");

/** 쪽마다 JPEG. AI 피드백이 쪽 그림을 볼 때 쓴다. */
export async function bookPageImages(source: BookRenderSource, width: number): Promise<Buffer[]> {
  if (!config()) return (await renderer()).renderBookPages(source.document, await loadAssets(source), width);
  const { pages } = await (await call("/pages", { ...source, width })).json() as { pages: string[] };
  return pages.map((page) => Buffer.from(page, "base64"));
}

/** 화면·내려받기용 PDF(판형 비율 그대로). */
export async function bookViewPdf(source: BookRenderSource, width: number, title: string): Promise<Uint8Array> {
  if (!config()) {
    const { renderBookPages, viewPdf } = await renderer();
    return viewPdf(await renderBookPages(source.document, await loadAssets(source), width), source.document.format, title);
  }
  return new Uint8Array(await (await call("/view-pdf", { ...source, width, title })).arrayBuffer());
}

/** 제작사에 보낼 표지·내지 PDF. */
export async function bookPrintPdfs(source: BookRenderSource, width: number, spec: PrintSpec, size: PrintSize, title: string, options: PrintCoverOptions): Promise<PrintPdfs> {
  if (!config()) {
    const { renderBookPages, printPdfs } = await renderer();
    return printPdfs(await renderBookPages(source.document, await loadAssets(source), width), spec, size, title, options);
  }
  // 표지·내지를 한 응답에 이어 붙여 받는다(base64로 부풀리지 않게). 길이와 쪽 수는 머리글에 온다.
  const response = await call("/print-pdfs", { ...source, width, spec, size, title, options });
  const bytes = new Uint8Array(await response.arrayBuffer());
  const coverLength = Number(response.headers.get("x-cover-length"));
  if (!Number.isSafeInteger(coverLength) || coverLength <= 0 || coverLength >= bytes.length) throw new Error("그리기 서버 응답이 올바르지 않아요.");
  return {
    cover: bytes.slice(0, coverLength),
    inner: bytes.slice(coverLength),
    pageCount: Number(response.headers.get("x-page-count")),
    addedPages: Number(response.headers.get("x-added-pages")),
  };
}

/** 그림책 피드백 PDF. 글꼴 파일을 읽어야 해서 Workers에서는 그리기 서버가 만든다. */
export async function bookFeedbackPdf(identity: BookIdentity, rubric: Rubric, feedback: BookFeedback, version: string, options: FeedbackExportOptions): Promise<Uint8Array> {
  if (!config()) return (await renderer()).feedbackPdf(identity, rubric, feedback, version, options);
  return new Uint8Array(await (await call("/feedback-pdf", { identity, rubric, feedback, version, options })).arrayBuffer());
}

/** 그리기 서버 쪽 비밀 확인. 길이가 달라도 같은 시간에 거절한다. */
export function renderSecretMatches(expected: string, given: string | null) {
  if (!expected || !given) return false;
  const a = Buffer.from(expected), b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}
