"use client";

import { useEffect, useRef, useState } from "react";
import { DRAWING_LOCKED } from "@/lib/feature-locks";
import { activeProfile, flushSaves, studentFetch } from "@/lib/client-session";
import { Logo } from "./Logo";
import { DeskArtwork, StudentArtDesk } from "./StudentArtDesk";
import { WaitMongri } from "./WaitMongri";

type EntryData = { student: { nickname: string }; artworks: DeskArtwork[]; artworkTotal: number };

/* 커리큘럼이 사라지고(2026-09-12 사용자 결정) 수업은 빈 도화지에서 선생님이 진행한다.
 * 그래서 학생 홈(오늘 회차 카드·선반)은 없앴다.
 *
 * 2026-09-25 사용자 결정으로 이 화면은 다시 갈림길이 됐다. 판정은 **저장된 그림 총수** 하나다.
 *   0장  → 중간 화면 없이 바로 새 도화지. 처음 들어온 아이를 빈 목록 앞에 세워 두지 않는다.
 *   1장~ → 「그림 자리」(StudentArtDesk). 내 그림·새 그림·내 그림책이 한자리에 있다.
 * 종전에는 그리다 만 그림이 있으면 **자동으로** 그것을 열었다. 그러면 아이가 새 그림을 시작할
 * 길이 없었다 — 이제 목록에서 직접 「이어 그리기」를 고른다.
 * 총수는 페이지 크기(artworks 40장)가 아니라 artworkTotal로 본다. */
export function StudentEntry() {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [data, setData] = useState<EntryData | null>(null);
  const opened = useRef(false);

  async function open() {
    if (opened.current) return;
    const profile = activeProfile();
    if (!profile) { location.replace("/join"); return; }
    opened.current = true;
    setBusy(true); setError("");
    // 기기에 남은 저장분을 먼저 올려 둔다. 실패해도 계속 간다 — 큐는 그대로 남는다.
    void flushSaves(profile.studentId).catch(() => undefined);
    try {
      const response = await studentFetch("/api/student");
      const payload = await response.json() as EntryData & { error?: string };
      if (!response.ok) throw new Error(payload.error);
      if (!Number(payload.artworkTotal)) {
        // A student may only have a teacher-imported PDF. Keep their book reachable from home.
        const booksResponse = await studentFetch("/api/storybooks");
        const books = await booksResponse.json() as { storybooks?: unknown[]; error?: string };
        if (!booksResponse.ok) throw new Error(books.error ?? "그림책을 확인하지 못했어요.");
        // 그림 그리기가 잠겨 있으면(유료 요금제) 빈 도화지로 보내지 않고 그림 자리(그림책 만들기)를 보여 준다.
        if (!books.storybooks?.length && !DRAWING_LOCKED) { location.replace("/student/draw/new?mode=free"); return; }
      }
      setData(payload);
      setBusy(false);
    } catch (cause) {
      opened.current = false;
      setError(cause instanceof Error && cause.message ? cause.message : "도화지를 펴지 못했어요. 다시 해 볼까요?");
      setBusy(false);
    }
  }

  // open은 한 번만 돈다(opened ref). 다시 걸면 매 렌더마다 요청이 새로 나간다.
  useEffect(() => { void open(); }, []);

  if (data) return <StudentArtDesk nickname={data.student.nickname} artworks={data.artworks ?? []} artworkTotal={Number(data.artworkTotal) || 0} />;
  // 기다리는 동안은 대기 화면 하나(WaitMongri)만 쓴다. 다시 해 보기 단추가 필요한 실패 때만 안내 화면을 연다.
  if (!error) return <WaitMongri line="도화지를 펴고 있어요" />;
  return <main className="app-shell student-app">
    <header className="app-header"><Logo /></header>
    <div className="entry-error-block">
      <div className="error-box child-error" role="alert"><span className="child-error-icon" aria-hidden="true">⚠️</span><p>{error}</p></div>
      <button type="button" className="button primary full child-primary-action" disabled={busy} onClick={() => void open()}>
        <span aria-hidden="true">🔄</span>{busy ? "여는 중…" : "다시 해 보기"}
      </button>
      <a className="text-button" href="/join">처음으로</a>
    </div>
  </main>;
}
