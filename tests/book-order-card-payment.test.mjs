import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { startTestServer } from "./harness/server.mjs";
import { sha256 } from "../lib/token-crypto.ts";

// 2026-11-04 그림책 공방 카드 결제: 견적서 금액과 같아야 승인하고, 승인되면 주문이 입금 확인(paid)으로 간다.
// 새로고침으로 같은 결제가 다시 와도 한 번만, 남의 주문·다른 결제는 막는다. 토스는 가짜 서버로 대신한다.

async function fakeToss() {
  const calls = [];
  let reply = (path, body) => ({ status: 200, body: { paymentKey: body.paymentKey, orderId: body.orderId, status: "DONE", totalAmount: body.amount, method: "카드", approvedAt: "2026-11-04T10:00:00+09:00" } });
  const server = createServer(async (request, response) => {
    let raw = ""; for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    calls.push({ path: request.url, body, auth: request.headers.authorization, key: request.headers["idempotency-key"] });
    const { status, body: out } = reply(request.url, body);
    response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(out));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, calls, setReply(fn) { reply = fn; }, close: () => new Promise((resolve) => server.close(resolve)) };
}

test("카드 결제: 금액 확인, 승인 뒤 입금 확인, 멱등, 남의 주문 차단, 승인 실패", async (t) => {
  const toss = await fakeToss(); t.after(() => toss.close());
  const server = await startTestServer({ env: { TOSS_API_BASE: toss.url, TOSS_SECRET_KEY: "test_sk_fake", TOSS_CLIENT_KEY: "test_ck_fake" } });
  t.after(() => server.dispose());
  await server.fetch("/api/student");
  const expiry = new Date(Date.now() + 3_600_000).toISOString();
  const teacher = { id: `teacher_${randomUUID()}`, token: randomUUID() }, other = { id: `teacher_${randomUUID()}`, token: randomUUID() };
  for (const who of [teacher, other]) await server.DB.batch([
    server.DB.prepare("INSERT INTO teachers(id,email,display_name) VALUES(?,?,'교사')").bind(who.id, `${who.id}@example.test`),
    server.DB.prepare("INSERT INTO teacher_sessions(token_hash,teacher_id,expires_at,last_used_at) VALUES(?,?,?,CURRENT_TIMESTAMP)").bind(await sha256(who.token), who.id, expiry),
  ]);
  const order = (id, number, total) => server.DB.prepare("INSERT INTO book_orders(id,order_number,teacher_id,classroom_id,document_json,quote_json) VALUES(?,?,?,?,?,?)").bind(
    id, number, teacher.id, "class_x",
    JSON.stringify({ teacher: { name: "교사", email: "t@example.test" }, classroom: {}, shipping: {}, notes: "", product: "하드커버", items: [{ storybookId: "b1", title: "바다 친구들", quantity: 2 }] }),
    JSON.stringify({ totals: { quantity: 2, subtotal: 60000, shipping: 4000, supply: 58182, vat: 5818, total } }),
  ).run();
  const orderId = randomUUID(); await order(orderId, "WG261104-0001", 64000);
  const as = (who) => ({ cookie: `wiggle_teacher=${who.token}`, "content-type": "application/json" });
  const pay = (who, id, body) => server.fetch(`/api/book-orders/${id}/payment`, { method: "POST", headers: as(who), body: JSON.stringify(body) });

  const setup = await (await server.fetch(`/api/book-orders/${orderId}/payment`, { headers: as(teacher) })).json();
  assert.deepEqual({ ready: setup.ready, amount: setup.amount, clientKey: setup.clientKey, orderName: setup.orderName }, { ready: true, amount: 64000, clientKey: "test_ck_fake", orderName: "바다 친구들" });
  assert.equal((await server.fetch(`/api/book-orders/${orderId}/payment`, { headers: as(other) })).status, 404);

  assert.equal((await pay(teacher, orderId, { paymentKey: "pk_1", orderId, amount: 1000 })).status, 400, "견적서와 다른 금액");
  assert.equal((await pay(other, orderId, { paymentKey: "pk_1", orderId, amount: 64000 })).status, 400, "남의 주문");
  assert.equal((await pay(teacher, orderId, { paymentKey: "pk_1", orderId: randomUUID(), amount: 64000 })).status, 400, "다른 주문 번호");
  assert.equal(toss.calls.length, 0, "검증에 걸린 요청은 토스에 가지 않는다");

  const ok = await pay(teacher, orderId, { paymentKey: "pk_1", orderId, amount: 64000 });
  assert.equal(ok.status, 200, await ok.clone().text());
  assert.equal(toss.calls[0].path, "/v1/payments/confirm");
  assert.equal(toss.calls[0].auth, `Basic ${Buffer.from("test_sk_fake:").toString("base64")}`);
  const row = await server.DB.prepare("SELECT o.status, o.paid_at AS paidAt, p.payment_key AS paymentKey, p.amount FROM book_orders o JOIN book_order_payments p ON p.order_id=o.id WHERE o.id=?").bind(orderId).first();
  assert.equal(row.status, "paid"); assert.ok(row.paidAt); assert.equal(row.paymentKey, "pk_1"); assert.equal(Number(row.amount), 64000);

  assert.equal((await pay(teacher, orderId, { paymentKey: "pk_1", orderId, amount: 64000 })).status, 200, "새로고침해도 한 번만");
  assert.equal((await pay(teacher, orderId, { paymentKey: "pk_2", orderId, amount: 64000 })).status, 400, "이미 결제한 주문");
  assert.equal(toss.calls.filter((call) => call.path.includes("/cancel")).length, 0);
  assert.equal((await (await server.fetch(`/api/book-orders/${orderId}/payment`, { headers: as(teacher) })).json()).ready, false, "결제한 주문은 결제창을 열지 않는다");

  // 토스가 승인을 거절하면 주문은 그대로다.
  const declined = randomUUID(); await order(declined, "WG261104-0002", 30000);
  toss.setReply(() => ({ status: 400, body: { code: "REJECT_CARD_PAYMENT", message: "한도 초과" } }));
  const no = await pay(teacher, declined, { paymentKey: "pk_3", orderId: declined, amount: 30000 });
  assert.equal(no.status, 400); assert.match((await no.json()).error, /한도 초과/);
  assert.equal((await server.DB.prepare("SELECT status FROM book_orders WHERE id=?").bind(declined).first()).status, "awaiting_deposit");

  // 승인 값이 다르면(금액 위조 등) 바로 취소한다.
  toss.setReply((path, body) => path.includes("/cancel") ? { status: 200, body: { status: "CANCELED" } } : { status: 200, body: { paymentKey: body.paymentKey, orderId: body.orderId, status: "DONE", totalAmount: 1 } });
  assert.equal((await pay(teacher, declined, { paymentKey: "pk_4", orderId: declined, amount: 30000 })).status, 400);
  assert.ok(toss.calls.some((call) => call.path === "/v1/payments/pk_4/cancel"));
  assert.equal((await server.DB.prepare("SELECT status FROM book_orders WHERE id=?").bind(declined).first()).status, "awaiting_deposit");
});
