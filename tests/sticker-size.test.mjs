import assert from "node:assert/strict";
import test from "node:test";
import { contentBounds, STICKER_SIZE, toDocumentUnits, validateDrawDocument } from "../lib/drawing-model.ts";

const sticker = (extra = {}) => ({ opId: "op_sticker0001", clientOpId: "client_sticker0001", type: "sticker", at: "2026-10-11T01:00:00.000Z", sticker: "star", points: [{ x: 0.5, y: 0.5 }], ...extra });
const documentWith = (op, span) => ({ schemaVersion: 1, rendererVersion: 1, size: 1024, ...(span ? { span } : {}), ops: [op] });

test("stickers keep the same on-screen size on wide paper and stay loadable without a size", () => {
  // 넓은 도화지(span 3)는 화면 세 장 너비라, 크기를 나누지 않으면 스티커가 화면에서 세 배로 커진다.
  for (const span of [1, 2, 3]) {
    const size = toDocumentUnits(STICKER_SIZE, span);
    const validated = validateDrawDocument(documentWith(sticker({ fontSize: size }), span));
    assert.equal(validated?.ops[0].fontSize, size, `span ${span}`);
  }
  // 크기 없는 옛 문서는 그대로 열린다(렌더러가 140으로 그린다).
  assert.equal(validateDrawDocument(documentWith(sticker()))?.ops[0].fontSize, undefined);
  // 허용 범위 밖 크기와 숫자가 아닌 값은 저장을 거부한다.
  for (const bad of [0, 10, 361, 5000, "140", null]) assert.equal(validateDrawDocument(documentWith(sticker({ fontSize: bad }))), null, String(bad));
  // 스티커의 다른 종류 필드는 남지 않는다.
  assert.equal(validateDrawDocument(documentWith(sticker({ color: "#FF0000", text: "x" })))?.ops[0].color, undefined);
});

test("the crop box around a sticker follows its stored size", () => {
  const small = contentBounds(documentWith(sticker({ fontSize: toDocumentUnits(STICKER_SIZE, 3) }), 3));
  const large = contentBounds(documentWith(sticker()));
  assert.ok(small && large && small.width < large.width);
});
