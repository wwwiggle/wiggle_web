"use client";

import { FormEvent, useEffect, useState } from "react";
import { useCopyFeedback } from "./useCopyFeedback";
import { Check, Copy, MoreHorizontal, Plus, Printer, QrCode, RefreshCw, Search } from "lucide-react";
import { MAX_SEAT_NUMBER, parseRosterRows, RosterRow } from "@/lib/roster";
import { blankRows, RosterEditor } from "./RosterRowsEditor";
import { WorkspaceDialog, WorkspaceProps } from "./TeacherWorkspace";
import { TeacherRosterPrint } from "./TeacherRosterPrint";
import "./TeacherRosterSettings.css";

export function TeacherRosterSettings({ data, onAction, onArchive, onRestore, onQr, onDeleteClassroom, busyStudentId, deletingClassroom }: WorkspaceProps) {
  const { classroom: room, students, archivedStudents, familyLinks } = data;
  const [search, setSearch] = useState("");
  const [dialog, setDialog] = useState<"add" | string | null>(null);
  const [rows, setRows] = useState<RosterRow[]>(() => blankRows(1));
  const [seat, setSeat] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState("");
  const [now, setNow] = useState(0);
  const [school, setSchool] = useState(data.profile?.schoolName ?? "");
  const [grade, setGrade] = useState(data.profile?.grade ? String(data.profile.grade) : "");
  useEffect(() => { setNow(Date.now()); const timer = setInterval(() => setNow(Date.now()), 6000); return () => clearInterval(timer); }, []);
  const filtered = [...students].sort((a, b) => (a.seatNumber ?? 1000) - (b.seatNumber ?? 1000)).filter((student) => `${student.seatNumber} ${student.realName ?? ""} ${student.nickname}`.includes(search.trim()));
  const parsed = parseRosterRows(rows);
  // 이어 붙이는 학급이면 마지막 번호 다음부터 시작한다. 선생님이 번호를 다시 세지 않는다.
  const firstSeat = Math.min(MAX_SEAT_NUMBER, students.reduce((max, student) => Math.max(max, student.seatNumber ?? 0), 0) + 1);
  function openAddDialog() { setError(""); setRows(blankRows(firstSeat)); setDialog("add"); }
  /* 인쇄는 팝업 대신 화면 안의 시트 + 브라우저 인쇄다. window.open에 noopener를 주면
   * 규격상 null이 돌아와, 팝업을 허용해 둔 브라우저에서도 종전 방식은 늘 실패했다. */
  const [printOpen, setPrintOpen] = useState(false);
  const joinUrl = typeof location === "undefined" ? "" : `${location.origin}/join/${room.joinToken}`;
  // 복사는 lib/copy-text 한 경로만 쓴다. 화면마다 따로 만들면 비보안 맥락 폴백이 한쪽에만 남는다.
  // 성공하면 누른 단추가 체크로 바뀌고, 실패만 안내 줄로 알린다(useCopyFeedback).
  const { copiedKey, copiedLabel, copy } = useCopyFeedback(setNotice);
  async function action(key: string, rest?: Record<string, unknown>) { if (pending) return; setPending(key); const result = await onAction(key, rest); setPending(""); if (result) setNotice("변경 사항을 저장했어요."); }
  async function save(event: FormEvent) {
    event.preventDefault(); if (busy) return; setError("");
    if (dialog === "add" && (parsed.errors.length || !parsed.entries.length)) { setError(parsed.errors[0] ?? "번호와 이름을 입력해 주세요."); return; }
    setBusy(true);
    const result = dialog === "add" ? await onAction("addStudents", { roster: parsed.entries }) : await onAction("updateStudent", { studentId: dialog, seatNumber: Number(seat), realName: name.trim() });
    setBusy(false);
    if (result) { setDialog(null); setRows(blankRows(firstSeat)); setNotice("명단을 저장했어요."); } else setError("저장하지 못했어요. 번호가 중복되지 않았는지 확인해 주세요. 입력 내용은 그대로 남아 있어요.");
  }
  return <section className="trs" aria-label="명단과 설정">
    <header className="trs-intro"><h2>명단 · 설정</h2><p>우리 반 학생과 입장 정보를 관리해요.</p></header>
    <div className="trs-layout"><section className="trs-roster"><header className="trs-heading"><div><h2>우리 반 명단 <small>{students.length}명</small></h2><p>학생 이름은 선생님에게만 보여요.</p></div><div className="trs-heading-actions"><button type="button" className="tcw-secondary" onClick={() => setPrintOpen(true)} disabled={!students.length}><Printer size={18} />코드표 인쇄</button><button className="tcw-primary" onClick={openAddDialog}><Plus size={18} />학생 추가</button></div></header>
      <label className="trs-search"><Search size={18} /><span className="sr-only">번호, 이름 또는 별명으로 학생 검색</span><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="번호, 이름 또는 별명 검색" /></label>
      <div className="trs-table-wrap"><table className="trs-table"><thead><tr><th>번호</th><th>이름</th><th>참여 코드</th><th>별명</th><th>첫 입장</th><th>관리</th></tr></thead><tbody>{filtered.map((student) => <tr key={student.id}><td>{student.seatNumber ?? "—"}</td><td><b>{student.realName ?? "이름 미등록"}</b></td><td><span className="trs-entry-code"><code>{student.entryCode ?? "—"}</code>{student.entryCode && <button type="button" aria-label={`${student.realName ?? student.nickname} 참여 코드 복사`} onClick={() => void copy(student.entryCode ?? "", "참여 코드", `code-${student.id}`)}>{copiedKey === `code-${student.id}` ? <Check size={14} className="trs-copied" /> : <Copy size={14} />}</button>}<button type="button" aria-label={`${student.realName ?? student.nickname} 참여 코드 새로 뽑기`} disabled={Boolean(pending)} onClick={() => { if (confirm(`${student.realName ?? student.nickname}의 참여 코드를 새로 뽑을까요?\n\n지금 코드는 바로 못 쓰게 돼요. 그림과 별명은 그대로예요.`)) void action("rotateEntryCode", { studentId: student.id }); }}><RefreshCw size={14} /></button></span></td><td>{student.claimedAt ? student.nickname : "아직 미정"}</td><td><span className={`trs-entry ${student.claimedAt ? "is-claimed" : ""}`}>{student.claimedAt ? "입장 완료" : "입장 전"}</span></td><td><div className="trs-row-actions"><button type="button" aria-label={`${student.realName ?? student.nickname} 번호·이름 수정`} onClick={() => { setError(""); setSeat(String(student.seatNumber ?? "")); setName(student.realName ?? ""); setDialog(student.id); }}>수정</button><details><summary aria-label={`${student.realName ?? student.nickname} 더 보기`}><MoreHorizontal size={18} /></summary><button className="trs-danger" disabled={busyStudentId === student.id} onClick={() => onArchive(student.id)}>{busyStudentId === student.id ? "처리 중…" : "학생 삭제"}</button></details></div></td></tr>)}</tbody></table></div>
      {!filtered.length && <p className="trs-empty">{students.length ? "검색한 학생을 찾지 못했어요." : "학생을 추가해 명단을 만들어 주세요."}</p>}
      <details className="trs-disclosure"><summary>삭제한 학생 {archivedStudents.length}명</summary><p>학생을 복원하면 보관된 작품도 다시 볼 수 있어요.</p>{archivedStudents.map((student) => <div className="trs-archived" key={student.id}><span><b>{student.seatNumber} {student.realName ?? student.nickname}</b><small>작품 {student.artworkCount}개 보관</small></span><button disabled={busyStudentId === student.id} onClick={() => onRestore(student.id)}>{busyStudentId === student.id ? "처리 중…" : "복원"}</button></div>)}</details>
    </section>
    <aside className="trs-settings"><section><h2>입장 관리</h2><div className="trs-admission"><span className={`trs-entry ${room.admissionOpen ? "is-claimed" : ""}`}>{room.admissionOpen ? "입장 열림" : "입장 닫힘"}</span><button disabled={Boolean(pending)} onClick={() => void action("toggleAdmission", { open: !room.admissionOpen })}>{pending === "toggleAdmission" ? "변경 중…" : room.admissionOpen ? "입장 닫기" : "입장 열기"}</button></div><div className="trs-code"><span>수업 코드</span><strong>{room.classCode}</strong><button aria-label="수업 코드 복사" onClick={() => void copy(room.classCode, "수업 코드", "class-code")}>{copiedKey === "class-code" ? <Check size={18} className="trs-copied" /> : <Copy size={18} />}</button></div><div className="trs-entry-actions"><button aria-label="입장 주소 복사" onClick={() => void copy(`${location.origin}/join/${room.classCode}`, "입장 주소", "join-url")}>{copiedKey === "join-url" ? <><Check size={16} className="trs-copied" />복사됨</> : <><Copy size={16} />입장 주소 복사</>}</button><button onClick={(event) => onQr(event.currentTarget)}><QrCode size={17} />QR 보기</button></div><div className="trs-entry-actions"><button disabled={Boolean(pending)} onClick={() => void action("clearEntryLocks")} title="코드를 여러 번 잘못 넣어 잠긴 기기를 모두 풀어 줍니다">{pending === "clearEntryLocks" ? "푸는 중…" : "입장 잠금 풀기"}</button></div><details className="trs-disclosure"><summary>수업 코드 변경</summary><p>변경하면 기존 코드와 QR로 입장할 수 없어요.</p><button disabled={Boolean(pending)} onClick={() => { if (confirm("수업 코드를 바꿀까요? 기존 코드와 QR은 더 이상 사용할 수 없어요.")) void action("rotateCode"); }}>{pending === "rotateCode" ? "변경 중…" : "새 코드 발급"}</button></details></section>
      <details className="trs-disclosure"><summary>가족 공유 링크 <small>{familyLinks.length}개</small></summary><p>작품을 열어 보호자 동의를 확인한 뒤 링크를 만들 수 있어요.</p>{familyLinks.map((link) => { const expired = new Date(link.expiresAt).getTime() < now; const student = students.find((entry) => entry.id === link.studentId); return <div className="trs-family" key={link.id}><b>{student?.realName ?? student?.nickname ?? "삭제한 학생"} · 작품 {link.artworkCount}개</b><small>{link.revokedAt ? "취소됨" : expired ? "만료됨" : `${new Date(link.expiresAt).toLocaleDateString("ko-KR")} 만료`}</small>{!link.revokedAt && !expired && <button disabled={Boolean(pending)} onClick={() => { if (confirm("이 가족 공유 링크를 취소할까요?")) void action("revokeFamilyShare", { linkId: link.id }); }}>링크 취소</button>}</div>; })}{!familyLinks.length && <p>아직 발급한 링크가 없어요.</p>}</details>
      <section className="trs-school"><h3>학교 · 학년 <small>(선택)</small></h3><p>선생님만 봐요. 그림책 인쇄 주문서에 미리 채워지고, 학생 화면·ebook·AI에는 보내지 않아요.</p><label>학교 이름<input value={school} maxLength={40} onChange={(event) => setSchool(event.target.value)} placeholder="예: 꿈틀초등학교" /></label><label>학년<select aria-label="학년" value={grade} onChange={(event) => setGrade(event.target.value)}><option value="">고르지 않음</option>{[1, 2, 3, 4, 5, 6].map((value) => <option key={value} value={value}>{value}학년</option>)}</select></label><button type="button" className="tcw-secondary" disabled={Boolean(pending)} onClick={() => void action("updateClassroomProfile", { schoolName: school, grade: grade || null })}>{pending === "updateClassroomProfile" ? "저장 중…" : "학교·학년 저장"}</button></section>
      <section className="trs-delete"><h3>학급 삭제</h3><p>학급과 학생의 접근이 종료되며 되돌릴 수 없어요.</p><button className="trs-danger" disabled={deletingClassroom} onClick={onDeleteClassroom}>{deletingClassroom ? "삭제 중…" : "학급 삭제"}</button></section>
    </aside></div>
    {printOpen && <WorkspaceDialog title="참여 코드표 인쇄" onClose={() => setPrintOpen(false)}>
      <div className="roster-print-actions no-print">
        <p>미리 보고 인쇄해요. 첫 장은 선생님 보관용 명단, 둘째 장은 잘라서 나눠 줄 쪽지예요.</p>
        <button type="button" className="tcw-primary" onClick={() => window.print()}><Printer size={18} />인쇄하기</button>
      </div>
      <TeacherRosterPrint classroomName={room.displayName} classCode={room.classCode} joinUrl={joinUrl} students={students} />
    </WorkspaceDialog>}
    <p className="sr-only" role="status">{copiedLabel ? `${copiedLabel}를 복사했어요.` : ""}</p>
    {notice && <div className="trs-notice" role="status">{notice}<button aria-label="알림 닫기" onClick={() => setNotice("")}>닫기</button></div>}
    {dialog && <WorkspaceDialog title={dialog === "add" ? "명단에 학생 추가" : "번호·이름 수정"} onClose={() => { if (!busy) setDialog(null); }}><form onSubmit={save}>{dialog === "add" ? <RosterEditor rows={rows} setRows={setRows} firstSeat={firstSeat} onError={setError} /> : <><label>번호<input type="number" min={1} max={99} required value={seat} onChange={(event) => setSeat(event.target.value)} /></label><label>이름<input required maxLength={20} value={name} onChange={(event) => setName(event.target.value)} /></label></>}<p className="trs-privacy">이름은 선생님만 볼 수 있어요. 학생 화면, 가족 공유, AI에는 전달되지 않아요.</p>{error && <p className="tcw-error" role="alert">{error}</p>}<div className="trs-form-actions"><button type="button" disabled={busy} onClick={() => setDialog(null)}>취소</button><button className="tcw-primary" disabled={busy || (dialog === "add" && (!parsed.entries.length || parsed.errors.length > 0))}>{busy ? "저장 중…" : "저장"}</button></div></form></WorkspaceDialog>}
  </section>;
}
