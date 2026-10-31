// Book Print API products, verified 2026-09-17:
// https://api.sweetbook.com/docs/concepts/pdf-size/
// Products are data so another binding (e.g. SQUAREBOOK_LAYFLAT_HC, 16–46 pages) can be added once its
// PDF geometry and pricing are confirmed with the vendor. Until then only the hardcover square book is offered.
import type { PrintSize, PrintSpec } from "@/lib/book-render-shared";

/** Bumped when the cover/inner split changes so stale prepared PDFs are rebuilt (3 = back cover + spine text). */
export const PRINT_LAYOUT_VERSION = 3;

export type BookPrintProduct = {
  uid: string;
  label: string;
  bindingType: string;
  trimWidthMm: number;
  trimHeightMm: number;
  pageMin: number;
  pageMax: number;
  pageIncrement: number;
  /** Inner page PDF size including bleed. */
  innerWidthMm: number;
  innerHeightMm: number;
  /** Cover PDF width = coverBaseWidthMm + spine width. */
  coverBaseWidthMm: number;
  coverHeightMm: number;
  spineWidthMm: (pages: number) => number;
};

export const BOOK_PRINT_PRODUCTS = {
  SQUAREBOOK_HC: {
    uid: "SQUAREBOOK_HC",
    label: "고화질 스퀘어북 (하드커버, PUR)",
    bindingType: "PUR",
    trimWidthMm: 243,
    trimHeightMm: 248,
    pageMin: 24,
    pageMax: 130,
    pageIncrement: 2,
    innerWidthMm: 249,
    innerHeightMm: 254,
    coverBaseWidthMm: 534,
    coverHeightMm: 288,
    spineWidthMm: (pages: number) => (pages <= 64 ? 10 : 16),
  },
} satisfies Record<string, BookPrintProduct>;

export type BookPrintProductUid = keyof typeof BOOK_PRINT_PRODUCTS;
export const BOOK_PRINT_SPEC_UID: BookPrintProductUid = "SQUAREBOOK_HC";

export function bookPrintProduct(uid: string): BookPrintProduct | null {
  return Object.prototype.hasOwnProperty.call(BOOK_PRINT_PRODUCTS, uid) ? BOOK_PRINT_PRODUCTS[uid as BookPrintProductUid] : null;
}

/** Chooses the product for a page count. Today every printable book (24p+) uses the hardcover square book. */
export function bookPrintProductForPages(pages: number): BookPrintProduct | null {
  const candidates = Object.values(BOOK_PRINT_PRODUCTS) as BookPrintProduct[];
  return candidates.find(product => pages >= product.pageMin && pages <= product.pageMax) ?? null;
}

/** Spine width used for previews before the vendor's calculated size is known. */
export function estimatedSpineWidthMm(innerPages: number, uid: string = BOOK_PRINT_SPEC_UID) {
  const product = bookPrintProduct(uid) ?? BOOK_PRINT_PRODUCTS.SQUAREBOOK_HC;
  const pages = Math.ceil(Math.max(innerPages, product.pageMin) / product.pageIncrement) * product.pageIncrement;
  return product.spineWidthMm(Math.min(pages, product.pageMax));
}

export function assertBookPrintSpec(spec: PrintSpec) {
  const product = bookPrintProduct(spec.bookSpecUid);
  if (!product || spec.bindingType !== product.bindingType || spec.innerTrimWidthMm !== product.trimWidthMm || spec.innerTrimHeightMm !== product.trimHeightMm || spec.pageMin !== product.pageMin || spec.pageMax !== product.pageMax || spec.pageIncrement !== product.pageIncrement) throw new Error("243 × 248mm 스퀘어북 하드커버 제작 규격을 확인해 주세요.");
}

export function assertBookPrintSize(size: PrintSize, pages: number, uid: string = BOOK_PRINT_SPEC_UID) {
  const product = bookPrintProduct(uid);
  if (!product) throw new Error("알 수 없는 제작 판형이에요.");
  const spine = product.spineWidthMm(pages);
  if (!Number.isInteger(pages) || pages < product.pageMin || pages > product.pageMax || pages % product.pageIncrement || size.innerWidthMm !== product.innerWidthMm || size.innerHeightMm !== product.innerHeightMm || size.coverWidthMm !== product.coverBaseWidthMm + spine || size.coverHeightMm !== product.coverHeightMm || size.spineWidthMm !== spine) throw new Error("표지·내지 크기가 스퀘어북 하드커버 규격과 달라요. 제작사 규격을 확인해 주세요.");
}
