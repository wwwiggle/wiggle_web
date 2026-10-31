import { DRAWING_LOCKED, drawingLockedResponse } from "@/lib/feature-locks";
import { bindings } from "@/db/runtime";
import { findOwnedCoachingEvent, recordCoachingAfter, recordCoachingBefore } from "@/lib/coaching-store";
import { validateDrawDocument, MAX_DOCUMENT_BYTES } from "@/lib/drawing-model";
import { parseImageDataUrl } from "@/lib/image-data";
import { AIServiceError, requestStructuredOpenAI, StoryInterpretation, StudentCoaching } from "@/lib/openai-coaching";
import { cleanText, jsonError, noStoreJson, rateLimit, sameOrigin, sha256, studentFromRequest } from "@/lib/security";

const MAX_BODY_CHARS = 5_200_000;
type ArtworkRow = { id: string; studentId: string; topic: string; intent: string; currentStep: number; revision: number; status: string };

async function limitedPayload(request: Request) {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_CHARS) return null;
  const text = await request.text(); if (text.length > MAX_BODY_CHARS) return null;
  try { const value = JSON.parse(text); return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; } catch { return {}; }
}

async function ownedArtwork(artworkId: string, studentId: string) {
  return bindings().DB.prepare(`SELECT id, student_id AS studentId, topic, intent, current_step AS currentStep, revision, status FROM artworks WHERE id = ? AND student_id = ?`).bind(artworkId, studentId).first<ArtworkRow>();
}

function stringList(value: unknown, maxItems: number, maxLength: number) {
  if (!Array.isArray(value) || value.length > maxItems) return null;
  const result = value.map((entry) => cleanText(entry, maxLength)).filter(Boolean);
  return result.length === value.length ? result : null;
}

function parsedStringList(value: string) {
  try { return stringList(JSON.parse(value || "[]"), 4, 40) ?? []; } catch { return []; }
}

async function recentContext(artworkId: string) {
  const rows = await bindings().DB.prepare(`SELECT e.question, e.student_answer AS studentAnswer, d.new_elements_json AS newElementsJson, d.growth_event AS growthEvent, d.response_kind AS responseKind FROM coaching_events e JOIN coaching_event_details d ON d.event_id = e.id WHERE e.artwork_id = ? ORDER BY e.created_at DESC, e.id DESC LIMIT 4`).bind(artworkId).all<{ question: string; studentAnswer: string | null; newElementsJson: string; growthEvent: string | null; responseKind: string }>();
  return rows.results.reverse().map((row) => ({
    kind: row.responseKind,
    question: cleanText(row.question, 100),
    answer: cleanText(row.studentAnswer, 80),
    newElements: parsedStringList(row.newElementsJson),
    growthEvent: cleanText(row.growthEvent, 120),
  }));
}

function aiError(error: unknown) {
  if (error instanceof AIServiceError) return noStoreJson({ error: error.message, code: error.code }, { status: error.status });
  return noStoreJson({ error: "몽그리가 잠시 쉬고 있어요. 조금 뒤에 다시 불러 주세요.", code: "AI_UNAVAILABLE" }, { status: 503 });
}

export async function POST(request: Request) {
  // 그림 그리기는 유료 요금제 기능으로 잠겨 있다(lib/feature-locks.ts). 읽기(GET)는 그림책·보관함이 쓰므로 그대로 둔다.
  if (DRAWING_LOCKED) return drawingLockedResponse();
  if (!sameOrigin(request)) return jsonError("요청 출처를 확인할 수 없어요.", 403);
  const student = await studentFromRequest(request); if (!student) return jsonError("학생 로그인이 필요해요.", 401);
  const payload = await limitedPayload(request); if (!payload) return jsonError("그림 요청이 너무 커요.", 413);
  const action = cleanText(payload.action, 24); const artworkId = cleanText(payload.artworkId, 80);
  const artwork = await ownedArtwork(artworkId, student.id); if (!artwork) return jsonError("내 그림이 아니거나 찾을 수 없어요.", 404);
  if (artwork.status === "complete") return jsonError("완성한 작품에서는 새 사본으로 몽그리를 불러 주세요.", 409);
  const db = bindings().DB;

  if (action === "dismiss") {
    const eventId = cleanText(payload.eventId, 80);
    const event = await findOwnedCoachingEvent(db, eventId, artworkId, student.id);
    if (!event) return jsonError("이 도움 기록을 찾을 수 없어요.", 404);
    // 단계 가이드는 은퇴했다(2026-09-09). 남아 있는 옛 guide 이벤트는 아래 UPDATE가
    // response_kind = 'question'으로 좁혀 두므로 그대로 통과하지 않는다.
    const dismissed = await db.prepare(`UPDATE coaching_event_details SET status = 'dismissed', updated_at = CURRENT_TIMESTAMP WHERE event_id = ? AND response_kind = 'question' AND status = 'open' AND EXISTS (SELECT 1 FROM coaching_events e JOIN artworks a ON a.id = e.artwork_id WHERE e.id = coaching_event_details.event_id AND a.student_id = ? AND a.id = ?)`).bind(eventId, student.id, artworkId).run();
    if (!dismissed.meta.changes) return noStoreJson({ error: "이미 처리한 도움 기록이에요.", code: "COACHING_ALREADY_HANDLED" }, { status: 409 });
    return noStoreJson({ ok: true });
  }

  /* 즉시 답하기 (2026-09-26 인계 mongri-floating-handoff). 아이가 카드에서 선택지를 고르거나
   * 자기 말로 답한 것을 그 자리에서 기록한다. 아래 `answer`와 섞지 않는 이유가 셋이다.
   *  ① `answer`는 "답하고 **그린 뒤**"를 기록하는 경로라 document·image·newElements를 요구한다.
   *     즉시 답에는 그린 것이 없어 그때 문서를 그대로 보내면 before와 같은 after 버전이 남는다.
   *  ② `answer`는 한 번 기록되면 409 `이미 처리한 도움 기록이에요`를 낸다. 아이가 고른 답을
   *     바꾸면 그대로 막혔다 — 2026-09-23에 왕복을 걷어낸 세 이유 중 하나다. 여기서는 덮어쓴다.
   *  ③ 답은 다음 질문의 맥락(recentContext)으로만 쓰이므로 새 작품 버전을 만들 이유가 없다. */
  if (action === "reply") {
    if (!(await rateLimit(`ai-reply:${student.id}`, 60, 60))) return jsonError("잠깐 쉬었다가 다시 눌러 주세요.", 429);
    const eventId = cleanText(payload.eventId, 80);
    const answer = cleanText(payload.answer, 80);
    if (!eventId || !answer) return jsonError("답을 고르거나 적어 주세요.");
    const event = await findOwnedCoachingEvent(db, eventId, artworkId, student.id);
    if (!event) return jsonError("이 도움 기록을 찾을 수 없어요.", 404);
    /* 이 답이 이 도움 기록의 **첫 답인지**를 저장 전에 본다. 아래에서 몽그리를 부를지 가르는 기준이고,
     * 이것이 곧 예산이다 — 한 도움 기록당 제안은 한 번만 다시 쓴다. 답을 고쳐 보내면 글자만 덮어쓴다. */
    const before = await db.prepare(`SELECT e.question, d.status FROM coaching_events e JOIN coaching_event_details d ON d.event_id = e.id WHERE e.id = ? AND d.response_kind = 'question'`).bind(eventId).first<{ question: string; status: string }>();
    const firstAnswer = before?.status !== "answered";
    // 답을 바꿔도 같은 줄을 덮어쓴다 — 두 번째 답이 409로 막히지 않는다.
    const saved = await db.batch([
      db.prepare(`UPDATE coaching_events SET student_answer = ? WHERE id = ?`).bind(answer, eventId),
      db.prepare(`UPDATE coaching_event_details SET status = 'answered', updated_at = CURRENT_TIMESTAMP WHERE event_id = ? AND response_kind = 'question' AND status <> 'dismissed'`).bind(eventId),
    ]);
    if (!saved[0]?.meta.changes) return jsonError("답을 저장하지 못했어요. 잠시 뒤 다시 해 주세요.", 503);
    /* 물어만 보고 답을 쓰지 않으면 아이 눈에는 답해도 아무 일이 없는 것과 같다(2026-09-26 사용자 결정).
     * 화면에 떠 있는 「이제 그려 볼 일」은 아이가 답하기 **전에** 만들어진 말이라, 그 한 줄만 다시 받는다.
     * 질문을 새로 하지 않는다 — 카드가 도화지를 가리고 있고 "한 번에 하나만 묻는다"가 제품 원칙이다.
     * 실패해도 답은 이미 저장됐다. 몽그리가 쉬면 화면은 종전 줄을 그대로 둔다(완성 저장과 같은 원칙). */
    if (!firstAnswer) return noStoreJson({ ok: true, answer });
    try {
      const result = await requestStructuredOpenAI({
        kind: "reply_next_action",
        prompt: `몽그리가 물은 것: ${cleanText(before?.question, 100)}\n아이가 알려 준 답: ${answer}\n이 답에서 출발해 아이가 지금 바로 해 볼 행동 하나를 써 줘.`,
        safetyIdentifier: await sha256(`wiggle-ai-safety-v1:${student.id}`),
      });
      // 「이제 그려 볼 일」은 저장하는 값이 아니다(coaching_event_details에 칸이 없다).
      // 화면이 들고 있는 줄이므로 응답으로만 돌려주고 그 자리에서 바꾼다.
      const { nextAction } = result.value as { nextAction: string };
      return noStoreJson({ ok: true, answer, nextAction });
    } catch {
      return noStoreJson({ ok: true, answer });
    }
  }

  if (action === "answer") {
    if (!(await rateLimit(`ai-answer:${student.id}`, 30, 60))) return jsonError("잠깐 쉬었다가 다시 눌러 주세요.", 429);
    const eventId = cleanText(payload.eventId, 80); const answer = cleanText(payload.answer, 80); const newElements = stringList(payload.newElements, 4, 40);
    const document = validateDrawDocument(payload.document); const image = parseImageDataUrl(payload.imageDataUrl);
    if (!eventId || !document || !image || !answer || !newElements) return jsonError("그린 뒤 답과 그림을 다시 확인해 주세요.");
    const result = await recordCoachingAfter({
      DB: db, ARTWORKS: bindings().ARTWORKS, studentId: student.id, artworkId, eventId,
      kind: "question_answer",
      document, image, currentStep: Math.max(0, Math.min(30, Number(payload.currentStep) || 0)), answer,
      newElements: newElements ?? [],
    });
    if (!result.ok && result.reason === "not_found") return jsonError("이 도움 기록을 찾을 수 없어요.", 404);
    if (!result.ok && result.reason === "already_recorded") return noStoreJson({ error: "이미 처리한 도움 기록이에요.", code: "COACHING_ALREADY_HANDLED" }, { status: 409 });
    if (!result.ok) return noStoreJson({ error: "과정 기록을 저장하지 못했어요. 잠시 뒤 다시 해 주세요.", code: "COACHING_SAVE_FAILED" }, { status: 503 });
    return noStoreJson(result);
  }

  // 틀리는 해석자 — 아이가 완성을 누른 순간 몽그리가 짐작 하나를 내놓고 아이가 고친다
  // (product-decisions 학습 과정 4항). 아이 답은 소감의 storyText로 저장되므로 여기서는
  // 새 작품 버전을 만들지 않는다. 완성 저장은 이 응답을 기다리지 않는다 — 몽그리가
  // 쉬고 있어도 아이는 그대로 완성할 수 있어야 한다.
  if (action === "interpret") {
    if (!(await rateLimit(`ai-create:${student.id}`, 20, 10 * 60))) return jsonError("몽그리를 많이 불렀어요. 잠깐 뒤에 다시 불러 주세요.", 429);
    const image = parseImageDataUrl(payload.imageDataUrl);
    if (!image) return jsonError("현재 그림을 확인하지 못했어요.", 413);
    const context = { artworkIntent: artwork.intent, artworkTopic: artwork.topic };
    try {
      const result = await requestStructuredOpenAI({
        kind: "story_interpretation",
        prompt: `현재 작품 맥락(JSON): ${JSON.stringify(context)}\n그림을 보고 네 짐작 하나와 아이가 고를 수 있는 답을 만들어 줘.`,
        imageDataUrl: String(payload.imageDataUrl), safetyIdentifier: await sha256(`wiggle-ai-safety-v1:${student.id}`),
      });
      return noStoreJson({ interpretation: result.value as StoryInterpretation, meta: { model: result.model, schemaValid: result.schemaValid } });
    } catch (error) {
      return aiError(error);
    }
  }

  if (action !== "ask") return jsonError("지원하지 않는 몽그리 요청이에요.");
  const requestId = cleanText(payload.requestId, 80);
  if (!/^coaching_[a-zA-Z0-9_-]{12,70}$/.test(requestId)) return jsonError("몽그리 요청 번호를 확인해 주세요.");
  const existingRequest = await db.prepare(`SELECT e.artwork_id AS artworkId, a.student_id AS studentId FROM coaching_events e JOIN artworks a ON a.id = e.artwork_id WHERE e.id = ?`).bind(requestId).first<{ artworkId: string; studentId: string }>();
  if (existingRequest && (existingRequest.artworkId !== artworkId || existingRequest.studentId !== student.id)) return jsonError("몽그리 요청을 찾을 수 없어요.", 404);
  if (existingRequest) return noStoreJson({ error: "이미 처리한 몽그리 요청이에요.", code: "COACHING_ALREADY_HANDLED" }, { status: 409 });
  if (!(await rateLimit(`ai-create:${student.id}`, 20, 10 * 60))) return jsonError("몽그리를 많이 불렀어요. 잠깐 뒤에 다시 불러 주세요.", 429);
  const expectedRevision = Number(payload.expectedRevision); const document = validateDrawDocument(payload.document); const image = parseImageDataUrl(payload.imageDataUrl);
  if (!Number.isInteger(expectedRevision) || expectedRevision !== artwork.revision) return noStoreJson({ error: "그림을 먼저 저장한 뒤 다시 불러 주세요.", code: "REVISION_CONFLICT", serverRevision: artwork.revision }, { status: 409 });
  // 저장 한도와 같은 상수를 쓴다. 숫자를 따로 박아 두면 저장 한도를 올렸을 때 그림은 저장되는데
  // 몽그리만 413으로 막힌다(2026-09-26 2.5MB로 올리며 실제로 걸릴 뻔한 자리).
  if (!document || JSON.stringify(document).length > MAX_DOCUMENT_BYTES || !image) return jsonError("현재 그림을 확인하지 못했어요.", 413);
  const childChoice = cleanText(payload.childChoice, 80);
  // 아이가 불렀는지 몽그리가 먼저 말을 걸었는지 알려 준다 — 프롬프트가 이 값으로 말투를 고른다.
  const openedBy = payload.openedBy === "mongri" ? "mongri" : "child";
  const recentEvents = await recentContext(artworkId);
  /* 첫 만남이면 알아맞히지 말고 **무엇을 그리는지 묻는다**(2026-09-26 사용자 결정).
   * 몽그리가 스스로 판정하려다 빗나가던 것이 뜬금없는 대답의 뿌리였다(미결정 P-014).
   * 아이가 한 번 알려 주면 그 답이 recentEvents로 돌아와 이후 질문이 그 위에서 이어진다. */
  const firstTurn = recentEvents.length === 0;
  const context = { artworkIntent: artwork.intent, artworkTopic: artwork.topic, childChoice, openedBy, firstTurn, currentStep: artwork.currentStep, recentEvents };
  const prompt = firstTurn
    ? `현재 작품 맥락(JSON): ${JSON.stringify(context)}\n이 그림에 대해 처음 말을 거는 자리다. 무엇을 그리고 있는지 아이에게 물어보고, 네가 보기에 그럴듯한 것들을 고를 수 있는 답으로 함께 줘.`
    : `현재 작품 맥락(JSON): ${JSON.stringify(context)}\n그림을 관찰하고, 아이가 이미 그린 것을 이어 가는 질문 하나와 실제 다음 그리기 행동을 제안해 줘.`;
  try {
    const result = await requestStructuredOpenAI({
      kind: "student_coaching",
      prompt, imageDataUrl: String(payload.imageDataUrl), safetyIdentifier: await sha256(`wiggle-ai-safety-v1:${student.id}`),
    });
    const coaching = result.value as StudentCoaching;
    const saved = await recordCoachingBefore({
      DB: db, ARTWORKS: bindings().ARTWORKS, studentId: student.id, artworkId, eventId: requestId, expectedRevision,
      responseKind: "question", document, image, question: coaching.question, hint: coaching.nextAction, choices: coaching.choices,
      growthEvent: coaching.growthEvent, currentStep: artwork.currentStep,
    });
    if (!saved.ok && saved.reason === "not_found") return jsonError("내 그림이 아니거나 찾을 수 없어요.", 404);
    if (!saved.ok && saved.reason === "already_recorded") return noStoreJson({ error: "이미 처리한 몽그리 요청이에요.", code: "COACHING_ALREADY_HANDLED" }, { status: 409 });
    if (!saved.ok && (saved.reason === "revision_conflict" || saved.reason === "artwork_complete")) return noStoreJson({ error: "그림이 바뀌었어요. 다시 불러 주세요.", code: "REVISION_CONFLICT", serverRevision: saved.serverRevision }, { status: 409 });
    if (!saved.ok) return noStoreJson({ error: "몽그리 과정을 저장하지 못했어요.", code: "COACHING_SAVE_FAILED" }, { status: 503 });
    return noStoreJson({ eventId: saved.eventId, coaching, meta: { model: result.model, schemaValid: result.schemaValid } }, { status: 201 });
  } catch (error) {
    return aiError(error);
  }
}
