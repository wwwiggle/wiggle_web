import type { Metadata } from "next";
import { DesignSurface } from "@/app/components/DesignSurface";

export const metadata: Metadata = { title: "그림책 ebook", robots: { index: false, follow: false } };

export default function Layout({ children }: { children: React.ReactNode }) {
  return <DesignSurface audience="student">{children}</DesignSurface>;
}
