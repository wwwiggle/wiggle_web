import { drawingTextGraphemes, drawnStrokeWidth, STICKER_SIZE, visibleDrawOperations, type DrawOp } from "@/lib/drawing-model";
import { computeFloodFillMask, paintFloodFillMask, sampleRgb } from "@/lib/flood-fill";

/* 도화지 크기. 숫자를 주면 예전처럼 정사각이고, 가로 도화지는 {width,height}를 준다.
 * 좌표는 x·y 모두 0~1로 정규화돼 있어 x는 가로, y는 세로에 각각 곱한다.
 * 굵기·글자처럼 "문서 단위"로 저장된 값은 가로(1024)를 기준으로 환산한다. */
export type RenderSize = number | { width: number; height: number };

function dimensions(size: RenderSize) {
  return typeof size === "number" ? { w: size, h: size } : { w: size.width, h: size.height };
}

export const STICKER_EMOJI: Record<NonNullable<DrawOp["sticker"]>, string> = {
  star: "⭐", heart: "❤️", leaf: "🍃", cloud: "☁️", sparkle: "✨",
};

function rgb(hex = "#1B3A57") {
  return [Number.parseInt(hex.slice(1, 3), 16), Number.parseInt(hex.slice(3, 5), 16), Number.parseInt(hex.slice(5, 7), 16)] as const;
}

function floodFill(context: CanvasRenderingContext2D, op: DrawOp, size: number, docH: number) {
  const seed = op.points?.[0]; if (!seed || !op.color) return;
  const image = context.getImageData(0, 0, size, docH); const pixels = image.data;
  const sx = Math.max(0, Math.min(size - 1, Math.round(seed.x * (size - 1))));
  const sy = Math.max(0, Math.min(docH - 1, Math.round(seed.y * (docH - 1))));
  const target = sampleRgb(pixels, size, sx, sy);
  const fill = rgb(op.color); if (fill.every((channel, index) => channel === target[index])) return;
  const mask = computeFloodFillMask(pixels, size, sx, sy, target, { height: docH });
  paintFloodFillMask(pixels, mask, fill);
  context.putImageData(image, 0, 0);
}

function drawShape(context: CanvasRenderingContext2D, op: DrawOp, size: number, docH: number) {
  const start = op.points?.[0]; const end = op.points?.[1]; if (!start || !end || !op.shape) return;
  const left = Math.min(start.x, end.x) * size; const top = Math.min(start.y, end.y) * docH;
  const width = Math.abs(end.x - start.x) * size; const height = Math.abs(end.y - start.y) * docH;
  const centerX = left + width / 2; const centerY = top + height / 2;
  context.save(); context.strokeStyle = op.color ?? "#1B3A57"; context.fillStyle = op.color ?? "#1B3A57"; context.lineWidth = (op.width ?? 8) * size / 1024; context.lineCap = "round"; context.lineJoin = "round"; context.beginPath();
  if (op.shape === "line") { context.moveTo(start.x * size, start.y * docH); context.lineTo(end.x * size, end.y * docH); }
  if (op.shape === "rectangle") context.rect(left, top, width, height);
  if (op.shape === "rounded-rectangle") context.roundRect(left, top, width, height, Math.min(width, height) * .2);
  if (op.shape === "circle") context.ellipse(centerX, centerY, width / 2, height / 2, 0, 0, Math.PI * 2);
  if (op.shape === "triangle") { context.moveTo(left + width / 2, top); context.lineTo(left, top + height); context.lineTo(left + width, top + height); context.closePath(); }
  if (op.shape === "star") {
    const outer = Math.min(width, height) / 2; const inner = outer * .46;
    for (let point = 0; point < 10; point += 1) {
      const radius = point % 2 === 0 ? outer : inner; const angle = -Math.PI / 2 + point * Math.PI / 5;
      const x = centerX + Math.cos(angle) * radius; const y = centerY + Math.sin(angle) * radius;
      if (point === 0) context.moveTo(x, y); else context.lineTo(x, y);
    }
    context.closePath();
  }
  if (op.shape === "heart") {
    context.moveTo(centerX, top + height);
    context.bezierCurveTo(left - width * .08, top + height * .58, left + width * .03, top + height * .12, centerX, top + height * .36);
    context.bezierCurveTo(left + width * .97, top + height * .12, left + width * 1.08, top + height * .58, centerX, top + height);
    context.closePath();
  }
  if (op.shape === "arrow") {
    const direction = end.x >= start.x ? 1 : -1; const baseX = direction > 0 ? left : left + width; const tipX = direction > 0 ? left + width : left;
    const neckX = baseX + direction * width * .58; const topStem = centerY - height * .16; const bottomStem = centerY + height * .16;
    context.moveTo(baseX, topStem); context.lineTo(neckX, topStem); context.lineTo(neckX, top); context.lineTo(tipX, centerY); context.lineTo(neckX, top + height); context.lineTo(neckX, bottomStem); context.lineTo(baseX, bottomStem); context.closePath();
  }
  if (op.shape === "curve") {
    context.moveTo(start.x * size, start.y * docH);
    context.bezierCurveTo(start.x * size + (end.x - start.x) * size * .28, start.y * docH - (end.y - start.y) * docH * .55, start.x * size + (end.x - start.x) * size * .72, end.y * docH + (end.y - start.y) * docH * .55, end.x * size, end.y * docH);
  }
  if (op.shape === "cloud") {
    context.moveTo(left + width * .18, top + height * .78);
    context.bezierCurveTo(left - width * .02, top + height * .75, left - width * .02, top + height * .42, left + width * .22, top + height * .42);
    context.bezierCurveTo(left + width * .24, top + height * .14, left + width * .55, top + height * .04, left + width * .68, top + height * .29);
    context.bezierCurveTo(left + width * .98, top + height * .22, left + width * 1.08, top + height * .62, left + width * .84, top + height * .76);
    context.bezierCurveTo(left + width * .66, top + height * .91, left + width * .34, top + height * .88, left + width * .18, top + height * .78); context.closePath();
  }
  if (op.filled && op.shape !== "line" && op.shape !== "curve") context.fill();
  context.stroke(); context.restore();
}

function smoothedPoints(points: NonNullable<DrawOp["points"]>) {
  if (points.length < 3) return points;
  return points.map((point, index) => {
    if (index === 0 || index === points.length - 1) return point;
    const previous = points[index - 1]; const next = points[index + 1];
    return { ...point, x: (previous.x + point.x * 2 + next.x) / 4, y: (previous.y + point.y * 2 + next.y) / 4 };
  });
}

function eraseWithSquareFootprint(context: CanvasRenderingContext2D, op: DrawOp, size: number, docH: number) {
  if (!op.points?.length) return;
  const footprint = Math.max(1, (op.width ?? 8) * size / 1024); const half = footprint / 2;
  context.save(); context.globalCompositeOperation = "destination-out"; context.globalAlpha = 1; context.fillStyle = "#000";
  const stamp = (x: number, y: number) => context.fillRect(x * size - half, y * docH - half, footprint, footprint);
  stamp(op.points[0].x, op.points[0].y);
  for (let index = 1; index < op.points.length; index += 1) {
    const start = op.points[index - 1]; const end = op.points[index]; const distance = Math.hypot((end.x - start.x) * size, (end.y - start.y) * docH);
    const steps = Math.max(1, Math.ceil(distance / Math.max(1, footprint * .22)));
    for (let step = 1; step <= steps; step += 1) {
      const amount = step / steps; stamp(start.x + (end.x - start.x) * amount, start.y + (end.y - start.y) * amount);
    }
  }
  context.restore();
}

function roundedPath(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  const r = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + r, y);
  context.lineTo(x + width - r, y);
  context.quadraticCurveTo(x + width, y, x + width, y + r);
  context.lineTo(x + width, y + height - r);
  context.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  context.lineTo(x + r, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - r);
  context.lineTo(x, y + r);
  context.quadraticCurveTo(x, y, x + r, y);
  context.closePath();
}

function wrapText(context: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number) {
  const characters = drawingTextGraphemes(text);
  const lines: string[] = [];
  let line = "";
  for (const character of characters) {
    const candidate = `${line}${character}`;
    if (line && context.measureText(candidate).width > maxWidth && lines.length < maxLines - 1) {
      lines.push(line);
      line = character;
    } else line = candidate;
  }
  if (line) lines.push(line);
  return lines.slice(0, maxLines);
}

function drawText(context: CanvasRenderingContext2D, op: DrawOp, size: number, docH: number) {
  const center = op.points?.[0];
  if (!center || !op.text || !op.textKind || !op.fontSize || op.deleted) return;
  const scale = size / 1024;
  const fontSize = op.fontSize * scale;
  const x = center.x * size;
  const y = center.y * docH;
  const isTitle = op.textKind === "title";
  const isSpeech = op.textKind === "speech";
  const maxWidth = size * (isTitle ? 0.82 : isSpeech ? 0.58 : 0.55);
  const lineHeight = fontSize * 1.28;
  const [red, green, blue] = rgb(op.color);
  const lightInk = red * 0.299 + green * 0.587 + blue * 0.114 > 185;
  const outlineColor = lightInk ? "rgba(27,58,87,.96)" : "rgba(255,255,255,.96)";
  context.save();
  context.globalCompositeOperation = "source-over";
  context.globalAlpha = 1;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.font = `${isTitle ? 800 : 700} ${Math.round(fontSize)}px "Arial Rounded MT Bold", "Noto Sans KR", "Apple SD Gothic Neo", sans-serif`;
  const lines = isSpeech ? wrapText(context, op.text, maxWidth, 2) : [op.text];
  const measuredWidth = Math.min(maxWidth, Math.max(...lines.map((line) => context.measureText(line).width)));
  const paddingX = 22 * scale;
  const paddingY = 16 * scale;
  if (!isTitle) {
    const bubbleWidth = measuredWidth + paddingX * 2;
    const bubbleHeight = Math.max(lineHeight, lines.length * lineHeight) + paddingY * 2;
    const left = x - bubbleWidth / 2;
    const top = y - bubbleHeight / 2;
    context.fillStyle = "rgba(255,255,255,.94)";
    context.strokeStyle = lightInk ? "#5B7FA0" : op.color ?? "#1B3A57";
    context.lineWidth = Math.max(2, 3 * scale);
    roundedPath(context, left, top, bubbleWidth, bubbleHeight, 18 * scale);
    context.fill();
    context.stroke();
    if (isSpeech) {
      context.beginPath();
      context.moveTo(x + bubbleWidth * 0.18, top + bubbleHeight - 2 * scale);
      context.lineTo(x + bubbleWidth * 0.30, top + bubbleHeight + 24 * scale);
      context.lineTo(x + bubbleWidth * 0.34, top + bubbleHeight - 2 * scale);
      context.closePath();
      context.fill();
      context.stroke();
    }
  }
  context.fillStyle = op.color ?? "#1B3A57";
  if (isTitle) {
    context.strokeStyle = outlineColor;
    context.lineWidth = Math.max(3, 8 * scale);
    context.lineJoin = "round";
    context.strokeText(op.text, x, y, maxWidth);
    context.fillText(op.text, x, y, maxWidth);
  } else {
    const topLineY = y - ((lines.length - 1) * lineHeight) / 2;
    context.strokeStyle = outlineColor;
    context.lineWidth = Math.max(1.5, 3 * scale);
    context.lineJoin = "round";
    lines.forEach((line, index) => {
      context.strokeText(line, x, topLineY + index * lineHeight, maxWidth);
      context.fillText(line, x, topLineY + index * lineHeight, maxWidth);
    });
  }
  context.restore();
}

export function renderDrawOperation(context: CanvasRenderingContext2D, op: DrawOp, canvasSize: RenderSize) {
  const { w: size, h: docH } = dimensions(canvasSize);
  if (op.type === "fill") { floodFill(context, op, size, docH); return; }
  if (op.type === "shape") { drawShape(context, op, size, docH); return; }
  if (op.type === "text") { drawText(context, op, size, docH); return; }
  if (op.type === "sticker") {
    const center = op.points?.[0]; if (!center || !op.sticker) return;
    context.save(); context.globalCompositeOperation = "source-over"; context.globalAlpha = 1; context.textAlign = "center"; context.textBaseline = "middle"; context.font = `${Math.round((op.fontSize ?? STICKER_SIZE) * size / 1024)}px "Apple Color Emoji", "Segoe UI Emoji", sans-serif`;
    context.fillText(STICKER_EMOJI[op.sticker], center.x * size, center.y * docH); context.restore(); return;
  }
  if (!op.points?.length) return;
  if (op.tool === "eraser" && op.squareEraser) { eraseWithSquareFootprint(context, op, size, docH); return; }
  const points = op.smoothed ? smoothedPoints(op.points) : op.points;
  context.save(); context.lineCap = "round"; context.lineJoin = "round";
  context.globalCompositeOperation = op.tool === "eraser" ? "destination-out" : "source-over";
  context.strokeStyle = op.color ?? "#1B3A57";
  // 도구별 질감: 크레용은 반투명(기존 렌더 보존을 위해 값 불변), 수채붓은 아주 옅고 넓게 +
  // 바깥 번짐 패스(겹칠수록 물감처럼 진해짐), 마커는 가장 넓고 완전 불투명.
  context.globalAlpha = op.tool === "crayon" ? 0.62 : op.tool === "watercolor" ? 0.3 : 1;
  const baseWidth = drawnStrokeWidth(op.tool, op.width ?? 8) * size / 1024;
  context.lineWidth = baseWidth;
  // 새 연필(pencil)만 필압으로 굵기가 변한다. 기존 "pen" 획에는 실필압이 이미 기록돼 있어
  // 배율을 적용하면 저장 당시 이미지와 재생이 어긋나므로, pen은 예전과 동일한 균일 굵기로 남긴다.
  if (op.tool === "pencil" && points.length > 1) {
    for (let index = 1; index < points.length; index += 1) {
      const start = points[index - 1]; const end = points[index];
      const pressure = ((start.pressure ?? 0.5) + (end.pressure ?? 0.5)) / 2;
      context.lineWidth = baseWidth * Math.max(0.35, Math.min(1.5, 0.5 + pressure));
      context.beginPath(); context.moveTo(start.x * size, start.y * docH); context.lineTo(end.x * size, end.y * docH); context.stroke();
    }
    context.restore(); return;
  }
  if (op.tool === "pencil") context.lineWidth = baseWidth * Math.max(0.35, Math.min(1.5, 0.5 + (points[0].pressure ?? 0.5)));
  context.beginPath(); context.moveTo(points[0].x * size, points[0].y * docH);
  for (const point of points.slice(1)) context.lineTo(point.x * size, point.y * docH);
  if (points.length === 1) context.lineTo(points[0].x * size + 0.1, points[0].y * docH + 0.1);
  if (op.tool === "watercolor") {
    // 같은 경로를 넓고 옅게 한 번 더 그어 가장자리 번짐을 만든다. (결정적 — 재생·타임랩스 동일)
    context.globalAlpha = 0.12; context.lineWidth = baseWidth * 1.35; context.stroke();
    context.globalAlpha = 0.3; context.lineWidth = baseWidth;
  }
  context.stroke(); context.restore();
}

/* 지우개는 `destination-out`이라 캔버스에 진짜 구멍을 뚫는다 — `resetDrawingCanvas`가 미리 칠해 둔
 * 흰 종이까지 함께 지운다. 그래서 다 그린 뒤 종이를 **밑에** 한 번 더 깔아 구멍을 메운다.
 * 이것이 없으면 지운 자리가 알파 0으로 저장돼, 흰색이 아닌 바탕 위에 얹힐 때 그 색이 비친다.
 * 특히 그림책 인쇄(`lib/book-render.ts`)는 지면색 위에 얹고 JPEG로 구워 **되돌릴 수 없다**
 * (2026-09-27 사용자 지적 "지우개로 지우면 왜 회색이 그려져?"에서 드러난 같은 뿌리). */
function paintPaperUnder(context: CanvasRenderingContext2D, size: RenderSize) {
  const { w, h } = dimensions(size);
  context.save();
  context.globalCompositeOperation = "destination-over"; context.globalAlpha = 1;
  context.fillStyle = "#ffffff"; context.fillRect(0, 0, w, h);
  context.restore();
}

export function renderDrawDocument(context: CanvasRenderingContext2D, ops: readonly DrawOp[], size: RenderSize, limit = ops.length) {
  for (const op of visibleDrawOperations(ops, limit)) renderDrawOperation(context, op, size);
  // ponytail: 종이를 마지막에 깐다. 이 뒤에 renderDrawOperation으로 지우개 획을 낱개로 덧대면
  // 다시 뚫린다(타임랩스 재생이 그렇게 쓴다) — 필요해지면 그쪽에서도 한 번 더 깔면 된다.
  paintPaperUnder(context, size);
}

export function resetDrawingCanvas(context: CanvasRenderingContext2D, size: RenderSize) {
  const { w, h } = dimensions(size);
  context.globalCompositeOperation = "source-over"; context.globalAlpha = 1; context.clearRect(0, 0, w, h); context.fillStyle = "#ffffff"; context.fillRect(0, 0, w, h);
}
