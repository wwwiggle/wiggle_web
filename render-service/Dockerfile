# 그림책 그리기 서버 이미지 (Cloudflare Containers). 빌드 위치는 저장소 루트:
#   docker build -f render-service/Dockerfile -t wiggle-render .
# resvg·sharp는 리눅스용 미리 빌드된 바이너리를 쓰므로 glibc 기반 이미지를 쓴다.
FROM node:22.23.2-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8080

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
  && npm rebuild sharp @resvg/resvg-js

# 앱과 같은 그리기 코드·저장소 어댑터·글꼴을 그대로 쓴다.
COPY tsconfig.json ./
COPY lib ./lib
COPY db ./db
COPY public/fonts ./public/fonts
COPY tests/harness/alias-hooks.mjs tests/harness/empty-module.mjs ./tests/harness/
COPY render-service ./render-service

EXPOSE 8080
USER node
CMD ["node", "--import", "./render-service/register.mjs", "render-service/server.ts"]
