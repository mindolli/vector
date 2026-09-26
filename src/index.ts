export default {
  async fetch(request, env, ctx): Promise<Response> {
    // 정적 파일(public/)에 없는 경로만 이곳으로 들어온다.
    // /api/* 라우팅은 다음 단계에서 추가한다.
    return new Response("Not found", { status: 404 });
  },

  async scheduled(controller, env, ctx): Promise<void> {
    // 밀린 임베딩·인덱싱 처리는 pipeline 단계에서 추가한다.
  },
} satisfies ExportedHandler<Env>;
