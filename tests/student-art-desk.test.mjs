import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

/* 참여 코드 뒤 「그림 자리」 (2026-09-25 사용자 결정 — 코덱스 인계
 * docs/design-assets/student-art-desk-handoff-20260923/README-CLAUDE.md).
 *
 * 이 시험이 지키는 핵심은 셋이다.
 *   1. 갈림길은 저장된 그림 **총수** 하나다. 0장이면 중간 화면 없이 바로 도화지.
 *   2. 그리던 그림을 **자동으로 열지 않는다** — 아이가 목록에서 직접 고른다.
 *   3. 시안을 배경 한 장으로 깔지 않는다. 그림·책·글자는 실제 데이터와 DOM이다. */

test("그림·그림책이 모두 없으면 도화지로 가고 PDF만 있는 아이도 책을 찾을 수 있다", async () => {
  const entry = await read("../app/components/StudentEntry.tsx");
  // 페이지 크기(artworks 40장)가 아니라 총수로 본다 — 41장째부터 0장으로 읽히면 안 된다.
  assert.match(entry, /if \(!Number\(payload\.artworkTotal\)\)/);
  assert.match(entry, /studentFetch\("\/api\/storybooks"\)/);
  // 2026-10-31: 그림 그리기가 유료 요금제로 잠기면 빈 도화지로 보내지 않고 그림 자리(그림책 만들기)를 보여 준다.
  assert.match(entry, /if \(!books\.storybooks\?\.length && !DRAWING_LOCKED\) \{ location\.replace\("\/student\/draw\/new\?mode=free"\); return; \}/);
  assert.match(entry, /if \(data\) return <StudentArtDesk /);
});

test("그리던 그림을 자동으로 열지 않는다", async () => {
  const entry = await read("../app/components/StudentEntry.tsx");
  /* 종전에는 latestUnfinishedArtwork가 있으면 그것을 곧바로 열었다. 그러면 그리다 만 그림이
     있는 아이는 새 그림을 시작할 길이 아예 없었다(2026-09-25 사용자 지적). */
  assert.doesNotMatch(entry, /latestUnfinishedArtwork/);
  const desk = await read("../app/components/StudentArtDesk.tsx");
  // 이어 그리기는 목록 카드의 행동이다.
  assert.match(desk, /\{drawing \? "이어 그리기" : "그림 보기"\}/);
  assert.match(desk, /href: drawing \? `\/student\/draw\/\$\{encodeURIComponent\(artwork\.id\)\}` : `\/student\/archive\/\$\{encodeURIComponent\(artwork\.id\)\}`/);
  // 잠긴 동안(유료 요금제) 그리다 만 그림 카드는 링크가 아니라 누를 수 없는 span이다.
  assert.match(desk, /const locked = DRAWING_LOCKED;\r?\n  const Card = locked \? "span" : "a";/);
});

test("시안을 배경으로 깔지 않고 장식만 따로 놓는다", async () => {
  const [desk, css] = await Promise.all([read("../app/components/StudentArtDesk.tsx"), read("../app/components/StudentArtDesk.css")]);
  /* 시안 원본(selected-art-desk.png)은 참고용으로 docs에만 둔다. public에 넣어 배경으로 깔거나
     <img>로 불러오면 안 된다 — 주석에서 출처로 언급하는 것은 괜찮다. */
  assert.doesNotMatch(css, /url\([^)]*selected-art-desk/);
  assert.doesNotMatch(desk, /src=\{?["'`][^"'`]*selected-art-desk/);
  // 바탕에 까는 것은 글자 없는 책상 질감 한 장뿐이다.
  assert.match(css, /background: var\(--desk-cream\) url\("\/student-desk\/desk-surface\.webp"\)/);
  // 장식은 초점·클릭을 받지 않고 본문 뒤에 있다.
  assert.match(desk, /<div className="desk-decor" aria-hidden="true">/);
  assert.match(css, /\.student-art-desk > \.desk-decor \{ position: absolute;[^}]*pointer-events: none;/);
  // 좁은 화면에서는 장식을 숨긴다 — 정보가 들어 있지 않다.
  assert.match(css, /@media \(max-width: 899px\) \{ \.desk-decor \{ display: none; \} \}/);
});

test("카드 안에 링크를 중첩하지 않고, 상태를 글자로 적는다", async () => {
  const desk = await read("../app/components/StudentArtDesk.tsx");
  /* 카드 전체가 <a>다. 안쪽 행동 표시는 <span>이라 초점이 두 번 잡히지 않는다.
     파일 전체를 정규식으로 훑으면 서로 다른 카드의 <a>끼리 걸리므로, 카드 함수 본문만 잘라서 본다.
     실제 중첩 여부는 브라우저에서도 쟀다(320/390/844/1440 모두 중첩 0건). */
  for (const name of ["function ArtworkCard", "function BookCard"]) {
    const start = desk.indexOf(name);
    const body = desk.slice(start, desk.indexOf("\n}", start));
    const opens = [...body.matchAll(/<(a|button|Card)\b/g)]; // Card = 잠김에 따라 <a> 또는 <span>
    assert.equal(opens.length, 1, `${name} 안에 링크·단추가 둘 이상이다: ${opens.map((m) => m[1])}`);
  }
  assert.match(desk, /<span className="desk-art-go">/);
  // 색만으로 구분하지 않는다.
  assert.match(desk, /\{drawing \? "그리는 중" : "완성"\}/);
});

test("많은 그림·책은 기존 전체 목록으로 보낸다", async () => {
  const desk = await read("../app/components/StudentArtDesk.tsx");
  // 이 화면이 전부 받지 않는다 — 보관함과 그림책 목록을 지우지 않고 그대로 쓴다.
  assert.match(desk, /export const DESK_ARTWORK_LIMIT = 3;/);
  assert.match(desk, /href="\/student\/archive"/);
  assert.match(desk, /href="\/student\/books"/);
});

test("그림책을 못 받아도 그림 목록은 살아 있다", async () => {
  const desk = await read("../app/components/StudentArtDesk.tsx");
  // 책은 따로 받는다. 실패하면 그 구역만 안내를 보여 준다.
  assert.match(desk, /studentFetch\("\/api\/storybooks"\)/);
  assert.match(desk, /setBooks\(\[\]\); setBookError\(/);
  assert.match(desk, /아직 만든 그림책이 없어요\./);
});

test("장식 에셋이 자산 목록에 등록되어 있다", async () => {
  const manifest = JSON.parse(await read("../public/brand/asset-manifest.json"));
  const paths = new Set(manifest.assets.map((asset) => asset.path));
  for (const file of ["/student-desk/desk-surface.webp", "/student-desk/plant-left.webp", "/student-desk/icon-new-drawing.svg", "/student-desk/book-cover-frame-green.svg"]) {
    assert.ok(paths.has(file), `${file}이 asset-manifest.json에 없다`);
  }
});

test("아이의 집은 「그림 자리」다 — 모든 화면이 거기로 돌아온다", async () => {
  /* 2026-09-26 사용자 지적: 「내 그림」을 누르면 아직 옛 보관함이 떴다. 그림 자리가 생긴 뒤로
     아이의 집은 거기다(내 그림·새 그림·내 그림책이 함께 있다). 보관함은 지우지 않고
     「내 그림 모두 보기」로 한 번에 가는 자리로 남긴다(인계 지시: 기존 보관함을 잃지 않는다). */
  const [studio, detail, books, archive, desk] = await Promise.all([
    read("../app/components/DrawingStudio.tsx"),
    read("../app/components/ArtworkDetail.tsx"),
    read("../app/components/StorybookLibrary.tsx"),
    read("../app/components/Archive.tsx"),
    read("../app/components/StudentArtDesk.tsx"),
  ]);
  assert.match(studio, /className="icon-button studio-back" href="\/student" aria-label="내 그림 자리로 나가기"/);
  assert.match(detail, /<a className="small-button" href="\/student">← 내 그림 자리<\/a>/);
  assert.match(books, /<a className="small-button" href="\/student">← 내 그림 자리<\/a>/);
  // 보관함은 들어가는 길만 있고 나오는 길이 없어 막다른 곳이었다.
  assert.match(archive, /<a className="small-button" href="\/student">.{0,60}내 그림 자리<\/a>/s);
  // 보관함 자체는 그대로 살아 있다 — 그림 자리에서 한 번에 간다.
  assert.match(desk, /href="\/student\/archive"/);
  assert.match(detail, /href="\/student\/archive">다른 그림 보기/);
});
