import type { NextConfig } from "next";

// worker/index.ts가 부착하던 보안 헤더를 경로별로 동일하게 재현한다.
// 나중에 오는 항목이 같은 키를 덮으므로 /family 강화 세트를 마지막에 둔다.
const baseHeaders = [
  { key: "x-content-type-options", value: "nosniff" },
  { key: "referrer-policy", value: "strict-origin-when-cross-origin" },
];

// 공개 랜딩("/")만 프레임 허용으로 남긴다 — 호스팅 미리보기 유지.
const frameDenyHeaders = [
  { key: "x-frame-options", value: "DENY" },
  { key: "content-security-policy", value: "frame-ancestors 'none'" },
];

const familyHeaders = [
  { key: "cache-control", value: "no-store, max-age=0" },
  { key: "pragma", value: "no-cache" },
  { key: "referrer-policy", value: "no-referrer" },
  { key: "x-content-type-options", value: "nosniff" },
  { key: "x-frame-options", value: "DENY" },
  { key: "cross-origin-resource-policy", value: "same-origin" },
  { key: "x-robots-tag", value: "noindex, nofollow, noarchive" },
  {
    key: "content-security-policy",
    value:
      "default-src 'self'; img-src 'self' data: blob:; media-src 'self' data: blob:; connect-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  },
];

// Cloudflare Workers로 빌드할 때(`npm run build:cloudflare`): Workers에서 못 도는 네이티브 모듈을 대체 모듈로 바꾼다.
// 그림책 그리기는 그리기 서버(render-service), DB는 Supabase가 맡는다. Vercel 빌드에는 영향이 없다.
const cloudflare = process.env.WIGGLE_TARGET === "cloudflare";
// 요청 이름이나 실제 파일 경로가 맞으면 대체 모듈로 바꾼다(`@/…` 별칭은 Next가 먼저 풀기 때문에 경로로 잡는다).
// 끝을 고정해 book-render-shared 같은 이웃 모듈은 그대로 둔다.
const cloudflareReplacements: [RegExp, string][] = [
  [/(^@\/lib\/book-render$)|([\\/]lib[\\/]book-render(\.ts)?$)/, "./lib/cloudflare-stubs/book-render.ts"],
  [/[\\/]db[\\/]adapters[\\/]turso-d1(\.ts)?$/, "./lib/cloudflare-stubs/turso-d1.ts"],
];

const nextConfig: NextConfig = {
  // 저장소의 제품·보안 규칙 AGENTS.md를 Next가 실행 때마다 자동 수정하지 않게 한다.
  agentRules: false,
  // libSQL 클라이언트는 네이티브 바인딩을 포함하므로 서버 번들에 넣지 않는다.
  serverExternalPackages: cloudflare ? [] : ["@libsql/client", "libsql", "@resvg/resvg-js", "sharp"],
  ...(cloudflare
    ? {
        webpack(config: { plugins: unknown[] }, { webpack }: { webpack: { NormalModuleReplacementPlugin: new (pattern: RegExp, replacement: string) => unknown } }) {
          for (const [pattern, to] of cloudflareReplacements) config.plugins.push(new webpack.NormalModuleReplacementPlugin(pattern, new URL(to, import.meta.url).pathname));
          return config;
        },
      }
    : {}),
  outputFileTracingIncludes: { "/api/teacher/*": ["./config/rubrics/**/*", "./public/fonts/**/*"] },
  // dev 도구 부유 버튼이 어린이용 UI의 히트 테스트(브라우저 실측)를 가린다.
  devIndicators: false,
  async headers() {
    return [
      { source: "/:path*", headers: baseHeaders },
      { source: "/:path+", headers: frameDenyHeaders },
      { source: "/family/:path*", headers: familyHeaders },
      { source: "/api/family/:path*", headers: familyHeaders },
      // ebook 링크: 토큰이 주소에 있으므로 리퍼러·캐시·검색 노출을 막는다(가족 공유와 같은 강화 세트).
      { source: "/ebook/:path*", headers: familyHeaders },
      { source: "/api/ebook/:path*", headers: familyHeaders },
    ];
  },
};

export default nextConfig;
