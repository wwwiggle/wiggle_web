import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      "react-hooks/set-state-in-effect": "off",
      "@next/next/no-html-link-for-pages": "off",
      "@next/next/no-img-element": "off",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "outputs/**",
    "next-env.d.ts",
    "public/pdfjs/**",
    // Cloudflare 빌드 결과물(npm run build:cloudflare)
    ".open-next/**",
    ".wrangler/**",
    "render-service/cloudflare/**",
  ]),
]);

export default eslintConfig;
