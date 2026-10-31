import { DRAWING_LOCKED, drawingLockedResponse } from "@/lib/feature-locks";
import { bindings } from "@/db/runtime";
import { MAX_DOCUMENT_BYTES, validateDrawDocument } from "@/lib/drawing-model";
import { cleanText, id, jsonError, noStoreJson, randomToken, rateLimit, sameOrigin, studentFromRequest } from "@/lib/security";
import { settleUploadsBeforeCleanup } from "@/lib/settled-uploads";

type Artwork = { id: string; studentId: string; classroomId: string; title: string; topic: string; learningMode: string; lessonSlug: string | null; guideVariant: number; intent: string; opsJson: string; currentStep: number; revision: number; status: string; versionCount: number; thumbnailKey: string | null; finalImageKey: string | null; updatedAt: string; completedAt: string | null };

async function ownedArtwork(artworkId: string, studentId: string) {
  return bindings().DB.prepare(`SELECT id, student_id AS studentId, classroom_id AS classroomId, title, topic, learning_mode AS learningMode, lesson_slug AS lessonSlug, guide_variant AS guideVariant, intent, ops_json AS opsJson, current_step AS currentStep, revision, status, version_count AS versionCount, thumbnail_key AS thumbnailKey, final_image_key AS finalImageKey, updated_at AS updatedAt, completed_at AS completedAt FROM artworks WHERE id = ? AND student_id = ?`).bind(artworkId, studentId).first<Artwork>();
}

/* 썸네일은 2026-09-26부터 WebP 무손실로 올라온다(자동 저장마다 실려 반복 비용이 크다).
 * 완성본은 PNG 그대로다. 굽지 못하는 기기는 썸네일도 PNG로 보내므로 둘 다 받는다.
 * 옛 작품의 썸네일은 이미 PNG로 저장돼 있고, 서빙은 저장된 contentType을 그대로 쓰므로 그대로 열린다. */
const THUMBNAIL_TYPES = ["image/webp", "image/png"] as const;
const FINAL_TYPES = ["image/png"] as const;

function decodeImage(dataUrl: unknown, maxBytes: number, allowed: readonly string[] = FINAL_TYPES) {
  if (typeof dataUrl !== "string") return null;
  // 정규식만으로는 atob가 거부하는 문자열("A", "====")도 통과한다. 그 예외가 밖으로 나가면
  // 잘못된 입력이 400이 아니라 처리되지 않은 500이 된다.
  const match = /^data:(image\/(?:png|webp));base64,([A-Za-z0-9+/]{4,}={0,2})$/.exec(dataUrl);
  if (!match || !allowed.includes(match[1]) || match[2].length % 4 !== 0) return null;
  let binary: string;
  try { binary = atob(match[2]); } catch { return null; }
  if (binary.length > maxBytes) return null;
  const bytes = new Uint8Array(binary.length); for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return { bytes, contentType: match[1] };
}

// 별도 업로드된 완성 그림 후보 키는 이 학생·이 작품의 업로드 프리픽스만 허용한다.
// 임의 키를 받으면 다른 학생의 객체를 자기 완성본으로 연결할 수 있다.
function candidateFinalKey(value: unknown, studentId: string, artworkId: string) {
  if (typeof value !== "string" || value.length > 300 || !/^[A-Za-z0-9._/-]+$/.test(value)) return null;
  const prefix = `students/${studentId}/artworks/${artworkId}/objects/upload-`;
  return value.startsWith(prefix) && value.endsWith("-final.png") ? value : null;
}

async function priorMutation(requestId: string, artworkId: string, studentId: string) {
  return bindings().DB.prepare(`SELECT result_revision AS resultRevision FROM artwork_mutations WHERE request_id = ? AND artwork_id = ? AND student_id = ?`).bind(requestId, artworkId, studentId).first<{ resultRevision: number }>();
}

async function removeCandidates(keys: Array<string | null>) {
  await Promise.allSettled(keys.filter((key): key is string => Boolean(key)).map((key) => bindings().ARTWORKS.delete(key)));
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const student = await studentFromRequest(request);
  if (!student) return jsonError("학생 로그인이 필요해요.", 401);
  const artworkId = cleanText((await context.params).id, 80); const artwork = await ownedArtwork(artworkId, student.id);
  if (!artwork) return jsonError("내 그림이 아니거나 찾을 수 없어요.", 404);
  const reflection = await bindings().DB.prepare(`SELECT favorite_part AS favoritePart, favorite_reason AS favoriteReason, spoken_description AS spokenDescription, story_text AS storyText, next_suggestion AS nextSuggestion FROM reflections WHERE artwork_id = ?`).bind(artworkId).first();
  // 지난 회차 서랍(Story 3.1): 같은 아크의 다른 회차 그림을 참조용으로 함께 내려준다.
  // 귀속 컬럼으로만 찾는다 — 책·쪽 테이블을 거치지 않고, 시각·순서 추론도 쓰지 않는다(AD-10·AD-11).
  if (new URL(request.url).searchParams.get("summary") === "1") {
    const { opsJson: _opsJson, ...summary } = artwork;
    void _opsJson;
    return noStoreJson({ artwork: summary, reflection });
  }
  return noStoreJson({ artwork: { ...artwork, document: JSON.parse(artwork.opsJson), opsJson: undefined }, reflection });
}

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  // 그림 그리기는 유료 요금제 기능으로 잠겨 있다(lib/feature-locks.ts). 읽기(GET)는 그림책·보관함이 쓰므로 그대로 둔다.
  if (DRAWING_LOCKED) return drawingLockedResponse();
  if (!sameOrigin(request)) return jsonError("요청 출처를 확인할 수 없어요.", 403);
  const student = await studentFromRequest(request);
  if (!student) return jsonError("학생 로그인이 필요해요.", 401);
  if (!(await rateLimit(`artwork-save:${student.id}`, 90, 60))) return jsonError("저장이 너무 빨라요. 잠깐 기다려 주세요.", 429);
  const artworkId = cleanText((await context.params).id, 80); const payload = await request.json().catch(() => ({})) as Record<string, unknown>;
  const requestId = cleanText(payload.requestId, 80);
  if (!/^[a-zA-Z0-9_-]{12,80}$/.test(requestId)) return jsonError("저장 요청 번호가 올바르지 않아요.");
  const previousRequest = await priorMutation(requestId, artworkId, student.id);
  if (previousRequest) return noStoreJson({ ok: true, revision: previousRequest.resultRevision, duplicate: true });
  const artwork = await ownedArtwork(artworkId, student.id);
  if (!artwork) return jsonError("내 그림이 아니거나 찾을 수 없어요.", 404);
  if (artwork.status === "complete") return noStoreJson({ error: "완성한 작품은 새 사본으로 이어 그려 주세요.", code: "ARTWORK_COMPLETE", serverRevision: artwork.revision }, { status: 409 });
  const expectedRevision = Number(payload.expectedRevision);
  if (!Number.isInteger(expectedRevision) || expectedRevision !== artwork.revision) return noStoreJson({ error: "다른 저장이 먼저 반영됐어요.", code: "REVISION_CONFLICT", serverRevision: artwork.revision }, { status: 409 });
  const document = validateDrawDocument(payload.document); if (!document) return jsonError("그림 동작 데이터가 올바르지 않아요.");
  const serialized = JSON.stringify(document); if (serialized.length > MAX_DOCUMENT_BYTES) return jsonError("한 작품의 동작이 너무 커요.", 413);
  const currentStep = Math.max(0, Math.min(30, Number(payload.currentStep) || 0)); const complete = payload.complete === true;
  const reflection = (payload.reflection ?? {}) as Record<string, unknown>;
  const favoritePart = cleanText(reflection.favoritePart, 80); const favoriteReason = cleanText(reflection.favoriteReason, 180);
  const spokenDescription = cleanText(reflection.spokenDescription, 300); const storyText = cleanText(reflection.storyText, 600);
  // 2026-09-20 사용자 지시로 "마음에 드는 곳·왜 마음에 들어" 고르기를 없앴다. 소감은 더 이상 완성의 조건이 아니다
  // (몽그리 짐작을 고친 문장 storyText만 남는다). 옛 기록은 그대로 두고, 빈 값으로도 완성이 저장된다.

  const newRevision = artwork.revision + 1; const thumbnail = decodeImage(payload.thumbnailDataUrl, 500_000, THUMBNAIL_TYPES); const finalImage = complete ? decodeImage(payload.finalDataUrl, 3_500_000) : null;
  if (payload.thumbnailDataUrl && !thumbnail) return jsonError("썸네일 파일을 확인해 주세요.", 413);
  // Vercel 4.5MB 본문 한도 대응: 완성 PNG는 별도 바이너리 업로드로 먼저 올라오고,
  // 이 요청은 그 후보 키만 참조할 수 있다. 실제 존재·크기를 저장소에서 확인한다.
  const uploadedFinalKey = complete && !finalImage ? candidateFinalKey(payload.finalImageKey, student.id, artworkId) : null;
  if (complete && !finalImage && !uploadedFinalKey) return jsonError("완성 그림 파일을 확인해 주세요.", 413);
  if (uploadedFinalKey) {
    const uploaded = await bindings().ARTWORKS.head(uploadedFinalKey);
    if (!uploaded || uploaded.size > 3_500_000) return jsonError("완성 그림 파일을 확인해 주세요.", 413);
  }
  const nonce = randomToken(10);
  // 확장자도 실제 형식을 따른다 — WebP를 .png로 두면 저장소를 들여다보는 사람이 속는다.
  const thumbnailKey = thumbnail ? `students/${student.id}/artworks/${artworkId}/objects/r${newRevision}-${requestId}-${nonce}-thumb.${thumbnail.contentType === "image/webp" ? "webp" : "png"}` : null;
  const finalKey = finalImage ? `students/${student.id}/artworks/${artworkId}/objects/r${newRevision}-${requestId}-${nonce}-final.png` : uploadedFinalKey;
  // 같은 키를 candidate → committed로 두 번 put하면 이미지 인코딩 크기만큼 R2 업로드를
  // 매 저장마다 두 번 기다린다. 객체는 DB가 그 키를 가리키기 전에는 외부에서 발견할 수 없으므로
  // 한 번만 쓰고, DB 커밋 실패 시 아래 보상 삭제로 회수한다.
  await settleUploadsBeforeCleanup([
      thumbnail && thumbnailKey
        // 저장하는 형식을 그대로 적는다 — 하드코딩하면 WebP를 PNG라고 적어 보내 그림이 깨진다.
        ? bindings().ARTWORKS.put(thumbnailKey, thumbnail.bytes, { httpMetadata: { contentType: thumbnail.contentType, cacheControl: "private, max-age=60" }, customMetadata: { studentId: student.id, artworkId, requestId, state: "committed", revision: String(newRevision), kind: "thumbnail" } })
        : Promise.resolve(),
      finalImage && finalKey
        ? bindings().ARTWORKS.put(finalKey, finalImage.bytes, { httpMetadata: { contentType: finalImage.contentType, cacheControl: "private, max-age=300" }, customMetadata: { studentId: student.id, artworkId, requestId, state: "committed", revision: String(newRevision), kind: "final" } })
        : Promise.resolve(),
    ], () => removeCandidates([thumbnailKey, finalKey]));

  const db = bindings().DB; const versionId = id("version");
  const statements = [
    db.prepare(`UPDATE artworks SET ops_json = ?, current_step = ?, revision = ?, thumbnail_key = COALESCE(?, thumbnail_key), final_image_key = COALESCE(?, final_image_key), last_mutation_id = ?, status = CASE WHEN ? = 1 THEN 'complete' ELSE status END, completed_at = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE completed_at END, updated_at = CURRENT_TIMESTAMP, version_count = version_count + ? WHERE id = ? AND student_id = ? AND revision = ? AND status <> 'complete'`).bind(serialized, currentStep, newRevision, thumbnailKey, finalKey, requestId, complete ? 1 : 0, complete ? 1 : 0, complete ? 1 : 0, artworkId, student.id, expectedRevision),
    db.prepare(`INSERT OR IGNORE INTO artwork_mutations(request_id, artwork_id, student_id, result_revision) SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM artworks WHERE id = ? AND student_id = ? AND revision = ? AND last_mutation_id = ?)`).bind(requestId, artworkId, student.id, newRevision, artworkId, student.id, newRevision, requestId),
  ];
  if (complete) {
    // sequence는 batch 안에서 갱신된 version_count로 계산한다. 요청 시작 시점에 읽은 값을 쓰면
    // 그 사이 코칭 저장이 만든 버전과 UNIQUE(artwork_id, sequence) 충돌이 나 batch 전체가 실패한다.
    statements.push(db.prepare(`INSERT INTO artwork_versions(id, artwork_id, sequence, ops_json, image_key, reason) SELECT ?, a.id, a.version_count, ?, ?, 'complete' FROM artworks a WHERE a.id = ? AND a.student_id = ? AND a.revision = ? AND a.last_mutation_id = ?`).bind(versionId, serialized, finalKey, artworkId, student.id, newRevision, requestId));
    statements.push(db.prepare(`INSERT INTO reflections(artwork_id, favorite_part, favorite_reason, spoken_description, story_text, next_suggestion) SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM artworks WHERE id = ? AND student_id = ? AND revision = ? AND last_mutation_id = ?) ON CONFLICT(artwork_id) DO UPDATE SET favorite_part = excluded.favorite_part, favorite_reason = excluded.favorite_reason, spoken_description = excluded.spoken_description, story_text = excluded.story_text, next_suggestion = excluded.next_suggestion, updated_at = CURRENT_TIMESTAMP`).bind(artworkId, favoritePart, favoriteReason, spokenDescription, storyText, "다음 그림에는 어떤 일이 생길까?", artworkId, student.id, newRevision, requestId));
  }

  let results: D1Result[];
  try { results = await db.batch(statements); }
  catch (error) {
    await removeCandidates([thumbnailKey, finalKey]);
    const duplicate = await priorMutation(requestId, artworkId, student.id);
    if (duplicate) return noStoreJson({ ok: true, revision: duplicate.resultRevision, duplicate: true });
    // (student, arc, episode) 완성작 유일 제약(AD-10) 위반은 배치 안에서 터진다 —
    // 내부 오류(500)가 아니라 분기 가능한 409로 바꿔 내보낸다 (Story 3.4).
    if (error instanceof Error && /UNIQUE constraint failed: .*artworks/.test(error.message)) {
      return noStoreJson({ error: "이 회차에는 이미 완성한 그림이 있어요.", code: "EPISODE_ALREADY_COMPLETE" }, { status: 409 });
    }
    throw error;
  }
  if (!results[0]?.meta.changes) {
    await removeCandidates([thumbnailKey, finalKey]);
    const duplicate = await priorMutation(requestId, artworkId, student.id);
    if (duplicate) return noStoreJson({ ok: true, revision: duplicate.resultRevision, duplicate: true });
    const current = await ownedArtwork(artworkId, student.id);
    return noStoreJson({ error: current?.status === "complete" ? "완성한 작품은 바꿀 수 없어요." : "다른 저장이 먼저 반영됐어요.", code: current?.status === "complete" ? "ARTWORK_COMPLETE" : "REVISION_CONFLICT", serverRevision: current?.revision }, { status: 409 });
  }

  // 채택된 완성 이미지 키는 지우지 않는다(AD-6, Story 3.4) — storybook_assets.object_key가
  // 채택 당시 키의 스냅샷이라, 재완성이 가능해지는 순간 이 삭제가 아이가 만든 책 쪽을
  // 영구 백지로 만든다. 두 팀이 각자 테스트하면 잡히지 않는 유일한 지점이다.
  // 옛 썸네일 정리는 유지한다 — 지우지 않으면 자동저장마다 R2에 누적된다.
  // 옛 완성 키의 회수는 참조 여부를 아는 정리 작업(미구현)의 몫이다.
  await removeCandidates([thumbnailKey && artwork.thumbnailKey !== thumbnailKey ? artwork.thumbnailKey : null]);
  return noStoreJson({ ok: true, revision: newRevision, status: complete ? "complete" : artwork.status });
}
