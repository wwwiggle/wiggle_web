import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import sharp from "sharp";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, PDFName, PDFNumber, PDFRawStream, cmyk, degrees, rgb } from "pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { createCanvas } from "@napi-rs/canvas";
import { parsePageRange, resizePdf } from "../lib/pdf-resize.ts";
import { validatePrintPdf } from "../lib/print-validation.ts";

const PT = 72 / 25.4;
const sweetbookInner = { spec: { bindingType: "PUR" }, size: { innerWidthMm: 249, innerHeightMm: 254, coverWidthMm: 544, coverHeightMm: 288 }, pageCount: 3 };

/** 3 pages of widthMm×heightMm (+ optional art bleed): full-page RGB and CMYK JPEGs, alpha PNG, vectors, embedded Korean text. */
async function samplePdf(widthMm, heightMm, bleedMm = 0) {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const font = await pdf.embedFont(readFileSync("public/fonts/NanumGothic-Regular.ttf"), { subset: true });
  const art = (r, g, b) => sharp({ create: { width: 600, height: 600, channels: 3, background: { r, g, b } } }).composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600"><circle cx="300" cy="300" r="200" fill="#ffd400"/></svg>`) }]);
  const rgbJpg = await pdf.embedJpg(await art(30, 140, 60).jpeg().toBuffer());
  const cmykJpg = await pdf.embedJpg(await art(30, 60, 160).toColourspace("cmyk").jpeg().toBuffer());
  const png = await pdf.embedPng(await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.5 } } }).png().toBuffer());
  const [w, h, b] = [widthMm * PT, heightMm * PT, bleedMm * PT];
  for (const [i, image] of [rgbJpg, cmykJpg, rgbJpg].entries()) {
    const page = pdf.addPage([w + 2 * b, h + 2 * b]);
    if (b) { page.setTrimBox(b, b, w, h); page.setBleedBox(0, 0, w + 2 * b, h + 2 * b); }
    page.drawImage(image, { x: 0, y: 0, width: w + 2 * b, height: h + 2 * b });
    page.drawImage(png, { x: b + 20, y: b + 20, width: 60, height: 60 });
    page.drawCircle({ x: b + w / 2, y: b + h / 2, size: 40 * PT, borderColor: rgb(0, 0, 0), borderWidth: 2 });
    page.drawRectangle({ x: b + 20 * PT, y: b + 20 * PT, width: 60 * PT, height: 20 * PT, color: cmyk(0, 0.6, 1, 0), opacity: 0.5 });
    page.drawText(`꿈틀 그림책 ${i + 1}쪽`, { x: b + 20 * PT, y: b + 50 * PT, size: 20, font });
  }
  return pdf.save({ useObjectStreams: false });
}

async function imageHashes(bytes) {
  const pdf = await PDFDocument.load(bytes), hashes = [];
  for (const [, object] of pdf.context.enumerateIndirectObjects()) {
    if (object instanceof PDFRawStream && object.dict.get(PDFName.of("Subtype")) === PDFName.of("Image")) hashes.push(createHash("sha256").update(object.contents).digest("hex"));
  }
  return hashes.sort();
}

const boxMm = (box) => [box.x, box.y, box.width, box.height].map((v) => Math.round(v / PT * 100) / 100);

async function render(bytes, pageNumber = 1, scale = 0.5) {
  const task = getDocument({ data: new Uint8Array(bytes), standardFontDataUrl: "public/pdfjs/standard_fonts/", verbosity: 0 });
  try {
    const pdf = await task.promise, page = await pdf.getPage(pageNumber), viewport = page.getViewport({ scale });
    const canvas = createCanvas(Math.round(viewport.width), Math.round(viewport.height)), context = canvas.getContext("2d");
    await page.render({ canvasContext: context, viewport }).promise;
    const text = (await page.getTextContent()).items.map((item) => item.str).join("");
    return { width: canvas.width, height: canvas.height, data: context.getImageData(0, 0, canvas.width, canvas.height).data, text, mm: [viewport.width / scale / PT, viewport.height / scale / PT] };
  } finally { await task.destroy(); }
}
const pixel = (r, xMm, yMmFromTop) => { const x = Math.floor(xMm / r.mm[0] * r.width), y = Math.floor(yMmFromTop / r.mm[1] * r.height), i = (y * r.width + x) * 4; return [...r.data.slice(i, i + 3)]; };
const isWhite = (c) => c.every((v) => v > 245);

test("210×210 → Sweetbook inner (243×248 + 3mm bleed): sizes, untouched images, vector text, vendor validation", async () => {
  const source = await samplePdf(210, 210);
  const result = await resizePdf(source, { widthMm: 243, heightMm: 248, bleedMm: 3, mode: "fill", placeInto: "bleed" });
  const pdf = await PDFDocument.load(result.bytes);
  assert.equal(result.pageCount, 3);
  for (const page of pdf.getPages()) {
    assert.deepEqual(boxMm(page.getMediaBox()), [0, 0, 249, 254]);
    assert.deepEqual(boxMm(page.getTrimBox()), [3, 3, 243, 248]);
    assert.deepEqual(boxMm(page.getCropBox()), [0, 0, 249, 254]);
  }
  assert.deepEqual(await imageHashes(result.bytes), await imageHashes(source), "image streams are copied byte for byte");
  assert.equal((await imageHashes(source)).length, 4, "RGB JPEG, CMYK JPEG, PNG and its soft mask");
  assert.deepEqual(await validatePrintPdf(result.bytes, "inner", sweetbookInner), [1, 2, 3].map((page) => ({ page, widthMm: 249, heightMm: 254 })));
  const [p1] = result.pages;
  assert.deepEqual(p1.sourceMm, [210, 210]);
  assert.equal(p1.scale[0], 1.2095);
  assert.deepEqual(p1.placedMm, [254, 254]);
  assert.deepEqual(p1.cutSourceMm, { left: 4.55, right: 4.55, top: 2.48, bottom: 2.48 });
  assert.deepEqual(p1.gapMm, { left: 0, right: 0, top: 0, bottom: 0 });
  const page = await render(result.bytes);
  assert.equal(page.text, "꿈틀 그림책 1쪽", "text stays text");
  assert.ok(!isWhite(pixel(page, 0.5, 0.5)) && !isWhite(pixel(page, 248.5, 253.5)), "art reaches every bleed corner");
  assert.ok(result.bytes.length < source.length * 1.05, "no rasterization, size barely changes");
});

test("243×248 (+3mm art bleed) → 210×210 shrinks whole art with no cut; gaps use the source bleed or the background", async () => {
  const source = await samplePdf(243, 248, 3);
  const kept = await resizePdf(source, { widthMm: 210, heightMm: 210, mode: "fit" });
  const [p1] = kept.pages;
  assert.deepEqual(p1.sourceMm, [243, 248]);
  assert.equal(p1.scale[0], 0.8468);
  assert.deepEqual(p1.cutSourceMm, { left: 0, right: 0, top: 0, bottom: 0 });
  assert.deepEqual(p1.gapMm, { left: 2.12, right: 2.12, top: 0, bottom: 0 });
  assert.deepEqual(await imageHashes(kept.bytes), await imageHashes(source));
  const keptRender = await render(kept.bytes);
  assert.deepEqual(keptRender.mm.map(Math.round), [210, 210]);
  assert.ok(!isWhite(pixel(keptRender, 1, 105)), "source bleed art fills the 2.12mm side gap");
  const clipped = await render((await resizePdf(source, { widthMm: 210, heightMm: 210, mode: "fit", sourceBleed: "clip" })).bytes);
  assert.ok(isWhite(pixel(clipped, 1, 105)) && !isWhite(pixel(clipped, 3, 105)), "clip leaves a white gap, art starts after it");
  const stretched = await resizePdf(source, { widthMm: 210, heightMm: 210, mode: "stretch" });
  assert.deepEqual(stretched.pages[0].scale, [0.8642, 0.8468]);
  assert.deepEqual(stretched.pages[0].gapMm, { left: 0, right: 0, top: 0, bottom: 0 });
});

test("fit and fill to the trim leave background in the bleed or cut the long side", async () => {
  const source = await samplePdf(210, 210);
  const fit = await resizePdf(source, { widthMm: 243, heightMm: 248, bleedMm: 3, mode: "fit" });
  assert.deepEqual(fit.pages[0].gapMm, { left: 0, right: 0, top: 2.5, bottom: 2.5 });
  const fitRender = await render(fit.bytes);
  assert.ok(isWhite(pixel(fitRender, 124.5, 4)) && !isWhite(pixel(fitRender, 124.5, 7)), "white band below the top trim, art after it");
  const fill = await resizePdf(source, { widthMm: 243, heightMm: 248, bleedMm: 3, mode: "fill", background: "#ff00ff" });
  assert.deepEqual(fill.pages[0].cutSourceMm, { left: 2.12, right: 2.12, top: 0, bottom: 0 });
  assert.deepEqual(pixel(await render(fill.bytes), 124.5, 1), [255, 0, 255], "uncovered bleed shows the chosen background");
});

test("rotated pages and offset boxes render the same after a same-size conversion", async () => {
  const base = await PDFDocument.load(await samplePdf(210, 210));
  for (const angle of [0, 90, 180, 270]) {
    const doc = await PDFDocument.create(), [page] = await doc.copyPages(base, [0]);
    doc.addPage(page); page.setCropBox(20, 40, 500, 400); page.setTrimBox(20, 40, 500, 400); page.setRotation(degrees(angle));
    const source = await doc.save();
    const [w, h] = angle % 180 ? [400, 500] : [500, 400];
    const result = await resizePdf(source, { widthMm: w / PT, heightMm: h / PT, mode: "stretch" });
    const out = await PDFDocument.load(result.bytes);
    assert.equal(out.getPage(0).getRotation().angle, 0, "rotation is baked into the content");
    const [a, b] = [await render(source), await render(result.bytes)];
    assert.deepEqual([b.width, b.height], [a.width, a.height]);
    let diff = 0; for (let i = 0; i < a.data.length; i++) diff += Math.abs(a.data[i] - b.data[i]);
    assert.ok(diff / a.data.length < 1, `rotation ${angle}: mean pixel difference ${diff / a.data.length}`);
  }
});

test("page ranges, UserUnit, annotations and bad input", async () => {
  assert.deepEqual(parsePageRange("3, 1-2, 2", 5), [1, 2, 3]);
  assert.throws(() => parsePageRange("0-2", 5), /1~5/);
  assert.throws(() => parsePageRange("a", 5), /읽지 못했어요/);
  const source = await samplePdf(210, 210);
  const partial = await resizePdf(source, { widthMm: 243, heightMm: 248, pages: [2] });
  assert.deepEqual(partial.pages.map((p) => p.page), [2]);
  const sizes = (await PDFDocument.load(partial.bytes)).getPages().map((p) => boxMm(p.getMediaBox()).slice(2));
  assert.deepEqual(sizes, [[210, 210], [243, 248], [210, 210]]);

  const doc = await PDFDocument.load(source);
  doc.getPage(0).node.set(PDFName.of("UserUnit"), PDFNumber.of(2));
  doc.getPage(0).node.set(PDFName.of("Annots"), doc.context.obj([doc.context.obj({ Type: "Annot", Subtype: "Link", Rect: [0, 0, 10, 10] })]));
  const unitResult = await resizePdf(await doc.save(), { widthMm: 210, heightMm: 210 });
  assert.deepEqual(unitResult.pages[0].sourceMm, [420, 420]);
  assert.equal(unitResult.pages[0].scale[0], 0.5);
  assert.equal(unitResult.pages[0].droppedAnnotations, 1);
  const unitPage = (await PDFDocument.load(unitResult.bytes)).getPage(0);
  assert.equal(unitPage.node.get(PDFName.of("UserUnit")), undefined);
  assert.equal(unitPage.node.get(PDFName.of("Annots")), undefined);

  await assert.rejects(resizePdf(source, { widthMm: 5, heightMm: 210 }), /10~2000mm/);
  await assert.rejects(resizePdf(source, { widthMm: 210, heightMm: 210, bleedMm: 30 }), /0~20mm/);
  await assert.rejects(resizePdf(source, { widthMm: 210, heightMm: 210, pages: [4] }), /1~3/);
  await assert.rejects(resizePdf(source, { widthMm: 210, heightMm: 210, background: "red" }), /#ffffff/);
  await assert.rejects(resizePdf(new TextEncoder().encode("not a pdf"), { widthMm: 210, heightMm: 210 }), /읽지 못했어요/);
  const encrypted = Buffer.from(Buffer.from(source).toString("latin1").replace("trailer\n<<", "trailer\n<<\n/Encrypt << /Filter /Standard /V 1 /R 2 >>"), "latin1");
  await assert.rejects(resizePdf(encrypted, { widthMm: 210, heightMm: 210 }), /암호가 걸린 PDF/);
});

/** One 100×100pt page whose content is a single raw stream (not an array), like Chrome/Quartz/InDesign output. */
async function rawPagePdf(content, { inherit = false, contents = true } = {}) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([100, 100]);
  page.node.delete(PDFName.of("Contents"));
  if (contents) page.node.set(PDFName.of("Contents"), pdf.context.register(pdf.context.flateStream(content)));
  if (inherit) {
    // MediaBox and Resources only on the parent Pages node
    const parent = page.node.Parent();
    parent.set(PDFName.of("MediaBox"), page.node.get(PDFName.of("MediaBox")));
    parent.set(PDFName.of("Resources"), pdf.context.obj({}));
    page.node.delete(PDFName.of("MediaBox"));
    page.node.delete(PDFName.of("Resources"));
  }
  return pdf.save({ useObjectStreams: false });
}

test("single-stream, inherited and missing contents are scaled, not just re-boxed", async () => {
  // red square over the left-bottom half of a 100pt page
  for (const inherit of [false, true]) {
    const source = await rawPagePdf("1 0 0 rg 0 0 50 50 re f", { inherit });
    const result = await resizePdf(source, { widthMm: 200 / PT, heightMm: 200 / PT, mode: "stretch", background: null });
    const page = await render(result.bytes, 1, 1);
    assert.deepEqual(page.mm.map(Math.round), [71, 71], "200pt page");
    assert.deepEqual(pixel(page, 25, 45), [255, 0, 0], `inherit=${inherit}: square grew to 100pt (35mm) instead of staying 50pt`);
  }
  const blank = await resizePdf(await rawPagePdf("", { contents: false }), { widthMm: 50, heightMm: 50, background: "#00ff00" });
  assert.deepEqual(pixel(await render(blank.bytes), 25, 25), [0, 255, 0], "page without contents still gets the background");
});

test("stray Q in broken content cannot undo the resize", async () => {
  const source = await rawPagePdf("Q Q 1 0 0 rg 0 0 50 50 re f q");
  const result = await resizePdf(source, { widthMm: 200 / PT, heightMm: 200 / PT, mode: "stretch", background: null });
  assert.deepEqual(pixel(await render(result.bytes, 1, 1), 25, 45), [255, 0, 0]);
});

test("gradients and patterns scale with the page (they are anchored to the form, not the page)", async () => {
  const pdf = await PDFDocument.create(), page = pdf.addPage([100, 100]), ctx = pdf.context;
  const shading = ctx.obj({ ShadingType: 2, ColorSpace: "DeviceRGB", Coords: [0, 0, 100, 0], Extend: [true, true], Function: { FunctionType: 2, Domain: [0, 1], C0: [1, 0, 0], C1: [0, 0, 1], N: 1 } });
  page.node.set(PDFName.of("Resources"), ctx.obj({ Pattern: { P0: ctx.obj({ PatternType: 2, Shading: shading }) } }));
  page.node.set(PDFName.of("Contents"), ctx.register(ctx.flateStream("/Pattern cs /P0 scn 0 0 100 100 re f")));
  const result = await resizePdf(await pdf.save(), { widthMm: 200 / PT, heightMm: 200 / PT, mode: "stretch" });
  const centre = pixel(await render(result.bytes, 1, 1), 35.3, 35.3); // page centre
  assert.ok(centre[0] > 100 && centre[0] < 160 && centre[1] < 40 && centre[2] > 100 && centre[2] < 160, `centre is the red→blue midpoint, got ${centre}`);
});

test("a content stream shared with an untouched page is kept; otherwise it is dropped", async () => {
  const pdf = await PDFDocument.create();
  const stream = pdf.context.register(pdf.context.flateStream("1 0 0 rg 0 0 50 50 re f"));
  for (let i = 0; i < 2; i++) { const page = pdf.addPage([100, 100]); page.node.set(PDFName.of("Contents"), stream); }
  const source = await pdf.save();
  const one = await resizePdf(source, { widthMm: 200 / PT, heightMm: 200 / PT, mode: "stretch", pages: [1] });
  assert.deepEqual(pixel(await render(one.bytes, 2, 1), 10, 30), [255, 0, 0], "page 2 still draws its square");
  assert.deepEqual(pixel(await render(one.bytes, 1, 1), 25, 45), [255, 0, 0], "page 1 square doubled");
  const both = await resizePdf(source, { widthMm: 200 / PT, heightMm: 200 / PT, mode: "stretch" });
  for (const n of [1, 2]) assert.deepEqual(pixel(await render(both.bytes, n, 1), 25, 45), [255, 0, 0]);
  const objects = (bytes) => PDFDocument.load(bytes).then((d) => d.context.enumerateIndirectObjects().length);
  assert.ok(await objects(both.bytes) <= (await objects(source)) + 4, "no orphaned copies of the old content");
});
