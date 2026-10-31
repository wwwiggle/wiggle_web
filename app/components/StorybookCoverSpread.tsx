"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { estimatedSpineWidthMm } from "@/lib/book-print-format";
import { BARCODE_AREA, backCoverIndex, innerPageIndexes, spineLabel, spineFontSizeMm } from "@/lib/storybook-structure";
import type { StorybookDocument, StorybookPage } from "@/lib/storybook-model";
import "./book-structure.css";

/** The printed cover as one opened sheet: back cover (left) | spine | front cover (right). */
export function StorybookCoverSpread({ title, document, renderPage, onClose }: { title: string; document: StorybookDocument; renderPage: (page: StorybookPage) => ReactNode; onClose: () => void }) {
  const closeButton = useRef<HTMLButtonElement>(null);
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; });
  useEffect(() => {
    const previous = window.document.activeElement as HTMLElement | null;
    closeButton.current?.focus();
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); closeRef.current(); } };
    window.addEventListener("keydown", key);
    return () => { window.removeEventListener("keydown", key); previous?.focus(); };
  }, []);
  const backIndex = backCoverIndex(document);
  const spineMm = estimatedSpineWidthMm(innerPageIndexes(document).length);
  const spine = spineLabel(title, document);
  const spineHasText = Boolean(spineFontSizeMm(spineMm) && (spine.title || spine.author));
  const panel = (page: StorybookPage | undefined, role: "front" | "back") => <div className={`cover-spread-panel ${role}`}>
    {page ? <div className={`storybook-stage preview format-${document.format}`} style={{ background: page.background }}><div className="storybook-stage-content">{renderPage(page)}</div></div>
      : <div className="cover-spread-empty"><b>뒷표지가 아직 없어요</b><span>마지막 쪽에서 ‘뒷표지’ 양식을 고르거나 ‘책 구성 갖추기’를 눌러 주세요. 없으면 무늬 없는 뒷면으로 인쇄돼요.</span></div>}
    {role === "back" && <div className="cover-spread-barcode" style={{ left: `${BARCODE_AREA.x * 100}%`, top: `${BARCODE_AREA.y * 100}%`, width: `${BARCODE_AREA.width * 100}%`, height: `${BARCODE_AREA.height * 100}%` }}>바코드·ISBN 자리</div>}
    <i className="cover-spread-safe" aria-hidden="true" />
  </div>;
  return <div className="storybook-modal-backdrop" role="presentation" onMouseDown={onClose}>
    <section className="cover-spread-modal" role="dialog" aria-modal="true" aria-labelledby="cover-spread-title" onMouseDown={event => event.stopPropagation()}>
      <header><div><p className="eyebrow">인쇄될 표지 한 장</p><h2 id="cover-spread-title">표지 펼쳐 보기</h2></div><button ref={closeButton} type="button" className="small-button" onClick={onClose}>닫기</button></header>
      <div className="cover-spread-labels" aria-hidden="true"><span>뒷표지</span><span>책등</span><span>앞표지</span></div>
      <div className="cover-spread-sheet" style={{ gridTemplateColumns: `243fr minmax(30px, ${spineMm}fr) 243fr` }}>
        {panel(backIndex === null ? undefined : document.pages[backIndex], "back")}
        <div className="cover-spread-spine" aria-label={`책등 ${spineMm}mm`}>{spineHasText ? <span>{[spine.title, spine.author].filter(Boolean).join("   ")}</span> : <small>{spineMm}mm</small>}</div>
        {panel(document.pages[0], "front")}
      </div>
      <ul className="cover-spread-notes">
        <li>점선은 접히는 선이에요. 책등 폭은 지금 쪽 수로 계산한 값({spineMm}mm)이고, 쪽 수가 바뀌면 다시 계산돼요.</li>
        <li>책등에는 책 제목과 앞표지의 ‘글 / 그림’ 칸이 자동으로 들어가요.{!spine.author && " 앞표지에 지은이를 적으면 함께 들어가요."}</li>
        <li>표지 그림은 가장자리에서 1cm 안쪽에 맞춰 인쇄돼요. 뒷표지 오른쪽 아래 바코드 자리는 비워 두세요.</li>
      </ul>
    </section>
  </div>;
}
