import { Container, getRandom } from "@cloudflare/containers";

type Env = {
  RENDER: DurableObjectNamespace<RenderContainer>;
  WIGGLE_APP_ENV: string;
  WIGGLE_DATA_ENV: string;
  RENDER_SERVICE_SECRET: string;
  R2_S3_ENDPOINT: string;
  R2_S3_BUCKET: string;
  R2_S3_ACCESS_KEY_ID: string;
  R2_S3_SECRET_ACCESS_KEY: string;
};

const INSTANCES = 3; // wrangler.jsonc max_instances와 같게

/** 그리기 서버 컨테이너. Worker의 비밀 값을 컨테이너 환경 변수로 넘긴다. */
export class RenderContainer extends Container<Env> {
  defaultPort = 8080;
  // 그림책 그리기는 몇십 초 걸린다. 요청이 끊긴 뒤 5분 지나면 잠든다.
  sleepAfter = "5m";

  constructor(ctx: DurableObjectState<Record<string, never>>, env: Env) {
    super(ctx, env);
    this.envVars = {
      PORT: "8080",
      WIGGLE_APP_ENV: env.WIGGLE_APP_ENV,
      WIGGLE_DATA_ENV: env.WIGGLE_DATA_ENV,
      RENDER_SERVICE_SECRET: env.RENDER_SERVICE_SECRET,
      R2_S3_ENDPOINT: env.R2_S3_ENDPOINT,
      R2_S3_BUCKET: env.R2_S3_BUCKET,
      R2_S3_ACCESS_KEY_ID: env.R2_S3_ACCESS_KEY_ID,
      R2_S3_SECRET_ACCESS_KEY: env.R2_S3_SECRET_ACCESS_KEY,
    };
  }
}

const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!env.RENDER_SERVICE_SECRET) return Response.json({ error: "그리기 서버 설정이 끝나지 않았어요." }, { status: 503 });
    const container = await getRandom(env.RENDER, INSTANCES);
    return container.fetch(request);
  },
};

export default worker;
