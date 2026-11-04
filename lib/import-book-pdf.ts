import { emptyStorybookDocument, DEFAULT_STORYBOOK_FORMAT, storybookAspectRatio } from "@/lib/storybook-model";
import { postJson } from "@/app/components/book-workflow-client";

async function importRequest<T>(url: string, init: RequestInit): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, { cache: "no-store", ...init });
    if (response.status === 429 && attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, 60_000));
      continue;
    }
    const data = await response.json() as T & { error?: string };
    if (!response.ok) throw new Error(data.error ?? "PDF를 가져오지 못했어요.");
    return data;
  }
}

/** 책의 지은이: 학급 명단에서 고른 학생, 또는 그림책 공방에서 적은 이름(서버가 명단 자리를 찾거나 만든다). */
export type ImportAuthor = { studentId: string } | { authorName: string };

/**
 * PDF는 브라우저 안에서 쪽마다 그림으로 바꿔 올리므로 서버 요청 크기와 상관이 없다. 2026-11-04 실제 학교 그림책 18권 중
 * 7권이 30MB를 넘어(최대 214MB) 한도를 올렸다. 아주 큰 파일은 브라우저 메모리가 버거울 수 있어 300MB에서 멈춘다.
 */
export const MAX_IMPORT_PDF_BYTES = 300_000_000;
export const MAX_IMPORT_IMAGES = 130;

type DrawPage = (context: CanvasRenderingContext2D, width: number, height: number) => Promise<void>;

/** 쪽마다 캔버스에 그린 그림을 책의 배경으로 올리고, 쪽을 올릴 때마다 초안으로 저장한다. */
async function importPages(label: string, pageCount: number, drawPage: (n: number) => DrawPage, classroomId: string, author: ImportAuthor, title: string, progress: (text: string) => void, onBookId: (id: string) => void) {
  const format = DEFAULT_STORYBOOK_FORMAT;
  const targetRatio = storybookAspectRatio(format);
  const doc = emptyStorybookDocument(format); doc.pages = [];
  const bookId = `storybook_${crypto.randomUUID().replaceAll("-", "")}`;
  await importRequest("/api/teacher/book-import", postJson({ classroomId, ...author, title, format, pageCount, bookId }));
  onBookId(bookId);
  let revision = 0;
  for (let n = 1; n <= pageCount; n++) {
    progress(`${label} · ${n}/${pageCount}쪽 가져오는 중`);
    const width = Math.round(2400 * Math.min(1, targetRatio)), height = Math.round(width / targetRatio);
    const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
    const context = canvas.getContext("2d"); if (!context) throw new Error("그림을 준비할 수 없어요.");
    context.fillStyle = "#ffffff"; context.fillRect(0, 0, width, height);
    await drawPage(n)(context, width, height);
    let blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    // Bound each request below Vercel's body limit. Very detailed scans are downsampled, never cropped.
    while (blob && blob.size > 3_500_000 && canvas.width > 1000) {
      const small = document.createElement("canvas"); small.width = Math.round(canvas.width * .8); small.height = Math.round(canvas.height * .8);
      small.getContext("2d")!.drawImage(canvas, 0, 0, small.width, small.height);
      canvas.width = small.width; canvas.height = small.height; context.drawImage(small, 0, 0);
      blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    }
    if (!blob || blob.size > 3_500_000) throw new Error("한 쪽의 이미지가 너무 커요. 해상도를 줄여 다시 올려 주세요.");
    const { asset } = await importRequest<{ asset: { id: string } }>(`/api/teacher/book-editor/${bookId}/assets`, { method: "POST", headers: { "content-type": "image/png" }, body: blob });
    const imported = emptyStorybookDocument(format, `page_${crypto.randomUUID().replaceAll("-", "")}`, `element_${crypto.randomUUID().replaceAll("-", "")}`).pages[0];
    imported.backgroundAssetId = asset.id; imported.elements[0].text = ""; doc.pages.push(imported);
    // Save each successful page as a recoverable draft, but expose feedback/order only after all pages exist.
    const saved = await importRequest<{ revision: number }>(`/api/teacher/book-editor/${bookId}`, postJson({ requestId: `import_${crypto.randomUUID().replaceAll("-", "")}`, expectedRevision: revision, title, document: doc, complete: n === pageCount }, "PUT"));
    revision = saved.revision; canvas.width = canvas.height = 1;
  }
  return bookId;
}

function importFailure(error: unknown, bookId: string, fallback: string) {
  const message = error instanceof Error ? error.message : fallback;
  return new Error(`${message}${bookId ? " 가져온 쪽은 아래 ‘편집 중인 책’에 보관됩니다." : ""}`);
}

export async function importBookPdf(file: File, classroomId: string, author: ImportAuthor | string, title: string, progress: (text: string) => void) {
  if (!file.name.toLowerCase().endsWith(".pdf") || file.size < 5 || file.size > MAX_IMPORT_PDF_BYTES) throw new Error("300MB 이하의 PDF를 선택해 주세요.");
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.min.mjs";
  const task = pdfjs.getDocument({ data: await file.arrayBuffer(), cMapUrl: "/pdfjs/cmaps/", cMapPacked: true, standardFontDataUrl: "/pdfjs/standard_fonts/", wasmUrl: "/pdfjs/wasm/" });
  let bookId = "";
  try {
    const pdf = await task.promise;
    if (!Number.isSafeInteger(pdf.numPages) || pdf.numPages < 1) throw new Error("PDF에 가져올 쪽이 없어요.");
    return await importPages(file.name, pdf.numPages, (n) => async (context, width, height) => {
      const page = await pdf.getPage(n), native = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.min(width / native.width, height / native.height) });
      await page.render({ canvas: context.canvas, canvasContext: context, viewport, transform: [1, 0, 0, 1, (width - viewport.width) / 2, (height - viewport.height) / 2], background: "rgba(0,0,0,0)" }).promise;
      page.cleanup();
    }, classroomId, typeof author === "string" ? { studentId: author } : author, title, progress, (id) => { bookId = id; });
  } catch (error) {
    const failure = importFailure(error, bookId, "PDF를 읽지 못했어요.");
    if (!bookId) failure.message += " 암호·손상 여부를 확인해 주세요.";
    throw failure;
  } finally { await task.destroy(); }
}

/**
 * 그림책 공방(2026-11-04): 아이들 그림 사진·스캔 여러 장을 한 번에 올리면 한 장이 한 쪽인 새 책이 된다.
 * 사진은 자르지 않고 쪽 안에 맞춰 넣고(남는 곳은 흰색), 휴대폰 사진의 회전 정보(EXIF)는 브라우저가 반영한다.
 */
export async function importBookImages(files: File[], classroomId: string, author: ImportAuthor, title: string, progress: (text: string) => void) {
  const images = files.filter((file) => file.type.startsWith("image/"));
  if (!images.length) throw new Error("사진이나 스캔 이미지를 골라 주세요.");
  if (images.length > MAX_IMPORT_IMAGES) throw new Error(`한 책에 ${MAX_IMPORT_IMAGES}장까지 올릴 수 있어요.`);
  let bookId = "";
  try {
    return await importPages(`${title}`, images.length, (n) => async (context, width, height) => {
      const bitmap = await createImageBitmap(images[n - 1], { imageOrientation: "from-image" }).catch(() => { throw new Error(`${images[n - 1].name}을(를) 열지 못했어요.`); });
      const scale = Math.min(width / bitmap.width, height / bitmap.height);
      const w = bitmap.width * scale, h = bitmap.height * scale;
      context.drawImage(bitmap, (width - w) / 2, (height - h) / 2, w, h);
      bitmap.close();
    }, classroomId, author, title, progress, (id) => { bookId = id; });
  } catch (error) {
    throw importFailure(error, bookId, "사진을 가져오지 못했어요.");
  }
}
