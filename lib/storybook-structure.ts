// Book structure rules shared by the editor, the ebook viewer and the print/PDF renderers.
// Nothing here rewrites a saved book on load: every change is an explicit, additive action.
import {
  applyStorybookTemplate,
  DEFAULT_STORYBOOK_TEXT,
  MAX_STORYBOOK_PAGES,
  STORYBOOK_TEMPLATE_LABELS,
  type StorybookDocument,
  type StorybookElement,
  type StorybookPage,
  type StorybookTemplate,
} from "@/lib/storybook-model";

/** The first page is always the front cover. The last page is the back cover only when marked "back". */
export function hasBackCover(document: Pick<StorybookDocument, "pages">) {
  return document.pages.length > 1 && document.pages[document.pages.length - 1].template === "back";
}

export function backCoverIndex(document: Pick<StorybookDocument, "pages">) {
  return hasBackCover(document) ? document.pages.length - 1 : null;
}

/** Pages printed inside the book block (everything between the covers). */
export function innerPageIndexes(document: Pick<StorybookDocument, "pages">) {
  const end = hasBackCover(document) ? document.pages.length - 1 : document.pages.length;
  return Array.from({ length: Math.max(0, end - 1) }, (_, index) => index + 1);
}

export type PageRole = "front" | "back" | "inner";
export function pageRole(document: Pick<StorybookDocument, "pages">, index: number): PageRole {
  if (index === 0) return "front";
  return index === backCoverIndex(document) ? "back" : "inner";
}

export function pageLabel(document: Pick<StorybookDocument, "pages">, index: number) {
  const role = pageRole(document, index);
  if (role === "front") return "앞표지";
  if (role === "back") return "뒷표지";
  const template = document.pages[index]?.template;
  if (template === "pattern") return "면지";
  if (template === "title" || template === "author") return STORYBOOK_TEMPLATE_LABELS[template];
  return `${index + 1}쪽`;
}

function meaningfulText(element: StorybookElement | undefined) {
  const text = element?.text?.trim() ?? "";
  return text && text !== DEFAULT_STORYBOOK_TEXT ? text : "";
}

/** The author line the child typed on the front cover ("글 / 그림 …"). Real names are never filled in automatically. */
export function coverCredit(document: Pick<StorybookDocument, "pages">) {
  const cover = document.pages[0];
  return meaningfulText(cover?.elements.find(element => element.type === "text" && element.textRole === "credit"));
}

/** Text placed on the printed spine. Empty strings mean "leave the spine plain". */
export function spineLabel(title: string, document: Pick<StorybookDocument, "pages">) {
  return { title: title.trim().slice(0, 40), author: coverCredit(document).replace(/\s+/g, " ").slice(0, 24) };
}

/** Spine lettering size in millimetres; null when the spine is too thin to hold legible text. */
export function spineFontSizeMm(spineWidthMm: number) {
  if (!Number.isFinite(spineWidthMm) || spineWidthMm < 6) return null;
  return Math.min(7, spineWidthMm * 0.5);
}

/** New pages go before the back cover so it stays last. */
export function newPageIndex(document: Pick<StorybookDocument, "pages">) {
  return hasBackCover(document) ? document.pages.length - 1 : document.pages.length;
}

/** The front cover stays first and the back cover stays last. */
export function canMovePage(document: Pick<StorybookDocument, "pages">, from: number, to: number) {
  if (from === to || to < 0 || to >= document.pages.length) return false;
  const back = backCoverIndex(document);
  return from !== 0 && to !== 0 && from !== back && to !== back;
}

export type StructureContext = { title: string; credit: string };
type MakeId = (prefix: "page" | "element") => string;

function structurePage(template: StorybookTemplate, makeId: MakeId, context: StructureContext): StorybookPage {
  const page: StorybookPage = { id: makeId("page"), background: template === "pattern" ? "#FFF6E3" : "#FFFFFF", elements: [] };
  return applyStorybookTemplate(page, template, () => makeId("element"), context);
}

/**
 * Adds the standard book parts that are still missing:
 * 앞표지 → 면지 → 작가의 말 → 속표지 → 본문 … → 면지 → 뒷표지.
 * Existing pages are never moved, edited or removed.
 */
export function completeBookStructure(document: StorybookDocument, makeId: MakeId, context: StructureContext, maxPages = MAX_STORYBOOK_PAGES) {
  const has = (template: StorybookTemplate) => document.pages.some(page => page.template === template);
  const front: StorybookPage[] = [];
  const back: StorybookPage[] = [];
  const added: string[] = [];
  const addPattern = !has("pattern");
  if (addPattern) { front.push(structurePage("pattern", makeId, context)); added.push("앞 면지"); }
  if (!has("author")) { front.push(structurePage("author", makeId, context)); added.push("작가의 말"); }
  if (!has("title")) { front.push(structurePage("title", makeId, context)); added.push("속표지"); }
  if (addPattern) { back.push(structurePage("pattern", makeId, context)); added.push("뒤 면지"); }
  const needsBack = !hasBackCover(document);
  if (needsBack) added.push("뒷표지");
  const total = document.pages.length + front.length + back.length + (needsBack ? 1 : 0);
  if (!added.length) return { document, added, error: "" };
  if (total > maxPages) return { document, added: [], error: `책 구성을 더하면 ${total}쪽이 되어 최대 ${maxPages}쪽을 넘어요. 쪽을 조금 줄인 뒤 다시 눌러 주세요.` };
  const pages = [...document.pages];
  const backCover = needsBack ? structurePage("back", makeId, context) : pages.pop()!;
  return { document: { ...document, pages: [pages[0], ...front, ...pages.slice(1), ...back, backCover] }, added, error: "" };
}

export type PatternDensity = "few" | "normal" | "many";
export type PatternSize = "small" | "normal" | "large";
export const PATTERN_DENSITY_LABELS: Record<PatternDensity, string> = { few: "적게", normal: "보통", many: "많이" };
export const PATTERN_SIZE_LABELS: Record<PatternSize, string> = { small: "작게", normal: "보통", large: "크게" };

function seededRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round4 = (value: number) => Number(value.toFixed(4));

/**
 * One picture repeated over the page in a staggered (zigzag) grid with small offsets.
 * pageAspect = page width / page height, imageAspect = picture width / height.
 */
export function patternElements(options: { assetId: string; imageAspect: number; pageAspect: number; density: PatternDensity; size: PatternSize; rotate: boolean; makeId: () => string; seed?: number }): StorybookElement[] {
  const { assetId, pageAspect, density, size, rotate, makeId } = options;
  const imageAspect = Math.min(10, Math.max(0.1, Number.isFinite(options.imageAspect) ? options.imageAspect : 1));
  const cols = density === "few" ? 3 : density === "many" ? 5 : 4;
  const cellW = 1 / cols;
  const rows = Math.max(2, Math.round(1 / (cellW * pageAspect)));
  const cellH = 1 / rows;
  const scale = size === "small" ? 0.5 : size === "large" ? 0.84 : 0.68;
  let width = cellW * scale;
  let height = width * pageAspect / imageAspect;
  if (height > cellH * 0.92) { height = cellH * 0.92; width = height * imageAspect / pageAspect; }
  width = Math.max(0.04, width); height = Math.max(0.04, height);
  const random = seededRandom(options.seed ?? 20261028);
  const elements: StorybookElement[] = [];
  for (let row = 0; row < rows; row++) {
    const shifted = row % 2 === 1;
    const count = shifted ? cols - 1 : cols;
    for (let col = 0; col < count; col++) {
      const centerX = col * cellW + cellW / 2 + (shifted ? cellW / 2 : 0) + (random() - 0.5) * 0.24 * cellW;
      const centerY = row * cellH + cellH / 2 + (random() - 0.5) * 0.24 * cellH;
      elements.push({
        id: makeId(),
        type: "image",
        assetId,
        x: round4(Math.min(1 - width, Math.max(0, centerX - width / 2))),
        y: round4(Math.min(1 - height, Math.max(0, centerY - height / 2))),
        width: round4(width),
        height: round4(height),
        rotation: rotate ? round4((random() - 0.5) * 28) : 0,
        zIndex: elements.length + 1,
        opacity: 1,
        locked: false,
        aspectRatio: round4(imageAspect),
      });
    }
  }
  return elements;
}

/** Replaces the page's copies of the chosen picture with a fresh pattern; other content stays. */
export function applyPattern(page: StorybookPage, elements: StorybookElement[], assetId: string): StorybookPage {
  const kept = page.elements.filter(element => !(element.type === "image" && element.assetId === assetId));
  return { ...page, template: "pattern", elements: [...elements, ...kept.map(element => element.type === "image" ? { ...element, zIndex: Math.min(10_000, element.zIndex + elements.length) } : element)] };
}

/** Area kept clear on the back cover for a future ISBN barcode (not printed, guide only). */
export const BARCODE_AREA = { x: 0.6, y: 0.79, width: 0.32, height: 0.15 } as const;

export type EbookView = { pages: number[]; label: string };
/** ebook order: front cover alone, then pages in pairs (or one at a time on narrow screens), then the back cover alone. */
export function ebookViews(document: Pick<StorybookDocument, "pages">, spread: boolean): EbookView[] {
  const back = backCoverIndex(document);
  const inner = innerPageIndexes(document);
  const views: EbookView[] = [{ pages: [0], label: "앞표지" }];
  if (spread) for (let i = 0; i < inner.length; i += 2) views.push({ pages: inner.slice(i, i + 2), label: inner.slice(i, i + 2).map(n => n + 1).join("–") + "쪽" });
  else for (const index of inner) views.push({ pages: [index], label: `${index + 1}쪽` });
  if (back !== null) views.push({ pages: [back], label: "뒷표지" });
  return views;
}
