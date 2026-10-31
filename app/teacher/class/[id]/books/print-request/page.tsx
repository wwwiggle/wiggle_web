import { redirect } from "next/navigation";
import { TeacherBookOrders } from "@/app/components/TeacherBookOrders";
import { requiresHostedTeacherAuthentication } from "@/lib/runtime/environment";
import { requireTeacher } from "@/lib/security";
export const dynamic = "force-dynamic";
// 기존 「제작 요청」(인쇄 PDF 원고를 준비해 운영자에게 보내는 흐름). 2026-10-31부터 기본 주문 화면은 견적서 주문이다.
export default async function BookPrintRequestPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (requiresHostedTeacherAuthentication() && !await requireTeacher()) redirect(`/api/auth/google/start?return_to=${encodeURIComponent(`/teacher/class/${id}/books/print-request`)}`);
  return <TeacherBookOrders classroomId={id} />;
}
