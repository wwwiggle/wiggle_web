import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { PDFDocument } from "pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { createCanvas } from "@napi-rs/canvas";
import { applyStorybookTemplate, emptyStorybookDocument, STORYBOOK_TEMPLATE_LABELS, validateStorybookDocument } from "../lib/storybook-model.ts";
import { applyPattern, BOOK_PUBLISHER, bookSpreads, canMovePage, completeBookStructure, coverCredit, duplicatedPage, ebookViews, hasBackCover, innerPageCount, innerPageIndexes, insertPatternPage, isStructurePage, newPageIndex, newStructuredStorybook, pageDeleteBlock, pageLabel, patternEightElements, patternElements, replacePattern, settleInnerPages, spineFontSizeMm, spineLabel } from "../lib/storybook-structure.ts";
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
  // 2026-11-02: 앞표지 → 작가의 말 → 속표지 → 내지 … → 뒷표지 (면지는 넣지 않는다)
  assert.deepEqual(result.added, ["작가의 말", "속표지", "뒷표지"]);
  const pages = result.document.pages;
  assert.deepEqual(pages.map(page => page.template ?? "inner"), ["cover", "author", "title", "inner", "inner", "back"]);
  assert.deepEqual(pages[0], before.pages[0]);
  assert.deepEqual(pages[3], before.pages[1]);
  assert.deepEqual(pages[4], before.pages[2]);
  const titlePage = pages[2];
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
  assert.equal(result.document.pages.at(-2).id, document.pages[2].id, "기존 내지가 뒷표지 바로 앞에 그대로 있다");
  const full = book(130);
  const limited = completeBookStructure(full, makeId, { title: "", credit: "" }, 131);
  assert.match(limited.error, /최대 131쪽/);
  assert.equal(limited.document, full);
});

test("새 그림책: 앞표지 + 내지 24쪽(작가의 말·속표지 포함) + 뒷표지, 면지 없음 (2026-11-02)", () => {
  const document = newStructuredStorybook("squarebook-hc", makeId);
  assert.equal(document.pages.length, 26);
  assert.equal(innerPageCount(document), 24, "내지 PDF 최소 24쪽");
  assert.deepEqual(document.pages.slice(0, 3).map(page => page.template), ["cover", "author", "title"]);
  assert.ok(!document.pages.some(page => page.template === "pattern"), "면지는 넣지 않는다");
  assert.equal(document.pages.at(-1).template, "back");
  assert.ok(document.pages.slice(3, -1).every(page => page.template === "inner"));
  assert.ok(validateStorybookDocument(document));
  assert.deepEqual(completeBookStructure(document, makeId, { title: "", credit: "" }).added, [], "이미 다 갖춘 책은 그대로");
  assert.deepEqual(document.pages.map((_, index) => isStructurePage(document, index)), document.pages.map((_, index) => index < 3 || index === 25));
  assert.equal(newPageIndex(document), 25, "새 쪽은 뒷표지 앞에 들어간다");
});

test("쪽 삭제: 뼈대 쪽과 내지 24쪽 이하에서는 까닭을 알려 주고, 24쪽을 넘으면 지울 수 있다", () => {
  const document = newStructuredStorybook("squarebook-hc", makeId);
  assert.match(pageDeleteBlock(document, 0), /앞표지/);
  assert.match(pageDeleteBlock(document, 1), /작가의 말/);
  assert.match(pageDeleteBlock(document, 2), /속표지/);
  assert.match(pageDeleteBlock(document, 25), /뒷표지/);
  assert.match(pageDeleteBlock(document, 5), /최소 페이지가 24페이지라서 쪽을 삭제할 수 없어요/);
  const bigger = { ...document, pages: [...document.pages.slice(0, 25), { id: "page_extra000001", background: "#FFFFFF", elements: [] }, document.pages[25]] };
  assert.equal(innerPageCount(bigger), 25);
  assert.equal(pageDeleteBlock(bigger, 5), "");
  assert.equal(pageDeleteBlock(document, 5, 0), "", "선생님 편집(가져온 PDF 책)은 최소 쪽 수가 없다");
});

test("쪽 복제: 어느 쪽이든 복제되고, 복사본은 지울 수 있는 평범한 쪽이 된다", () => {
  const document = newStructuredStorybook("squarebook-hc", makeId);
  const cover = duplicatedPage(document, 0, makeId);
  assert.equal(cover.at, 1, "앞표지 복사본은 바로 뒤에");
  assert.equal(cover.copy.template, undefined, "복사본은 표지가 아니다");
  assert.notEqual(cover.copy.id, document.pages[0].id);
  assert.ok(cover.copy.elements.every((element, index) => element.id !== document.pages[0].elements[index].id));
  const back = duplicatedPage(document, 25, makeId);
  assert.equal(back.at, 25, "뒷표지 복사본은 뒷표지 앞에 — 뒷표지는 맨 끝에 남는다");
  const author = duplicatedPage(document, 1, makeId);
  const withCopy = { ...document, pages: [...document.pages.slice(0, author.at), author.copy, ...document.pages.slice(author.at)] };
  assert.equal(isStructurePage(withCopy, author.at), false, "작가의 말 복사본은 뼈대가 아니다");
  assert.equal(pageDeleteBlock(withCopy, author.at), "", "내지가 25쪽이 되어 복사본을 지울 수 있다");
  const pattern = insertPatternPage(document, [], makeId).document;
  assert.equal(duplicatedPage(pattern, 1, makeId).copy.template, "pattern", "패턴 면지는 패턴 면지로 복제된다");
});

test("만드는 중인 책을 열 때: 빈 면지만 빼고, 내지를 24쪽까지 채운다(있는 쪽은 그대로)", () => {
  // 11-01 방식(앞표지·빈 면지·작가의 말·속표지·내지 19·뒷표지 = 24쪽) 책
  const old = newStructuredStorybook("squarebook-hc", makeId);
  old.pages.splice(1, 0, { id: "page_emptyendpap", background: "#FFF6E3", template: "pattern", elements: [] });
  old.pages.splice(5, 3);
  assert.equal(old.pages.length, 24);
  const before = structuredClone(old);
  const settled = settleInnerPages(old, makeId);
  assert.equal(settled.removed, 1);
  assert.equal(innerPageCount(settled.document), 24);
  assert.ok(!settled.document.pages.some(page => page.template === "pattern"));
  assert.equal(settled.document.pages.at(-1).id, old.pages.at(-1).id, "뒷표지는 맨 끝 그대로");
  for (const page of old.pages.filter(page => page.template !== "pattern")) assert.ok(settled.document.pages.some(kept => kept.id === page.id && JSON.stringify(kept) === JSON.stringify(page)), "있던 쪽은 고치지 않는다");
  assert.deepEqual(old, before, "입력 문서는 바꾸지 않는다");
  // 그림을 놓은 면지는 남긴다
  const decorated = structuredClone(old);
  decorated.pages[1].elements.push({ id: "element_pattern01", type: "image", assetId: "asset_pattern0001", x: .1, y: .1, width: .2, height: .2, rotation: 0, zIndex: 1, opacity: 1, locked: false });
  assert.equal(settleInnerPages(decorated, makeId).removed, 0);
  // 이미 맞는 책은 그대로
  const fresh = newStructuredStorybook("squarebook-hc", makeId);
  assert.equal(settleInnerPages(fresh, makeId).document, fresh);
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

test("패턴 면지: 그림 한 장을 가로 2장 × 4줄 지그재그로 8장, 쪽 안에, 겹치지 않게, 그림 비율 그대로 (2026-11-02)", () => {
  for (const imageAspect of [0.5, 0.7, 1, 2]) {
    const elements = patternEightElements({ assetId: "asset_pattern0001", imageAspect, pageAspect: 243 / 248, makeId: () => makeId("element") });
    assert.equal(elements.length, 8);
    for (const element of elements) {
      assert.ok(element.x >= 0 && element.y >= 0 && element.x + element.width <= 1.0001 && element.y + element.height <= 1.0001, JSON.stringify(element));
      assert.ok(Math.abs(element.width * (243 / 248) / element.height - imageAspect) < 0.01, "비율 유지");
    }
    const rows = [...new Set(elements.map(element => element.y))];
    assert.equal(rows.length, 4, "네 줄");
    const centers = row => elements.filter(element => element.y === rows[row]).map(element => Math.round((element.x + element.width / 2) * 100) / 100);
    for (let row = 0; row < 4; row++) assert.equal(centers(row).length, 2, "한 줄에 두 장");
    assert.deepEqual(centers(0), centers(2), "1·3줄은 같은 자리");
    assert.deepEqual(centers(1), centers(3), "2·4줄은 같은 자리");
    assert.ok(centers(1)[0] > centers(0)[0] && centers(1)[0] < centers(0)[1], "짝수 줄은 반 칸 밀려 지그재그");
    for (const a of elements) for (const b of elements) if (a !== b) assert.ok(a.x + a.width <= b.x + 1e-6 || b.x + b.width <= a.x + 1e-6 || a.y + a.height <= b.y + 1e-6 || b.y + b.height <= a.y + 1e-6, "겹치지 않는다");
  }
  const inserted = insertPatternPage(newStructuredStorybook("squarebook-hc", makeId), patternEightElements({ assetId: "asset_pattern0001", imageAspect: 1, pageAspect: 1, makeId: () => makeId("element") }), makeId);
  assert.equal(inserted.index, 1, "패턴 면지 추가는 앞표지 바로 뒤");
  assert.equal(inserted.document.pages[1].template, "pattern");
  assert.equal(pageLabel(inserted.document, 1), "패턴 면지");
  assert.equal(isStructurePage(inserted.document, 1), false, "패턴 면지는 지울 수 있다");
  assert.ok(validateStorybookDocument(inserted.document));
  const page = { id: "page_pattern001", background: "#FFF6E3", template: "pattern", elements: [
    { id: "element_oldimage1", type: "image", assetId: "asset_old0000001", x: .1, y: .1, width: .2, height: .2, rotation: 0, zIndex: 1, opacity: 1, locked: false },
    { id: "element_text00001", type: "text", text: "남는 글", x: .1, y: .8, width: .5, height: .1, rotation: 0, zIndex: 0, opacity: 1, locked: true },
  ] };
  const replaced = replacePattern(page, patternEightElements({ assetId: "asset_new0000001", imageAspect: 1, pageAspect: 1, makeId: () => makeId("element") }));
  assert.ok(!replaced.elements.some(element => element.assetId === "asset_old0000001"), "이전 패턴 그림은 바뀐다");
  assert.ok(replaced.elements.some(element => element.text === "남는 글"));
});

test("spine text and width follow page count; thin spines stay plain", () => {
  const document = book(2);
  document.pages[0] = applyStorybookTemplate(document.pages[0], "cover", () => makeId("element"));
  assert.deepEqual(spineLabel(" 달빛 여행 ", document), { title: "달빛 여행", author: "", publisher: "Ficture" });
  assert.equal(BOOK_PUBLISHER, "Ficture");
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

test("책 넘기기: 앞표지 홀로(오른쪽) → 2–3쪽, 4–5쪽 … 두 쪽씩 → 뒷표지 홀로(왼쪽)", () => {
  const document = book(7);
  document.pages[6] = applyStorybookTemplate(document.pages[6], "back", () => makeId("element"));
  assert.deepEqual(bookSpreads(document).map(({ left, right, kind }) => [left, right, kind]), [[null, 0, "front"], [1, 2, "inner"], [3, 4, "inner"], [5, null, "inner"], [6, null, "back"]]);
  assert.deepEqual(bookSpreads(document).map(spread => spread.label), ["앞표지", "2–3쪽", "4–5쪽", "6쪽", "뒷표지"]);
  const even = book(6); even.pages[5] = applyStorybookTemplate(even.pages[5], "back", () => makeId("element"));
  assert.deepEqual(bookSpreads(even).map(({ left, right }) => [left, right]), [[null, 0], [1, 2], [3, 4], [5, null]]);
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
  const result = await printPdfs(images, spec, size, "달빛 여행", { backCover: true, spine: { title: "달빛 여행", author: "글 / 그림 봄이", publisher: "Ficture" } });
  const front = await sample(result.cover, 1, .75, .5), back = await sample(result.cover, 1, .25, .5);
  assert.ok(front[0] > 240 && front[1] < 10 && front[2] < 10, "front cover = first page");
  assert.ok(back[2] > 240 && back[0] < 10 && back[1] < 10, "back cover = last page");
  const inner = await sample(result.inner, 1, .5, .5), afterInner = await sample(result.inner, 2, .5, .5);
  assert.ok(inner[1] > 240 && inner[0] < 10, "the only inner page is page two");
  assert.ok(afterInner.every(value => value > 250), "the back cover is not repeated inside");
  assert.equal(result.addedPages, 23);
  const spineText = (await pdfText(result.cover)).replace(/\s+/g, "");
  assert.ok(spineText.includes("달빛여행") && spineText.includes("봄이") && spineText.includes("Ficture"), spineText);
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
