// 그림책 주문·견적서·입금 확인(2026-10-31).
// 교사: 우리 반 완성 그림책 + 권수 + 배송지 → 주문 → 즉시 견적서(입금 계좌 포함).
// 운영자: 관리자 화면에서 입금 확인 → 제작 중 → 발송 완료로 옮긴다. 실제 인쇄 발주는 기존 제작 요청 흐름을 따로 쓴다.
import "server-only";
import { randomInt } from "node:crypto";
import { bindings } from "@/db/runtime";
import { cleanText, type TeacherIdentity } from "@/lib/security";
import { bookClassroom } from "@/lib/book-workflow";
import { printableInnerCount, validateShipping } from "@/lib/book-print-workflow";
import { BOOK_PRINT_PRODUCTS, BOOK_PRINT_SPEC_UID } from "@/lib/book-print-format";
import {
  BOOK_ORDER_NEXT,
  BOOK_ORDER_STATUSES,
  MAX_COPIES_PER_BOOK,
  MAX_ORDER_BOOKS,
  bookOrderSettingsReady,
  depositorName,
  printPagesFor,
  quoteTotals,
  unitPriceFor,
  validateBookOrderSettings,
  type BookOrderSettings,
  type BookOrderStatus,
  type QuoteTotals,
} from "@/lib/book-order-pricing";

const SETTINGS_ID = "book_order";

export type BookOrderItem = { storybookId: string; title: string; revision: number; innerPages: number; printPages: number; quantity: number; unitPrice: number; amount: number };
export type BookOrderDocument = {
  teacher: { name: string; email: string };
  classroom: { id: string; name: string; school: string; grade: number; classNumber: number };
  shipping: ReturnType<typeof validateShipping>;
  notes: string;
  product: string;
  items: BookOrderItem[];
};
export type BookOrderQuote = {
  issuedAt: string;
  depositDueAt: string;
  totals: QuoteTotals;
  vatIncluded: boolean;
  bank: BookOrderSettings["bank"];
  supplier: BookOrderSettings["supplier"];
  note: string;
  depositorName: string;
};
export type BookOrderRow = { id: string; order_number: string; teacher_id: string; classroom_id: string; document_json: string; quote_json: string; status: BookOrderStatus; admin_note: string; paid_at: string | null; shipped_at: string | null; canceled_at: string | null; created_at: string; updated_at: string };
export type BookOrderView = Omit<BookOrderRow, "document_json" | "quote_json"> & { document: BookOrderDocument; quote: BookOrderQuote };

export function orderView(row: BookOrderRow): BookOrderView {
  const { document_json, quote_json, ...rest } = row;
  return { ...rest, document: JSON.parse(document_json), quote: JSON.parse(quote_json) };
}

export async function bookOrderSettings(): Promise<BookOrderSettings | null> {
  const row = await bindings().DB.prepare(`SELECT value_json FROM operations_settings WHERE id = ?`).bind(SETTINGS_ID).first<{ value_json: string }>();
  if (!row) return null;
  try { return validateBookOrderSettings(JSON.parse(row.value_json)); } catch { return null; }
}

export async function saveBookOrderSettings(value: unknown, adminEmail: string) {
  const settings = validateBookOrderSettings(value);
  await bindings().DB.prepare(`INSERT INTO operations_settings(id, value_json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET value_json = excluded.value_json`)
    .bind(SETTINGS_ID, JSON.stringify({ ...settings, updatedAt: new Date().toISOString(), updatedBy: adminEmail })).run();
  return settings;
}

type OrderableBook = { id: string; title: string; revision: number; documentJson: string; seatNumber: number | null; realName: string | null; nickname: string };

/** 학급의 완성 그림책과 각 책의 인쇄 쪽 수. 교사 화면 목록과 서버 검증이 같은 쿼리를 쓴다. */
export async function orderableBooks(teacherId: string, classroomId: string, ids?: string[]) {
  const filter = ids?.length ? ` AND b.id IN (${ids.map(() => "?").join(",")})` : "";
  const rows = await bindings().DB.prepare(`SELECT b.id, b.title, b.revision, b.document_json AS documentJson, s.seat_number AS seatNumber, s.real_name AS realName, s.nickname FROM storybooks b JOIN classrooms c ON c.id = b.classroom_id JOIN student_profiles s ON s.id = b.student_id WHERE c.id = ? AND c.teacher_id = ? AND c.active = 1 AND s.archived_at IS NULL AND b.status = 'complete' AND b.completed_at IS NOT NULL${filter} ORDER BY s.seat_number IS NULL, s.seat_number, b.updated_at DESC`)
    .bind(classroomId, teacherId, ...(ids ?? [])).all<OrderableBook>();
  return rows.results.map((book) => {
    let innerPages = 0;
    try { innerPages = printableInnerCount(book.documentJson); } catch { innerPages = 0; }
    return { id: book.id, title: book.title || "제목 없는 그림책", revision: book.revision, seatNumber: book.seatNumber, realName: book.realName, nickname: book.nickname, innerPages, printPages: printPagesFor(innerPages) };
  });
}

function orderNumber() {
  const now = new Date(Date.now() + 9 * 3600_000); // 한국 날짜
  return `WG${now.toISOString().slice(2, 10).replace(/-/g, "")}-${String(randomInt(0, 10_000)).padStart(4, "0")}`;
}

export async function createBookOrder(teacher: TeacherIdentity, body: Record<string, unknown>) {
  const db = bindings().DB, classroomId = cleanText(body.classroomId, 40), requestId = String(body.requestId ?? "");
  if (!/^[a-f0-9-]{36}$/.test(requestId)) throw new Error("주문 번호가 올바르지 않아요. 화면을 새로고침해 주세요.");
  const existing = await db.prepare(`SELECT id, teacher_id FROM book_orders WHERE id = ?`).bind(requestId).first<{ id: string; teacher_id: string }>();
  if (existing) { if (existing.teacher_id !== teacher.id) throw new Error("다른 주문 번호를 사용해 주세요."); return { id: existing.id }; }
  const room = await bookClassroom(teacher.id, classroomId);
  if (!room) throw new Error("학급 권한이 없어요.");
  const settings = await bookOrderSettings();
  if (!bookOrderSettingsReady(settings)) throw new Error("운영자가 가격과 입금 계좌를 준비 중이에요. 잠시 뒤 다시 주문해 주세요.");
  const school = cleanText(body.schoolName, 40), grade = Number(body.grade), classNumber = Number(body.classNumber);
  if (!school || !Number.isInteger(grade) || grade < 1 || grade > 6 || !Number.isInteger(classNumber) || classNumber < 1 || classNumber > 99) throw new Error("학교 이름과 학년(1~6)·반을 입력해 주세요.");
  if (body.confirmed !== true) throw new Error("주문 내용과 배송지를 확인해 주세요.");
  const shipping = validateShipping(body.shipping);
  const sources = body.items as { storybookId?: unknown; quantity?: unknown }[];
  if (!Array.isArray(sources) || !sources.length || sources.length > MAX_ORDER_BOOKS) throw new Error(`주문할 그림책을 1~${MAX_ORDER_BOOKS}권 골라 주세요.`);
  const ids = sources.map((source) => String(source.storybookId ?? ""));
  if (new Set(ids).size !== ids.length || ids.some((id) => !/^[A-Za-z0-9_-]{1,80}$/.test(id))) throw new Error("같은 그림책이 두 번 들어 있어요.");
  const books = new Map((await orderableBooks(teacher.id, classroomId, ids)).map((book) => [book.id, book]));
  const items: BookOrderItem[] = sources.map((source) => {
    const book = books.get(String(source.storybookId)), quantity = Number(source.quantity);
    if (!book) throw new Error("완성된 우리 반 그림책만 주문할 수 있어요. 목록을 새로고침해 주세요.");
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_COPIES_PER_BOOK) throw new Error(`책마다 1~${MAX_COPIES_PER_BOOK}권까지 주문할 수 있어요.`);
    if (book.printPages === null) throw new Error(`「${book.title}」은 쪽 수가 너무 많아 인쇄할 수 없어요.`);
    const unitPrice = unitPriceFor(book.printPages, settings);
    return { storybookId: book.id, title: book.title, revision: book.revision, innerPages: book.innerPages, printPages: book.printPages, quantity, unitPrice, amount: unitPrice * quantity };
  });
  const issuedAt = new Date();
  const document: BookOrderDocument = { teacher: { name: teacher.displayName, email: teacher.email }, classroom: { id: room.id, name: room.displayName, school, grade, classNumber }, shipping, notes: cleanText(body.notes, 1000), product: BOOK_PRINT_PRODUCTS[BOOK_PRINT_SPEC_UID].label, items };
  for (let attempt = 0; attempt < 5; attempt++) {
    const number = orderNumber();
    const quote: BookOrderQuote = {
      issuedAt: issuedAt.toISOString(),
      depositDueAt: new Date(issuedAt.getTime() + settings.depositDays * 86_400_000).toISOString(),
      totals: quoteTotals(items, settings), vatIncluded: settings.vatIncluded, bank: settings.bank, supplier: settings.supplier, note: settings.note,
      depositorName: depositorName(school, number),
    };
    try {
      await db.batch([
        db.prepare(`INSERT INTO book_orders(id, order_number, teacher_id, classroom_id, document_json, quote_json) VALUES (?, ?, ?, ?, ?, ?)`).bind(requestId, number, teacher.id, classroomId, JSON.stringify(document), JSON.stringify(quote)),
        db.prepare(`INSERT INTO classroom_profiles(classroom_id, school_name) VALUES (?, ?) ON CONFLICT(classroom_id) DO UPDATE SET school_name = excluded.school_name`).bind(classroomId, school),
        db.prepare(`INSERT INTO classroom_book_settings(classroom_id, grade, class_number) VALUES (?, ?, ?) ON CONFLICT(classroom_id) DO UPDATE SET grade = excluded.grade, class_number = excluded.class_number, updated_at = CURRENT_TIMESTAMP`).bind(classroomId, grade, classNumber),
      ]);
      return { id: requestId };
    } catch (error) {
      const retry = await db.prepare(`SELECT id FROM book_orders WHERE id = ? AND teacher_id = ?`).bind(requestId, teacher.id).first();
      if (retry) return { id: requestId };
      if (!/UNIQUE/i.test(String(error))) throw error;
    }
  }
  throw new Error("주문 번호를 만들지 못했어요. 다시 눌러 주세요.");
}

export async function teacherBookOrders(teacherId: string, classroomId: string) {
  const rows = await bindings().DB.prepare(`SELECT * FROM book_orders WHERE teacher_id = ? AND classroom_id = ? ORDER BY created_at DESC LIMIT 100`).bind(teacherId, classroomId).all<BookOrderRow>();
  return rows.results.map(orderView);
}

export async function bookOrder(id: string) {
  const row = await bindings().DB.prepare(`SELECT * FROM book_orders WHERE id = ?`).bind(id).first<BookOrderRow>();
  return row ? orderView(row) : null;
}

/** 교사는 입금 전 주문만 스스로 취소할 수 있다. */
export async function cancelBookOrder(teacherId: string, id: string) {
  const result = await bindings().DB.prepare(`UPDATE book_orders SET status = 'canceled', canceled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND teacher_id = ? AND status = 'awaiting_deposit'`).bind(id, teacherId).run();
  if (!result.meta.changes) throw new Error("입금 전 주문만 취소할 수 있어요. 입금 후에는 운영자에게 연락해 주세요.");
}

export async function allBookOrders() {
  const rows = await bindings().DB.prepare(`SELECT * FROM book_orders ORDER BY created_at DESC LIMIT 300`).all<BookOrderRow>();
  return rows.results.map(orderView);
}

/** 운영자 상태 변경. 허용된 다음 단계로만 옮기고, 동시에 두 번 눌러도 한 번만 바뀐다. */
export async function updateBookOrderStatus(id: string, status: string, note: unknown) {
  if (!(BOOK_ORDER_STATUSES as readonly string[]).includes(status)) throw new Error("주문 상태가 올바르지 않아요.");
  const db = bindings().DB, order = await db.prepare(`SELECT status FROM book_orders WHERE id = ?`).bind(id).first<{ status: BookOrderStatus }>();
  if (!order) throw new Error("주문을 찾을 수 없어요.");
  const next = status as BookOrderStatus;
  if (!BOOK_ORDER_NEXT[order.status].includes(next)) throw new Error("이 주문은 그 단계로 옮길 수 없어요. 화면을 새로고침해 주세요.");
  const stamp = next === "paid" ? ", paid_at = CURRENT_TIMESTAMP" : next === "shipped" ? ", shipped_at = CURRENT_TIMESTAMP" : next === "canceled" ? ", canceled_at = CURRENT_TIMESTAMP" : "";
  const adminNote = typeof note === "string" ? cleanText(note, 300) : null;
  const result = await db.prepare(`UPDATE book_orders SET status = ?, admin_note = COALESCE(?, admin_note), updated_at = CURRENT_TIMESTAMP${stamp} WHERE id = ? AND status = ?`).bind(next, adminNote, id, order.status).run();
  if (!result.meta.changes) throw new Error("다른 관리자가 먼저 바꿨어요. 화면을 새로고침해 주세요.");
}

export async function saveBookOrderNote(id: string, note: unknown) {
  const result = await bindings().DB.prepare(`UPDATE book_orders SET admin_note = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(cleanText(note, 300), id).run();
  if (!result.meta.changes) throw new Error("주문을 찾을 수 없어요.");
}
