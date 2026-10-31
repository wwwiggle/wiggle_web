// node --import ./render-service/register.mjs render-service/server.ts
// 앱 코드의 `@/…` 별칭과 Next 표식 패키지(server-only)를 Node에서 풀어 주는 훅. 테스트와 같은 훅을 쓴다.
import { register } from "node:module";

register("../tests/harness/alias-hooks.mjs", import.meta.url);
