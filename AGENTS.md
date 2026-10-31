# Wiggle Web — 에이전트 공통 규칙 (Codex 등)

이 저장소에서 작업하는 모든 코딩 에이전트의 공통 규칙이다. 2026-08-19 재플랫폼으로
배포는 GitHub `main` → Vercel 자동 배포로 바뀌었고, 예전의 Codex 독립 검증·Sites
릴리스 게이트는 은퇴했다(이력: `docs/agent-pipeline.md`). Codex는 이제 요청받은
기능 개발이나 교차 감사를 수행하는 일반 에이전트다.

## 지속 컨텍스트 규칙

1. 작업 시작 전에 `docs/current-state.md`, `docs/product-decisions.md`, `docs/pending-decisions.md`를 끝까지 읽는다.
2. 구현·검증·커밋·배포 상태가 바뀌면 `current-state.md`를 같은 작업에서 갱신한다.
3. 사용자가 확정한 제품 결정과 이유는 `product-decisions.md`에 기록한다.
4. 아직 선택이 필요한 항목과 질문 원문은 `pending-decisions.md`에 기록한다.
5. 채팅 요약만으로 과거의 번호나 문장을 추측하지 않는다. 문서에도 없다면 사용자에게 확인한다.
6. 문서와 사용자의 최근 명시적 지시가 충돌하면 최근 지시를 우선하고 문서를 바로 고친다.

## 경계

- GitHub `main`에 push하지 않는다. `main` push는 곧 운영 배포이며 사용자만 실행한다.
- 작업은 자기 브랜치(`codex/*` 또는 `claude/*`)에서 하고, 다른 에이전트의 브랜치를 대신 수정하지 않는다.
- 같은 폴더를 여러 세션이 공유할 수 있다 — 커밋 전에 `git branch --show-current`로 브랜치를 확인한다.
- `C:\Users\user\Desktop\Project\wiggle_draw`는 읽기 전용 참고 자료다.
- `.env.local`, API 키, 토큰, 쿠키를 출력하거나 커밋하지 않는다. `# vercel-only:` 주석 줄의 운영 자격증명을 활성화하지 않는다(로컬이 운영 DB·버킷을 물게 됨).
- 운영 Turso·R2 데이터를 직접 수정하거나 삭제하지 않는다.
- `.openai/hosting.json`은 은퇴한 Sites 연결의 이력이다 — 삭제·수정하지 않는다.
- 다른 에이전트의 설명과 테스트 결과를 정답으로 간주하지 않는다. 직접 재현한다.

## 검증 게이트

```powershell
npm.cmd run typecheck
npm.cmd run lint
npm.cmd test
git diff --check
git diff --check main...HEAD
```

- `npm.cmd test`는 production build 뒤 전체 테스트를 실행한다. DB 이사 기간(2026-10-31~)에는 `npm.cmd run test:postgres`로 같은 테스트를 Postgres로도 돌린다. 무거운 HTTP 통합만 따로 돌리려면 `npm.cmd run test:integration`.
- 브라우저 실측: 로컬 서버를 띄운 뒤 `npm.cmd run check:browser` — `320×568`, `390×844`, `844×390`에서 computed size·잘림·초점·연속 탭을 실제 DOM으로 확인한다.
- 테스트가 문자열 존재만 확인하면서 실제 UX를 통과했다고 주장하지 않는다.
- 저장·이미지·인증 경로를 바꿨다면 배포 후 운영 실측(`scripts/check-deployed.mjs`)까지가 검증이다 — 실제 수업 코드가 필요하므로 사용자와 조율한다.

## 배포 요약

- 운영: `https://www.kkumtle.app` (저장소 `wwwiggle/wiggle_web`, Vercel 프로젝트 `wiggle-web`, `main` 반영 시 자동 배포). DB는 Turso → Supabase 이사 중이다(`DATABASE_URL`).
- 운영 환경 변수는 Vercel 대시보드에서 관리한다. 저장소에는 어떤 비밀값도 두지 않는다.
- 교사 인증은 구글 OAuth — 새 도메인은 구글 콘솔 리디렉션 URI 추가가 필요하다.
