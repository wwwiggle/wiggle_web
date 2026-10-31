// School name and grade, entered once by the teacher (an adult) when creating a class.
// Optional by design (minimum collection): students never type them, and they are never sent to
// student screens, ebooks or AI requests. Used for class management and to pre-fill print orders.
export const CLASSROOM_GRADES = [1, 2, 3, 4, 5, 6] as const;
export type ClassroomProfile = { schoolName: string; grade: number | null };

export function classroomProfileInput(payload: Record<string, unknown>): ClassroomProfile | { error: string } {
  const raw = typeof payload.schoolName === "string" ? payload.schoolName : "";
  const schoolName = raw.normalize("NFC").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (schoolName.length > 40) return { error: "학교 이름은 40자 안으로 적어 주세요." };
  const gradeValue = payload.grade === null || payload.grade === undefined || payload.grade === "" ? null : Number(payload.grade);
  if (gradeValue !== null && !CLASSROOM_GRADES.includes(gradeValue as (typeof CLASSROOM_GRADES)[number])) return { error: "학년은 1~6학년 중에서 골라 주세요." };
  return { schoolName, grade: gradeValue };
}
