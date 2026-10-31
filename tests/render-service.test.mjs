import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
import sharp from "sharp";
import { createArtworksStore } from "../db/adapters/artworks-store.ts";
import { defaultRubric } from "../lib/book-rubric.ts";
import { renderBookPages, printPdfs, viewPdf } from "../lib/book-render.ts";
import { bookFeedbackPdf, bookPageImages, bookPrintPdfs, bookViewPdf, setRenderServiceForTests } from "../lib/book-render-service.ts";
import { emptyStorybookDocument } from "../lib/storybook-model.ts";
import { createRenderServer } from "../render-service/server.ts";

// Cloudflare 이사(2026-11-01): Workers에서 못 도는 그림책 그리기를 그리기 서버(render-service)가 맡는다.
// 같은 lib/book-render.ts로 그리므로, 서버를 거쳐도 직접 그린 것과 결과가 같아야 한다.

const SECRET = "render-test-secret";
const SPEC = { bookSpecUid: "SQUAREBOOK_HC", name: "테스트", pageMin: 24, pageMax: 130, pageIncrement: 2, bindingType: "PUR", innerTrimWidthMm: 243, innerTrimHeightMm: 248, hingeGapMm: 10 };
const SIZE = { coverWidthMm: 544, coverHeightMm: 288, innerWidthMm: 249, innerHeightMm: 254, spineWidthMm: 10 };

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "wiggle-render-"));
  const store = createArtworksStore("test", { ARTWORKS_FS_DIR: directory });
  const picture = await sharp({ create: { width: 400, height: 300, channels: 4, background: { r: 30, g: 120, b: 220, alpha: 1 } } }).png().toBuffer();
  await store.put("storybooks/render-test/asset_picture01.png", picture, { httpMetadata: { contentType: "image/png" } });

  const document = emptyStorybookDocument("square");
  document.pages[0].background = "#EF3344";
  document.pages[0].elements.find((element) => element.type === "text").text = "친구야, 함께 놀자!";
  document.pages[0].elements.push({ id: "element_picture01", type: "image", x: 0.1, y: 0.1, width: 0.5, height: 0.4, rotation: 5, zIndex: 9, opacity: 1, locked: false, assetId: "asset_picture01", aspectRatio: 4 / 3 });
  const source = { document, assetKeys: { asset_picture01: "storybooks/render-test/asset_picture01.png" } };

  const server = createRenderServer({ store, secret: SECRET });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const assets = new Map([["asset_picture01", picture]]);
  return {
    source,
    assets,
    url,
    async dispose() {
      setRenderServiceForTests(undefined);
      await new Promise((resolve) => server.close(resolve));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("그리기 서버를 거쳐 그린 쪽은 직접 그린 쪽과 바이트까지 같다", async () => {
  const f = await fixture();
  try {
    const local = await renderBookPages(f.source.document, f.assets, 900);
    setRenderServiceForTests({ url: f.url, secret: SECRET, fetch });
    const remote = await bookPageImages(f.source, 900);
    assert.equal(remote.length, local.length);
    remote.forEach((page, index) => assert.ok(page.equals(local[index]), `${index + 1}쪽`));
  } finally {
    await f.dispose();
  }
});

test("화면용·인쇄용·피드백 PDF도 그리기 서버로 같은 모양이 나온다", async () => {
  const f = await fixture();
  try {
    const images = await renderBookPages(f.source.document, f.assets, 1200);
    const localView = await PDFDocument.load(await viewPdf(images, f.source.document.format, "책"));
    const localPrint = await printPdfs(images, SPEC, SIZE, "책", { spine: { title: "책", author: "지은이" } });
    setRenderServiceForTests({ url: f.url, secret: SECRET, fetch });

    const view = await PDFDocument.load(await bookViewPdf(f.source, 1200, "책"));
    assert.equal(view.getPageCount(), localView.getPageCount());
    assert.deepEqual(view.getPages().map((page) => page.getSize()), localView.getPages().map((page) => page.getSize()));

    const print = await bookPrintPdfs(f.source, 1200, SPEC, SIZE, "책", { spine: { title: "책", author: "지은이" } });
    assert.equal(print.pageCount, localPrint.pageCount);
    assert.equal(print.addedPages, localPrint.addedPages);
    const [cover, inner] = await Promise.all([PDFDocument.load(print.cover), PDFDocument.load(print.inner)]);
    const [localCover, localInner] = await Promise.all([PDFDocument.load(localPrint.cover), PDFDocument.load(localPrint.inner)]);
    assert.equal(inner.getPageCount(), localInner.getPageCount());
    assert.deepEqual(cover.getPages()[0].getSize(), localCover.getPages()[0].getSize());

    const rubric = await defaultRubric();
    const feedback = { summary: "끝 장면을 더 다듬어 보세요.", criteria: rubric.criteria.map((criterion) => ({ id: criterion.id, score: 8, feedback: "1쪽에 마음이 드러남.", pages: [1] })) };
    const identity = { grade: 4, classNumber: 2, seatNumber: 3, realName: "테스트", title: "책" };
    const feedbackPdf = await PDFDocument.load(await bookFeedbackPdf(identity, rubric, feedback, "v1", undefined));
    assert.ok(feedbackPdf.getPageCount() >= 1);
  } finally {
    await f.dispose();
  }
});

test("그리기 서버는 비밀이 틀리면 거절하고, 없는 그림은 한국어로 알린다", async () => {
  const f = await fixture();
  try {
    setRenderServiceForTests({ url: f.url, secret: "wrong-secret", fetch });
    await assert.rejects(bookPageImages(f.source, 900), /인증되지 않은 요청/);
    setRenderServiceForTests({ url: f.url, secret: SECRET, fetch });
    await assert.rejects(bookPageImages({ ...f.source, assetKeys: { asset_picture01: "storybooks/render-test/missing.png" } }, 900), /이미지가 누락/);
    await assert.rejects(bookPageImages(f.source, 99999), /그림 크기가 올바르지 않아요/);
  } finally {
    await f.dispose();
  }
});
