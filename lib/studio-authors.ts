import { bindings } from "@/db/runtime";
import { cleanText } from "@/lib/security";
import { id } from "@/lib/token-crypto";

/**
 * 그림책 공방(2026-11-04, lib/product-mode.ts): 학생 명단을 미리 만들지 않고, 책을 올릴 때 적은 지은이 이름으로
 * 학급 명단의 한 자리를 찾거나 만든다. 책은 지금처럼 학생(지은이) 한 명에게 묶인다 — 편집·ebook·주문 코드를 그대로 쓴다.
 *
 * 지은이는 입장하지 않으므로 참여 코드(entry_code)는 비워 둔다. 같은 이름이 이미 명단에 있으면 그 자리를 쓴다.
 */
export async function studioAuthor(classroomId: string, rawName: unknown) {
  const name = cleanText(rawName, 20);
  if (!name) return { error: "지은이 이름을 적어 주세요." } as const;
  const db = bindings().DB;
  const existing = await db.prepare(`SELECT id FROM student_profiles WHERE classroom_id=? AND archived_at IS NULL AND seat_number IS NOT NULL AND real_name=? ORDER BY seat_number LIMIT 1`).bind(classroomId, name).first<{ id: string }>();
  if (existing) return { id: existing.id } as const;
  // 번호는 명단 끝 다음 번호. 두 책을 동시에 올려 번호가 부딪히면(부분 유니크 인덱스) 다시 고른다.
  for (let attempt = 0; attempt < 3; attempt++) {
    const last = await db.prepare(`SELECT MAX(seat_number) AS seat FROM student_profiles WHERE classroom_id=? AND archived_at IS NULL`).bind(classroomId).first<{ seat: number | null }>();
    const seat = Number(last?.seat ?? 0) + 1, studentId = id("student");
    try {
      await db.prepare(`INSERT INTO student_profiles(id, classroom_id, seat_number, real_name, entry_code, claimed_at, nickname, animal, last_activity_at) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?)`)
        .bind(studentId, classroomId, seat, name, `${seat}번`, "📖", new Date().toISOString()).run();
      return { id: studentId } as const;
    } catch (error) {
      if (attempt === 2) throw error;
    }
  }
  return { error: "지은이를 명단에 넣지 못했어요." } as const;
}
