import type { Metadata } from "next";
import { DesignSurface } from "@/app/components/DesignSurface";
import { PdfResizeTool } from "@/app/components/PdfResizeTool";

// Test screen for lib/pdf-resize.ts (2026-11-02). Not linked from the product yet; files never leave the browser.
export const metadata: Metadata = { title: "PDF 판형 바꾸기 (시험)", robots: { index: false, follow: false } };

export default function PdfResizePage() {
  return <DesignSurface audience="adult"><PdfResizeTool /></DesignSurface>;
}
