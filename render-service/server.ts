/**
 * 그림책 그리기 서버 (Cloudflare Containers에서 돈다).
 *
 * Cloudflare Workers에서는 resvg·sharp가 돌지 않아, 그림책 쪽 그리기와 PDF 만들기를 이 서버가 맡는다.
 * 그리는 코드는 앱과 같은 lib/book-render.ts다 — Vercel에서 직접 그릴 때와 결과가 같다.
 * 그림은 앱이 넘긴 저장소 키로 R2(S3 API)에서 직접 읽는다. 책 한 권 그림(최대 80MB)을 Worker 메모리로 넘기지 않으려고.
 *
 * 요청은 모두 POST JSON, 머리글 x-render-secret이 RENDER_SERVICE_SECRET과 같아야 한다.
 *   /pages        → { pages: base64 JPEG[] }
 *   /view-pdf     → application/pdf
 *   /print-pdfs   → 표지 PDF + 내지 PDF를 이어 붙인 본문, 머리글 x-cover-length·x-page-count·x-added-pages
 *   /feedback-pdf → application/pdf
 *   GET /health   → { ok: true }
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createArtworksStore, type ArtworksStore } from "../db/adapters/artworks-store.ts";
import { feedbackPdf, printPdfs, renderBookPages, viewPdf } from "../lib/book-render.ts";
import { renderSecretMatches, RENDER_SECRET_HEADER } from "../lib/book-render-service.ts";
import { validateStorybookDocument, type StorybookDocument } from "../lib/storybook-model.ts";
import { runtimeEnvironment, runtimePolicy } from "../lib/runtime/environment.ts";

const MAX_BODY_BYTES = 25_000_000;
const MAX_TOTAL_ASSET_BYTES = 80_000_000; // 앱(bookRenderSource)과 같은 한도

class RequestError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new RequestError(413, "요청이 너무 커요.");
    chunks.push(chunk as Buffer);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
  } catch {
    // 아래에서 같은 오류로 처리한다.
  }
  throw new RequestError(400, "요청 형식이 올바르지 않아요.");
}

function documentOf(body: Record<string, unknown>): StorybookDocument {
  const document = validateStorybookDocument(body.document);
  if (!document) throw new RequestError(400, "그림책 문서가 올바르지 않아요.");
  return document;
}

function widthOf(body: Record<string, unknown>) {
  const width = Number(body.width);
  if (!Number.isInteger(width) || width < 200 || width > 3000) throw new RequestError(400, "그림 크기가 올바르지 않아요.");
  return width;
}

function titleOf(body: Record<string, unknown>) {
  return typeof body.title === "string" ? body.title.slice(0, 200) : "";
}

async function loadAssets(store: ArtworksStore, body: Record<string, unknown>) {
  const keys = body.assetKeys;
  if (!keys || typeof keys !== "object" || Array.isArray(keys)) throw new RequestError(400, "그림 목록이 올바르지 않아요.");
  const assets = new Map<string, Buffer>();
  let total = 0;
  for (const [assetId, key] of Object.entries(keys)) {
    if (typeof key !== "string") throw new RequestError(400, "그림 목록이 올바르지 않아요.");
    const object = await store.get(key);
    if (!object) throw new RequestError(422, "그림책 이미지가 누락되었어요.");
    total += object.size;
    if (total > MAX_TOTAL_ASSET_BYTES) throw new RequestError(422, "이미지를 모두 읽을 수 없어요. 누락 또는 책 전체 용량(80MB)을 확인해 주세요.");
    assets.set(assetId, Buffer.from(await object.arrayBuffer()));
  }
  return assets;
}

function send(response: ServerResponse, status: number, body: Uint8Array | string, headers: Record<string, string>) {
  response.writeHead(status, { "cache-control": "no-store", ...headers });
  response.end(body);
}

const json = (response: ServerResponse, status: number, value: unknown) => send(response, status, JSON.stringify(value), { "content-type": "application/json; charset=utf-8" });
const pdf = (response: ServerResponse, bytes: Uint8Array, headers: Record<string, string> = {}) => send(response, 200, bytes, { "content-type": "application/pdf", ...headers });

export function createRenderServer({ store, secret }: { store: ArtworksStore; secret: string }): Server {
  if (!secret) throw new Error("RENDER_SERVICE_SECRET이 필요해요.");
  return createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/health") return json(response, 200, { ok: true });
      if (request.method !== "POST") throw new RequestError(405, "지원하지 않는 요청이에요.");
      if (!renderSecretMatches(secret, request.headers[RENDER_SECRET_HEADER] as string | undefined ?? null)) throw new RequestError(401, "인증되지 않은 요청이에요.");
      const body = await readJson(request);
      switch (request.url) {
        case "/pages": {
          const pages = await renderBookPages(documentOf(body), await loadAssets(store, body), widthOf(body));
          return json(response, 200, { pages: pages.map((page) => page.toString("base64")) });
        }
        case "/view-pdf": {
          const document = documentOf(body);
          return pdf(response, await viewPdf(await renderBookPages(document, await loadAssets(store, body), widthOf(body)), document.format, titleOf(body)));
        }
        case "/print-pdfs": {
          const images = await renderBookPages(documentOf(body), await loadAssets(store, body), widthOf(body));
          const result = await printPdfs(images, body.spec as never, body.size as never, titleOf(body), (body.options ?? {}) as never);
          const joined = new Uint8Array(result.cover.length + result.inner.length);
          joined.set(result.cover, 0);
          joined.set(result.inner, result.cover.length);
          return pdf(response, joined, { "x-cover-length": String(result.cover.length), "x-page-count": String(result.pageCount), "x-added-pages": String(result.addedPages) });
        }
        case "/feedback-pdf":
          return pdf(response, await feedbackPdf(body.identity as never, body.rubric as never, body.feedback as never, String(body.version ?? ""), body.options as never));
        default:
          throw new RequestError(404, "없는 주소예요.");
      }
    } catch (error) {
      if (error instanceof RequestError) return json(response, error.status, { error: error.message });
      // 그리기 코드가 던진 한국어 안내(판형·쪽 수 확인 등)는 그대로 돌려준다. 그 밖의 오류는 기록만 하고 일반 문구.
      const message = error instanceof Error && /[가-힣]/.test(error.message) ? error.message : "그림책을 그리지 못했어요.";
      if (!(error instanceof Error && /[가-힣]/.test(error.message))) console.error("render-service error", error);
      return json(response, 422, { error: message });
    }
  });
}

// 직접 실행할 때: PORT(기본 8080)에서 듣는다. 저장소·환경 경계는 앱과 같은 규칙(createArtworksStore)을 따른다.
if (import.meta.url === `file://${process.argv[1]}`) {
  const environment = runtimeEnvironment();
  const secret = process.env.RENDER_SERVICE_SECRET?.trim() ?? "";
  const server = createRenderServer({ store: createArtworksStore(environment), secret });
  const port = Number(process.env.PORT || 8080);
  server.listen(port, () => console.log(`render-service ${environment}${runtimePolicy(environment).storagePrefix ? ` (prefix ${runtimePolicy(environment).storagePrefix})` : ""} :${port}`));
}
