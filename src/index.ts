import { handleApi } from "./routes.ts";

export default {
  async fetch(request, env, ctx): Promise<Response> {
    // 정적 파일(public/)에 없는 경로만 이곳으로 들어온다.
    const { pathname } = new URL(request.url);
    if (pathname === "/api" || pathname.startsWith("/api/")) {
      try {
        return await handleApi(request, env, ctx);
      } catch (err) {
        // 내부 오류 내용은 로그에만 남기고 응답에는 드러내지 않는다.
        console.error("unhandled api error", err);
        return Response.json({ error: "internal error" }, { status: 500 });
      }
    }
    return new Response("Not found", { status: 404 });
  },

  async scheduled(controller, env, ctx): Promise<void> {
    // 밀린 임베딩·인덱싱 처리는 3페이즈(pipeline.ts)에서 추가한다.
  },
} satisfies ExportedHandler<Env>;
