import { notFound, redirect } from "next/navigation";
import { bindings } from "@/db/runtime";
import { requiresHostedTeacherAuthentication } from "@/lib/runtime/environment";
import { requireTeacher } from "@/lib/security";
import { ebookLink } from "@/lib/storybook-ebook";

export const dynamic = "force-dynamic";

// The class teacher opens any student's book in this class as an ebook, one book at a time.
export default async function TeacherEbookPage({ params }: { params: Promise<{ id: string; storybookId: string }> }) {
  const { id, storybookId } = await params;
  const teacher = await requireTeacher();
  if (!teacher) {
    if (requiresHostedTeacherAuthentication()) redirect(`/api/auth/google/start?return_to=${encodeURIComponent(`/teacher/class/${id}/books/${storybookId}/ebook`)}`);
    redirect(`/teacher/class/${encodeURIComponent(id)}/books`);
  }
  const book = await bindings().DB.prepare(`SELECT b.id FROM storybooks b JOIN classrooms c ON c.id = b.classroom_id JOIN student_profiles s ON s.id = b.student_id WHERE b.id = ? AND b.classroom_id = ? AND c.teacher_id = ? AND c.active = 1 AND s.archived_at IS NULL`).bind(storybookId, id, teacher.id).first<{ id: string }>();
  if (!book) notFound();
  const link = await ebookLink(book.id);
  redirect(`/ebook/${link.token}`);
}
