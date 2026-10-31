import { bindings } from "@/db/runtime";
import { DEFAULT_STORYBOOK_FORMAT, MIN_STORYBOOK_PAGES } from "@/lib/storybook-model";
import { newStructuredStorybook } from "@/lib/storybook-structure";
import { cleanText, id, jsonError, noStoreJson, rateLimit, sameOrigin, studentFromRequest } from "@/lib/security";
import { ownedStorybook, storybookAssets, storybookResponse } from "@/lib/storybook-store";

type CompletedArtwork = { id: string; title: string; finalImageKey: string };

export async function GET(request: Request) {
  const student = await studentFromRequest(request);
  if (!student) return jsonError("학생 로그인이 필요해요.", 401);
  const rows = await bindings().DB.prepare(`SELECT id, title, document_json AS documentJson, revision, status, completed_at AS completedAt, created_at AS createdAt, updated_at AS updatedAt FROM storybooks WHERE student_id = ? ORDER BY updated_at DESC, id DESC`).bind(student.id).all();
  const storybooks = rows.results.map((row) => {
    const item = row as { documentJson: string } & Record<string, unknown>;
    let pageCount = 1;
    try {
      const parsed = JSON.parse(item.documentJson) as { pages?: unknown[] };
      pageCount = Array.isArray(parsed.pages) ? parsed.pages.length : 1;
    } catch {}
    const { documentJson: _documentJson, ...summary } = item;
    void _documentJson;
    return { ...summary, pageCount };
  });
  return noStoreJson({ storybooks });
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return jsonError("요청 출처를 확인할 수 없어요.", 403);
  const student = await studentFromRequest(request);
  if (!student) return jsonError("학생 로그인이 필요해요.", 401);
  if (!(await rateLimit(`storybook-create:${student.id}`, 20, 60))) return jsonError("새 그림책을 너무 빨리 만들고 있어요.", 429);
  const payload = await request.json().catch(() => ({})) as Record<string, unknown>;
  const format = DEFAULT_STORYBOOK_FORMAT;
  const artworkId = cleanText(payload.artworkId, 80);
  let artwork: CompletedArtwork | null = null;
  if (artworkId) {
    artwork = await bindings().DB.prepare(`SELECT id, title, final_image_key AS finalImageKey FROM artworks WHERE id = ? AND student_id = ? AND status = 'complete' AND final_image_key IS NOT NULL`).bind(artworkId, student.id).first<CompletedArtwork>();
    if (!artwork) return jsonError("완성된 내 그림을 찾을 수 없어요.", 404);
  }

  const storybookId = id("storybook");
  // 2026-11-01: 새 책은 처음부터 앞표지·면지·작가의 말·속표지·내지·뒷표지 꼴로 시작한다(최소 24쪽).
  const document = newStructuredStorybook(format, (prefix) => id(prefix), MIN_STORYBOOK_PAGES);
  const assetId = artwork ? id("asset") : null;
  if (assetId) {
    document.pages[0].elements.push({
      id: id("element"), type: "image", assetId,
      x: 0.08, y: 0.27, width: 0.84, height: 0.65,
      rotation: 0, zIndex: 1, opacity: 1, locked: false,
    });
  }
  const title = cleanText(payload.title, 60) || (artwork ? `${artwork.title} 그림책` : "");
  const db = bindings().DB;
  const statements = [
    db.prepare(`INSERT INTO storybooks(id, student_id, classroom_id, title, document_json, schema_version) VALUES (?, ?, ?, ?, ?, 1)`).bind(storybookId, student.id, student.classroomId, title, JSON.stringify(document)),
  ];
  if (artwork && assetId) {
    const object = await bindings().ARTWORKS.head(artwork.finalImageKey);
    if (!object) return jsonError("완성 그림 파일을 찾을 수 없어요.", 404);
    statements.push(db.prepare(`INSERT INTO storybook_assets(id, storybook_id, student_id, source_type, source_artwork_id, object_key, content_type, byte_size) VALUES (?, ?, ?, 'artwork', ?, ?, ?, ?)`).bind(assetId, storybookId, student.id, artwork.id, artwork.finalImageKey, object.httpMetadata?.contentType ?? "image/png", object.size));
  }
  await db.batch(statements);
  const book = await ownedStorybook(storybookId, student.id);
  if (!book) return jsonError("그림책을 만들 수 없어요.", 409);
  return noStoreJson(storybookResponse(book, await storybookAssets(storybookId, student.id)), { status: 201 });
}
