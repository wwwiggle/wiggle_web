import { redirect } from "next/navigation";
import { TeacherBookOrderDesk } from "@/app/components/TeacherBookOrderDesk";
import { requiresHostedTeacherAuthentication } from "@/lib/runtime/environment";
import { requireTeacher } from "@/lib/security";
export const dynamic = "force-dynamic";
// 그림책 주문 → 견적서·입금 계좌(2026-10-31). 원고 PDF로 보내는 기존 제작 요청은 ../print-request.
export default async function BookOrdersPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (requiresHostedTeacherAuthentication() && !await requireTeacher()) redirect(`/api/auth/google/start?return_to=${encodeURIComponent(`/teacher/class/${id}/books/orders`)}`);
  return <TeacherBookOrderDesk classroomId={id} />;
}
