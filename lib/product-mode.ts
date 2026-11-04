/**
 * 2026-11-04 사용자 결정: www.kkumtle.app은 교사 전용 "그림책 공방"이 된다 — 학생 입장·그리기·가족 공유 화면을 끄고,
 * 교사가 사진·스캔·PDF로 그림책을 만들어 편집하고 주문·결제한다("기본 기능에서 그리기 기능은 빼고, 올라온 그림 수정해서
 * pdf로 넣거나 완성된 pdf를 넣어서 주문·결제").
 *
 * 학생 코드와 데이터는 지우지 않는다. WIGGLE_STUDENT_APP=1이면 예전 수업 앱(학생 화면 포함)으로 돌아간다.
 */
export function studentAppEnabled(source: Record<string, string | undefined> = process.env) {
  return source.WIGGLE_STUDENT_APP?.trim() === "1";
}

/** 학생 앱을 끄면 닫히는 화면 주소. API는 테스트·기존 기기 저장 때문에 그대로 둔다. */
export function isStudentPagePath(pathname: string) {
  return /^\/(join|student|family)(\/|$)/.test(pathname);
}
