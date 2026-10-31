# Vercel → Cloudflare 이사 진행표 (3단계)

2026-11-01 사용자 지시 "꿈틀웹 마무리하자". DB는 이미 Supabase다(`docs/db-cutover.md`). 이번에는 서버만 옮긴다 — 기능·데이터는 그대로다.

## 구성

| 하는 일 | Vercel(지금) | Cloudflare(옮긴 뒤) |
| --- | --- | --- |
| Next 앱 | Vercel 함수 | Worker `wiggle-web` (OpenNext, `npm run build:cloudflare`) |
| 그림책 그리기(resvg·sharp) | 같은 함수 안 | 그리기 서버 Worker `wiggle-render` + Containers (`render-service/`) |
| DB | Supabase `web` | 같음 |
| 그림 파일 | R2(S3 API) | 같음 |
| 배포 | main → Vercel | main → Workers Builds(또는 GitHub Actions) |
| 도메인 | Vercel | Cloudflare 커스텀 도메인 (`kkumtle.app`은 이미 Cloudflare DNS) |

Cloudflare 빌드에서는 `next.config.ts`가 `lib/book-render.ts`와 `db/adapters/turso-d1.ts`를 `lib/cloudflare-stubs/`로 바꾼다(네이티브 모듈이 Workers에서 안 돈다). 그림책 그리기는 `RENDER_SERVICE_URL`이 꼭 있어야 한다.

## 필요한 것

| 무엇 | 누가 | 왜 |
| --- | --- | --- |
| Workers 유료 요금제(월 $5) — `kkumtle.app`이 있는 계정 | 제윤님 | Containers(그리기 서버), 요청당 계산 시간(무료 10ms로는 화면 하나도 빠듯), 번들 크기(지금 압축 2.88MB로 무료 한도 3MB에 거의 닿음) |
| Vercel 운영 비밀 값 | 용환님 | 아래 목록을 Worker 비밀 값으로 옮긴다 |
| Cloudflare 배포 권한 | 제윤님 | 지금 eubean7 권한은 "개별 Workers 편집"이라 새 Worker를 만들 수 있는지 확인 필요 |

Worker 비밀 값(`wrangler secret put`): `DATABASE_URL`, `R2_S3_ENDPOINT`, `R2_S3_BUCKET`, `R2_S3_ACCESS_KEY_ID`, `R2_S3_SECRET_ACCESS_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `OPENAI_API_KEY`, `OPENAI_MODEL`, `BOOK_FEEDBACK_MODEL`, `SWEETBOOK_API_KEY`, `SWEETBOOK_ENV`, `SWEETBOOK_LIVE_ORDERS_ENABLED`, `ADMIN_EMAILS`, `RENDER_SERVICE_URL`, `RENDER_SERVICE_SECRET`. 그리기 서버 Worker에는 `RENDER_SERVICE_SECRET`과 `R2_S3_*`.

## 순서

1. 그리기 서버 배포(`render-service/cloudflare`, GitHub Actions `RENDER_DEPLOY_ENABLED=true`). 실제 그림책 한 권을 Vercel 결과와 비교한다.
2. `wiggle-web` Worker를 workers.dev 주소로 먼저 올린다(도메인 없이). 비밀 값을 넣는다.
3. workers.dev 주소에서 확인: 학생 입장·그리기·저장, 교사 화면, 그림책 편집·PDF·인쇄 준비, 몽그리. 교사 구글 로그인은 그 주소를 구글 콘솔 리디렉션 URI에 잠깐 더해서 본다.
4. 이사(수업 없는 시간): Cloudflare에서 `www.kkumtle.app`, `kkumtle.app`을 `wiggle-web` Worker 커스텀 도메인으로 붙인다(기존 Vercel DNS 레코드를 바꾼다). `/api/health`·학생 입장 확인.
5. 되돌리기: DNS 레코드를 이사 전 Vercel 값으로 되돌린다. DB가 같아 데이터 문제는 없다.
   - 2026-11-01 공개 조회 기록: `kkumtle.app` A `216.198.79.67`, `64.29.17.67` / `www.kkumtle.app` CNAME `wiggleweb.vercel.app`. (eubean7의 DNS 권한으로는 레코드 목록 API가 막혀, 이사 전에 대시보드에서 한 번 더 확인한다.)
6. 며칠 뒤: Vercel에서 도메인 제거, 프로젝트 끄기, 저장소 비공개.
