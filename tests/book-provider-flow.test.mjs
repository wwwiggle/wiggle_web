import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { startTestServer } from "./harness/server.mjs";
import { sha256 } from "../lib/token-crypto.ts";
import { emptyStorybookDocument } from "../lib/storybook-model.ts";

test("모의 제공자 + 실제 HTTP: 전체 쪽 평가·부분 실패·재시도·단권/일괄 인쇄·주문 응답 유실 복구", async (t) => {
  const server = await startTestServer({ env: { OPENAI_API_KEY: "fixture-not-a-real-key", SWEETBOOK_API_KEY: "fixture-not-a-real-key", SWEETBOOK_ENV: "sandbox", WIGGLE_BOOK_PROVIDER_FIXTURE: "true", NODE_OPTIONS: `--import=${new URL("./harness/book-provider-fixture.mjs", import.meta.url).href}` } });
  t.after(() => server.dispose()); await server.fetch("/api/student");
  const teacherId = `teacher_${randomUUID()}`, classroomId = `class_${randomUUID().replaceAll("-", "").slice(0,24)}`, studentId = `student_${randomUUID()}`, session = randomUUID();
  const ids = [1,2].map(() => `storybook_${randomUUID().replaceAll("-", "")}`);
  const docs = ["친구의 마음", "실패테스트 이야기"].map((title) => { const doc = emptyStorybookDocument("square"); doc.pages[0].elements.find((e) => e.type === "text").text = title; const second = emptyStorybookDocument("square", "page_second0001", "element_secondtext0001"); second.pages[0].elements.find((e) => e.type === "text").text = "우리는 서로 손을 잡았어요."; doc.pages.push(second.pages[0]); return doc; });
  await server.DB.batch([
    server.DB.prepare("INSERT INTO teachers(id,email,display_name) VALUES (?,?,'테스트교사')").bind(teacherId, `${teacherId}@example.test`),
    server.DB.prepare("INSERT INTO classrooms(id,teacher_id,display_name,class_code,join_token) VALUES (?,?,'검증반','8457',?)").bind(classroomId, teacherId, randomUUID()),
    server.DB.prepare("INSERT INTO student_profiles(id,classroom_id,nickname,animal,last_activity_at,seat_number,real_name) VALUES (?,?,'별명','cat',CURRENT_TIMESTAMP,1,'테스트실명')").bind(studentId, classroomId),
    server.DB.prepare("INSERT INTO teacher_sessions(token_hash,teacher_id,expires_at,last_used_at) VALUES (?,?,?,CURRENT_TIMESTAMP)").bind(await sha256(session), teacherId, new Date(Date.now() + 3_600_000).toISOString()),
    ...ids.map((id,i) => server.DB.prepare("INSERT INTO storybooks(id,student_id,classroom_id,title,document_json,schema_version,revision,status,completed_at) VALUES (?,?,?,?,?,1,1,'complete',CURRENT_TIMESTAMP)").bind(id,studentId,classroomId,`다른 책 ${i}`,JSON.stringify(docs[i]))),
  ]);
  const headers = { cookie: `wiggle_teacher=${session}`, "content-type": "application/json" };
  async function post(path, body, status=200) { const r = await server.fetch(path, { method: "POST", headers, body: JSON.stringify({ classroomId,...body }) }); const value = await r.json(); assert.equal(r.status,status,JSON.stringify(value)); return value; }
  await post("/api/teacher/book-feedback", { storybookIds: ids }, 202);
  await Promise.all([post("/api/teacher/book-feedback/process", {}),post("/api/teacher/book-feedback/process", {})]);
  let jobs = (await server.DB.prepare("SELECT * FROM book_feedback_jobs ORDER BY storybook_id").all()).results;
  assert.equal(jobs.filter((j) => j.status === "complete").length,1, JSON.stringify(jobs.map((j) => ({status:j.status,error:j.error}))));
  assert.equal(jobs.filter((j) => j.status === "failed").length,1, JSON.stringify(jobs.map((j) => ({status:j.status,error:j.error}))));
  assert.ok(jobs.every((j) => j.attempts === 1));
  await post("/api/teacher/book-feedback", { storybookIds: ids }, 202);
  await post("/api/teacher/book-feedback/process", {});
  jobs = (await server.DB.prepare("SELECT * FROM book_feedback_jobs").all()).results;
  assert.ok(jobs.every((j) => j.status === "complete"));
  assert.notEqual(jobs[0].feedback_json,jobs[1].feedback_json);
  assert.ok(jobs.every((j) => JSON.parse(j.feedback_json).criteria[0].pages.includes(2)));
  await post("/api/teacher/book-print", { action:"prepare",storybookIds:ids,specUid:"SQUAREBOOK_HC" },202);
  await post("/api/teacher/book-print/process",{}); await post("/api/teacher/book-print/process",{});
  const prints = (await server.DB.prepare("SELECT * FROM book_print_jobs").all()).results;
  assert.equal(prints.length,2); assert.ok(prints.every((j) => j.status === "ready"), JSON.stringify(prints.map((j) => j.error)));
  assert.ok(prints.every(j=>JSON.parse(j.layout_json).innerSourcePages===1 && JSON.parse(j.layout_json).sourceLayoutVersion===3));
  const oldLayout=JSON.parse(prints[0].layout_json);delete oldLayout.sourceLayoutVersion;
  await server.DB.prepare('UPDATE book_print_jobs SET layout_json=? WHERE id=?').bind(JSON.stringify(oldLayout),prints[0].id).run();
  assert.equal((await server.fetch(`/api/teacher/book-print/${prints[0].id}?kind=inner`,{headers})).status,409);
  await post('/api/teacher/book-print',{action:'prepare',storybookIds:[prints[0].storybook_id],specUid:'SQUAREBOOK_HC'},202);
  assert.equal((await server.DB.prepare('SELECT status FROM book_print_jobs WHERE id=?').bind(prints[0].id).first()).status,'queued');
  await post('/api/teacher/book-print/process',{});
  const shipping={recipientName:"테스트교사",recipientPhone:"010-0000-0000",postalCode:"12345",address1:"테스트시 테스트로 123",address2:"4층",memo:"응답유실테스트"};

  await post("/api/teacher/book-print",{action:"estimate",items:prints.map((p)=>({jobId:p.id,quantity:1})),shipping},403);
  const requestId = randomUUID();
  const payload={requestId,schoolName:"검증초등학교",grade:4,classNumber:7,confirmed:true,items:prints.map((p)=>({jobId:p.id,quantity:1})),shipping};
  const submitted=await post("/api/teacher/print-requests",payload,201);
  await post("/api/teacher/print-requests",payload,201);
  assert.equal(submitted.id,requestId);
  assert.equal((await server.DB.prepare("SELECT COUNT(*) AS n FROM print_requests").first()).n,1);
  assert.ok(prints.every((p)=>p.book_uid===null),'Teachers never create provider books');
  await post("/api/admin/print-requests",{id:requestId,action:"prepare"},403);
  assert.equal((await server.fetch('/api/admin',{headers})).status,403);
  const adminId='teacher_admin',adminToken=randomUUID();
  await server.DB.batch([
    server.DB.prepare("INSERT INTO teachers(id,email,display_name) VALUES (?,'qudcks1940@gmail.com','관리자')").bind(adminId),
    server.DB.prepare("INSERT INTO teacher_sessions(token_hash,teacher_id,expires_at,last_used_at) VALUES (?,?,?,CURRENT_TIMESTAMP)").bind(await sha256(adminToken),adminId,new Date(Date.now()+3600000).toISOString())
  ]);
  const adminHeaders={...headers,cookie:`wiggle_teacher=${adminToken}`};
  async function admin(body,status=200){const r=await server.fetch('/api/admin/print-requests',{method:'POST',headers:adminHeaders,body:JSON.stringify({id:requestId,...body})});const value=await r.json();assert.equal(r.status,status,JSON.stringify(value));return value;}
  // Changing the classroom book after submission cannot mutate the submitted PDFs or prevent its order.
  await server.DB.prepare("UPDATE storybooks SET revision=revision+1 WHERE id=?").bind(ids[0]).run();
  assert.equal((await admin({action:'prepare'})).done,false);
  assert.equal((await admin({action:'prepare'})).done,false);
  const quote=await admin({action:'prepare'});assert.equal(quote.done,true);assert.equal(quote.estimate.paidCreditAmount,22000);
  await admin({action:'order',confirmed:false},400);
  await admin({action:'order',confirmed:true},400);
  assert.equal((await server.DB.prepare('SELECT status FROM print_requests WHERE id=?').bind(requestId).first()).status,'uncertain');
  await admin({action:'prepare'},400);
  const recovered=await admin({action:'order',confirmed:true});
  const repeated=await admin({action:'order',confirmed:true});
  assert.equal(recovered.result.orderUid,repeated.result.orderUid);
  assert.equal((await admin({action:'refresh'})).result.orderStatus,'SHIPPED');
  const dashboard=await (await server.fetch('/api/admin',{headers:adminHeaders})).json();
  assert.equal(dashboard.orders.length,1);assert.equal(dashboard.classrooms[0].school,'검증초등학교');assert.ok(dashboard.resources.usedMemory>0);assert.equal(dashboard.capacity,null);
  const details=JSON.parse((await server.DB.prepare('SELECT document_json FROM print_requests WHERE id=?').bind(requestId).first()).document_json);
  assert.equal(details.items.length,2);assert.equal(details.items[0].measurements.inner.length,24);
  assert.equal((await server.fetch(`/api/print-requests/${requestId}?kind=cover&item=${details.items[0].id}`,{headers:adminHeaders})).status,200);
  assert.equal((await server.fetch(`/api/print-requests/${requestId}?kind=request`)).status,401);
});
