import "server-only";
import { bindings } from "@/db/runtime";
import type { StorybookDocument } from "@/lib/storybook-model";

export type StorybookRow = {
  id: string;
  studentId: string;
  classroomId: string;
  title: string;
  documentJson: string;
  schemaVersion: number;
  revision: number;
  status: "draft" | "complete";
  lastMutationId: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type StorybookAssetRow = {
  id: string;
  storybookId: string;
  studentId: string;
  sourceType: "artwork" | "upload";
  sourceArtworkId: string | null;
  objectKey: string;
  contentType: string;
  byteSize: number;
  createdAt: string;
};

export async function ownedStorybook(storybookId: string, studentId: string) {
  return bindings().DB.prepare(`SELECT id, student_id AS studentId, classroom_id AS classroomId, title, document_json AS documentJson, schema_version AS schemaVersion, revision, status, last_mutation_id AS lastMutationId, completed_at AS completedAt, created_at AS createdAt, updated_at AS updatedAt FROM storybooks WHERE id = ? AND student_id = ?`).bind(storybookId, studentId).first<StorybookRow>();
}

const ASSET_COLUMNS = "id, storybook_id AS storybookId, student_id AS studentId, source_type AS sourceType, source_artwork_id AS sourceArtworkId, object_key AS objectKey, content_type AS contentType, byte_size AS byteSize, created_at AS createdAt";

export async function storybookAssets(storybookId: string, studentId: string) {
  const rows = await bindings().DB.prepare(`SELECT ${ASSET_COLUMNS} FROM storybook_assets WHERE storybook_id = ? AND student_id = ? ORDER BY created_at, id`).bind(storybookId, studentId).all<StorybookAssetRow>();
  return rows.results;
}

// Uploads only need the added/reused row, even when a book retains thousands of originals.
export async function storybookAsset(storybookId: string, studentId: string, assetId: string) {
  return bindings().DB.prepare(`SELECT ${ASSET_COLUMNS} FROM storybook_assets WHERE id = ? AND storybook_id = ? AND student_id = ?`).bind(assetId, storybookId, studentId).first<StorybookAssetRow>();
}

export async function storybookArtworkAsset(storybookId: string, studentId: string, artworkId: string) {
  return bindings().DB.prepare(`SELECT ${ASSET_COLUMNS} FROM storybook_assets WHERE storybook_id = ? AND student_id = ? AND source_type = 'artwork' AND source_artwork_id = ? ORDER BY created_at, id LIMIT 1`).bind(storybookId, studentId, artworkId).first<StorybookAssetRow>();
}

export async function storybookAssetIds(storybookId: string, studentId: string) {
  const rows = await bindings().DB.prepare("SELECT id FROM storybook_assets WHERE storybook_id = ? AND student_id = ?").bind(storybookId, studentId).all<{ id: string }>();
  return new Set(rows.results.map(asset => asset.id));
}

export async function priorStorybookMutation(requestId: string, storybookId: string, studentId: string) {
  return bindings().DB.prepare(`SELECT result_revision AS resultRevision FROM storybook_mutations WHERE request_id = ? AND storybook_id = ? AND student_id = ?`).bind(requestId, storybookId, studentId).first<{ resultRevision: number }>();
}

export function storybookResponse(book: StorybookRow, assets: StorybookAssetRow[]) {
  let document: StorybookDocument;
  try {
    document = JSON.parse(book.documentJson) as StorybookDocument;
  } catch {
    throw new Error("저장된 그림책 데이터를 읽을 수 없어요.");
  }
  const { documentJson: _documentJson, ...summary } = book;
  void _documentJson;
  return {
    storybook: { ...summary, document },
    assets: assets.map(({ objectKey: _objectKey, studentId: _studentId, ...asset }) => {
      void _objectKey;
      void _studentId;
      return asset;
    }),
  };
}
