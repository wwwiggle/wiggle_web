// 그림책 주문 견적 계산(2026-10-31). 교사 화면의 미리 계산과 서버 견적이 같은 함수를 쓴다.
// 금액은 모두 원 단위 정수다. 단가·계좌는 운영자가 관리자 화면에서 정한다(코드에 박지 않는다).
import { BOOK_PRINT_PRODUCTS, BOOK_PRINT_SPEC_UID } from "@/lib/book-print-format";

export type BookOrderSupplier = { name: string; ceo: string; businessNumber: string; address: string; phone: string; email: string };
export type BookOrderBank = { bankName: string; accountNumber: string; accountHolder: string };
export type BookOrderSettings = {
  /** 1권 기본 가격(24쪽까지). */
  basePrice: number;
  /** 24쪽을 넘으면 2쪽마다 더하는 가격. */
  extraPagePrice: number;
  shippingFee: number;
  /** 이 권수 이상이면 배송비 무료. 0이면 무료 배송 없음. */
  freeShippingQuantity: number;
  /** true면 위 가격에 부가세가 들어 있다. false면 합계에 부가세 10%를 더한다. */
  vatIncluded: boolean;
  /** 주문일로부터 입금 기한(일). */
  depositDays: number;
  bank: BookOrderBank;
  supplier: BookOrderSupplier;
  /** 견적서 아래에 붙는 안내 문구. */
  note: string;
};

export const BOOK_ORDER_STATUSES = ["awaiting_deposit", "paid", "producing", "shipped", "canceled"] as const;
export type BookOrderStatus = (typeof BOOK_ORDER_STATUSES)[number];
export const BOOK_ORDER_STATUS_LABELS: Record<BookOrderStatus, string> = {
  awaiting_deposit: "입금 대기",
  paid: "입금 확인",
  producing: "제작 중",
  shipped: "발송 완료",
  canceled: "주문 취소",
};
/** 운영자가 옮길 수 있는 다음 상태. 되돌리기는 없다(잘못 누르면 메모로 남기고 취소 후 다시 주문). */
export const BOOK_ORDER_NEXT: Record<BookOrderStatus, BookOrderStatus[]> = {
  awaiting_deposit: ["paid", "canceled"],
  paid: ["producing", "canceled"],
  producing: ["shipped"],
  shipped: [],
  canceled: [],
};

export const MAX_ORDER_BOOKS = 100;
export const MAX_COPIES_PER_BOOK = 200;
const product = BOOK_PRINT_PRODUCTS[BOOK_PRINT_SPEC_UID];

/** 앞·뒤표지를 뺀 속지 수 → 실제 인쇄 쪽 수(최소 24쪽, 2쪽 단위). 최대 쪽 수를 넘으면 null. */
export function printPagesFor(innerPages: number) {
  const pages = Math.max(product.pageMin, Math.ceil(Math.max(0, innerPages) / product.pageIncrement) * product.pageIncrement);
  return pages > product.pageMax ? null : pages;
}

export function unitPriceFor(printPages: number, settings: Pick<BookOrderSettings, "basePrice" | "extraPagePrice">) {
  const extraSteps = Math.ceil(Math.max(0, printPages - product.pageMin) / product.pageIncrement);
  return settings.basePrice + extraSteps * settings.extraPagePrice;
}

export type QuoteLine = { printPages: number; quantity: number };
export type QuoteTotals = { quantity: number; subtotal: number; shipping: number; supply: number; vat: number; total: number };

export function quoteTotals(lines: QuoteLine[], settings: BookOrderSettings): QuoteTotals {
  const quantity = lines.reduce((sum, line) => sum + line.quantity, 0);
  const subtotal = lines.reduce((sum, line) => sum + unitPriceFor(line.printPages, settings) * line.quantity, 0);
  const shipping = quantity === 0 || (settings.freeShippingQuantity > 0 && quantity >= settings.freeShippingQuantity) ? 0 : settings.shippingFee;
  const gross = subtotal + shipping;
  if (settings.vatIncluded) {
    const supply = Math.round(gross / 1.1);
    return { quantity, subtotal, shipping, supply, vat: gross - supply, total: gross };
  }
  const vat = Math.round(gross * 0.1);
  return { quantity, subtotal, shipping, supply: gross, vat, total: gross + vat };
}

/** 단가와 입금 계좌가 모두 있어야 교사가 주문할 수 있다. */
export function bookOrderSettingsReady(settings: BookOrderSettings | null): settings is BookOrderSettings {
  return !!settings && settings.basePrice > 0 && !!settings.bank.bankName && !!settings.bank.accountNumber && !!settings.bank.accountHolder && !!settings.supplier.name;
}

const text = (value: unknown, max: number) => (typeof value === "string" ? value.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max) : "");
function money(value: unknown, label: string) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 10_000_000) throw new Error(`${label}은 0~10,000,000원 사이 정수로 입력해 주세요.`);
  return number;
}

/** 관리자 입력을 검사해 저장할 값으로 만든다. 잘못된 값은 한국어 오류로 거절한다. */
export function validateBookOrderSettings(value: unknown): BookOrderSettings {
  const data = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const bank = (data.bank && typeof data.bank === "object" ? data.bank : {}) as Record<string, unknown>;
  const supplier = (data.supplier && typeof data.supplier === "object" ? data.supplier : {}) as Record<string, unknown>;
  const freeShippingQuantity = Number(data.freeShippingQuantity ?? 0), depositDays = Number(data.depositDays ?? 7);
  if (!Number.isInteger(freeShippingQuantity) || freeShippingQuantity < 0 || freeShippingQuantity > 10_000) throw new Error("무료 배송 권수는 0~10,000 사이 정수로 입력해 주세요.");
  if (!Number.isInteger(depositDays) || depositDays < 1 || depositDays > 60) throw new Error("입금 기한은 1~60일로 입력해 주세요.");
  const settings: BookOrderSettings = {
    basePrice: money(data.basePrice, "1권 기본 가격"),
    extraPagePrice: money(data.extraPagePrice ?? 0, "추가 쪽 가격"),
    shippingFee: money(data.shippingFee ?? 0, "배송비"),
    freeShippingQuantity,
    vatIncluded: data.vatIncluded !== false,
    depositDays,
    bank: { bankName: text(bank.bankName, 40), accountNumber: text(bank.accountNumber, 40), accountHolder: text(bank.accountHolder, 60) },
    supplier: { name: text(supplier.name, 80), ceo: text(supplier.ceo, 40), businessNumber: text(supplier.businessNumber, 20), address: text(supplier.address, 200), phone: text(supplier.phone, 30), email: text(supplier.email, 120) },
    note: text(data.note, 500),
  };
  if (settings.bank.accountNumber && !/^[0-9][0-9 -]{4,38}[0-9]$/.test(settings.bank.accountNumber)) throw new Error("계좌번호는 숫자와 - 만 입력해 주세요.");
  return settings;
}

export const won = (value: number) => `${value.toLocaleString("ko-KR")}원`;

/** 입금자명 안내: 학교 이름 + 주문번호 끝 4자리. 은행 입금자명 칸이 짧아 앞부분만 쓴다. */
export function depositorName(school: string, orderNumber: string) {
  return `${school.replace(/\s+/g, "").slice(0, 6)}${orderNumber.slice(-4)}`;
}

/** SQLite CURRENT_TIMESTAMP("2026-10-31 03:00:00", UTC)와 ISO 문자열을 모두 한국 날짜로 보여 준다. */
export function orderDate(value: string, withTime = false) {
  const date = new Date(/[zZ]|[+-]\d\d:\d\d$/.test(value) ? value : `${value.replace(" ", "T")}Z`);
  if (Number.isNaN(date.getTime())) return value;
  return withTime ? date.toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }) : date.toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul" });
}
