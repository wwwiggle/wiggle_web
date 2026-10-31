// 유료 요금제 기능 잠금(2026-10-31 사용자 결정).
// 지금 서비스는 「그림책 만들기 → 선생님 주문·견적」에 집중한다. 그림 그리기(그림판·몽그리 AI 코칭·
// 선생님 실시간 그림 보기)는 코드를 지우지 않고 유료 요금제 기능으로 잠가 둔다.
// 다시 열려면 DRAWING_LOCKED를 false로 바꾸면 된다(화면·API가 모두 이 값 하나를 본다). 자세한 목록: docs/paid-features.md
export const DRAWING_LOCKED: boolean = true;
export const PAID_PLAN_LABEL = "유료 요금제";
export const DRAWING_LOCKED_MESSAGE = "그림 그리기는 유료 요금제 기능이에요.";
export const DRAWING_LOCKED_CODE = "DRAWING_LOCKED";

/** 잠긴 API가 돌려주는 응답. 409가 아닌 4xx라 기기에 남은 그림 저장분은 지우지 않고 보존된다(lib/client-session.ts). */
export function drawingLockedResponse() {
  return Response.json({ error: DRAWING_LOCKED_MESSAGE, code: DRAWING_LOCKED_CODE }, { status: 403, headers: { "cache-control": "no-store" } });
}
