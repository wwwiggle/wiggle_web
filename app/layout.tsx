import { PresenceHeartbeat } from "./components/PresenceHeartbeat";
import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import "./globals.css";
import { InputModeTracker } from "./components/InputModeTracker";
import { ShopFrame } from "./components/ShopFrame";
import { studentAppEnabled } from "@/lib/product-mode";
import "./shop.css";

const title = "Wiggle — 함께 그리며 생각해요";
const description =
  "아이가 그리고, AI는 묻습니다. 설치 없이 교실에서 쓰는 초등 그림 창작 코칭 웹앱";

const STUDIO_TITLE = "꿈틀 그림책 — 학교 그림책 인쇄 주문";
const STUDIO_DESCRIPTION = "아이들 그림 사진·스캔이나 PDF로 그림책을 만들어 하드커버 책으로 주문해요.";

export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover" };

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:5173";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const metadataBase = new URL(`${protocol}://${host}`);

  // 그림책 공방이면 탭 제목·소개를 꿈틀 그림책으로 바꾼다(링크 미리보기 그림은 아직 옛 대문이다).
  const studio = !studentAppEnabled();
  return {
    metadataBase,
    title: studio ? { default: STUDIO_TITLE, template: "%s | 꿈틀 그림책" } : { default: title, template: "%s | Wiggle" },
    description: studio ? STUDIO_DESCRIPTION : description,
    icons: {
      // 브라우저 탭 아이콘은 손 흔드는 WIGGLE 마크다(2026-10-03 사용자 지정, 종전 크레용 그림 대체).
      // 원본 로고가 가로형이라 마크만 잘라 흰 바탕 정사각으로 올린다. app_icon.png는 제품 앱 아이콘이라 그대로 둔다.
      icon: [
        { url: "/brand/wiggle-icon-32.png", sizes: "32x32", type: "image/png" },
        { url: "/brand/wiggle-icon-512.png", sizes: "512x512", type: "image/png" },
      ],
      shortcut: "/brand/wiggle-icon-32.png",
      apple: { url: "/brand/wiggle-icon-180.png", sizes: "180x180", type: "image/png" },
    },
    openGraph: {
      title,
      description,
      type: "website",
      // 링크 미리보기 카드. 실제 대문 화면을 OG 표준 크기(1200×630)로 찍어 둔다 — 화면이 바뀌면 이 파일도 다시 찍는다.
      images: [{ url: new URL("/og.png", metadataBase), width: 1200, height: 630, alt: "Wiggle 대문 — 오늘은 어떤 생각을 그려볼까요?" }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [new URL("/og.png", metadataBase)],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const studio = !studentAppEnabled();
  return (
    <html lang="ko">
      {/* 그림책 공방이면 몸통에 shop을 달아 꿈틀 그림책(book.kkumtle.app)과 같은 쇼핑몰 모양을 입힌다(app/shop.css). */}
      {studio && <head><link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css" /></head>}
      <body className={studio ? "shop" : undefined}><InputModeTracker /><PresenceHeartbeat />{studio ? <ShopFrame>{children}</ShopFrame> : children}</body>
    </html>
  );
}
