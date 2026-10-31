# Wiggle Web — Claude Code 작업 규칙

이 파일은 Claude Code가 이 저장소에서 개발할 때 항상 지켜야 할 최소 규칙이다. 작업을 시작하기 전에 다음 문서를 끝까지 읽는다.

1. [현재 구현·검증·배포 상태](docs/current-state.md)
2. [확정 제품 결정](docs/product-decisions.md)
3. [미결정 항목](docs/pending-decisions.md)
4. [상세 개발 인수인계](docs/claude-handoff-2026-07-27.md)

## 지속 컨텍스트 규칙

- 구현·검증·커밋 상태가 바뀌면 `docs/current-state.md`를 같은 작업에서 갱신한다.
- 사용자가 확정한 결정과 이유는 `docs/product-decisions.md`에 기록한다.
- 아직 선택이 필요한 항목과 질문 원문은 `docs/pending-decisions.md`에 기록한다.
- 채팅 요약만으로 과거의 번호나 문장을 추측하지 않는다.
- 문서와 사용자의 최근 명시적 지시가 충돌하면 최근 지시를 우선하고 문서를 바로 고친다.

## 프로젝트 경계

- 작업 저장소는 **`wwwiggle/wiggle_web`** 하나다(2026-10-31 사용자 지시: "깃허브 저장소를 옮겨서 … 여기서 작업 새로 할거거든"). 로컬 클론 경로는 기기마다 다르다.
  - `yonghwan86/wiggle_web`을 GitHub에서 **이전(transfer)**한 같은 저장소다(저장소 ID 동일, 옛 주소는 새 주소로 연결된다). 이슈·PR 번호와 Vercel 연결이 그대로 이어진다.
  - `origin` = `https://github.com/wwwiggle/wiggle_web.git`. 작업 계정에 admin 권한이 있으므로 기능 브랜치를 `origin`에 바로 push하고 `gh pr create --repo wwwiggle/wiggle_web --base main`으로 PR을 연다. 포크를 거치지 않는다.
  - 옛 클론의 `origin`이 `yonghwan86/wiggle_web`이면 `git remote set-url origin https://github.com/wwwiggle/wiggle_web.git`으로 바꾼다.
  - 은퇴(2026-10-31): `wwwiggle/new_wiggle`(보관 처리됨)과의 양쪽 동기화 규칙(2026-09-21 결정), 포크(`wpdbs1229`·`qudcks1940`) 경유 PR.
- `C:\Users\user\Desktop\Project\wiggle_draw`는 읽기 전용 참고 자료다. 수정하거나 통째로 복사하지 않는다.
- `.openai/hosting.json`은 은퇴한 Sites 연결의 이력이다. 삭제하거나 프로젝트 ID를 바꾸지 않는다.
- `.env.local`, API 키, 토큰, 쿠키 등 비밀값을 읽어 출력하거나 커밋하지 않는다.
- 운영 자격증명(TURSO_*, DATABASE_URL, R2_S3_*)은 `.env.local`에 `# vercel-only: KEY=value` 주석으로만 보관한다. 활성 줄로 두면 Next dev가 env를 핫리로드해 로컬 개발·테스트가 운영 DB·버킷에 그대로 쓴다(2026-08-19 실제 사고). 원격 검증이 필요할 때만 잠깐 활성화하고 즉시 되돌린다.

## 제품 불변 원칙

- 수업 코드와 학급 QR은 입장 수단일 뿐 학생 작품 접근 권한이 아니다. 예외는 잘라 나눠 주는 아이별 쪽지 QR로, 그 아이 참여 코드를 주소 조각(`#entry=`)에 담는다(2026-09-13 사용자 결정 — 같은 쪽지에 참여 코드가 이미 글자로 인쇄돼 있어 쪽지가 입장 수단이라는 점은 같다). 참여 코드를 쿼리에 넣지 않고, 선생님 화면의 큰 QR에는 절대 담지 않는다.
- 작품과 과정 기록은 서버가 발급한 익명 학생 ID에 저장한다.
- 학생 이메일·학교명·점수·순위·재능 진단을 만들지 않는다.
- 학생 실명은 교사가 만든 학급 명단에만 있고, 그 학급 담임 교사에게만 보인다(2026-09-07 사용자 결정으로 종전 실명 금지 원칙을 바꿈). 학생 화면·가족 공유·그림책·AI 요청에는 실명을 싣지 않는다. 학급을 지우면 명단도 함께 지운다.
- AI 몽그리는 그림을 대신 완성하거나 평가하지 않는다.
- 몽그리는 아이가 부를 때, 그리고 정해진 조건에서 스스로 한 번 먼저 말을 건다(2026-09-12 변경). 어느 쪽이든 그리기를 막지 않고, 모르면 추측하지 않고 한 번에 하나만 질문한다. 조건은 `tests/auto-grimi.test.mjs`가 지킨다.
- 점선과 시범은 아이 원본 그림과 분리된 레이어이며 저장 이미지에 합성하지 않는다.
- 초등학교 3~6학년이 핵심 사용자다(2026-09-12 확정). 읽기 수준 차이를 고려해 핵심 행동은 그림과 큰 터치 목표로도 이해할 수 있어야 한다(브라우저 읽어 주기 버튼은 2026-09-09 사용자 지시로 제거).

## 개발 절차

1. 기능마다 `claude/<짧은-작업명>` 브랜치를 만든다.
2. 관련 코드와 기존 테스트를 먼저 읽고, 범위를 좁혀 수정한다.
3. 개발자가 직접 만든 테스트만으로 완료 판정하지 않는다.
4. 최소 검증을 모두 통과시킨다.
   ⚠️ **Node는 `.nvmrc`의 버전(22.23.2)을 쓴다.** `package.json`의 `engines`가 `>=22.18.0`인 이유:
   그보다 낮으면 `.ts` 임포트 타입 스트리핑이 기본이 아니고(22.18+), `node:module`의
   `registerHooks`도 없어(22.15+) `pbkdf2-runtime` 같은 테스트가 통째로 실패한다.
   낮은 버전에서 플래그로 우회하지 말고 `nvm use`로 맞춘다 — 보안 패치도 함께 받는다.

```powershell
npm.cmd run typecheck
npm.cmd run lint
npm.cmd test
npm.cmd run test:postgres   # DB 이사 기간(2026-10-31~): 같은 테스트를 Postgres로도 돌린다
git diff --check
git diff --check main...HEAD
```

5. 모바일 UI는 최소 `320×568`, `390×844`, `844×390`에서 실제 브라우저로 확인한다.
   ⚠️ `browser-check.mjs`는 자기 서버를 띄우지 않는다 — 인자가 없으면 `localhost:3000`의
   **아무 서버나** 검사한다(다른 워크트리 서버를 검사한 실사고, 2026-09-07).
   반드시 현재 트리를 빌드해 띄우고 주소를 명시한다:
   `npm run build && npx next start -p 3299 & node scripts/browser-check.mjs http://localhost:3299`
6. 소스 문자열이나 CSS 정규식 검사만으로 UX 통과를 주장하지 않는다. computed size, 잘림, 스크롤, 초점, 연속 탭, 오류 복구를 실제 동작으로 검증한다.
7. 작업 결과에는 변경 파일, 재현한 문제, 실행한 검증, 남은 위험을 사실대로 기록한다.
8. Claude는 기능 브랜치에 커밋·push까지 마친 뒤 사용자에게 알린다. `main` 반영은 사용자가 지시했을 때만 한다(2026-09-20·21 사용자 지시로 Claude가 직접 올린 전례가 있다). `main` 반영이 곧 운영 배포이며, PR로 한다.

## 배포 (GitHub → Vercel)

- ⚠️ **운영은 `origin`(`wwwiggle/wiggle_web`)의 `main`을 빌드한다.** 2026-10-31 저장소 이전 뒤에도 같은 저장소의 GitHub 배포 기록에 Vercel Production 배포가 이어진다(`5ba702c`).
- 운영 주소: **`https://www.kkumtle.app`** — Vercel 프로젝트 `wiggle-web`(서울 리전 icn1). 옛 `wiggleweb.vercel.app`은 같은 프로젝트의 서브도메인이고, `wiggle-web.vercel.app`은 타인 소유이므로 사용·안내 금지.
- 운영 환경 변수는 Vercel 대시보드에서만 관리한다(9종: `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `R2_S3_ENDPOINT`, `R2_S3_BUCKET`, `R2_S3_ACCESS_KEY_ID`, `R2_S3_SECRET_ACCESS_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `OPENAI_API_KEY`). 값에 따옴표를 넣지 않는다.
- DB(Turso)는 첫 요청의 `ensureSchema()`가 자가 프로비저닝한다. **2026-10-31부터 Supabase로 이사 중**: `DATABASE_URL`이 있으면 Supabase Postgres(`web` 스키마, `db/postgres-schema.ts`), 없으면 Turso. SQLite 스키마에 칸·표를 더하면 `db/postgres-schema.ts`에도 더한다(`tests/postgres-schema.test.mjs`가 확인). 운영 Turso·R2 데이터를 SQL·S3로 직접 수정·삭제하지 않는다(정리도 사용자 승인 필요).
- 교사 인증은 구글 OAuth다. 도메인을 추가하면 구글 콘솔의 승인된 리디렉션 URI에 `https://<도메인>/api/auth/google/callback`을 함께 추가해야 그 도메인에서 교사 로그인이 된다.
- 저장 경로(작품 저장·이미지·인증)를 건드린 배포는 반영 후 운영 실측을 돌린다: `node scripts/check-deployed.mjs https://www.kkumtle.app <수업코드>` — 실제 수업 코드가 필요하고 검증용 학생이 하나 생기므로 사용자에게 알리고 정리를 안내한다. 그 외 배포는 랜딩·핵심 API 스모크로 충분하다.
- 은퇴(2026-08-19): ChatGPT Sites 배포, Codex 독립 검증 게이트, `pipeline:ready` marker. `docs/agent-handoff/`와 `.openai/hosting.json`은 이력 보존용으로만 남긴다.

## 현재 우선순위

우선순위와 미결정 항목의 정본은 `docs/current-state.md`와 `docs/pending-decisions.md`다. 새 기능보다 실사용 안정(교실에서 아이 혼자 쓸 수 있는가, 저장 신뢰성)을 우선한다.
