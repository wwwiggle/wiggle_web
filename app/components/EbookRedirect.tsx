"use client";

import { useEffect, useState } from "react";
import { requestEbookLink } from "@/lib/ebook-client";
import { Logo } from "./Logo";

/** The author's session lives in this tab, so the link is fetched in the browser and then opened. */
export function EbookRedirect({ bookId }: { bookId: string }) {
  const [error, setError] = useState("");
  useEffect(() => {
    void requestEbookLink(bookId).then(link => window.location.replace(link.path)).catch(cause => setError(cause instanceof Error ? cause.message : "ebook을 열지 못했어요."));
  }, [bookId]);
  return <main className="ebook-message"><Logo />{error ? <p className="error-box" role="alert">{error} <a href="/student/books">내 그림책으로</a></p> : <div className="loading-card">ebook을 펼치는 중…</div>}</main>;
}
