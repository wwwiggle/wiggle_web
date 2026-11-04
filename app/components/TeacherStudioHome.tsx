"use client";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Logo } from "./Logo";
import { postJson, teacherRequest } from "./book-workflow-client";
import "./book-workflow.css";

type Classroom = { id: string; displayName: string; studentCount: number; updatedAt: string };
type Payload = { teacher?: { displayName: string }; classrooms?: Classroom[] };

/**
 * 그림책 공방(2026-11-04, lib/product-mode.ts)의 교사 첫 화면. 수업 진행(입장·그리기·손들기)은 없고,
 * 책을 묶어 두는 "학급"만 만들고 연다. 학급 안에서 사진·스캔·PDF로 책을 만들고 주문한다.
 */
export function TeacherStudioHome() {
  const router = useRouter();
  const [teacher, setTeacher] = useState(""), [classrooms, setClassrooms] = useState<Classroom[] | null>(null);
  const [name, setName] = useState(""), [schoolName, setSchoolName] = useState(""), [grade, setGrade] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [signedOut, setSignedOut] = useState(false);
  const load = useCallback(async () => {
    const response = await fetch("/api/teacher", { cache: "no-store" });
    if (response.status === 401) { setSignedOut(true); return; }
    const data = await response.json() as Payload & { error?: string };
    if (!response.ok) throw new Error(data.error ?? "불러오지 못했어요.");
    setTeacher(data.teacher?.displayName ?? ""); setClassrooms(data.classrooms ?? []);
  }, []);
  useEffect(() => { void load().catch((e) => setError(e instanceof Error ? e.message : "불러오지 못했어요.")); }, [load]);
  async function create(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const { classroom } = await teacherRequest<{ classroom: { id: string } }>("/api/teacher", postJson({ action: "createClassroom", displayName: name, schoolName, grade: grade || null, roster: [] }));
      router.push(`/teacher/class/${classroom.id}/books`);
    } catch (e) { setError(e instanceof Error ? e.message : "만들지 못했어요."); setBusy(false); }
  }
  async function logout() {
    await fetch("/api/teacher", postJson({ action: "logout" })).catch(() => {});
    router.push("/");
  }
  if (signedOut) return <main className="book-desk"><header className="book-desk-header"><Logo /></header><section className="book-panel"><h1>로그인이 필요해요</h1><p>선생님 구글 계정으로 들어와 주세요.</p><a className="button primary" href="/api/auth/google/start?return_to=%2Fteacher">구글로 로그인</a></section></main>;
  return <main className="book-desk">
    <header className="book-desk-header"><Logo /><span className="book-status">{teacher ? `${teacher} 선생님` : "선생님"}</span><button type="button" className="small-button" onClick={() => void logout()}>로그아웃</button></header>
    <section className="book-desk-hero"><div><p className="eyebrow">꿈틀 그림책 공방</p><h1>우리 반 그림책 만들기</h1><p>학급(책 묶음)을 만들고, 그 안에서 아이들 그림 사진·스캔이나 완성 PDF로 그림책을 만들어 주문해요.</p></div><div className="book-desk-count"><b>{classrooms?.length ?? "–"}</b><span>학급</span></div></section>
    {error && <p className="error-box" role="alert">{error}</p>}
    <section className="book-panel" aria-labelledby="studio-classrooms"><h2 id="studio-classrooms">내 학급</h2>
      {classrooms === null ? <p className="book-empty">불러오는 중…</p> : classrooms.length ? <div className="book-library-grid">{classrooms.map((classroom) => <article className="book-library-card" key={classroom.id}><div className="book-card-copy"><h3>{classroom.displayName}</h3><p>지은이 {classroom.studentCount}명 · {new Date(classroom.updatedAt).toLocaleDateString("ko-KR")}</p></div><div className="book-card-buttons"><a className="button primary" href={`/teacher/class/${classroom.id}/books`}>그림책 열기 →</a><a className="small-button" href={`/teacher/class/${classroom.id}/books/orders`}>주문</a></div></article>)}</div> : <p className="book-empty">아직 학급이 없어요. 아래에서 첫 학급을 만들어 주세요.</p>}
    </section>
    <form className="book-panel" onSubmit={(event) => void create(event)} aria-labelledby="studio-new"><h2 id="studio-new">새 학급 만들기</h2><p>학생 명단은 없어도 돼요. 책을 올릴 때 지은이 이름을 적으면 돼요.</p>
      <div className="book-shipping-grid"><label>학급 이름<input required minLength={2} maxLength={30} value={name} onChange={(e) => setName(e.target.value)} placeholder="예: 4학년 2반" /></label><label>학교 (선택)<input maxLength={40} value={schoolName} onChange={(e) => setSchoolName(e.target.value)} placeholder="주문서에 미리 채워져요" /></label><label>학년 (선택)<select value={grade} onChange={(e) => setGrade(e.target.value)}><option value="">고르지 않음</option>{[1, 2, 3, 4, 5, 6].map((g) => <option key={g} value={g}>{g}학년</option>)}</select></label></div>
      <button className="button primary" disabled={busy || name.trim().length < 2}>{busy ? "만드는 중…" : "학급 만들기"}</button>
    </form>
  </main>;
}
