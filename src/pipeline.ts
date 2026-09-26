// 임베딩 상태 전이: pending → embedded → indexed
// 실패하면 상태를 그대로 두고 embed_attempts 를 늘린다. 다음 처리 시점에 같은 단계부터 다시 시작한다.
// 임베딩은 embedOne, 인덱싱은 indexVectors 한 곳에서만 한다.

import {
  existingIds,
  getEmbeddings,
  getPipelineRow,
  listUnfinished,
  markEmbedded,
  markIndexed,
  recordFailure,
  type EmbedStatus,
  type PipelineRow,
  type UnfinishedStatus,
} from "./db.ts";
import { buildEmbeddingInput, embed, EMBED_MODEL, EmptyInputError } from "./embed.ts";
import { createVectorizeStore } from "./vector-store.ts";

/** 같은 단계에서 이 횟수만큼 연속으로 실패하면 Cron 이 더 이상 시도하지 않는다. */
export const MAX_EMBED_ATTEMPTS = 5;
/** Cron 한 번에 처리할 개수. pending 은 AI 를 부르므로 적게, embedded 는 D1 사본만 읽으므로 많이. */
const CRON_PENDING_LIMIT = 10;
const CRON_EMBEDDED_LIMIT = 100;
/**
 * 저장한 지 이 시간이 지나지 않은 행은 Cron 이 건너뛴다. 저장 직후 작업(waitUntil)은 응답 후 최대 30초까지만
 * 이어지므로, 그보다 넉넉하게 잡으면 두 작업이 같은 행을 동시에 처리하지 않는다.
 */
export const CRON_GRACE_MS = 60_000;

/**
 * 저장 직후 waitUntil 에서 부른다. pending 인 북마크 하나를 임베딩하고 인덱싱까지 진행한다.
 * pending 이 아닌 행은 건드리지 않는다(embedded 는 Cron 이 묶어서 처리한다).
 * 돌려주는 값은 처리 후 상태이며, 그 사이에 삭제된 경우 null.
 */
export async function processBookmark(env: Env, id: number): Promise<EmbedStatus | null> {
  const row = await getPipelineRow(env.DB, id);
  if (!row) return null;
  if (row.embed_status !== "pending" || row.embed_attempts >= MAX_EMBED_ATTEMPTS) return row.embed_status;

  const outcome = await embedOne(env, row);
  if (outcome === "failed") return "pending";
  if (outcome !== "skipped" && (await indexVectors(env, new Map([[id, outcome]]))).includes(id)) return "indexed";
  // 인덱싱이 실패했거나, 다른 작업이 먼저 처리했거나, 그 사이에 삭제됐다. 실제 상태를 다시 읽는다.
  return (await getPipelineRow(env.DB, id))?.embed_status ?? null;
}

/** Cron: pending 을 몇 개 임베딩하고, 기존 embedded 와 합쳐서 upsert 한 번으로 인덱싱한다. */
export async function processUnfinished(env: Env): Promise<{ indexed: number; embedded: number; failed: number }> {
  const createdBefore = Date.now() - CRON_GRACE_MS;

  // 1. embedded: AI 호출 없이 D1 의 벡터 사본을 읽는다 (Vectorize 재구축도 이 경로).
  const embeddedRows = await listUnfinished(env.DB, "embedded", MAX_EMBED_ATTEMPTS, createdBefore, CRON_EMBEDDED_LIMIT);
  const vectors = await loadVectors(env, embeddedRows.map((r) => r.id));

  // 2. pending: 하나씩 임베딩해서 같은 묶음에 더한다.
  const pendingRows = await listUnfinished(env.DB, "pending", MAX_EMBED_ATTEMPTS, createdBefore, CRON_PENDING_LIMIT);
  let embedded = 0;
  let failed = 0;
  for (const row of pendingRows) {
    const outcome = await embedOne(env, row);
    if (outcome === "failed") failed++;
    else if (outcome !== "skipped") {
      vectors.set(row.id, outcome);
      embedded++;
    }
  }

  // 3. 모두 합쳐서 한 번에 인덱싱한다.
  const indexed = await indexVectors(env, vectors);
  const summary = { indexed: indexed.length, embedded, failed };
  console.log("processUnfinished", summary);
  return summary;
}

/**
 * pending 행 하나를 임베딩하고 D1 에 사본을 저장한다(pending → embedded).
 * "skipped": 그 사이에 삭제됐거나 다른 작업이 먼저 처리해서 이 결과를 쓰지 않는다.
 */
async function embedOne(env: Env, row: PipelineRow): Promise<Float32Array | "failed" | "skipped"> {
  let vector: Float32Array;
  try {
    vector = await embed(env.AI, buildEmbeddingInput(row));
  } catch (err) {
    await fail(env, row.id, "pending", err);
    return "failed";
  }
  return (await markEmbedded(env.DB, row.id, vector, EMBED_MODEL)) ? vector : "skipped";
}

/**
 * 벡터들을 Vectorize 에 넣고 indexed 로 표시한다. 실제로 indexed 가 된 id 를 돌려준다.
 * upsert 하는 동안 삭제된 북마크는 벡터가 다시 들어가 버리므로, D1 에서 사라진 id 의 벡터는 곧바로 다시 지운다.
 */
async function indexVectors(env: Env, vectors: Map<number, Float32Array>): Promise<number[]> {
  const ids = [...vectors.keys()];
  if (ids.length === 0) return [];
  const store = createVectorizeStore(env.VECTORIZE);
  try {
    await store.upsert(ids.map((id) => ({ id, vector: vectors.get(id)! })));
  } catch (err) {
    await Promise.all(ids.map((id) => fail(env, id, "embedded", err)));
    return [];
  }

  const changed = await markIndexed(env.DB, ids);
  // 바뀌지 않은 id 는 (a) 다른 작업이 먼저 indexed 로 바꿨거나 (b) 그 사이에 삭제된 것이다. (b)만 지운다.
  const unchanged = ids.filter((id) => !changed.has(id));
  if (unchanged.length > 0) {
    const stillThere = await existingIds(env.DB, unchanged);
    const deleted = unchanged.filter((id) => !stillThere.has(id));
    if (deleted.length > 0) {
      try {
        await store.delete(deleted);
        console.log("removed vectors of bookmarks deleted during indexing", { ids: deleted });
      } catch (err) {
        console.error("failed to remove vectors of deleted bookmarks", { ids: deleted, err });
      }
    }
  }
  return ids.filter((id) => changed.has(id));
}

/** D1 에서 벡터 사본을 읽는다. embedded 인데 벡터가 없는 행은 실패로 기록해서 조용히 건너뛰지 않게 한다. */
async function loadVectors(env: Env, ids: number[]): Promise<Map<number, Float32Array>> {
  const vectors = await getEmbeddings(env.DB, ids);
  const missing = ids.filter((id) => !vectors.has(id));
  await Promise.all(missing.map((id) => fail(env, id, "embedded", new Error("embedded row has no stored vector"))));
  return vectors;
}

/** status: 실패가 일어난 단계. 그 사이에 행이 다음 단계로 넘어갔으면 recordFailure 가 아무것도 바꾸지 않는다. */
async function fail(env: Env, id: number, status: UnfinishedStatus, err: unknown): Promise<void> {
  const permanent = err instanceof EmptyInputError;
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  console.error("embedding pipeline failed", { id, status, permanent, message });
  await recordFailure(env.DB, id, status, message, MAX_EMBED_ATTEMPTS, permanent);
}
