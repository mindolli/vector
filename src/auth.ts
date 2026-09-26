// 혼자 쓰는 서비스이므로 비밀 토큰 1개로 /api/* 를 보호한다.
// 요청: Authorization: Bearer <토큰>

/** 요청의 Bearer 토큰이 expected 와 같은지 확인한다. expected 가 비어 있으면 항상 거부한다. */
export async function isAuthorized(request: Request, expected: string | undefined): Promise<boolean> {
  if (!expected) return false;

  const header = request.headers.get("Authorization") ?? "";
  const match = /^Bearer (.+)$/.exec(header);
  if (!match || match[1] === undefined) return false;

  return timingSafeEqual(match[1], expected);
}

/**
 * 비교 시간으로 토큰을 추측할 수 없도록, 두 문자열을 SHA-256(항상 32바이트)으로 바꾼 뒤
 * 모든 바이트를 끝까지 비교한다. 길이가 달라도 걸리는 시간이 같다.
 */
export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

async function sha256(text: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return new Uint8Array(digest);
}
