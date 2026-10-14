"use client";

import { createContext, useContext, useEffect, useRef, useState, type ImgHTMLAttributes, type ReactNode } from "react";
import { storybookEditorFetch } from "@/lib/storybook-editor-fetch";

type Entry = { promise: Promise<string>; url?: string; bytes: number; users: number; controller: AbortController };
type Cache = Map<string, Entry>;
const Images = createContext<Cache | null>(null);
function prune(cache: Cache, all = false) {
  let bytes = [...cache.values()].reduce((n, e) => n + e.bytes, 0);
  for (const [key, entry] of cache) {
    if (all || (!entry.users && bytes > 32_000_000)) {
      entry.controller.abort(); if (entry.url) URL.revokeObjectURL(entry.url);
      bytes -= entry.bytes; cache.delete(key);
    }
  }
}
// One editor mount owns this cache; another student's session cannot reuse it.
export function AuthenticatedImageCache({ children }: { children: ReactNode }) {
  const [cache] = useState<Cache>(() => new Map());
  useEffect(() => () => prune(cache, true), [cache]);
  return <Images.Provider value={cache}>{children}</Images.Provider>;
}
export function AuthenticatedImage({ src, alt, className, onLoad, style, lazy = false }: { src: string; alt: string; className?: string; onLoad?: ImgHTMLAttributes<HTMLImageElement>["onLoad"]; style?: ImgHTMLAttributes<HTMLImageElement>["style"]; lazy?: boolean }) {
  const shared = useContext(Images);
  const [visible, setVisible] = useState(!lazy);
  const marker = useRef<HTMLSpanElement>(null);
  const [url, setUrl] = useState("");
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (visible || !marker.current) return;
    const observer = new IntersectionObserver(entries => { if (entries.some(e => e.isIntersecting)) { setVisible(true); observer.disconnect(); } }, { rootMargin: "160px" });
    observer.observe(marker.current); return () => observer.disconnect();
  }, [visible]);
  useEffect(() => {
    if (!visible) return;
    const cache = shared ?? new Map<string, Entry>();
    let cancelled = false;
    setUrl(""); setFailed(false);
    let entry = cache.get(src);
    if (!entry) {
      const controller = new AbortController();
      entry = { bytes: 0, users: 0, controller, promise: Promise.resolve("") };
      const created = entry;
      created.promise = storybookEditorFetch(src, { signal: controller.signal }).then(async response => {
        if (!response.ok) throw new Error("image unavailable");
        const blob = await response.blob();
        if (!blob.type.startsWith("image/") || controller.signal.aborted) throw new Error("invalid image");
        created.bytes = blob.size; created.url = URL.createObjectURL(blob); prune(cache);
        return created.url;
      }).catch(error => { if (cache.get(src) === created) cache.delete(src); throw error; });
      cache.set(src, created);
    }
    entry.users++;
    void entry.promise.then(value => { if (!cancelled) setUrl(value); }).catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; entry.users--; prune(cache, !shared); };
  }, [src, shared, visible]);
  if (url && !failed) return <img className={className} src={url} alt={alt} draggable={false} decoding="async" onLoad={onLoad} onError={() => setFailed(true)} style={style} />;
  return <span ref={marker} data-image-state={failed ? "error" : "loading"} className={className} style={style} role="img" aria-label={failed ? `${alt}을 불러오지 못했어요` : `${alt}을 불러오는 중`}>{failed ? "⚠️" : "🎨"}</span>;
}
