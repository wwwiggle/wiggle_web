"use client";

import { ReactNode, useEffect, useId, useRef, useState } from "react";
import { PaidLock } from "./PaidLock";
import { DRAWING_LOCKED } from "@/lib/feature-locks";
import { ArrowLeft, ArrowRightLeft, FileText, Hand, Lock, QrCode, Send, X } from "lucide-react";
import { Logo } from "./Logo";
import { useModalDialog } from "./useModalDialog";
import type { ClassroomData, Student, WorkspaceArtwork } from "./TeacherApp";
import { TeacherWorkArchive } from "./TeacherWorkArchive";
import { TeacherRosterSettings } from "./TeacherRosterSettings";

export function WorkspaceDialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  useModalDialog(ref, onClose);
  useEffect(() => { const previous = document.body.style.overflow; document.body.style.overflow = "hidden"; return () => { document.body.style.overflow = previous; }; }, []);
  return <div className="tcw-dialog-backdrop"><div ref={ref} className="tcw-dialog" role="dialog" aria-modal="true" aria-labelledby={id} tabIndex={-1}><header><h2 id={id}>{title}</h2><button type="button" aria-label={`${title} 닫기`} onClick={onClose}><X size={20} /></button></header>{children}</div></div>;
}

type Tab = "today" | "archive" | "settings";
const tabs: [Tab, string][] = [["today", "오늘 수업"], ["archive", "작품 · 그림책"], ["settings", "명단 · 설정"]];
function currentTab(): Tab { const value = new URLSearchParams(location.search).get("view"); return value === "archive" || value === "settings" ? value : "today"; }

/* 손든 아이 호출 줄 (2026-09-20).
 * 종전에는 손든 표시가 "오늘 수업" 탭 안에만 있어, 교사가 다른 탭에 있으면 아이가 불러도 몰랐다.
 * 그래서 이 줄은 탭 내용 **바깥**에 두어 세 탭 어디서나 같은 자리에 보인다.
 * 넓은 화면은 이름 칩을 늘어놓고(가안), 좁은 화면은 가장 오래 기다린 한 명 + "외 N명"으로 접는다(나안).
 * 접는 기준은 CSS 미디어 쿼리다 — 화면 폭을 JS로 재면 서버 렌더와 어긋나고 resize 처리가 붙는다. */
const HAND_CHIPS_WIDE = 4;

function waitedLabel(ms: number) {
  if (ms < 60_000) return "방금";
  return `${Math.floor(ms / 60_000)}분째`;
}

function HandRaiseStrip({ students, serverNow, entryLocks = 0, onOpenArtwork, onAction }: {
  students: Student[];
  serverNow?: string;
  /* 지금 입장이 잠긴 기기 수. 잠금은 기기 단위라 누구인지는 알 수 없다 —
   * 손들기처럼 "막힌 아이가 있다"는 것만 선생님이 알아차리게 한다(2026-09-22 사용자 결정). */
  entryLocks?: number;
  onOpenArtwork: (studentId: string) => void;
  onAction: (action: string, rest?: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
}) {
  // 손을 내린 직후 6초 폴링을 기다리지 않고 바로 사라지게 한다.
  const [lowered, setLowered] = useState<string[]>([]);
  // 렌더 중에 Date.now()를 부르지 않는다(react-hooks/purity). 시계는 effect에서만 읽어 상태에 담는다.
  const [clock, setClock] = useState(0);
  useEffect(() => {
    const update = () => setClock(Date.now());
    update();
    const timer = window.setInterval(update, 10_000);
    return () => window.clearInterval(timer);
  }, []);
  const raised = students
    .filter((student) => student.handRaisedAt && !lowered.includes(student.id))
    .sort((a, b) => (a.handRaisedAt ?? "").localeCompare(b.handRaisedAt ?? ""));
  // 다시 손을 든 아이는 낙관적으로 지운 목록에서 풀어 준다.
  useEffect(() => {
    const stillRaised = new Set(students.filter((student) => student.handRaisedAt).map((student) => student.id));
    setLowered((value) => value.filter((id) => stillRaised.has(id)));
  }, [students]);
  if (!raised.length && entryLocks <= 0) return null;
  // 교사 기기 시계가 틀어져 있어도 어긋나지 않게 서버 시각과의 차이를 뺀다.
  const skew = serverNow && clock ? clock - Date.parse(serverNow) : 0;
  const waitedMs = (at: string) => (clock ? Math.max(0, clock - skew - Date.parse(at)) : 0);
  const lower = (studentId: string) => { setLowered((value) => [...value, studentId]); void onAction("lowerHand", { studentId }); };
  const name = (student: Student) => `${student.seatNumber !== null ? `${String(student.seatNumber).padStart(2, "0")} ` : ""}${student.realName ?? student.nickname}`;
  return (
    <section className="tcw-hand-strip" aria-label="선생님을 부른 학생">
      {/* 인원이 바뀔 때만 읽힌다. 경과 시간은 10초마다 바뀌므로 여기에 넣지 않는다. */}
      <span className="sr-only" aria-live="polite">{raised.length}명이 선생님을 불렀어요{entryLocks > 0 ? `, 입장이 잠긴 기기 ${entryLocks}대` : ""}</span>
      {raised.length > 0 && <p className="tcw-hand-strip-title"><Hand size={18} aria-hidden="true" /><span>손 든 학생</span></p>}
      <ul className="tcw-hand-list">
        {raised.map((student) => (
          <li key={student.id}>
            <button type="button" className="tcw-hand-chip" onClick={() => onOpenArtwork(student.id)}>
              <b>{name(student)}</b>
              <small>{waitedLabel(waitedMs(student.handRaisedAt ?? ""))}</small>
            </button>
            <button type="button" className="tcw-hand-lower" onClick={() => lower(student.id)} aria-label={`${name(student)} 손 내리기`}>
              <span aria-hidden="true">손 내리기</span>
            </button>
          </li>
        ))}
      </ul>
      {/* 넓은 화면: 앞의 넷만 보이고 나머지는 수로 접는다. 좁은 화면: 첫 한 명만 보이고 나머지를 접는다. */}
      {raised.length > HAND_CHIPS_WIDE && <span className="tcw-hand-more">+{raised.length - HAND_CHIPS_WIDE}명 더</span>}
      {raised.length > 1 && <span className="tcw-hand-rest">외 {raised.length - 1}명</span>}
      {/* 코드를 여러 번 틀려 잠긴 기기. 선생님이 바로 풀어 줄 수 있어야 아이가 수업에서 빠지지 않는다. */}
      {entryLocks > 0 && <span className="tcw-entry-lock">
        <Lock size={16} aria-hidden="true" />
        <b>입장이 잠긴 기기 {entryLocks}대</b>
        <button type="button" onClick={() => void onAction("clearEntryLocks")}>잠금 풀기</button>
      </span>}
    </section>
  );
}

export type WorkspaceProps = {
  data: ClassroomData;
  lastUpdated: string;
  loadError: string;
  onRetry: () => void;
  onOpenArtwork: (studentId: string, artwork?: WorkspaceArtwork) => void;
  onMessage: () => void;
  onQr: (opener: HTMLButtonElement) => void;
  onAction: (action: string, rest?: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
  onArchive: (studentId: string) => void;
  onRestore: (studentId: string) => void;
  onDeleteClassroom: () => void;
  busyStudentId: string;
  deletingClassroom: boolean;
};

export function TeacherWorkspace(props: WorkspaceProps) {
  const { data, lastUpdated, loadError, onRetry, onOpenArtwork, onMessage, onQr } = props;
  const [tab, setTab] = useState<Tab>("today");
  useEffect(() => { const update = () => setTab(currentTab()); update(); window.addEventListener("popstate", update); return () => window.removeEventListener("popstate", update); }, []);
  function selectTab(next: Tab) { setTab(next); const url = new URL(location.href); if (next === "today") url.searchParams.delete("view"); else url.searchParams.set("view", next); history.pushState(null, "", url); }
  const room = data.classroom;
  const students = [...data.students].sort((a, b) => (a.seatNumber ?? 1000) - (b.seatNumber ?? 1000) || a.nickname.localeCompare(b.nickname, "ko"));
  const raisedCount = students.filter((student) => student.handRaisedAt).length;
  return <>
    <header className="tcw-header"><Logo /><a className="tcw-back" href="/teacher"><ArrowLeft size={20} /><span>학급 목록</span></a><h1>{room.displayName}</h1><div className="tcw-header-actions"><button type="button" onClick={(event) => onQr(event.currentTarget)}><QrCode size={19} />입장 안내</button><button type="button" className="tcw-primary" onClick={onMessage}><Send size={18} />전체 메시지</button></div></header>
    <nav className="tcw-tabs" aria-label="학급 메뉴">{tabs.map(([key, label]) => <a key={key} href={key === "today" ? `?` : `?view=${key}`} aria-current={tab === key ? "page" : undefined} onClick={(event) => { if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return; event.preventDefault(); selectTab(key); }}>{label}{key === "today" && raisedCount > 0 && <span className="tcw-tab-badge" aria-label={`${raisedCount}명이 선생님을 불렀어요`}>{raisedCount}</span>}</a>)}</nav>
    <HandRaiseStrip students={students} serverNow={data.serverNow} entryLocks={data.entryLocks} onOpenArtwork={onOpenArtwork} onAction={props.onAction} />
    {loadError && <div className="tcw-error" role="alert">새로 확인하지 못했어요. 마지막으로 받은 내용을 표시하고 있어요. <span>{loadError}</span><button onClick={onRetry}>다시 확인</button></div>}
    {tab === "today" && <section className="tcw-today" aria-label="오늘 수업">
      <div className="tcw-session"><div><h2>오늘 수업</h2><p>{DRAWING_LOCKED ? "아이들은 그림책 만들기로 들어와요. 그림책 실시간 보기에서 만드는 모습을 함께 봐요." : "아이들은 빈 도화지로 들어와요. 수업은 선생님이 이끌고, 여기서는 그리는 모습을 함께 봐요."}</p></div><a className="small-button" href={`/teacher/class/${room.id}/books/live`}>그림책 실시간 보기</a></div>
      <div className="tcw-section-title"><h2>학생 그림 <small>{students.length}명</small>{students.some((student) => student.handRaisedAt) && <small className="tcw-hand-count">🙋 {students.filter((student) => student.handRaisedAt).length}명이 불렀어요</small>}</h2><span>{DRAWING_LOCKED ? <PaidLock className="tcw-paid-note" message="학생 그림 실시간 보기는 유료 요금제 기능이에요.">학생별 최근 그림</PaidLock> : "학생별 최근 그림"}</span></div>
      {students.length ? <div className="tcw-student-grid">{students.map((student) => { const artwork = student.sessionArtwork; return <article key={student.id}>{DRAWING_LOCKED ? <PaidLock className="tcw-artwork" message="학생 그림 실시간 보기는 유료 요금제 기능이에요."><span>그림 실시간 보기</span></PaidLock> : <button type="button" className="tcw-artwork" onClick={() => onOpenArtwork(student.id)} aria-label={`${student.seatNumber ? `${student.seatNumber}번 ` : ""}${student.realName ?? student.nickname} 그림 자세히 보기`}>{artwork?.thumbnail ? <img src={artwork.thumbnail} alt={`${student.realName ?? student.nickname}의 ${artwork.title}`} /> : <span>{artwork ? "그림이 저장되면 여기에 보여요" : "아직 저장된 그림이 없어요"}</span>}</button>}<div className="tcw-student-caption"><b>{student.seatNumber !== null && <span>{String(student.seatNumber).padStart(2, "0")} </span>}{student.realName ?? student.nickname}</b>{student.handRaisedAt && <span className="tcw-hand" title="선생님을 불렀어요">🙋<span className="sr-only">선생님을 불렀어요</span></span>}{!DRAWING_LOCKED && <span className={`tcw-status ${artwork?.status === "complete" ? "is-complete" : ""}`}>{artwork?.status === "complete" ? "완성" : artwork ? "그리는 중" : "시작 전"}</span>}</div></article>; })}</div> : <div className="tcw-empty"><h3>아직 등록된 학생이 없어요</h3><p>명단을 등록한 뒤 입장 안내를 보여 주세요.</p><button onClick={() => selectTab("settings")}>명단 등록하기</button></div>}
      {lastUpdated && <p className="tcw-updated">{lastUpdated} 업데이트 · 6초마다 확인</p>}
    </section>}
    {tab === "archive" && <TeacherWorkArchive classroomId={room.id} students={students} onOpenArtwork={onOpenArtwork} />}
    {tab === "settings" && <TeacherRosterSettings {...props} />}
  </>;
}
