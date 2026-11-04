import { redirect } from "next/navigation";
import { BookOrderPaymentReturn } from "@/app/components/BookOrderPaymentReturn";
import { requiresHostedTeacherAuthentication } from "@/lib/runtime/environment";
import { requireTeacher } from "@/lib/security";
export const dynamic = "force-dynamic";
// 토스 결제창에서 돌아오는 곳(성공·실패 모두). 여기서 서버가 승인해야 실제로 결제된다.
export default async function BookOrderPayPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (requiresHostedTeacherAuthentication() && !await requireTeacher()) redirect(`/api/auth/google/start?return_to=${encodeURIComponent(`/teacher/book-orders/${id}`)}`);
  return <BookOrderPaymentReturn orderId={id} />;
}
