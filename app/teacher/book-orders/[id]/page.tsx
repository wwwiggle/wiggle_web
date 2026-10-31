import { redirect } from "next/navigation";
import { BookOrderQuote } from "@/app/components/BookOrderQuote";
import { requiresHostedTeacherAuthentication } from "@/lib/runtime/environment";
import { requireTeacher } from "@/lib/security";
export const dynamic = "force-dynamic";
export default async function BookOrderQuotePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (requiresHostedTeacherAuthentication() && !await requireTeacher()) redirect(`/api/auth/google/start?return_to=${encodeURIComponent(`/teacher/book-orders/${id}`)}`);
  return <BookOrderQuote orderId={id} />;
}
