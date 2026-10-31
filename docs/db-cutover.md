# DB 이사 당일 진행표 (Turso → Supabase, 서버는 Vercel 그대로)

2026-11-01 사용자 결정 "A 진행하자": 서버(Vercel)는 그대로 두고 DB만 먼저 옮긴다. 리허설 결과는 `current-state.md` 「DB 이사 리허설」.

## 미리 (이사 전날까지)

| 할 일 | 누가 | 확인 |
| --- | --- | --- |
| PR #39(두 DB 겸용), 점검 모드 PR, PR #46이 운영에 반영돼 있다 | 팀 | `www.kkumtle.app/api/health` 200 |
| 운영 Supabase(`kkumtle-book`, 제윤님 조직)에 `wiggle_web` 역할과 `web` 스키마를 만든다 — 개발 프로젝트와 같은 방법 | Claude | 역할 search_path = `web, public` |
| 운영 `DATABASE_URL`(풀러 6543, `wiggle_web.hatcajqaiypaoqyvcckt` 사용자)을 Vercel 담당자에게 개인 메시지로 전달 | 사용자 | 채팅·단체방에 붙이지 않는다 |
| 날짜·시각을 정한다. 수업이 없는 시간(저녁·주말), 30분 | 팀 | 선생님 공지가 필요하면 미리 |

## 당일 (Vercel 담당 = 용환님 또는 제윤님, 복사 = Claude)

1. **점검 시작** — Vercel → wiggle-web → Settings → Environment Variables → `WIGGLE_MAINTENANCE` = `1` (Production) → Deployments에서 최신 운영 배포 **Redeploy**. 끝나면 `/api/student`가 503, `/api/health`가 200인지 Claude가 확인한다.
2. **최종 복사** — Claude: `scripts/migrate-turso-to-postgres.mjs`로 운영 Turso → 운영 Supabase `web`. **44표 모두 "같음"**이어야 다음으로 간다(점검 중이라 리허설 때처럼 바뀌는 표가 없어야 한다). 하나라도 다르면 멈추고 원인을 본다.
3. **전환** — Vercel: `DATABASE_URL` = 운영 Supabase 주소 (Production) 추가, `WIGGLE_MAINTENANCE` 삭제 → Redeploy.
4. **확인** — Claude: `/api/health` 200, 학생 입장·그림 저장·선생님 화면·그림책 열기. 저장 경로 실측 `node scripts/check-deployed.mjs https://www.kkumtle.app <수업코드>`(검증용 학생 하나가 생긴다 — 끝나면 정리). Supabase `web`에 새 행이 쌓이는지 본다.
5. **끝** — 팀에 알린다. Turso는 그대로 둔다(되돌리기용).

## 문제가 생기면 (되돌리기)

- Vercel에서 `DATABASE_URL`을 지우고 Redeploy → 다시 Turso를 쓴다.
- ⚠️ 전환 뒤 Supabase에만 저장된 것(그림·그림책 수정)은 Turso에 없다. 전환 직후 문제를 발견했다면 바로 되돌리고, 시간이 지났다면 되돌리기 전에 Supabase → Turso로 새 행을 옮길지 먼저 정한다.

## 며칠 뒤 정리

- 문제가 없으면 Turso 토큰 전체 무효화: `turso db tokens invalidate wiggle-yonghwan86`(용환님). 2026-11-01에 받은 토큰이 `rw`이고 채팅에 노출돼 반드시 한다. 운영이 Turso를 안 쓰게 된 뒤라 영향이 없다.
- Vercel 환경 변수 `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` 삭제. 코드의 Turso 길(`db/adapters/turso-d1.ts`, SQLite 스키마 업그레이드)은 3단계(Cloudflare)와 함께 걷어 낸다.
