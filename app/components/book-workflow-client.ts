export async function teacherRequest<T>(url: string, init?: RequestInit): Promise<T> {
  let response = await fetch(url, { cache: "no-store", ...init });
  if (response.status === 401 && location.hostname === "localhost") {
    await fetch("/api/teacher", { cache: "no-store" });
    response = await fetch(url, { cache: "no-store", ...init });
  }
  const data = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? "요청을 처리하지 못했어요.");
  return data;
}
export const postJson = (data: unknown, method = "POST"): RequestInit => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
export function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob), a = document.createElement("a"); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
export async function downloadFeedback(id: string, options?: import("@/lib/feedback-export").FeedbackExportOptions) {
  const { feedbackExportQuery } = await import("@/lib/feedback-export");
  const response = await fetch(`/api/teacher/book-feedback/${id}?format=pdf${options ? "&" + feedbackExportQuery(options) : ""}`, { cache: "no-store" });
  if (!response.ok) { const body = await response.json() as { error: string }; throw new Error(body.error); }
  const disposition = response.headers.get("content-disposition") ?? "";
  const filename = decodeURIComponent(disposition.split("filename*=UTF-8''")[1] ?? "피드백.pdf");
  return { bytes: new Uint8Array(await response.arrayBuffer()), filename };
}
export type CompletedBook = { id: string; title: string; studentId: string; nickname: string; animal: string; seatNumber: number | null; realName: string | null; revision: number; pageCount: number; completedAt: string; cover: { background: string; imageAssetId: string | null; backgroundAssetId: string | null; text: string } };
export type DraftBook = { id: string; title: string; studentId: string; seatNumber: number | null; realName: string | null; nickname: string; animal: string; updatedAt: string; pageCount: number | null };
export const jobLabel = (status?: string) => ({ queued: "대기 중", waiting_key: "API 키 대기", processing: "만드는 중", failed: "재시도 필요", complete: "피드백 완료", ready: "주문 준비 완료", draft: "견적 저장", submitted: "주문 접수", submitting: "전송 중", uncertain: "전송 결과 확인 필요" }[status ?? ""] ?? "아직 요청 안 함");
