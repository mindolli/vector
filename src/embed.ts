// 북마크 텍스트 → bge-m3 임베딩 (1024차원). Workers AI 는 저장할 때만 호출한다.

import type { BookmarkInput } from "./db.ts";

export const EMBED_MODEL = "@cf/baai/bge-m3";
export const EMBED_DIM = 1024;

/** 임베딩할 텍스트가 하나도 없을 때. 다시 시도해도 결과가 같으므로 재시도 대상이 아니다. */
export class EmptyInputError extends Error {
  constructor() {
    super("nothing to embed: title, memo, description and content are all empty");
    this.name = "EmptyInputError";
  }
}

/**
 * 제목 → 메모 → description → 본문 순서로 잇는다. 빈 필드는 건너뛴다.
 * 메모를 앞에 두는 이유: 직접 쓴 설명이 페이지 본문보다 의도를 더 정확하게 나타낸다.
 * URL 은 넣지 않는다.
 */
export function buildEmbeddingInput(b: Pick<BookmarkInput, "title" | "memo" | "description" | "content">): string {
  return [b.title, b.memo, b.description, b.content]
    .map((s) => s.trim())
    .filter((s) => s !== "")
    .join("\n");
}

/** 텍스트 하나를 임베딩해서 길이 1024 의 Float32Array 로 돌려준다. */
export async function embed(ai: Ai, text: string): Promise<Float32Array> {
  if (text.trim() === "") throw new EmptyInputError();

  const out = await ai.run(EMBED_MODEL, { text, truncate_inputs: true });
  // 반환 타입은 여러 응답 형태의 합집합이다. { text } 요청의 응답은 { shape, data } 형태다.
  if (!("data" in out) || !Array.isArray(out.data) || out.data.length !== 1) {
    throw new Error(`unexpected ${EMBED_MODEL} response: ${JSON.stringify(out).slice(0, 200)}`);
  }
  const vector = out.data[0]!;
  if (vector.length !== EMBED_DIM) {
    throw new Error(`expected ${EMBED_DIM} dimensions, got ${vector.length}`);
  }
  return Float32Array.from(vector);
}
