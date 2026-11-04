import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { startTestServer } from "./harness/server.mjs";
import { sha256 } from "../lib/token-crypto.ts";
import { isStudentPagePath, studentAppEnabled } from "../lib/product-mode.ts";

// 2026-11-04 그림책 공방: 학생 앱을 끄면(기본) 학생·가족 화면이 닫히고, 선생님은 명단 없이 학급을 만들어
// 지은이 이름만 적고 책을 올린다. WIGGLE_STUDENT_APP=1이면 예전 수업 앱 그대로다.

test("학생 앱 스위치는 1일 때만 켜지고, 닫히는 화면 주소를 가린다", () => {
  assert.equal(studentAppEnabled({}), false);
  assert.equal(studentAppEnabled({ WIGGLE_STUDENT_APP: "1" }), true);
  assert.equal(studentAppEnabled({ WIGGLE_STUDENT_APP: "0" }), false);
  for (const path of ["/join", "/join/abc", "/student", "/student/draw/new", "/family/view"]) assert.equal(isStudentPagePath(path), true, path);
  for (const path of ["/", "/teacher", "/teacher/class/x/books", "/studentish", "/api/student"]) assert.equal(isStudentPagePath(path), false, path);
});

test("그림책 공방: 학생 화면은 첫 화면으로, 명단 없는 학급, 지은이 이름으로 책 올리기", async (t) => {
  const server = await startTestServer({ env: { WIGGLE_STUDENT_APP: "" } }); t.after(() => server.dispose());
  for (const path of ["/join", "/student/draw/new?mode=free", "/family/view"]) {
    const response = await server.fetch(path, { redirect: "manual" });
    assert.ok([307, 308].includes(response.status), path);
    assert.equal(new URL(response.headers.get("location"), "http://x").pathname, "/");
  }
  // 첫 화면은 꿈틀 그림책(book.kkumtle.app)과 같은 상품 화면이고, 수업 코드 칸이 없다.
  const landing = await (await server.fetch("/")).text();
  assert.match(landing, /그림책 공방/);
  assert.match(landing, /그림책 하드커버 스퀘어북/);
  assert.match(landing, /href="\/teacher"[^>]*>그림책 만들기 시작</);
  assert.doesNotMatch(landing, /수업 코드 입력/);
  // 학생 API는 기존 기기 저장 때문에 열어 둔다.
  assert.notEqual((await server.fetch("/api/student")).status, 307);

  await server.fetch("/api/student");
  const teacherId = `teacher_${randomUUID()}`, token = randomUUID();
  await server.DB.batch([
    server.DB.prepare("INSERT INTO teachers(id,email,display_name) VALUES(?,?,'교사')").bind(teacherId, `${teacherId}@example.test`),
    server.DB.prepare("INSERT INTO teacher_sessions(token_hash,teacher_id,expires_at,last_used_at) VALUES(?,?,?,CURRENT_TIMESTAMP)").bind(await sha256(token), teacherId, new Date(Date.now() + 3_600_000).toISOString()),
  ]);
  const headers = { cookie: `wiggle_teacher=${token}`, "content-type": "application/json" };
  const send = (path, body) => server.fetch(path, { method: "POST", headers, body: JSON.stringify(body) });

  const created = await send("/api/teacher", { action: "createClassroom", displayName: "공방 4학년", roster: [] });
  assert.equal(created.status, 201, await created.clone().text());
  const { classroom } = await created.json();

  const book = (title, authorName) => ({ classroomId: classroom.id, authorName, title, format: "squarebook-hc", pageCount: 24, bookId: `storybook_${randomUUID().replaceAll("-", "")}` });
  assert.equal((await send("/api/teacher/book-import", book("첫 책", "  "))).status, 400);
  const first = book("첫 책", "김하늘");
  assert.equal((await send("/api/teacher/book-import", first)).status, 201);
  assert.equal((await send("/api/teacher/book-import", first)).status, 200, "같은 요청 번호를 다시 보내도 한 권");
  assert.equal((await send("/api/teacher/book-import", book("둘째 책", "김하늘"))).status, 201);
  assert.equal((await send("/api/teacher/book-import", book("셋째 책", "이바다"))).status, 201);
  const authors = await server.DB.prepare("SELECT seat_number AS seat, real_name AS name, entry_code AS code FROM student_profiles WHERE classroom_id=? ORDER BY seat_number").bind(classroom.id).all();
  assert.deepEqual(authors.results, [{ seat: 1, name: "김하늘", code: null }, { seat: 2, name: "이바다", code: null }]);
  const books = await server.DB.prepare("SELECT COUNT(*) AS n FROM storybooks WHERE classroom_id=?").bind(classroom.id).first();
  assert.equal(Number(books.n), 3);

  // 다른 교사의 학급에는 지은이를 만들 수 없다.
  const otherRoom = `class_${randomUUID()}`, otherTeacher = `teacher_${randomUUID()}`;
  await server.DB.batch([
    server.DB.prepare("INSERT INTO teachers(id,email,display_name) VALUES(?,?,'다른 교사')").bind(otherTeacher, `${otherTeacher}@example.test`),
    server.DB.prepare("INSERT INTO classrooms(id,teacher_id,display_name,class_code,join_token) VALUES(?,?,'남의 반','8812',?)").bind(otherRoom, otherTeacher, randomUUID()),
  ]);
  assert.equal((await send("/api/teacher/book-import", { ...book("남의 책", "몰래"), classroomId: otherRoom })).status, 403);
  const leaked = await server.DB.prepare("SELECT COUNT(*) AS n FROM student_profiles WHERE classroom_id=?").bind(otherRoom).first();
  assert.equal(Number(leaked.n), 0);
});

test("수업 앱(WIGGLE_STUDENT_APP=1)에서는 명단 없는 학급을 만들 수 없다", async (t) => {
  const server = await startTestServer(); t.after(() => server.dispose()); await server.fetch("/api/student");
  const teacherId = `teacher_${randomUUID()}`, token = randomUUID();
  await server.DB.batch([
    server.DB.prepare("INSERT INTO teachers(id,email,display_name) VALUES(?,?,'교사')").bind(teacherId, `${teacherId}@example.test`),
    server.DB.prepare("INSERT INTO teacher_sessions(token_hash,teacher_id,expires_at,last_used_at) VALUES(?,?,?,CURRENT_TIMESTAMP)").bind(await sha256(token), teacherId, new Date(Date.now() + 3_600_000).toISOString()),
  ]);
  const response = await server.fetch("/api/teacher", { method: "POST", headers: { cookie: `wiggle_teacher=${token}`, "content-type": "application/json" }, body: JSON.stringify({ action: "createClassroom", displayName: "수업 반", roster: [] }) });
  assert.equal(response.status, 400);
  assert.ok(![307, 308].includes((await server.fetch("/join/abc", { redirect: "manual" })).status), "수업 앱에서는 학생 화면을 막지 않는다");
});
