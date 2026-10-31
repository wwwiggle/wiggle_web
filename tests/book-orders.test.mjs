import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { startTestServer } from "./harness/server.mjs";
import { sha256 } from "../lib/token-crypto.ts";
import { bookOrderSettingsReady, depositorName, printPagesFor, quoteTotals, unitPriceFor, validateBookOrderSettings } from "../lib/book-order-pricing.ts";

const settings = {
  basePrice: 30000, extraPagePrice: 1000, shippingFee: 4000, freeShippingQuantity: 10, vatIncluded: true, depositDays: 7,
  bank: { bankName: "꿈틀은행", accountNumber: "123-456-789012", accountHolder: "꿈틀출판" },
  supplier: { name: "꿈틀출판", ceo: "", businessNumber: "", address: "", phone: "", email: "" }, note: "입금 확인 후 2주 안에 보내요.",
};

test("견적 계산: 24쪽 최소·2쪽 단위·추가 쪽 가격·무료 배송·부가세", () => {
  assert.equal(printPagesFor(0), 24);
  assert.equal(printPagesFor(23), 24);
  assert.equal(printPagesFor(25), 26);
  assert.equal(printPagesFor(130), 130);
  assert.equal(printPagesFor(131), null, "최대 쪽 수를 넘으면 인쇄할 수 없다");
  assert.equal(unitPriceFor(24, settings), 30000);
  assert.equal(unitPriceFor(30, settings), 33000);
  // 2권 + 배송비, 부가세 포함
  assert.deepEqual(quoteTotals([{ printPages: 24, quantity: 2 }], settings), { quantity: 2, subtotal: 60000, shipping: 4000, supply: 58182, vat: 5818, total: 64000 });
  // 10권 이상이면 배송비 무료
  assert.equal(quoteTotals([{ printPages: 24, quantity: 10 }], settings).shipping, 0);
  // 부가세 별도면 10%를 더한다
  assert.deepEqual(quoteTotals([{ printPages: 24, quantity: 1 }], { ...settings, vatIncluded: false }), { quantity: 1, subtotal: 30000, shipping: 4000, supply: 34000, vat: 3400, total: 37400 });
  assert.equal(depositorName("꿈 틀 초 등 학 교", "WG261031-4821"), "꿈틀초등학교4821");
  assert.equal(bookOrderSettingsReady(validateBookOrderSettings(settings)), true);
  assert.equal(bookOrderSettingsReady(validateBookOrderSettings({ ...settings, bank: { ...settings.bank, accountNumber: "" } })), false, "계좌가 없으면 주문을 받지 않는다");
  assert.throws(() => validateBookOrderSettings({ ...settings, basePrice: -1 }), /0~10,000,000원/);
  assert.throws(() => validateBookOrderSettings({ ...settings, bank: { ...settings.bank, accountNumber: "abc-def" } }), /계좌번호/);
});

test("HTTP 그림책 주문: 가격 설정 전 차단, 견적서·입금 계좌, 소유권, 멱등, 상태 흐름, 그림 그리기 잠금", async (t) => {
  const server = await startTestServer({ env: { ADMIN_EMAILS: "admin@example.test", OPENAI_API_KEY: "" } });
  t.after(() => server.dispose());
  await server.fetch("/api/student");
  const expiry = new Date(Date.now() + 3600000).toISOString();
  const headers = {};
  for (const [id, email] of [["bo_owner", "owner@example.test"], ["bo_other", "other@example.test"], ["bo_admin", "admin@example.test"]]) {
    const token = randomUUID();
    headers[id] = { cookie: `wiggle_teacher=${token}`, "content-type": "application/json" };
    await server.DB.batch([
      server.DB.prepare("INSERT INTO teachers(id,email,display_name) VALUES(?,?,?)").bind(id, email, id === "bo_owner" ? "김담임" : id),
      server.DB.prepare("INSERT INTO teacher_sessions(token_hash,teacher_id,expires_at,last_used_at) VALUES(?,?,?,CURRENT_TIMESTAMP)").bind(await sha256(token), id, expiry),
    ]);
  }
  const studentToken = randomUUID();
  await server.DB.batch([
    server.DB.prepare("INSERT INTO classrooms(id,teacher_id,display_name,class_code,join_token) VALUES('bo_class','bo_owner','햇살반','7311','bo_join')"),
    server.DB.prepare("INSERT INTO classrooms(id,teacher_id,display_name,class_code,join_token) VALUES('bo_class2','bo_other','다른반','7312','bo_join2')"),
    server.DB.prepare("INSERT INTO student_profiles(id,classroom_id,nickname,animal,last_activity_at,claimed_at,seat_number,real_name) VALUES('bo_s1','bo_class','별','cat',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,1,'김하나')"),
    server.DB.prepare("INSERT INTO student_profiles(id,classroom_id,nickname,animal,last_activity_at,claimed_at) VALUES('bo_s2','bo_class2','달','dog',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)"),
    server.DB.prepare("INSERT INTO device_sessions(token_hash,student_id,expires_at,last_used_at) VALUES(?,?,?,CURRENT_TIMESTAMP)").bind(await sha256(studentToken), "bo_s1", expiry),
  ]);
  const student = { authorization: `Bearer ${studentToken}`, "content-type": "application/json" };
  const created = await (await server.fetch("/api/storybooks", { method: "POST", headers: student, body: "{}" })).json();
  const document = created.storybook.document;
  const longDocument = { ...document, pages: [document.pages[0], ...Array.from({ length: 30 }, (_, index) => ({ ...document.pages[0], id: `long_${index}`, template: "inner" }))] };
  const insertBook = (id, classroom, studentId, doc, status = "complete") => server.DB.prepare(`INSERT INTO storybooks(id,student_id,classroom_id,title,document_json,status,completed_at) VALUES(?,?,?,?,?,?,${status === "complete" ? "CURRENT_TIMESTAMP" : "NULL"})`).bind(id, studentId, classroom, `책 ${id}`, JSON.stringify(doc), status);
  await server.DB.batch([
    insertBook("bo_short", "bo_class", "bo_s1", document),
    insertBook("bo_long", "bo_class", "bo_s1", longDocument),
    insertBook("bo_draft", "bo_class", "bo_s1", document, "draft"),
    insertBook("bo_foreign", "bo_class2", "bo_s2", document),
  ]);
  const post = async (path, body, who, status) => { const response = await server.fetch(path, { method: "POST", headers: headers[who], body: JSON.stringify(body) }); const value = await response.json(); assert.equal(response.status, status, `${path} ${JSON.stringify(value)}`); return value; };
  const shipping = { recipientName: "김담임", recipientPhone: "010-1234-5678", postalCode: "04524", address1: "서울시 중구 세종대로 110", address2: "3층 교무실", memo: "" };
  const order = (items, extra = {}) => ({ requestId: randomUUID(), classroomId: "bo_class", schoolName: "햇살초등학교", grade: 3, classNumber: 2, shipping, notes: "", confirmed: true, items, ...extra });

  // 가격·계좌를 넣기 전에는 주문을 받지 않는다.
  let desk = await (await server.fetch("/api/teacher/book-orders?classroomId=bo_class", { headers: headers.bo_owner })).json();
  assert.equal(desk.ready, false);
  assert.equal(desk.settings, null);
  await post("/api/teacher/book-orders", order([{ storybookId: "bo_short", quantity: 1 }]), "bo_owner", 400);
  // 설정은 운영자만.
  await post("/api/admin/book-orders", { action: "settings", settings }, "bo_owner", 403);
  assert.equal((await server.fetch("/api/admin/book-orders", { headers: headers.bo_owner })).status, 403);
  await post("/api/admin/book-orders", { action: "settings", settings: { ...settings, bank: { ...settings.bank, accountNumber: "계좌" } } }, "bo_admin", 400);
  await post("/api/admin/book-orders", { action: "settings", settings }, "bo_admin", 200);

  desk = await (await server.fetch("/api/teacher/book-orders?classroomId=bo_class", { headers: headers.bo_owner })).json();
  assert.equal(desk.ready, true);
  assert.equal(desk.settings.bank.accountNumber, "123-456-789012");
  assert.deepEqual(desk.books.map((book) => [book.id, book.printPages]).sort(), [["bo_long", 30], ["bo_short", 24]], "완성된 우리 반 책만, 인쇄 쪽 수와 함께");
  assert.equal((await server.fetch("/api/teacher/book-orders?classroomId=bo_class", { headers: headers.bo_other })).status, 403);

  // 잘못된 주문은 거절한다.
  await post("/api/teacher/book-orders", order([{ storybookId: "bo_draft", quantity: 1 }]), "bo_owner", 400);
  await post("/api/teacher/book-orders", order([{ storybookId: "bo_foreign", quantity: 1 }]), "bo_owner", 400);
  await post("/api/teacher/book-orders", order([{ storybookId: "bo_short", quantity: 0 }]), "bo_owner", 400);
  await post("/api/teacher/book-orders", order([{ storybookId: "bo_short", quantity: 1 }, { storybookId: "bo_short", quantity: 1 }]), "bo_owner", 400);
  await post("/api/teacher/book-orders", order([{ storybookId: "bo_short", quantity: 1 }], { grade: 7 }), "bo_owner", 400);
  await post("/api/teacher/book-orders", order([{ storybookId: "bo_short", quantity: 1 }], { confirmed: false }), "bo_owner", 400);
  await post("/api/teacher/book-orders", order([{ storybookId: "bo_short", quantity: 1 }], { shipping: { ...shipping, postalCode: "12" } }), "bo_owner", 400);

  // 주문 → 견적서. 같은 주문 번호로 다시 보내도 한 건이다.
  const body = order([{ storybookId: "bo_short", quantity: 2 }, { storybookId: "bo_long", quantity: 1 }]);
  const first = await post("/api/teacher/book-orders", body, "bo_owner", 201);
  assert.equal((await post("/api/teacher/book-orders", body, "bo_owner", 201)).id, first.id);
  await post("/api/teacher/book-orders", body, "bo_other", 400);
  const quote = async (who, status = 200) => { const response = await server.fetch(`/api/book-orders/${first.id}`, { headers: headers[who] }); assert.equal(response.status, status); return response.json(); };
  const view = (await quote("bo_owner")).order;
  assert.match(view.order_number, /^WG\d{6}-\d{4}$/);
  assert.equal(view.status, "awaiting_deposit");
  assert.deepEqual(view.document.items.map((item) => [item.storybookId, item.printPages, item.unitPrice, item.amount]), [["bo_short", 24, 30000, 60000], ["bo_long", 30, 33000, 33000]]);
  assert.deepEqual(view.quote.totals, { quantity: 3, subtotal: 93000, shipping: 4000, supply: 88182, vat: 8818, total: 97000 });
  assert.equal(view.quote.bank.accountHolder, "꿈틀출판");
  assert.equal(view.quote.depositorName, `햇살초등학교${view.order_number.slice(-4)}`);
  assert.equal(view.document.classroom.school, "햇살초등학교");
  assert.ok(!JSON.stringify(view).includes("김하나"), "견적서·주문 기록에 학생 실명을 싣지 않는다");
  await quote("bo_other", 404);
  assert.equal((await quote("bo_admin")).admin, true);
  assert.equal((await server.fetch(`/api/book-orders/${first.id}`)).status, 401);
  const profile = await server.DB.prepare("SELECT p.school_name AS school, b.grade, b.class_number AS classNumber FROM classroom_profiles p JOIN classroom_book_settings b ON b.classroom_id = p.classroom_id WHERE p.classroom_id='bo_class'").first();
  assert.deepEqual({ ...profile }, { school: "햇살초등학교", grade: 3, classNumber: 2 });

  // 나중에 가격·계좌를 바꿔도 이미 낸 견적서는 그대로다.
  await post("/api/admin/book-orders", { action: "settings", settings: { ...settings, basePrice: 50000, bank: { ...settings.bank, accountNumber: "999-999-999999" } } }, "bo_admin", 200);
  const unchanged = (await quote("bo_owner")).order;
  assert.equal(unchanged.quote.totals.total, 97000);
  assert.equal(unchanged.quote.bank.accountNumber, "123-456-789012");

  // 상태: 입금 확인 → 제작 중 → 발송 완료. 건너뛰기·되돌리기는 막는다. 입금 뒤 교사 취소도 막는다.
  await post("/api/admin/book-orders", { action: "status", id: first.id, status: "shipped" }, "bo_admin", 400);
  await post("/api/admin/book-orders", { action: "status", id: first.id, status: "paid" }, "bo_owner", 403);
  await post("/api/admin/book-orders", { action: "status", id: first.id, status: "paid", note: "10/31 입금 확인" }, "bo_admin", 200);
  await post("/api/teacher/book-orders", { action: "cancel", id: first.id }, "bo_owner", 400);
  await post("/api/admin/book-orders", { action: "status", id: first.id, status: "producing" }, "bo_admin", 200);
  await post("/api/admin/book-orders", { action: "status", id: first.id, status: "shipped", note: "운송장 1234" }, "bo_admin", 200);
  await post("/api/admin/book-orders", { action: "status", id: first.id, status: "paid" }, "bo_admin", 400);
  const shipped = (await quote("bo_owner")).order;
  assert.equal(shipped.status, "shipped");
  assert.equal(shipped.admin_note, "운송장 1234");
  assert.ok(shipped.paid_at && shipped.shipped_at);

  // 입금 전 주문은 교사가 직접 취소한다. 남의 주문은 취소하지 못한다.
  const second = await post("/api/teacher/book-orders", order([{ storybookId: "bo_short", quantity: 1 }]), "bo_owner", 201);
  await post("/api/teacher/book-orders", { action: "cancel", id: second.id }, "bo_other", 400);
  await post("/api/teacher/book-orders", { action: "cancel", id: second.id }, "bo_owner", 200);
  const list = await (await server.fetch("/api/teacher/book-orders?classroomId=bo_class", { headers: headers.bo_owner })).json();
  assert.deepEqual(list.orders.map((value) => value.status).sort(), ["canceled", "shipped"]);
  const admin = await (await server.fetch("/api/admin/book-orders", { headers: headers.bo_admin })).json();
  assert.equal(admin.orders.length, 2);

  // 주문 화면·견적서 화면이 열린다.
  assert.equal((await server.fetch("/teacher/class/bo_class/books/orders", { headers: headers.bo_owner })).status, 200);
  assert.equal((await server.fetch(`/teacher/book-orders/${first.id}`, { headers: headers.bo_owner })).status, 200);
  assert.equal((await server.fetch("/teacher/class/bo_class/books/print-request", { headers: headers.bo_owner })).status, 200, "기존 원고 PDF 제작 요청 화면도 남아 있다");

  // 그림 그리기는 유료 요금제로 잠겨 있다: 쓰기 API는 403, 읽기와 그림책은 그대로.
  for (const [method, path] of [["POST", "/api/artworks"], ["PUT", "/api/artworks/any_artwork"], ["PUT", "/api/artworks/any_artwork/image?kind=final"], ["POST", "/api/ai/coaching"]]) {
    const response = await server.fetch(path, { method, headers: student, body: "{}" });
    assert.equal(response.status, 403, `${method} ${path}`);
    assert.equal((await response.json()).code, "DRAWING_LOCKED");
  }
  assert.equal((await server.fetch("/api/ai/teacher-draft", { method: "POST", headers: headers.bo_owner, body: "{}" })).status, 403);
  assert.equal((await server.fetch("/api/artworks", { headers: student })).status, 200);
  assert.equal((await server.fetch("/api/student", { headers: student })).status, 200);
  assert.equal((await server.fetch("/api/storybooks", { method: "POST", headers: student, body: "{}" })).status, 201, "그림책 만들기는 그대로 된다");
  const drawPage = await (await server.fetch("/student/draw/new?mode=free")).text();
  assert.match(drawPage, /그림 그리기는 유료 요금제 기능이에요/);
  assert.doesNotMatch(drawPage, /도화지를 펴고 있어요/);
  // 「내 그림」 보관함과 완성 그림 보기도 잠긴다(2026-11-01).
  for (const path of ["/student/archive", "/student/archive/any_artwork"]) assert.match(await (await server.fetch(path)).text(), /그림 그리기는 유료 요금제 기능이에요/, path);
});
