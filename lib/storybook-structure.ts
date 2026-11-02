// Book structure rules shared by the editor, the ebook viewer and the print/PDF renderers.
// Nothing here rewrites a saved book on load: every change is an explicit, additive action.
import {
  applyStorybookTemplate,
  DEFAULT_STORYBOOK_TEXT,
  MAX_STORYBOOK_PAGES,
  MIN_STORYBOOK_INNER_PAGES,
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
  if (template === "pattern") return "패턴 면지";
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

/** 책등 아래쪽에 들어가는 펴낸 곳 이름(2026-11-01 사용자 결정: 회사명 픽쳐 → 영문 Ficture). */
export const BOOK_PUBLISHER = "Ficture";

/** Text placed on the printed spine: 제목·지은이(앞표지 글 / 그림 칸)·펴낸 곳. Empty strings mean "leave it out". */
export function spineLabel(title: string, document: Pick<StorybookDocument, "pages">) {
  return { title: title.trim().slice(0, 40), author: coverCredit(document).replace(/\s+/g, " ").slice(0, 24), publisher: BOOK_PUBLISHER };
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
 * 책의 뼈대가 되는 쪽(앞표지·작가의 말·속표지·뒷표지). 지우지 않는다.
 * 2026-11-02: 면지는 뼈대에서 뺐다(사용자 지시 "면지는 없애"). 「패턴 면지 추가」로 넣은 쪽은 지울 수 있다.
 */
export function isStructurePage(document: Pick<StorybookDocument, "pages">, index: number) {
  const role = pageRole(document, index), template = document.pages[index]?.template;
  return role !== "inner" || template === "author" || template === "title";
}

/** 인쇄 내지(앞·뒤표지를 뺀 쪽) 최소 수. 표지 PDF는 따로, 내지 PDF는 24쪽부터 만든다(2026-11-02 사용자 결정). */
export const MIN_INNER_PAGES = MIN_STORYBOOK_INNER_PAGES;
export function innerPageCount(document: Pick<StorybookDocument, "pages">) {
  return innerPageIndexes(document).length;
}

/** 이 쪽을 지울 수 있는지. 지울 수 없으면 아이에게 보여 줄 까닭을 돌려준다(빈 문자열 = 지울 수 있음). */
export function pageDeleteBlock(document: Pick<StorybookDocument, "pages">, index: number, minInner = MIN_INNER_PAGES): string {
  if (document.pages.length <= 1) return "쪽이 하나뿐이라 지울 수 없어요.";
  const role = pageRole(document, index);
  if (role === "front") return "앞표지는 책의 뼈대라 지울 수 없어요.";
  if (role === "back") return "뒷표지는 책의 뼈대라 지울 수 없어요.";
  const template = document.pages[index]?.template;
  if (template === "author") return "작가의 말 쪽은 책의 뼈대라 지울 수 없어요.";
  if (template === "title") return "속표지는 책의 뼈대라 지울 수 없어요.";
  if (innerPageCount(document) <= minInner) return `최소 페이지가 ${minInner}페이지라서 쪽을 삭제할 수 없어요. (앞뒤 표지를 뺀 내지가 ${minInner}쪽보다 많을 때 지울 수 있어요.)`;
  return "";
}

/**
 * 쪽 복제(2026-11-02: 내지가 아니어도 언제나 복제할 수 있다).
 * 복사본은 늘 평범한 내지가 된다 — 표지·작가의 말·속표지 복사본이 뼈대로 잡혀 못 지우는 일이 없게.
 * 패턴 면지는 패턴 면지로 남는다. 뒷표지는 맨 끝에 남도록 복사본을 그 앞에 넣는다. 앞표지 복사본은 바로 뒤(2쪽)에 들어간다.
 */
export function duplicatedPage(document: Pick<StorybookDocument, "pages">, index: number, makeId: MakeId) {
  const page = document.pages[index];
  if (!page) return null;
  const { template, ...rest } = page;
  const copy: StorybookPage = { ...rest, id: makeId("page"), elements: page.elements.map(element => ({ ...element, id: makeId("element") })), ...(template === "pattern" ? { template } : {}) };
  const at = pageRole(document, index) === "back" ? index : index + 1;
  return { copy, at };
}

/**
 * 2026-11-02 사용자 결정: 책은 처음부터 「앞표지 → 작가의 말 → 속표지 → 내지 … → 뒷표지」 꼴을 갖춘다(면지는 넣지 않는다).
 * 빠진 부분만 더하고, 있는 쪽은 옮기거나 고치거나 지우지 않는다.
 */
export function completeBookStructure(document: StorybookDocument, makeId: MakeId, context: StructureContext, maxPages = MAX_STORYBOOK_PAGES) {
  const has = (template: StorybookTemplate) => document.pages.some(page => page.template === template);
  const front: StorybookPage[] = [];
  const added: string[] = [];
  if (!has("author")) { front.push(structurePage("author", makeId, context)); added.push("작가의 말"); }
  if (!has("title")) { front.push(structurePage("title", makeId, context)); added.push("속표지"); }
  const needsBack = !hasBackCover(document);
  if (needsBack) added.push("뒷표지");
  const total = document.pages.length + front.length + (needsBack ? 1 : 0);
  if (!added.length) return { document, added, error: "" };
  if (total > maxPages) return { document, added: [], error: `책 구성을 더하면 ${total}쪽이 되어 최대 ${maxPages}쪽을 넘어요. 쪽을 조금 줄인 뒤 다시 열어 주세요.` };
  const pages = [...document.pages];
  const backCover = needsBack ? structurePage("back", makeId, context) : pages.pop()!;
  const cover = pages[0].template ? pages[0] : applyStorybookTemplate(pages[0], "cover", () => makeId("element"), context);
  return { document: { ...document, pages: [cover, ...front, ...pages.slice(1), backCover] }, added, error: "" };
}

/** 새 그림책: 앞표지 + 내지 24쪽(작가의 말·속표지 포함) + 뒷표지 = 26쪽. 내지 PDF가 24쪽부터라서다(2026-11-02). */
export function newStructuredStorybook(format: StorybookDocument["format"], makeId: MakeId, minInner = MIN_INNER_PAGES): StorybookDocument {
  const context = { title: "", credit: "" };
  const cover = structurePage("cover", makeId, context);
  const inner = Array.from({ length: Math.max(1, minInner - 2) }, () => structurePage("inner", makeId, context));
  return {
    schemaVersion: 1, format,
    pages: [cover, structurePage("author", makeId, context), structurePage("title", makeId, context), ...inner, structurePage("back", makeId, context)],
  };
}

/** 아무것도 놓지 않은 면지(그림·글·배경 그림이 없는 패턴 쪽). 지워도 잃는 것이 없다. */
export function isEmptyEndpaper(page: StorybookPage) {
  return page.template === "pattern" && !page.backgroundAssetId && page.elements.length === 0;
}

/**
 * 만드는 중인 책을 열 때(2026-11-02):
 * - 11-01 뼈대 때 자동으로 들어간 **빈** 면지를 뺀다(그림을 놓은 면지는 그대로 둔다 — 아이 작업은 지우지 않는다).
 * - 내지가 24쪽보다 적으면 뒷표지 앞에 빈 내지를 더해 24쪽을 채운다. 있는 쪽은 고치지 않는다.
 */
export function settleInnerPages(document: StorybookDocument, makeId: MakeId, minInner = MIN_INNER_PAGES, maxPages = MAX_STORYBOOK_PAGES) {
  const removed = document.pages.filter((page, index) => index > 0 && isEmptyEndpaper(page)).length;
  let pages = removed ? document.pages.filter((page, index) => index === 0 || !isEmptyEndpaper(page)) : document.pages;
  const current = innerPageIndexes({ pages }).length;
  const room = Math.max(0, maxPages - pages.length);
  const added = Math.min(room, Math.max(0, minInner - current));
  if (added) {
    const at = newPageIndex({ pages });
    const blanks = Array.from({ length: added }, () => structurePage("inner", makeId, { title: "", credit: "" }));
    pages = [...pages.slice(0, at), ...blanks, ...pages.slice(at)];
  }
  return { document: removed || added ? { ...document, pages } : document, removed, added };
}

/** 「패턴 면지 추가」: 앞표지 바로 뒤에 패턴 면지 쪽을 하나 넣는다. */
export function insertPatternPage(document: StorybookDocument, elements: StorybookElement[], makeId: MakeId) {
  const page: StorybookPage = { id: makeId("page"), background: "#FFF6E3", template: "pattern", elements };
  return { document: { ...document, pages: [document.pages[0], page, ...document.pages.slice(1)] }, index: 1 };
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

/**
 * 패턴 면지(2026-11-02 사용자 지시): 그림 한 장을 가로 2장 × 세로 4줄로, 줄마다 반 칸씩 엇갈리게(지그재그) 8장 놓는다.
 * 그림 비율은 지키고 칸 안에 들어가게 줄인다. pageAspect = 쪽 가로/세로, imageAspect = 그림 가로/세로.
 */
export function patternEightElements(options: { assetId: string; imageAspect: number; pageAspect: number; makeId: () => string }): StorybookElement[] {
  const imageAspect = Math.min(10, Math.max(0.1, Number.isFinite(options.imageAspect) ? options.imageAspect : 1));
  // 줄 간격 0.2, 같은 줄 두 장 간격 0.4, 엇갈린 이웃 간격 0.2 → 그림 상자가 0.18 안쪽이면 서로 겹치지 않는다.
  const box = 0.18;
  let width = box, height = width * options.pageAspect / imageAspect;
  if (height > box) { height = box; width = height * imageAspect / options.pageAspect; }
  const columns = [[0.2, 0.6], [0.4, 0.8]];
  const rowCenters = [0.2, 0.4, 0.6, 0.8];
  return rowCenters.flatMap((centerY, row) => columns[row % 2].map((centerX, index) => ({
    id: options.makeId(), type: "image" as const, assetId: options.assetId,
    x: round4(centerX - width / 2), y: round4(centerY - height / 2), width: round4(width), height: round4(height),
    rotation: 0, zIndex: row * 2 + index + 1, opacity: 1, locked: false, aspectRatio: round4(imageAspect),
  })));
}

/** 패턴 쪽의 그림을 새 패턴으로 통째로 바꾼다. 글 칸은 남긴다. */
export function replacePattern(page: StorybookPage, elements: StorybookElement[]): StorybookPage {
  return { ...page, template: "pattern", elements: [...elements, ...page.elements.filter(element => element.type !== "image")] };
}

/** Replaces the page's copies of the chosen picture with a fresh pattern; other content stays. */
export function applyPattern(page: StorybookPage, elements: StorybookElement[], assetId: string): StorybookPage {
  const kept = page.elements.filter(element => !(element.type === "image" && element.assetId === assetId));
  return { ...page, template: "pattern", elements: [...elements, ...kept.map(element => element.type === "image" ? { ...element, zIndex: Math.min(10_000, element.zIndex + elements.length) } : element)] };
}

/** Area kept clear on the back cover for a future ISBN barcode (not printed, guide only). */
export const BARCODE_AREA = { x: 0.6, y: 0.79, width: 0.32, height: 0.15 } as const;

export type EbookView = { pages: number[]; label: string };
/**
 * ebook order: front cover alone, then pages in pairs, then the back cover alone.
 * 2026-11-02: 읽기 화면은 화면 폭과 상관없이 언제나 두 쪽씩 펼친다(실제 책처럼). spread=false는 옛 호출부 호환용.
 */
export function ebookViews(document: Pick<StorybookDocument, "pages">, spread: boolean): EbookView[] {
  const back = backCoverIndex(document);
  const inner = innerPageIndexes(document);
  const views: EbookView[] = [{ pages: [0], label: "앞표지" }];
  if (spread) for (let i = 0; i < inner.length; i += 2) views.push({ pages: inner.slice(i, i + 2), label: inner.slice(i, i + 2).map(n => n + 1).join("–") + "쪽" });
  else for (const index of inner) views.push({ pages: [index], label: `${index + 1}쪽` });
  if (back !== null) views.push({ pages: [back], label: "뒷표지" });
  return views;
}

/* 두 쪽 펼침 책 넘기기(app/components/BookFlip.tsx, 2026-11-02) */
/** 펼침 한 장. null = 그 자리에 쪽이 없음(닫힌 책의 빈 쪽 또는 홀수 끝의 빈 종이). */
export type BookSpread = { left: number | null; right: number | null; label: string; kind: "front" | "inner" | "back" };

/**
 * 읽기 화면의 펼침 순서. 실제 책처럼 맨 앞 쪽은 앞표지, 맨 뒤 쪽은 뒷표지로 각각 홀로 보인다.
 * 2026-11-02 사용자 지시: 마지막 쪽이 "back" 틀로 표시되지 않은 옛 책도 읽을 때는 마지막 쪽을 뒷표지로 본다
 * (인쇄·주문 쪽 규칙인 hasBackCover는 그대로 둔다).
 */
export function bookSpreads(document: Pick<StorybookDocument, "pages">): BookSpread[] {
  const spreads: BookSpread[] = [{ left: null, right: 0, label: "앞표지", kind: "front" }];
  const count = document.pages.length;
  const back = count > 1 ? count - 1 : null;
  const inner = Array.from({ length: Math.max(0, count - 2) }, (_, index) => index + 1);
  for (let i = 0; i < inner.length; i += 2) {
    const left = inner[i], right = inner[i + 1] ?? null;
    spreads.push({ left, right, label: right === null ? `${left + 1}쪽` : `${left + 1}–${right + 1}쪽`, kind: "inner" });
  }
  if (back !== null) spreads.push({ left: back, right: null, label: "뒷표지", kind: "back" });
  return spreads;
}

/** 이 쪽이 들어 있는 펼침 번호. */
export function spreadOfPage(spreads: BookSpread[], page: number) {
  const found = spreads.findIndex(spread => spread.left === page || spread.right === page);
  return found < 0 ? 0 : found;
}
