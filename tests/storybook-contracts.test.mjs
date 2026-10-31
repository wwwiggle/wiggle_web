import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("그림책 API는 학생 소유권·요청 출처·저장 충돌을 확인한다", async () => {
  const [collection, book, assets, assetImage] = await Promise.all([
    read("../app/api/storybooks/route.ts"),
    read("../app/api/storybooks/[id]/route.ts"),
    read("../app/api/storybooks/[id]/assets/route.ts"),
    read("../app/api/storybooks/[id]/assets/[assetId]/route.ts"),
  ]);
  for (const source of [collection, book, assets]) {
    assert.match(source, /studentFromRequest|storybookEditorActor/);
    assert.match(source, /sameOrigin/);
    assert.match(source, /rateLimit/);
  }
  assert.match(collection, /student_id = \?/);
  assert.match(collection, /status = 'complete'/);
  assert.match(book, /validateStorybookDocument/);
  assert.match(book, /expectedRevision/);
  assert.match(book, /REVISION_CONFLICT/);
  assert.match(book, /storybook_mutations/);
  assert.match(book, /다른 그림책의 이미지는 사용할 수 없어요/);
  assert.match(book, /backgroundAssetId/);
  assert.match(assets, /PNG 이미지가 아니거나 파일이 너무 커요/);
  assert.match(assets, /ARTWORKS\.put/);
  assert.match(assets, /ARTWORKS\.delete/);
  assert.match(assetImage, /JOIN storybooks/);
  assert.match(assetImage, /b\.student_id = \?/);
  assert.match(assetImage, /private, no-store/);
  assert.match(assetImage, /x-content-type-options/);
});

test("D1 메타데이터와 R2 이미지 바이트가 분리되고 인덱스가 있다", async () => {
  const [schema, runtime] = await Promise.all([read("../db/schema.ts"), read("../db/runtime.ts")]);
  for (const table of ["storybooks", "storybook_assets", "storybook_mutations", "storybook_feedback_requests"]) {
    assert.match(schema, new RegExp(`sqliteTable\\(\"${table}\"`));
    assert.match(runtime, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  assert.match(schema, /objectKey: text\("object_key"\)/);
  assert.match(schema, /documentJson: text\("document_json"\)/);
  assert.match(runtime, /storybook_assets_book_idx/);
  assert.match(runtime, /storybooks_student_idx/);
  assert.match(runtime, /storybook_feedback_book_teacher_uq/);
});

test("교사 완성 그림책 화면은 소유권·완성 상태·개별 및 일괄 피드백 요청을 연결한다", async () => {
  const [collection, book, asset, library, preview, teacherApp] = await Promise.all([
    read("../app/api/teacher/storybooks/route.ts"),
    read("../app/api/teacher/storybooks/[id]/route.ts"),
    read("../app/api/teacher/storybooks/[id]/assets/[assetId]/route.ts"),
    read("../app/components/TeacherStorybookLibrary.tsx"),
    read("../app/components/TeacherStorybookPreview.tsx"),
    read("../app/components/TeacherApp.tsx"),
  ]);
  for (const source of [collection, book, asset]) assert.match(source, /requireTeacher/);
  assert.match(collection, /c\.teacher_id = \?/);
  assert.match(collection, /b\.status = 'complete'/);
  assert.match(collection, /enqueueFeedback/);
  assert.doesNotMatch(collection, /object_key AS/);
  assert.match(asset, /c\.teacher_id = \?/);
  assert.match(asset, /private, no-store/);
  assert.match(library, /피드백 관리 열기/);
  assert.doesNotMatch(library, /선택한 책 피드백 만들기/);
  const generation = await read("../app/components/TeacherFeedbackGeneration.tsx");
  assert.match(generation, /전체 선택/);
  assert.match(generation, /선택한 책 피드백 만들기/);
  assert.match(await read("../app/components/TeacherFeedbackManager.tsx"), /<TeacherFeedbackGeneration/);
  // 2026-10-31: 브라우저 인쇄(A4, 머리글·바닥글·쪽 번호)를 버리고 서버가 만든 정사각형 PDF를 내려받는다.
  assert.doesNotMatch(preview, /window\.print\(\)/);
  assert.doesNotMatch(preview, /teacher-print-pages/);
  assert.match(preview, /downloadEbookPdf/);
  assert.match(preview, /ebook으로 보기/);
  assert.match(teacherApp, /TeacherWorkspace/);
  assert.match(await read("../app/components/TeacherWorkArchive.tsx"), /완성 그림책/);
});

test("학생 화면에 실제 그림책 진입·편집·가져오기·미리보기가 연결된다", async () => {
  const [home, detail, editor, cutout, library, demo, studentApi, css] = await Promise.all([
    read("../app/components/Archive.tsx"),
    read("../app/components/ArtworkDetail.tsx"),
    read("../app/components/StorybookEditor.tsx"),
    read("../app/components/ImageCutoutModal.tsx"),
    read("../app/components/StorybookLibrary.tsx"),
    read("../app/components/dev-only/StorybookDemoBootstrap.tsx"),
    read("../app/api/student/route.ts"),
    read("../app/globals.css"),
  ]);
  assert.match(home, /href="\/student\/books"/); // 학생 홈 은퇴 뒤에는 내 그림 화면이 그림책 입구다
  assert.match(detail, /이 그림으로 그림책 만들기/);
  assert.match(detail, /artworkId: artwork\.id/);
  assert.doesNotMatch(detail, /formatPickerOpen|STORYBOOK_FORMATS\.map/);
  assert.match(detail, /makeStorybook\(\)/);
  assert.match(library, /새 그림책 만들기/);
  assert.doesNotMatch(library, /가로 그림책|세로 그림책/);
  assert.match(library, /activeProfile/);
  assert.match(library, /\/join\?next=/);
  assert.match(library, /URLSearchParams\(location\.search\)\.get\("create"\)/);
  assert.match(studentApi, /action === "localStorybookDemo"/);
  assert.match(studentApi, /isLocalDemoRequest\(request\)/);
  assert.match(demo, /ensureCompletedArtwork/);
  assert.match(demo, /finalImageKey: uploadedData\.key/);
  assert.match(demo, /"content-type": "image\/png"/);
  assert.match(demo, /artworkId: artwork\.id/);
  assert.doesNotMatch(editor, /T 글 넣기/);
  assert.doesNotMatch(editor, /✏️ 이야기 쓰기/);
  // 2026-11-01 기능 최소화: 내 그림(그리기는 유료)·그림 붙여넣기·책 구성 갖추기·쪽 이동·쪽 양식·전체 복제 단추를 뺐다.
  for (const removed of [/🎨 내 그림/, /📋 그림 붙여넣기/, /책 구성 갖추기/, /← 쪽 이동|쪽 이동 →/, /쪽 양식·배경/, /StorybookDuplicateButton/]) assert.doesNotMatch(editor, removed);
  assert.match(editor, /🖼️ 새 그림/);
  assert.match(editor, /🌄 배경 넣기/);
  assert.match(editor, /배경 지우기/);
  assert.match(editor, /🔁 패턴 면지/);
  assert.match(editor, /onDrop=\{\(event\) => \{ event\.preventDefault\(\); setDropActive\(false\); const file = droppedImage\(event\)/, "쪽 위로 그림을 끌어다 놓을 수 있다");
  assert.match(editor, /<header className="storybook-editor-header">.*📖 표지 펼쳐 보기.*<\/header>/, "표지 펼쳐 보기는 맨 위에 있다");
  assert.doesNotMatch(editor, /changeFormat|storybook-format-switcher|storybook-inspector-formats/);
  assert.match(editor, /쪽 복제/);
  assert.match(editor, /↶ 되돌리기/);
  assert.match(editor, /↷ 다시하기/);
  assert.match(editor, /맨 앞으로/);
  assert.match(editor, /잠그기/);
  assert.match(editor, /미리보기/);
  assert.match(editor, /그림 크기/);
  assert.match(editor, /빈 여백 없이 맞추기/);
  assert.match(editor, /visibleContentBounds/);
  assert.match(editor, /imageCropStyle/);
  assert.match(editor, /STORYBOOK_IMAGE_AREA/);
  assert.match(editor, /STORYBOOK_TEXT_BOX/);
  assert.match(editor, /배경 지우기/);
  assert.match(editor, /body: blob/);
  assert.match(editor, /"content-type": "image\/png"/);
  assert.match(cutout, /배경 자동 지우기/);
  assert.match(cutout, /removeConnectedColor/);
  assert.match(cutout, /opaqueBounds/);
  assert.match(editor, /from "react-moveable"/);
  assert.match(editor, /<Moveable/);
  assert.match(editor, /draggable/);
  assert.match(editor, /resizable/);
  assert.match(editor, /keepRatio/);
  assert.match(editor, /rotatable/);
  assert.match(editor, /snappable/);
  assert.match(editor, /useResizeObserver/);
  assert.match(editor, /useMutationObserver/);
  assert.match(editor, /controlPadding=\{8\}/);
  assert.match(editor, /canvas\.toDataURL\("image\/png"\)/);
  assert.match(css, /\.storybook-stage-element\.selected/);
  assert.match(css, /\.storybook-page-background/);
  assert.match(css, /height:100%!important/);
  assert.match(css, /@media \(max-height:480px\) and \(orientation:landscape\)/);
});
