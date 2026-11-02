import { redirect } from "next/navigation";
import { TeacherEbookShelf } from "@/app/components/TeacherEbookShelf";
import { requiresHostedTeacherAuthentication } from "@/lib/runtime/environment";
import { requireTeacher } from "@/lib/security";

export const dynamic = "force-dynamic";

// 우리 반 ebook 서재: 완성한 그림책을 모두 꽂아 두고, 한 권을 누르면 두 쪽 펼침으로 읽는다(2026-11-02).
export default async function TeacherEbookShelfPage({ params }: { params: Promise<{ id: string }> }) {
  const id = (await params).id;
  const returnTo = `/teacher/class/${id}/books/ebooks`;
  if (requiresHostedTeacherAuthentication() && !(await requireTeacher())) redirect(`/api/auth/google/start?return_to=${encodeURIComponent(returnTo)}`);
  return <TeacherEbookShelf classroomId={id} />;
}
