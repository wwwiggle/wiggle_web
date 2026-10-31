import { DRAWING_LOCKED, drawingLockedResponse } from "@/lib/feature-locks";
import { bindings } from "@/db/runtime";
import { bytesToDataUrl } from "@/lib/image-data";
import { AIServiceError, requestStructuredOpenAI, TeacherCoachingDraft } from "@/lib/openai-coaching";
import { cleanText, id, jsonError, noStoreJson, rateLimit, requireTeacher, sameOrigin, sha256 } from "@/lib/security";
import { approveTeacherDraftMessage } from "@/lib/teacher-messages";

type OwnedArtwork = { artworkId: string; studentId: string; nickname: string; topic: string; intent: string; thumbnailKey: string | null; finalImageKey: string | null };

async function payloadOf(request: Request) {
  const length = Number(request.headers.get("content-length") ?? 0); if (length > 30_000) return null;
  const text = await request.text(); if (text.length > 30_000) return null;
  try { const value = JSON.parse(text); return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; } catch { return {}; }
}

async function ownedArtwork(teacherId: string, classroomId: string, studentId: string, artworkId: string) {
  return bindings().DB.prepare(`SELECT a.id AS artworkId, s.id AS studentId, s.nickname, a.topic, a.intent, a.thumbnail_key AS thumbnailKey, a.final_image_key AS finalImageKey FROM artworks a JOIN student_profiles s ON s.id = a.student_id AND s.archived_at IS NULL JOIN classrooms c ON c.id = a.classroom_id WHERE a.id = ? AND s.id = ? AND c.id = ? AND c.teacher_id = ? AND c.active = 1`).bind(artworkId, studentId, classroomId, teacherId).first<OwnedArtwork>();
}

/* 키 이름이 아니라 바이트를 직접 본다 — 저장 형식이 바뀌어도 여기서 틀리지 않는다.
 * 썸네일은 2026-09-26부터 WebP 무손실이다. 여기에 WebP를 더하지 않으면 교사 AI 초안이
 * 415 「학생 그림 형식을 확인할 수 없어요」로 막힌다(썸네일을 우선 읽기 때문). */
function imageMime(bytes: Uint8Array): "image/png" | "image/jpeg" | "image/webp" | null {
  if ([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, index) => bytes[index] === byte)) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9) return "image/jpeg";
  // RIFF....WEBP
  if ([0x52, 0x49, 0x46, 0x46].every((byte, index) => bytes[index] === byte)
    && [0x57, 0x45, 0x42, 0x50].every((byte, index) => bytes[index + 8] === byte)) return "image/webp";
  return null;
}

function aiError(error: unknown) {
  if (error instanceof AIServiceError) return noStoreJson({ error: error.message, code: error.code }, { status: error.status });
  return noStoreJson({ error: "AI 코칭 초안을 잠시 만들 수 없어요.", code: "AI_UNAVAILABLE" }, { status: 503 });
}

export async function POST(request: Request) {
  // 그림 그리기는 유료 요금제 기능으로 잠겨 있다(lib/feature-locks.ts). 읽기(GET)는 그림책·보관함이 쓰므로 그대로 둔다.
  if (DRAWING_LOCKED) return drawingLockedResponse();
  if (!sameOrigin(request)) return jsonError("요청 출처를 확인할 수 없어요.", 403);
  const teacher = await requireTeacher(); if (!teacher) return jsonError("교사 로그인이 필요해요.", 401);
  const payload = await payloadOf(request); if (!payload) return jsonError("요청이 너무 커요.", 413);
  const action = cleanText(payload.action, 20); const classroomId = cleanText(payload.classroomId, 40); const db = bindings().DB;

  if (action === "approve") {
    if (!(await rateLimit(`teacher-ai-approve:${teacher.id}`, 60, 60))) return jsonError("전송 요청이 너무 빨라요.", 429);
    const draftId = cleanText(payload.draftId, 80); const body = cleanText(payload.body, 180);
    if (!draftId || !body) return jsonError("교사가 확인한 도움말을 적어 주세요.");
    const approved = await approveTeacherDraftMessage(db, { teacherId: teacher.id, classroomId, draftId, body });
    if (!approved.ok && approved.reason === "not_found") return jsonError("승인할 초안을 찾을 수 없어요.", 404);
    if (!approved.ok && approved.reason === "empty_body") return jsonError("교사가 확인한 도움말을 적어 주세요.");
    if (!approved.ok && (approved.reason === "classroom_forbidden" || approved.reason === "student_forbidden")) return jsonError("메시지 대상을 다시 확인해 주세요.", 403);
    if (!approved.ok && approved.reason === "save_failed") return noStoreJson({ error: "초안 메시지를 저장하지 못했어요.", code: "DRAFT_SAVE_FAILED" }, { status: 503 });
    if (!approved.ok) return noStoreJson({ error: "이미 처리한 초안이에요.", code: "DRAFT_ALREADY_HANDLED" }, { status: 409 });
    return noStoreJson({ ok: true, messageId: approved.messageId });
  }

  if (action !== "draft") return jsonError("지원하지 않는 교사 AI 요청이에요.");
  if (!(await rateLimit(`teacher-ai-draft:${teacher.id}`, 12, 10 * 60))) return jsonError("AI 초안을 많이 요청했어요. 잠깐 뒤에 다시 시도해 주세요.", 429);
  const studentId = cleanText(payload.studentId, 40); const artworkId = cleanText(payload.artworkId, 80);
  const artwork = await ownedArtwork(teacher.id, classroomId, studentId, artworkId);
  if (!artwork) return jsonError("이 학급 학생의 그림이 아니에요.", 403);
  const objectKey = artwork.thumbnailKey ?? artwork.finalImageKey; if (!objectKey) return jsonError("학생 그림이 저장된 뒤 초안을 만들 수 있어요.", 409);
  const object = await bindings().ARTWORKS.get(objectKey); if (!object || object.size > 3_500_000) return jsonError("학생 그림 파일을 확인할 수 없어요.", 413);
  const bytes = new Uint8Array(await object.arrayBuffer()); const mime = imageMime(bytes); if (!mime) return jsonError("학생 그림 형식을 확인할 수 없어요.", 415);
  const recent = await db.prepare(`SELECT e.question, e.student_answer AS studentAnswer, d.new_elements_json AS newElementsJson, d.growth_event AS growthEvent FROM coaching_events e JOIN coaching_event_details d ON d.event_id = e.id WHERE e.artwork_id = ? ORDER BY e.created_at DESC, e.id DESC LIMIT 4`).bind(artworkId).all();
  const prompt = `학생 별명: ${artwork.nickname}\n작품 주제: ${artwork.topic}\n아이의 처음 의도: ${artwork.intent}\n최근 구조화 과정(JSON): ${JSON.stringify(recent.results)}\n교사가 검토할 짧은 코칭 초안을 만들어 줘.`;
  try {
    const result = await requestStructuredOpenAI({ kind: "teacher_draft", prompt, imageDataUrl: bytesToDataUrl(bytes, mime), safetyIdentifier: await sha256(`wiggle-ai-safety-v1:${studentId}`) });
    const draft = result.value as TeacherCoachingDraft; const draftId = id("draft");
    await db.prepare(`INSERT INTO teacher_coaching_drafts(id, teacher_id, classroom_id, student_id, artwork_id, body, observation, next_action, model, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft')`).bind(draftId, teacher.id, classroomId, studentId, artworkId, draft.body, draft.observation, draft.nextAction, result.model).run();
    return noStoreJson({ draft: { id: draftId, body: draft.body }, meta: { model: result.model, schemaValid: result.schemaValid } }, { status: 201 });
  } catch (error) { return aiError(error); }
}
