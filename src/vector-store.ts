// 벡터 저장소 인터페이스와 Vectorize 구현.
// 다른 파일은 Vectorize 를 직접 부르지 않고 이 인터페이스만 쓴다.
// 나중에 sqlite-vec, pgvector 등으로 옮길 때는 구현체만 새로 작성한다.

export interface VectorStore {
  /** 같은 id 가 있으면 덮어쓴다. */
  upsert(items: { id: number; vector: Float32Array }[]): Promise<void>;
  /** id 의 벡터와 가까운 순서로 최대 k 개. 자기 자신은 뺀다. */
  similar(id: number, k: number): Promise<{ id: number; score: number }[]>;
  delete(ids: number[]): Promise<void>;
}

/**
 * Vectorize(V2) 구현.
 * wrangler types 는 바인딩을 베타(V1) 타입인 VectorizeIndex 로 생성하지만, 실제 인덱스는 V2 이므로
 * queryById 가 있는 Vectorize 타입으로 바꿔서 쓴다. 이 변환은 이 파일에서만 한다.
 * V2 의 upsert·deleteByIds 는 비동기로 처리되며, 요청이 받아들여진 뒤 몇 초가 지나야 조회에 반영된다.
 */
export function createVectorizeStore(binding: Env["VECTORIZE"]): VectorStore {
  const index = binding as unknown as Vectorize;

  return {
    async upsert(items) {
      if (items.length === 0) return;
      await index.upsert(items.map((i) => ({ id: String(i.id), values: i.vector })));
    },

    async similar(id, k) {
      // 결과에 자기 자신이 포함되므로 1개 더 받는다.
      const { matches } = await index.queryById(String(id), { topK: k + 1, returnValues: false, returnMetadata: "none" });
      return matches
        .map((m) => ({ id: Number(m.id), score: m.score }))
        .filter((m) => Number.isSafeInteger(m.id) && m.id !== id)
        .slice(0, k);
    },

    async delete(ids) {
      if (ids.length === 0) return;
      await index.deleteByIds(ids.map(String));
    },
  };
}
