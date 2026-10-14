"use client";

import { useEffect, useState, type RefObject } from "react";
import type { StorybookDocument } from "@/lib/storybook-model";

type PrintStatus = { ready: boolean; loaded: number; total: number; failedPages: number[]; timedOut: boolean };
const initial: PrintStatus = { ready: false, loaded: 0, total: 0, failedPages: [], timedOut: false };

// Inspect the actual print tree, including repeated pictures and page backgrounds.
// A successful HTTP fetch alone is insufficient: the browser must decode every img.
export function useStorybookPrint(root: RefObject<HTMLElement | null>, document: StorybookDocument | undefined, attempt: number) {
  const [status, setStatus] = useState<PrintStatus>(initial);
  useEffect(() => {
    const element = root.current;
    if (!element || !document) return;
    const expected = document.pages.map(page => Number(!!page.backgroundAssetId) + page.elements.filter(item => item.type === "image").length);
    const total = expected.reduce((sum, count) => sum + count, 0);
    let cancelled = false, timedOut = false, fontsReady = false, scheduled = false;
    const decoded = new WeakSet<HTMLImageElement>(), decoding = new WeakSet<HTMLImageElement>(), failed = new WeakSet<HTMLImageElement>();
    const publish = (next: PrintStatus) => setStatus(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
    const schedule = () => {
      if (cancelled || scheduled) return;
      scheduled = true;
      queueMicrotask(() => { scheduled = false; if (!cancelled) inspect(); });
    };
    const inspect = () => {
      const articles = Array.from(element.children);
      const failedPages: number[] = [];
      let loaded = 0;
      expected.forEach((count, index) => {
        const article = articles[index];
        const images = Array.from(article?.querySelectorAll<HTMLImageElement>("img") ?? []);
        const placeholders = article?.querySelectorAll("[data-image-state]");
        let pageLoaded = 0;
        let pageFailed = images.length + (placeholders?.length ?? 0) !== count || !!article?.querySelector('[data-image-state="error"]');
        for (const image of images) {
          if (failed.has(image) || (image.complete && !image.naturalWidth)) pageFailed = true;
          else if (decoded.has(image)) pageLoaded++;
          else if (image.complete && image.naturalWidth && !decoding.has(image)) {
            decoding.add(image);
            void image.decode().then(() => decoded.add(image), () => failed.add(image)).finally(schedule);
          }
        }
        loaded += pageLoaded;
        if (pageFailed || (timedOut && pageLoaded < count)) failedPages.push(index + 1);
      });
      publish({ ready: loaded === total && !failedPages.length && fontsReady, loaded, total, failedPages, timedOut: timedOut && (!fontsReady || loaded < total) });
    };
    publish({ ...initial, total });
    const observer = new MutationObserver(schedule);
    observer.observe(element, { childList: true, subtree: true, attributes: true, attributeFilter: ["src", "data-image-state"] });
    element.addEventListener("load", schedule, true);
    element.addEventListener("error", schedule, true);
    const timer = window.setTimeout(() => { timedOut = true; schedule(); }, 60_000);
    void window.document.fonts.ready.then(() => { fontsReady = true; schedule(); });
    schedule();
    return () => {
      cancelled = true;
      observer.disconnect();
      window.clearTimeout(timer);
      element.removeEventListener("load", schedule, true);
      element.removeEventListener("error", schedule, true);
    };
  }, [root, document, attempt]);
  return status;
}
