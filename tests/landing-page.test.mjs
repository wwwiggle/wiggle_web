import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("landing hero puts the code form in a titled card with exactly four accessible boxes", async () => {
  const [page, form] = await Promise.all([
    read("../app/page.tsx"),
    read("../app/components/LandingCodeForm.tsx"),
  ]);
  assert.match(page, /<div className="landing-code-card">/);
  assert.match(page, /<h2 className="landing-code-card-title">수업 코드 입력<\/h2>/);
  assert.match(page, /<LandingCodeForm \/>/);

  assert.match(form, /const CODE_LENGTH = 4;/);
  assert.match(form, /role="group" aria-label="4자리 수업 코드"/);
  assert.match(form, /aria-label=\{`수업 코드 \$\{index \+ 1\}번째 숫자`\}/);
  // exactly four boxes are rendered by mapping the four-length digits array, not a hardcoded list
  assert.match(form, /Array\(CODE_LENGTH\)\.fill\(""\)/);
  assert.match(form, /digits\.map\(\(digit, index\) =>/);
});

test("landing code submit reads all four visible boxes before navigating to /join?code=", async () => {
  const form = await read("../app/components/LandingCodeForm.tsx");
  assert.match(form, /const submittedDigits = inputRefs\.current\.map/);
  assert.match(form, /const firstEmptyIndex = submittedDigits\.findIndex/);
  assert.match(form, /inputRefs\.current\[firstEmptyIndex\]\?\.focus\(\)/);
  assert.match(form, /pattern="\[0-9\]"/);
  assert.match(form, /required/);
  assert.doesNotMatch(form, /disabled=\{!complete\}/);
  assert.match(form, /window\.location\.href = `\/join\?code=\$\{submittedDigits\.join\(""\)\}`;/);
});

test("landing reconciles browser-restored code boxes with React state", async () => {
  const form = await read("../app/components/LandingCodeForm.tsx");
  assert.match(form, /function syncRestoredDigits\(\)/);
  assert.match(form, /inputRefs\.current\.map\(\(input\) => input\?\.value/);
  assert.match(form, /window\.addEventListener\("pageshow", syncRestoredDigits\)/);
  assert.match(form, /\[0, 100, 500\]\.map/);
});

test("teacher link uses the exact copy with a hidden person icon", async () => {
  const page = await read("../app/page.tsx");
  assert.match(page, /<a className="button secondary teacher-link" href="\/teacher">/);
  assert.match(page, /<svg aria-hidden="true"[^>]*>/);
  assert.match(page, />\s*교사 수업 열기\s*<\/a>/);
  assert.doesNotMatch(page, />교사 입장</);
});

test("landing headline separates the navy lead phrase from the blue question", async () => {
  const page = await read("../app/page.tsx");
  assert.match(page, /<h1 className="landing-headline"><span>오늘은<\/span> <strong>어떤 생각을 그려볼까요\?<\/strong><\/h1>/);
});

test("/join accepts exactly four digits and rejects everything else", async () => {
  const joinPage = await read("../app/join/page.tsx");
  const patternSource = joinPage.match(/\/\^\\d\{4\}\$\/\.test\(rawCode\)/);
  assert.ok(patternSource, "expected the /^\\d{4}$/ four-digit contract in app/join/page.tsx");

  const fourDigitCode = /^\d{4}$/;
  for (const value of ["0000", "9999", "1234"]) {
    assert.ok(fourDigitCode.test(value), `expected ${value} to be accepted`);
  }
  for (const value of ["", "123", "12345", "12a4", " 1234", "1234 "]) {
    assert.ok(!fourDigitCode.test(value), `expected ${value} to be rejected`);
  }
});

test("/join never renders a visible classroom-code field; the class code is only supplied via the landing page or QR", async () => {
  const [joinPage, joinClient] = await Promise.all([
    read("../app/join/page.tsx"),
    read("../app/components/JoinClient.tsx"),
  ]);
  assert.doesNotMatch(joinPage, /isQrEntry/);
  assert.doesNotMatch(joinClient, /isQrEntry/);
  assert.match(joinPage, /<JoinClient initialEntry=\{sanitizedCode\} \/>/);
  assert.doesNotMatch(joinClient, /수업 코드<\/span>/);
  assert.doesNotMatch(joinClient, /placeholder="수업 코드"/);
});

test("/join never redirects server-side; it always hands the sanitized code to JoinClient, which decides what to show client-side", async () => {
  const joinPage = await read("../app/join/page.tsx");
  assert.doesNotMatch(joinPage, /redirect\(/);
  assert.doesNotMatch(joinPage, /next\/navigation/);
});

test("landing subtitle has an explicit width so it wraps instead of overflowing as a centered item", async () => {
  const css = await read("../app/globals.css");
  // 대문 카피는 가운데 정렬 컨테이너 안에 있다. max-width만 주면 렌더러에 따라 보이는 상자 밖으로
  // 늘어나 잘릴 수 있다. 명시적 width가 있어야 어떤 폭에서도 줄바꿈으로 처리된다.
  assert.match(css, /\.gallery-landing \.landing-subtitle \{[^}]*width:min\(100%,460px\);[^}]*margin-inline:auto;/);
});

test("desktop (min-width:900px) landing typography reads as a strong headline with an emphasized student card", async () => {
  const css = await read("../app/globals.css");
  const desktop = css.match(/@media \(min-width:900px\) \{\s*\.gallery-hero([\s\S]*?)\n\}/)?.[1] ?? "";
  assert.ok(desktop, "expected a @media (min-width:900px) gallery landing block");

  const headlineSize = desktop.match(/\.gallery-landing \.landing-headline \{ font-size:min\([^,]+,(\d+)px\);/);
  assert.ok(headlineSize, "expected a capped desktop headline font-size");
  assert.ok(Number(headlineSize[1]) >= 48, `expected desktop headline max size >= 48px, got ${headlineSize[1]}px`);

  const tagLabelSize = desktop.match(/\.gallery-student-tag b \{ font-size:(\d+)px; \}/);
  assert.ok(tagLabelSize, "expected an explicit desktop .gallery-student-tag b font-size");
  assert.ok(Number(tagLabelSize[1]) >= 20, `expected 학생 label size >= 20px, got ${tagLabelSize[1]}px`);
});

test("wide picture-book screens keep short landing copy on one line", async () => {
  const css = await read("../app/globals.css");
  const wide = css.match(/@media \(min-width:901px\) \{\s*\.landing-headline,\.landing-subtitle \{([\s\S]*?)\}/)?.[1] ?? "";
  assert.match(wide, /width:auto;/);
  assert.match(wide, /max-width:none;/);
  assert.match(wide, /white-space:nowrap;/);
  assert.match(wide, /text-wrap:nowrap;/);
});

test("the gallery landing composes individual assets instead of one baked scene picture", async () => {
  const page = await read("../app/page.tsx");
  // 2026-09-06 사용자 선택으로 단일 landing-scene 그림 고정 결정은 은퇴했다.
  assert.doesNotMatch(page, /landing-scene/);
  assert.match(page, /className="landing gallery-landing"/);
  assert.match(page, /src="\/landing-gallery\/duck-painter-1200\.webp"/);
  assert.match(page, /src="\/landing-gallery\/frame-blue-960\.webp"/);
  for (const id of ["rocket", "whale", "house"]) {
    assert.ok(page.includes(`{ id: "${id}"`), `expected the ${id} exhibit`);
  }
  // 액자·걸이줄·잎은 장식이므로 보조기기에서 읽히지 않아야 한다.
  assert.match(page, /className="gallery-frame__rim"[\s\S]*?alt=""[\s\S]*?aria-hidden="true"/);
  assert.match(page, /className="gallery-wire" aria-hidden="true"/);
  assert.match(page, /className="gallery-leaves gallery-decoration"[\s\S]*?aria-hidden="true"/);
  // 도형→작품 표식은 예시 장식이지 실제 레슨 씨앗이 아니다 — 보조기기에서 읽히지 않는다.
  assert.match(page, /className="gallery-shape-chip" aria-hidden="true"/);
});

test("the landing keeps the three product promises under the gallery", async () => {
  const page = await read("../app/page.tsx");
  for (const [title, body] of [
    ["모두 다른 답", "같은 시작에서도 생각은 달라져요"],
    ["AI는 대신 그리지 않아요", "필요할 때만 질문으로 도와요"],
    ["비교보다 발견", "선생님과 서로의 과정을 살펴봐요"],
  ]) {
    assert.ok(page.includes(`title: "${title}", body: "${body}"`), `expected the ${title} promise`);
  }
  // 점수·순위·재능 진단은 만들지 않는다는 확정 결정을 대문 문구에서도 지킨다.
  assert.doesNotMatch(page, /순위|점수|등수|재능 진단/);
});

test("wide screens put the frames behind and the duck in front, with the code card clear of the wall", async () => {
  const css = await read("../app/globals.css");
  const start = css.indexOf("@media (min-width:760px) {");
  assert.ok(start >= 0, "expected the gallery composition block");
  const stage = css.slice(start, css.indexOf("@media (min-width:900px) {", start));

  // 액자 벽은 첫 행 전체, 입장 카드는 둘째 행 오른쪽 — 카드가 액자를 덮지 않는다.
  assert.match(stage, /\.gallery-wall \{[\s\S]*?grid-column:1\/-1;[\s\S]*?grid-row:1;/);
  assert.match(stage, /\.gallery-entry \{ grid-column:2; grid-row:2;[\s\S]*?z-index:3;/);
  // 오리는 무대 바닥에 붙여 액자 앞에 세운다.
  assert.match(stage, /\.gallery-duck \{[\s\S]*?position:absolute;[\s\S]*?z-index:2;[\s\S]*?bottom:0;/);
});

test("the gallery landing never scales controls with container units, so touch targets stay 44px", async () => {
  const css = await read("../app/globals.css");
  // 주석에는 은퇴 사유로 cqw가 적혀 있다 — 규칙만 본다.
  // 대문 블록만 본다. 파일 끝까지 자르면 뒤에 붙은 그리기 화면 규칙(도화지 크기 계산에
  // 컨테이너 단위를 쓴다)까지 걸려 이 계약이 잘못 깨진다.
  const galleryStart = css.indexOf("/* ── 2026-09-07 오리 전시관 대문");
  const galleryEnd = css.indexOf("/* ── 2026-09-07 그리기 화면 플로팅 도구", galleryStart);
  assert.ok(galleryStart >= 0 && galleryEnd > galleryStart, "expected the gallery landing block boundaries");
  const gallery = css.slice(galleryStart, galleryEnd).replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(gallery.trim(), "expected the gallery landing block");
  // 은퇴한 1488 무대는 cqw로 입력칸까지 줄여 세로 태블릿에서 44px이 깨졌다. 다시 도입하지 않는다.
  assert.doesNotMatch(gallery, /cqw/);
  assert.doesNotMatch(gallery, /container-type/);
  const box = gallery.match(/\.gallery-landing \.landing-code-box \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(box, /width:52px;/);
  assert.match(box, /height:56px;/);
  assert.match(box, /min-height:44px;/);
});

test("the frame inner box matches the verified geometry in the asset package", async () => {
  const [css, assetCss] = await Promise.all([
    read("../app/globals.css"),
    read("../public/landing-gallery/gallery-assets.css"),
  ]);
  // globals.css는 에셋 패키지에서 검수된 액자 안쪽 좌표를 옮겨 쓴다. 둘이 어긋나면 그림이 액자를 벗어난다.
  // 두 파일의 공백 표기가 달라 선언 값만 비교한다.
  const artRule = (source) => {
    const body = source.match(/\.gallery-frame__art\s*\{([^}]*)\}/)?.[1];
    assert.ok(body, "expected a .gallery-frame__art rule");
    return body.replace(/\s+/g, "");
  };
  assert.equal(artRule(css), artRule(assetCss));
  assert.match(artRule(css), /left:14\.1%;top:18%;width:71\.7%;height:62%;/);
});
