// 임베딩 상태 전이: pending → embedded → indexed
// 실패하면 상태를 그대로 두고 embed_attempts 를 늘린다. 다음 처리 시점에 같은 단계부터 다시 시작한다.

import {
  getEmbeddings,
  getPipelineRow,
  listUnfinished,
  markEmbedded,
  markIndexed,
  recordFailure,
  type EmbedStatus,
} from "./db.ts";
import { buildEmbeddingInput, embed, EMBED_MODEL, EmptyInputError } from "./embed.ts";
import { createVectorizeStore } from "./vector-store.ts";

/** 같은 단계에서 이 횟수만큼 연속으로 실패하면 Cron 이 더 이상 시도하지 않는다. */
export const MAX_EMBED_ATTEMPTS = 5;
/** Cron 한 번에 처리할 개수. pending 은 AI 를 부르므로 적게, embedded 는 upsert 한 번으로 묶으므로 많이. */
const CRON_PENDING_LIMIT = 10;
const CRON_EMBEDDED_LIMIT = 100;

/**
 * 북마크 하나를 갈 수 있는 데까지 진행한다. 저장 직후 waitUntil 에서 부른다.
 * 돌려주는 값은 처리 후 상태이며, 그 사이에 삭제된 경우 null.
 */
export async function processBookmark(env: Env, id: number): Promise<EmbedStatus | null> {
  const row = await getPipelineRow(env.DB, id);
  if (!row) return null;
  if (row.embed_status === "indexed" || row.embed_attempts >= MAX_EMBED_ATTEMPTS) return row.embed_status;

  let vector: Float32Array | undefined;
  if (row.embed_status === "pending") {
    try {
      vector = await embed(env.AI, buildEmbeddingInput(row));
    } catch (err) {
      await fail(env, id, err);
      return "pending";
    }
    // 그 사이에 삭제됐거나 Cron 이 먼저 처리했으면 여기서 멈춘다.
    if (!(await markEmbedded(env.DB, id, vector, EMBED_MODEL))) return (await getPipelineRow(env.DB, id))?.embed_status ?? null;
  }

  const vectors = vector ? new Map([[id, vector]]) : await loadVectors(env, [id]);
  const indexed = await indexVectors(env, vectors);
  return indexed.includes(id) ? "indexed" : "embedded";
}

/** Cron: embedded 를 먼저 묶어서 인덱싱하고, pending 을 몇 개 임베딩한다. */
export async function processUnfinished(env: Env): Promise<{ indexed: number; embedded: number; failed: number }> {
  // 1. embedded: AI 호출 없이 D1 의 벡터 사본을 한 번의 upsert 로 넣는다 (Vectorize 재구축도 이 경로).
  const embeddedRows = await listUnfinished(env.DB, "embedded", MAX_EMBED_ATTEMPTS, CRON_EMBEDDED_LIMIT);
  const indexedIds = await indexVectors(env, await loadVectors(env, embeddedRows.map((r) => r.id)));

  // 2. pending: 하나씩 임베딩한다. 성공하면 processBookmark 가 곧바로 인덱싱까지 진행한다.
  const pendingRows = await listUnfinished(env.DB, "pending", MAX_EMBED_ATTEMPTS, CRON_PENDING_LIMIT);
  let embedded = 0;
  let failed = 0;
  for (const row of pendingRows) {
    const status = await processBookmark(env, row.id);
    if (status === "pending") failed++;
    else embedded++;
  }

  const summary = { indexed: indexedIds.length, embedded, failed };
  console.log("processUnfinished", summary);
  return summary;
}

/** 벡터들을 Vectorize 에 넣고 indexed 로 표시한다. 실패하면 각 행에 실패를 기록한다. */
async function indexVectors(env: Env, vectors: Map<number, Float32Array>): Promise<number[]> {
  const ids = [...vectors.keys()];
  if (ids.length === 0) return [];
  try {
    await createVectorizeStore(env.VECTORIZE).upsert(ids.map((id) => ({ id, vector: vectors.get(id)! })));
  } catch (err) {
    await Promise.all(ids.map((id) => fail(env, id, err)));
    return [];
  }
  await markIndexed(env.DB, ids);
  return ids;
}

/** D1 에서 벡터 사본을 읽는다. embedded 인데 벡터가 없는 행은 실패로 기록해서 조용히 건너뛰지 않게 한다. */
async function loadVectors(env: Env, ids: number[]): Promise<Map<number, Float32Array>> {
  const vectors = await getEmbeddings(env.DB, ids);
  const missing = ids.filter((id) => !vectors.has(id));
  await Promise.all(missing.map((id) => fail(env, id, new Error("embedded row has no stored vector"))));
  return vectors;
}

async function fail(env: Env, id: number, err: unknown): Promise<void> {
  const permanent = err instanceof EmptyInputError;
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  console.error("embedding pipeline failed", { id, permanent, message });
  await recordFailure(env.DB, id, message, MAX_EMBED_ATTEMPTS, permanent);
}
