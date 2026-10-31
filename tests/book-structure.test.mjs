import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { PDFDocument } from "pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { createCanvas } from "@napi-rs/canvas";
import { applyStorybookTemplate, emptyStorybookDocument, STORYBOOK_TEMPLATE_LABELS, validateStorybookDocument } from "../lib/storybook-model.ts";
import { applyPattern, canMovePage, completeBookStructure, coverCredit, ebookViews, hasBackCover, innerPageIndexes, newPageIndex, pageLabel, patternElements, spineFontSizeMm, spineLabel } from "../lib/storybook-structure.ts";
import { bookPrintProductForPages, estimatedSpineWidthMm, PRINT_LAYOUT_VERSION } from "../lib/book-print-format.ts";
import { printPdfs, viewPdf } from "../lib/book-render.ts";
import { validatePrintPdf } from "../lib/print-validation.ts";
import { classroomProfileInput } from "../lib/classroom-profile.ts";

let counter = 0;
const makeId = prefix => `${prefix}_t${String(counter++).padStart(10, "0")}`;
function book(pages) {
  const document = emptyStorybookDocument();
  document.pages = Array.from({ length: pages }, (_, index) => emptyStorybookDocument("squarebook-hc", `page_book${String(index).padStart(8, "0")}`, `element_book${String(index).padStart(8, "0")}`).pages[0]);
  return document;
}

test("front cover is first; the last page is a back cover only when marked", () => {
  const document = book(5);
  assert.equal(hasBackCover(document), false);
  assert.deepEqual(innerPageIndexes(document), [1, 2, 3, 4]);
  assert.equal(pageLabel(document, 0), "앞표지");
  document.pages[4] = applyStorybookTemplate(document.pages[4], "back", () => makeId("element"));
  assert.equal(hasBackCover(document), true);
  assert.deepEqual(innerPageIndexes(document), [1, 2, 3]);
  assert.equal(pageLabel(document, 4), "뒷표지");
  assert.equal(newPageIndex(document), 4, "new pages go before the back cover");
  assert.equal(canMovePage(document, 2, 3), true);
  assert.equal(canMovePage(document, 1, 0), false, "nothing moves in front of the front cover");
  assert.equal(canMovePage(document, 3, 4), false, "nothing moves behind the back cover");
  assert.equal(canMovePage(document, 4, 3), false, "the back cover stays last");
  assert.equal(STORYBOOK_TEMPLATE_LABELS.cover, "앞표지");
  assert.ok(validateStorybookDocument(document));
});

test("a single-page book never treats its cover as a back cover", () => {
  const document = book(1);
  document.pages[0].template = "back";
  assert.equal(hasBackCover(document), false);
  assert.deepEqual(innerPageIndexes(document), []);
});

test("book structure only adds missing parts in the standard order and never edits existing pages", () => {
  const document = book(3);
  document.pages[0] = applyStorybookTemplate(document.pages[0], "cover", () => makeId("element"));
  document.pages[0].elements.find(element => element.textRole === "credit").text = "글 / 그림 봄이";
  document.pages[1].elements[0].text = "본문 첫 쪽";
  const before = structuredClone(document);
  const result = completeBookStructure(document, makeId, { title: "달빛 여행", credit: coverCredit(document) });
  assert.equal(result.error, "");
  assert.deepEqual(result.added, ["앞 면지", "작가의 말", "속표지", "뒤 면지", "뒷표지"]);
  const pages = result.document.pages;
  assert.deepEqual(pages.map(page => page.template ?? "inner"), ["cover", "pattern", "author", "title", "inner", "inner", "pattern", "back"]);
  assert.deepEqual(pages[0], before.pages[0]);
  assert.deepEqual(pages[4], before.pages[1]);
  assert.deepEqual(pages[5], before.pages[2]);
  const titlePage = pages[3];
  assert.equal(titlePage.elements.find(element => element.textRole === "title").text, "달빛 여행", "속표지 gets the book title");
  assert.equal(titlePage.elements.find(element => element.textRole === "credit").text, "글 / 그림 봄이", "and the author line typed on the cover");
  assert.ok(validateStorybookDocument(result.document));
  assert.deepEqual(document, before, "input document is not mutated");
  const again = completeBookStructure(result.document, makeId, { title: "달빛 여행", credit: "" });
  assert.deepEqual(again.added, []);
  assert.equal(again.document, result.document);
});

test("book structure keeps an existing back cover last and respects the page limit", () => {
  const document = book(4);
  document.pages[3] = applyStorybookTemplate(document.pages[3], "back", () => makeId("element"));
  const result = completeBookStructure(document, makeId, { title: "", credit: "" });
  assert.equal(result.document.pages.at(-1).id, document.pages[3].id);
  assert.equal(result.document.pages.at(-2).template, "pattern");
  const full = book(130);
  const limited = completeBookStructure(full, makeId, { title: "", credit: "" }, 131);
  assert.match(limited.error, /최대 131쪽/);
  assert.equal(limited.document, full);
});

test("template autofill never overwrites text the child wrote", () => {
  const page = book(1).pages[0];
  page.elements[0].text = "내가 쓴 제목";
  const applied = applyStorybookTemplate(page, "title", () => makeId("element"), { title: "다른 제목", credit: "글 / 그림 봄이" });
  assert.ok(applied.elements.some(element => element.text === "내가 쓴 제목"));
  assert.ok(!applied.elements.some(element => element.text === "다른 제목"));
  assert.equal(applied.elements.find(element => element.textRole === "credit").text, "글 / 그림 봄이");
});

test("pattern endpaper: one picture repeated in a staggered grid, valid and inside the page", () => {
  const options = { assetId: "asset_pattern0001", imageAspect: 1.5, pageAspect: 243 / 248, size: "normal", rotate: true, makeId: () => makeId("element"), seed: 7 };
  const few = patternElements({ ...options, density: "few" });
  const many = patternElements({ ...options, density: "many" });
  assert.ok(many.length > few.length);
  for (const element of many) {
    assert.equal(element.assetId, "asset_pattern0001");
    assert.ok(element.x >= 0 && element.y >= 0 && element.x + element.width <= 1.001 && element.y + element.height <= 1.001);
    assert.ok(Math.abs(element.rotation) <= 14);
  }
  const rows = [...new Set(few.map(element => Math.round(element.y * 10)))];
  assert.ok(rows.length >= 2);
  const sameSeed = patternElements({ ...options, density: "few", makeId: () => makeId("element") });
  assert.deepEqual(sameSeed.map(({ x, y, rotation }) => [x, y, rotation]), few.map(({ x, y, rotation }) => [x, y, rotation]), "same seed, same layout");
  const page = book(1).pages[0];
  page.elements.push({ id: "element_original001", type: "image", assetId: "asset_pattern0001", x: .2, y: .3, width: .3, height: .3, rotation: 0, zIndex: 1, opacity: 1, locked: false });
  const patterned = applyPattern(page, few, "asset_pattern0001");
  assert.equal(patterned.template, "pattern");
  assert.ok(!patterned.elements.some(element => element.id === "element_original001"), "the source copy is replaced by the pattern");
  assert.ok(patterned.elements.some(element => element.type === "text"), "other content stays");
  const document = book(1); document.pages[0] = patterned;
  assert.ok(validateStorybookDocument(document));
});

test("spine text and width follow page count; thin spines stay plain", () => {
  const document = book(2);
  document.pages[0] = applyStorybookTemplate(document.pages[0], "cover", () => makeId("element"));
  assert.deepEqual(spineLabel(" 달빛 여행 ", document), { title: "달빛 여행", author: "" });
  document.pages[0].elements.find(element => element.textRole === "credit").text = "글 / 그림 봄이";
  assert.equal(spineLabel("달빛 여행", document).author, "글 / 그림 봄이");
  assert.equal(estimatedSpineWidthMm(10), 10);
  assert.equal(estimatedSpineWidthMm(64), 10);
  assert.equal(estimatedSpineWidthMm(65), 16);
  assert.equal(spineFontSizeMm(10), 5);
  assert.equal(spineFontSizeMm(4), null);
  assert.equal(bookPrintProductForPages(24)?.uid, "SQUAREBOOK_HC");
  assert.equal(bookPrintProductForPages(16), null, "24쪽 미만은 아직 인쇄 상품이 없다");
  assert.equal(PRINT_LAYOUT_VERSION, 3);
});

test("ebook order: front cover alone, pairs or single pages, back cover alone", () => {
  const document = book(6);
  document.pages[5] = applyStorybookTemplate(document.pages[5], "back", () => makeId("element"));
  assert.deepEqual(ebookViews(document, true).map(view => view.pages), [[0], [1, 2], [3, 4], [5]]);
  assert.deepEqual(ebookViews(document, false).map(view => view.label), ["앞표지", "2쪽", "3쪽", "4쪽", "5쪽", "뒷표지"]);
  assert.deepEqual(ebookViews(book(4), true).map(view => view.pages), [[0], [1, 2], [3]]);
});

const spec = { bookSpecUid: "SQUAREBOOK_HC", name: "스퀘어북", bindingType: "PUR", pageMin: 24, pageMax: 130, pageIncrement: 2, innerTrimWidthMm: 243, innerTrimHeightMm: 248, hingeGapMm: 10 };
const size = { innerWidthMm: 249, innerHeightMm: 254, coverWidthMm: 544, coverHeightMm: 288, spineWidthMm: 10 };
async function sample(bytes, pageNumber, rx, ry) {
  const task = getDocument({ data: new Uint8Array(bytes) }), pdf = await task.promise, page = await pdf.getPage(pageNumber), viewport = page.getViewport({ scale: .5 });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height)), context = canvas.getContext("2d");
  await page.render({ canvasContext: context, viewport }).promise;
  const color = [...context.getImageData(Math.floor(canvas.width * rx), Math.floor(canvas.height * ry), 1, 1).data].slice(0, 3);
  await task.destroy(); return color;
}
async function pdfText(bytes) {
  const task = getDocument({ data: new Uint8Array(bytes) }), pdf = await task.promise;
  let text = "";
  for (let n = 1; n <= pdf.numPages; n++) text += (await (await pdf.getPage(n)).getTextContent()).items.map(item => item.str).join("");
  await task.destroy(); return text;
}

test("print cover: back cover on the left, front on the right, title and author on the spine", async () => {
  const colors = ["#ff0000", "#00ff00", "#0000ff"];
  const images = await Promise.all(colors.map(background => sharp({ create: { width: 243, height: 248, channels: 3, background } }).jpeg().toBuffer()));
  const result = await printPdfs(images, spec, size, "달빛 여행", { backCover: true, spine: { title: "달빛 여행", author: "글 / 그림 봄이" } });
  const front = await sample(result.cover, 1, .75, .5), back = await sample(result.cover, 1, .25, .5);
  assert.ok(front[0] > 240 && front[1] < 10 && front[2] < 10, "front cover = first page");
  assert.ok(back[2] > 240 && back[0] < 10 && back[1] < 10, "back cover = last page");
  const inner = await sample(result.inner, 1, .5, .5), afterInner = await sample(result.inner, 2, .5, .5);
  assert.ok(inner[1] > 240 && inner[0] < 10, "the only inner page is page two");
  assert.ok(afterInner.every(value => value > 250), "the back cover is not repeated inside");
  assert.equal(result.addedPages, 23);
  const spineText = (await pdfText(result.cover)).replace(/\s+/g, "");
  assert.ok(spineText.includes("달빛여행") && spineText.includes("봄이"), spineText);
  assert.equal((await validatePrintPdf(result.cover, "cover", { spec, size, pageCount: 24 })).length, 1);
  assert.equal((await validatePrintPdf(result.inner, "inner", { spec, size, pageCount: 24 })).length, 24);
});

test("download PDF is square 243 × 248mm with no header, footer or page numbers", async () => {
  const images = await Promise.all(["#ffffff", "#ffeeaa", "#aaddff"].map(background => sharp({ create: { width: 243, height: 248, channels: 3, background } }).jpeg().toBuffer()));
  const bytes = await viewPdf(images, "squarebook-hc", "달빛 여행");
  const pdf = await PDFDocument.load(bytes);
  assert.equal(pdf.getPageCount(), 3);
  for (const page of pdf.getPages()) {
    assert.ok(Math.abs(page.getWidth() * 25.4 / 72 - 243) < .01);
    assert.ok(Math.abs(page.getHeight() * 25.4 / 72 - 248) < .01);
  }
  assert.equal((await pdfText(bytes)).trim(), "", "no text such as the title or page numbers is added");
  assert.equal(pdf.getTitle(), "달빛 여행");
});

test("school name and grade are optional, bounded and never required from students", () => {
  assert.deepEqual(classroomProfileInput({}), { schoolName: "", grade: null });
  assert.deepEqual(classroomProfileInput({ schoolName: "  꿈틀\n초등학교 ", grade: "4" }), { schoolName: "꿈틀 초등학교", grade: 4 });
  assert.match(classroomProfileInput({ grade: 7 }).error, /1~6학년/);
  assert.match(classroomProfileInput({ schoolName: "가".repeat(41) }).error, /40자/);
});
