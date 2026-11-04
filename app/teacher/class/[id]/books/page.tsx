import { redirect } from "next/navigation";
import { TeacherStorybookLibrary } from "@/app/components/TeacherStorybookLibrary";
import { requiresHostedTeacherAuthentication } from "@/lib/runtime/environment";
import { requireTeacher } from "@/lib/security";
import { studentAppEnabled } from "@/lib/product-mode";

export const dynamic = "force-dynamic";

export default async function TeacherStorybooksPage({ params }: { params: Promise<{ id: string }> }) {
  const id = (await params).id;
  const returnTo = `/teacher/class/${id}/books`;
  if (requiresHostedTeacherAuthentication() && !(await requireTeacher())) redirect(`/api/auth/google/start?return_to=${encodeURIComponent(returnTo)}`);
  return <TeacherStorybookLibrary classroomId={id} studio={!studentAppEnabled()} />;
}
