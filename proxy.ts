import { NextResponse, type NextRequest } from "next/server";

/**
 * 점검 모드(2026-11-01, DB 이사 당일용). WIGGLE_MAINTENANCE=1이면 상태 확인(/api/health)을 뺀 모든 API가 503을 돌려준다.
 * DB를 옮기는 동안 어떤 쓰기도 들어오지 않게 하려는 것이다 — 읽기 요청도 세션·요청 횟수 같은 기록을 남기므로 함께 막는다.
 * 아이의 그림 저장은 5xx를 받으면 기기(IndexedDB)에 남겨 두고 나중에 다시 보낸다(lib/client-session.ts flushResponseDisposition).
 * 화면(HTML)은 그대로 열린다. Vercel 환경 변수를 바꾼 뒤 다시 배포해야 켜지고 꺼진다.
 */
export function proxy(request: NextRequest) {
  if (process.env.WIGGLE_MAINTENANCE?.trim() !== "1") return NextResponse.next();
  if (request.nextUrl.pathname === "/api/health") return NextResponse.next();
  return NextResponse.json(
    { error: "지금 잠깐 점검 중이에요. 그림은 기기에 남아 있으니 화면을 닫지 말고 몇 분 뒤 다시 해 주세요.", maintenance: true },
    { status: 503, headers: { "retry-after": "300", "cache-control": "no-store" } },
  );
}

export const config = {
  matcher: "/api/:path*",
};
