import { DRAWING_LOCKED, drawingLockedResponse } from "@/lib/feature-locks";
import { bindings } from "@/db/runtime";
import { emptyDocument } from "@/lib/drawing-model";
import { lessonBySlug } from "@/lib/lesson-content";
import { GUIDED_LESSON_VARIANT_COUNT } from "@/lib/lesson-guide-variants";
import { cleanText, id, jsonError, noStoreJson, rateLimit, sameOrigin, studentFromRequest } from "@/lib/security";

export async function GET(request: Request) {
  const student = await studentFromRequest(request);
  if (!student) return jsonError("학생 로그인이 필요해요.", 401);
  const rows = await bindings().DB.prepare(`SELECT id, title, topic, learning_mode AS learningMode, lesson_slug AS lessonSlug, guide_variant AS guideVariant, intent, current_step AS currentStep, revision, status, updated_at AS updatedAt, completed_at AS completedAt FROM artworks WHERE student_id = ? ORDER BY updated_at DESC, id DESC LIMIT 50`).bind(student.id).all();
  return noStoreJson({ artworks: rows.results });
}

export async function POST(request: Request) {
  // 그림 그리기는 유료 요금제 기능으로 잠겨 있다(lib/feature-locks.ts). 읽기(GET)는 그림책·보관함이 쓰므로 그대로 둔다.
  if (DRAWING_LOCKED) return drawingLockedResponse();
  if (!sameOrigin(request)) return jsonError("요청 출처를 확인할 수 없어요.", 403);
  const student = await studentFromRequest(request);
  if (!student) return jsonError("학생 로그인이 필요해요.", 401);
  if (!(await rateLimit(`artwork-create:${student.id}`, 20, 60))) return jsonError("새 그림을 너무 빨리 만들고 있어요.", 429);
  const payload = await request.json().catch(() => ({})) as Record<string, unknown>;
  const clientArtworkId = cleanText(payload.clientArtworkId, 80);
  const artworkId = /^artwork_[a-zA-Z0-9_-]{12,64}$/.test(clientArtworkId) ? clientArtworkId : id("artwork");
  const mode = cleanText(payload.learningMode, 20);
  if (!["practice", "guided", "observe", "free"].includes(mode)) return jsonError("그리기 활동을 다시 골라 주세요.");
  const lessonSlug = cleanText(payload.lessonSlug, 80) || null;
  const lesson = lessonSlug ? lessonBySlug(lessonSlug) : undefined;
  if (lessonSlug && (!lesson || lesson.mode !== mode)) return jsonError("학습 활동을 다시 골라 주세요.");
  if (mode !== "free" && !lesson) return jsonError("학습 활동을 다시 골라 주세요.");
  const title = lesson?.title ?? (cleanText(payload.title, 50) || "새 그림");
  const topic = lesson?.topic ?? (cleanText(payload.topic, 50) || title);
  const intent = cleanText(payload.intent, 160);
  let guideVariant = 0;
  if (lesson?.mode === "guided") {
    const prior = await bindings().DB.prepare(`SELECT COUNT(*) AS count FROM artworks WHERE student_id = ? AND lesson_slug = ?`).bind(student.id, lesson.slug).first<{ count: number }>();
    guideVariant = Number(prior?.count ?? 0) % GUIDED_LESSON_VARIANT_COUNT;
  }
  await bindings().DB.prepare(`INSERT INTO artworks(id, student_id, classroom_id, title, topic, learning_mode, lesson_slug, guide_variant, intent, ops_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`).bind(artworkId, student.id, student.classroomId, title, topic, mode, lesson?.slug ?? null, guideVariant, intent, JSON.stringify(emptyDocument())).run();
  const artwork = await bindings().DB.prepare(`SELECT id, title, topic, learning_mode AS learningMode, lesson_slug AS lessonSlug, guide_variant AS guideVariant, intent, revision, status FROM artworks WHERE id = ? AND student_id = ?`).bind(artworkId, student.id).first();
  if (!artwork) return jsonError("그림을 만들 수 없어요.", 409);
  return noStoreJson({ artwork }, { status: 201 });
}
