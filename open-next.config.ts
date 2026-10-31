import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// 화면 대부분이 학생·교사마다 달라 미리 만들어 둘 페이지 캐시를 쓰지 않는다(꿈틀 그림책과 같은 설정).
export default defineCloudflareConfig({});
