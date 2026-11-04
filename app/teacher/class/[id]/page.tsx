import { TeacherApp } from "@/app/components/TeacherApp";
import { redirect } from "next/navigation";
import { requireTeacher } from "@/lib/security";
import { requiresHostedTeacherAuthentication } from "@/lib/runtime/environment";
import { studentAppEnabled } from "@/lib/product-mode";

export const dynamic = "force-dynamic";

export default async function TeacherClassPage({ params }: { params: Promise<{ id: string }> }) {
  const id = (await params).id;
  if (requiresHostedTeacherAuthentication() && !(await requireTeacher())) redirect(`/api/auth/google/start?return_to=${encodeURIComponent(`/teacher/class/${id}`)}`);
  // 그림책 공방(학생 앱 끔)에는 수업 진행실이 없다 — 학급을 열면 그림책 책상으로 간다.
  if (!studentAppEnabled()) redirect(`/teacher/class/${id}/books`);
  return <TeacherApp classroomId={id} />;
}
