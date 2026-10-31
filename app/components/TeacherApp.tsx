"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Check } from "lucide-react";
import { copyText } from "@/lib/copy-text";
import { useCopyFeedback } from "./useCopyFeedback";
import { parseRosterRows, RosterRow } from "@/lib/roster";
import { blankRows, RosterEditor } from "./RosterRowsEditor";
import { Logo } from "./Logo";
import { QrCode } from "./QrCode";
import { TeacherLiveView } from "./TeacherLiveView";
import { TeacherWorkspace, WorkspaceDialog } from "./TeacherWorkspace";
import "./TeacherWorkspace.css";
import { useModalDialog } from "./useModalDialog";

type Classroom = { id: string; displayName: string; classCode: string; joinToken: string; admissionOpen: number; currentActivity: string; currentActivityKey: string; currentActivityLabel: string; studentCount: number; updatedAt: string };
export type WorkspaceArtwork = { id: string; title: string; status: string; thumbnail: string | null; updatedAt: string };
export type Student = { sessionArtwork: (WorkspaceArtwork & { currentStep: number; revision: number }) | null; id: string; nickname: string; animal: string; seatNumber: number | null; realName: string | null; entryCode: string | null; claimedAt: string | null; createdAt: string; lastActivityAt: string; artworkId: string | null; completedArtworkId: string | null; artworkTitle: string | null; status: string | null; currentStep: number | null; revision: number | null; thumbnail: string | null; handRaisedAt: string | null; artworkUpdatedAt: string | null; artworkCount: number; drawingArtworkCount: number; completedArtworkCount: number; duplicateNickname: boolean };
export type ArchivedStudent = { id: string; nickname: string; animal: string; seatNumber: number | null; realName: string | null; lastActivityAt: string; archivedAt: string; artworkCount: number };
type FamilyLink = { id: string; studentId: string; scope: "artwork" | "bundle"; expiresAt: string; revokedAt: string | null; createdAt: string; artworkCount: number };
type TeacherArtworkHistory = { id: string; title: string; topic: string; learningMode: string; lessonSlug: string | null; status: string; currentStep: number; updatedAt: string; completedAt: string | null; thumbnail: string | null };
export type ClassroomData = { serverNow?: string; entryLocks?: number; classroom: Classroom; profile?: { schoolName: string; grade: number | null }; students: Student[]; archivedStudents: ArchivedStudent[]; messages: Array<{ id: string; studentId: string | null; body: string; createdAt: string; nickname?: string; seenCount?: number }>; familyLinks: FamilyLink[]; teacher: { displayName: string; isAdmin?: boolean; source?: "siwc" | "local" } };
type TeacherPayload = Partial<ClassroomData> & { error?: string; localDemo?: boolean; teacher?: { displayName: string; isAdmin?: boolean; source?: "siwc" | "local" }; classrooms?: Classroom[] };

function profileDate(value: string) {
  if (!value) return "기록 없음";
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? `${value.replace(" ", "T")}Z` : value;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return "기록 없음";
  return date.toLocaleString("ko-KR", { year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function StudentProfileFacts({ student }: { student: Student }) {
  return <section className="student-profile-facts" aria-label={`${student.nickname} 학생 프로필 정보`}>
    {student.duplicateNickname && <strong className="duplicate-nickname-badge">같은 별명 있음</strong>}
    <dl>
      <div><dt>프로필 생성</dt><dd>{profileDate(student.createdAt)}</dd></div>
      <div><dt>마지막 접속</dt><dd>{profileDate(student.lastActivityAt)}</dd></div>
      <div><dt>작품</dt><dd>전체 {student.artworkCount} · 진행 {student.drawingArtworkCount} · 완료 {student.completedArtworkCount}</dd></div>
    </dl>
  </section>;
}

function lessonDate(value: string) {
  // CURRENT_TIMESTAMP('YYYY-MM-DD HH:MM:SS')는 Safari에서 Invalid Date라 ISO로 맞춘다.
  const date = new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
  if (Number.isNaN(date.getTime())) return "";
  const label = `${date.getMonth() + 1}월 ${date.getDate()}일`;
  const today = new Date();
  const days = Math.round((new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime() - new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()) / 86_400_000);
  return days === 0 ? `오늘 (${label})` : days === 1 ? `어제 (${label})` : label;
}

function AdmissionBadge({ open }: { open: number }) {
  return <span className={`admission-badge ${open ? "is-open" : "is-closed"}`}>{open ? "입장 열림" : "입장 닫힘"}</span>;
}

const UsersIcon = () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></svg>;
const CalendarIcon = () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" /></svg>;

function ClassroomCard({ item }: { item: Classroom }) {
  return <article className="class-card">
    <div className="class-card-head"><h3>{item.displayName}</h3><AdmissionBadge open={item.admissionOpen} /></div>
    <p>{item.currentActivity}</p>
    <div className="class-card-foot"><span><UsersIcon />{item.studentCount}명</span><span><CalendarIcon />{lessonDate(item.updatedAt)}</span><a className={`class-open-link${item.admissionOpen ? " is-primary" : ""}`} href={`/teacher/class/${item.id}`} aria-label={`${item.displayName} 학급 열기`}>학급 열기</a></div>
  </article>;
}

function ClassroomRow({ item, deleting, onDelete, onQr, onCopy, copiedKey }: { item: Classroom; deleting: boolean; onDelete: (item: Classroom) => void; onQr: (item: Classroom, opener: HTMLButtonElement) => void; onCopy: (text: string, label: string, key: string) => void; copiedKey: string }) {
  return <tr>
    <td data-label="학급명"><b>{item.displayName}</b><div className="class-row-meta"><span>수업 코드 {item.classCode}</span><button type="button" onClick={() => onCopy(item.classCode, "수업 코드", `class-${item.id}`)} aria-label={`${item.displayName} 수업 코드 복사`}>{copiedKey === `class-${item.id}` ? <Check size={15} className="copy-check" /> : "복사"}</button><button type="button" onClick={(event) => onQr(item, event.currentTarget)} aria-label={`${item.displayName} 입장 QR 보기`}>QR 보기</button></div></td>
    <td data-label="오늘 활동">{item.currentActivity}</td>
    <td data-label="등록 학생">{item.studentCount}명</td>
    <td data-label="입장 상태"><AdmissionBadge open={item.admissionOpen} /></td>
    <td data-label="최근 수업">{lessonDate(item.updatedAt)}</td>
    <td className="class-row-actions"><a className={`class-open-link${item.admissionOpen ? " is-primary" : ""}`} href={`/teacher/class/${item.id}`} aria-label={`${item.displayName} 학급 열기`}>학급 열기</a><details className="row-menu"><summary aria-label={`${item.displayName} 더 보기`}>⋯</summary><button type="button" className="class-delete-button" aria-label={`${item.displayName} 학급 삭제`} disabled={deleting} onClick={() => onDelete(item)}>{deleting ? "삭제 처리 중…" : "학급 삭제"}</button></details></td>
  </tr>;
}

/* 선생님 화면 첫 불러오기(2026-09-14 사용자 결정 — 코덱스 시안 docs/design-assets/teacher-loading/loading.png).
 * 빈 페이지의 점선 상자 대신 실제 머리 줄 + 회색 뼈대를 보여 준다. 첫 응답이 권한 오류(403) 같은 실패면
 * 예전에는 상자가 안내 없이 끝나지 않았다(2026-09-14 로컬 실측). 같은 안내 줄을 오류 문구와 행동 버튼으로 바꾼다. */
function TeacherLoading({ classPage, error, onRetry }: { classPage: boolean; error: string; onRetry: () => void }) {
  return <main className={`teacher-workspace tcw-loading${error ? " is-failed" : ""}`} aria-busy={!error}>
    <header className="tcw-header"><Logo />{classPage && <><a className="tcw-back" href="/teacher"><ArrowLeft size={20} /><span>학급 목록</span></a><span className="tcw-skel tcw-skel-title" aria-hidden="true" /></>}<div className="tcw-header-actions" aria-hidden="true"><span className="tcw-skel tcw-skel-button" /><span className="tcw-skel tcw-skel-button" /></div></header>
    <div className="tcw-loading-tabs" aria-hidden="true"><span className="tcw-skel" /><span className="tcw-skel" /><span className="tcw-skel" /></div>
    {error
      ? <div className="tcw-loading-status is-error" role="alert"><span>{error}</span><span className="tcw-loading-actions">{classPage && <a className="tcw-link-button tcw-primary" href="/teacher">학급 목록으로</a>}<button type="button" onClick={onRetry}>다시 시도</button></span></div>
      : <p className="tcw-loading-status" role="status"><span className="tcw-spinner" aria-hidden="true" />{classPage ? "학급을 불러오고 있어요" : "학급 목록을 불러오고 있어요"}</p>}
    <h2 className="tcw-loading-heading" aria-hidden="true">{classPage ? "학생 그림" : "내 학급"}</h2>
    <div className="tcw-student-grid" aria-hidden="true">{Array.from({ length: 8 }, (_, index) => <div key={index}><span className="tcw-skel tcw-skel-card" /><div className="tcw-skel-caption"><span className="tcw-skel" /><span className="tcw-skel tcw-skel-pill" /></div></div>)}</div>
  </main>;
}

async function teacherPost<T = Record<string, unknown>>(payload: Record<string, unknown>): Promise<T> { const response = await fetch("/api/teacher", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), cache: "no-store" }); const data = await response.json() as T & { error?: string }; if (!response.ok) throw new Error(data.error ?? "요청을 처리하지 못했어요."); return data; }
async function teacherAiPost<T = Record<string, unknown>>(payload: Record<string, unknown>): Promise<T> { const response = await fetch("/api/ai/teacher-draft", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), cache: "no-store" }); const data = await response.json() as T & { error?: string }; if (!response.ok) throw new Error(data.error ?? "AI 코칭 초안을 처리하지 못했어요."); return data; }

function TeacherHistoryDrawer({ student, artworks, loading, error, hasMore, onMore }: { student: Student | null; artworks: TeacherArtworkHistory[]; loading: boolean; error: string; hasMore: boolean; onMore: () => void }) {
  const [selectedArtworkId, setSelectedArtworkId] = useState("");
  useEffect(() => { setSelectedArtworkId(""); }, [student?.id]);
  if (!student) return null;
  const selectedArtwork = artworks.find((item) => item.id === selectedArtworkId) ?? null;
  return <section className="teacher-history-drawer" aria-labelledby="teacher-artwork-history-title">
    <div className="teacher-artwork-history-heading"><h3 id="teacher-artwork-history-title">{student.realName ?? student.nickname}의 지난 그림</h3><span>{artworks.length}개</span></div>
    {loading && !artworks.length && <div className="draft-loading">작품 기록을 불러오는 중…</div>}
    {error && <p className="preview-message-error" role="alert">{error}</p>}
    {selectedArtwork?.thumbnail && <figure className="teacher-history-preview"><img src={selectedArtwork.thumbnail} alt={`${selectedArtwork.title} 크게 보기`} /><figcaption><b>{selectedArtwork.title}</b><span>{selectedArtwork.status === "complete" ? "완성" : "그리는 중"} · {new Date(selectedArtwork.completedAt ?? selectedArtwork.updatedAt).toLocaleDateString("ko-KR")}</span><button type="button" className="text-button" onClick={() => setSelectedArtworkId("")}>큰 그림 닫기</button></figcaption></figure>}
    {artworks.length > 0 && <div className="teacher-artwork-history-grid">{artworks.map((item) => <button type="button" aria-pressed={selectedArtworkId === item.id} aria-label={`${item.title} 크게 보기`} onClick={() => setSelectedArtworkId(item.id)} key={item.id}>{item.thumbnail ? <img src={item.thumbnail} alt="" /> : <div className="empty-state">미리보기 없음</div>}<span><b>{item.title}</b><small>{item.status === "complete" ? "완성" : "그리는 중"} · {new Date(item.completedAt ?? item.updatedAt).toLocaleDateString("ko-KR")}</small></span></button>)}</div>}
    {!loading && !artworks.length && !error && <p className="empty-state">아직 저장된 작품이 없어요.</p>}
    {hasMore && <button type="button" className="button secondary full" disabled={loading} onClick={onMore}>{loading ? "더 불러오는 중…" : "이전 작품 더 보기"}</button>}
  </section>;
}

export function TeacherApp({ classroomId = "" }: { classroomId?: string }) {
  // 학급 만들 때도 만든 뒤와 같은 번호·이름 칸을 쓴다(2026-09-23 사용자 요청).
  const [newRows, setNewRows] = useState<RosterRow[]>(() => blankRows(1));
  const newRosterParsed = parseRosterRows(newRows);
  const [workspaceDialog, setWorkspaceDialog] = useState<"message" | null>(null);
  const [selectedArtwork, setSelectedArtwork] = useState<WorkspaceArtwork | null>(null);
  const [messageSending, setMessageSending] = useState(false);
  const [messageNotice, setMessageNotice] = useState("");
  const [lastUpdated, setLastUpdated] = useState("");
  // 복사 결과는 반드시 화면에 알린다. 조용히 끝나면 교사는 눌리지 않은 것으로 읽는다.
  const [copyNotice, setCopyNotice] = useState("");
  const [loadError, setLoadError] = useState("");
  const { copiedKey, copiedLabel, copy } = useCopyFeedback(setCopyNotice);
  const [authorized, setAuthorized] = useState<boolean | null>(null); const [localDemo, setLocalDemo] = useState(false); const [teacher, setTeacher] = useState<{ displayName: string; isAdmin?: boolean; source?: "siwc" | "local" } | null>(null); const [classrooms, setClassrooms] = useState<Classroom[]>([]); const [classroomData, setClassroomData] = useState<ClassroomData | null>(null); const [error, setError] = useState("");
  const [email, setEmail] = useState(""); const [pin, setPin] = useState(""); const [newClass, setNewClass] = useState(""); const [newSchool, setNewSchool] = useState(""); const [newGrade, setNewGrade] = useState(""); const [messageBody, setMessageBody] = useState(""); const [targetStudent, setTargetStudent] = useState(""); const [viewingStudentId, setViewingStudentId] = useState("");
  const [previewMessageBody, setPreviewMessageBody] = useState("");
  const [previewMessageStatus, setPreviewMessageStatus] = useState("");
  const [previewMessageError, setPreviewMessageError] = useState("");
  const [previewMessageSending, setPreviewMessageSending] = useState(false);
  const [studentHistory, setStudentHistory] = useState<TeacherArtworkHistory[]>([]);
  const [studentHistoryLoading, setStudentHistoryLoading] = useState(false);
  const [studentHistoryError, setStudentHistoryError] = useState("");
  const [studentHistoryHasMore, setStudentHistoryHasMore] = useState(false);
  const [studentHistoryOffset, setStudentHistoryOffset] = useState(0);
  const [deletingClassroom, setDeletingClassroom] = useState("");
  const [creatingClass, setCreatingClass] = useState(false); const [classSearch, setClassSearch] = useState(""); const [classFilter, setClassFilter] = useState<"all" | "open" | "closed">("all"); const [qrClassroom, setQrClassroom] = useState<Classroom | null>(null);
  const [deletingStudent, setDeletingStudent] = useState("");
  const [draftId, setDraftId] = useState(""); const [draftBody, setDraftBody] = useState(""); const [draftLoading, setDraftLoading] = useState(false); const [draftSent, setDraftSent] = useState(false);
  // 초안이 어느 학생 것인지 함께 들고 다닌다. 늦게 도착한 응답이 다른 학생 화면에 붙어
  // 교사가 그대로 승인하면 엉뚱한 아이에게 메시지가 간다.
  const [draftStudentId, setDraftStudentId] = useState("");
  const [familyShareUrl, setFamilyShareUrl] = useState("");
  const [familySharePanelOpen, setFamilySharePanelOpen] = useState(false);
  const [guardianConsentConfirmed, setGuardianConsentConfirmed] = useState(false);
  const [consentMethod, setConsentMethod] = useState("");
  const [qrExpanded, setQrExpanded] = useState(false);
  const qrOpenButtonRef = useRef<HTMLButtonElement>(null);
  const qrDialogRef = useRef<HTMLDialogElement>(null);
  const previewDialogRef = useRef<HTMLDivElement>(null);
  const viewingStudentIdRef = useRef("");
  const studentHistoryRequestRef = useRef(0);
  const load = useCallback(async () => { try { const response = await fetch(`/api/teacher${classroomId ? `?classroomId=${encodeURIComponent(classroomId)}` : ""}`, { cache: "no-store" }); const data = await response.json() as TeacherPayload; if (response.status === 401) { setLocalDemo(Boolean(data.localDemo)); setAuthorized(false); return; } if (!response.ok) throw new Error(data.error); setAuthorized(true); setLoadError(""); setLastUpdated(new Date().toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })); setTeacher(data.teacher ?? null); if (classroomId) setClassroomData(data as ClassroomData); else setClassrooms(data.classrooms ?? []); } catch (cause) { setLoadError(cause instanceof Error ? cause.message : "불러오지 못했어요."); } }, [classroomId]);
  useEffect(() => { void load(); const timer = classroomId ? window.setInterval(load, 6000) : undefined; return () => { if (timer) clearInterval(timer); }; }, [classroomId, load]);
  // 미리보기는 id만 들고, 표시는 매 폴링의 최신 목록에서 찾는다.
  // 클릭 시점 사본을 들고 있으면 6초마다 갱신되는 썸네일·상태가 반영되지 않는다.
  const viewingStudent = useMemo(
    () => (viewingStudentId ? classroomData?.students.find((student) => student.id === viewingStudentId) ?? null : null),
    [classroomData, viewingStudentId],
  );
  useEffect(() => { viewingStudentIdRef.current = viewingStudentId; }, [viewingStudentId]);
  const closePreview = useCallback(() => { studentHistoryRequestRef.current += 1; viewingStudentIdRef.current = ""; setViewingStudentId(""); setSelectedArtwork(null); setDraftId(""); setDraftBody(""); setDraftSent(false); setDraftStudentId(""); setFamilySharePanelOpen(false); setGuardianConsentConfirmed(false); setConsentMethod(""); setPreviewMessageBody(""); setPreviewMessageStatus(""); setPreviewMessageError(""); setPreviewMessageSending(false); setStudentHistory([]); setStudentHistoryError(""); setStudentHistoryLoading(false); setStudentHistoryHasMore(false); setStudentHistoryOffset(0); }, []);
  useEffect(() => {
    // 학생이 목록에서 사라지면(삭제·학급 변경) 미리보기를 통째로 닫는다. id만 비우면
    // 보호자 동의 확인값이 남아 다음 학생의 가족 링크 버튼이 미리 열린다.
    if (viewingStudentId && classroomData && !viewingStudent) closePreview();
  }, [classroomData, closePreview, viewingStudent, viewingStudentId]);
  useModalDialog(previewDialogRef, closePreview, Boolean(viewingStudent));
  const viewingClassroomId = classroomData?.classroom.id;
  useEffect(() => {
    if (!viewingStudentId || !viewingClassroomId) return;
    const ping = () => void teacherPost({ action: "viewStudent", classroomId: viewingClassroomId, studentId: viewingStudentId }).catch(() => { /* 다음 주기에 다시 확인합니다. */ });
    ping(); const timer = window.setInterval(ping, 10_000); return () => clearInterval(timer);
  }, [viewingStudentId, viewingClassroomId]);
  useEffect(() => {
    if (!qrExpanded) return;
    const dialog = qrDialogRef.current;
    const opener = qrOpenButtonRef.current;
    if (!dialog) return;
    const previousOverflow = document.body.style.overflow;
    if (!dialog.open) dialog.showModal();
    document.body.style.overflow = "hidden";
    const focusableSelector = "button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";
    const focusableItems = () => Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector)).filter((item) => !item.hidden);
    focusableItems()[0]?.focus();
    const keepFocusInside = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); setQrExpanded(false); return; }
      if (event.key !== "Tab") return;
      const items = focusableItems();
      const first = items[0]; const last = items.at(-1);
      if (!first || !last) { event.preventDefault(); dialog.focus(); return; }
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    dialog.addEventListener("keydown", keepFocusInside);
    return () => {
      dialog.removeEventListener("keydown", keepFocusInside);
      if (dialog.open) dialog.close();
      document.body.style.overflow = previousOverflow;
      if (opener?.isConnected) opener.focus();
    };
  }, [qrExpanded]);
  const classCode = classroomData?.classroom.classCode ?? "";
  const joinUrl = useMemo(() => classCode && typeof location !== "undefined" ? `${location.origin}/join/${classCode}` : "", [classCode]);

  async function login(event: FormEvent) { event.preventDefault(); setError(""); try { await teacherPost({ action: "login", email, pin }); await load(); } catch (cause) { setError(cause instanceof Error ? cause.message : "로그인할 수 없어요."); } }
  async function createClass(event: FormEvent) {
    event.preventDefault();
    const parsed = parseRosterRows(newRows);
    if (parsed.errors.length) { setError(parsed.errors[0]); return; }
    if (!parsed.entries.length) { setError("번호와 이름을 입력해 주세요."); return; }
    try {
      // 명단은 필수다. 입장은 명단의 번호로만 하므로 명단 없는 학급은 아무도 못 들어온다.
      const data = await teacherPost<{ classroom: Classroom }>({ action: "createClassroom", displayName: newClass, roster: parsed.entries, schoolName: newSchool, grade: newGrade || null });
      setNewClass(""); setNewSchool(""); setNewGrade(""); setNewRows(blankRows(1));
      location.href = `/teacher/class/${data.classroom.id}`;
    } catch (cause) { setError(cause instanceof Error ? cause.message : "학급을 만들 수 없어요."); }
  }
  async function deleteClassroom(item: Classroom) {
  const confirmed = confirm(`${item.displayName} 학급(학생 ${item.studentCount}명)을 삭제할까요?\n\n되돌릴 수 없어요. 학생 입장과 기존 로그인, 가족 공유가 즉시 끝나고 이 학급 아이들은 자기 그림과 동화책을 다시 열 수 없어요.`);
    if (!confirmed) return;
    setDeletingClassroom(item.id); setError("");
    try { await teacherPost({ action: "deleteClassroom", classroomId: item.id }); if (classroomId) location.href = "/teacher"; else await load(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "학급을 삭제하지 못했어요."); }
    finally { setDeletingClassroom(""); }
  }
  async function classAction<T = Record<string, unknown>>(action: string, rest: Record<string, unknown> = {}) { if (!classroomData) return null; setError(""); try { const result = await teacherPost<T>({ action, classroomId: classroomData.classroom.id, ...rest }); await load(); return result; } catch (cause) { setError(cause instanceof Error ? cause.message : "바꾸지 못했어요."); return null; } }
  async function sendMessage(event: FormEvent) {
    event.preventDefault(); if (!messageBody.trim() || messageSending) return;
    setMessageSending(true); setMessageNotice("");
    const sent = await classAction("sendMessage", { body: messageBody, studentId: targetStudent || null });
    if (sent) { setMessageBody(""); setMessageNotice("메시지를 보냈어요."); }
    setMessageSending(false);
  }
  async function sendPreviewMessage(event: FormEvent) {
    event.preventDefault();
    if (!classroomData || !viewingStudent || !previewMessageBody.trim() || previewMessageSending) return;
    const recipientId = viewingStudent.id;
    const recipientNickname = viewingStudent.nickname;
    setPreviewMessageSending(true); setPreviewMessageStatus(""); setPreviewMessageError("");
    try {
      await teacherPost({ action: "sendMessage", classroomId: classroomData.classroom.id, studentId: recipientId, body: previewMessageBody });
      if (viewingStudentIdRef.current === recipientId) {
        setPreviewMessageBody("");
        setPreviewMessageStatus(`${recipientNickname} 학생 화면에 보냈어요.`);
      }
      await load();
    } catch (cause) {
      if (viewingStudentIdRef.current === recipientId) setPreviewMessageError(cause instanceof Error ? cause.message : "도움말을 보내지 못했어요.");
    } finally {
      if (!viewingStudentIdRef.current || viewingStudentIdRef.current === recipientId) setPreviewMessageSending(false);
    }
  }
  async function archiveStudent(student: Student) {
    const confirmed = confirm(`${student.nickname} 학생을 학급에서 삭제할까요?\n\n교사 화면에서 숨겨지고 모든 기기 입장이 종료됩니다. 작품과 성장 기록은 보관되며 필요하면 다시 복원할 수 있어요.`);
    if (!confirmed) return;
    setDeletingStudent(student.id); setError("");
    if (viewingStudentId === student.id) closePreview();
    await classAction("archiveStudent", { studentId: student.id });
    setDeletingStudent("");
  }
  async function restoreStudent(student: ArchivedStudent) {
    setDeletingStudent(student.id); setError("");
    await classAction("restoreStudent", { studentId: student.id });
    setDeletingStudent("");
  }
  async function loadStudentHistory(studentId: string, offset = 0, append = false) {
    if (!classroomData) return;
    const requestId = ++studentHistoryRequestRef.current;
    setStudentHistoryLoading(true); setStudentHistoryError("");
    try {
      const response = await fetch(`/api/teacher?classroomId=${encodeURIComponent(classroomData.classroom.id)}&studentId=${encodeURIComponent(studentId)}&historyOffset=${offset}`, { cache: "no-store" });
      const data = await response.json() as { artworks?: TeacherArtworkHistory[]; hasMore?: boolean; nextOffset?: number; error?: string };
      if (!response.ok) throw new Error(data.error ?? "작품 기록을 불러오지 못했어요.");
      if (studentHistoryRequestRef.current !== requestId || viewingStudentIdRef.current !== studentId) return;
      setStudentHistory((current) => {
        if (!append) return data.artworks ?? [];
        const known = new Set(current.map((item) => item.id));
        return [...current, ...(data.artworks ?? []).filter((item) => !known.has(item.id))];
      });
      setStudentHistoryHasMore(Boolean(data.hasMore));
      setStudentHistoryOffset(data.nextOffset ?? offset);
    } catch (cause) {
      if (studentHistoryRequestRef.current === requestId && viewingStudentIdRef.current === studentId) setStudentHistoryError(cause instanceof Error ? cause.message : "작품 기록을 불러오지 못했어요.");
    } finally { if (studentHistoryRequestRef.current === requestId) setStudentHistoryLoading(false); }
  }

  function openPreview(student: Student, openFamilyShare = false) {
    // 미리보기 대상을 먼저 확정한다. 서버 왕복 뒤에 정하면 느린 네트워크에서
    // 다른 학생을 연 뒤 늦은 응답이 화면을 되돌려 놓는다.
    closePreview(); viewingStudentIdRef.current = student.id; setViewingStudentId(student.id); setFamilySharePanelOpen(openFamilyShare); void loadStudentHistory(student.id);
  }
  async function requestTeacherDraft(student: Student) {
    if (!classroomData || !student.artworkId || draftLoading) return;
    setDraftStudentId(student.id); setDraftLoading(true); setError("");
    try {
      const data = await teacherAiPost<{ draft: { id: string; body: string } }>({ action: "draft", classroomId: classroomData.classroom.id, studentId: student.id, artworkId: student.artworkId });
      // 응답이 오는 사이 교사가 다른 학생을 열었으면 그 화면에 붙이지 않는다.
      if (viewingStudentIdRef.current !== student.id) return;
      setDraftId(data.draft.id); setDraftBody(data.draft.body);
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : "AI 초안을 만들지 못했어요."); }
    finally { setDraftLoading(false); }
  }
  async function approveTeacherDraft() {
    if (!classroomData || !draftId || !draftBody.trim() || draftLoading) return;
    // 화면에 보이는 학생과 초안 주인이 다르면 승인하지 않는다.
    if (draftStudentId !== viewingStudentId) { setError("다른 학생의 초안이에요. 그 학생을 다시 열어 확인해 주세요."); return; }
    setDraftLoading(true); setError("");
    try { await teacherAiPost({ action: "approve", classroomId: classroomData.classroom.id, draftId, body: draftBody }); setDraftSent(true); await load(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "초안을 보내지 못했어요."); }
    finally { setDraftLoading(false); }
  }
  async function issueFamilyShare(student: Student) {
    if (!classroomData || !student.completedArtworkId || !guardianConsentConfirmed || !consentMethod) return;
    // 동의 확인은 지금 화면에 열린 그 학생에 대한 것이어야 한다.
    if (viewingStudentId !== student.id) { setError("보호자 동의는 지금 열어 둔 학생에게만 적용돼요."); return; }
    const result = await classAction<{ share: { token: string } }>("createFamilyShare", {
      studentId: student.id,
      artworkIds: [student.completedArtworkId],
      expiresInDays: 7,
      guardianConsentConfirmed,
      consentMethod,
    });
    if (!result) return;
    const url = `${location.origin}/family/${result.share.token}`;
    setFamilyShareUrl(url); setFamilySharePanelOpen(false); setGuardianConsentConfirmed(false); setConsentMethod("");
    if (!(await copyText(url))) setError("가족 링크를 만들었어요. 주소를 직접 선택해 복사해 주세요.");
  }

  if (authorized === null) return <TeacherLoading classPage={Boolean(classroomId)} error={loadError} onRetry={() => void load()} />;
  // 성공은 누른 단추가 체크로 바뀌어 알리고, 실패만 안내 줄로 알린다(2026-09-17 사용자 요청).
  async function copyAndNotify(text: string, label: string, key = label) {
    await copy(text, label, key);
  }

  if (!authorized) return <main className="teacher-login"><section className="login-brand"><Logo /><div><p className="eyebrow">아이의 다음 선을 함께 찾아요</p><h1>교사 수업 진행실</h1><p>순위 없이 학생의 진행과 작품 변화를 한눈에 확인하고, 짧은 도움말을 보낼 수 있어요.</p></div><ul><li>우리 반 명단은 담임만 볼 수 있어요</li><li>낮은 빈도의 안전한 썸네일</li><li>전체 또는 한 학생에게 메시지</li></ul></section>{localDemo ? <form className="login-card" onSubmit={login}><h2>로컬 개발 로그인</h2><p className="helper">localhost에서만 열립니다. 처음 입력한 이메일과 8자 이상 PIN으로 개발 계정을 만들어요.</p><label>이메일<input type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} /></label><label>접속 PIN<input type="password" minLength={8} autoComplete="current-password" value={pin} onChange={(event) => setPin(event.target.value)} /></label>{error && <p className="error-box">{error}</p>}<button className="button primary full" disabled={!email || pin.length < 8}>로컬 수업실 열기</button><a className="text-button" href="/">학생 화면으로 돌아가기</a></form> : <section className="login-card"><h2>로그인이 필요해요</h2><p>운영 교사 화면은 구글 로그인으로 열립니다.</p><a className="button primary full" href="/api/auth/google/start?return_to=%2Fteacher">구글로 로그인</a></section>}</main>;
  if (!classroomId) {
    const sorted = [...classrooms].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const query = classSearch.trim().toLowerCase();
    const listed = sorted.filter((item) => (classFilter === "all" || (classFilter === "open") === Boolean(item.admissionOpen)) && (!query || item.displayName.toLowerCase().includes(query)));
    const openQr = (item: Classroom, opener: HTMLButtonElement) => { qrOpenButtonRef.current = opener; setQrClassroom(item); setQrExpanded(true); };
    return <main className="teacher-shell teacher-dashboard">
      <header className="teacher-header"><Logo /><div><span>교사</span><b>{teacher?.displayName}</b></div>{teacher?.isAdmin && <a className="small-button" href="/admin">관리자 페이지</a>}<button className="small-button" onClick={async () => { await teacherPost({ action: "logout" }); location.href = "/teacher"; }}>로그아웃</button></header>
      <section className="dashboard-title"><div><h1>내 학급</h1><p>오늘도, 아이들의 생각이 자라는 수업을 만들어보세요.</p></div><button type="button" className="button primary" aria-expanded={creatingClass} onClick={() => setCreatingClass((value) => !value)}>＋ 새 학급</button></section>
      {creatingClass && <form className="create-class" onSubmit={createClass}><label>새 학급 이름<input value={newClass} maxLength={30} autoFocus onChange={(event) => setNewClass(event.target.value)} placeholder="예: 별빛 1반" /></label><div className="create-class-school"><label><span>학교 이름 <small>(선택)</small></span><input value={newSchool} maxLength={40} onChange={(event) => setNewSchool(event.target.value)} placeholder="예: 꿈틀초등학교" /></label><label><span>학년 <small>(선택)</small></span><select aria-label="학년 (선택)" value={newGrade} onChange={(event) => setNewGrade(event.target.value)}><option value="">고르지 않음</option>{[1, 2, 3, 4, 5, 6].map((grade) => <option key={grade} value={grade}>{grade}학년</option>)}</select></label><p className="roster-privacy">학교·학년은 선생님만 봐요. 그림책 인쇄 주문서에 미리 채워지고, 학생 화면·ebook·AI에는 보내지 않아요.</p></div><div className="create-class-roster"><span className="create-class-roster-label">우리 반 명단</span><RosterEditor rows={newRows} setRows={setNewRows} firstSeat={1} onError={setError} /></div><p className="roster-privacy">학생은 자기 <b>번호</b>로 들어옵니다. 이름은 <b>선생님만</b> 봅니다 — 학생 화면·가족 공유·AI에는 보내지 않아요.</p><div className="create-class-actions"><button className="button primary" disabled={newClass.length < 2 || !newRosterParsed.entries.length || newRosterParsed.errors.length > 0}>학급 만들기</button><button type="button" className="button secondary" onClick={() => { setCreatingClass(false); setNewClass(""); setNewRows(blankRows(1)); }}>취소</button></div></form>}
      {error && <p className="error-box" role="alert">{error}</p>}
      <p className="sr-only" role="status">{copiedLabel ? `${copiedLabel}를 복사했어요.` : ""}</p>
      {copyNotice && <p className="copy-notice" role="status">{copyNotice}<button type="button" onClick={() => setCopyNotice("")}>닫기</button></p>}
      {sorted.length > 0 && <section><div className="section-title"><h2>최근 사용한 학급</h2><span>최근 수업한 순</span></div><div className="class-grid">{sorted.slice(0, 3).map((item) => <ClassroomCard item={item} key={item.id} />)}</div></section>}
      <section>
        <div className="section-title"><h2>모든 학급 <small>({classrooms.length}개)</small></h2><label className="class-search"><span className="sr-only">학급 이름 검색</span><input type="search" value={classSearch} onChange={(event) => setClassSearch(event.target.value)} placeholder="학급 이름 검색" /></label></div>
        <div className="class-filter" role="group" aria-label="입장 상태로 거르기">{([["all", "전체"], ["open", "입장 열림"], ["closed", "입장 닫힘"]] as const).map(([key, label]) => <button type="button" key={key} aria-pressed={classFilter === key} onClick={() => setClassFilter(key)}>{label}</button>)}</div>
        {listed.length ? <table className="class-table"><thead><tr><th>학급명</th><th>오늘 활동</th><th>등록 학생</th><th>입장 상태</th><th>최근 수업</th><th><span className="sr-only">열기</span></th></tr></thead><tbody>{listed.map((item) => <ClassroomRow item={item} deleting={deletingClassroom === item.id} onDelete={deleteClassroom} onQr={openQr} onCopy={(text, label, key) => void copyAndNotify(text, label, key)} copiedKey={copiedKey} key={item.id} />)}</tbody></table> : <p className="empty-state">{classrooms.length ? "조건에 맞는 학급이 없어요." : "아직 학급이 없어요. 새 학급을 만들어 보세요."}</p>}
      </section>
      {qrExpanded && qrClassroom && <dialog ref={qrDialogRef} className="qr-modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="large-qr-title" onCancel={(event) => { event.preventDefault(); setQrExpanded(false); }}><section className="large-qr-dialog"><button className="modal-close" aria-label="입장 QR 닫기" autoFocus onClick={() => setQrExpanded(false)}>×</button><h2 id="large-qr-title">{qrClassroom.displayName} 입장 QR</h2><p>카메라로 QR을 비추거나 아래 수업 코드를 입력해요.</p><QrCode value={`${location.origin}/join/${qrClassroom.classCode}`} label={`${qrClassroom.displayName} 입장 QR`} variant="large" /><div className="large-qr-code"><small>수업 코드</small><strong>{qrClassroom.classCode}</strong></div><button className="button secondary full" aria-label="입장 주소 복사" onClick={() => copyAndNotify(`${location.origin}/join/${qrClassroom.classCode}`, "입장 주소", "qr-join")}>{copiedKey === "qr-join" ? <><Check size={17} className="copy-check" />복사됨</> : "입장 주소 복사"}</button></section></dialog>}
    </main>;
  }
  if (!classroomData) return <TeacherLoading classPage error={loadError || error} onRetry={() => void load()} />;
  const room = classroomData.classroom;
  const previewArtwork = selectedArtwork ?? viewingStudent?.sessionArtwork ?? null;
  return <main className="teacher-workspace">
    <TeacherWorkspace data={classroomData} lastUpdated={lastUpdated} loadError={loadError} onRetry={() => void load()}
      onOpenArtwork={(studentId, artwork) => { const student = classroomData.students.find((item) => item.id === studentId); if (student) { openPreview(student); setSelectedArtwork(artwork ?? null); } }}
      onMessage={() => { setTargetStudent(""); setMessageNotice(""); setWorkspaceDialog("message"); }}
      onQr={(opener) => { qrOpenButtonRef.current = opener; setQrExpanded(true); }}
      onAction={classAction} onArchive={(id) => { const student = classroomData.students.find((item) => item.id === id); if (student) void archiveStudent(student); }}
      onRestore={(id) => { const student = classroomData.archivedStudents.find((item) => item.id === id); if (student) void restoreStudent(student); }}
      onDeleteClassroom={() => void deleteClassroom(room)} busyStudentId={deletingStudent} deletingClassroom={Boolean(deletingClassroom)}
    />
    {error && <div className="tcw-error tcw-action-error" role="alert">{error}<button type="button" onClick={() => setError("")}>닫기</button></div>}
    <p className="sr-only" role="status">{copiedLabel ? `${copiedLabel}를 복사했어요.` : ""}</p>
      {copyNotice && <p className="copy-notice" role="status">{copyNotice}<button type="button" onClick={() => setCopyNotice("")}>닫기</button></p>}
    {familyShareUrl && <div className="family-link-ready" role="status"><b>10분 동안 유효한 1회용 가족 입장 링크를 만들었어요.</b><input readOnly value={familyShareUrl} aria-label="새 가족 공유 1회용 입장 링크" /><button aria-label="가족 입장 링크 다시 복사" onClick={() => copyAndNotify(familyShareUrl, "가족 입장 링크", "family-link")}>{copiedKey === "family-link" ? <><Check size={15} className="copy-check" />복사됨</> : "다시 복사"}</button><button onClick={() => setFamilyShareUrl("")}>닫기</button></div>}
    {workspaceDialog === "message" && <WorkspaceDialog title="메시지 보내기" onClose={() => setWorkspaceDialog(null)}>
      <form className="tcw-message" onSubmit={sendMessage}><label>받는 학생<select value={targetStudent} onChange={(event) => setTargetStudent(event.target.value)}><option value="">우리 반 모두</option>{classroomData.students.map((student) => <option value={student.id} key={student.id}>{student.seatNumber} {student.realName ?? student.nickname}</option>)}</select></label><label>메시지<textarea maxLength={180} rows={4} value={messageBody} onChange={(event) => { setMessageBody(event.target.value); setMessageNotice(""); }} placeholder="학생에게 전할 짧은 도움말을 적어 주세요." /></label><div className="tcw-message-footer"><small>{messageBody.length}/180</small><button className="tcw-primary" disabled={messageSending || !messageBody.trim()}>{messageSending ? "보내는 중…" : "보내기"}</button></div>{messageNotice && <p role="status">{messageNotice}</p>}{error && <p className="tcw-error" role="alert">{error}</p>}</form>
      <details className="tcw-message-history"><summary>보낸 메시지 {classroomData.messages.length}개</summary>{classroomData.messages.map((item) => <article key={item.id}><b>{item.studentId ? item.nickname : "우리 반 모두"}</b><p>{item.body}</p><small>{item.seenCount ? `${item.seenCount}명 확인` : "아직 확인 전"}</small></article>)}</details>
    </WorkspaceDialog>}
    {qrExpanded && <dialog ref={qrDialogRef} className="qr-modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="large-qr-title" onCancel={(event) => { event.preventDefault(); setQrExpanded(false); }}><section className="large-qr-dialog"><button className="modal-close" aria-label="큰 입장 QR 닫기" autoFocus onClick={() => setQrExpanded(false)}>×</button><h2 id="large-qr-title">{room.displayName} 입장 QR</h2><p>카메라로 QR을 비추거나 아래 수업 코드를 입력해요.</p><QrCode value={joinUrl} label={`${room.displayName} 큰 입장 QR`} variant="large" /><div className="large-qr-code"><small>수업 코드</small><strong>{room.classCode}</strong></div><button className="button secondary full" aria-label="입장 주소 복사" onClick={() => copyAndNotify(joinUrl, "입장 주소", "qr-join")}>{copiedKey === "qr-join" ? <><Check size={17} className="copy-check" />복사됨</> : "입장 주소 복사"}</button></section></dialog>}{viewingStudent && <div className="modal-backdrop" ref={previewDialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="student-preview-title"><section className="teacher-preview coaching-review"><button className="modal-close" aria-label="학생 그림 미리보기 닫기" onClick={closePreview}>×</button><h2 id="student-preview-title">{viewingStudent.realName ?? viewingStudent.nickname}의 그림</h2>{viewingStudent.handRaisedAt && <p className="teacher-hand-raised" role="status"><span aria-hidden="true">🙋</span> 선생님을 불렀어요 <button type="button" className="text-button" onClick={() => void teacherPost({ action: "lowerHand", classroomId: room.id, studentId: viewingStudent.id }).then(() => load()).catch(() => undefined)}>손 내리기</button></p>}{selectedArtwork ? <>{selectedArtwork.thumbnail ? <img src={selectedArtwork.thumbnail} alt={`${viewingStudent.nickname} 그림`} /> : <div className="empty-state">아직 썸네일이 없어요.</div>}<p className="tcw-preview-caption">{selectedArtwork.title} · {selectedArtwork.status === "complete" ? "완성" : "그리는 중"}</p></> : <TeacherLiveView key={viewingStudent.id} classroomId={room.id} studentId={viewingStudent.id} nickname={viewingStudent.realName ?? viewingStudent.nickname} onPost={teacherPost} />}<p>이 창을 열어 둔 동안 학생 화면에 선생님이 보고 있다는 표시가 잠시 보여요.</p><section className="teacher-preview-guide" aria-labelledby="teacher-preview-guide-title"><div className="teacher-preview-guide-heading"><div><h3 id="teacher-preview-guide-title">학생에게 메시지</h3><p>{viewingStudent.nickname} 학생에게만 보여요.</p></div><span>{previewMessageBody.length}/180</span></div><form onSubmit={sendPreviewMessage}><label className="sr-only" htmlFor="teacher-preview-message">{viewingStudent.nickname} 학생에게 보낼 도움말</label><textarea id="teacher-preview-message" maxLength={180} value={previewMessageBody} onChange={(event) => { setPreviewMessageBody(event.target.value); setPreviewMessageStatus(""); setPreviewMessageError(""); }} placeholder="예: 고양이 옆에 좋아하는 장난감을 하나 더 그려볼까?" /><button className="button primary" disabled={!previewMessageBody.trim() || previewMessageSending}>{previewMessageSending ? "보내는 중…" : "학생에게 보내기"}</button></form>{previewMessageStatus && <p className="preview-message-status" role="status">✓ {previewMessageStatus}</p>}{previewMessageError && <p className="preview-message-error" role="alert">{previewMessageError}</p>}</section><StudentProfileFacts student={viewingStudent} />{previewArtwork?.status === "complete" && !familySharePanelOpen && <button type="button" className="button secondary full family-share-open-button" onClick={() => setFamilySharePanelOpen(true)}>가족 링크 준비</button>}{previewArtwork?.status === "complete" && familySharePanelOpen && <div className="family-consent-panel"><div className="family-consent-panel-heading"><h3>가족 공유 동의 기록</h3><button type="button" className="text-button" onClick={() => { setFamilySharePanelOpen(false); setGuardianConsentConfirmed(false); setConsentMethod(""); }}>나중에 하기</button></div><p>교사가 대신 동의하는 절차가 아닙니다. 실제 보호자의 사전 동의를 확인한 경우에만 아래 기록을 남겨 주세요.</p><label><input type="checkbox" checked={guardianConsentConfirmed} onChange={(event) => setGuardianConsentConfirmed(event.target.checked)} /> 실제로 확인한 경우에만 선택: 보호자가 가족 공유에 사전 동의했고, 그 확인 기록을 남깁니다.</label><label>동의 확인 방법<select value={consentMethod} onChange={(event) => setConsentMethod(event.target.value)}><option value="">선택해 주세요</option><option value="paper">서면</option><option value="in_person">대면</option><option value="phone">전화</option><option value="school_portal">학교 포털</option></select></label><button className="button secondary full" disabled={!guardianConsentConfirmed || !consentMethod} onClick={() => issueFamilyShare({ ...viewingStudent, completedArtworkId: previewArtwork?.id ?? null })}>1회용 가족 입장 링크 만들기</button></div>}{draftLoading && <div className="draft-loading">AI가 교사용 초안을 만드는 중…</div>}{!draftId && !draftLoading && previewArtwork?.id && previewArtwork?.thumbnail && <button className="button secondary full" onClick={() => requestTeacherDraft({ ...viewingStudent, artworkId: previewArtwork?.id ?? null })}>AI 코칭 초안 만들기</button>}{draftId && draftStudentId === viewingStudent.id && <div className="draft-review"><div><b>교사 검토가 필요해요</b><small>AI 초안은 아직 학생에게 보내지지 않았습니다.</small></div><textarea maxLength={180} value={draftBody} disabled={draftSent} onChange={(event) => setDraftBody(event.target.value)} /><button className="button primary full" disabled={draftLoading || draftSent || !draftBody.trim()} onClick={approveTeacherDraft}>{draftSent ? "교사가 승인해 보냈어요" : "수정한 뒤 승인해서 보내기"}</button></div>}<TeacherHistoryDrawer student={viewingStudent} artworks={studentHistory} loading={studentHistoryLoading} error={studentHistoryError} hasMore={studentHistoryHasMore} onMore={() => { if (viewingStudent) void loadStudentHistory(viewingStudent.id, studentHistoryOffset, true); }} /></section></div>}</main>;
}
