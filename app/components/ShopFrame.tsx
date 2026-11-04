"use client";
import { usePathname } from "next/navigation";

/**
 * 그림책 공방(2026-11-04, lib/product-mode.ts)의 쇼핑몰식 머리·바닥.
 * 꿈틀 그림책(book.kkumtle.app, kkumtle-book app/components/SiteHeader.tsx)과 같은 문법이다: 흰 바탕, 1px 선, 검정 버튼.
 * 편집기·ebook·운영 관리처럼 화면 전체를 쓰는 곳에는 붙이지 않는다.
 */
const BARE = [/\/books\/[^/]+\/edit$/, /\/ebooks?(\/|$)/, /^\/admin(\/|$)/];

export function ShopFrame({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? "/";
  if (BARE.some((pattern) => pattern.test(pathname))) return <>{children}</>;
  return <>
    <header className="shop-header">
      <div className="shop-util"><div className="shop-wrap"><a href="/teacher">선생님 로그인</a><a href="/teacher">내 학급</a><a href="/#shop-notice">주문 안내</a></div></div>
      <div className="shop-gnb"><div className="shop-wrap">
        <a className="shop-logo" href="/"><img src="/brand/wiggle-mark-128.png" alt="" width={28} height={28} /><span>꿈틀<em>그림책</em></span></a>
        <nav aria-label="메뉴"><a href="/">그림책 인쇄</a><a href="/#shop-notice">상품정보</a><a href="/#shop-how">만드는 방법</a><a href="/teacher">내 그림책</a></nav>
        <a className="shop-pill" href="/teacher">그림책 만들기</a>
      </div></div>
    </header>
    {children}
    <footer className="shop-foot"><div className="shop-wrap">
      <nav aria-label="약관"><a href="/terms">이용약관</a><a href="/privacy"><b>개인정보처리방침</b></a></nav>
      <p>꿈틀 그림책 공방 · 아이들 그림으로 만드는 학교 그림책</p>
    </div></footer>
  </>;
}
