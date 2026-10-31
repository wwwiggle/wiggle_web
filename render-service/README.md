# 그림책 그리기 서버 (render-service)

Cloudflare Workers에서는 `resvg`·`sharp`가 돌지 않아서, 그림책 쪽 그리기와 PDF 만들기만 따로 떼어 낸 작은 서버다(2026-11-01, Cloudflare 이사 2단계).

- 그리는 코드는 앱과 같은 `lib/book-render.ts`다. 직접 그릴 때와 결과가 같다(`tests/render-service.test.mjs`).
- 앱은 `RENDER_SERVICE_URL`이 있으면 이 서버에 맡기고, 없으면 지금처럼 직접 그린다(`lib/book-render-service.ts`). Vercel 운영은 설정이 없어 영향이 없다.
- 그림은 앱이 넘긴 저장소 키로 R2(S3 API)에서 직접 읽는다. 책 한 권(최대 80MB)을 Worker 메모리로 넘기지 않으려고.
- 요청에는 `x-render-secret: <RENDER_SERVICE_SECRET>`이 있어야 한다.

## 로컬 실행

```
WIGGLE_APP_ENV=local RENDER_SERVICE_SECRET=아무값 PORT=8080 node --import ./render-service/register.mjs render-service/server.ts
```

## 환경 변수

| 이름 | 뜻 |
| --- | --- |
| `RENDER_SERVICE_SECRET` | 앱과 같은 값. 없으면 시작하지 않는다 |
| `WIGGLE_APP_ENV`, `WIGGLE_DATA_ENV` | 앱과 같은 환경 경계(`lib/runtime/environment.ts`) |
| `R2_S3_ENDPOINT`, `R2_S3_BUCKET`, `R2_S3_ACCESS_KEY_ID`, `R2_S3_SECRET_ACCESS_KEY` | 운영·Preview 그림 저장소 (앱과 같은 값) |
| `ARTWORKS_FS_DIR` | 로컬·테스트 파일 저장소 |
| `PORT` | 기본 8080 |

## 이미지

```
docker build -f render-service/Dockerfile -t wiggle-render .
```

Cloudflare Containers 연결(Worker 바인딩)은 3단계(Vercel → Cloudflare)에서 한다.
