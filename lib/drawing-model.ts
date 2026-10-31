export const DRAWING_SCHEMA_VERSION = 1;
export const RENDERER_VERSION = 1;
export const DOCUMENT_SIZE = 1024;
/* 도화지 세로. 좌표는 x·y 모두 0~1로 정규화돼 있으므로 세로를 바꾸면 같은 문서가 다르게 그려진다.
 * 그래서 세로는 문서에 함께 저장하고, `height`가 없는 기존 문서는 예전처럼 정사각(1024)으로 읽는다.
 *
 * 시안의 도화지는 화면을 가득 채운다. 그래서 새 작품은 첫 획을 긋기 전까지 화면에 맞춰
 * 세로를 정한다(아래 clampDocumentHeight). 한 번이라도 그리면 그 비율로 굳는다 — 그린 뒤에
 * 비율을 바꾸면 이미 그린 선이 늘어나기 때문이다.
 * 범위를 둔 이유: 아무 값이나 받으면 저장된 그림의 비율을 마음대로 바꿀 수 있고, 극단적인
 * 비율은 썸네일·그림책 배치를 깨뜨린다. 세로는 정수로 저장한다.
 * 2026-09-15 사용자 결정("도화지는 항상 어떤기기 든지 화면을 꽉채우게")으로 가로로 눕힌 휴대폰(약 3:1)과
 * 세로 휴대폰(약 1:2)까지 넓혔다. 예전 범위(512~1024)는 그대로 안에 있어 옛 작품이 열린다.
 * 같은 결정으로 16 단위 반올림을 1로 바꿨다 — 16 단위면 가로 휴대폰에서 도화지 양옆에 6px씩 초록 여백이 남았다. */
export const DOCUMENT_MIN_HEIGHT = 320;
export const DOCUMENT_MAX_HEIGHT = 2240;
export const DOCUMENT_HEIGHT_STEP = 1;

/* 도화지 넓이(2026-09-20 사용자 결정: "엄청 큰 도화지 … 축소하면 도화지가 확장되는 느낌", 2번 안).
 * `span`은 "100%로 볼 때 도화지가 화면 몇 개 너비인가"다. 좌표는 여전히 도화지 안의 0~1이고
 * 가로 단위도 1024 그대로라, 저장 형식과 렌더러는 바뀌지 않는다 — 화면에서 얼마나 크게 펼쳐 보이는지만 달라진다.
 * 옛 작품은 `span`이 없어 1(=화면 한 장)로 읽히므로 예전과 똑같이 열린다. */
export const DOCUMENT_SPANS = [1, 2, 3] as const;
export type DocumentSpan = (typeof DOCUMENT_SPANS)[number];
export const NEW_DOCUMENT_SPAN: DocumentSpan = 3;
export const isDocumentSpan = (value: unknown): value is DocumentSpan => DOCUMENT_SPANS.includes(value as DocumentSpan);
export function documentSpan(document: Pick<DrawDocument, "span">): DocumentSpan {
  return document.span ?? 1;
}
/** 화면에서 고른 크기(굵기·글자 단계)를 도화지 단위로 바꾼다. 넓은 도화지는 100%에서 화면 span장 너비로
 *  펼쳐지므로, 같은 굵기로 보이려면 저장 값을 span으로 나눈다. 좁은 도화지(span 1)는 그대로여서 옛 작품과 같다. */
export const toDocumentUnits = (screenValue: number, span: number) => Math.round(screenValue / span * 100) / 100;
export const toScreenUnits = (documentValue: number, span: number) => Math.round(documentValue * span);
/** 그린 것이 차지하는 칸(0~1). 넓은 도화지에서 완성 PNG·썸네일을 그림에 맞춰 잘라내는 데 쓴다.
 *  아무것도 없으면 null. 굵은 선이 잘리지 않게 가장 굵은 선의 절반만큼 넓혀 준다. */
export function contentBounds(document: DrawDocument): { x: number; y: number; width: number; height: number } | null {
  let left = 1, top = 1, right = 0, bottom = 0, found = false, widest = 0;
  for (const op of visibleDrawOperations(document.ops)) {
    for (const point of op.points ?? []) {
      found = true;
      if (point.x < left) left = point.x;
      if (point.x > right) right = point.x;
      if (point.y < top) top = point.y;
      if (point.y > bottom) bottom = point.y;
    }
    // 글자·스티커는 점 하나로 저장되므로 그 크기만큼 여유를 둔다.
    const reach = op.type === "text" ? (op.fontSize ?? 64) * 1.2 : op.type === "sticker" ? (op.fontSize ?? STICKER_SIZE) : (op.width ?? 0);
    if (reach > widest) widest = reach;
  }
  if (!found) return null;
  const height = documentHeight(document);
  const padX = (widest / 2 + DOCUMENT_SIZE * 0.01) / DOCUMENT_SIZE;
  const padY = (widest / 2 + DOCUMENT_SIZE * 0.01) / height;
  left = Math.max(0, left - padX); right = Math.min(1, right + padX);
  top = Math.max(0, top - padY); bottom = Math.min(1, bottom + padY);
  return { x: left, y: top, width: Math.max(0.02, right - left), height: Math.max(0.02, bottom - top) };
}

/** 글자 크기도 굵기와 같은 규칙이다 — 넓은 도화지에서는 TEXT_SIZES를 span으로 나눈 값이 저장된다. */
export const isTextSize = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= TEXT_SIZES[0] / DOCUMENT_SPANS[DOCUMENT_SPANS.length - 1] - 0.01 && value <= TEXT_SIZES[TEXT_SIZES.length - 1] + 0.01;
export const DEFAULT_DOCUMENT_HEIGHT = 640;

export function isDocumentHeight(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value)
    && value >= DOCUMENT_MIN_HEIGHT && value <= DOCUMENT_MAX_HEIGHT
    && value % DOCUMENT_HEIGHT_STEP === 0;
}

/** 화면에서 잰 비율을 저장 가능한 세로 값으로 맞춘다. */
export function clampDocumentHeight(rawHeight: number): number {
  if (!Number.isFinite(rawHeight)) return DEFAULT_DOCUMENT_HEIGHT;
  const stepped = Math.round(rawHeight / DOCUMENT_HEIGHT_STEP) * DOCUMENT_HEIGHT_STEP;
  return Math.max(DOCUMENT_MIN_HEIGHT, Math.min(DOCUMENT_MAX_HEIGHT, stepped));
}
export const STICKER_ALLOWLIST = ["star", "heart", "leaf", "cloud", "sparkle"] as const;
/* 스티커 크기도 굵기·글자와 같은 도화지 단위다. 넓은 도화지(span)에서는 STICKER_SIZE를 span으로 나눈 값을
 * `fontSize`에 담는다(렌더러가 스티커를 글자로 그린다). 값이 없으면 예전처럼 140이다. */
export const STICKER_SIZE = 140;
/* 아이가 바꿀 수 있는 스티커 크기(화면 기준 픽셀). 넓은 도화지에서는 저장 값이 span으로 나뉘므로
 * 서버가 받는 범위는 가장 넓은 도화지의 최소부터 좁은 도화지의 최대까지다. */
export const STICKER_SCREEN_MIN = 60;
export const STICKER_SCREEN_MAX = 360;
export const isStickerSize = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= STICKER_SCREEN_MIN / DOCUMENT_SPANS[DOCUMENT_SPANS.length - 1] - 0.01 && value <= STICKER_SCREEN_MAX;
// 서버 validator와 클라이언트가 같은 목록을 봐야 한다. 클라이언트만 넓히면
// 새 도구로 그린 문서가 서버에서 거부돼 저장이 영구 실패한다.
// "pen"은 필압 렌더 도입 전의 기존 획이다. 기존 작품에는 실필압(0.5가 아닌 값)이 이미 기록돼
// 있으므로, pen에 필압 배율을 적용하면 저장된 썸네일·최종 PNG와 재생 렌더가 어긋난다.
// 새 연필 획은 "pencil"로 저장해 필압 렌더를 새 획에만 적용한다.
export const STROKE_TOOLS = ["pen", "pencil", "crayon", "marker", "watercolor", "eraser"] as const;
// 굵기는 1024 도화지 기준 픽셀 정수다. 예전 5단 값(3·8·16·30·48)도 이 범위 안이라 옛 작품이 그대로 열린다.
/* 굵기는 도화지 단위(가로 1024 기준)다. 화면에서 고르는 값은 1~60픽셀이고, 넓은 도화지(span)에서는
 * 화면 한 픽셀이 도화지 단위로 span배라 저장 값도 그만큼 커진다. 그래서 상한은 60 × 가장 넓은 도화지다. */
export const STROKE_WIDTH_MIN = 1;
export const STROKE_WIDTH_MAX = 60;
/* 넓은 도화지에서는 화면 1픽셀이 도화지 1/3단위라 소수 굵기가 필요하다(0.01 단위까지). */
export const STROKE_WIDTH_UNIT_MIN = 0.2;
export const STROKE_WIDTH_SCREEN_MAX = 60;
export const SHAPE_KINDS = ["line", "circle", "triangle", "rectangle", "rounded-rectangle", "star", "heart", "arrow", "curve", "cloud"] as const;
export const TEXT_KINDS = ["label", "title", "speech"] as const;
export const TEXT_SIZES = [48, 64, 84] as const;
export const MAX_TEXT_OBJECTS = 5;
export const MAX_TEXT_GRAPHEMES = {
  label: 12,
  title: 20,
  speech: 30,
} as const;
// 서버가 거부하는 한도. 클라이언트가 같은 값을 미리 지켜야 저장이 영구 실패하지 않는다.
/* 도구별로 화면에 그려지는 굵기 배율. 렌더러(draw-renderer)와 점 간격 계산이 같은 값을 써야
 * "보이는 굵기"가 어긋나지 않는다. 마커는 넓게, 수채붓은 두 배로 그어진다. */
export const TOOL_DRAWN_WIDTH_SCALE: Record<string, number> = { marker: 1.6, watercolor: 2 };
export const drawnStrokeWidth = (tool: string | undefined, width: number) => width * (TOOL_DRAWN_WIDTH_SCALE[tool ?? ""] ?? 1);

/* 획에 점을 하나 더 담기까지 필요한 최소 이동 거리(도화지 단위, 가로 1024 기준).
 *
 * 2026-09-26: 종전에는 굵기와 상관없이 2.5로 고정이었다. 그래서 굵은 붓으로 넓은 면을 칠하면
 * 화면엔 덩어리 하나인데 점이 수만 개 쌓여 저장 한도(1.25MB)에 먼저 닿았다 — 아이는 여백이
 * 많은데도 "종이가 가득 찼다"는 말을 들었다(운영 실사용 보고).
 * 렌더러는 점을 찍지 않고 둥근 이음으로 **이어** 그리므로, 간격이 굵기에 비해 작을수록 낭비다.
 * 보이는 굵기의 1/4까지는 눈에 띄지 않는다(반지름 r인 곡선에서 벗어남 ≈ 간격²/8r).
 * 가는 연필은 바닥값 2.5가 그대로 걸려 예전과 같은 밀도를 유지한다. */
export const MIN_POINT_GAP = 2.5;
export const POINT_GAP_WIDTH_RATIO = 0.25;
export function strokePointGap(tool: string | undefined, width: number) {
  return Math.max(MIN_POINT_GAP, drawnStrokeWidth(tool, width) * POINT_GAP_WIDTH_RATIO);
}

export const MAX_DOCUMENT_OPS = 5000;
export const MAX_STROKE_POINTS = 12000;
/* 한 작품의 동작 데이터 상한. 서버가 이 값으로 413을 내고, 클라이언트는 10만 바이트 앞서 멈춘다.
 * 2026-09-26 1.25MB → 2.5MB(사용자 결정). 완성 PNG는 별도 바이너리로 올라가고 본문에는 키만 실리므로
 * (lib/save-transmit.ts splitCompletionBody) 최악 본문은 문서 2.5MB + 썸네일 base64 ≈ 3.2MB로
 * Vercel 4.5MB 한도 아래다. 같은 날 점 간격을 굵기에 맞춘 것과 합쳐 그릴 수 있는 양이 크게 는다. */
export const MAX_DOCUMENT_BYTES = 2_500_000;
// 좌표를 소수 4자리로 줄이면 1024px 캔버스에서 0.1px 미만 오차로 직렬화 크기를 크게 줄인다.
export const POINT_PRECISION = 4;

export function roundUnit(value: number) {
  return Number(value.toFixed(POINT_PRECISION));
}

// 직렬화 크기의 보수적 상한. 스트로크마다 문서 전체를 JSON.stringify 하면
// 큰 작품에서 손을 뗄 때마다 1MB를 문자열로 만든다. 실제보다 작게 잡으면
// 클라이언트가 한도를 넘긴 문서를 커밋해 저장이 영구 실패하므로,
// 고정값이 아니라 op의 실제 문자열 길이를 더해 상한을 보장한다.
const OP_FIXED_BYTES = 120;
// 정규화된 점 하나의 최악 직렬화: {"x":0.1234,"y":0.1234,"pressure":0.1234}, = 42자.
const POINT_BYTES = 44;

function opBytes(op: DrawOp) {
  return OP_FIXED_BYTES
    + (op.opId?.length ?? 0) + (op.clientOpId?.length ?? 0) + (op.type?.length ?? 0)
    + (op.at?.length ?? 0) + (op.tool?.length ?? 0) + (op.color?.length ?? 0)
    + (op.shape?.length ?? 0) + (op.sticker?.length ?? 0)
    + (op.textObjectId?.length ?? 0) + (op.textKind?.length ?? 0) + (op.objectId?.length ?? 0)
    // UTF-8에서 한 UTF-16 code unit가 차지할 수 있는 양보다 넉넉하게 잡는다.
    + (op.text?.length ?? 0) * 6
    + (op.points?.length ?? 0) * POINT_BYTES;
}

export function estimateDocumentBytes(document: DrawDocument) {
  let bytes = 64;
  for (const op of document.ops) bytes += opBytes(op);
  return bytes;
}

// 이 클라이언트가 만드는 스트로크(op_ + 32자 hex, client_ + 32자 hex)의 상한.
// 여유분 80은 type(6)+at(24)+tool(최장 watercolor 10)+color(7)+미러 접미사를 덮는다 —
// 여유가 부족하면 estimateStrokeBytes가 실제 기여보다 작아져 상한 보증이 깨진다.
const CLIENT_OP_ID_BYTES = 40 + 40 + 80;

export function estimateStrokeBytes(pointCount: number) {
  return OP_FIXED_BYTES + CLIENT_OP_ID_BYTES + pointCount * POINT_BYTES;
}

type Point = { x: number; y: number; pressure?: number };

export type StrokeTool = (typeof STROKE_TOOLS)[number];
export type StrokeWidth = number;
export const isStrokeWidth = (value: unknown): value is StrokeWidth =>
  typeof value === "number" && Number.isFinite(value) && value >= STROKE_WIDTH_UNIT_MIN && value <= STROKE_WIDTH_MAX
  && Math.abs(value * 100 - Math.round(value * 100)) < 1e-9;
export type ShapeKind = (typeof SHAPE_KINDS)[number];
export type TextKind = (typeof TEXT_KINDS)[number];
export type TextSize = (typeof TEXT_SIZES)[number];

export type DrawOp = {
  opId: string;
  clientOpId: string;
  type: "stroke" | "fill" | "shape" | "sticker" | "text";
  at: string;
  tool?: StrokeTool;
  color?: string;
  width?: StrokeWidth;
  points?: Point[];
  smoothed?: boolean;
  squareEraser?: boolean;
  shape?: ShapeKind;
  filled?: boolean;
  sticker?: (typeof STICKER_ALLOWLIST)[number];
  textObjectId?: string;
  text?: string;
  textKind?: TextKind;
  /* 글자 크기도 도화지 단위다 — 넓은 도화지(span)에서는 화면에서 같아 보이도록 TEXT_SIZES의 span배로 저장된다. */
  fontSize?: number;
  /* 도형·스티커를 옮기거나 지운 동작이 가리키는 원래 물건. 처음 그린 동작에는 없고(그 동작의 opId가 곧 이름이다),
   * 옮길 때마다 같은 objectId로 전체 상태를 새로 덧붙인다 — 글씨의 textObjectId와 같은 방식이다. */
  objectId?: string;
  deleted?: boolean;
};

export type DocumentHeight = number;

export type DrawDocument = {
  schemaVersion: 1;
  rendererVersion: 1;
  size: 1024;
  /* 없으면 정사각(1024). 기존 작품은 이 값이 없으므로 저장된 그림이 그대로 유지된다. */
  height?: DocumentHeight;
  /* 없으면 1(화면 한 장). 2026-09-20부터 새 작품은 3 — 100%에서 도화지가 화면 세 개 너비다. */
  span?: DocumentSpan;
  ops: DrawOp[];
};

export function documentHeight(document: Pick<DrawDocument, "height">): number {
  return document.height ?? DOCUMENT_SIZE;
}

/** 이미 그린 도화지를 세로로 늘린다(2026-09-15 "도화지는 항상 화면을 꽉 채우게").
 * 그림은 가운데에 두고 위아래로 같은 만큼 종이를 덧댄다. 가로 1024 기준인 굵기·글자·스티커 크기는
 * 그대로라 화면에 그려지는 모양이 한 픽셀도 바뀌지 않는다(세로 좌표만 새 높이로 다시 나눈다).
 * 가운데 정렬이라 도화지 가운데에 놓이는 수업 점선과도 어긋나지 않는다. 줄이는 쪽은 그림을 잘라야 해 하지 않는다. */
export function growDrawOps(ops: DrawOp[], fromHeight: number, toHeight: number): DrawOp[] {
  if (!(toHeight > fromHeight)) return ops;
  const offset = (toHeight - fromHeight) / 2;
  return ops.map((op) => (op.points ? { ...op, points: op.points.map((point) => ({ ...point, y: roundUnit((point.y * fromHeight + offset) / toHeight) })) } : op));
}

function finiteUnit(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

// 정규식은 값을 문자열로 강제 변환한다. [["#FF0000"]] 같은 중첩 배열이 통과해
// 그대로 복사되면 DrawDocument 타입이 깨지고, 렌더러의 문자열 전제와 크기 상한도 무너진다.
function isHexColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9A-Fa-f]{6}$/.test(value);
}

// points:[null] 같은 입력에서 point.x를 바로 읽으면 TypeError가 나 검증이 거부 대신 500이 된다.
function invalidPoint(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return true;
  const point = value as { x?: unknown; y?: unknown; pressure?: unknown };
  return !finiteUnit(point.x) || !finiteUnit(point.y) || (point.pressure !== undefined && !finiteUnit(point.pressure));
}

export function drawingTextGraphemes(value: string) {
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    const segmenter = new Intl.Segmenter("ko", { granularity: "grapheme" });
    return [...segmenter.segment(value)].map((part) => part.segment);
  }
  return Array.from(value);
}

export function normalizeDrawingText(value: string) {
  return value
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 고쳐 쓸 수 있는 물건(글씨·도형·스티커)의 이름. 획·채우기는 물건이 아니라 undefined다.
 *  종류를 앞에 붙여, 글씨 이름과 도형 이름이 우연히 같아도 서로를 가리지 않게 한다. */
export function drawObjectKey(op: DrawOp) {
  if (op.type === "text") return op.textObjectId ? `text:${op.textObjectId}` : undefined;
  if (op.type === "shape" || op.type === "sticker") return `object:${op.objectId ?? op.opId}`;
  return undefined;
}

// 물건 편집은 같은 이름의 전체 상태를 새 op로 덧붙인다. 마지막 상태만 그리면
// 이동·크기·색 변경도 되돌리기와 타임랩스에 남고, 삭제 op를 지우면 직전 상태가 복구된다.
export function visibleDrawOperations(ops: readonly DrawOp[], limit = ops.length) {
  const end = Math.max(0, Math.min(ops.length, limit));
  const latest = new Map<string, number>();
  for (let index = 0; index < end; index += 1) {
    const key = drawObjectKey(ops[index]);
    if (key) latest.set(key, index);
  }
  const visible: DrawOp[] = [];
  for (let index = 0; index < end; index += 1) {
    const op = ops[index];
    const key = drawObjectKey(op);
    if (!key || (latest.get(key) === index && !op.deleted)) visible.push(op);
  }
  return visible;
}

/** 물건이 도화지에서 차지하는 칸(0~1). 도형은 두 점의 상자, 스티커는 가운데 점 둘레의 정사각이다. */
export function drawObjectBounds(op: DrawOp, docHeight: number) {
  const points = op.points ?? [];
  if (!points.length) return null;
  const reach = op.type === "sticker" ? (op.fontSize ?? STICKER_SIZE) / 2 : (op.width ?? 0) / 2;
  const padX = reach / DOCUMENT_SIZE, padY = reach / docHeight;
  const xs = points.map((point) => point.x), ys = points.map((point) => point.y);
  const left = Math.min(...xs) - padX, top = Math.min(...ys) - padY;
  return { x: left, y: top, width: Math.max(...xs) + padX - left, height: Math.max(...ys) + padY - top };
}

/** 지금 옮길 수 있는 도형·스티커(그려지는 순서).
 *  **채우기를 한 뒤에는 그 전에 그린 것을 옮기지 못한다.** 채우기는 저장된 색이 아니라 "그 자리에서 번지기"라
 *  다시 그릴 때마다 계산된다 — 동그라미를 그리고 안을 채운 뒤 동그라미를 옮기면, 번질 때 막아 주던 선이
 *  사라져 색이 도화지 전체로 번진다. */
export function movableDrawObjects(ops: readonly DrawOp[]) {
  const firstIndex = new Map<string, number>();
  let lastFill = -1;
  ops.forEach((op, index) => {
    if (op.type === "fill") lastFill = index;
    const key = drawObjectKey(op);
    if (key && !firstIndex.has(key)) firstIndex.set(key, index);
  });
  return visibleDrawOperations(ops).filter((op) => (op.type === "shape" || op.type === "sticker") && (firstIndex.get(drawObjectKey(op) ?? "") ?? -1) > lastFill);
}

// 이보다 작게 줄이면 다시 누르기 어렵다(도형 그리기가 받는 최소 길이 0.012보다 넉넉하게).
const SHAPE_MIN_SPAN = 0.03;
/** 물건을 가운데 기준으로 factor배 한 상태. 스티커는 크기(fontSize)가, 도형은 두 점이 바뀐다 — 선 굵기는 그대로다.
 *  도화지 밖으로 나가거나 너무 작아지지 않는 만큼만 바뀐다. */
export function scaleDrawObject(op: DrawOp, factor: number, span: number): Pick<DrawOp, "points" | "fontSize"> {
  if (!Number.isFinite(factor) || factor <= 0) return {};
  if (op.type === "sticker") {
    const size = (op.fontSize ?? STICKER_SIZE) * factor;
    return { fontSize: Math.max(toDocumentUnits(STICKER_SCREEN_MIN, span), Math.min(toDocumentUnits(STICKER_SCREEN_MAX, span), Math.round(size * 100) / 100)) };
  }
  const [a, b] = op.points ?? [];
  if (op.type !== "shape" || !a || !b) return {};
  const centerX = (a.x + b.x) / 2, centerY = (a.y + b.y) / 2;
  const halfX = Math.abs(a.x - b.x) / 2, halfY = Math.abs(a.y - b.y) / 2;
  const length = Math.hypot(a.x - b.x, a.y - b.y);
  const most = Math.min(halfX ? Math.min(centerX, 1 - centerX) / halfX : Infinity, halfY ? Math.min(centerY, 1 - centerY) / halfY : Infinity);
  const least = length > SHAPE_MIN_SPAN ? SHAPE_MIN_SPAN / length : 1;
  const applied = Math.max(least, Math.min(most, factor));
  const scaled = (point: Point) => ({ ...point, x: roundUnit(Math.max(0, Math.min(1, centerX + (point.x - centerX) * applied))), y: roundUnit(Math.max(0, Math.min(1, centerY + (point.y - centerY) * applied))) });
  return { points: [scaled(a), scaled(b)] };
}

/** 물건을 (dx, dy)만큼 옮긴 점들. 점이 도화지 밖으로 나가지 않는 만큼만 움직인다. */
export function shiftDrawPoints(points: readonly Point[], dx: number, dy: number): Point[] {
  const xs = points.map((point) => point.x), ys = points.map((point) => point.y);
  const moveX = Math.max(-Math.min(...xs), Math.min(1 - Math.max(...xs), dx));
  const moveY = Math.max(-Math.min(...ys), Math.min(1 - Math.max(...ys), dy));
  return points.map((point) => ({ ...point, x: roundUnit(point.x + moveX), y: roundUnit(point.y + moveY) }));
}

export function activeTextObjects(ops: readonly DrawOp[]) {
  return visibleDrawOperations(ops).filter((op): op is DrawOp & Required<Pick<DrawOp, "textObjectId" | "text" | "textKind" | "fontSize" | "color" | "points">> => op.type === "text");
}

export function validateDrawDocument(value: unknown): DrawDocument | null {
  if (!value || typeof value !== "object") return null;
  const doc = value as Partial<DrawDocument>;
  if (doc.schemaVersion !== DRAWING_SCHEMA_VERSION || doc.rendererVersion !== RENDERER_VERSION || doc.size !== DOCUMENT_SIZE || !Array.isArray(doc.ops) || doc.ops.length > MAX_DOCUMENT_OPS) return null;
  // 세로는 없거나(기존 정사각 문서) 허용 목록 안이어야 한다. 임의 값을 받으면 저장된 그림의
  // 비율을 클라이언트가 마음대로 바꿀 수 있고, 렌더 결과가 썸네일과 어긋난다.
  if (doc.height !== undefined && !isDocumentHeight(doc.height)) return null;
  if (doc.span !== undefined && !isDocumentSpan(doc.span)) return null;
  const seen = new Set<string>();
  const activeTextIds = new Set<string>();
  for (const raw of doc.ops) {
    if (!raw || typeof raw !== "object") return null;
    const op = raw as DrawOp;
    // 문자열 여부를 먼저 본다. String(...)으로 강제하면 객체가 통과해 원본이 그대로 복사되고,
    // slice(0, 80) 뒤 검사는 81자 이상 ID를 잘린 채 통과시켜 크기 상한이 깨진다.
    if (typeof op.opId !== "string" || typeof op.clientOpId !== "string" || typeof op.at !== "string") return null;
    if (!/^[a-zA-Z0-9_-]{8,80}$/.test(op.opId) || !/^[a-zA-Z0-9_-]{8,80}$/.test(op.clientOpId) || seen.has(op.clientOpId)) return null;
    seen.add(op.clientOpId);
    // 제어문자가 섞인 날짜도 Date.parse는 통과시킨다. JSON에서 이스케이프되며 길이가 폭증하므로 길이를 먼저 막는다.
    if (!["stroke", "fill", "shape", "sticker", "text"].includes(op.type) || op.at.length > 40 || !Number.isFinite(Date.parse(op.at))) return null;
    if (op.type === "stroke") {
      if (!op.tool || !STROKE_TOOLS.includes(op.tool) || !isStrokeWidth(op.width) || !Array.isArray(op.points) || op.points.length < 1 || op.points.length > MAX_STROKE_POINTS) return null;
      if (op.tool !== "eraser" && !isHexColor(op.color)) return null;
      if (op.smoothed !== undefined && typeof op.smoothed !== "boolean") return null;
      if (op.squareEraser !== undefined && typeof op.squareEraser !== "boolean") return null;
      if (op.points.some(invalidPoint)) return null;
    }
    if (op.type === "fill") {
      if (!isHexColor(op.color) || !Array.isArray(op.points) || op.points.length !== 1 || op.points.some(invalidPoint)) return null;
    }
    if (op.type === "shape") {
      if (!op.shape || !SHAPE_KINDS.includes(op.shape) || !isHexColor(op.color) || !isStrokeWidth(op.width) || !Array.isArray(op.points) || op.points.length !== 2 || op.points.some(invalidPoint)) return null;
      if (op.filled !== undefined && typeof op.filled !== "boolean") return null;
    }
    if (op.type === "sticker" && (!STICKER_ALLOWLIST.includes(op.sticker as (typeof STICKER_ALLOWLIST)[number]) || !Array.isArray(op.points) || op.points.length !== 1 || op.points.some(invalidPoint) || (op.fontSize !== undefined && !isStickerSize(op.fontSize)))) return null;
    if (op.type === "shape" || op.type === "sticker") {
      if (op.objectId !== undefined && (typeof op.objectId !== "string" || !/^[a-zA-Z0-9_-]{8,80}$/.test(op.objectId))) return null;
      if (op.deleted !== undefined && typeof op.deleted !== "boolean") return null;
    }
    if (op.type === "text") {
      if (typeof op.textObjectId !== "string" || !/^[a-zA-Z0-9_-]{8,80}$/.test(op.textObjectId)) return null;
      if (typeof op.text !== "string" || normalizeDrawingText(op.text) !== op.text) return null;
      // 글자 크기도 도화지 단위다. 넓은 도화지에서는 화면에서 같아 보이려면 span배로 저장된다.
      if (!op.textKind || !TEXT_KINDS.includes(op.textKind) || !isTextSize(op.fontSize)) return null;
      if (!isHexColor(op.color) || !Array.isArray(op.points) || op.points.length !== 1 || op.points.some(invalidPoint)) return null;
      if (op.deleted !== undefined && typeof op.deleted !== "boolean") return null;
      if (!op.text.length || drawingTextGraphemes(op.text).length > MAX_TEXT_GRAPHEMES[op.textKind]) return null;
      if (op.deleted) activeTextIds.delete(op.textObjectId);
      else activeTextIds.add(op.textObjectId);
      if (activeTextIds.size > MAX_TEXT_OBJECTS) return null;
    }
  }
  // 알려진 필드만 남기고 좌표를 정규화한 사본을 돌려준다. 원본을 그대로 통과시키면
  // 전체 정밀도 좌표(0.12345678901234568)와 미지의 속성이 함께 저장돼,
  // 크기 추정이 실제 직렬화 길이의 상한이 아니게 되고 저장이 한도에 걸린다.
  return { schemaVersion: 1, rendererVersion: 1, size: 1024, ...(doc.height === undefined ? {} : { height: doc.height }), ...(doc.span === undefined ? {} : { span: doc.span }), ops: doc.ops.map(normalizeOp) };
}

function normalizePoint(point: Point): Point {
  const normalized: Point = { x: roundUnit(point.x), y: roundUnit(point.y) };
  if (point.pressure !== undefined) normalized.pressure = roundUnit(point.pressure);
  return normalized;
}

// op 종류마다 검증된 필드만 남긴다. 종류와 무관한 필드까지 복사하면,
// 그 종류에서 검사하지 않는 자리(예: stroke의 sticker)에 거대한 값을 실어
// 검증을 통과시키면서 크기 상한을 깨뜨릴 수 있다.
function normalizeOp(raw: DrawOp): DrawOp {
  // at은 검증을 통과했으므로 항상 24자 ISO로 정규화된다.
  const op: DrawOp = { opId: raw.opId, clientOpId: raw.clientOpId, type: raw.type, at: new Date(raw.at).toISOString() };
  const points = Array.isArray(raw.points) ? raw.points.map(normalizePoint) : undefined;
  if (raw.type === "stroke") {
    op.tool = raw.tool;
    if (raw.tool !== "eraser") op.color = raw.color;
    op.width = raw.width;
    op.points = points;
    if (raw.smoothed !== undefined) op.smoothed = raw.smoothed;
    if (raw.squareEraser !== undefined) op.squareEraser = raw.squareEraser;
  }
  if (raw.type === "fill") { op.color = raw.color; op.points = points; }
  if (raw.type === "shape") { op.shape = raw.shape; op.color = raw.color; op.width = raw.width; op.points = points; if (raw.filled !== undefined) op.filled = raw.filled; }
  if (raw.type === "sticker") { op.sticker = raw.sticker; op.points = points; if (raw.fontSize !== undefined) op.fontSize = raw.fontSize; }
  if (raw.type === "shape" || raw.type === "sticker") {
    if (raw.objectId !== undefined) op.objectId = raw.objectId;
    if (raw.deleted !== undefined) op.deleted = raw.deleted;
  }
  if (raw.type === "text") {
    op.textObjectId = raw.textObjectId;
    op.text = raw.text;
    op.textKind = raw.textKind;
    op.fontSize = raw.fontSize;
    op.color = raw.color;
    op.points = points;
    if (raw.deleted !== undefined) op.deleted = raw.deleted;
  }
  return op;
}

export function emptyDocument(): DrawDocument {
  return { schemaVersion: 1, rendererVersion: 1, size: 1024, height: DEFAULT_DOCUMENT_HEIGHT, ops: [] };
}
