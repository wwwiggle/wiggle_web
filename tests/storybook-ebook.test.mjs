import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { PDFDocument } from "pdf-lib";
import { startTestServer } from "./harness/server.mjs";
import { sha256 } from "../lib/token-crypto.ts";

test("HTTP ebook links: author and class teacher only, consent-gated sharing, rotation, square PDF", async t => {
  const server = await startTestServer({ env: { OPENAI_API_KEY: "", SWEETBOOK_API_KEY: "" } }); t.after(() => server.dispose());
  await server.fetch("/api/student");
  const [ownerToken, otherToken, teacherToken, wrongTeacherToken] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const expiry = new Date(Date.now() + 3600000).toISOString();
  const hash = Object.fromEntries(await Promise.all([ownerToken, otherToken, teacherToken, wrongTeacherToken].map(async token => [token, await sha256(token)])));
  await server.DB.batch([
    server.DB.prepare("INSERT INTO teachers(id,email,display_name) VALUES('eb_teacher','eb@example.test','교사')"),
    server.DB.prepare("INSERT INTO teachers(id,email,display_name) VALUES('eb_wrong','wrong@example.test','다른 교사')"),
    ...[[teacherToken, "eb_teacher"], [wrongTeacherToken, "eb_wrong"]].map(([token, id]) => server.DB.prepare("INSERT INTO teacher_sessions(token_hash,teacher_id,expires_at,last_used_at) VALUES(?,?,?,CURRENT_TIMESTAMP)").bind(hash[token], id, expiry)),
    server.DB.prepare("INSERT INTO classrooms(id,teacher_id,display_name,class_code,join_token) VALUES('eb_class','eb_teacher','비밀반이름','4515','eb_join')"),
    server.DB.prepare("INSERT INTO student_profiles(id,classroom_id,nickname,animal,last_activity_at,seat_number,real_name) VALUES('eb_owner','eb_class','비밀별명','cat',CURRENT_TIMESTAMP,3,'김비밀')"),
    server.DB.prepare("INSERT INTO student_profiles(id,classroom_id,nickname,animal,last_activity_at) VALUES('eb_other','eb_class','다른별','dog',CURRENT_TIMESTAMP)"),
    ...[[ownerToken, "eb_owner"], [otherToken, "eb_other"]].map(([token, id]) => server.DB.prepare("INSERT INTO device_sessions(token_hash,student_id,expires_at,last_used_at) VALUES(?,?,?,CURRENT_TIMESTAMP)").bind(hash[token], id, expiry)),
  ]);
  const owner = { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" };
  const other = { authorization: `Bearer ${otherToken}`, "content-type": "application/json" };
  const teacher = { cookie: `wiggle_teacher=${teacherToken}`, "content-type": "application/json" };
  const wrongTeacher = { cookie: `wiggle_teacher=${wrongTeacherToken}`, "content-type": "application/json" };

  const created = await (await server.fetch("/api/storybooks", { method: "POST", headers: owner, body: "{}" })).json();
  const bookId = created.storybook.id;
  const png = await sharp({ create: { width: 30, height: 30, channels: 3, background: "#3388cc" } }).png().toBuffer();
  const asset = (await (await server.fetch(`/api/storybooks/${bookId}/assets`, { method: "POST", headers: { ...owner, "content-type": "image/png" }, body: png })).json()).asset;
  const document = created.storybook.document;
  document.pages[0].backgroundAssetId = asset.id;
  await server.DB.prepare("UPDATE storybooks SET title='달빛 여행', document_json=? WHERE id=?").bind(JSON.stringify(document), bookId).run();

  // The author gets one stable, unguessable link; another student cannot.
  const link = await (await server.fetch(`/api/storybooks/${bookId}/ebook`, { method: "POST", headers: owner, body: "{}" })).json();
  assert.match(link.token, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(link.path, `/ebook/${link.token}`);
  assert.equal(link.shared, false);
  assert.equal((await (await server.fetch(`/api/storybooks/${bookId}/ebook`, { method: "POST", headers: owner, body: "{}" })).json()).token, link.token);
  assert.equal((await server.fetch(`/api/storybooks/${bookId}/ebook`, { method: "POST", headers: other, body: "{}" })).status, 404);

  const view = headers => server.fetch(`/api/ebook/${link.token}`, { headers });
  const ownerView = await view(owner);
  assert.equal(ownerView.status, 200);
  assert.equal(ownerView.headers.get("referrer-policy"), "no-referrer");
  assert.match(ownerView.headers.get("x-robots-tag") ?? "", /noindex/);
  const ownerData = await ownerView.json();
  assert.equal(ownerData.viewer, "owner");
  assert.equal(ownerData.storybook.status, "draft");
  assert.equal(ownerData.share.shared, false);
  assert.equal((await (await view(teacher)).json()).viewer, "teacher");
  for (const headers of [{}, other, wrongTeacher]) assert.equal((await view(headers)).status, 404, JSON.stringify(headers));
  for (const bad of ["short", "x".repeat(33), "../../etc/passwd"]) assert.equal((await server.fetch(`/api/ebook/${encodeURIComponent(bad)}`)).status, 404);
  assert.equal((await server.fetch(`/api/ebook/${link.token}/assets/${asset.id}`)).status, 404, "not shared: no anonymous images");

  // Sharing: teacher only, complete books only, guardian consent required.
  const teacherEbook = body => server.fetch(`/api/teacher/storybooks/${bookId}/ebook`, { method: "POST", headers: teacher, body: JSON.stringify(body) });
  assert.match((await (await teacherEbook({ action: "share", consentMethod: "paper", guardianConsent: true })).json()).error, /완성한 그림책/);
  await server.DB.prepare("UPDATE storybooks SET status='complete', completed_at=CURRENT_TIMESTAMP WHERE id=?").bind(bookId).run();
  assert.equal((await teacherEbook({ action: "share", consentMethod: "paper" })).status, 400);
  assert.equal((await teacherEbook({ action: "share", consentMethod: "email", guardianConsent: true })).status, 400);
  assert.equal((await server.fetch(`/api/teacher/storybooks/${bookId}/ebook`, { method: "POST", headers: wrongTeacher, body: JSON.stringify({ action: "share", consentMethod: "paper", guardianConsent: true }) })).status, 404);
  const shared = await (await teacherEbook({ action: "share", consentMethod: "paper", guardianConsent: true })).json();
  assert.equal(shared.shared, true);
  assert.equal(shared.consentMethod, "paper");

  const publicView = await view({});
  assert.equal(publicView.status, 200);
  const publicText = await publicView.text();
  const publicData = JSON.parse(publicText);
  assert.equal(publicData.viewer, "public");
  assert.equal(publicData.share, undefined);
  assert.equal(publicData.storybook.id, undefined);
  for (const secret of ["비밀별명", "김비밀", "비밀반이름", "eb_owner", "eb_class"]) assert.ok(!publicText.includes(secret), secret);
  const publicImage = await server.fetch(`/api/ebook/${link.token}/assets/${asset.id}`);
  assert.equal(publicImage.status, 200);
  assert.deepEqual(Buffer.from(await publicImage.arrayBuffer()), png);
  assert.equal((await server.fetch(`/api/ebook/${link.token}/pdf`)).status, 404, "a shared link is view-only");

  // Square PDF for the author.
  const pdfResponse = await server.fetch(`/api/ebook/${link.token}/pdf`, { headers: owner });
  assert.equal(pdfResponse.status, 200, await pdfResponse.clone().text());
  assert.equal(pdfResponse.headers.get("content-type"), "application/pdf");
  assert.match(decodeURIComponent(pdfResponse.headers.get("content-disposition") ?? ""), /달빛 여행\.pdf/);
  const pdf = await PDFDocument.load(new Uint8Array(await pdfResponse.arrayBuffer()));
  assert.equal(pdf.getPageCount(), document.pages.length, "every page of the book (new books start with 24 structured pages)");
  assert.ok(Math.abs(pdf.getPage(0).getWidth() * 25.4 / 72 - 243) < .01 && Math.abs(pdf.getPage(0).getHeight() * 25.4 / 72 - 248) < .01);

  // Editing a shared book pauses the public view until it is complete again.
  await server.DB.prepare("UPDATE storybooks SET status='draft', completed_at=NULL WHERE id=?").bind(bookId).run();
  assert.equal((await view({})).status, 409);
  assert.equal((await view(owner)).status, 200);
  await server.DB.prepare("UPDATE storybooks SET status='complete', completed_at=CURRENT_TIMESTAMP WHERE id=?").bind(bookId).run();

  // Rotation kills the old link and switches sharing off.
  const rotated = await (await teacherEbook({ action: "rotate" })).json();
  assert.notEqual(rotated.token, link.token);
  assert.equal(rotated.shared, false);
  assert.equal((await view(teacher)).status, 404);
  assert.equal((await server.fetch(`/api/ebook/${rotated.token}`)).status, 404);
  assert.equal((await (await server.fetch(`/api/ebook/${rotated.token}`, { headers: teacher })).json()).viewer, "teacher");

  // Teacher list includes books still being made.
  const second = (await (await server.fetch("/api/storybooks", { method: "POST", headers: other, body: "{}" })).json()).storybook.id;
  const list = await (await server.fetch("/api/teacher/storybooks?classroomId=eb_class", { headers: teacher })).json();
  assert.ok(list.storybooks.some(book => book.id === bookId));
  assert.deepEqual(list.drafts.map(book => [book.id, book.pageCount]), [[second, 24]], "new books start with the full 24-page structure");

  // Archived students' books close for everyone.
  await server.DB.prepare("UPDATE student_profiles SET archived_at=CURRENT_TIMESTAMP WHERE id='eb_owner'").run();
  assert.equal((await server.fetch(`/api/ebook/${rotated.token}`, { headers: teacher })).status, 404);
});

test("HTTP class creation stores optional school and grade for the teacher only", async t => {
  const server = await startTestServer({ env: { OPENAI_API_KEY: "" } }); t.after(() => server.dispose());
  await server.fetch("/api/student");
  const token = randomUUID();
  const tokenHash = await sha256(token);
  await server.DB.batch([
    server.DB.prepare("INSERT INTO teachers(id,email,display_name) VALUES('sg_teacher','sg@example.test','교사')"),
    server.DB.prepare("INSERT INTO teacher_sessions(token_hash,teacher_id,expires_at,last_used_at) VALUES(?,?,?,CURRENT_TIMESTAMP)").bind(tokenHash, "sg_teacher", new Date(Date.now() + 3600000).toISOString()),
  ]);
  const headers = { cookie: `wiggle_teacher=${token}`, "content-type": "application/json" };
  const post = body => server.fetch("/api/teacher", { method: "POST", headers, body: JSON.stringify(body) });
  assert.equal((await post({ action: "createClassroom", displayName: "학년 반", roster: [{ seatNumber: 1, realName: "김민준" }], grade: 9 })).status, 400);
  const created = await (await post({ action: "createClassroom", displayName: "학년 반", roster: [{ seatNumber: 1, realName: "김민준" }], schoolName: "꿈틀초등학교", grade: "4" })).json();
  const classroomId = created.classroom.id;
  const view = await (await server.fetch(`/api/teacher?classroomId=${classroomId}`, { headers })).json();
  assert.deepEqual(view.profile, { schoolName: "꿈틀초등학교", grade: 4 });
  const orders = await (await server.fetch(`/api/teacher/print-requests?classroomId=${classroomId}`, { headers })).json();
  assert.equal(orders.profile?.school_name, "꿈틀초등학교", "print orders are pre-filled");
  assert.equal(orders.room?.grade, 4);
  assert.equal((await post({ action: "updateClassroomProfile", classroomId, schoolName: "", grade: null })).status, 200);
  assert.deepEqual((await (await server.fetch(`/api/teacher?classroomId=${classroomId}`, { headers })).json()).profile, { schoolName: "", grade: null });
  const plain = await (await post({ action: "createClassroom", displayName: "선택 안 함 반", roster: [{ seatNumber: 1, realName: "이서연" }] })).json();
  assert.equal(await server.DB.prepare("SELECT school_name FROM classroom_profiles WHERE classroom_id=?").bind(plain.classroom.id).first(), null, "nothing stored when not given");
});
