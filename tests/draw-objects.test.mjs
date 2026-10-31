import assert from "node:assert/strict";
import test from "node:test";
import { drawObjectBounds, drawObjectKey, movableDrawObjects, shiftDrawPoints, validateDrawDocument, visibleDrawOperations } from "../lib/drawing-model.ts";
import { mirrorOp } from "../lib/symmetry.ts";

const at = "2026-10-11T01:00:00.000Z";
const ids = (name) => ({ opId: `op_${name}`.padEnd(12, "0"), clientOpId: `client_${name}`.padEnd(14, "0"), at });
const shape = (name, x = 0.2, extra = {}) => ({ ...ids(name), type: "shape", shape: "circle", color: "#E53935", width: 8, points: [{ x, y: 0.2 }, { x: x + 0.2, y: 0.4 }], ...extra });
const sticker = (name, extra = {}) => ({ ...ids(name), type: "sticker", sticker: "heart", points: [{ x: 0.5, y: 0.5 }], ...extra });
const fill = (name) => ({ ...ids(name), type: "fill", color: "#1E88E5", points: [{ x: 0.3, y: 0.3 }] });
const stroke = (name) => ({ ...ids(name), type: "stroke", tool: "pencil", color: "#1B3A57", width: 8, points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }] });
const documentWith = (ops) => ({ schemaVersion: 1, rendererVersion: 1, size: 1024, ops });
// 옮긴 동작은 처음 동작의 opId를 objectId로 들고 전체 상태를 새로 덧붙인다.
const moved = (original, name, dx, extra = {}) => ({ ...original, ...ids(name), objectId: original.objectId ?? original.opId, points: shiftDrawPoints(original.points, dx, 0), ...extra });

test("moving a shape or sticker shows only its latest state, and undo brings the old place back", () => {
  const circle = shape("circle");
  const heart = sticker("heart");
  const circleMoved = moved(circle, "circlemove", 0.3);
  const ops = [circle, stroke("line"), heart, circleMoved];
  const visible = visibleDrawOperations(ops);
  assert.deepEqual(visible.map((op) => op.opId), [ops[1].opId, heart.opId, circleMoved.opId]);
  assert.equal(visible.at(-1).points[0].x, 0.5);
  // 되돌리기는 마지막 동작을 떼어 낼 뿐이다 — 그러면 예전 자리가 다시 보인다.
  assert.deepEqual(visibleDrawOperations(ops.slice(0, -1)).map((op) => op.opId), [circle.opId, ops[1].opId, heart.opId]);
  // 타임랩스는 limit까지만 본다.
  assert.equal(visibleDrawOperations(ops, 1)[0].opId, circle.opId);
  // 지운 동작은 물건을 숨긴다.
  assert.equal(visibleDrawOperations([...ops, moved(heart, "heartgone", 0, { deleted: true })]).some((op) => op.type === "sticker"), false);
});

test("objects drawn before a fill stay put, because the fill is recomputed from the lines around it", () => {
  const circle = shape("circle");
  const later = shape("later", 0.6);
  // 동그라미를 그리고 안을 채웠다. 동그라미를 옮기면 채우기가 도화지 전체로 번진다.
  assert.deepEqual(movableDrawObjects([circle, fill("fill"), later, sticker("heart")]).map((op) => op.opId), [later.opId, sticker("heart").opId]);
  // 채우기를 되돌리면 다시 옮길 수 있다.
  assert.equal(movableDrawObjects([circle]).length, 1);
  // 채우기 전에 그린 것을 채우기 전에 옮겼어도, 처음 그린 때가 기준이라 잠긴다.
  assert.equal(movableDrawObjects([circle, moved(circle, "early", 0.1), fill("fill")]).length, 0);
});

test("a mirrored pair is two separate objects, and old shapes without an objectId can still be picked", () => {
  const original = shape("pair");
  const mirror = mirrorOp(original);
  assert.notEqual(drawObjectKey(original), drawObjectKey(mirror));
  assert.equal(visibleDrawOperations([original, mirror, moved(original, "pairmove", 0.1)]).length, 2);
  assert.equal(drawObjectKey(moved(original, "again", 0.1)), drawObjectKey(original));
});

test("a moved object never leaves the paper", () => {
  assert.deepEqual(shiftDrawPoints([{ x: 0.2, y: 0.2 }, { x: 0.4, y: 0.4 }], 5, -5), [{ x: 0.8, y: 0 }, { x: 1, y: 0.2 }]);
  const box = drawObjectBounds(sticker("box", { fontSize: 102.4 }), 1024);
  assert.ok(Math.abs(box.width - 0.1) < 1e-9 && Math.abs(box.x - 0.45) < 1e-9);
});

test("the server keeps move and delete records for shapes and stickers, and rejects malformed ones", () => {
  const circle = shape("circle");
  const saved = validateDrawDocument(documentWith([circle, moved(circle, "move", 0.1), moved(sticker("heart"), "gone", 0, { deleted: true })]));
  assert.equal(saved?.ops[1].objectId, circle.opId);
  assert.equal(saved?.ops[2].deleted, true);
  assert.equal(validateDrawDocument(documentWith([shape("bad", 0.2, { objectId: "x" })])), null);
  assert.equal(validateDrawDocument(documentWith([shape("bad", 0.2, { objectId: { blob: "z".repeat(5000) } })])), null);
  assert.equal(validateDrawDocument(documentWith([sticker("bad", { deleted: "yes" })])), null);
  // 획에 실린 objectId는 남지 않는다.
  assert.equal(validateDrawDocument(documentWith([{ ...stroke("line"), objectId: circle.opId }]))?.ops[0].objectId, undefined);
});

test("resizing keeps the centre, the paper edge, and a size a finger can still hit", async () => {
  const { scaleDrawObject, STICKER_SCREEN_MAX, STICKER_SCREEN_MIN, toDocumentUnits } = await import("../lib/drawing-model.ts");
  // 도형: 가운데는 그대로, 두 점이 배율만큼 벌어진다.
  assert.deepEqual(scaleDrawObject(shape("circle", 0.4), 1.5, 3).points, [{ x: 0.35, y: 0.15 }, { x: 0.65, y: 0.45 }]);
  // 도화지 가장자리에 닿으면 거기서 멈춘다(위쪽 0.2가 먼저 닿는다 — 가운데 y 0.3, 반높이 0.1 → 최대 3배).
  const huge = scaleDrawObject(shape("circle", 0.4), 50, 3).points;
  assert.ok(huge.every((point) => point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1));
  assert.equal(huge[0].y, 0);
  // 아주 작게 줄여도 다시 누를 수 있는 크기는 남는다.
  const tiny = scaleDrawObject(shape("circle", 0.4), 0.0001, 3).points;
  assert.ok(Math.hypot(tiny[0].x - tiny[1].x, tiny[0].y - tiny[1].y) >= 0.029);
  // 스티커: 화면 기준 범위 안에서만 바뀌고, 그 값은 서버 검증을 통과한다.
  for (const span of [1, 2, 3]) {
    const start = sticker("heart", { fontSize: toDocumentUnits(140, span) });
    // 저장 값은 소수 둘째 자리로 반올림돼 있어 두 배가 0.01만큼 어긋날 수 있다.
    assert.ok(Math.abs(scaleDrawObject(start, 2, span).fontSize - toDocumentUnits(280, span)) <= 0.011);
    for (const factor of [0.001, 1000]) {
      const size = scaleDrawObject(start, factor, span).fontSize;
      assert.equal(size, toDocumentUnits(factor < 1 ? STICKER_SCREEN_MIN : STICKER_SCREEN_MAX, span));
      assert.ok(validateDrawDocument({ ...documentWith([{ ...start, fontSize: size }]), span }), `span ${span} size ${size}`);
    }
  }
  assert.deepEqual(scaleDrawObject(shape("circle"), Number.NaN, 1), {});
});
