import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { startTestServer } from "./harness/server.mjs";

import { clearRedoAfterEdit, redoDrawing, undoDrawing } from "../lib/drawing-history.ts";
import { canvasPointerCanEdit, isQuickStationaryTap, savedInputMode } from "../lib/input-mode.ts";
import { mirrorOp } from "../lib/symmetry.ts";
import { settleUploadsBeforeCleanup } from "../lib/settled-uploads.ts";
import { sha256 } from "../lib/token-crypto.ts";

// 교사 인증은 더 이상 oai-* 헤더가 아니라 wiggle_teacher 세션 쿠키다 (lib/security.ts requireTeacher).
// 구글 OAuth 왕복을 흉내 내는 대신 교사 행과 세션을 DB에 직접 심고 그 토큰만 쿠키로 보낸다.
async function signInTeacher(server, email) {
  // 스키마는 첫 요청의 ensureSchema에서 세워진다 — 시드보다 먼저 한 번 두드려 테이블을 만든다.
  await server.fetch("/api/teacher");
  const token = randomUUID();
  const teacherId = `teacher_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const now = new Date();
  await server.DB.batch([
    server.DB.prepare(`INSERT INTO teachers(id, email, display_name, credential_hash, credential_salt) VALUES (?, ?, ?, '', '')`)
      .bind(teacherId, email, email.split("@")[0]),
    server.DB.prepare(`INSERT INTO teacher_sessions(token_hash, teacher_id, expires_at, last_used_at) VALUES (?, ?, ?, ?)`)
      .bind(await sha256(token), teacherId, new Date(now.getTime() + 8 * 60 * 60 * 1000).toISOString(), now.toISOString()),
  ]);
  return { "content-type": "application/json", cookie: `wiggle_teacher=${token}` };
}

// 주소는 x-forwarded-for로 흉내 낸다 — 플랫폼이 덮어쓰는, 앱이 실제로 신뢰하는 헤더다.
const studentHeaders = {
  "content-type": "application/json",
  "x-forwarded-for": "203.0.113.209",
};

const stroke = (suffix) => ({
  opId: `op_${suffix}`.padEnd(12, "0"),
  clientOpId: `client_${suffix}`.padEnd(14, "0"),
  type: "stroke",
  at: "2026-08-09T00:00:00.000Z",
  tool: "pencil",
  color: "#1B3A57",
  width: 16,
  points: [{ x: 0.2, y: 0.3, pressure: 0.5 }, { x: 0.4, y: 0.5, pressure: 0.8 }],
});

const documentWith = (ops) => ({ schemaVersion: 1, rendererVersion: 1, size: 1024, ops });


// 2026-08-09 00:00 + n분. SQLite datetime(…, '+n minutes')와 같은 모양을 JS에서 만든다(DB마다 날짜 함수가 달라서).
const atMinute = (minute) => `2026-08-09 00:${String(minute).padStart(2, "0")}:00`;
test("rapid undo and redo stay atomic, preserve mirror pairs, and new edits clear redo", () => {
  const first = stroke("first");
  const second = stroke("second");
  const mirrored = mirrorOp(second);
  let history = { document: documentWith([first, second, mirrored]), redo: [] };

  history = undoDrawing(history);
  assert.deepEqual(history.document.ops.map((op) => op.opId), [first.opId]);
  assert.equal(history.redo.length, 1);
  assert.equal(history.redo[0].length, 2, "a mirrored edit must be one history action");

  history = undoDrawing(history);
  assert.equal(history.document.ops.length, 0);
  assert.equal(history.redo.length, 2);

  history = redoDrawing(history);
  history = redoDrawing(history);
  assert.deepEqual(history.document.ops.map((op) => op.opId), [first.opId, second.opId, mirrored.opId]);
  assert.equal(history.redo.length, 0);

  history = undoDrawing(history);
  history = clearRedoAfterEdit(history, [stroke("replacement")]);
  assert.equal(history.redo.length, 0, "drawing after undo must invalidate the old redo branch");
});

test("pen mode is the safe default and the exact pointer contract is explicit", () => {
  const emptyStorage = { getItem: () => null };
  const fingerStorage = { getItem: (key) => key === "wiggle:input-mode" ? "finger" : null };
  assert.equal(savedInputMode(emptyStorage), "pen");
  assert.equal(savedInputMode(fingerStorage), "pen", "a shared tablet must start each new artwork in pen mode");
  assert.equal(canvasPointerCanEdit("pen", "pen"), true);
  assert.equal(canvasPointerCanEdit("pen", "mouse"), true);
  assert.equal(canvasPointerCanEdit("pen", "touch"), false, "one touch must not draw in pen mode");
  assert.equal(canvasPointerCanEdit("finger", "touch"), true);
  assert.equal(isQuickStationaryTap({ elapsedMs: 250, distancePx: 4 }), true);
  assert.equal(isQuickStationaryTap({ elapsedMs: 450, distancePx: 4 }), false);
  assert.equal(isQuickStationaryTap({ elapsedMs: 250, distancePx: 18 }), false);
});

test("a failed parallel upload waits for its late sibling before cleanup", async () => {
  const events = [];
  let finishLateUpload = () => {};
  const lateUpload = new Promise((resolve) => {
    finishLateUpload = () => { events.push("late upload finished"); resolve(); };
  });
  const failedUpload = Promise.reject(new Error("thumbnail failed"));
  const operation = settleUploadsBeforeCleanup([lateUpload, failedUpload], async () => { events.push("cleanup"); });

  await Promise.resolve();
  assert.deepEqual(events, [], "cleanup must not run while a sibling upload is still pending");
  finishLateUpload();
  await assert.rejects(operation, /thumbnail failed/);
  assert.deepEqual(events, ["late upload finished", "cleanup"]);
});

test("teacher artwork history is ownership-scoped, newest-first, and paginated", async (context) => {
  const server = await startTestServer();
  context.after(() => server.dispose());
  // 소유자와 제3자 두 교사의 쿠키를 미리 만들어 둔다 — 호출부는 예전처럼 이메일로 고른다.
  const sessions = new Map();
  for (const email of ["history-owner@example.com", "different-teacher@example.com"]) {
    sessions.set(email, await signInTeacher(server, email));
  }
  const teacherHeaders = (email) => sessions.get(email);

  const created = await server.fetch("/api/teacher", {
    method: "POST",
    headers: teacherHeaders("history-owner@example.com"),
    body: JSON.stringify({ action: "createClassroom", displayName: "작품 기록반", roster: [{ seatNumber: 1, realName: "김민준" }] }),
  });
  assert.equal(created.status, 201);
  const createdPayload = await created.json();
  const classroom = createdPayload.classroom;

  const joined = await server.fetch("/api/student", {
    method: "POST",
    headers: studentHeaders,
    body: JSON.stringify({ action: "join", entry: classroom.classCode, entryCode: createdPayload.entryCodes[0].entryCode, animal: "🐻" }),
  });
  assert.equal(joined.status, 201);
  const joinedData = await joined.json();
  const student = joinedData.student;
  const DB = server.DB;
  for (let index = 0; index < 13; index += 1) {
    await DB.prepare(`INSERT INTO artworks(id, student_id, classroom_id, title, topic, learning_mode, status, updated_at) VALUES (?, ?, ?, ?, ?, 'guided', ?, ?)`)
      .bind(`history_${String(index).padStart(2, "0")}`, student.id, classroom.id, `작품 ${index}`, "고양이", index === 0 ? "drawing" : "complete", atMinute(index)).run();
  }

  const pageOne = await server.fetch(`/api/teacher?classroomId=${classroom.id}&studentId=${student.id}&historyOffset=0`, {
    headers: teacherHeaders("history-owner@example.com"),
  });
  assert.equal(pageOne.status, 200);
  const first = await pageOne.json();
  assert.equal(first.artworks.length, 12);
  assert.equal(first.artworks[0].id, "history_12");
  assert.equal(first.hasMore, true);
  assert.equal(first.nextOffset, 12);

  const pageTwo = await server.fetch(`/api/teacher?classroomId=${classroom.id}&studentId=${student.id}&historyOffset=${first.nextOffset}`, {
    headers: teacherHeaders("history-owner@example.com"),
  });
  assert.equal(pageTwo.status, 200);
  const second = await pageTwo.json();
  assert.equal(second.artworks.length, 1);
  assert.equal(second.artworks[0].id, "history_00");
  assert.equal(second.hasMore, false);

  const forbidden = await server.fetch(`/api/teacher?classroomId=${classroom.id}&studentId=${student.id}`, {
    headers: teacherHeaders("different-teacher@example.com"),
  });
  assert.equal(forbidden.status, 403);

  for (let index = 13; index < 45; index += 1) {
    await DB.prepare(`INSERT INTO artworks(id, student_id, classroom_id, title, topic, learning_mode, status, updated_at) VALUES (?, ?, ?, ?, ?, 'guided', 'complete', ?)`)
      .bind(`history_${String(index).padStart(2, "0")}`, student.id, classroom.id, `작품 ${index}`, "고양이", atMinute(index)).run();
  }
  const studentAuthHeaders = { ...studentHeaders, authorization: `Bearer ${joinedData.deviceToken}` };
  const archiveOne = await server.fetch("/api/student?artworkOffset=0", { headers: studentAuthHeaders });
  assert.equal(archiveOne.status, 200);
  const archiveFirst = await archiveOne.json();
  assert.equal(archiveFirst.artworks.length, 40);
  assert.equal(archiveFirst.artworkTotal, 45);
  assert.equal(archiveFirst.artworkHasMore, true);
  assert.equal(archiveFirst.artworkNextOffset, 40);
  assert.equal(archiveFirst.latestUnfinishedArtwork.id, "history_00");
  assert.equal(archiveFirst.artworks.some((item) => item.id === "history_00"), false, "the old draft must be outside page one for this regression");
  const archiveTwo = await server.fetch("/api/student?artworkOffset=40", { headers: studentAuthHeaders });
  const archiveSecond = await archiveTwo.json();
  assert.equal(archiveSecond.artworks.length, 5);
  assert.equal(archiveSecond.artworkHasMore, false);
});

test("the UI source keeps completion, archive, palette, help-choice and touch protections visible", async () => {
  const [studio, archive, detail, globalCss, tracker, artworkRoute, artworkImageRoute, teacher, teacherRoute, studentRoute, studentEntry, uploads] = await Promise.all([
    readFile(new URL("../app/components/DrawingStudio.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/Archive.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/ArtworkDetail.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../app/components/InputModeTracker.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/artworks/[id]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/artworks/[id]/image/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/components/TeacherApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/teacher/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/student/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/components/StudentEntry.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/settled-uploads.ts", import.meta.url), "utf8"),
  ]);
  assert.match(studio, /도움받을래/);
  assert.match(studio, /내가 먼저 그릴래/);
  assert.match(studio, /작품을 안전하게 저장 중/);
  assert.match(studio, /갈색/);
  assert.match(studio, /민트/);
  // 2026-09-20: `색 더보기` 단추는 사라지고 무지개 단추가 그 화면을 직접 연다.
  assert.match(studio, /className="dock-more-colors"[^>]*aria-label="색 섞어 고르기"/);
  assert.match(studio, /펜 모드/);
  assert.match(studio, /손가락 모드/);
  assert.match(globalCss, /-webkit-touch-callout:\s*none/);
  assert.match(tracker, /pointerdown/);
  assert.match(archive, /\/student\/archive\//);
  assert.match(archive, /artworkOffset/);
  assert.match(archive, /이전 그림 더 보기/);
  assert.match(detail, /읽기 전용/);
  assert.match(detail, /새 그림으로 다시 그리기/);
  assert.match(detail, /image\?variant=final/);
  assert.match(detail, /\?summary=1/);
  assert.match(artworkRoute, /ARTWORK_COMPLETE/);
  assert.match(artworkRoute, /settleUploadsBeforeCleanup/);
  assert.match(uploads, /Promise\.allSettled/);
  assert.match(artworkImageRoute, /variant === "final"[\s\S]*finalImageKey[\s\S]*thumbnailKey/);
  assert.match(archive, /\/image\$\{full \? "\?variant=final" : ""\}`/);
  // 원본은 펼친 쪽의 한 장에만 쓴다. 목록 전부가 원본을 받으면 교실 회선이 그만큼 더 든다
  // (2026-09-20 보관함 재설계 전에는 원본을 아예 쓰지 않았고, 규칙의 뜻은 "목록은 썸네일"이다).
  assert.match(archive, /load\(artwork, false\)/, "목록은 썸네일");
  assert.match(archive, /images\.load\(selected, true\)/, "펼친 쪽 한 장만 원본");
  assert.match(teacherRoute, /COALESCE\(a\.thumbnail_key, a\.final_image_key\)/);
  assert.doesNotMatch(teacherRoute, /Math\.min\(500/);
  assert.match(teacher, /studentHistoryRequestRef/);
  assert.match(teacher, /const known = new Set\(current\.map/);
  assert.match(teacher, /크게 보기/);
  assert.match(studentRoute, /artworkTotal/);
  assert.match(studentRoute, /currentActivityArtwork/);
  assert.match(studentRoute, /latestUnfinishedArtwork/);
  /* 2026-09-25 사용자 결정(인계 student-art-desk-handoff-20260923): 갈림길은 저장된 그림 **총수** 하나다.
     0장이면 중간 화면 없이 바로 새 도화지, 1장 이상이면 「그림 자리」를 보여 준다.
     종전에는 그리다 만 그림을 **자동으로** 열었다 — 그러면 아이가 새 그림을 시작할 길이 없었다.
     이제 이어 그리기는 목록에서 아이가 직접 고른다. */
  // A teacher-imported PDF also counts as an existing work: keep its home/library reachable.
  assert.match(studentEntry, /if \(!books\.storybooks\?\.length && !DRAWING_LOCKED\) \{ location\.replace\("\/student\/draw\/new\?mode=free"\); return; \}/);
  assert.match(studentEntry, /if \(data\) return <StudentArtDesk /);
  assert.doesNotMatch(studentEntry, /latestUnfinishedArtwork/, "그리던 그림을 자동으로 열면 안 된다");
  assert.match(archive, /setHasMore\(Boolean\(value\.artworkHasMore\)\)/);
  assert.doesNotMatch(studio, /lastTwoFingerTapRef|두 손가락 짧은 탭 두 번/);
  assert.match(studio, /lastSingleFingerTapRef[\s\S]*resetViewToFit/);
  assert.match(globalCss, /max-height:480px[\s\S]*orientation:landscape[\s\S]*guide-choice-card/);
  // 2026-08-17의 "도구 패널은 캔버스 아래 격자" 계약은 2026-09-14 사용자 결정(도구 막대 B안)으로 바뀌었다.
  // 2026-09-14 도구 막대: 좁은 화면은 색 점 대신 지금 색 버튼 하나(누르면 12색 창)를 보인다.
  assert.match(globalCss, /\.dock-current-color \{ display:block; \}/);
  assert.doesNotMatch(globalCss, /mobile-tool-peek/);
  assert.match(globalCss, /\.teacher-history-drawer\s*\{[^}]*position:static/);
  assert.match(teacher, /<TeacherHistoryDrawer[\s\S]*<\/section><\/div>}<\/main>/);
});
