// /student/draw/* 잠금 화면. 주소로 바로 들어와도 그림판을 열지 않는다(코드는 그대로 남아 있다).
import { DRAWING_LOCKED_MESSAGE } from "@/lib/feature-locks";

export function DrawingLocked() {
  return <main className="paid-lock-screen" data-paid-lock="">
    <p aria-hidden="true" style={{ fontSize: 56, lineHeight: 1 }}>🔒</p>
    <h1>{DRAWING_LOCKED_MESSAGE}</h1>
    <p>지금은 그림책 만들기를 쓸 수 있어요.<br />종이에 그린 그림은 사진으로 찍어 그림책에 넣어 보세요.</p>
    <div className="paid-lock-actions"><a className="button primary" href="/student/books">📖 내 그림책으로 가기</a><a className="button secondary" href="/student">처음으로</a></div>
  </main>;
}
