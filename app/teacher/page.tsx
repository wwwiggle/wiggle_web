import { TeacherApp } from "@/app/components/TeacherApp";
import { TeacherStudioHome } from "@/app/components/TeacherStudioHome";
import { studentAppEnabled } from "@/lib/product-mode";
import { redirect } from "next/navigation";
import { requireTeacher } from "@/lib/security";
import { requiresHostedTeacherAuthentication } from "@/lib/runtime/environment";

export const dynamic = "force-dynamic";

export default async function TeacherPage() {
  if (requiresHostedTeacherAuthentication() && !(await requireTeacher())) redirect("/api/auth/google/start?return_to=%2Fteacher");
  // 그림책 공방(학생 앱 끔)에서는 수업 진행 대신 책 묶음(학급) 목록을 연다.
  return studentAppEnabled() ? <TeacherApp /> : <TeacherStudioHome />;
}
