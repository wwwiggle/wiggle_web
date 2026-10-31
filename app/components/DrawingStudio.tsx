"use client";

import { PointerEvent as ReactPointerEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { activeTextObjects, clampDocumentHeight, contentBounds, DOCUMENT_SIZE, documentHeight, documentSpan, DrawDocument, DrawOp, drawingTextGraphemes, drawObjectBounds, drawObjectKey, movableDrawObjects, scaleDrawObject, shiftDrawPoints, visibleDrawOperations, emptyDocument, estimateDocumentBytes, estimateStrokeBytes, growDrawOps, MAX_DOCUMENT_BYTES, MAX_DOCUMENT_OPS, MAX_STROKE_POINTS, strokePointGap, MAX_TEXT_GRAPHEMES, MAX_TEXT_OBJECTS, NEW_DOCUMENT_SPAN, normalizeDrawingText, roundUnit, ShapeKind, STICKER_ALLOWLIST, STICKER_SIZE, STROKE_WIDTH_SCREEN_MAX, STROKE_WIDTH_MIN, StrokeWidth, TextKind, TEXT_SIZES, TextSize, toDocumentUnits, toScreenUnits, validateDrawDocument } from "@/lib/drawing-model";
import { renderDrawDocument, renderDrawOperation, resetDrawingCanvas, STICKER_EMOJI } from "@/lib/draw-renderer";
import { mirrorOp } from "@/lib/symmetry";
import { clearAllDrawing, redoDrawing, undoDrawing } from "@/lib/drawing-history";
import { DrawingInputMode, INPUT_MODE_EVENT } from "@/lib/input-mode";
import { CanvasView, clampView, coverPaper, IDENTITY_VIEW, MAX_SCALE, minScaleFor, pinchView, zoomView } from "@/lib/canvas-view";
import { lessonBySlug, Lesson } from "@/lib/lesson-content";
import { guideMarksForVariant } from "@/lib/lesson-guide-variants";
import { ArrowLeftIcon, CheckIcon, ChevronUpIcon, HandIcon, MoreHorizontalIcon, Redo2Icon, Trash2Icon, Undo2Icon } from "./StudioIcons";
import { createLessonStepBaseline, isLessonStepProgress, lessonStepActionStatus, LessonStepProgress } from "@/lib/lesson-step-progress";
import { lockGuideTrace, snapGuideTrace } from "@/lib/trace-guidance.mjs";
import { clampTextPlacement, suggestTextPlacement } from "@/lib/text-placement";
import { activeProfile, clearQueuedArtworkSaves, createSerialTaskQueue, deleteQueuedArtworkSave, flushSaves, queueSave, queuedArtworkDraft, queuedArtworkSaves, resolveArtworkDraftDisposition, studentFetch } from "@/lib/client-session";

import type { QueuedArtworkDraft } from "@/lib/client-session";
import { Logo } from "./Logo";
import { WaitMongri } from "./WaitMongri";
import { useModalDialog } from "./useModalDialog";
import { ColorPickerDialog } from "./ColorPickerDialog";
import { StudentMessageCenter, StudentTeacherMessage } from "./StudentMessageCenter";
import { drawMarkStrokes, type MarkAnswer, type MarkStroke } from "@/lib/teacher-marks";

const PALETTE = ["#1B3A57", "#E53935", "#FB8C00", "#FDD835", "#43A047", "#1E88E5", "#8E24AA", "#8D6E63", "#F06292", "#4DD0E1", "#FFCC80", "#FFFFFF"];
const CHOICE_DRAWING_SETUP: Record<string, { color?: string; shade?: "base" | "light"; tool: BrushTool; width: StrokeWidth; feedback: string }> = {
  "초록 눈": { color: "#43A047", shade: "base", tool: "pencil", width: 16, feedback: "초록 연필을 골랐어요. 눈 안쪽을 초록색으로 그려요." },
  "파란 눈": { color: "#1E88E5", shade: "base", tool: "pencil", width: 16, feedback: "파란 연필을 골랐어요. 눈 안쪽을 파란색으로 그려요." },
  "줄무늬 꼬리": { tool: "pencil", width: 16, feedback: "연필로 꼬리에 짧은 선을 세 개 더해요." },
  "점무늬 꼬리": { tool: "pencil", width: 16, feedback: "연필로 꼬리에 작은 동그라미를 세 개 더해요." },
  "하얀 고양이": { color: "#F8BBD0", shade: "light", tool: "crayon", width: 48, feedback: "몸은 하얗게 남기고, 분홍 크레용으로 귀와 볼을 꾸며요." },
  "회색 고양이": { color: "#9AA7B1", shade: "light", tool: "crayon", width: 48, feedback: "회색 크레용을 골랐어요. 몸 안을 크게 쓱쓱 칠해요." },
};
const COLOR_NAMES: Record<string, string> = {
  "#1B3A57": "남색",
  "#E53935": "빨간색",
  "#FB8C00": "주황색",
  "#FDD835": "노란색",
  "#43A047": "초록색",
  "#1E88E5": "파란색",
  "#8E24AA": "보라색",
  "#8D6E63": "갈색",
  "#F06292": "분홍색",
  "#4DD0E1": "하늘색",
  "#FFCC80": "살구색",
  "#FFFFFF": "흰색",
  "#5B7FA0": "밝은 남색",
  "#F8A9A4": "밝은 빨간색",
  "#FFC97E": "밝은 주황색",
  "#FFF0A6": "밝은 노란색",
  "#A5D6A7": "밝은 초록색",
  "#90CAF9": "밝은 파란색",
  "#CE93D8": "밝은 보라색",
  "#C4A79F": "밝은 갈색",
  "#F8BBD0": "밝은 분홍색",
  "#B2EBF2": "밝은 하늘색",
  "#FFE0B2": "밝은 살구색",
  "#9AA7B1": "회색",
  "#000000": "검정",
  "#455A64": "진한 회색",
  "#D7DEE3": "연한 회색",
  "#5D4037": "진한 갈색",
  "#795548": "갈색",
  "#A1887F": "연한 갈색",
  "#D7CCC8": "회갈색",
  "#F5E0C3": "베이지",
  "#B71C1C": "진한 빨강",
  "#FF7043": "산호색",
  "#C0CA33": "연두",
  "#00897B": "청록",
  "#80CBC4": "민트",
  "#26C6DA": "밝은 하늘색",
  "#64B5F6": "하늘색",
  "#3949AB": "진한 파랑",
  "#7E57C2": "연보라",
  "#EC407A": "진한 분홍",
};
/* 도구 막대의 세워진 도구(2026-09-14, public/drawing-tools/dock/). tint가 있는 붓은 끝·띠 마스크(<id>-tint.webp)를 지금 색으로 칠한다. */
const DOCK_TOOLS: { id: "pencil" | "crayon" | "marker" | "watercolor" | "eraser"; label: string; tint: boolean }[] = [
  { id: "pencil", label: "연필", tint: true },
  { id: "crayon", label: "크레용", tint: true },
  { id: "marker", label: "마커", tint: true },
  { id: "watercolor", label: "수채붓", tint: true },
  { id: "eraser", label: "지우개", tint: false },
];
/* 막대에 늘 보이는 색 수. 나머지는 무지개 버튼의 12색 창에 있다. */
const DOCK_QUICK_COLORS = 8;

const SHAPE_KINDS = [
  { kind: "line", icon: "─", label: "선" },
  { kind: "circle", icon: "○", label: "동그라미" },
  { kind: "triangle", icon: "△", label: "세모" },
  { kind: "rectangle", icon: "□", label: "네모" },
  { kind: "rounded-rectangle", icon: "▢", label: "둥근 네모" },
  { kind: "star", icon: "☆", label: "별" },
  { kind: "heart", icon: "♡", label: "하트" },
  { kind: "arrow", icon: "➜", label: "화살표" },
  { kind: "curve", icon: "⌒", label: "곡선" },
  { kind: "cloud", icon: "☁", label: "구름" },
] as const;
const BASIC_SHAPE_COUNT = 4;

const TEXT_KIND_OPTIONS: Array<{ kind: TextKind; icon: string; label: string; help: string }> = [
  { kind: "label", icon: "🏷️", label: "이름표", help: "짧은 낱말" },
  { kind: "title", icon: "✨", label: "제목", help: "그림의 이름" },
  { kind: "speech", icon: "💬", label: "말풍선", help: "그림 속 한마디" },
];
// "pencil"이 새 연필 획(필압 렌더 적용). "pen"은 이 UI가 더 만들지 않는 기존 획 값이다.
type BrushTool = "pencil" | "crayon" | "marker" | "watercolor";
type Tool = BrushTool | "eraser";
type StrokeMeta = { tool: Tool; color: string; width: StrokeWidth };
type StudioTool = Tool | "fill" | "shape" | "text" | "sticker" | "pipette" | "move";
type StickerKind = (typeof STICKER_ALLOWLIST)[number];
const STICKER_LABELS: Record<StickerKind, string> = { star: "별", heart: "하트", leaf: "나뭇잎", cloud: "구름", sparkle: "반짝이" };
type PendingText = { text: string; textKind: TextKind; fontSize: TextSize; color: string };
type GuidePhase = "independent" | "demo" | "practice";
type TracePoint = { x: number; y: number };
type GuideTrace = TracePoint[];
type ArtworkPayload = {
  id: string;
  title: string;
  topic: string;
  learningMode: string;
  lessonSlug: string | null;
  guideVariant: number;
  intent: string;
  document: DrawDocument;
  currentStep: number;
  revision: number;
  status: string;
};
type CoachingChoice = { emoji: string; label: string; answer: string };
type StudentCoaching = {
  question: string;
  choices: CoachingChoice[];
  nextAction: string;
  observedElements: string[];
  uncertain: boolean;
  growthEvent: string;
};
/** 틀리는 해석자 — 몽그리가 먼저 짐작을 내놓고 아이가 고친다 (product-decisions 학습 과정 4항). */
type StoryInterpretation = { guess: string; choices: CoachingChoice[] };
/** 점선 시범이 쓰는 도형 종류. 수업 카탈로그가 몰던 값이라 단계 가이드 은퇴 뒤에도 남는다. */
type GuideShape = "none" | "line" | "circle" | "triangle" | "rectangle";
type SaveOptions = {
  complete?: boolean;
  reflection?: Record<string, string>;
  currentStep?: number;
};
type LessonStepPrompt = "step-action" | "unfinished-lesson" | null;

/* 몽그리 요청에만 시간 제한을 둔다. 서버는 20초에 스스로 끊고 504를 주지만(lib/openai-coaching.ts),
 * 그 답이 오는 길이 끊기면(교실 와이파이가 끊기는 흔한 일) 아이 화면의 표시가 영구히 돈다.
 * 25초는 서버 상한보다 길어, 서버가 답할 수 있는 요청을 이쪽에서 먼저 끊어 버리지 않는 값이다.
 * 저장에는 쓰지 않는다 — 느린 교실 와이파이에서 큰 PNG가 30초 넘게 올라가는 일은 정상이고,
 * 거기서 끊으면 아이 그림을 잃는다. AbortSignal.timeout을 모르는 옛 브라우저는 제한 없이 보낸다
 * (여기서 던지면 몽그리가 그 기기에서 아예 안 열린다). */
const GRIMI_TIMEOUT_MS = 25_000;
/* 짐작만 더 짧게 끊는다. 몽그리를 부른 답은 아이가 기다리는 목적 그 자체지만, 짐작은 없어도
 * 완성에 지장이 없는 곁가지다(askInterpretation). 8살에게 25초 동안 점만 보여 주는 대신
 * 12초에 「못 봤어」로 넘겨 자기 말로 쓰게 한다. */
const INTERPRET_TIMEOUT_MS = 12_000;

async function grimiFetch(body: Record<string, unknown>, timeoutMs = GRIMI_TIMEOUT_MS) {
  try {
    return await studentFetch("/api/ai/coaching", {
      method: "POST",
      body: JSON.stringify(body),
      signal: typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(timeoutMs) : undefined,
    });
  } catch (cause) {
    // 끊긴 것도 아이에게는 「늦었다」는 한 가지 일이다. DOMException의 영문 문구를 그대로 보여 주지 않는다.
    if (cause instanceof DOMException && cause.name === "TimeoutError") throw new Error("몽그리가 지금 대답이 늦어. 조금 뒤에 다시 불러 줄래?");
    throw cause;
  }
}

function documentPixels(document: Pick<DrawDocument, "height">, width: number) {
  return { width, height: Math.round(width * documentHeight(document) / DOCUMENT_SIZE) };
}

/* 도화지 래스터는 "화면에 보이는 크기 × 기기 픽셀"에 맞춘다. 예전에는 늘 가로 1024로만 그려서,
 * 큰 화면이나 확대한 상태에서 3배 가까이 늘여 보여 선이 뭉개졌다(2026-09-20 사용자: "도화지 축소시 픽셀 깨져보이고").
 * 상한을 두는 이유: 채우기(페인트통)가 이 래스터를 한 픽셀씩 훑고, 되돌리기 스냅숏도 같은 크기로 잡힌다. */
const MIN_RASTER_WIDTH = 1024;
const MAX_RASTER_WIDTH = 3072;
const MAX_RASTER_PIXELS = 9_000_000;
function rasterWidthFor(displayWidth: number, docHeight: number) {
  const dpr = typeof window === "undefined" ? 1 : Math.min(3, window.devicePixelRatio || 1);
  const wanted = Math.max(MIN_RASTER_WIDTH, Math.min(MAX_RASTER_WIDTH, Math.round(displayWidth * dpr)));
  const byArea = Math.sqrt(MAX_RASTER_PIXELS * DOCUMENT_SIZE / docHeight);
  return Math.max(MIN_RASTER_WIDTH, Math.round(Math.min(wanted, byArea)));
}

function renderDocument(canvas: HTMLCanvasElement, document: DrawDocument, width = 1024) {
  // size는 이제 가로·세로를 함께 담는다. 기존 정사각 문서는 height가 없어 예전과 같은 값이 나온다.
  const size = documentPixels(document, width);
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext("2d");
  if (!context) return;
  resetDrawingCanvas(context, size);
  renderDrawDocument(context, document.ops, size);
}

/* 그리는 중인 획을 올리는 얇은 층. 도화지와 픽셀 크기를 맞춰 두면 문서 좌표를 그대로 쓸 수 있고,
 * 반투명 브러시도 층 전체를 지우고 획을 다시 그리면 알파가 겹치지 않는다. 예전에는 같은 일을
 * 도화지 위에서 하느라 이벤트마다 캔버스 전체를 ImageData로 뜨고 되돌렸다(아이패드 미니에서 34MB·약 38ms). */
function liveStrokeContext(live: HTMLCanvasElement | null, canvas: HTMLCanvasElement) {
  if (!live) return null;
  // width/height를 다시 넣으면 층이 비워진다 — 크기가 같을 때만 clearRect를 쓴다.
  if (live.width !== canvas.width || live.height !== canvas.height) {
    live.width = canvas.width;
    live.height = canvas.height;
    return live.getContext("2d");
  }
  const context = live.getContext("2d");
  if (context) context.clearRect(0, 0, live.width, live.height);
  return context;
}

function clearLiveStroke(live: HTMLCanvasElement | null) {
  const context = live?.getContext("2d");
  if (live && context) context.clearRect(0, 0, live.width, live.height);
}

function renderLiveStroke(canvas: HTMLCanvasElement, tool: Tool, color: string, width: StrokeWidth, points: Array<{ x: number; y: number; pressure: number }>) {
  const context = canvas.getContext("2d");
  if (!context || !points.length) return;
  renderDrawOperation(
    context,
    {
      opId: "preview_op",
      clientOpId: "preview_client",
      type: "stroke",
      at: "2000-01-01T00:00:00.000Z",
      tool,
      color: tool === "eraser" ? undefined : color,
      width,
      points,
      smoothed: tool !== "eraser",
      squareEraser: tool === "eraser",
    },
    { width: canvas.width, height: canvas.height },
  );
}

function sampleLine(points: Array<[number, number]>) {
  const trace: GuideTrace = [];
  for (let index = 1; index < points.length; index += 1) {
    const [startX, startY] = points[index - 1];
    const [endX, endY] = points[index];
    const distance = Math.hypot(endX - startX, endY - startY);
    const segments = Math.max(8, Math.ceil(distance * 90));
    for (let segment = index === 1 ? 0 : 1; segment <= segments; segment += 1) {
      const amount = segment / segments;
      trace.push({
        x: (startX + (endX - startX) * amount) * 1024,
        y: (startY + (endY - startY) * amount) * 1024,
      });
    }
  }
  return trace;
}

function sampleEllipse(x: number, y: number, rx: number, ry: number) {
  const trace: GuideTrace = [];
  for (let segment = 0; segment <= 96; segment += 1) {
    const angle = -Math.PI / 2 + (Math.PI * 2 * segment) / 96;
    trace.push({
      x: (x + Math.cos(angle) * rx) * 1024,
      y: (y + Math.sin(angle) * ry) * 1024,
    });
  }
  return trace;
}

function sampleCurve(points: [[number, number], [number, number], [number, number], [number, number]]) {
  const trace: GuideTrace = [];
  const [start, first, second, end] = points;
  for (let segment = 0; segment <= 96; segment += 1) {
    const amount = segment / 96;
    const remaining = 1 - amount;
    trace.push({
      x: (remaining ** 3 * start[0] + 3 * remaining ** 2 * amount * first[0] + 3 * remaining * amount ** 2 * second[0] + amount ** 3 * end[0]) * 1024,
      y: (remaining ** 3 * start[1] + 3 * remaining ** 2 * amount * first[1] + 3 * remaining * amount ** 2 * second[1] + amount ** 3 * end[1]) * 1024,
    });
  }
  return trace;
}

function guideTraces(lesson: Lesson | undefined, lessonStep = 0, aiShape: GuideShape = "none", guideVariant = 0) {
  const traces: GuideTrace[] = [];
  const lessonMarks = lesson ? guideMarksForVariant(lesson, guideVariant) : [];
  for (const mark of lessonMarks.filter((item) => item.step === lessonStep + 1)) {
    if (mark.kind === "line") traces.push(sampleLine(mark.points));
    if (mark.kind === "ellipse") traces.push(sampleEllipse(mark.x, mark.y, mark.rx, mark.ry));
    if (mark.kind === "rect")
      traces.push(
        sampleLine([
          [mark.x, mark.y],
          [mark.x + mark.width, mark.y],
          [mark.x + mark.width, mark.y + mark.height],
          [mark.x, mark.y + mark.height],
          [mark.x, mark.y],
        ]),
      );
    if (mark.kind === "curve") traces.push(sampleCurve(mark.points));
  }
  if (!lesson && aiShape === "line")
    traces.push(
      sampleLine([
        [0.25, 0.51],
        [0.75, 0.51],
      ]),
    );
  if (!lesson && aiShape === "circle") traces.push(sampleEllipse(0.5, 0.5, 0.225, 0.225));
  if (!lesson && aiShape === "triangle")
    traces.push(
      sampleLine([
        [0.5, 0.24],
        [0.26, 0.74],
        [0.74, 0.74],
        [0.5, 0.24],
      ]),
    );
  if (!lesson && aiShape === "rectangle")
    traces.push(
      sampleLine([
        [0.28, 0.29],
        [0.72, 0.29],
        [0.72, 0.7],
        [0.28, 0.7],
        [0.28, 0.29],
      ]),
    );
  return traces.filter((trace) => trace.length > 1);
}

function traceLength(trace: GuideTrace) {
  let length = 0;
  for (let index = 1; index < trace.length; index += 1) length += Math.hypot(trace[index].x - trace[index - 1].x, trace[index].y - trace[index - 1].y);
  return length;
}

function drawTrace(context: CanvasRenderingContext2D, trace: GuideTrace, distance = Number.POSITIVE_INFINITY) {
  if (trace.length < 2) return { point: trace[0], previous: trace[0] };
  context.beginPath();
  context.moveTo(trace[0].x, trace[0].y);
  let travelled = 0;
  let point = trace[0];
  let previous = trace[0];
  for (let index = 1; index < trace.length; index += 1) {
    const start = trace[index - 1];
    const end = trace[index];
    const segment = Math.hypot(end.x - start.x, end.y - start.y);
    if (travelled + segment >= distance) {
      const amount = segment > 0 ? Math.max(0, Math.min(1, (distance - travelled) / segment)) : 0;
      point = {
        x: start.x + (end.x - start.x) * amount,
        y: start.y + (end.y - start.y) * amount,
      };
      previous = start;
      context.lineTo(point.x, point.y);
      break;
    }
    context.lineTo(end.x, end.y);
    previous = start;
    point = end;
    travelled += segment;
  }
  context.stroke();
  return { point, previous };
}

function drawPencil(context: CanvasRenderingContext2D, point: TracePoint, previous: TracePoint) {
  const angle = Math.atan2(point.y - previous.y, point.x - previous.x);
  context.save();
  context.translate(point.x, point.y);
  context.rotate(angle);
  context.shadowColor = "rgba(26,59,92,.24)";
  context.shadowBlur = 12;
  context.shadowOffsetY = 6;
  context.fillStyle = "#FDD835";
  context.strokeStyle = "#B88200";
  context.lineWidth = 3;
  context.setLineDash([]);
  context.beginPath();
  context.roundRect(-66, -17, 55, 34, 8);
  context.fill();
  context.stroke();
  context.fillStyle = "#F2B8B5";
  context.fillRect(-66, -17, 15, 34);
  context.fillStyle = "#F5D2A5";
  context.beginPath();
  context.moveTo(-11, -17);
  context.lineTo(4, 0);
  context.lineTo(-11, 17);
  context.closePath();
  context.fill();
  context.stroke();
  context.fillStyle = "#1B3A57";
  context.beginPath();
  context.moveTo(-1, -4);
  context.lineTo(7, 0);
  context.lineTo(-1, 4);
  context.closePath();
  context.fill();
  context.restore();
}

/* 점선·시범 좌표는 정사각 기준으로 그려 둔 것이다. 가로 도화지에 x를 그대로 늘리면
 * 동그라미가 타원이 되므로, 도화지 가운데의 정사각 영역 안에 넣어 모양을 지킨다. */
function guideSquare(canvas: HTMLCanvasElement) {
  const side = Math.min(canvas.width, canvas.height);
  return { side, left: (canvas.width - side) / 2, top: (canvas.height - side) / 2 };
}

function renderGuideFrame(canvas: HTMLCanvasElement, traces: GuideTrace[], phase: GuidePhase, progress = 0, docHeight = 1024) {
  if (canvas.width !== 1024) canvas.width = 1024;
  if (canvas.height !== docHeight) canvas.height = docHeight;
  const context = canvas.getContext("2d");
  if (!context) return;
  context.clearRect(0, 0, canvas.width, canvas.height);
  if (phase === "independent" || !traces.length) return;
  const square = guideSquare(canvas);
  context.save();
  context.translate(square.left, square.top);
  context.scale(square.side / 1024, square.side / 1024);
  context.strokeStyle = "#087EA8";
  context.globalAlpha = 0.92;
  context.lineWidth = 9;
  context.setLineDash([20, 14]);
  context.lineCap = "round";
  context.lineJoin = "round";
  if (phase === "demo") context.globalAlpha = 0.58;
  for (const trace of traces) {
    drawTrace(context, trace);
  }
  if (phase === "demo") {
    const lengths = traces.map(traceLength);
    const target = lengths.reduce((sum, length) => sum + length, 0) * Math.max(0, Math.min(1, progress));
    let remaining = target;
    let pencil = { point: traces[0][0], previous: traces[0][0] };
    context.strokeStyle = "#FDD835";
    context.globalAlpha = 0.96;
    context.lineWidth = 16;
    context.setLineDash([]);
    for (let index = 0; index < traces.length; index += 1) {
      if (remaining <= 0) break;
      const distance = Math.min(lengths[index], remaining);
      pencil = drawTrace(context, traces[index], distance);
      remaining -= lengths[index];
    }
    drawPencil(context, pencil.point, pencil.previous);
  }
  context.restore();
}


/* 썸네일은 자동 저장마다 본문에 실린다(완성본은 완성할 때 한 번뿐이다). 그래서 이 한 장만
 * WebP 무손실로 굽는다 — 실측(2026-09-26): 물감 많은 그림 기준 PNG 40.3KB → WebP 23.9KB(−41%),
 * 픽셀 손상 0, 256px 인코딩은 PNG보다 오히려 빠르다(2.2ms → 1.8ms).
 * 완성본(1024)은 PNG 그대로 둔다 — 한 번뿐이라 이득이 작고 인코딩이 3배 느리다.
 * toDataURL은 못 굽는 형식을 주면 **말없이 PNG를 돌려준다.** 그래서 결과 접두사를 보고 판단한다 —
 * 안 되는 기기(옛 사파리)에서는 자동으로 PNG가 되고 서버는 둘 다 받는다. */
function encodeThumbnail(output: HTMLCanvasElement) {
  const webp = output.toDataURL("image/webp", 1);
  return webp.startsWith("data:image/webp;base64,") ? webp : output.toDataURL("image/png");
}

/* 저장 이미지는 화면 픽셀이 아니라 저장하려는 문서에서 직접 렌더한다. 화면 캔버스에는
 * 그리는 중 미리보기 같은 문서 밖 픽셀이 있을 수 있고, 그게 썸네일·완성 PNG에 섞이면 안 된다.
 *
 * 2026-09-26: 몽그리에 보내는 이미지도 이것을 쓴다(미결정 P-014). 종전에는 "아이가 지금 보는
 * 화면"이라는 이유로 imageData를 썼는데, 실제로는 화면이 아니라 문서 래스터 전체였고 — 넓은
 * 도화지(span 3)는 대부분이 흰 여백이라 340×290짜리 집이 모델 눈에 57×48px(넓이의 5.6%)로
 * 들어갔다. 이 함수는 span>1이면 그린 칸만 잘라 같은 크기에 9배 크게 담는다. */
function documentImage(documentValue: DrawDocument, size: 256 | 1024) {
  const span = documentSpan(documentValue);
  const bounds = span > 1 ? contentBounds(documentValue) : null;
  if (!bounds) {
    const output = document.createElement("canvas");
    renderDocument(output, documentValue, size);
    return size === 256 ? encodeThumbnail(output) : output.toDataURL("image/png");
  }
  /* 넓은 도화지(span>1)는 흰 여백이 대부분이라 도화지 전체를 1024로 줄이면 아이 그림이 1/3 크기로 들어간다.
   * 그러면 그림책·인쇄에서 뭉개진다. 그래서 그린 칸만 잘라, 같은 파일 크기로 훨씬 촘촘하게 담는다. */
  const paperWidth = size === 256 ? 256 * span : 1024 * span;
  const paperHeight = Math.round(paperWidth * documentHeight(documentValue) / DOCUMENT_SIZE);
  const cropWidth = Math.max(1, Math.round(bounds.width * paperWidth));
  const cropHeight = Math.max(1, Math.round(bounds.height * paperHeight));
  // 긴 변을 목표 크기에 맞춘다 — 작은 낙서는 크게, 큰 그림은 한도 안에서.
  const longest = Math.max(cropWidth, cropHeight);
  const target = size === 256 ? 256 : 1536;
  const ratio = Math.min(4, target / longest);
  const output = document.createElement("canvas");
  output.width = Math.max(1, Math.round(cropWidth * ratio));
  output.height = Math.max(1, Math.round(cropHeight * ratio));
  const context = output.getContext("2d");
  if (!context) return "";
  const pageSize = { width: Math.round(paperWidth * ratio), height: Math.round(paperHeight * ratio) };
  context.translate(-Math.round(bounds.x * pageSize.width), -Math.round(bounds.y * pageSize.height));
  resetDrawingCanvas(context, pageSize);
  renderDrawDocument(context, documentValue.ops, pageSize);
  return size === 256 ? encodeThumbnail(output) : output.toDataURL("image/png");
}

// 서버 한도에 부딪히면 그 작품은 이후 모든 저장이 실패해 조용히 유실된다.
// 여유분을 두고 미리 멈춰서 아이가 완성으로 안내받게 한다.
const STROKE_POINT_SPLIT = MAX_STROKE_POINTS - 500;
const OPS_WARN_THRESHOLD = MAX_DOCUMENT_OPS - 200;
const DOCUMENT_BYTES_WARN = MAX_DOCUMENT_BYTES - 100_000;
const AUTOSAVE_DEBOUNCE_MS = 1500;
const AUTOSAVE_MAX_WAIT_MS = 6000;
// 선생님이 보고 있는 동안(2026-09-14 사용자 결정): 선생님 실시간 보기가 덜 늦도록 짧게 저장한다.
// 보지 않을 때는 위 값 그대로라 평소 저장 요청은 늘지 않는다.
const WATCHED_AUTOSAVE_DEBOUNCE_MS = 500;
const WATCHED_AUTOSAVE_MAX_WAIT_MS = 2000;

function documentTooLarge(document: DrawDocument) {
  // 한 획도 더 담을 수 없으면 이미 가득 찬 것이다. 여유를 남기지 않으면 pointerDown이
  // 입력을 허용해 놓고 커밋이 거부돼, 문서에 없는 선이 화면과 썸네일에만 남는다.
  return document.ops.length >= OPS_WARN_THRESHOLD || estimateDocumentBytes(document) + estimateStrokeBytes(8) >= DOCUMENT_BYTES_WARN;
}

function mutationId() {
  return `mutation_${crypto.randomUUID().replaceAll("-", "")}`;
}
function coachingRequestId() {
  return `coaching_${crypto.randomUUID().replaceAll("-", "")}`;
}

function lessonStepStorageKey(artworkId: string, lessonSlug: string, step: number) {
  return `wiggle:lesson-step:v1:${artworkId}:${lessonSlug}:${step}`;
}

function guideChoiceStorageKey(artworkId: string, step: number) {
  return `wiggle:guide-choice:v1:${artworkId}:${step}`;
}

export function DrawingStudio() {
  const params = useParams<{ id: string }>();
  const search = useSearchParams();
  const requestedLesson = useMemo(() => lessonBySlug(search.get("lesson") ?? ""), [search]);
  const [artwork, setArtwork] = useState<ArtworkPayload | null>(null);
  // 지난 회차 서랍(Story 3.1) — 같은 아크의 다른 회차 그림. 보기 전용이며 도화지를 딤 처리하지 않는다.
  const [documentState, setDocumentState] = useState<DrawDocument>(emptyDocument());
  const lesson = useMemo(() => (params.id === "new" ? requestedLesson : lessonBySlug(artwork?.lessonSlug)), [artwork?.lessonSlug, params.id, requestedLesson]);
  const [studioTool, setStudioTool] = useState<StudioTool>("pencil");
  const [color, setColor] = useState(PALETTE[0]);
  // 그리기 굵기와 지우개 굵기를 따로 기억한다. 하나로 합치면 지우개를 한 번 쓸 때마다
  // 아이가 고른 그리기 굵기가 말없이 리셋된다.
  const [drawWidth, setDrawWidth] = useState<StrokeWidth>(16);
  const [eraserWidth, setEraserWidth] = useState<StrokeWidth>(48);
  const [colorPickerOpen, setColorPickerOpen] = useState(false);
  // 시안의 좁은 세로 레일에는 브러시·지우개만 남기고 나머지 도구는 더보기 시트로 접는다.
  const [toolSheetOpen, setToolSheetOpen] = useState(false);
  // 선택된 펜을 다시 누르면 그 펜 왼쪽에 굵기 슬라이더가 열린다 (2026-08-30 결정).
  const [widthSliderOpen, setWidthSliderOpen] = useState(false);
  const [dockOpen, setDockOpen] = useState(true);
  const dockSwipeRef = useRef<number | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [guideCollapsed, setGuideCollapsed] = useState(false);
  const [shapeKind, setShapeKind] = useState<ShapeKind>("line");
  const [shapeFilled, setShapeFilled] = useState(false);
  const [stickerKind, setStickerKind] = useState<StickerKind>("star");
  const [selectedObjectKey, setSelectedObjectKey] = useState<string | null>(null);
  const [objectDrag, setObjectDrag] = useState<{ dx: number; dy: number } | null>(null);
  const [objectScale, setObjectScale] = useState<number | null>(null);
  const [moreShapes, setMoreShapes] = useState(false);
  const [textComposerOpen, setTextComposerOpen] = useState(false);
  const [textDraft, setTextDraft] = useState("");
  const [textKind, setTextKind] = useState<TextKind>("label");
  const [textSize, setTextSize] = useState<TextSize>(64);
  const [pendingText, setPendingText] = useState<PendingText | null>(null);
  const [selectedTextObjectId, setSelectedTextObjectId] = useState<string | null>(null);
  const [editingTextObjectId, setEditingTextObjectId] = useState<string | null>(null);
  const [textDragPoint, setTextDragPoint] = useState<{ x: number; y: number } | null>(null);
  const [shapeStartPoint, setShapeStartPoint] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [mirror, setMirror] = useState(false);
  const [view, setView] = useState<CanvasView>(IDENTITY_VIEW);
  const [inputMode, setInputMode] = useState<DrawingInputMode>("pen");
  const [redo, setRedo] = useState<DrawOp[][]>([]);
  // 전체 지우기는 도구 패널의 되돌리기/다시하기와 같은 버튼을 그대로 쓴다. 이 두 상태는
  // "복원 가능한 지우기가 대기 중인지"만 렌더에 반영해 되돌리기/다시하기 disabled를 맞춘다.
  const [hasClearToUndo, setHasClearToUndo] = useState(false);
  const [hasClearToRedo, setHasClearToRedo] = useState(false);
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  const [guidePhase, setGuidePhase] = useState<GuidePhase>("independent");
  const [guideChoiceOpen, setGuideChoiceOpen] = useState(false);
  const [guideDemoRun, setGuideDemoRun] = useState(0);
  const [guidePracticeTried, setGuidePracticeTried] = useState(false);
  const [lessonStepProgress, setLessonStepProgress] = useState<LessonStepProgress | null>(null);
  const [lessonStepPrompt, setLessonStepPrompt] = useState<LessonStepPrompt>(null);
  const [saveState, setSaveState] = useState("불러오는 중");
  const [editVersion, setEditVersion] = useState(0);
  const [reflectionOpen, setReflectionOpen] = useState(false);
  const [completionState, setCompletionState] = useState<"idle" | "saving" | "error">("idle");
  const [completionError, setCompletionError] = useState("");
  // 틀리는 해석자. 몽그리가 쉬고 있어도 완성은 그대로 되어야 하므로 전부 선택 항목이다.
  const [interpretation, setInterpretation] = useState<StoryInterpretation | null>(null);
  const [interpretLoading, setInterpretLoading] = useState(false);
  const [storyText, setStoryText] = useState("");
  // 선생님 말씀 배너는 고정 오버레이라 닫을 수 없으면 밑의 버튼을 영영 가린다.
  // 닫은 메시지 id를 기억하고, 새 메시지가 오면 다시 보여 준다.
  const [teacherMessages, setTeacherMessages] = useState<StudentTeacherMessage[]>([]);
  const [teacherViewing, setTeacherViewing] = useState(false);
  /* 배너는 선생님이 보는 **동안 내내** 떠 있어 그림을 가렸다(2026-09-26 사용자 지적).
   * 알림은 알림이고 상태가 아니다 — 보기 시작할 때 5초만 띄운다. `teacherViewing` 자체는
   * 자동 저장 간격과 자동 호출 억제가 쓰므로 건드리지 않고, 배너 표시만 따로 둔다. */
  const [viewingNoticeOpen, setViewingNoticeOpen] = useState(false);
  // 선생님 표시(아이 원본과 따로 된 층)와 손들기(2026-09-14). 표시는 작품 ops에 넣지 않는다.
  const [teacherMark, setTeacherMark] = useState<{ id: string; artworkId: string; strokes: MarkStroke[]; note: string } | null>(null);
  const [handRaised, setHandRaised] = useState(false);
  const [handBusy, setHandBusy] = useState(false);
  const markRef = useRef<HTMLCanvasElement>(null);
  const answeredMarkIds = useRef(new Set<string>());
  const pollFastRef = useRef(false);
  // 자동 저장 간격만 바꾸면 되므로 ref로 읽는다. 저장 효과의 의존성에 넣으면 보기 시작·끝마다 바뀐 것 없는 저장이 한 번 더 나간다.
  const teacherViewingRef = useRef(false);
  useEffect(() => {
    if (!teacherViewing) { setViewingNoticeOpen(false); return; }
    // 폴링이 같은 true를 다시 넣어도 React가 값을 바꾸지 않아 이 효과는 다시 돌지 않는다.
    setViewingNoticeOpen(true);
    const timer = setTimeout(() => setViewingNoticeOpen(false), 5000);
    return () => clearTimeout(timer);
  }, [teacherViewing]);
  const [conflictRevision, setConflictRevision] = useState<number | null>(null);
  const [conflictDraft, setConflictDraft] = useState<QueuedArtworkDraft | null>(null);
  const [grimiOpen, setGrimiOpen] = useState(false);
  const [grimiLoading, setGrimiLoading] = useState(false);
  const [grimiError, setGrimiError] = useState("");
  // 몽그리가 "선을 하나 더 그어 보자"고 하면 아이는 그려야 한다. 시트를 닫으면 코칭이 사라지므로,
  // 코칭을 유지한 채 도화지를 여는 접기 상태를 따로 둔다.
  const [grimiCollapsed, setGrimiCollapsed] = useState(false);
  // 도구로 이동하는 플로팅 버튼이 정작 도구 패널·몽그리 시트 위까지 떠서
  // 320px 세로에서 전체 지우기·탈출 버튼을 가렸다. 도구가 이미 보이면 숨긴다.
  const [coaching, setCoaching] = useState<(StudentCoaching & { eventId: string }) | null>(null);
  /* 카드에서 바로 답하기(2026-09-26 인계 mongri-floating-handoff). 선택지 하나 또는 아이가 쓴 문장
   * **둘 중 하나만** 답으로 나간다. 둘 다 비면 보내지 않는다. */
  const [pickedAnswer, setPickedAnswer] = useState("");
  const [ownAnswer, setOwnAnswer] = useState("");
  const [replyState, setReplyState] = useState<"idle" | "sending" | "sent">("idle");
  /* 상태만으로는 연속 탭을 못 막는다 — setState가 비동기라 같은 틱에 두 번 누르면 둘 다 통과한다
   * (2026-09-26 실측: 요청이 2번 나갔다). 완성 저장(completingRef)과 같은 방식으로 ref가 막는다. */
  const replyingRef = useRef(false);
  const [replyError, setReplyError] = useState("");
  const [childChoice, setChildChoice] = useState("");
  const [runSerial] = useState(createSerialTaskQueue);
  const [saveBranchId] = useState(() => `branch_${crypto.randomUUID().replaceAll("-", "")}`);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // 그리는 중인 반투명 획을 올리는 층. 도화지와 픽셀 크기가 같아 좌표 변환이 필요 없다.
  const liveCanvasRef = useRef<HTMLCanvasElement>(null);
  const guideRef = useRef<HTMLCanvasElement>(null);
  const eraserFootprintRef = useRef<HTMLDivElement>(null);
  const guideAnimationRef = useRef<number | null>(null);
  const activePoints = useRef(new Map<number, Array<{ x: number; y: number; pressure: number }>>());
  const guideTraceLocksRef = useRef(new Map<number, { traceIndex: number; pointIndex: number }>());
  const wrapRef = useRef<HTMLDivElement>(null);
  const rasterWidthRef = useRef(MIN_RASTER_WIDTH);
  const scaleLimitsRef = useRef({ min: 1, max: MAX_SCALE });
  // 틀(도화지가 보이는 자리)과 그 틀을 빈틈 없이 덮는 1배 종이 크기. 확대·이동 계산이 함께 쓴다.
  const [frame, setFrame] = useState({ width: 0, height: 0 });
  const viewBoxRef = useRef<[number, number, number, number]>([1, 1, 1, 1]);
  const canvasZoneRef = useRef<HTMLElement>(null);
  const viewRef = useRef<CanvasView>(IDENTITY_VIEW);
  const penModeRef = useRef(true);
  const redoRef = useRef<DrawOp[][]>([]);
  const clearedOpsRef = useRef<DrawOp[] | null>(null);
  const clearRedoReadyRef = useRef(false);
  const clearConfirmDialogRef = useRef<HTMLDivElement>(null);
  const lastBrushRef = useRef<BrushTool>("pencil");
  const drawWidthRef = useRef<StrokeWidth>(16);
  const colorModeActiveRef = useRef(false);
  const colorReturnBrushRef = useRef<BrushTool>("pencil");
  const colorReturnWidthRef = useRef<StrokeWidth>(16);
  const shapeStartRef = useRef<{ x: number; y: number } | null>(null);
  const shapeDragRef = useRef<{
    pointerId: number;
    origin: { x: number; y: number };
    moved: boolean;
  } | null>(null);
  const textDragRef = useRef<{ pointerId: number; moved: boolean; startX: number; startY: number } | null>(null);
  const objectDragRef = useRef<{ pointerId: number; moved: boolean; startX: number; startY: number } | null>(null);
  const objectResizeRef = useRef<{ pointerId: number; centerX: number; centerY: number; startDistance: number } | null>(null);
  const gestureTouches = useRef(new Map<number, { x: number; y: number }>());
  const singleTouchTapRef = useRef(new Map<number, { at: number; x: number; y: number; moved: boolean }>());
  const lastSingleFingerTapRef = useRef(0);
  // 그리기에 참여 중인 포인터의 마지막 화면 좌표. 두 번째 손가락이 오면 첫 손가락을
  // 이 좌표로 핀치 제스처에 승격시켜야 자연스러운 두 손가락 확대가 성립한다.
  const lastClientRef = useRef(new Map<number, { x: number; y: number }>());
  // 획 시작 시점의 도구·색·굵기. 획 도중 다른 손이 도구 버튼을 눌러도 커밋은 시작 시점 기준이다.
  const strokeMetaRef = useRef(new Map<number, StrokeMeta>());
  // 채우기는 눌렀을 때가 아니라 뗐을 때 커밋한다. 손바닥 다접촉이 각각 fill이 되는 사고 방지.
  const pendingFillRef = useRef<{
    pointerId: number;
    point: { x: number; y: number };
  } | null>(null);
  // 반투명 브러시(크레용·수채)의 라이브 미리보기용 스냅숏. 세그먼트를 겹쳐 그리면
  // 이음마다 알파가 중첩돼 커밋 결과보다 훨씬 진해 보이므로, 매 이동마다 복원 후 전체를 한 번에 그린다.
  // 반투명 획을 얇은 층에 그리는 중인지. 예전에는 여기에 캔버스 전체 ImageData를 들고 있었다.
  const liveStrokeRef = useRef(false);
  // 획 중에는 도화지가 움직이지 않는다. 이벤트마다 getBoundingClientRect를 부르지 않도록 시작 때 한 번 잡는다.
  const strokeRectRef = useRef<DOMRect | null>(null);
  const revisionRef = useRef(0);
  const initialized = useRef(false);
  const saveTimer = useRef<number | undefined>(undefined);
  const conflictDraftRef = useRef<QueuedArtworkDraft | null>(null);
  const completingRef = useRef(false);
  const documentStateRef = useRef(documentState);
  const currentStepRef = useRef(0);
  const loadingKeyRef = useRef<string | null>(null);
  const hydratedKeyRef = useRef<string | null>(null);
  const pendingSinceRef = useRef(0);
  const unsavedRef = useRef(false);
  const editSeqRef = useRef(0);
  const artworkRef = useRef<ArtworkPayload | null>(null);

  // 서버 로드나 충돌 초안 복구처럼 문서를 통째로 교체할 때, 이전 작품의 되돌리기/다시하기/
  // 전체 지우기 대기 상태가 그대로 남아 있으면 되돌리기가 새 작품 위에 이전 작품의 편집을
  // 되살릴 수 있다. 문서를 바꾸는 모든 지점에서 이 함수로 히스토리를 함께 초기화한다.
  function resetDocumentHistory() {
    redoRef.current = [];
    setRedo([]);
    clearedOpsRef.current = null;
    clearRedoReadyRef.current = false;
    setHasClearToUndo(false);
    setHasClearToRedo(false);
    setClearConfirmOpen(false);
  }

  const createOrLoad = useCallback(async () => {
    const loadKey = params.id === "new" ? `new:${search.toString()}` : params.id;
    if (loadingKeyRef.current === loadKey || hydratedKeyRef.current === loadKey) return;
    loadingKeyRef.current = loadKey;
    try {
      const profile = activeProfile();
      if (!profile) {
        location.replace("/join");
        return;
      }
      const artworkUrl = params.id === "new" ? undefined : `/api/artworks/${params.id}`;
      // 느린 서버 저장을 기다린 뒤 화면을 여는 대신, IndexedDB 초안을 먼저 읽어 즉시 복구하고
      // 네트워크 전송은 화면이 열린 뒤 별도로 수행한다. 초안이 있으면 자동 전송 중 편집이 섞이지
      // 않도록 기존 충돌/사본 흐름을 그대로 보여 준다.
      const localSaves = artworkUrl ? await queuedArtworkSaves(profile.studentId, artworkUrl).catch(() => []) : [];
      const localDisposition = artworkUrl ? resolveArtworkDraftDisposition(localSaves, artworkUrl, false) : { action: "load" as const };
      const restoredDraft = localDisposition.action === "recover" ? localDisposition.draft : null;
      if (params.id === "new") {
        const mode = lesson?.mode ?? (search.get("mode") === "free" ? "free" : "free");
        const title = lesson?.title ?? "내 마음 그림";
        const topic = lesson?.topic ?? "자유 창작";
        const clientArtworkId = `artwork_${crypto.randomUUID().replaceAll("-", "")}`;
        const response = await studentFetch("/api/artworks", {
          method: "POST",
          body: JSON.stringify({
            clientArtworkId,
            learningMode: mode,
            lessonSlug: lesson?.slug ?? null,
            title,
            topic,
            intent: lesson ? `${topic}을 보고 내 생각을 더한다.` : "내 마음대로 그리고 싶다.",
          }),
        });
        const data = (await response.json()) as {
          error?: string;
          artwork: ArtworkPayload;
        };
        if (!response.ok) throw new Error(data.error);
        hydratedKeyRef.current = loadKey;
        location.replace(`/student/draw/${data.artwork.id}`);
        return;
      }
      const response = await studentFetch(`/api/artworks/${encodeURIComponent(params.id)}`);
      const data = (await response.json()) as {
        error?: string;
        artwork: ArtworkPayload;
      };
      if (!response.ok) throw new Error(data.error);
      const loadDisposition = artworkUrl ? resolveArtworkDraftDisposition(localSaves, artworkUrl, data.artwork.status === "complete") : { action: "load" as const };
      if (loadDisposition.action === "archive") {
        hydratedKeyRef.current = loadKey;
        location.replace("/student");
        return;
      }
      const loadDraft = loadDisposition.action === "recover" ? loadDisposition.draft : restoredDraft;
      const loadedStep = loadDraft?.currentStep ?? data.artwork.currentStep;
      // 서버가 돌려준 문서를 정규화해 크기 추정이 상한으로 유지되게 한다.
      const loadedDocument = loadDraft?.document ?? validateDrawDocument(data.artwork.document);
      if (!loadedDocument) {
        // 검증에 실패한 문서를 편집 상태로 올리면 렌더가 깨지거나, 아이가 그린 뒤
        // 저장이 계속 거부된다. 빈 문서로 열면 자동 저장이 서버 원본을 덮어쓴다.
        // 그래서 아예 열지 않고 원본을 서버에 그대로 둔 채 도움을 요청하게 한다.
        hydratedKeyRef.current = loadKey;
        setSaveState("이 그림을 열지 못했어요. 선생님을 불러 주세요.");
        return;
      }
      currentStepRef.current = loadedStep;
      documentStateRef.current = loadedDocument;
      setArtwork({ ...data.artwork, currentStep: loadedStep });
      // 자동 몽그리 시계는 도화지를 열 때 처음부터 센다.
      openedAtRef.current = Date.now();
      lastStrokeAtRef.current = Date.now();
      autoGrimiCountRef.current = 0;
      lastAutoGrimiAtRef.current = 0;
      setDocumentState(loadedDocument);
      resetDocumentHistory();
      setEditVersion(0);
      conflictDraftRef.current = loadDraft;
      setConflictDraft(loadDraft);
      setConflictRevision(loadDraft?.save.conflictRevision ?? null);
      revisionRef.current = data.artwork.revision;
      initialized.current = true;
      hydratedKeyRef.current = loadKey;
      setSaveState(loadDraft ? (loadDraft.save.conflict ? "저장 충돌 초안을 복구했어요" : "전송을 기다리는 기기 초안을 복구했어요") : "저장됨");
      if (artworkUrl && !loadDraft) void flushSaves(profile.studentId, artworkUrl).catch(() => undefined);
    } finally {
      if (loadingKeyRef.current === loadKey) loadingKeyRef.current = null;
    }
  }, [lesson, params.id, search]);

  useEffect(() => {
    createOrLoad().catch((cause) => setSaveState(cause instanceof Error ? cause.message : "불러오지 못했어요"));
  }, [createOrLoad]);
  useEffect(() => {
    documentStateRef.current = documentState;
    if (canvasRef.current) renderDocument(canvasRef.current, documentState, rasterWidthRef.current);
  }, [documentState]);
  useEffect(() => {
    currentStepRef.current = artwork?.currentStep ?? 0;
    artworkRef.current = artwork;
  }, [artwork]);
  // 편집 표시는 effect가 아니라 편집이 일어나는 즉시(markEdited) 동기로 올린다.
  // effect는 저장 응답보다 늦게 돌 수 있어 미저장 표시를 놓친다.
  /* 자동 몽그리(2026-09-12 사용자 결정). 종전 원칙은 "아이가 부를 때만"이었지만,
   * 아이가 버튼을 먼저 찾는 일이 드물어 기능이 없는 것과 같았다. 그래서 몽그리가 먼저 말을 건다.
   * 대신 그리는 것을 막지 않는다 — 옆 패널로 열리고, 아이가 다시 그리기 시작하면 스스로 접힌다.
   * 뜨는 때와 뜨지 않는 때는 AUTO_GRIMI가 정본이다. */
  const AUTO_GRIMI = {
    minOps: 8,            // 도화지가 비었으면 확장할 것이 없다 — 무엇을 그릴지는 선생님 몫
    settleMs: 120_000,    // 자리 잡기 전에 말 걸지 않는다
    idleMs: 75_000,       // 손이 멈춘 뒤
    afterManualMs: 30_000,// 직접 부른 직후는 건너뛴다
    gapMs: 300_000,       // 자동끼리 최소 간격
    maxPerArtwork: 2,
    tickMs: 5_000,
  } as const;
  const lastStrokeAtRef = useRef(0);
  const openedAtRef = useRef(0);
  const lastManualGrimiAtRef = useRef(0);
  const lastAutoGrimiAtRef = useRef(0);
  const autoGrimiCountRef = useRef(0);
  const [autoGrimi, setAutoGrimi] = useState(false);
  const markEdited = useCallback(() => {
    editSeqRef.current += 1;
    unsavedRef.current = true;
    lastStrokeAtRef.current = Date.now();
  }, []);
  const currentGuideTraces = useMemo(() => guideTraces(lesson, artwork?.currentStep ?? 0, "none", artwork?.guideVariant ?? 0), [artwork?.currentStep, artwork?.guideVariant, lesson]);
  const currentLessonActivity = lesson?.steps[artwork?.currentStep ?? 0]?.activity;
  const lessonGuideAvailable = currentGuideTraces.length > 0;
  const currentLessonStepStatus = useMemo(
    () => lessonStepActionStatus(documentState.ops, lessonStepProgress, currentGuideTraces.length, currentLessonActivity),
    [currentGuideTraces.length, currentLessonActivity, documentState.ops, lessonStepProgress],
  );
  const guideSourceKey = lesson ? `lesson:${lesson.slug}:${artwork?.guideVariant ?? 0}:${artwork?.currentStep ?? 0}` : "none";
  const lessonArtworkId = artwork?.id;
  const lessonArtworkStep = artwork?.currentStep;

  useEffect(() => {
    if (!lessonArtworkId || lessonArtworkStep === undefined || !lesson) {
      setLessonStepProgress(null);
      setLessonStepPrompt(null);
      return;
    }
    const step = Math.min(lessonArtworkStep, lesson.steps.length - 1);
    const key = lessonStepStorageKey(lessonArtworkId, lesson.slug, step);
    let stored: LessonStepProgress | null = null;
    try {
      const raw = localStorage.getItem(key);
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      if (isLessonStepProgress(parsed)) stored = parsed;
    } catch {}
    const next = stored ?? {
      baseline: createLessonStepBaseline(documentStateRef.current.ops),
      completed: false,
      skipped: false,
    };
    if (!stored) {
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {}
    }
    setLessonStepProgress(next);
    setLessonStepPrompt(null);
  }, [lesson, lessonArtworkId, lessonArtworkStep]);

  useEffect(() => {
    if (currentLessonStepStatus.ready && lessonStepPrompt === "step-action") setLessonStepPrompt(null);
  }, [currentLessonStepStatus.ready, lessonStepPrompt]);
  const markCurrentGuideSeen = useCallback(() => {
    if (lesson?.stage !== 1 || guideSourceKey === "none") return;
    const profile = activeProfile();
    if (!profile) return;
    try {
      localStorage.setItem(`wiggle:guide-demo:v1:${profile.studentId}:${guideSourceKey}`, "seen");
    } catch {}
  }, [guideSourceKey, lesson?.stage]);
  const startGuideDemo = useCallback(() => {
    if (!lessonGuideAvailable) return;
    setGuidePracticeTried(false);
    setGuidePhase("demo");
    setGuideDemoRun((value) => value + 1);
  }, [lessonGuideAvailable]);
  const chooseIndependentDrawing = useCallback(() => {
    markCurrentGuideSeen();
    setGuidePhase("independent");
  }, [markCurrentGuideSeen]);
  const stopGuideDemoForPractice = useCallback(() => {
    markCurrentGuideSeen();
    setGuidePhase("practice");
  }, [markCurrentGuideSeen]);
  const chooseGuideHelp = useCallback(() => {
    const currentArtwork = artworkRef.current;
    if (currentArtwork) {
      try { localStorage.setItem(guideChoiceStorageKey(currentArtwork.id, currentArtwork.currentStep), "help"); } catch {}
    }
    setGuideChoiceOpen(false);
    startGuideDemo();
  }, [startGuideDemo]);
  const chooseGuideSolo = useCallback(() => {
    const currentArtwork = artworkRef.current;
    if (currentArtwork) {
      try { localStorage.setItem(guideChoiceStorageKey(currentArtwork.id, currentArtwork.currentStep), "solo"); } catch {}
    }
    setGuideChoiceOpen(false);
    chooseIndependentDrawing();
  }, [chooseIndependentDrawing]);

  useEffect(() => {
    if (currentLessonActivity === "color") {
      if (!colorModeActiveRef.current) {
        colorModeActiveRef.current = true;
        colorReturnBrushRef.current = lastBrushRef.current;
        colorReturnWidthRef.current = drawWidthRef.current;
      }
      // A traced outline can have tiny gaps, so bucket fill may flood the paper.
      // Start young children with a broad crayon; the bucket remains optional.
      setStudioTool("crayon");
      drawWidthRef.current = 48;
      setDrawWidth(48);
    } else if (colorModeActiveRef.current) {
      colorModeActiveRef.current = false;
      lastBrushRef.current = colorReturnBrushRef.current;
      setStudioTool(colorReturnBrushRef.current);
      drawWidthRef.current = colorReturnWidthRef.current;
      setDrawWidth(colorReturnWidthRef.current);
    }
  }, [currentLessonActivity]);

  useEffect(() => {
    setGuidePracticeTried(false);
    if (!lessonGuideAvailable) {
      setGuideChoiceOpen(false);
      setGuidePhase("independent");
      return;
    }
    const currentArtwork = artworkRef.current;
    if (!currentArtwork || currentLessonActivity === "color" || currentLessonStepStatus.actionCount > 0) {
      setGuideChoiceOpen(false);
      setGuidePhase("independent");
      return;
    }
    let choice = "";
    try {
      choice = localStorage.getItem(guideChoiceStorageKey(currentArtwork.id, currentArtwork.currentStep)) ?? "";
    } catch {}
    setGuideChoiceOpen(choice !== "help" && choice !== "solo");
    setGuidePhase(choice === "help" ? "practice" : "independent");
  }, [artwork?.currentStep, artwork?.id, currentLessonActivity, currentLessonStepStatus.actionCount, guideSourceKey, lessonGuideAvailable]);

  useEffect(() => {
    if (guideAnimationRef.current !== null) cancelAnimationFrame(guideAnimationRef.current);
    const canvas = guideRef.current;
    if (!canvas) return;
    if (guidePhase !== "demo") {
      renderGuideFrame(canvas, currentGuideTraces, guidePhase, 0, documentHeight(documentStateRef.current));
      return;
    }
    const motionPreference = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (motionPreference.matches) {
      renderGuideFrame(canvas, currentGuideTraces, "practice", 0, documentHeight(documentStateRef.current));
      markCurrentGuideSeen();
      setGuidePhase("practice");
      return;
    }
    const duration = Math.min(6800, 1600 + currentGuideTraces.length * 600);
    const startedAt = performance.now();
    const stopForReducedMotion = (event: MediaQueryListEvent) => {
      if (!event.matches) return;
      if (guideAnimationRef.current !== null) cancelAnimationFrame(guideAnimationRef.current);
      guideAnimationRef.current = null;
      renderGuideFrame(canvas, currentGuideTraces, "practice", 0, documentHeight(documentStateRef.current));
      markCurrentGuideSeen();
      setGuidePhase("practice");
    };
    motionPreference.addEventListener("change", stopForReducedMotion);
    const animate = (now: number) => {
      const linear = Math.min(1, (now - startedAt) / duration);
      const eased = 1 - (1 - linear) ** 3;
      renderGuideFrame(canvas, currentGuideTraces, "demo", eased, documentHeight(documentStateRef.current));
      if (linear < 1) {
        guideAnimationRef.current = requestAnimationFrame(animate);
        return;
      }
      guideAnimationRef.current = null;
      markCurrentGuideSeen();
      setGuidePhase("practice");
    };
    guideAnimationRef.current = requestAnimationFrame(animate);
    return () => {
      motionPreference.removeEventListener("change", stopForReducedMotion);
      if (guideAnimationRef.current !== null) cancelAnimationFrame(guideAnimationRef.current);
      guideAnimationRef.current = null;
    };
  }, [currentGuideTraces, guideDemoRun, guidePhase, markCurrentGuideSeen]);
  const visibleMark = teacherMark && teacherMark.artworkId === artwork?.id ? teacherMark : null;
  const markDocHeight = documentHeight(documentState);
  const markSpan = documentSpan(documentState);
  useEffect(() => {
    const canvas = markRef.current;
    if (!canvas) return;
    if (canvas.width !== DOCUMENT_SIZE) canvas.width = DOCUMENT_SIZE;
    if (canvas.height !== markDocHeight) canvas.height = markDocHeight;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    if (visibleMark) drawMarkStrokes(context, visibleMark.strokes, DOCUMENT_SIZE, markDocHeight, 0.9, 1 / markSpan);
  }, [visibleMark, markDocHeight, markSpan]);
  async function answerTeacherMark(answer: MarkAnswer) {
    if (!visibleMark) return;
    answeredMarkIds.current.add(visibleMark.id);
    const markId = visibleMark.id;
    setTeacherMark(null);
    await studentFetch("/api/student", { method: "POST", body: JSON.stringify({ action: "answerMark", markId, answer }) }).catch(() => undefined);
  }
  async function toggleHand() {
    if (handBusy) return;
    const next = !handRaised;
    setHandBusy(true); setHandRaised(next);
    try {
      const response = await studentFetch("/api/student", { method: "POST", body: JSON.stringify({ action: "raiseHand", raised: next }) });
      if (!response.ok) setHandRaised(!next);
      else pollFastRef.current = next || pollFastRef.current;
    } catch { setHandRaised(!next); }
    finally { setHandBusy(false); }
  }
  useEffect(() => {
    let polling = false;
    const poll = async () => {
      if (polling || document.visibilityState === "hidden") return;
      polling = true;
      try {
        const response = await studentFetch("/api/student");
        const data = (await response.json()) as {
          messages?: StudentTeacherMessage[];
          teacherViewing?: boolean;
          teacherMark?: { id: string; artworkId: string; strokes: MarkStroke[]; note: string } | null;
          handRaised?: boolean;
        };
        setTeacherMessages(data.messages ?? []);
        setTeacherViewing(Boolean(data.teacherViewing));
        teacherViewingRef.current = Boolean(data.teacherViewing);
        // 방금 답한 표시가 늦게 온 응답으로 다시 뜨지 않게 거른다.
        const mark = data.teacherMark && !answeredMarkIds.current.has(data.teacherMark.id) ? data.teacherMark : null;
        setTeacherMark(mark);
        setHandRaised(Boolean(data.handRaised));
        // 선생님이 보고 있거나 손을 든 동안은 표시가 빨리 닿도록 3초마다, 평소에는 8초마다 확인한다.
        pollFastRef.current = Boolean(data.teacherViewing || data.handRaised || mark);
      } catch {
        /* 다음 주기에 다시 확인한다 */
      } finally {
        polling = false;
      }
    };
    void poll();
    let tick = 0;
    const timer = window.setInterval(() => {
      tick += 1;
      if (pollFastRef.current ? tick % 3 === 0 : tick % 8 === 0) void poll();
    }, 1000);
    const visible = () => {
      if (document.visibilityState === "visible") void poll();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, []);
  // 공유 태블릿의 매 작품은 펜 모드로 새로 시작한다. 앞 학생이 손가락 모드를
  // 골랐더라도 다음 학생에게 손바닥 오입력 위험을 넘기지 않는다.
  useEffect(() => {
    penModeRef.current = true;
    setInputMode("pen");
    const syncDetectedPen = () => {
      penModeRef.current = true;
      setInputMode("pen");
    };
    window.addEventListener(INPUT_MODE_EVENT, syncDetectedPen);
    return () => window.removeEventListener(INPUT_MODE_EVENT, syncDetectedPen);
  }, []);

  useEffect(() => {
    if (!artwork) return;
    const key = `wiggle:lesson-choice:v1:${artwork.id}:${artwork.currentStep}`;
    try {
      setChildChoice(localStorage.getItem(key) ?? "");
    } catch {
      setChildChoice("");
    }
  }, [artwork]);

  useEffect(() => {
    const setup = CHOICE_DRAWING_SETUP[childChoice];
    if (!setup) return;
    setStudioTool(setup.tool);
    lastBrushRef.current = setup.tool;
    if (setup.color) setColor(setup.color);
    drawWidthRef.current = setup.width;
    setDrawWidth(setup.width);
  }, [childChoice]);

  function chooseChildChoice(choice: string) {
    setChildChoice(choice);
    if (!artwork) return;
    try {
      localStorage.setItem(`wiggle:lesson-choice:v1:${artwork.id}:${artwork.currentStep}`, choice);
    } catch {}
  }

  // savingEdit은 save() 호출 시점에 캡처해 넘긴다. 직렬 큐에서 실제 실행될 때 읽으면
  // 대기 중에 생긴 새 편집의 세대를 잡아, 그 편집까지 저장된 것으로 오인한다.
  const performSave = useCallback(
    async (nextDocument: DrawDocument, savingEdit: number, options?: SaveOptions) => {
      if (!artwork || !canvasRef.current) return false;
      const profile = activeProfile();
      if (!profile) return false;
      const preserveDraft = async (queued: Parameters<typeof queueSave>[0], message: string) => {
        const restored = queuedArtworkDraft(queued);
        if (restored) {
          conflictDraftRef.current = restored;
          setConflictDraft(restored);
          setConflictRevision(queued.conflictRevision ?? null);
          setEditVersion(0);
        }
        try {
          await queueSave(queued);
        } catch {
          setSaveState(`${message} 이 탭에서 계속 보관하고 있어요`);
          return;
        }
        setSaveState(message);
      };
      const existingDraft = conflictDraftRef.current;
      if (existingDraft) {
        if (options?.complete) {
          const requestId = mutationId();
          const previousTime = Date.parse(existingDraft.save.createdAt);
          const createdAt = new Date(Math.max(Date.now(), Number.isFinite(previousTime) ? previousTime + 1 : 0)).toISOString();
          const upgradedBody = JSON.stringify({
            ...(JSON.parse(existingDraft.save.body) as Record<string, unknown>),
            requestId,
            document: documentStateRef.current,
            currentStep: currentStepRef.current,
            thumbnailDataUrl: documentImage(documentStateRef.current, 256),
            complete: true,
            finalDataUrl: documentImage(documentStateRef.current, 1024),
            reflection: options.reflection,
          });
          await preserveDraft(
            {
              requestId,
              studentId: profile.studentId,
              url: existingDraft.save.url,
              body: upgradedBody,
              createdAt,
              branchId: saveBranchId,
              conflict: true,
              conflictRevision: existingDraft.save.conflictRevision,
            },
            "완성한 그림과 소감을 기기에 안전하게 보관했어요",
          );
        } else {
          setSaveState("먼저 보관한 그림을 새 사본으로 저장해 주세요");
        }
        return false;
      }
      const requestId = mutationId();
      const url = `/api/artworks/${artwork.id}`;
      const createdAt = new Date().toISOString();
      const body = JSON.stringify({
        requestId,
        expectedRevision: revisionRef.current,
        document: nextDocument,
        currentStep: options?.currentStep ?? artwork.currentStep,
        thumbnailDataUrl: documentImage(nextDocument, 256),
        complete: options?.complete ?? false,
        finalDataUrl: options?.complete ? documentImage(nextDocument, 1024) : undefined,
        reflection: options?.reflection,
      });
      setSaveState(navigator.onLine ? "저장 중…" : "기기에 보관 중");
      try {
        const response = await studentFetch(url, { method: "PUT", body });
        const data = (await response.json()) as {
          error?: string;
          serverRevision?: number;
          revision?: number;
        };
        if (response.status === 409) {
          const serverRevision = typeof data.serverRevision === "number" ? data.serverRevision : revisionRef.current;
          const conflictBody = JSON.stringify({
            ...(JSON.parse(body) as Record<string, unknown>),
            document: documentStateRef.current,
            currentStep: currentStepRef.current,
            thumbnailDataUrl: documentImage(documentStateRef.current, 256),
            finalDataUrl: options?.complete ? documentImage(documentStateRef.current, 1024) : undefined,
          });
          await preserveDraft(
            {
              requestId,
              studentId: profile.studentId,
              url,
              body: conflictBody,
              createdAt,
              branchId: saveBranchId,
              conflict: true,
              conflictRevision: serverRevision,
            },
            "다른 저장과 겹쳤어요",
          );
          return false;
        }
        if (response.status >= 400 && response.status < 500) {
          const queued = {
            requestId,
            studentId: profile.studentId,
            url,
            body,
            createdAt,
            branchId: saveBranchId,
          };
          if (options?.complete) await preserveDraft(queued, data.error ?? "완성한 그림을 기기에 안전하게 보관했어요");
          else {
            await queueSave(queued);
            setSaveState(data.error ?? "저장할 수 없어 기기에 보관했어요");
          }
          return false;
        }
        if (!response.ok) throw new Error(data.error);
        // 서버가 이미 반영했으므로 revision부터 확정한다. IndexedDB 정리는 부가 작업이라
        // 실패해도 커밋된 저장을 실패로 되돌리거나 낡은 revision을 남기면 안 된다.
        revisionRef.current = data.revision ?? revisionRef.current;
        // 이 저장이 담아 간 편집 세대가 그대로일 때만 "저장됨"이라고 말한다. 그 사이 더 그렸다면
        // 미저장 표시를 유지해야 이탈 시 기기 보관이 그 선을 지켜 준다.
        const stillCurrent = editSeqRef.current === savingEdit;
        if (stillCurrent) unsavedRef.current = false;
        if (stillCurrent || options?.complete) setSaveState(options?.complete ? "완성했어요" : "저장됨");
        try {
          await clearQueuedArtworkSaves(profile.studentId, url, "pending", { createdAt, requestId }, saveBranchId);
        } catch {
          /* 큐 정리는 다음 flush에서 다시 시도한다 */
        }
        return true;
      } catch {
        const queued = {
          requestId,
          studentId: profile.studentId,
          url,
          body,
          createdAt,
          branchId: saveBranchId,
        };
        if (options?.complete) await preserveDraft(queued, "완성한 그림을 기기에 안전하게 보관했어요");
        // IndexedDB를 못 열면 queueSave도 던진다. 그 예외가 밖으로 나가면 호출부의
        // 로딩 상태가 영구히 잠긴다(몽그리 호출이 다시 안 됨).
        else {
          try {
            await queueSave(queued);
            setSaveState("기기에 안전하게 보관됨");
          } catch {
            setSaveState("지금은 저장할 수 없어요. 인터넷을 확인해 주세요");
          }
        }
        return false;
      }
    },
    [artwork, saveBranchId],
  );
  // 문서와 편집 세대를 같은 동기 구간에서 함께 캡처한다. 인자를 생략하면 항상 최신 화면 문서를 쓴다.
  // 서버 응답을 기다린 뒤 렌더 시점의 documentState를 넘기면 그사이 그린 선이 되돌려진다.
  const save = useCallback(
    (nextDocument?: DrawDocument, options?: SaveOptions) => {
      const savingEdit = editSeqRef.current;
      return runSerial(() => performSave(nextDocument ?? documentStateRef.current, savingEdit, options));
    },
    [performSave, runSerial],
  );

  useEffect(() => {
    if (!initialized.current || !artwork || editVersion === 0 || conflictDraft || completingRef.current) {
      pendingSinceRef.current = 0;
      return;
    }
    window.clearTimeout(saveTimer.current);
    setSaveState("그리는 중…");
    // 선을 1.5초보다 촘촘히 이어 그리면 디바운스가 계속 미뤄져 저장이 한 번도 일어나지 않는다.
    // 최초 미저장 편집 시각부터 최대 대기 시간을 두어 상한을 강제한다.
    if (!pendingSinceRef.current) pendingSinceRef.current = Date.now();
    const waited = Date.now() - pendingSinceRef.current;
    const watched = teacherViewingRef.current;
    const debounce = watched ? WATCHED_AUTOSAVE_DEBOUNCE_MS : AUTOSAVE_DEBOUNCE_MS;
    const maxWait = watched ? WATCHED_AUTOSAVE_MAX_WAIT_MS : AUTOSAVE_MAX_WAIT_MS;
    const delay = Math.max(0, Math.min(debounce, maxWait - waited));
    saveTimer.current = window.setTimeout(() => {
      pendingSinceRef.current = 0;
      void save(documentState, { currentStep: artwork.currentStep });
    }, delay);
    return () => window.clearTimeout(saveTimer.current);
  }, [artwork, conflictDraft, documentState, editVersion, save]);

  // 아이가 나가기를 누르거나 탭이 숨겨질 때, 아직 서버에 못 보낸 그림을 기기에 보관한다.
  // 이 경로가 없으면 마지막 저장 이후의 선이 서버에도 IndexedDB에도 남지 않는다.
  const preserveUnsavedOnExit = useCallback(() => {
    if (!artworkRef.current || !unsavedRef.current || conflictDraftRef.current || completingRef.current) return;
    const profile = activeProfile();
    if (!profile) return;
    const url = `/api/artworks/${artworkRef.current.id}`;
    const requestId = mutationId();
    const body = JSON.stringify({
      requestId,
      expectedRevision: revisionRef.current,
      document: documentStateRef.current,
      currentStep: currentStepRef.current,
      complete: false,
    });
    void queueSave({
      requestId,
      studentId: profile.studentId,
      url,
      body,
      createdAt: new Date().toISOString(),
      branchId: saveBranchId,
    }).catch(() => undefined);
  }, [saveBranchId]);
  useEffect(() => {
    const onHide = () => preserveUnsavedOnExit();
    const onVisibility = () => {
      if (document.visibilityState === "hidden") preserveUnsavedOnExit();
    };
    window.addEventListener("pagehide", onHide);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", onHide);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [preserveUnsavedOnExit]);

  const canvasFull = useMemo(() => documentTooLarge(documentState), [documentState]);
  const textObjects = useMemo(() => activeTextObjects(documentState.ops), [documentState.ops]);
  const selectedText = useMemo(() => textObjects.find((op) => op.textObjectId === selectedTextObjectId) ?? null, [selectedTextObjectId, textObjects]);
  // 되돌리기·채우기로 더는 옮길 수 없게 된 물건은 여기서 빠지므로 선택 테두리도 함께 사라진다.
  const selectedObject = useMemo(() => (selectedObjectKey ? movableDrawObjects(documentState.ops).find((op) => drawObjectKey(op) === selectedObjectKey) ?? null : null), [selectedObjectKey, documentState.ops]);
  const selectedObjectBox = useMemo(() => {
    if (!selectedObject?.points) return null;
    const resized = objectScale ? { ...selectedObject, ...scaleDrawObject(selectedObject, objectScale, documentSpan(documentState)) } : selectedObject;
    return drawObjectBounds({ ...resized, points: shiftDrawPoints(resized.points ?? selectedObject.points, objectDrag?.dx ?? 0, objectDrag?.dy ?? 0) }, documentHeight(documentState));
  }, [selectedObject, objectDrag, objectScale, documentState]);
  const reflectionDialogRef = useRef<HTMLDivElement>(null);
  // 소감을 닫으면 몽그리 짐작도 함께 접는다. 남겨 두면 다시 열었을 때
  // 지금 그림과 맞지 않는 옛 짐작이 그대로 보인다.
  const closeReflection = useCallback(() => {
    // 저장 중에는 아무것도 건드리지 않는다. 여기서 초기화하면 저장이 도는 동안
    // 아이가 쓴 이야기 한 줄이 화면에서 사라진다.
    if (completionState === "saving") return;
    setInterpretation(null);
    setStoryText("");
    setReflectionOpen(false);
  }, [completionState]);
  useModalDialog(reflectionDialogRef, closeReflection, reflectionOpen);
  const textDialogRef = useRef<HTMLDivElement>(null);
  const closeTextComposer = useCallback(() => {
    setTextComposerOpen(false);
    setEditingTextObjectId(null);
  }, []);
  useModalDialog(textDialogRef, closeTextComposer, textComposerOpen);
  const closeClearConfirm = useCallback(() => setClearConfirmOpen(false), []);
  useModalDialog(clearConfirmDialogRef, closeClearConfirm, clearConfirmOpen);
  const artworkId = artwork?.id;
  const flushCurrentArtwork = useCallback(() => {
    if (!artworkId) return;
    const url = `/api/artworks/${artworkId}`;
    void runSerial(async () => {
      const profile = activeProfile();
      if (!profile) return;
      try {
        const flushed = await flushSaves(profile.studentId, url);
        const disposition = resolveArtworkDraftDisposition(flushed.remaining, url, flushed.completedUrls.includes(url));
        if (disposition.action === "archive") {
          conflictDraftRef.current = null;
          setConflictDraft(null);
          setConflictRevision(null);
          location.replace("/student");
          return;
        }
        const latestRevision = flushed.latestRevisions[url];
        if (typeof latestRevision === "number") revisionRef.current = latestRevision;
        const restored = disposition.action === "recover" ? disposition.draft : null;
        if (restored) {
          // 큐에 들어가기 전에 그린 선이 화면에 남아 있으면, 복구 초안으로 덮으면 그 선이 사라진다.
          // 화면의 최신 문서를 그대로 두고 그 내용을 충돌 초안 본문에 반영해 보관한다.
          const keepLocalEdits = unsavedRef.current;
          const draft: QueuedArtworkDraft = keepLocalEdits
            ? {
                ...restored,
                document: documentStateRef.current,
                currentStep: currentStepRef.current,
                save: {
                  ...restored.save,
                  body: JSON.stringify({
                    ...(JSON.parse(restored.save.body) as Record<string, unknown>),
                    document: documentStateRef.current,
                    currentStep: currentStepRef.current,
                  }),
                },
              }
            : restored;
          if (keepLocalEdits) await queueSave(draft.save).catch(() => undefined);
          conflictDraftRef.current = draft;
          setConflictDraft(draft);
          setConflictRevision(draft.save.conflictRevision ?? null);
          if (!keepLocalEdits) {
            documentStateRef.current = draft.document;
            currentStepRef.current = draft.currentStep;
            setDocumentState(draft.document);
            resetDocumentHistory();
            setEditVersion(0);
            setGuidePhase("independent");
            setArtwork((current) => (current ? { ...current, currentStep: draft.currentStep } : current));
          }
          setSaveState(draft.save.conflict ? "저장 충돌 초안을 복구했어요" : "기기 초안의 전송을 기다리고 있어요");
        } else if (flushed.flushed > 0) {
          conflictDraftRef.current = null;
          setConflictDraft(null);
          setConflictRevision(null);
          setSaveState("저장됨");
        }
      } catch {
        setSaveState("기기에 안전하게 보관 중");
      }
    });
  }, [artworkId, runSerial]);
  useEffect(() => {
    if (!artworkId) return;
    window.addEventListener("online", flushCurrentArtwork);
    return () => window.removeEventListener("online", flushCurrentArtwork);
  }, [artworkId, flushCurrentArtwork]);

  function pointFromRect(rect: DOMRect, clientX: number, clientY: number, pressure: number) {
    return {
      x: roundUnit(Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))),
      y: roundUnit(Math.max(0, Math.min(1, (clientY - rect.top) / rect.height))),
      pressure: roundUnit(pressure || 0.5),
    };
  }
  function canvasPoint(event: ReactPointerEvent<HTMLCanvasElement>) {
    // 획 중에는 도화지가 움직이지 않는다. 시작 때 잡아 둔 사각형을 쓰면 이벤트마다 레이아웃을 읽지 않는다.
    const rect = strokeRectRef.current ?? event.currentTarget.getBoundingClientRect();
    return pointFromRect(rect, event.clientX, event.clientY, event.pressure);
  }
  /* 애플 펜슬은 초당 240번 좌표를 보내는데 pointermove는 화면 주사율(60Hz)로만 온다.
   * 나머지 표본은 getCoalescedEvents에 담겨 오므로, 이것을 읽지 않으면 점을 버리게 되고
   * 빠르게 그을수록 선이 펜 뒤에 처지고 모서리가 잘린다. 사파리도 지원한다.
   * 예측 점(getPredictedEvents)은 사파리에 없어 쓰지 않는다. */
  function movePoints(event: ReactPointerEvent<HTMLCanvasElement>) {
    const rect = strokeRectRef.current ?? event.currentTarget.getBoundingClientRect();
    const native = event.nativeEvent;
    const coalesced = typeof native.getCoalescedEvents === "function" ? native.getCoalescedEvents() : [];
    const samples = coalesced.length ? coalesced : [native];
    return samples.map((sample) => pointFromRect(rect, sample.clientX, sample.clientY, sample.pressure));
  }
  function canvasPointFromClient(clientX: number, clientY: number) {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return {
      x: roundUnit(Math.max(0.04, Math.min(0.96, (clientX - rect.left) / rect.width))),
      y: roundUnit(Math.max(0.04, Math.min(0.96, (clientY - rect.top) / rect.height))),
    };
  }
  // 옮기기 도구로 도화지를 누르면 그 자리의 맨 위 도형·스티커를 고른다. 손끝 오차만큼 상자를 넓혀 잡는다.
  function selectObjectAt(point: { x: number; y: number }) {
    const height = documentHeight(documentStateRef.current);
    const hit = (op: DrawOp) => {
      const box = drawObjectBounds(op, height);
      return Boolean(box && point.x >= box.x - 0.015 && point.x <= box.x + box.width + 0.015 && point.y >= box.y - 0.015 && point.y <= box.y + box.height + 0.015);
    };
    const target = movableDrawObjects(documentStateRef.current.ops).findLast(hit);
    setObjectDrag(null);
    setSelectedObjectKey(target ? drawObjectKey(target) ?? null : null);
    if (target) setSaveState("골랐어요. 테두리를 끌어서 옮겨요");
    else if (visibleDrawOperations(documentStateRef.current.ops).some((op) => (op.type === "shape" || op.type === "sticker") && hit(op))) setSaveState("색을 채우기 전에 그린 것은 옮길 수 없어요");
    else setSaveState("옮길 도형이나 스티커를 눌러요");
  }
  function updateDrawObject(current: DrawOp, changes: Partial<Pick<DrawOp, "points" | "fontSize" | "deleted">>) {
    const key = current.objectId ?? current.opId;
    const operationId = newOperationId();
    return commitOps([{ ...current, ...changes, objectId: key, opId: `op_${operationId}`, clientOpId: `client_${operationId}`, at: new Date().toISOString() }]);
  }
  function objectDragDelta(event: ReactPointerEvent<HTMLButtonElement>) {
    const drag = objectDragRef.current;
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!drag || !rect) return null;
    return { dx: (event.clientX - drag.startX) / rect.width, dy: (event.clientY - drag.startY) / rect.height };
  }
  function startObjectDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    if (!selectedObject || conflictDraftRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    objectDragRef.current = { pointerId: event.pointerId, moved: false, startX: event.clientX, startY: event.clientY };
  }
  function moveObjectDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    const drag = objectDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) >= 5) drag.moved = true;
    if (drag.moved) setObjectDrag(objectDragDelta(event));
  }
  function finishObjectDrag(event: ReactPointerEvent<HTMLButtonElement>, commit: boolean) {
    const drag = objectDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const delta = objectDragDelta(event);
    objectDragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setObjectDrag(null);
    if (commit && drag.moved && delta && selectedObject?.points && updateDrawObject(selectedObject, { points: shiftDrawPoints(selectedObject.points, delta.dx, delta.dy) })) setSaveState("옮겼어요");
  }
  // 크기 손잡이: 물건 가운데에서 손끝까지의 거리가 처음의 몇 배가 됐는지가 곧 배율이다.
  function objectResizeFactor(event: ReactPointerEvent<HTMLButtonElement>) {
    const resize = objectResizeRef.current;
    return resize ? Math.hypot(event.clientX - resize.centerX, event.clientY - resize.centerY) / resize.startDistance : null;
  }
  function startObjectResize(event: ReactPointerEvent<HTMLButtonElement>) {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!selectedObject || !selectedObjectBox || !rect || conflictDraftRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    const centerX = rect.left + (selectedObjectBox.x + selectedObjectBox.width / 2) * rect.width;
    const centerY = rect.top + (selectedObjectBox.y + selectedObjectBox.height / 2) * rect.height;
    const startDistance = Math.hypot(event.clientX - centerX, event.clientY - centerY);
    if (startDistance < 1) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    objectResizeRef.current = { pointerId: event.pointerId, centerX, centerY, startDistance };
  }
  function moveObjectResize(event: ReactPointerEvent<HTMLButtonElement>) {
    if (objectResizeRef.current?.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    setObjectScale(objectResizeFactor(event));
  }
  function finishObjectResize(event: ReactPointerEvent<HTMLButtonElement>, commit: boolean) {
    if (objectResizeRef.current?.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const factor = objectResizeFactor(event);
    objectResizeRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setObjectScale(null);
    if (!commit || !factor || !selectedObject || Math.abs(factor - 1) < 0.03) return;
    if (updateDrawObject(selectedObject, scaleDrawObject(selectedObject, factor, documentSpan(documentStateRef.current)))) setSaveState("크기를 바꿨어요");
  }
  function startTextDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    if (!selectedText || conflictDraftRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    textDragRef.current = { pointerId: event.pointerId, moved: false, startX: event.clientX, startY: event.clientY };
    setTextDragPoint(selectedText.points[0]);
  }
  function moveTextDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    const drag = textDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) >= 5) drag.moved = true;
    const point = canvasPointFromClient(event.clientX, event.clientY);
    if (point && selectedText?.textKind) setTextDragPoint(clampTextPlacement(point, selectedText.textKind));
  }
  function finishTextDrag(event: ReactPointerEvent<HTMLButtonElement>, commit: boolean) {
    const drag = textDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    textDragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const current = activeTextObjects(documentStateRef.current.ops).find((op) => op.textObjectId === selectedTextObjectId);
    const rawPoint = canvasPointFromClient(event.clientX, event.clientY) ?? textDragPoint;
    const point = rawPoint && current?.textKind ? clampTextPlacement(rawPoint, current.textKind) : rawPoint;
    setTextDragPoint(null);
    if (commit && drag.moved && point && current && updateTextObject(current, { points: [point] })) setSaveState("글씨를 옮겼어요");
  }
  // 화면에서 고르는 굵기는 "100%일 때의 픽셀"이고, 저장은 도화지 단위다(넓은 도화지는 span배).
  const width = studioTool === "eraser" ? eraserWidth : drawWidth;
  const documentWidthUnits = (screenWidth: number) => toDocumentUnits(screenWidth, documentSpan(documentStateRef.current));
  function hideEraserFootprint() {
    if (eraserFootprintRef.current) eraserFootprintRef.current.hidden = true;
  }
  function updateEraserFootprint(event: ReactPointerEvent<HTMLCanvasElement>, pressed = false) {
    const footprint = eraserFootprintRef.current;
    if (!footprint || studioTool !== "eraser") {
      hideEraserFootprint();
      return;
    }
    const point = canvasPoint(event);
    footprint.hidden = false;
    footprint.style.left = `${point.x * 100}%`;
    footprint.style.top = `${point.y * 100}%`;
    // 가로 도화지에서는 가로 %와 세로 %가 다른 픽셀이 된다 — 가로 기준 폭 + aspect-ratio로 정사각을 지킨다.
    // %는 도화지(span장 너비) 기준이므로 화면 굵기를 그대로 쓰면 안 된다 — 실제로 지워지는 칸은
    // 저장 단위(굵기÷span)라, 그대로 두면 새 도화지(span 3)에서 네모만 3배로 커진다.
    footprint.style.width = `${documentWidthUnits(eraserWidth) / 10.24}%`;
    footprint.style.height = "auto";
    footprint.dataset.pressed = pressed ? "true" : "false";
  }
  function clearShapeStart() {
    shapeStartRef.current = null;
    setShapeStartPoint(null);
  }
  function clampText(value: string, kind: TextKind) {
    const normalized = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ");
    return drawingTextGraphemes(normalized).slice(0, MAX_TEXT_GRAPHEMES[kind]).join("");
  }
  function openTextComposer(target?: DrawOp | null) {
    if (target?.type === "text" && target.textObjectId && target.text && target.textKind && target.fontSize) {
      setTextDraft(target.text);
      setTextKind(target.textKind);
      setTextSize(toScreenUnits(target.fontSize, span) as TextSize);
      if (target.color) setColor(target.color);
      setEditingTextObjectId(target.textObjectId);
    } else {
      setTextDraft("");
      setTextKind("label");
      setTextSize(64);
      setEditingTextObjectId(null);
    }
    setTextComposerOpen(true);
  }
  function submitTextComposer() {
    const text = normalizeDrawingText(clampText(textDraft, textKind));
    if (!text) return;
    const editing = editingTextObjectId ? textObjects.find((op) => op.textObjectId === editingTextObjectId) : null;
    if (editing) {
      updateTextObject(editing, { text, textKind, fontSize: documentWidthUnits(textSize) });
      setTextComposerOpen(false);
      setEditingTextObjectId(null);
      setSaveState("글씨를 바꿨어요");
      return;
    }
    if (textObjects.length >= MAX_TEXT_OBJECTS) {
      setSaveState(`글씨는 한 그림에 ${MAX_TEXT_OBJECTS}개까지 넣을 수 있어요`);
      return;
    }
    setPendingText({ text, textKind, fontSize: textSize, color });
    setSelectedTextObjectId(null);
    setStudioTool("text");
    setTextComposerOpen(false);
    setEditingTextObjectId(null);
    setSaveState("글씨를 놓을 곳을 도화지에서 콕 눌러 주세요");
  }
  function placeTextInSuggestedSpot() {
    const text = normalizeDrawingText(clampText(textDraft, textKind));
    if (!text || editingTextObjectId || textObjects.length >= MAX_TEXT_OBJECTS) return;
    const next: PendingText = { text, textKind, fontSize: textSize, color };
    setStudioTool("text");
    setTextComposerOpen(false);
    setEditingTextObjectId(null);
    if (!commitText(suggestTextPlacement(documentStateRef.current.ops, textKind), next)) {
      setSaveState("빈 곳에 글씨를 놓지 못했어요. 종이의 저장 공간을 확인해 주세요");
    }
  }
  function pickColor(value: string) {
    setColor(value);
    if (studioTool === "text" && selectedText) updateTextObject(selectedText, { color: value });
    if (studioTool === "text" && pendingText) setPendingText({ ...pendingText, color: value });
    if (studioTool === "eraser") chooseStudioTool(lastBrushRef.current);
  }
  function chooseStudioTool(next: StudioTool) {
    // 시안: 이미 고른 도구를 다시 누르면 그 위에 굵기 5단이 뜨고,
    // 다른 도구를 누르면 닫힌다. 화면 바깥 누름은 아래 pointerdown 감시가 닫는다.
    setWidthSliderOpen(next === studioTool && !widthSliderOpen);
    setPaletteOpen(false);
    // 도형·글씨는 더보기 안에서 모양·글씨 옵션을 이어서 고르므로 창을 열어 둔다. 붓·지우개·채우기는 닫는다.
    if (next !== studioTool && next !== "shape" && next !== "text" && next !== "sticker") setToolSheetOpen(false);
    setStudioTool(next);
    if (next !== "eraser") hideEraserFootprint();
    if (next === "pencil" || next === "crayon" || next === "marker" || next === "watercolor") lastBrushRef.current = next;
    if (next !== "shape") clearShapeStart();
    if (next !== "move") {
      setSelectedObjectKey(null);
      setObjectDrag(null);
      setObjectScale(null);
    }
    if (next !== "text") {
      setPendingText(null);
      setSelectedTextObjectId(null);
      setTextDragPoint(null);
    }
  }
  useEffect(() => {
    if (!widthSliderOpen && !toolSheetOpen && !paletteOpen) return;
    function closeOnOutside(event: PointerEvent) {
      const target = event.target as Element | null;
      if (target?.closest(".dock-tools, .dock-sheet, .dock-more, .dock-colors")) return;
      setWidthSliderOpen(false);
      setToolSheetOpen(false);
      setPaletteOpen(false);
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setWidthSliderOpen(false);
      setToolSheetOpen(false);
      setPaletteOpen(false);
    }
    window.addEventListener("pointerdown", closeOnOutside, true);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOnOutside, true);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [widthSliderOpen, toolSheetOpen, paletteOpen]);

  /* 시안의 도화지는 화면을 가득 채운다. 아직 아무것도 그리지 않은 새 작품이면 화면 비율에
   * 맞춰 도화지 세로를 정한다. 한 획이라도 그은 뒤에는 절대 바꾸지 않는다 — 좌표가 0~1로
   * 정규화돼 있어 비율을 바꾸면 이미 그린 선이 늘어난다. */
  useEffect(() => {
    const zone = canvasZoneRef.current;
    if (!zone) return;
    function fitPaperToScreen() {
      const current = documentStateRef.current;
      if (!current) return;
      const style = window.getComputedStyle(zone!);
      const width = zone!.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight);
      const height = zone!.clientHeight - Number.parseFloat(style.paddingTop) - Number.parseFloat(style.paddingBottom);
      if (!(width >= 1) || !(height >= 1)) return;
      const next = clampDocumentHeight(DOCUMENT_SIZE * height / width);
      const from = documentHeight(current);
      // 새 작품은 화면 비율에 맞추면서 넓은 도화지(span)를 함께 붙인다 — 100%에서 화면 한 장이고,
      // 축소하면 그만큼 빈 종이가 더 나타난다(2026-09-20 사용자 결정 2번 안).
      const needsSpan = !current.ops.length && current.span === undefined;
      if (next === from && !needsSpan) return;
      if (!current.ops.length) {
        const fitted = { ...current, height: next, span: NEW_DOCUMENT_SPAN };
        documentStateRef.current = fitted;
        setDocumentState(fitted);
        return;
      }
      /* 이미 그린 그림(2026-09-15 사용자: "도화지 크기는 화면을 꽉채우지 안 잖아"): 화면이 도화지보다 세로로 길면
       * 그림을 가운데 둔 채 위아래로 종이를 덧대 채운다. 화면이 더 넓은 쪽(기기를 눕힘)은 그림을 줄이거나 잘라야 해
       * 가운데 놓아 둔다. 긋는 중·완성·저장 충돌 중에는 좌표를 바꾸지 않는다. */
      if (next < from || activePoints.current.size || artworkRef.current?.status === "complete" || conflictDraftRef.current) return;
      const grown = { ...current, height: next, ops: growDrawOps(current.ops, from, next) };
      redoRef.current = redoRef.current.map((group) => growDrawOps(group, from, next));
      if (clearedOpsRef.current) clearedOpsRef.current = growDrawOps(clearedOpsRef.current, from, next);
      editSeqRef.current += 1;
      unsavedRef.current = true;
      documentStateRef.current = grown;
      setRedo(redoRef.current);
      setDocumentState(grown);
      setEditVersion((value) => value + 1);
    }
    fitPaperToScreen();
    const observer = new ResizeObserver(fitPaperToScreen);
    observer.observe(zone);
    return () => observer.disconnect();
  }, [artwork?.id, documentState.ops.length]);

  /* 틀 크기를 재고, 틀이나 종이 크기가 바뀌면 지금 확대·이동을 새 크기 안에 다시 가둔다. */
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const measure = () => setFrame((current) => (current.width === wrap.clientWidth && current.height === wrap.clientHeight ? current : { width: wrap.clientWidth, height: wrap.clientHeight }));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(wrap);
    return () => observer.disconnect();
  }, [artwork?.id]);
  const span = documentSpan(documentState);
  const screenPaper = coverPaper(frame.width, frame.height, documentHeight(documentState));
  // 도화지는 100%에서 화면 span장 너비다. 1/span이면 도화지 전체가 틀에 맞고,
  // 거기서 한 칸 더 줄이면 종이 끝과 그 바깥 바탕까지 보인다(2026-09-23 사용자 요청).
  const paper = { width: screenPaper.width * span, height: screenPaper.height * span };
  scaleLimitsRef.current = useMemo(() => ({ min: minScaleFor(span), max: MAX_SCALE }), [span]);
  // 화면에 보이는 도화지 크기(배율 포함)에 맞춰 래스터를 잡는다. 바뀌면 아래 effect가 다시 그린다.
  const rasterWidth = rasterWidthFor(paper.width * view.scale, documentHeight(documentState));
  rasterWidthRef.current = rasterWidth;
  // 배율이 바뀌면 그만큼 더 촘촘한 래스터로 다시 그린다(확대해도 선이 뭉개지지 않게).
  useEffect(() => {
    if (canvasRef.current) renderDocument(canvasRef.current, documentStateRef.current, rasterWidth);
  }, [rasterWidth]);
  viewBoxRef.current = [frame.width || 1, frame.height || 1, paper.width || 1, paper.height || 1];
  // 틀이나 종이 크기가 바뀌면(화면 회전·도화지 늘림) 1배로 돌아가 종이 가운데를 보여 준다.
  useEffect(() => {
    const next = fitView();
    if (next.x === viewRef.current.x && next.y === viewRef.current.y && next.scale === viewRef.current.scale) return;
    viewRef.current = next;
    setView(next);
  }, [frame.width, frame.height, paper.width, paper.height]);

  /* 트랙패드·마우스: 두 손가락 벌리기(ctrl+휠)는 커서 자리를 붙잡고 확대·축소, 확대했거나 종이가 틀보다 길면 스크롤은 도화지 옮기기.
   * React onWheel은 passive라 브라우저 페이지 확대를 막지 못해 직접 붙인다. */
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    function onWheel(event: WheelEvent) {
      const rect = wrap!.getBoundingClientRect();
      const current = viewRef.current;
      const unit = event.deltaMode === 1 ? 16 : 1;
      let next: CanvasView;
      const box = viewBoxRef.current;
      const overflows = box[2] > box[0] + 1 || box[3] > box[1] + 1;
      if (event.ctrlKey || event.metaKey) next = zoomView(current, current.scale * Math.exp(-event.deltaY * unit * 0.01), { x: event.clientX - rect.left, y: event.clientY - rect.top }, ...box);
      else if (current.scale > 1.001 || overflows) next = clampView({ ...current, x: current.x - event.deltaX * unit, y: current.y - event.deltaY * unit }, ...box);
      else return;
      event.preventDefault();
      viewRef.current = next;
      setView(next);
    }
    wrap.addEventListener("wheel", onWheel, { passive: false });
    return () => wrap.removeEventListener("wheel", onWheel);
  }, [artwork?.id]);

  function chooseWidth(next: number) {
    const value = Math.min(STROKE_WIDTH_SCREEN_MAX, Math.max(STROKE_WIDTH_MIN, Math.round(next)));
    if (studioTool === "eraser") setEraserWidth(value);
    else {
      drawWidthRef.current = value;
      setDrawWidth(value);
    }
  }
  function enablePenMode() {
    penModeRef.current = true;
    setInputMode("pen");
  }
  // 공유 기기에서 펜을 잃어버려도 손가락으로 그릴 수 있어야 한다. 펜이 다시 닿으면
  // pointerDown에서 자동으로 재활성화되므로 해제해도 손바닥 안전은 유지된다.
  function disablePenMode() {
    penModeRef.current = false;
    setInputMode("finger");
  }
  // 1배. 종이가 틀보다 길면 가운데가 보이게 둔다(그림은 늘릴 때 가운데에 놓인다).
  function fitView(scale = 1) {
    const [frameWidth, frameHeight, paperWidth, paperHeight] = viewBoxRef.current;
    const bounds = contentBounds(documentStateRef.current);
    const center = bounds
      ? { x: (bounds.x + bounds.width / 2) * paperWidth * scale, y: (bounds.y + bounds.height / 2) * paperHeight * scale }
      : { x: paperWidth * scale / 2, y: paperHeight * scale / 2 };
    return clampView({ scale, x: frameWidth / 2 - center.x, y: frameHeight / 2 - center.y }, frameWidth, frameHeight, paperWidth, paperHeight, scaleLimitsRef.current);
  }
  function resetViewToFit() {
    const next = fitView();
    viewRef.current = next;
    setView(next);
  }
  // 확대·축소 단추는 도화지 가운데를 붙잡고 1.5배씩 움직인다. 바닥은 도화지 전체보다 한 칸 더 작은 배율이다.
  function zoomBy(factor: number) {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    const next = zoomView(viewRef.current, viewRef.current.scale * factor, { x: rect.width / 2, y: rect.height / 2 }, ...viewBoxRef.current, scaleLimitsRef.current);
    viewRef.current = next;
    setView(next);
  }
  function newOperationId() {
    return crypto.randomUUID().replaceAll("-", "");
  }
  // 한 스트로크만으로도 서버 한도(직렬화 1.25MB, ops 5000)를 넘길 수 있다.
  // 넘길 만큼 길면 들어갈 수 있는 데까지만 남기고 그리기를 멈춘다.
  // 대칭이 켜져 있으면 같은 획이 두 벌 저장되므로 예산을 벌 수로 나눈다.
  function fitStrokePoints(points: Array<{ x: number; y: number; pressure: number }>, copies: number) {
    const budget = Math.floor((DOCUMENT_BYTES_WARN - estimateDocumentBytes(documentStateRef.current)) / copies);
    if (budget <= 0 || estimateStrokeBytes(0) >= budget) return [];
    if (estimateStrokeBytes(points.length) <= budget) return points;
    const allowed = Math.floor((budget - estimateStrokeBytes(0)) / (estimateStrokeBytes(1) - estimateStrokeBytes(0)));
    return points.slice(0, Math.max(0, allowed));
  }
  // 함께 커밋된 묶음(대칭 쌍)은 한 번의 편집이다. 되돌리기도 lib/symmetry의 쌍 규칙으로 함께 지워진다.
  function commitOps(ops: DrawOp[]) {
    if (documentStateRef.current.ops.length + ops.length > OPS_WARN_THRESHOLD) return false;
    const nextDocument = {
      ...documentStateRef.current,
      ops: [...documentStateRef.current.ops, ...ops],
    };
    if (estimateDocumentBytes(nextDocument) >= DOCUMENT_BYTES_WARN) return false;
    markEdited();
    documentStateRef.current = nextDocument;
    setDocumentState(documentStateRef.current);
    redoRef.current = [];
    setRedo([]);
    // 새 편집은 지우기 되돌리기/다시하기 대기 상태도 무효화한다 — 이미 지나간 지우기다.
    clearedOpsRef.current = null;
    clearRedoReadyRef.current = false;
    setHasClearToUndo(false);
    setHasClearToRedo(false);
    setEditVersion((value) => value + 1);
    return true;
  }
  // 전체 지우기는 원본 작품 레코드나 서버 메타데이터를 건드리지 않고 op 배열만 비운다.
  // 되돌리기/다시하기 버튼과 그대로 맞물리는 한 번의 원자적 편집이다.
  function clearAllOps() {
    if (conflictDraftRef.current) return;
    if (!documentStateRef.current.ops.length) return;
    clearShapeStart();
    const next = clearAllDrawing({
      document: documentStateRef.current,
      redo: redoRef.current,
      clearedOps: clearedOpsRef.current,
      clearRedoReady: clearRedoReadyRef.current,
    });
    if (next.document === documentStateRef.current) return;
    markEdited();
    documentStateRef.current = next.document;
    redoRef.current = next.redo;
    clearedOpsRef.current = next.clearedOps ?? null;
    clearRedoReadyRef.current = Boolean(next.clearRedoReady);
    setDocumentState(next.document);
    setRedo(next.redo);
    setHasClearToUndo(Boolean(next.clearedOps));
    setHasClearToRedo(Boolean(next.clearRedoReady));
    setEditVersion((value) => value + 1);
  }
  function confirmClearAll() {
    clearAllOps();
    setClearConfirmOpen(false);
  }
  // meta는 획이 시작된 시점의 도구·색·굵기다. 커밋 시점의 state를 읽으면
  // 획 도중 다른 손이 도구 버튼을 눌렀을 때 획이 통째로 폐기되거나 잘못된 도구로 커밋된다.
  function commitStroke(points: Array<{ x: number; y: number; pressure: number }>, meta: StrokeMeta) {
    const fitted = fitStrokePoints(points, mirror ? 2 : 1);
    if (!fitted.length) return false;
    const operationId = newOperationId();
    const op: DrawOp = {
      opId: `op_${operationId}`,
      clientOpId: `client_${operationId}`,
      type: "stroke",
      at: new Date().toISOString(),
      tool: meta.tool,
      color: meta.tool === "eraser" ? undefined : meta.color,
      width: meta.width,
      points: fitted,
      smoothed: meta.tool !== "eraser",
      squareEraser: meta.tool === "eraser",
    };
    if (!commitOps(mirror ? [op, mirrorOp(op)] : [op])) return false;
    return fitted.length === points.length;
  }
  function commitFill(point: { x: number; y: number }) {
    const operationId = newOperationId();
    const op: DrawOp = {
      opId: `op_${operationId}`,
      clientOpId: `client_${operationId}`,
      type: "fill",
      at: new Date().toISOString(),
      color,
      points: [{ x: point.x, y: point.y }],
    };
    commitOps(mirror ? [op, mirrorOp(op)] : [op]);
  }
  function commitSticker(point: { x: number; y: number }) {
    const operationId = newOperationId();
    const op: DrawOp = {
      opId: `op_${operationId}`,
      clientOpId: `client_${operationId}`,
      type: "sticker",
      at: new Date().toISOString(),
      sticker: stickerKind,
      fontSize: documentWidthUnits(STICKER_SIZE),
      points: [{ x: point.x, y: point.y }],
    };
    commitOps(mirror ? [op, mirrorOp(op)] : [op]);
  }
  // 스포이드: 도화지에 그려진 색을 그대로 집는다. 도화지는 흰 바탕이 칠해진 불투명 캔버스라 알파를 따로 풀지 않는다.
  function pickColorFromCanvas(canvas: HTMLCanvasElement, point: { x: number; y: number }) {
    const pixel = canvas.getContext("2d")?.getImageData(Math.min(canvas.width - 1, Math.floor(point.x * canvas.width)), Math.min(canvas.height - 1, Math.floor(point.y * canvas.height)), 1, 1).data;
    if (!pixel) return;
    pickColor(`#${[pixel[0], pixel[1], pixel[2]].map((value) => value.toString(16).padStart(2, "0")).join("").toUpperCase()}`);
    chooseStudioTool(lastBrushRef.current);
  }
  function commitShape(start: { x: number; y: number }, end: { x: number; y: number }) {
    // 점 하나 크기의 도형은 실수 탭이다. 커밋하지 않아야 2탭 흐름에서 시작점을 다시 찍을 수 있다.
    if (Math.hypot(end.x - start.x, end.y - start.y) < 0.012) return false;
    const operationId = newOperationId();
    const op: DrawOp = {
      opId: `op_${operationId}`,
      clientOpId: `client_${operationId}`,
      type: "shape",
      at: new Date().toISOString(),
      shape: shapeKind,
      filled: shapeFilled && shapeKind !== "line" && shapeKind !== "curve",
      color,
      width: documentWidthUnits(drawWidth),
      points: [
        { x: start.x, y: start.y },
        { x: end.x, y: end.y },
      ],
    };
    return commitOps(mirror ? [op, mirrorOp(op)] : [op]);
  }
  function commitText(point: { x: number; y: number }, pending: PendingText) {
    if (activeTextObjects(documentStateRef.current.ops).length >= MAX_TEXT_OBJECTS) return false;
    const operationId = newOperationId();
    const textObjectId = `text_${operationId}`;
    const op: DrawOp = {
      opId: `op_${operationId}`,
      clientOpId: `client_${operationId}`,
      type: "text",
      at: new Date().toISOString(),
      textObjectId,
      text: pending.text,
      textKind: pending.textKind,
      fontSize: documentWidthUnits(pending.fontSize),
      color: pending.color,
      points: [clampTextPlacement(point, pending.textKind)],
    };
    if (!commitOps([op])) return false;
    setPendingText(null);
    setSelectedTextObjectId(textObjectId);
    setSaveState("글씨를 놓았어요. 테두리를 끌어서 옮길 수 있어요");
    return true;
  }
  function updateTextObject(current: DrawOp, changes: Partial<Pick<DrawOp, "text" | "textKind" | "fontSize" | "color" | "points" | "deleted">>) {
    if (current.type !== "text" || !current.textObjectId) return false;
    const operationId = newOperationId();
    const op: DrawOp = {
      ...current,
      ...changes,
      opId: `op_${operationId}`,
      clientOpId: `client_${operationId}`,
      at: new Date().toISOString(),
    };
    if (!commitOps([op])) return false;
    if (changes.deleted) {
      setSelectedTextObjectId(null);
      setTextDragPoint(null);
    }
    return true;
  }
  /* 도형도 끄는 동안 모양이 계속 바뀐다. 획과 같은 얇은 층에 그려 도화지 픽셀을 건드리지 않는다.
   * 예전에는 move마다 도화지 전체를 ImageData로 되돌렸다(아이패드 미니에서 34MB·약 15ms). */
  function previewShape(canvas: HTMLCanvasElement, start: { x: number; y: number }, end: { x: number; y: number }) {
    const context = liveStrokeContext(liveCanvasRef.current, canvas);
    if (!context) return;
    const preview: DrawOp = {
      opId: "preview_op",
      clientOpId: "preview_client",
      type: "shape",
      at: "2000-01-01T00:00:00.000Z",
      shape: shapeKind,
      filled: shapeFilled && shapeKind !== "line" && shapeKind !== "curve",
      color,
      width: drawWidth,
      points: [start, end],
    };
    const size = { width: canvas.width, height: canvas.height };
    renderDrawOperation(context, preview, size);
    if (mirror) renderDrawOperation(context, mirrorOp(preview), size);
  }
  /** 도형 미리보기를 걷어낸다. 커밋되면 도화지에 다시 그려지고, 취소되면 그냥 사라진다. */
  function clearShapePreview() {
    clearLiveStroke(liveCanvasRef.current);
  }
  function startGestureTouch(event: ReactPointerEvent<HTMLCanvasElement>) {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    gestureTouches.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });
    if (penModeRef.current && gestureTouches.current.size === 1) {
      singleTouchTapRef.current.set(event.pointerId, { at: performance.now(), x: event.clientX, y: event.clientY, moved: false });
    }
    if (gestureTouches.current.size === 2) {
      singleTouchTapRef.current.clear();
    }
  }
  // 그리기 참여 중인 포인터가 있는가 (스트로크·도형 드래그·채우기 대기).
  function engagedByOther(pointerId: number) {
    if (activePoints.current.size > 0 && !activePoints.current.has(pointerId)) return true;
    if (shapeDragRef.current && shapeDragRef.current.pointerId !== pointerId) return true;
    if (pendingFillRef.current && pendingFillRef.current.pointerId !== pointerId) return true;
    return false;
  }
  // 두 번째 손가락이 오면 진행 중이던 그리기를 폐기하고, 기존 손가락을 마지막 좌표로
  // 핀치 제스처에 승격시킨다. 승격 없이 버리면 gestureTouches가 1개뿐이라 핀치가 영영 시작되지 않는다.
  function promoteEngagedToGesture(canvas: HTMLCanvasElement) {
    const engaged = new Set<number>([...activePoints.current.keys()]);
    if (shapeDragRef.current) engaged.add(shapeDragRef.current.pointerId);
    if (pendingFillRef.current) engaged.add(pendingFillRef.current.pointerId);
    for (const pointerId of engaged) {
      const last = lastClientRef.current.get(pointerId);
      if (last) gestureTouches.current.set(pointerId, last);
      else if (canvas.hasPointerCapture(pointerId)) canvas.releasePointerCapture(pointerId);
    }
    activePoints.current.clear();
    guideTraceLocksRef.current.clear();
    strokeMetaRef.current.clear();
    liveStrokeRef.current = false;
    strokeRectRef.current = null;
    clearLiveStroke(liveCanvasRef.current);
    shapeDragRef.current = null;
    clearShapePreview();
    pendingFillRef.current = null;
    renderDocument(canvas, documentStateRef.current, rasterWidthRef.current);
  }
  function endStroke(event: ReactPointerEvent<HTMLCanvasElement>) {
    activePoints.current.delete(event.pointerId);
    guideTraceLocksRef.current.delete(event.pointerId);
    strokeMetaRef.current.delete(event.pointerId);
    lastClientRef.current.delete(event.pointerId);
    liveStrokeRef.current = false;
    strokeRectRef.current = null;
    clearLiveStroke(liveCanvasRef.current);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    renderDocument(event.currentTarget, documentStateRef.current, rasterWidthRef.current);
  }
  function pointerDown(event: ReactPointerEvent<HTMLCanvasElement>) {
    lastStrokeAtRef.current = Date.now();
    // 몽그리가 먼저 띄운 카드는 아이가 다시 그리기 시작하면 스스로 접힌다 — 그리기를 막지 않는다.
    if (autoGrimi && grimiOpen && !grimiCollapsed) setGrimiCollapsed(true);
    if (event.pointerType === "pen") enablePenMode();
    // 펜 모드: 손 터치는 절대 편집하지 않는다(손바닥 안전). 한 손가락은 아무 일도 하지 않고,
    // 두 손가락만 확대/축소한다. 한 손가락 두 번 탭은 화면 맞춤으로만 쓴다.
    // 펜이 없는 기기: 첫 손가락은 그리고, 그리는 중 두 번째 손가락이 오면
    // 진행 중이던 그리기를 폐기하고 두 손가락 모두 핀치 제스처로 전환한다.
    if (event.pointerType === "touch") {
      if (penModeRef.current) {
        startGestureTouch(event);
        return;
      }
      if (engagedByOther(event.pointerId)) {
        promoteEngagedToGesture(event.currentTarget);
        startGestureTouch(event);
        return;
      }
      if (gestureTouches.current.size > 0) {
        startGestureTouch(event);
        return;
      }
    }
    if (conflictDraftRef.current) {
      setSaveState("먼저 보관한 그림을 새 사본으로 저장해 주세요");
      return;
    }
    if (canvasFull) {
      setSaveState("그림이 아주 커졌어요. ‘완성’을 눌러 저장해요");
      return;
    }
    // 한 번에 한 포인터만 그린다. 그렇지 않으면 태블릿에 얹은 손바닥 접촉이 각각 별도의 선이 된다.
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if (engagedByOther(event.pointerId)) return;
    if (guidePhase === "demo") stopGuideDemoForPractice();
    event.preventDefault();
    const first = canvasPoint(event);
    if (studioTool === "text") {
      if (pendingText) {
        if (!commitText(first, pendingText)) setSaveState("글씨를 놓지 못했어요. 종이의 저장 공간을 확인해 주세요");
        else renderDocument(event.currentTarget, documentStateRef.current, rasterWidthRef.current);
        return;
      }
      const nearest = activeTextObjects(documentStateRef.current.ops)
        .map((op) => ({ op, distance: Math.hypot((op.points?.[0]?.x ?? 2) - first.x, (op.points?.[0]?.y ?? 2) - first.y) }))
        .filter((item) => item.distance <= 0.18)
        .sort((left, right) => left.distance - right.distance)[0]?.op;
      if (nearest?.textObjectId) {
        setSelectedTextObjectId(nearest.textObjectId);
        setSaveState("글씨를 골랐어요. 테두리를 끌어서 옮기거나 아래에서 고쳐요");
      } else openTextComposer();
      return;
    }
    if (studioTool === "move") {
      selectObjectAt(first);
      return;
    }
    if (studioTool === "eraser") updateEraserFootprint(event, true);
    lastClientRef.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });
    if (studioTool === "fill" || studioTool === "sticker" || studioTool === "pipette") {
      // 커밋은 뗐을 때. 눌렀을 때 커밋하면 손바닥의 접촉 하나하나가 fill이 된다.
      event.currentTarget.setPointerCapture(event.pointerId);
      pendingFillRef.current = {
        pointerId: event.pointerId,
        point: { x: first.x, y: first.y },
      };
      return;
    }
    if (studioTool === "shape") {
      event.currentTarget.setPointerCapture(event.pointerId);
      shapeDragRef.current = {
        pointerId: event.pointerId,
        origin: first,
        moved: false,
      };
      strokeRectRef.current = event.currentTarget.getBoundingClientRect();
      clearShapePreview();
      if (shapeStartRef.current) previewShape(event.currentTarget, shapeStartRef.current, first);
      return;
    }
    const meta: StrokeMeta = { tool: studioTool, color, width: documentWidthUnits(width) };
    let strokeStart = first;
    if ((guidePhase === "practice" || guidePhase === "demo") && lessonGuideAvailable && studioTool !== "eraser" && currentLessonActivity !== "color") {
      const guidedStart = lockGuideTrace(currentGuideTraces, first);
      if (guidedStart) {
        guideTraceLocksRef.current.set(event.pointerId, guidedStart.lock);
        strokeStart = guidedStart.point;
      }
    }
    strokeMetaRef.current.set(event.pointerId, meta);
    strokeRectRef.current = event.currentTarget.getBoundingClientRect();
    event.currentTarget.setPointerCapture(event.pointerId);
    activePoints.current.set(event.pointerId, [strokeStart]);
    // 반투명 브러시(크레용·수채붓)는 얇은 층에 그린다. 층을 지우고 획 전체를 다시 그리므로
    // 세그먼트 알파가 겹치지 않고, 도화지 픽셀은 손을 뗄 때까지 그대로 둔다.
    // 지우개는 도화지 픽셀을 파내는 도구라(destination-out) 층에 올릴 수 없다 — 지금처럼 도화지에 그린다.
    liveStrokeRef.current = (meta.tool === "crayon" || meta.tool === "watercolor") && Boolean(liveStrokeContext(liveCanvasRef.current, event.currentTarget));
    const startTarget = liveStrokeRef.current ? liveCanvasRef.current! : event.currentTarget;
    renderLiveStroke(startTarget, meta.tool, meta.color, meta.width, [strokeStart]);
    if (mirror) renderLiveStroke(startTarget, meta.tool, meta.color, meta.width, [{ ...strokeStart, x: 1 - strokeStart.x }]);
  }
  function pointerMove(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (studioTool === "eraser") updateEraserFootprint(event, event.currentTarget.hasPointerCapture(event.pointerId));
    if (gestureTouches.current.has(event.pointerId)) {
      const previous = gestureTouches.current.get(event.pointerId)!;
      const current = { x: event.clientX, y: event.clientY };
      const singleTap = singleTouchTapRef.current.get(event.pointerId);
      if (singleTap && Math.hypot(current.x - singleTap.x, current.y - singleTap.y) > 10) singleTap.moved = true;
      if (gestureTouches.current.size >= 2) {
        const other = [...gestureTouches.current.entries()].find(([id]) => id !== event.pointerId);
        const wrap = wrapRef.current;
        if (other && wrap) {
          const rect = wrap.getBoundingClientRect();
          const local = (touch: { x: number; y: number }) => ({
            x: touch.x - rect.left,
            y: touch.y - rect.top,
          });
          const next = pinchView(viewRef.current, [local(previous), local(other[1])], [local(current), local(other[1])], ...viewBoxRef.current, scaleLimitsRef.current);
          viewRef.current = next;
          setView(next);
        }
      }
      gestureTouches.current.set(event.pointerId, current);
      event.preventDefault();
      return;
    }
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    lastClientRef.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });
    if (pendingFillRef.current?.pointerId === event.pointerId) {
      event.preventDefault();
      return;
    }
    const drag = shapeDragRef.current;
    if (drag && drag.pointerId === event.pointerId) {
      event.preventDefault();
      const next = canvasPoint(event);
      if (!drag.moved && Math.hypot((next.x - drag.origin.x) * 1024, (next.y - drag.origin.y) * 1024) >= 10) drag.moved = true;
      const origin = shapeStartRef.current ?? drag.origin;
      if (drag.moved || shapeStartRef.current) previewShape(event.currentTarget, origin, next);
      return;
    }
    const points = activePoints.current.get(event.pointerId);
    if (!points) return;
    const meta = strokeMetaRef.current.get(event.pointerId);
    if (!meta) return;
    const incoming: Array<{ x: number; y: number; pressure: number }> = [];
    for (const rawNext of movePoints(event)) {
      const guideLock = guideTraceLocksRef.current.get(event.pointerId);
      const guidedMove = guideLock ? snapGuideTrace(currentGuideTraces, guideLock, rawNext) : null;
      if (guidedMove) {
        guideTraceLocksRef.current.set(event.pointerId, guidedMove.lock);
        // 자석 점선이 만든 안내점에는 필압이 없다 — 마지막 실제 필압을 그대로 쓴다.
        for (const point of guidedMove.points) incoming.push({ ...point, pressure: rawNext.pressure });
      } else incoming.push(rawNext);
    }
    let addedPoint = false;
    /* 이 이벤트 **전에** 어디까지 그려져 있었는지 기억한다. 아래 미리보기가 거기서부터 이어 그린다.
     * 고정 창(points.slice(-3))을 쓰면 한 이벤트에 점이 3개 이상 들어올 때 앞쪽 새 점들이
     * 한 번도 그려지지 않아 선이 점선으로 보였다(2026-09-27 사용자 영상). 진짜 펜은
     * getCoalescedEvents로 한 번에 여러 점을 몰아 준다 — 마우스로는 1개씩 와서 드러나지 않았다.
     * 실측(이동 6번): 한 번에 4개 → 5군데 217px, 8개 → 5군데 365px이 빠졌다. 떼면 전체가 다시
     * 그려져 메워지므로 "떼는 순간 그려진다"로 보인다. */
    const drawnUpTo = points.length;
    // 굵은 붓은 점을 촘촘히 담을 이유가 없다 — 렌더러가 점을 이어 그리므로 간격을 굵기에 맞춘다.
    const gap = strokePointGap(meta.tool, meta.width);
    for (const next of incoming) {
      const last = points.at(-1);
      if (last && Math.hypot((next.x - last.x) * 1024, (next.y - last.y) * 1024) >= gap) {
        points.push(next);
        addedPoint = true;
      }
    }
    if (addedPoint) {
      event.preventDefault();
      const live = liveStrokeRef.current ? liveCanvasRef.current : null;
      if (live) {
        // 반투명 브러시: 층을 비우고 누적 획 전체를 한 번에 그려 커밋 결과와 같은 알파로 보인다.
        liveStrokeContext(live, event.currentTarget);
        renderLiveStroke(live, meta.tool, meta.color, meta.width, points);
        if (mirror)
          renderLiveStroke(
            live,
            meta.tool,
            meta.color,
            meta.width,
            points.map((point) => ({ ...point, x: 1 - point.x })),
          );
      } else {
        // 이미 그린 마지막 점부터 이어 그린다. 한 점만 늘어도 종전과 같은 3점 창이 되도록 하나 더 겹친다.
        const livePoints = points.slice(Math.max(0, drawnUpTo - 2));
        renderLiveStroke(event.currentTarget, meta.tool, meta.color, meta.width, livePoints);
        if (mirror)
          renderLiveStroke(
            event.currentTarget,
            meta.tool,
            meta.color,
            meta.width,
            livePoints.map((point) => ({ ...point, x: 1 - point.x })),
          );
      }
      // 손을 떼지 않고 계속 문지르면 한 스트로크가 서버 한도를 넘는다. 화면은 그대로 두고
      // 안쪽에서만 끊어 이어 붙인다. 한도에 닿으면 그 자리에서 입력을 끝낸다.
      if (points.length >= STROKE_POINT_SPLIT) {
        // 획 도중 저장 충돌이 세워졌으면 문서를 더 편집하지 않는다 (충돌 초안 편집 금지 불변).
        if (conflictDraftRef.current) {
          endStroke(event);
          setSaveState("먼저 보관한 그림을 새 사본으로 저장해 주세요");
          return;
        }
        const wholeStrokeFit = commitStroke(points.slice(), meta);
        if (!wholeStrokeFit) {
          endStroke(event);
          setSaveState("그림이 아주 커졌어요. ‘완성’을 눌러 저장해요");
          return;
        }
        activePoints.current.set(event.pointerId, [points.at(-1)!]);
        if (liveStrokeRef.current) {
          // 분할 커밋 뒤에는 방금 커밋된 획이 도화지에 들어갔다. 층은 비우고 이어서 그린다.
          renderDocument(event.currentTarget, documentStateRef.current, rasterWidthRef.current);
          clearLiveStroke(liveCanvasRef.current);
        }
      }
    }
  }
  function releaseGesturePointer(event: ReactPointerEvent<HTMLCanvasElement>) {
    gestureTouches.current.delete(event.pointerId);
    singleTouchTapRef.current.delete(event.pointerId);
    lastClientRef.current.delete(event.pointerId);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  function pointerUp(event: ReactPointerEvent<HTMLCanvasElement>, includeReleasePoint = true) {
    if (studioTool === "eraser") {
      if (event.pointerType === "touch") hideEraserFootprint();
      else updateEraserFootprint(event, false);
    }
    if (gestureTouches.current.has(event.pointerId)) {
      const touchCount = gestureTouches.current.size;
      const singleTap = singleTouchTapRef.current.get(event.pointerId);
      singleTouchTapRef.current.delete(event.pointerId);
      gestureTouches.current.delete(event.pointerId);
      if (touchCount === 1 && singleTap && !singleTap.moved && performance.now() - singleTap.at <= 320) {
        const now = performance.now();
        if (now - lastSingleFingerTapRef.current < 500) {
          resetViewToFit();
          lastSingleFingerTapRef.current = 0;
        } else lastSingleFingerTapRef.current = now;
      }
      lastClientRef.current.delete(event.pointerId);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      return;
    }
    const pendingFill = pendingFillRef.current;
    if (pendingFill && pendingFill.pointerId === event.pointerId) {
      pendingFillRef.current = null;
      lastClientRef.current.delete(event.pointerId);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      if (conflictDraftRef.current) {
        setSaveState("먼저 보관한 그림을 새 사본으로 저장해 주세요");
        return;
      }
      event.preventDefault();
      if (studioTool === "pipette") pickColorFromCanvas(event.currentTarget, pendingFill.point);
      else if (studioTool === "sticker") commitSticker(pendingFill.point);
      else commitFill(pendingFill.point);
      return;
    }
    const drag = shapeDragRef.current;
    if (drag && drag.pointerId === event.pointerId) {
      shapeDragRef.current = null;
      clearShapePreview();
      lastClientRef.current.delete(event.pointerId);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      if (conflictDraftRef.current) {
        renderDocument(event.currentTarget, documentStateRef.current, rasterWidthRef.current);
        setSaveState("먼저 보관한 그림을 새 사본으로 저장해 주세요");
        return;
      }
      event.preventDefault();
      const end = canvasPoint(event);
      const pending = shapeStartRef.current;
      if (pending) {
        // 2탭 경로의 두 번째 탭. 실패(너무 작음·한도)면 미리보기만 걷어낸다.
        clearShapeStart();
        if (!commitShape(pending, end)) renderDocument(event.currentTarget, documentStateRef.current, rasterWidthRef.current);
      } else if (drag.moved) {
        if (!commitShape(drag.origin, end)) renderDocument(event.currentTarget, documentStateRef.current, rasterWidthRef.current);
      } else {
        // 움직이지 않은 탭 = 2탭 경로의 시작점 찍기. 표식은 캔버스 픽셀이 아니라 DOM 점으로 —
        // 픽셀에 그리면 문서에 없는 초록 점이 썸네일·완성 PNG·AI 전송 이미지에 섞인다.
        shapeStartRef.current = drag.origin;
        setShapeStartPoint(drag.origin);
      }
      return;
    }
    const points = activePoints.current.get(event.pointerId);
    const meta = strokeMetaRef.current.get(event.pointerId);
    if (conflictDraftRef.current) {
      // 미리보기로 그려 둔 픽셀을 지우지 않으면 문서에 없는 선이 썸네일에 섞인다.
      endStroke(event);
      setSaveState("먼저 보관한 그림을 새 사본으로 저장해 주세요");
      return;
    }
    if (!points?.length || !meta) return;
    event.preventDefault();
    // Safari와 일부 태블릿 브라우저는 빠른 획에서 pointermove를 거의 보내지 않는다.
    // 손을 뗀 좌표를 마지막으로 보간해야 시작점만 점처럼 남지 않고, 자석 점선도
    // 건너뛴 안내점을 모두 채워 매끈한 선으로 완성된다.
    if (includeReleasePoint) {
      const releasePoint = canvasPoint(event);
      const guideLock = guideTraceLocksRef.current.get(event.pointerId);
      const guidedRelease = guideLock ? snapGuideTrace(currentGuideTraces, guideLock, releasePoint) : null;
      const incoming = guidedRelease ? guidedRelease.points : [releasePoint];
      const gap = strokePointGap(meta.tool, meta.width);
      for (const next of incoming) {
        const last = points.at(-1);
        if (last && Math.hypot((next.x - last.x) * 1024, (next.y - last.y) * 1024) >= gap) points.push(next);
      }
    }
    activePoints.current.delete(event.pointerId);
    guideTraceLocksRef.current.delete(event.pointerId);
    strokeMetaRef.current.delete(event.pointerId);
    liveStrokeRef.current = false;
    strokeRectRef.current = null;
    clearLiveStroke(liveCanvasRef.current);
    lastClientRef.current.delete(event.pointerId);
    // 한도에 막혀 커밋되지 않으면 미리보기 픽셀을 문서 상태로 되돌린다.
    if (!commitStroke(points, meta)) {
      endStroke(event);
      setSaveState("그림이 아주 커졌어요. ‘완성’을 눌러 저장해요");
      return;
    }
    if ((guidePhase === "practice" || guidePhase === "demo") && lessonGuideAvailable && meta.tool !== "eraser") setGuidePracticeTried(true);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    // 저장 렌더러의 선 보정 결과를 즉시 보여 줘서, 손을 뗀 뒤 화면과 재접속한 작품이 다르지 않게 한다.
    renderDocument(event.currentTarget, documentStateRef.current, rasterWidthRef.current);
  }
  // 취소는 폐기다. pointerUp으로 흘리면 취소 이벤트의 (0,0) 좌표로 도형이 커밋되는 사고가 난다.
  // 단 스트로크는 이벤트 좌표가 아니라 누적 점으로 커밋하므로, 그려 둔 만큼 살리는 기존 동작을 유지한다.
  function pointerCancel(event: ReactPointerEvent<HTMLCanvasElement>) {
    hideEraserFootprint();
    if (gestureTouches.current.has(event.pointerId)) {
      releaseGesturePointer(event);
      return;
    }
    if (pendingFillRef.current?.pointerId === event.pointerId) {
      pendingFillRef.current = null;
      lastClientRef.current.delete(event.pointerId);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      return;
    }
    if (shapeDragRef.current?.pointerId === event.pointerId) {
      shapeDragRef.current = null;
      clearShapePreview();
      lastClientRef.current.delete(event.pointerId);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      renderDocument(event.currentTarget, documentStateRef.current, rasterWidthRef.current);
      return;
    }
    pointerUp(event, false);
  }
  function undo() {
    if (conflictDraftRef.current) return;
    // 대기 중인 도형 시작점은 지운다. 문서가 바뀐 뒤 보이지 않는 옛 시작점에서 도형이 커밋되는 사고 방지.
    clearShapeStart();
    // 대칭 쌍은 한 번의 되돌리기로 함께 지워진다. 반쪽만 지우면 아이가 이해할 수 없는 상태가 된다.
    // 전체 지우기 직후라면(clearedOpsRef) 그 지우기 하나를 한 번에 복원한다.
    const next = undoDrawing({
      document: documentStateRef.current,
      redo: redoRef.current,
      clearedOps: clearedOpsRef.current,
      clearRedoReady: clearRedoReadyRef.current,
    });
    if (next.document === documentStateRef.current) return;
    markEdited();
    documentStateRef.current = next.document;
    redoRef.current = next.redo;
    clearedOpsRef.current = next.clearedOps ?? null;
    clearRedoReadyRef.current = Boolean(next.clearRedoReady);
    setDocumentState(next.document);
    setRedo(next.redo);
    setHasClearToUndo(Boolean(next.clearedOps));
    setHasClearToRedo(Boolean(next.clearRedoReady));
    setEditVersion((value) => value + 1);
  }
  function redoLast() {
    if (conflictDraftRef.current) return;
    clearShapeStart();
    const next = redoDrawing({
      document: documentStateRef.current,
      redo: redoRef.current,
      clearedOps: clearedOpsRef.current,
      clearRedoReady: clearRedoReadyRef.current,
    });
    if (next.document === documentStateRef.current) return;
    markEdited();
    documentStateRef.current = next.document;
    redoRef.current = next.redo;
    clearedOpsRef.current = next.clearedOps ?? null;
    clearRedoReadyRef.current = Boolean(next.clearRedoReady);
    setDocumentState(next.document);
    setRedo(next.redo);
    setHasClearToUndo(Boolean(next.clearedOps));
    setHasClearToRedo(Boolean(next.clearRedoReady));
    setEditVersion((value) => value + 1);
  }
  async function complete() {
    if (completingRef.current) return;
    completingRef.current = true;
    setCompletionState("saving");
    setCompletionError("");
    window.clearTimeout(saveTimer.current);
    try {
      const ok = await save(documentStateRef.current, {
        complete: true,
        // 2026-09-20 사용자 지시로 "마음에 드는 곳·왜 마음에 들어" 고르기를 없앴다.
        // 아이 말로 남는 것은 몽그리 짐작을 고친 문장(storyText) 하나다.
        reflection: { favoritePart: "", favoriteReason: "", spokenDescription: "", storyText },
      });
      if (ok) {
        // 완성하고 나면 아이 자리로 돌아간다(2026-09-25 사용자 지시). 거기서 방금 그린 그림과
        // 새 그림·그림책을 함께 본다. 보관함은 그 화면의 「내 그림 모두 보기」로 한 번에 간다.
        location.href = "/student";
        return;
      }
      setCompletionState("error");
      setCompletionError("저장이 끝나지 않았어요. 인터넷을 확인하고 다시 눌러 주세요.");
    } catch (cause) {
      setCompletionState("error");
      setCompletionError(cause instanceof Error ? cause.message : "작품을 저장하지 못했어요. 다시 눌러 주세요.");
    } finally {
      completingRef.current = false;
    }
  }

  async function saveAsCopy() {
    try {
      await performSaveAsCopy();
    } catch {
      setSaveState("사본을 만들지 못했어요. 인터넷을 확인하고 다시 눌러 주세요");
    }
  }

  async function performSaveAsCopy() {
    const draft = conflictDraftRef.current;
    const profile = activeProfile();
    if (!artwork || !canvasRef.current || !draft || !profile) return;
    setSaveState("새 사본을 만드는 중…");
    const stableKey = draft.save.requestId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 50);
    const clientArtworkId = stableKey.length >= 8 ? `artwork_copy_${stableKey}` : `artwork_${crypto.randomUUID().replaceAll("-", "")}`;
    const copyRequestId = stableKey.length >= 8 ? `copy_${stableKey}` : mutationId();
    const created = await studentFetch("/api/artworks", {
      method: "POST",
      body: JSON.stringify({
        clientArtworkId,
        learningMode: artwork.learningMode,
        lessonSlug: artwork.lessonSlug,
        title: `${artwork.title} 사본`,
        topic: artwork.topic,
        intent: artwork.intent,
      }),
    });
    const createdData = (await created.json()) as {
      error?: string;
      artwork?: { id: string };
    };
    if (!created.ok || !createdData.artwork) {
      setSaveState(createdData.error ?? "사본을 만들지 못했어요");
      return;
    }
    const response = await studentFetch(`/api/artworks/${createdData.artwork.id}`, {
      method: "PUT",
      body: JSON.stringify({
        requestId: copyRequestId,
        expectedRevision: 0,
        document: draft.document,
        currentStep: draft.currentStep,
        thumbnailDataUrl: documentImage(draft.document, 256),
        complete: draft.complete,
        finalDataUrl: draft.finalDataUrl,
        reflection: draft.reflection,
      }),
    });
    if (!response.ok) {
      const data = (await response.json()) as { error?: string };
      setSaveState(data.error ?? "사본을 저장하지 못했어요");
      return;
    }
    // 충돌 상태는 화면을 떠날 때까지 유지한다. 여기서 먼저 풀면 이동이 끝나기 전에
    // 도화지가 다시 편집 가능해지고, 그 자동 저장이 복구된 충돌 문서를 원본 작품에
    // 현재 revision으로 써 넣어 충돌을 일으킨 서버 쪽 그림을 덮어쓴다.
    let removed = false;
    for (let attempt = 0; attempt < 3 && !removed; attempt += 1) {
      try {
        await deleteQueuedArtworkSave(profile.studentId, draft.save.url, draft.save.requestId);
        removed = true;
      } catch {
        removed = false;
      }
    }
    if (!removed) {
      // flushSaves는 충돌 항목을 건너뛰므로 남겨 두면 다음에도 같은 초안이 되살아난다.
      setSaveState("사본은 저장했어요. 정리가 끝나지 않았으니 한 번 더 눌러 주세요");
      return;
    }
    location.replace(draft.complete ? "/student" : `/student/draw/${createdData.artwork.id}`);
  }

  /* 조건이 맞는 순간에만 몽그리가 먼저 말을 건다. 획을 긋는 도중에는 절대 뜨지 않는다 —
   * 마지막 획에서 idleMs가 지나야 하고, 완성·소감·저장 충돌·선생님 보기 중에도 뜨지 않는다. */
  const autoGrimiReady = useCallback(() => {
    const now = Date.now();
    if (!artwork || artwork.status === "complete") return false;
    if (grimiLoading || grimiOpen || reflectionOpen || interpretLoading) return false;
    // 손을 들고 선생님을 기다리는 아이에게 AI가 끼어들지 않는다(2026-09-20).
    // 손든 상태는 "손이 멈춘 상태"라 idleMs 조건에 그대로 걸린다 — 막지 않으면 부른 직후 몽그리가 뜬다.
    if (conflictDraftRef.current || teacherViewing || handRaised) return false;
    if (documentStateRef.current.ops.length < AUTO_GRIMI.minOps) return false;
    if (autoGrimiCountRef.current >= AUTO_GRIMI.maxPerArtwork) return false;
    if (now - openedAtRef.current < AUTO_GRIMI.settleMs) return false;
    if (now - lastStrokeAtRef.current < AUTO_GRIMI.idleMs) return false;
    if (now - lastManualGrimiAtRef.current < AUTO_GRIMI.afterManualMs) return false;
    if (lastAutoGrimiAtRef.current && now - lastAutoGrimiAtRef.current < AUTO_GRIMI.gapMs) return false;
    return true;
  }, [AUTO_GRIMI.afterManualMs, AUTO_GRIMI.gapMs, AUTO_GRIMI.idleMs, AUTO_GRIMI.maxPerArtwork, AUTO_GRIMI.minOps, AUTO_GRIMI.settleMs, artwork, grimiLoading, grimiOpen, handRaised, interpretLoading, reflectionOpen, teacherViewing]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      if (autoGrimiReady()) void askGrimi({ auto: true });
    }, AUTO_GRIMI.tickMs);
    return () => window.clearInterval(timer);
  // askGrimi는 렌더마다 새로 만들어지지만 조건 판정은 autoGrimiReady가 모두 한다.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoGrimiReady, AUTO_GRIMI.tickMs]);

  async function askGrimi(options: { auto?: boolean } = {}) {
    if (!artwork || !canvasRef.current || grimiLoading) return;
    const auto = options.auto === true;
    if (auto) { autoGrimiCountRef.current += 1; lastAutoGrimiAtRef.current = Date.now(); }
    else lastManualGrimiAtRef.current = Date.now();
    setAutoGrimi(auto);
    setGrimiOpen(true);
    setGrimiCollapsed(false);
    setGrimiLoading(true);
    setGrimiError("");
    // 다시 부르면 앞 질문은 아이가 답할 일이 없다. 열어 둔 채 쌓지 않고 닫는다.
    closeCoachingEvent(coaching?.eventId);
    setCoaching(null);
    setPickedAnswer(""); setOwnAnswer(""); setReplyState("idle"); setReplyError(""); replyingRef.current = false;
    setGuidePhase("independent");
    window.clearTimeout(saveTimer.current);
    // 선행 저장은 반드시 try 안에서 기다린다. 밖에서 던지면 grimiLoading이 영구히 잠긴다.
    try {
      const saved = await save();
      if (!saved) {
        setGrimiError("그림을 먼저 저장한 뒤 다시 불러 줘.");
        return;
      }
      const response = await grimiFetch({
        action: "ask",
        requestId: coachingRequestId(),
        artworkId: artwork.id,
        expectedRevision: revisionRef.current,
        document: documentStateRef.current,
        imageDataUrl: documentImage(documentStateRef.current, 1024),
        childChoice,
        openedBy: auto ? "mongri" : "child",
      });
      const data = (await response.json()) as {
        error?: string;
        eventId?: string;
        coaching?: StudentCoaching;
      };
      if (!response.ok || !data.eventId || !data.coaching) throw new Error(data.error ?? "몽그리의 답을 받지 못했어요.");
      setCoaching({ ...data.coaching, eventId: data.eventId });
    } catch (cause) {
      setGrimiError(cause instanceof Error ? cause.message : "몽그리를 부르지 못했어요.");
    } finally {
      setGrimiLoading(false);
    }
  }

  /* 몽그리 질문은 보여 주기만 한다(2026-09-23 사용자 결정). 아이가 답을 보낼 일이 없으니
   * 열린 도움 기록은 이 함수로만 닫는다. 답을 두 번 보내 409 `이미 처리한 도움 기록이에요`가
   * 나던 왕복 자체가 사라진다. */
  function closeCoachingEvent(eventId?: string) {
    if (!eventId || !artwork) return;
    void studentFetch("/api/ai/coaching", {
      method: "POST",
      body: JSON.stringify({ action: "dismiss", artworkId: artwork.id, eventId }),
    }).catch(() => undefined);
  }

  function saveLessonStepProgress(next: LessonStepProgress) {
    if (!artwork || !lesson) return;
    const step = Math.min(artwork.currentStep, lesson.steps.length - 1);
    try {
      localStorage.setItem(lessonStepStorageKey(artwork.id, lesson.slug, step), JSON.stringify(next));
    } catch {}
    setLessonStepProgress(next);
  }

  function completeCurrentLessonStep(skipped = false) {
    if (!lessonStepProgress) return;
    saveLessonStepProgress({ ...lessonStepProgress, completed: true, skipped });
  }

  function changeLessonStep(delta: -1 | 1, options?: { skip?: boolean }) {
    if (!artwork || !lesson || conflictDraftRef.current) {
      if (conflictDraftRef.current) setSaveState("먼저 보관한 그림을 새 사본으로 저장해 주세요");
      return;
    }
    if (delta === 1 && !options?.skip && !currentLessonStepStatus.ready) {
      setLessonStepPrompt("step-action");
      return;
    }
    const next = Math.max(0, Math.min(lesson.steps.length - 1, artwork.currentStep + delta));
    if (next === artwork.currentStep) return;
    if (delta === 1) completeCurrentLessonStep(Boolean(options?.skip));
    currentStepRef.current = next;
    setGuidePhase("independent");
    setLessonStepPrompt(null);
    markEdited();
    setEditVersion((value) => value + 1);
    setArtwork({ ...artwork, currentStep: next });
  }

  function advanceOrCompleteLessonStep(skip = false) {
    if (!artwork || !lesson || conflictDraftRef.current) return;
    if (!skip && !currentLessonStepStatus.ready) {
      setLessonStepPrompt("step-action");
      return;
    }
    if (artwork.currentStep < lesson.steps.length - 1) {
      changeLessonStep(1, { skip });
      return;
    }
    completeCurrentLessonStep(skip);
    setLessonStepPrompt(null);
    openReflection();
  }

  /**
   * 틀리는 해석자 요청. 완성 흐름을 막지 않는다 — 실패하면 조용히 접고
   * 소감 화면은 지금까지처럼 동작한다.
   */
  async function askInterpretation() {
    if (!artwork || !canvasRef.current || interpretLoading) return;
    setInterpretLoading(true);
    setInterpretation(null);
    try {
      const response = await grimiFetch({ action: "interpret", artworkId: artwork.id, imageDataUrl: documentImage(documentStateRef.current, 1024) }, INTERPRET_TIMEOUT_MS);
      const data = (await response.json()) as { interpretation?: StoryInterpretation };
      if (response.ok && data.interpretation) setInterpretation(data.interpretation);
    } catch {
      // 몽그리 짐작은 있으면 좋은 것이고 없어도 완성에는 지장이 없다.
    } finally {
      setInterpretLoading(false);
    }
  }

  /* 소감 화면은 이 한 곳에서만 연다. 종전에는 자유 그리기 경로에만 askInterpretation()이 있어서
   * 수업 중 완성은 「네 그림을 소개해 줘!」 제목과 단추만 남은 빈 화면이었다(2026-09-28 사용자 제보).
   * 셋 중 어느 길로 와도 몽그리 짐작을 부르고, 지난 오류 표시도 함께 지운다. */
  function openReflection() {
    setCompletionState("idle");
    setCompletionError("");
    setReflectionOpen(true);
    void askInterpretation();
  }

  function requestArtworkCompletion() {
    if (!lesson) {
      openReflection();
      return;
    }
    if (artwork && artwork.currentStep < lesson.steps.length - 1) {
      setLessonStepPrompt("unfinished-lesson");
      return;
    }
    advanceOrCompleteLessonStep(false);
  }

  /* 카드에서 바로 답을 보낸다. 서버의 `reply`는 같은 줄을 덮어쓰므로 아이가 답을 바꿔도 409가 나지 않는다
   * — 2026-09-23에 왕복을 걷어낸 세 이유 중 하나였다. 그리기 전에 답하는 길이라 문서·이미지를 싣지 않는다. */
  const replyText = (pickedAnswer || ownAnswer).trim();
  async function sendReply() {
    if (!artwork || !coaching || !replyText || replyingRef.current) return;
    replyingRef.current = true;
    setReplyState("sending"); setReplyError("");
    try {
      const response = await grimiFetch({ action: "reply", artworkId: artwork.id, eventId: coaching.eventId, answer: replyText });
      const data = await response.json() as { error?: string; nextAction?: string };
      if (!response.ok) throw new Error(data.error ?? "답을 보내지 못했어요.");
      setReplyState("sent");
      /* 화면에 떠 있던 「이제 그려 볼 일」은 아이가 답하기 **전에** 만들어진 말이다. 아이가 무엇인지
       * 알려 줬으니 그 자리에서 아이 말에 맞춘 줄로 바꾼다(2026-09-26 사용자 결정).
       * 몽그리가 쉬면 nextAction이 오지 않고, 그때는 종전 줄을 그대로 둔다 — 답은 이미 저장됐다. */
      if (data.nextAction) setCoaching((current) => current ? { ...current, nextAction: data.nextAction as string } : current);
    } catch (cause) {
      // 보내지 못하면 다시 누를 수 있게 되돌린다. 아이가 쓴 글자는 지우지 않는다.
      setReplyState("idle");
      setReplyError(cause instanceof Error ? cause.message : "답을 보내지 못했어요. 다시 눌러 볼까?");
    } finally {
      replyingRef.current = false;
    }
  }

  function closeGrimiState() {
    setGrimiOpen(false);
    setGrimiCollapsed(false);
    setCoaching(null);
    setPickedAnswer(""); setOwnAnswer(""); setReplyState("idle"); setReplyError(""); replyingRef.current = false;
    setGuidePhase("independent");
    setGrimiError("");
  }

  function dismissGrimi() {
    closeCoachingEvent(coaching?.eventId);
    closeGrimiState();
  }

  function guideControls() {
    if (!lessonGuideAvailable) return null;
    if (lesson?.mode === "observe") {
      return (
        <div className="guide-actions observation-guide-actions" aria-label="관찰 그리기 점선 힌트">
          <button className="guide-toggle" type="button" aria-pressed={guidePhase === "practice"} disabled={Boolean(conflictDraft)} onClick={() => setGuidePhase((phase) => (phase === "practice" ? "independent" : "practice"))}>
            {guidePhase === "practice" ? "점선 힌트 숨기기" : "🔎 점선 힌트 보기"}
          </button>
        </div>
      );
    }
    return (
      <div className="guide-actions" aria-label="그리기 시범과 점선">
        <button className="guide-demo-button" type="button" aria-pressed={guidePhase === "demo"} disabled={Boolean(conflictDraft)} onClick={() => (guidePhase === "demo" ? stopGuideDemoForPractice() : startGuideDemo())}>
          {guidePhase === "demo" ? "시범 멈추기" : guidePhase === "practice" ? "✏️ 다시 보기" : "✏️ 먼저 보여줘"}
        </button>
        {guidePhase === "practice" ? (
          <button className="guide-toggle" type="button" disabled={Boolean(conflictDraft)} onClick={chooseIndependentDrawing}>
            {guidePracticeTried ? "이제 혼자 해볼래" : "점선 숨기기"}
          </button>
        ) : (
          guidePhase === "independent" && (
            <button className="guide-toggle" type="button" disabled={Boolean(conflictDraft)} onClick={() => setGuidePhase("practice")}>
              점선만 보기
            </button>
          )
        )}
      </div>
    );
  }

  // 기다리는 화면은 입장 확인과 같은 것을 쓴다(2026-09-20 사용자 요청). 불러오기가 실패하면 그 문구를 둘째 줄에 보여 준다.
  if (!artwork) {
    // 실패 문구가 영어(예: "Failed to fetch")일 수 있다 — 아이가 읽는 줄이므로 우리말 안내로 바꾼다.
    const waiting = saveState === "불러오는 중";
    const koreanMessage = /[가-힣]/.test(saveState) ? saveState : "연결이 잠깐 어려워요. 다시 들어와 줄래?";
    return <WaitMongri line={waiting ? "도화지를 펴고 있어요" : koreanMessage} />;
  }
  const step = lesson ? Math.min(artwork.currentStep, lesson.steps.length - 1) : 0;
  const guideNotice = guidePhase === "demo" ? "연필이 먼저 보여줄게!" : guidePhase === "practice" ? (guidePracticeTried ? "한 번 따라 했어! 이제 점선 없이도 해볼까?" : "이제 네 차례야. 아무 점선이나 골라서 시작해 봐.") : "";
  const choiceFeedback = childChoice ? CHOICE_DRAWING_SETUP[childChoice]?.feedback ?? "고른 모습을 그림에 직접 더해요." : "";
  const canvasGuideStatus = guideNotice || (currentLessonActivity === "color" ? choiceFeedback || "색을 고르면 크레용도 함께 준비해 줄게요." : "");
  const nextStepLabel = lesson ? (step === lesson.steps.length - 1 ? "완성하기" : "다음") : "다음";
  const guardedNextStepLabel = currentLessonStepStatus.ready ? nextStepLabel : step === (lesson?.steps.length ?? 1) - 1 ? "완성하기" : "그린 뒤 다음";
  const lessonStepPromptText = currentLessonActivity === "color"
    ? "색을 하나 고르고 쓱쓱 칠해 볼까?"
    : currentLessonActivity === "free"
      ? "내 생각을 하나 더 그릴까?"
      : currentLessonStepStatus.remaining > 1
        ? "점이나 선을 조금 더 그려 볼까?"
        : "점이나 선을 한 번 더 그려 볼까?";
  /* 두 aside는 같은 자리를 쓴다. 종전에는 grimiOpen만 보고 골라서, 몽그리 카드가 열린 채 「완성」을
   * 누르면 단계 안내(남은 순서·조금 더 그리기)가 어디에도 그려지지 않아 단추가 죽은 것처럼 보였다
   * (2026-09-28 사용자 제보). 안내가 있는 동안만 카드를 접어 두고, 닫으면 카드가 그대로 돌아온다 —
   * grimiOpen·coaching은 건드리지 않는다. */
  const showGrimiPanel = grimiOpen && !lessonStepPrompt;
  const selectedColor = studioTool === "text" && selectedText ? selectedText.color : pendingText?.color ?? color;
  // 색 적용은 팔레트 원과 색 고르기 대화상자(onPick)에 같은 네 줄이 인라인으로 있다. 헬퍼로 빼면
  // React Compiler가 이 컴포넌트 전체를 컴파일 대상으로 삼아 기존 performance.now() 호출을 오류로 잡는다.
  const customColor = !PALETTE.includes(selectedColor);
  /* 몽그리 표정(2026-09-12). 어떤 얼굴을 쓸지는 **UI 상태로만** 정한다 —
   * AI가 쓴 문장에서 감정을 추측해 고르지 않는다(사용 제안서 2026-09-09).
   * 우선순위: 오류 → 생각 중 → 접힌 제안 → 질문. */
  const grimiFace = grimiError ? "reassuring"
    : grimiLoading ? "thinking"
    : grimiCollapsed && coaching ? "suggesting"
    : coaching ? "curious"
    : "listening";

  return (
    <main className={`studio${dockOpen ? "" : " dock-collapsed"}`}>
      <header className="studio-header">
        {/* 2026-09-26: 아이의 집은 이제 「그림 자리」(/student)다 — 내 그림·새 그림·내 그림책이 함께 있다.
            여기서 옛 보관함으로 바로 보내면 아이가 오늘 만든 자리를 못 본다. 보관함은 그 자리에서 한 번에 간다. */}
        <a className="icon-button studio-back" href="/student" aria-label="내 그림 자리로 나가기">
          <ArrowLeftIcon />
        </a>
        <Logo compact />
        <div className="artwork-name">
          <b>{artwork.title}</b>
          <small className="studio-save-state">{saveState === "저장됨" && <CheckIcon size={14} />}{saveState}</small>
        </div>
        {lesson && (
          <span className="step-count">
            {step + 1}/{lesson.steps.length}
          </span>
        )}
        {/* 버튼 묶음(2026-09-14 사용자 결정, 시안 docs/design-assets/studio-header-actions/1-quiet-ghost.webp):
            선생님·선생님 말씀은 조용한 선 아이콘+글자, 몽그리는 연노랑 도움 버튼, 완성만 진초록.
            과정 보기는 2026-09-15 사용자 지시로 뺐다(가족 보기의 과정 재생은 그대로). 휴대폰 세로에서는 버튼이 둘째 줄로 내려가고 완성은 첫 줄에 남는다. */}
        <div className="studio-actions">
          <button type="button" className="studio-action is-helper" disabled={grimiLoading || Boolean(conflictDraft)} onClick={() => void askGrimi()}>
            {grimiLoading ? <span className="studio-action-spinner" aria-hidden="true" /> : <img className="studio-action-mongri" src="/brand/mongri/listening.png" alt="" aria-hidden="true" width={28} height={28} />}
            <span>몽그리 부르기</span>
          </button>
          <button type="button" className={`studio-action hand-raise-button${handRaised ? " is-raised" : ""}`} aria-pressed={handRaised} disabled={handBusy} onClick={() => void toggleHand()} aria-label={handRaised ? "선생님 부른 손 내리기" : "선생님 부르기"}>
            <HandIcon size={22} /><span>{handRaised ? "손 내리기" : "선생님"}</span>
          </button>
          <StudentMessageCenter messages={teacherMessages} floating header />
        </div>
        <button type="button" className="studio-action is-primary studio-finish" disabled={Boolean(conflictDraft)} onClick={requestArtworkCompletion}>
          <CheckIcon size={20} /><span>완성</span>
        </button>
      </header>
      {conflictDraft && (
        <div className="save-conflict" role="alert">
          <b>{conflictDraft.save.conflict ? "다른 기기 저장과 겹쳤어요." : "아직 서버에 보내지 못한 그림이 있어요."}</b>
          <span>
            {conflictDraft.save.conflict ? "이 작품의 충돌 초안을 복구했어요." : "인터넷이 연결되면 다시 저장해요."} 지금은 편집을 멈추고 새 사본으로도 보관할 수 있어요.
            {conflictRevision !== null ? ` (서버 버전 ${conflictRevision})` : ""}
          </span>
          {!conflictDraft.save.conflict && <button onClick={flushCurrentArtwork}>다시 저장</button>}
          <button onClick={saveAsCopy}>새 사본으로 저장</button>
        </div>
      )}
      {visibleMark && (
        <div className="teacher-mark-card" role="alert">
          <b><span aria-hidden="true">✏️</span> 선생님이 표시를 보냈어요</b>
          {visibleMark.note && <p>{visibleMark.note}</p>}
          <div className="teacher-mark-answers">
            <button type="button" className="button primary" onClick={() => void answerTeacherMark("ok")}><span aria-hidden="true">👍</span> 알겠어요</button>
            <button type="button" className="button secondary" onClick={() => void answerTeacherMark("unsure")}><span aria-hidden="true">🤔</span> 잘 모르겠어요</button>
          </div>
        </div>
      )}
      {viewingNoticeOpen && !visibleMark && (
        <div className="teacher-viewing" role="status">
          선생님이 내 도화지를 보고 있어요.
        </div>
      )}
      <div className={`studio-body ${showGrimiPanel || lesson ? "" : "without-step-panel"}${showGrimiPanel ? " grimi-open" : ""}${showGrimiPanel && grimiCollapsed ? " grimi-collapsed" : ""}${studioTool === "shape" || studioTool === "text" ? " tool-options-open" : ""}`}>
        {showGrimiPanel ? (
          <aside className={`grimi-panel${grimiCollapsed ? " collapsed" : ""}`} aria-live="polite">
            <div className="grimi-head">
              <div>
                <img className="grimi-face" src={`/brand/mongri/${grimiFace}.png`} alt="" aria-hidden="true" width={224} height={224} />
                <b>몽그리</b>
                {/* 아이가 부르지 않았는데 열린 경우, 누가 먼저 말을 걸었는지 알려 준다. */}
                {autoGrimi && <small className="grimi-auto-tag">내가 먼저 말 걸었어</small>}
              </div>
              {/* 펼친 상태의 「그리러 가기」는 답 줄에 있다(시안). 여기 남는 것은 접었을 때 되펼치는 길뿐이다 —
                  같은 자리에 두 개를 두면 아이가 같은 말을 두 번 보게 된다. */}
              {coaching && !grimiLoading && grimiCollapsed && (
                <button className="grimi-collapse" onClick={() => setGrimiCollapsed(false)}>
                  ✨ 몽그리 다시 보기
                </button>
              )}
              <button onClick={dismissGrimi} aria-label="몽그리 닫기">
                ×
              </button>
            </div>
            {grimiCollapsed && coaching ? (
              <div className="grimi-peek">
                <img className="grimi-face grimi-face-small" src="/brand/mongri/suggesting.png" alt="" aria-hidden="true" width={224} height={224} />
                <small>이제 그려 볼 일</small>
                <div className="spoken-prompt">
                  <b>{coaching.nextAction}</b>
                </div>
              </div>
            ) : (
              <div className="grimi-scroll">
                {grimiLoading && (
                  <div className="grimi-thinking">
                    <span>●</span>
                    <span>●</span>
                    <span>●</span>
                    <p>그림을 보고 있어요…</p>
                  </div>
                )}
                {grimiError && <p className="error-box">{grimiError}</p>}
                {coaching && !grimiLoading && (
                  <div className="grimi-coaching">
                    {/* 관찰 한마디 → 궁금한 점 → 지금 그려 볼 일. 아이는 읽고 바로 그리러 간다.
                        growth_event는 판정이 아니라 관찰 문장이라 칭찬 금지 규칙과 부딪히지 않는다. */}
                    {coaching.growthEvent && <p className="grimi-observed">{coaching.growthEvent}</p>}
                    <p className="eyebrow">몽그리가 궁금해요</p>
                    <div className="spoken-prompt">
                      <h2>{coaching.question}</h2>
                    </div>
                    {/* 시안 차례는 질문 → 답하기지만, 그러면 320·844 같은 낮은 화면에서 「이제 그려 볼 일」이
                        접힌 아래로 밀렸다(2026-09-26 browser-check 실측 onScreen:false). 답하지 않아도 무엇을
                        할지 바로 알아야 한다는 보장이 시안 차례보다 앞선다. */}
                    {/* 「이제 그려 볼 일」은 답하기 **전부터** 보인다. 답을 골라야 나타나던 종전 흐름은
                        아이가 무엇을 할지 늦게 알게 했다(2026-09-23에 왕복을 걷어낸 세 이유 중 하나). */}
                    <div className="next-action">
                      <small>이제 그려 볼 일</small>
                      <div className="spoken-prompt">
                        <b>{coaching.nextAction}</b>
                      </div>
                    </div>
                    {replyState === "sent" ? (
                      <p className="grimi-replied" role="status">
                        <span aria-hidden="true">✓</span> 「{replyText}」라고 알려 줬어. 이제 그려 볼까?
                      </p>
                    ) : (
                      <div className="grimi-answer">
                        {coaching.choices.length > 0 && (
                          <div className="grimi-chips" role="group" aria-label="답 고르기">
                            {coaching.choices.map((choice) => {
                              const on = pickedAnswer === choice.answer;
                              return (
                                /* 고른 표시는 색만으로 하지 않는다 — 체크 글자와 aria-pressed를 함께 둔다.
                                   칩을 눌러도 아무 일이 없던 것이 종전 왕복을 걷어낸 세 이유 중 하나였다. */
                                <button type="button" key={choice.label} className={`grimi-chip${on ? " is-on" : ""}`} aria-pressed={on}
                                  onClick={() => { setPickedAnswer(on ? "" : choice.answer); setOwnAnswer(""); setReplyError(""); }}>
                                  <span className="grimi-chip-emoji" aria-hidden="true">{choice.emoji}</span>
                                  <span className="grimi-chip-label">{choice.label}</span>
                                  {on && <span className="grimi-chip-check" aria-hidden="true">✓</span>}
                                </button>
                              );
                            })}
                          </div>
                        )}
                        <label className="grimi-own">
                          <span className="grimi-own-name"><span aria-hidden="true">✏️</span> 내 말로 쓰기</span>
                          <input value={ownAnswer} maxLength={80} placeholder="내 그림은…" enterKeyHint="send"
                            onChange={(event) => { setOwnAnswer(event.target.value); setPickedAnswer(""); setReplyError(""); }}
                            onKeyDown={(event) => { if (event.key === "Enter" && replyText) { event.preventDefault(); void sendReply(); } }} />
                        </label>
                      </div>
                    )}
                    {/* 이 줄은 답하기 블록 **밖에** 있다. 안에 두었더니 답을 보낸 뒤 「그리러 가기」가 같이
                        사라져, 방금 답한 아이에게 남는 길이 이벤트를 dismiss 하는 ×뿐이었다(2026-09-26).
                        낮은 시트에서 이 줄을 바닥에 붙이는 sticky 규칙도 이 wrapper를 잡으므로 함께 옮긴다. */}
                    <div className="grimi-answer-actions">
                      {replyState !== "sent" && (
                        <button type="button" className="button primary grimi-send" disabled={!replyText || replyState === "sending"} onClick={() => void sendReply()}>
                          <span aria-hidden="true">✓</span>{replyState === "sending" ? "보내는 중…" : "이렇게 답할래"}
                        </button>
                      )}
                      <button type="button" className="grimi-collapse grimi-go-draw" onClick={() => setGrimiCollapsed(true)}>
                        <span aria-hidden="true">✏️</span> 그리러 가기
                      </button>
                    </div>
                    {replyError && <p className="grimi-reply-error" role="alert">{replyError}</p>}
                    {/* 「다른 것도 물어보기」는 2026-09-26에 없앴다(사용자 결정). 머리 줄의 「몽그리 부르기」와
                        **완전히 같은 askGrimi()**였고 카드가 열린 동안 둘 다 보여 같은 단추가 둘이었다.
                        다시 묻는 길은 머리 줄 하나로 모은다 — 카드도 그만큼 짧아진다. */}
                  </div>
                )}
              </div>
            )}
            {/* 「그냥 내 마음대로 그릴래」는 2026-09-26에 없앴다(사용자 결정). 머리의 ×와 **완전히 같은**
                dismissGrimi를 불렀다 — 이름만 다른 같은 단추였고, 읽기 전용 시절(답할 것이 없던 때)의
                유물이다. 지금은 나가는 길이 뜻으로 갈린다: × = 몽그리 보내기, 「그리러 가기」 = 접고 그리기. */}
          </aside>
        ) : (
          lesson && (
            <aside className={`step-panel${guideCollapsed ? " collapsed" : ""}`}>
              <button
                type="button"
                className="step-collapse"
                aria-expanded={!guideCollapsed}
                aria-label={guideCollapsed ? "지금 할 일 펼치기" : "지금 할 일 접기"}
                onClick={() => setGuideCollapsed((value) => !value)}
              >
                <ChevronUpIcon size={20} />
              </button>
              <div className="reference-tile">
                <span className="reference-emoji" aria-hidden="true">{lesson.emoji}</span>
                <small>{lesson.mode === "observe" ? `${lesson.topic} 관찰하기` : lesson.mode === "guided" ? `${lesson.topic} 색칠 완성 예시` : `${lesson.topic} 그려 보기`}</small>
              </div>
              <p className="eyebrow">지금 할 일</p>
              <div className="spoken-prompt lesson-spoken-prompt">
                <h2>{lesson.steps[step].instruction}</h2>
              </div>
              {lesson.steps[step].choices?.length && (
                <>
                  <div className="choice-chips">
                    {lesson.steps[step].choices.map((choice) => (
                      <button aria-pressed={childChoice === choice} onClick={() => chooseChildChoice(choice)} key={choice}>
                        {choice}
                      </button>
                    ))}
                  </div>
                  {choiceFeedback && <p className="choice-feedback" role="status">✓ {choiceFeedback}</p>}
                </>
              )}
              {guideControls()}
              <div className="step-actions">
                <button disabled={Boolean(conflictDraft) || step === 0} onClick={() => changeLessonStep(-1)}>
                  ⬅️ 이전
                </button>
                <button disabled={Boolean(conflictDraft)} onClick={() => advanceOrCompleteLessonStep(false)}>
                  <span aria-hidden="true">{step === lesson.steps.length - 1 ? "⭐" : "➡️"}</span>
                  {guardedNextStepLabel}
                </button>
              </div>
              {lessonStepPrompt && (
                <div className="lesson-step-prompt" role="status" aria-live="polite">
                  <div className="spoken-prompt">
                    <b>{lessonStepPrompt === "unfinished-lesson" ? "아직 그릴 순서가 남았어. 다음을 눌러 천천히 이어 가자." : lessonStepPromptText}</b>
                  </div>
                  <div className="lesson-step-prompt-actions">
                    <button type="button" onClick={() => setLessonStepPrompt(null)}>
                      ✏️ 더 그릴래
                    </button>
                    {lessonStepPrompt === "unfinished-lesson" ? (
                      <button type="button" onClick={() => { setLessonStepPrompt(null); openReflection(); }}>
                        ⭐ 지금 완성
                      </button>
                    ) : (
                      <button type="button" onClick={() => advanceOrCompleteLessonStep(true)}>
                        ⭐ 지금 완성
                      </button>
                    )}
                  </div>
                </div>
              )}
              <button className="text-button" onClick={chooseIndependentDrawing}>
                🎨 그냥 그릴래
              </button>
            </aside>
          )
        )}
        <section className={`canvas-zone${canvasGuideStatus ? " has-canvas-status" : ""}`} ref={canvasZoneRef}>
          {canvasGuideStatus && (
            <div className="canvas-status-rail">
              <div className="guide-notice" role="status" aria-live="polite">
                {currentLessonActivity === "color" ? "🖍️" : guidePhase === "demo" ? "✏️" : "🟢"} {canvasGuideStatus}
              </div>
            </div>
          )}
          <div
            className="canvas-wrap"
            ref={wrapRef}
            /* 도화지 비율은 문서가 정한다. 기존 정사각 작품(height 없음)은 1/1 그대로다. */
            style={{
              "--paper-aspect": `${DOCUMENT_SIZE} / ${documentHeight(documentState)}`,
              "--paper-ratio": `${DOCUMENT_SIZE / documentHeight(documentState)}`,
            } as React.CSSProperties}
            onContextMenu={(event) => event.preventDefault()}
            onDragStart={(event) => event.preventDefault()}
          >
            {guideChoiceOpen && (
              <div className="guide-choice-overlay" role="dialog" aria-modal="true" aria-labelledby="guide-choice-title">
                <section className="guide-choice-card">
                  <div className="guide-choice-heading">
                    <span aria-hidden="true">🖍️</span>
                    <div><p className="eyebrow">그리기 시작</p><h2 id="guide-choice-title">어떻게 시작할까?</h2></div>
                  </div>
                  <div className="guide-choice-buttons">
                    <button type="button" onClick={chooseGuideHelp}><span>✏️</span><b>도움받을래</b><small>연필 시범 뒤 점선을 따라 해요</small></button>
                    <button type="button" onClick={chooseGuideSolo}><span>🎨</span><b>내가 먼저 그릴래</b><small>점선 없이 내 생각대로 시작해요</small></button>
                  </div>
                </section>
              </div>
            )}
            {!lesson && !documentState.ops.length && !shapeStartPoint && (
              <div className="canvas-start-hint" role="status">
                ✏️ 하얀 종이에 그어 봐!
              </div>
            )}
            {shapeStartPoint && (
              <div className="canvas-start-hint" role="status">
                🟢 끝나는 곳을 콕 눌러 줘!
              </div>
            )}
            {pendingText && (
              <div className="canvas-start-hint text-place-hint" role="status">
                👆 “{pendingText.text}”을 놓을 곳을 콕 눌러 줘!
              </div>
            )}
            {canvasFull && (
              <div className="canvas-full-hint" role="alert">
                {/* 「종이가 가득 찼다」는 거짓말이었다 — 여백이 많아도 저장 용량이 먼저 찬다(2026-09-26 운영 보고).
                    아이가 화면을 보고 납득할 수 있는 말로 바꾼다. */}
                <span aria-hidden="true">🌟</span> 그림이 아주 커졌어! ‘완성’을 눌러 저장하자.
              </div>
            )}
            <div
              className="canvas-stack"
              style={{
                width: paper.width || undefined,
                height: paper.height || undefined,
                transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
              }}
            >
              <canvas ref={guideRef} className={guidePhase !== "independent" && lessonGuideAvailable ? "guide-canvas" : "guide-canvas hidden"} aria-hidden="true" />
              <canvas ref={markRef} className={visibleMark ? "mark-canvas" : "mark-canvas hidden"} aria-hidden="true" />
              {mirror && <div className="mirror-axis" aria-hidden="true" />}
              {shapeStartPoint && (
                <div
                  className="shape-start-dot"
                  aria-hidden="true"
                  style={{
                    left: `${shapeStartPoint.x * 100}%`,
                    top: `${shapeStartPoint.y * 100}%`,
                  }}
                />
              )}
              <div ref={eraserFootprintRef} className="eraser-footprint" hidden aria-hidden="true" />
              <canvas
                ref={canvasRef}
                className="draw-canvas"
                onPointerDown={pointerDown}
                onPointerMove={pointerMove}
                onPointerUp={pointerUp}
                onPointerCancel={pointerCancel}
                onPointerEnter={(event) => updateEraserFootprint(event)}
                onContextMenu={(event) => event.preventDefault()}
                onDragStart={(event) => event.preventDefault()}
                onPointerLeave={(event) => {
                  if (!event.currentTarget.hasPointerCapture(event.pointerId)) hideEraserFootprint();
                }}
                aria-disabled={Boolean(conflictDraft)}
                aria-label="그림 그리는 도화지"
              />
              {/* 그리는 중인 반투명 획만 올리는 얇은 층. 도화지 픽셀을 건드리지 않으므로
                  획마다 34MB짜리 스냅숏을 뜨고 되돌릴 일이 없다(2026-09-21 애플 펜슬 지연). */}
              <canvas ref={liveCanvasRef} className="live-canvas" aria-hidden="true" />
              {studioTool === "text" && selectedText && (
                <button
                  type="button"
                  className="text-object-selection"
                  aria-label={`글씨 ${selectedText.text}. 끌어서 옮기기`}
                  style={{
                    left: `${(textDragPoint?.x ?? selectedText.points[0].x) * 100}%`,
                    top: `${(textDragPoint?.y ?? selectedText.points[0].y) * 100}%`,
                    width: `${selectedText.textKind === "title" ? 82 : selectedText.textKind === "speech" ? 60 : 56}%`,
                    height: `${selectedText.textKind === "speech" ? Math.max(20, selectedText.fontSize / 3.4) : Math.max(12, selectedText.fontSize / 5.2)}%`,
                  }}
                  onPointerDown={startTextDrag}
                  onPointerMove={moveTextDrag}
                  onPointerUp={(event) => finishTextDrag(event, true)}
                  onPointerCancel={(event) => finishTextDrag(event, false)}
                >
                  <span>✥ 끌어서 옮겨요</span>
                </button>
              )}
              {studioTool === "move" && selectedObject && selectedObjectBox && (
                <>
                  <button
                    type="button"
                    className="text-object-selection"
                    aria-label={`${selectedObject.type === "sticker" ? "스티커" : "도형"}. 끌어서 옮기기`}
                    style={{
                      left: `${(selectedObjectBox.x + selectedObjectBox.width / 2) * 100}%`,
                      top: `${(selectedObjectBox.y + selectedObjectBox.height / 2) * 100}%`,
                      width: `${selectedObjectBox.width * 100}%`,
                      height: `${selectedObjectBox.height * 100}%`,
                    }}
                    onPointerDown={startObjectDrag}
                    onPointerMove={moveObjectDrag}
                    onPointerUp={(event) => finishObjectDrag(event, true)}
                    onPointerCancel={(event) => finishObjectDrag(event, false)}
                  >
                    <span>✥ 끌어서 옮겨요</span>
                  </button>
                  {!objectDrag && (
                    <button
                      type="button"
                      className="object-delete object-resize"
                      aria-label="끌어서 크기 바꾸기"
                      title="크기 바꾸기"
                      style={{ left: `${Math.min(0.97, selectedObjectBox.x + selectedObjectBox.width) * 100}%`, top: `${Math.min(0.97, selectedObjectBox.y + selectedObjectBox.height) * 100}%` }}
                      onPointerDown={startObjectResize}
                      onPointerMove={moveObjectResize}
                      onPointerUp={(event) => finishObjectResize(event, true)}
                      onPointerCancel={(event) => finishObjectResize(event, false)}
                    >
                      <span aria-hidden="true">⤡</span>
                    </button>
                  )}
                  {!objectDrag && !objectScale && (
                    <button
                      type="button"
                      className="object-delete"
                      aria-label="고른 것 지우기"
                      title="지우기"
                      style={{ left: `${Math.min(0.97, selectedObjectBox.x + selectedObjectBox.width) * 100}%`, top: `${Math.max(0.03, selectedObjectBox.y) * 100}%` }}
                      onClick={() => { if (updateDrawObject(selectedObject, { deleted: true })) setSaveState("지웠어요. 되돌리기로 다시 가져올 수 있어요"); }}
                    >
                      <Trash2Icon />
                    </button>
                  )}
                </>
              )}
            </div>
            {/* 확대·축소(2026-09-15 사용자 요청). 가운데 숫자를 누르면 화면 맞춤으로 돌아간다.
                두 손가락 벌리기·트랙패드도 같은 배율을 쓴다. */}
            <div className="zoom-controls" role="group" aria-label="확대와 축소">
              <button type="button" aria-label="확대" title="확대" disabled={view.scale >= MAX_SCALE - 0.001} onClick={() => zoomBy(1.5)}>+</button>
              <button type="button" className="zoom-fit" aria-label={`지금 ${Math.round(view.scale * 100)}%, 원래 크기로`} title="원래 크기로" disabled={Math.abs(view.scale - 1) < 0.01} onClick={resetViewToFit}>{Math.round(view.scale * 100)}%</button>
              <button type="button" aria-label="축소" title="축소" disabled={view.scale <= minScaleFor(span) + 0.001} onClick={() => zoomBy(1 / 1.5)}>−</button>
            </div>
          </div>
        </section>
        {/* 도구 막대(2026-09-14 사용자 결정 — 시안 docs/design-assets/studio-tool-dock/B-crayon-box.webp).
            화면 아래에 떠 있는 크림색 막대에 세워진 도구, 고른 도구는 올라오고 진초록 바탕. 붓 끝·띠는 지금 색으로 칠한다.
            고른 도구를 한 번 더 누르면 굵기 자가 위에 뜬다. 채우기·도형·글씨·입력 방법은 ⋯ 안에 있다. */}
        {/* 도화지는 CSS(선택·끌기 금지)와 onDragStart 방어를 **둘 다** 갖고 있다. 막대는 2026-09-23에
            CSS만 받았고, 그 커밋도 "실기기 재확인이 필요하다"고 적어 두었다 — 아이패드에서 도구가 계속
            끌린다는 제보(2026-09-26)가 이어졌다. 같은 JS 방어를 막대에도 건다.
            끌기 이벤트는 위로 올라오므로 막대 하나에 걸면 안의 도구 그림·색 단추가 모두 덮인다. */}
        <aside className={`tool-dock${dockOpen ? "" : " is-collapsed"}`} aria-label="그리기 도구 모음" style={{ "--dock-color": selectedColor } as React.CSSProperties}
          onDragStart={(event) => event.preventDefault()}
          onContextMenu={(event) => event.preventDefault()}>
          {/* 아코디언(2026-09-15 사용자: "누르면 위로 올라가고 내리면 아래로 내려가는 느낌"): 막대가 화면 아래로 미끄러져 내려가고 손잡이 탭만 남는다. */}
          <button
            type="button"
            className="dock-toggle"
            aria-expanded={dockOpen}
            aria-label={dockOpen ? "그리기 도구 접기" : "그리기 도구 펼치기"}
            onPointerDown={(event) => { dockSwipeRef.current = event.clientY; event.currentTarget.setPointerCapture(event.pointerId); }}
            onPointerUp={(event) => { dockSwipeRef.current = dockSwipeRef.current === null ? null : event.clientY - dockSwipeRef.current; }}
            onClick={() => {
              // 손잡이를 아래로 끌면 접고 위로 끌면 편다. 끌지 않고 누르면 번갈아 바꾼다.
              const moved = dockSwipeRef.current ?? 0;
              dockSwipeRef.current = null;
              setDockOpen((open) => (moved > 16 ? false : moved < -16 ? true : !open));
              setWidthSliderOpen(false); setPaletteOpen(false); setToolSheetOpen(false);
            }}
          >
            <ChevronUpIcon size={20} />{!dockOpen && <span>도구</span>}
          </button>
          <div className="dock-history" role="group" aria-label="그리기 기록">
            <button type="button" aria-label="되돌리기" title="되돌리기" onClick={undo} disabled={Boolean(conflictDraft) || (!documentState.ops.length && !hasClearToUndo)}>
              <Undo2Icon size={22} />
            </button>
            <button type="button" aria-label="다시하기" title="다시하기" onClick={redoLast} disabled={Boolean(conflictDraft) || (!redo.length && !hasClearToRedo)}>
              <Redo2Icon size={22} />
            </button>
            {/* 전체 지우기는 2026-09-20 사용자 요청으로 ⋯ 안에서 막대로 꺼냈다. 실수로 눌러도 확인 창을 지나고 되돌리기 한 번으로 되살아난다. */}
            <button type="button" className="dock-clear" aria-label="전체 지우기" title="전체 지우기" onClick={() => setClearConfirmOpen(true)} disabled={Boolean(conflictDraft) || !documentState.ops.length}>
              <Trash2Icon size={22} />
            </button>
          </div>
          <div className="dock-tools" role="group" aria-label="도구">
            {DOCK_TOOLS.map((tool) => (
              <button type="button" className={`dock-tool dock-tool-${tool.id}`} aria-label={tool.label} title={tool.label} aria-pressed={studioTool === tool.id} onClick={() => chooseStudioTool(tool.id)} key={tool.id}>
                <span className="dock-tool-art" aria-hidden="true">
                  <img src={`/drawing-tools/dock/${tool.id}.webp`} alt="" width={96} height={144} draggable={false} />
                  {tool.tint && <i className="dock-tool-tint" style={{ WebkitMaskImage: `url(/drawing-tools/dock/${tool.id}-tint.webp)`, maskImage: `url(/drawing-tools/dock/${tool.id}-tint.webp)` }} />}
                </span>
              </button>
            ))}
            <button type="button" className="dock-tool dock-tool-mirror" aria-label="좌우 대칭" title="좌우 대칭" aria-pressed={mirror} onClick={() => setMirror((value) => !value)}>
              <span className="dock-tool-art" aria-hidden="true"><img src="/drawing-tools/dock/mirror.webp" alt="" width={96} height={144} draggable={false} /></span>
            </button>
            {studioTool !== "text" && widthSliderOpen && (
              <div className="dock-width" role="group" aria-label="선 굵기">
                {/* 끌어서 1픽셀씩 고르고, 손끝으로 맞추기 어려운 마지막 한두 칸은 −·+로 옮긴다. */}
                <button type="button" aria-label="1픽셀 얇게" disabled={width <= STROKE_WIDTH_MIN} onClick={() => chooseWidth(width - 1)}>−</button>
                <input type="range" min={STROKE_WIDTH_MIN} max={STROKE_WIDTH_SCREEN_MAX} step={1} value={width} aria-label="선 굵기" aria-valuetext={`${width}픽셀`} onChange={(event) => chooseWidth(Number(event.target.value))} style={{ "--dock-width-fill": `${((width - STROKE_WIDTH_MIN) / (STROKE_WIDTH_SCREEN_MAX - STROKE_WIDTH_MIN)) * 100}%` } as React.CSSProperties} />
                <button type="button" aria-label="1픽셀 굵게" disabled={width >= STROKE_WIDTH_SCREEN_MAX} onClick={() => chooseWidth(width + 1)}>+</button>
                <output className="dock-width-value" aria-hidden="true">
                  {/* 지우개는 색을 쓰지 않는 도구라 점을 기본 잉크색으로 남겨 "지우는 크기"임을 구분한다. */}
                  <i style={{ width: Math.max(2, Math.round(width * 0.53)), height: Math.max(2, Math.round(width * 0.53)), background: studioTool === "eraser" ? undefined : selectedColor }} />
                  <b>{width}</b>
                </output>
              </div>
            )}
          </div>
          <div className="dock-colors" role="group" aria-label="색 고르기">
            {PALETTE.slice(0, DOCK_QUICK_COLORS).map((value) => (
              <button type="button" className="dock-color" aria-label={COLOR_NAMES[value]} title={COLOR_NAMES[value]} aria-pressed={selectedColor === value} onClick={() => pickColor(value)} key={value} style={{ background: value }} />
            ))}
            {/* 단색 점: 누르면 단색 12색 창이 열린다. 좁은 화면에서는 색 점 여덟 개 대신 이것만 보인다. */}
            <button type="button" className="dock-current-color" aria-label={`색 고르기, 지금 ${COLOR_NAMES[selectedColor] ?? "고른 색"}`} aria-haspopup="true" aria-expanded={paletteOpen} onClick={() => { setPaletteOpen((value) => !value); setToolSheetOpen(false); setWidthSliderOpen(false); }} style={{ background: selectedColor }} />
            {/* 무지개는 섞는 색 화면으로 바로 간다(2026-09-20 사용자 결정). 단색 점과 같은 창을 열면
                두 단추가 같은 일을 해 무엇이 무엇인지 아이가 구분할 수 없었다.
                팔레트 밖의 색을 쓰는 동안은 눌린 상태로 두고 고른 색을 안쪽 테두리로 보여 준다. */}
            <button type="button" className="dock-more-colors" aria-label="색 섞어 고르기" title="색 섞어 고르기" aria-haspopup="dialog" aria-expanded={colorPickerOpen} aria-pressed={customColor} style={customColor ? { boxShadow: `inset 0 0 0 6px ${selectedColor}` } : undefined} onClick={() => { setPaletteOpen(false); setToolSheetOpen(false); setWidthSliderOpen(false); setColorPickerOpen(true); }} />
            {/* 단색 점이 여는 창에는 단색만 둔다. 섞는 색은 무지개 단추 몫이다. */}
            {paletteOpen && (
              <div className="dock-palette" role="group" aria-label="단색 고르기">
                {PALETTE.map((value) => (
                  <button type="button" className="dock-color" aria-label={COLOR_NAMES[value]} title={COLOR_NAMES[value]} aria-pressed={selectedColor === value} onClick={() => { pickColor(value); setPaletteOpen(false); }} key={value} style={{ background: value }} />
                ))}
              </div>
            )}
          </div>
          <button
            type="button"
            className="dock-more"
            aria-label={toolSheetOpen ? "다른 도구 닫기" : "다른 도구 더 보기"}
            aria-expanded={toolSheetOpen}
            onClick={() => { setToolSheetOpen((value) => !value); setWidthSliderOpen(false); setPaletteOpen(false); }}
          >
            <MoreHorizontalIcon />
          </button>
          {toolSheetOpen && (
            <div className="dock-sheet">
                <div className="tool-group make-group" role="group" aria-label="채우기와 도형">
                  <button type="button" aria-label="채우기" title="채우기" aria-pressed={studioTool === "fill"} onClick={() => chooseStudioTool("fill")}>
                    <span className="tool-icon" aria-hidden="true">
                      🪣
                    </span>
                    <span className="tool-name" aria-hidden="true">
                      채우기
                    </span>
                  </button>
                  <button type="button" aria-label="도형" title="도형" aria-pressed={studioTool === "shape"} onClick={() => chooseStudioTool("shape")}>
                    <span className="tool-icon" aria-hidden="true">
                      ⬠
                    </span>
                    <span className="tool-name" aria-hidden="true">
                      도형
                    </span>
                  </button>
                  <button
                    type="button"
                    aria-label="글씨"
                    title="글씨"
                    aria-pressed={studioTool === "text"}
                    onClick={() => {
                      chooseStudioTool("text");
                      openTextComposer(selectedText);
                    }}
                  >
                    <span className="tool-icon text-tool-icon" aria-hidden="true">Aa</span>
                    <span className="tool-name" aria-hidden="true">글씨</span>
                  </button>
                  <button type="button" aria-label="옮기기, 도형과 스티커 옮기기" title="옮기기" aria-pressed={studioTool === "move"} onClick={() => chooseStudioTool("move")}>
                    <span className="tool-icon text-tool-icon" aria-hidden="true">✥</span>
                    <span className="tool-name" aria-hidden="true">옮기기</span>
                  </button>
                  <button type="button" aria-label="스티커" title="스티커" aria-pressed={studioTool === "sticker"} onClick={() => chooseStudioTool("sticker")}>
                    <span className="tool-icon" aria-hidden="true">{STICKER_EMOJI.star}</span>
                    <span className="tool-name" aria-hidden="true">스티커</span>
                  </button>
                  <button type="button" aria-label="스포이드, 그림에서 색 뽑기" title="스포이드" aria-pressed={studioTool === "pipette"} onClick={() => chooseStudioTool("pipette")}>
                    <span className="tool-icon" aria-hidden="true">💧</span>
                    <span className="tool-name" aria-hidden="true">스포이드</span>
                  </button>
                </div>
                {studioTool === "sticker" && (
                  <div className="shape-options">
                    <div className="shape-kind-row sticker-kind-row" role="group" aria-label="스티커 고르기">
                      {STICKER_ALLOWLIST.map((kind) => (
                        <button type="button" aria-label={STICKER_LABELS[kind]} title={STICKER_LABELS[kind]} aria-pressed={stickerKind === kind} onClick={() => setStickerKind(kind)} key={kind}>
                          <span aria-hidden="true">{STICKER_EMOJI[kind]}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {studioTool === "shape" && (
                  <div className="shape-options">
                    <div className="shape-kind-row" role="group" aria-label="도형 고르기">
                      {SHAPE_KINDS.slice(0, moreShapes ? SHAPE_KINDS.length : BASIC_SHAPE_COUNT).map((item) => (
                        <button
                          type="button"
                          aria-label={item.label}
                          title={item.label}
                          aria-pressed={shapeKind === item.kind}
                          onClick={() => {
                            setShapeKind(item.kind);
                            if (item.kind === "line" || item.kind === "curve") setShapeFilled(false);
                            clearShapeStart();
                          }}
                          key={item.kind}
                        >
                          {item.icon}
                        </button>
                      ))}
                      <button type="button" className="shape-more" aria-label={moreShapes ? "도형 접기" : "더 많은 도형"} title={moreShapes ? "도형 접기" : "더 많은 도형"} aria-expanded={moreShapes} onClick={() => setMoreShapes((value) => !value)}>
                        {moreShapes ? "−" : "＋"}
                      </button>
                    </div>
                    <div className="shape-fill-row" role="group" aria-label="도형 안쪽">
                      <button type="button" aria-pressed={!shapeFilled} onClick={() => setShapeFilled(false)}>
                        테두리
                      </button>
                      <button type="button" aria-pressed={shapeFilled} disabled={shapeKind === "line" || shapeKind === "curve"} onClick={() => setShapeFilled(true)}>
                        색 채움
                      </button>
                    </div>
                  </div>
                )}
                {studioTool === "text" && (
                  <div className="text-options" aria-label="글씨 고치기">
                    {pendingText ? (
                      <div className="text-pending-card" role="status">
                        <b>“{pendingText.text}”</b>
                        <span>도화지에 놓을 곳을 눌러요.</span>
                        <button type="button" onClick={() => setPendingText(null)}>취소</button>
                      </div>
                    ) : selectedText ? (
                      <>
                        <div className="text-edit-heading"><span>고른 글씨</span><b>{selectedText.text}</b></div>
                        <div className="text-edit-actions">
                          <button type="button" onClick={() => openTextComposer(selectedText)}>✏️ 내용</button>
                          <button
                            type="button"
                            aria-label="글씨 작게"
                            disabled={toScreenUnits(selectedText.fontSize, span) === TEXT_SIZES[0]}
                            onClick={() => {
                              const index = TEXT_SIZES.indexOf(toScreenUnits(selectedText.fontSize, span) as TextSize);
                              if (index > 0) updateTextObject(selectedText, { fontSize: documentWidthUnits(TEXT_SIZES[index - 1]) });
                            }}
                          >Aa−</button>
                          <button
                            type="button"
                            aria-label="글씨 크게"
                            disabled={toScreenUnits(selectedText.fontSize, span) === TEXT_SIZES.at(-1)}
                            onClick={() => {
                              const index = TEXT_SIZES.indexOf(toScreenUnits(selectedText.fontSize, span) as TextSize);
                              if (index >= 0 && index < TEXT_SIZES.length - 1) updateTextObject(selectedText, { fontSize: documentWidthUnits(TEXT_SIZES[index + 1]) });
                            }}
                          >Aa＋</button>
                          <button type="button" className="text-delete" onClick={() => updateTextObject(selectedText, { deleted: true })}>🗑️ 지우기</button>
                        </div>
                        <button type="button" className="text-new-button" disabled={textObjects.length >= MAX_TEXT_OBJECTS} onClick={() => openTextComposer()}>＋ 새 글씨</button>
                      </>
                    ) : (
                      <button type="button" className="text-new-button" disabled={textObjects.length >= MAX_TEXT_OBJECTS} onClick={() => openTextComposer()}>＋ 새 글씨 쓰기</button>
                    )}
                  </div>
                )}
                <div className="input-mode-control" role="group" aria-label="그리기 입력 방법">
                  <button type="button" aria-pressed={inputMode === "pen"} onClick={enablePenMode}><span>✍️</span><b>펜 모드</b><small>손바닥은 그려지지 않아요</small></button>
                  <button type="button" aria-pressed={inputMode === "finger"} onClick={disablePenMode}><span>☝️</span><b>손가락 모드</b><small>손가락으로 그려요</small></button>
                </div>
            </div>
          )}
        </aside>
      </div>
      {clearConfirmOpen && (
        <div className="modal-backdrop" ref={clearConfirmDialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="clear-confirm-title">
          <section className="reflection-modal clear-confirm-modal">
            <p className="modal-emoji" aria-hidden="true">🗑️</p>
            <h2 id="clear-confirm-title">정말 다 지울까요?</h2>
            <p>지금까지 그린 그림이 모두 사라져요. 지우고 나서도 되돌리기를 누르면 다시 가져올 수 있어요.</p>
            <div className="modal-actions">
              <button type="button" className="button secondary" onClick={() => setClearConfirmOpen(false)}>아니요</button>
              <button type="button" className="button primary" onClick={confirmClearAll}>네, 다 지울래요</button>
            </div>
          </section>
        </div>
      )}
      {colorPickerOpen && <ColorPickerDialog color={selectedColor} names={COLOR_NAMES} onPick={(value) => {
        pickColor(value);
        setColorPickerOpen(false);
      }} onClose={() => setColorPickerOpen(false)} />}
      {textComposerOpen && (
        <div className="modal-backdrop" ref={textDialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="text-composer-title">
          <section className="text-composer-modal">
            <button className="modal-close" onClick={closeTextComposer} aria-label="글씨 창 닫기">×</button>
            <div className="text-composer-title-row">
              <span aria-hidden="true">🔤</span>
              <div><p className="eyebrow">그림에 글씨 넣기</p><h2 id="text-composer-title">무슨 말을 쓸까?</h2></div>
            </div>
            <div className="text-kind-grid" role="group" aria-label="글씨 모양">
              {TEXT_KIND_OPTIONS.map((option) => (
                <button
                  type="button"
                  aria-pressed={textKind === option.kind}
                  onClick={() => {
                    setTextKind(option.kind);
                    setTextDraft((value) => clampText(value, option.kind));
                  }}
                  key={option.kind}
                >
                  <span>{option.icon}</span><b>{option.label}</b><small>{option.help}</small>
                </button>
              ))}
            </div>
            <label className="text-entry-label" htmlFor="drawing-text-input">짧게 써 봐</label>
            <textarea
              id="drawing-text-input"
              autoFocus
              rows={2}
              value={textDraft}
              placeholder={textKind === "title" ? "예: 달빛 고양이" : textKind === "speech" ? "예: 같이 놀자!" : "예: 우리 집"}
              onChange={(event) => setTextDraft(clampText(event.target.value, textKind))}
            />
            <div className="text-entry-meta">
              <span>🎤 키보드의 마이크로 말해도 돼요.</span>
              <b>{drawingTextGraphemes(normalizeDrawingText(textDraft)).length}/{MAX_TEXT_GRAPHEMES[textKind]}</b>
            </div>
            <div className="text-size-picker" role="group" aria-label="글씨 크기">
              <span>크기</span>
              {TEXT_SIZES.map((size, index) => (
                <button type="button" aria-pressed={textSize === size} onClick={() => setTextSize(size)} key={size}>
                  <span style={{ fontSize: `${16 + index * 4}px` }}>Aa</span>
                  <small>{index === 0 ? "작게" : index === 1 ? "보통" : "크게"}</small>
                </button>
              ))}
            </div>
            <div className={`text-composer-preview ${textKind}`} style={{ color }} aria-label="글씨 미리 보기">{normalizeDrawingText(textDraft) || "미리 보기"}</div>
            <div className="modal-actions text-composer-actions">
              <button type="button" className="button secondary" onClick={closeTextComposer}>취소</button>
              {!editingTextObjectId && (
                <button type="button" className="button secondary" disabled={!normalizeDrawingText(textDraft)} onClick={placeTextInSuggestedSpot}>✨ 빈 곳 추천</button>
              )}
              <button type="button" className="button primary" disabled={!normalizeDrawingText(textDraft)} onClick={submitTextComposer}>
                {editingTextObjectId ? "✓ 바꾸기" : "👆 놓을 곳 고르기"}
              </button>
            </div>
          </section>
        </div>
      )}
      {reflectionOpen && (
        <div className="modal-backdrop" ref={reflectionDialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="reflection-title">
          <section className="reflection-modal">
            <button className="modal-close" disabled={completionState === "saving"} onClick={closeReflection} aria-label="닫기">
              ×
            </button>
            <span className="modal-emoji">🌟</span>
            <div className="reflection-title-row">
              <h2 id="reflection-title">네 그림을 소개해 줘!</h2>
            </div>
            <p className="reflection-choice-note">정답이 아니에요. 네가 보고 직접 골라요.</p>
            {/* 이 칸은 **늘** 그린다. 종전에는 짐작이 오지 않으면(몽그리가 쉬거나 요청이 실패) 통째로
                사라져, 「네 그림을 소개해 줘!」가 제목과 단추만 남은 빈 화면이 됐다(2026-09-28 사용자 제보).
                짐작이 없어도 아이가 자기 말로 알려 줄 칸은 남는다. */}
            <div className="reflection-question mongri-guess">
              {/* 짐작을 기다릴 때는 생각 중, 짐작이 나오면 발견한 표정이다. */}
              <p className="mongri-guess-head"><img className="grimi-face grimi-face-small" src={`/brand/mongri/${interpretation ? "delighted" : "thinking"}.png`} alt="" aria-hidden="true" width={224} height={224} /> 몽그리 생각</p>
              {interpretLoading && !interpretation && <p className="mongri-guess-waiting">몽그리가 네 그림을 보고 있어…<span className="bounce-dots" aria-hidden="true"><i /><i /><i /></span></p>}
              {!interpretLoading && !interpretation && <p className="mongri-guess-waiting">몽그리가 지금은 네 그림을 못 봤어. 네가 알려 줄래?</p>}
              {interpretation && (
                <>
                  {/* AI가 만든 문장은 음성으로 내보내지 않는다 (product-decisions 20항).
                      답 칩의 이모지가 글과 함께 읽기 부담을 덜어 준다. */}
                  <p className="mongri-guess-text">{interpretation.guess}</p>
                  <div className="reflection-choice-grid">
                    {interpretation.choices.map((choice) => (
                      <button type="button" aria-pressed={storyText === choice.answer} onClick={() => setStoryText(choice.answer)} key={choice.label}>
                        <span>{choice.emoji}</span>
                        {choice.label}
                      </button>
                    ))}
                  </div>
                </>
              )}
              <label className="mongri-guess-own" htmlFor="story-text">
                내 말로 알려 줄래?
                <input id="story-text" maxLength={120} value={storyText} onChange={(event) => setStoryText(event.target.value)} placeholder="예: 아니야, 자전거 바퀴야" />
              </label>
            </div>
            <div className="modal-actions">
              <button className="button secondary" disabled={completionState === "saving"} onClick={closeReflection}>
                🎨 더 그릴래
              </button>
              <button className="button primary child-primary-action" aria-busy={completionState === "saving"} disabled={completionState === "saving"} onClick={complete}>
                <span aria-hidden="true">{completionState === "saving" ? "⏳" : "⭐"}</span>{completionState === "saving" ? "작품을 안전하게 저장 중…" : completionState === "error" ? "다시 저장하기" : "작품 완성"}
              </button>
            </div>
            {completionState === "error" && <p className="completion-error" role="alert">{completionError}</p>}
          </section>
        </div>
      )}
      {/* 저장하는 동안은 화면 전체를 덮는다(2026-09-25 사용자 요청). 단추 안에서만 도는 표시는
          아이 눈에 잘 안 띄어 그동안 다른 것을 누르려 든다. 이 막은 모달보다 위(z-index 30)에 있어
          뒤쪽 누르기를 전부 받아 삼킨다 — 닫기·단추는 이미 disabled라 탭으로도 닿지 않는다. */}
      {completionState === "saving" && (
        <div className="saving-veil" role="status" aria-live="assertive">
          <div className="saving-veil-card">
            <img src="/brand/mongri/reassuring.png" alt="" aria-hidden="true" width={224} height={224} />
            <b>몽그리가 그림을 옮기고 있어요</b>
            <span className="bounce-dots" aria-hidden="true"><i /><i /><i /></span>
            <small>잠깐만 기다려 줘. 창을 닫지 않아도 돼요.</small>
          </div>
        </div>
      )}
    </main>
  );
}
