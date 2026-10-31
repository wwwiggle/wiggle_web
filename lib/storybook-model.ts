export const STORYBOOK_SCHEMA_VERSION = 1;
// Student authoring limit only; imported PDFs have no page-count ceiling.
export const MAX_STORYBOOK_PAGES = 131; // One cover and up to 130 inner pages.
export const MIN_STORYBOOK_PAGES = 24;
export function storybookCompletionError(title: string, pageCount: number, student = true) {
  if (!title.trim() || ["나의 새 그림책", "나의 그림책"].includes(title.trim())) return "그림책 제목을 직접 지어 주세요. 제목을 정해야 완성할 수 있어요.";
  if (student && pageCount < MIN_STORYBOOK_PAGES) return `표지를 포함해 최소 ${MIN_STORYBOOK_PAGES}페이지가 필요해요. 지금은 ${pageCount}페이지예요.`;
  return "";
}
// Pictures have no per-page count quota. Bound serialized metadata, not children's pictures.
// Keep metadata below the hosting request-body limit, independently of print page counts.
export const MAX_STORYBOOK_DOCUMENT_BYTES = 3_500_000;
export const MAX_STORYBOOK_TEXT_GRAPHEMES = 800;

// Legacy formats remain readable so existing books are never silently reshaped.
export const DEFAULT_STORYBOOK_FORMAT = "squarebook-hc";
export const STORYBOOK_FORMATS = ["landscape", "portrait", "square", DEFAULT_STORYBOOK_FORMAT] as const;
export type StorybookFormat = (typeof STORYBOOK_FORMATS)[number];
export function storybookAspectRatio(format: StorybookFormat) {
  return format === "squarebook-hc" ? 243 / 248 : format === "landscape" ? 4 / 3 : format === "portrait" ? 3 / 4 : 1;
}
export type StorybookTextAlign = "left" | "center" | "right";
export type StorybookVerticalAlign = "top" | "middle" | "bottom";
// "back" marks the last page as the back cover; "pattern" is an endpaper made of one repeated picture.
export const STORYBOOK_TEMPLATES = ["inner", "cover", "title", "author", "pattern", "back", "blank"] as const;
export type StorybookTemplate = (typeof STORYBOOK_TEMPLATES)[number];
export const STORYBOOK_TEMPLATE_LABELS: Record<StorybookTemplate, string> = { inner: "내지", cover: "앞표지", title: "속표지", author: "작가의 말", pattern: "패턴 면지", back: "뒷표지", blank: "자유롭게" };
/** Filled into empty title/credit fields when a cover or title-page layout is chosen. Never overwrites written text. */
export type StorybookTemplateContext = { title?: string; credit?: string };
export type StorybookCrop = { x: number; y: number; width: number; height: number };

export const DEFAULT_STORYBOOK_TEXT = "여기에 이야기를 써 보세요";
export const STORYBOOK_TEXT_BOX = { x: 0.06, y: 0.04, width: 0.88, height: 0.16 } as const;
export const STORYBOOK_IMAGE_AREA = { x: 0.04, y: 0.24, width: 0.92, height: 0.72 } as const;

export type StorybookElement = {
  id: string;
  type: "image" | "text";
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  zIndex: number;
  opacity: number;
  locked: boolean;
  assetId?: string;
  aspectRatio?: number;
  crop?: StorybookCrop;
  text?: string;
  fontSize?: number;
  color?: string;
  align?: StorybookTextAlign;
  verticalAlign?: StorybookVerticalAlign;
  textRole?: "story" | "title" | "credit" | "heading";
};

export type StorybookPage = {
  id: string;
  background: string;
  backgroundAssetId?: string;
  template?: StorybookTemplate;
  elements: StorybookElement[];
};

export type StorybookDocument = {
  schemaVersion: 1;
  format: StorybookFormat;
  pages: StorybookPage[];
};

const ID_PATTERN = /^(?:page|element|asset)_[a-zA-Z0-9_-]{8,64}$/;
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

function finiteBetween(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function round(value: number) {
  return Number(value.toFixed(4));
}

function graphemes(value: string) {
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    return [...new Intl.Segmenter("ko", { granularity: "grapheme" }).segment(value)].length;
  }
  return Array.from(value).length;
}

function cleanStoryText(value: string) {
  return value.normalize("NFC").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
}

function serializedBytes(value: unknown) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function validateElement(value: unknown): StorybookElement | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const element = value as Partial<StorybookElement>;
  if (!element.id || !ID_PATTERN.test(element.id) || !["image", "text"].includes(element.type ?? "")) return null;
  if (!finiteBetween(element.x, 0, 1) || !finiteBetween(element.y, 0, 1)) return null;
  if (!finiteBetween(element.width, 0.04, 1) || !finiteBetween(element.height, 0.04, 1)) return null;
  if (element.x + element.width > 1.001 || element.y + element.height > 1.001) return null;
  const zIndex = element.zIndex;
  if (!finiteBetween(element.rotation, -180, 180) || typeof zIndex !== "number" || !Number.isInteger(zIndex) || zIndex < 0 || zIndex > 10_000) return null;
  if (!finiteBetween(element.opacity, 0.05, 1) || typeof element.locked !== "boolean") return null;

  const normalized: StorybookElement = {
    id: element.id,
    type: element.type as StorybookElement["type"],
    x: round(element.x),
    y: round(element.y),
    width: round(element.width),
    height: round(element.height),
    rotation: round(element.rotation),
    zIndex,
    opacity: round(element.opacity),
    locked: element.locked,
  };

  if (element.type === "image") {
    if (!element.assetId || !ID_PATTERN.test(element.assetId)) return null;
    if (element.aspectRatio !== undefined && !finiteBetween(element.aspectRatio, 0.1, 10)) return null;
    normalized.assetId = element.assetId;
    if (element.aspectRatio !== undefined) normalized.aspectRatio = round(element.aspectRatio);
    if (element.crop !== undefined) {
      if (!element.crop || typeof element.crop !== "object" || Array.isArray(element.crop)) return null;
      const crop = element.crop as Partial<StorybookCrop>;
      if (!finiteBetween(crop.x, 0, 1) || !finiteBetween(crop.y, 0, 1)) return null;
      if (!finiteBetween(crop.width, 0.01, 1) || !finiteBetween(crop.height, 0.01, 1)) return null;
      if (crop.x + crop.width > 1.001 || crop.y + crop.height > 1.001) return null;
      normalized.crop = { x: round(crop.x), y: round(crop.y), width: round(crop.width), height: round(crop.height) };
    }
    return normalized;
  }

  if (typeof element.text !== "string") return null;
  const text = cleanStoryText(element.text);
  if (text !== element.text || graphemes(text) > MAX_STORYBOOK_TEXT_GRAPHEMES) return null;
  if (!finiteBetween(element.fontSize, 0.018, 0.12) || !element.color || !COLOR_PATTERN.test(element.color)) return null;
  if (!["left", "center", "right"].includes(element.align ?? "") || element.rotation !== 0 || element.opacity !== 1 || element.locked !== true) return null;
  if (element.verticalAlign !== undefined && !["top", "middle", "bottom"].includes(element.verticalAlign)) return null;
  if (element.textRole !== undefined && !["story", "title", "credit", "heading"].includes(element.textRole)) return null;
  normalized.text = text;
  normalized.fontSize = round(element.fontSize);
  normalized.color = element.color.toUpperCase();
  normalized.align = element.align;
  if (element.verticalAlign !== undefined) normalized.verticalAlign = element.verticalAlign;
  if (element.textRole !== undefined) normalized.textRole = element.textRole;
  return normalized;
}

export function validateStorybookDocument(value: unknown): StorybookDocument | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const document = value as Partial<StorybookDocument>;
  if (document.schemaVersion !== STORYBOOK_SCHEMA_VERSION || !STORYBOOK_FORMATS.includes(document.format as StorybookFormat)) return null;
  if (!Array.isArray(document.pages) || document.pages.length < 1) return null;

  const pageIds = new Set<string>();
  const elementIds = new Set<string>();
  const pages: StorybookPage[] = [];
  for (const raw of document.pages) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const page = raw as Partial<StorybookPage>;
    if (!page.id || !ID_PATTERN.test(page.id) || pageIds.has(page.id)) return null;
    if (!page.background || !COLOR_PATTERN.test(page.background)) return null;
    if (page.backgroundAssetId !== undefined && (!page.backgroundAssetId || !ID_PATTERN.test(page.backgroundAssetId))) return null;
    if (page.template !== undefined && !STORYBOOK_TEMPLATES.includes(page.template)) return null;
    if (!Array.isArray(page.elements)) return null;
    pageIds.add(page.id);
    const elements: StorybookElement[] = [];
    for (const rawElement of page.elements) {
      const element = validateElement(rawElement);
      if (!element || elementIds.has(element.id)) return null;
      elementIds.add(element.id);
      elements.push(element);
    }
    pages.push({ id: page.id, background: page.background.toUpperCase(), ...(page.backgroundAssetId ? { backgroundAssetId: page.backgroundAssetId } : {}), ...(page.template ? { template: page.template } : {}), elements });
  }

  const normalized: StorybookDocument = { schemaVersion: 1, format: document.format as StorybookFormat, pages };
  return serializedBytes(normalized) <= MAX_STORYBOOK_DOCUMENT_BYTES ? normalized : null;
}

// Applying a layout is explicit. Loading a saved book must never merge, truncate or move its contents.
// Extra text, illustrations and PDF backgrounds survive every template change.
export function applyStorybookTemplate(page: StorybookPage, template: StorybookTemplate, makeId: () => string, context: StorybookTemplateContext = {}): StorybookPage {
  if (template === "blank" || template === "back" || template === "pattern") return { ...page, template };
  const autoText = (role: StorybookElement["textRole"]) => cleanStoryText((role === "title" ? context.title : role === "credit" ? context.credit : undefined)?.trim() ?? "").slice(0, 120) || undefined;
  const fields: Partial<StorybookElement>[] = template === "cover" || template === "title" ? [
    { textRole: "title", x: .08, y: template === "cover" ? .08 : .18, width: .84, height: .2, fontSize: .065, align: "center" },
    { textRole: "credit", x: .12, y: .82, width: .76, height: .09, fontSize: .026, align: "center" },
  ] : template === "author" ? [
    { textRole: "story", x: .1, y: .43, width: .8, height: .45, fontSize: .026, verticalAlign: "top" },
    { textRole: "heading", x: .1, y: .28, width: .8, height: .12, fontSize: .045, text: "작가의 말" },
  ] : [{ textRole: "story", ...STORYBOOK_TEXT_BOX, fontSize: .035 }];
  const elements = page.elements.map(element => ({ ...element }));
  const used = new Set<string>();
  for (const field of fields) {
    let index = elements.findIndex(element => element.type === "text" && element.textRole === field.textRole && !used.has(element.id));
    if (index < 0) index = elements.findIndex(element => element.type === "text" && !element.textRole && !used.has(element.id));
    if (index >= 0) {
      const original = elements[index];
      elements[index] = { ...original, verticalAlign: "middle", ...field, text: original.text || field.text || autoText(field.textRole) || "" };
      used.add(original.id);
    } else {
      const element = { ...createStorybookTextElement(makeId()), verticalAlign: "middle" as const, ...field, text: field.text || autoText(field.textRole) || "" };
      elements.push(element); used.add(element.id);
    }
  }
  return { ...page, template, elements };
}

export function createStorybookTextElement(id = "element_startertext0001"): StorybookElement {
  return {
    id,
    type: "text",
    text: "",
    ...STORYBOOK_TEXT_BOX,
    rotation: 0,
    zIndex: 0,
    opacity: 1,
    locked: true,
    fontSize: 0.045,
    color: "#24324A",
    align: "left",
  };
}

export function emptyStorybookDocument(format: StorybookFormat = DEFAULT_STORYBOOK_FORMAT, pageId = "page_starter0001", textElementId = "element_startertext0001"): StorybookDocument {
  return { schemaVersion: 1, format, pages: [{ id: pageId, background: "#FFFFFF", elements: [createStorybookTextElement(textElementId)] }] };
}
