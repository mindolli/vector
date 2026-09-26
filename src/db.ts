// D1 쿼리 모음. 다른 파일은 SQL 을 직접 쓰지 않는다.
// 입력 검증(길이 제한 등)은 routes.ts 가 끝낸 뒤 이곳으로 넘긴다.

export type EmbedStatus = "pending" | "embedded" | "indexed";
/** 아직 처리가 남은 상태. 파이프라인이 실패를 기록하거나 Cron 이 다시 집어 가는 대상이다. */
export type UnfinishedStatus = Exclude<EmbedStatus, "indexed">;

/** 클라이언트가 보내는 값 (POST /api/bookmarks 본문) */
export type BookmarkInput = {
  url: string;
  title: string;
  description: string;
  content: string;
  memo: string;
};

/** D1 행 전체. 4KB 짜리 embedding 은 필요할 때만 따로 읽으므로 제외한다. */
export type BookmarkRow = BookmarkInput & {
  id: number;
  created_at: number; // Unix ms
  embed_status: EmbedStatus;
  embed_model: string | null;
  embed_attempts: number;
  embed_error: string | null;
};

/** 목록·검색 결과의 한 항목 */
export type BookmarkListItem = Pick<BookmarkRow, "id" | "url" | "title" | "memo" | "created_at" | "embed_status">;

const LIST_COLUMNS = "id, url, title, memo, created_at, embed_status";
const ROW_COLUMNS =
  "id, url, title, description, memo, content, created_at, embed_status, embed_model, embed_attempts, embed_error";

export type InsertResult = { ok: true; id: number } | { ok: false; duplicateOf: number };

/** 새 북마크를 저장한다. 같은 URL 이 이미 있으면 저장하지 않고 기존 ID 를 돌려준다. */
export async function insertBookmark(db: D1Database, input: BookmarkInput, now: number): Promise<InsertResult> {
  // 충돌하면 아무 행도 돌려주지 않으므로, UNIQUE 오류 메시지를 해석할 필요가 없다.
  const inserted = await db
    .prepare(
      `INSERT INTO bookmarks (url, title, description, memo, content, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT (url) DO NOTHING
       RETURNING id`,
    )
    .bind(input.url, input.title, input.description, input.memo, input.content, now)
    .first<{ id: number }>();
  if (inserted) return { ok: true, id: inserted.id };

  const existing = await findByUrl(db, input.url);
  if (!existing) throw new Error(`insert conflicted but no row found for url: ${input.url}`);
  return { ok: false, duplicateOf: existing.id };
}

export async function findByUrl(db: D1Database, url: string): Promise<BookmarkListItem | null> {
  return db.prepare(`SELECT ${LIST_COLUMNS} FROM bookmarks WHERE url = ?1`).bind(url).first<BookmarkListItem>();
}

export type SearchParams = {
  q: string; // 빈 문자열이면 키워드 조건 없이 최신순
  from: number; // created_at 하한 (포함)
  to: number; // created_at 상한 (포함)
  limit: number;
  offset: number;
};

/** 키워드 검색 + 날짜 범위. content 는 검색 대상이 아니다. */
export async function searchBookmarks(db: D1Database, p: SearchParams): Promise<BookmarkListItem[]> {
  const keyword = p.q === "" ? "" : `(title LIKE ?5 ESCAPE '\\' OR memo LIKE ?5 ESCAPE '\\' OR description LIKE ?5 ESCAPE '\\') AND`;
  const sql = `SELECT ${LIST_COLUMNS} FROM bookmarks
    WHERE ${keyword} created_at BETWEEN ?1 AND ?2
    ORDER BY created_at DESC, id DESC
    LIMIT ?3 OFFSET ?4`;

  const params: unknown[] = [p.from, p.to, p.limit, p.offset];
  if (p.q !== "") params.push(escapeLike(p.q));

  const { results } = await db.prepare(sql).bind(...params).all<BookmarkListItem>();
  return results;
}

export async function getBookmark(db: D1Database, id: number): Promise<BookmarkRow | null> {
  return db.prepare(`SELECT ${ROW_COLUMNS} FROM bookmarks WHERE id = ?1`).bind(id).first<BookmarkRow>();
}

/** 실제로 지운 행이 있으면 true */
export async function deleteBookmark(db: D1Database, id: number): Promise<boolean> {
  const { meta } = await db.prepare(`DELETE FROM bookmarks WHERE id = ?1`).bind(id).run();
  return meta.changes > 0;
}

/** LIKE 패턴용: \ % _ 를 문자 그대로 찾도록 이스케이프하고 앞뒤에 % 를 붙인다. (ESCAPE '\' 와 짝) */
export function escapeLike(q: string): string {
  return `%${q.replace(/[\\%_]/g, "\\$&")}%`;
}

// ── 임베딩 파이프라인용 (정책은 pipeline.ts 가 정한다) ─────────────

/** 파이프라인이 한 행을 처리할 때 필요한 컬럼 */
export type PipelineRow = Pick<
  BookmarkRow,
  "id" | "title" | "memo" | "description" | "content" | "embed_status" | "embed_attempts"
>;
const PIPELINE_COLUMNS = "id, title, memo, description, content, embed_status, embed_attempts";

export async function getPipelineRow(db: D1Database, id: number): Promise<PipelineRow | null> {
  return db.prepare(`SELECT ${PIPELINE_COLUMNS} FROM bookmarks WHERE id = ?1`).bind(id).first<PipelineRow>();
}

/**
 * 아직 indexed 가 아니고 재시도 한도에 닿지 않은 행. 부분 인덱스(idx_bookmarks_unfinished)를 탄다.
 * createdBefore 보다 나중에 저장된 행은 저장 직후 작업(waitUntil)이 처리 중일 수 있으므로 뺀다.
 */
export async function listUnfinished(
  db: D1Database,
  status: UnfinishedStatus,
  maxAttempts: number,
  createdBefore: number,
  limit: number,
): Promise<PipelineRow[]> {
  const { results } = await db
    .prepare(
      `SELECT ${PIPELINE_COLUMNS} FROM bookmarks
       WHERE embed_status != 'indexed' AND embed_status = ?1 AND embed_attempts < ?2 AND created_at < ?3
       ORDER BY id LIMIT ?4`,
    )
    .bind(status, maxAttempts, createdBefore, limit)
    .all<PipelineRow>();
  return results;
}

/**
 * pending → embedded. 벡터를 BLOB(Float32 리틀 엔디언 4,096 bytes)으로 저장한다.
 * 그 사이에 삭제됐거나 다른 작업이 먼저 처리했으면 false.
 */
export async function markEmbedded(db: D1Database, id: number, vector: Float32Array, model: string): Promise<boolean> {
  const { meta } = await db
    .prepare(
      `UPDATE bookmarks
       SET embedding = ?2, embed_model = ?3, embed_status = 'embedded', embed_attempts = 0, embed_error = NULL
       WHERE id = ?1 AND embed_status = 'pending'`,
    )
    .bind(id, float32ToBlob(vector), model)
    .run();
  return meta.changes > 0;
}

/** embedded → indexed (여러 행을 한 번에). 실제로 바뀐 id 만 돌려준다. */
export async function markIndexed(db: D1Database, ids: number[]): Promise<Set<number>> {
  if (ids.length === 0) return new Set();
  const { results } = await db
    .prepare(
      `UPDATE bookmarks SET embed_status = 'indexed', embed_attempts = 0, embed_error = NULL
       WHERE embed_status = 'embedded' AND id IN (${placeholders(ids.length)})
       RETURNING id`,
    )
    .bind(...ids)
    .all<{ id: number }>();
  return new Set(results.map((r) => r.id));
}

/** ids 가운데 D1 에 아직 남아 있는 것 */
export async function existingIds(db: D1Database, ids: number[]): Promise<Set<number>> {
  if (ids.length === 0) return new Set();
  const { results } = await db
    .prepare(`SELECT id FROM bookmarks WHERE id IN (${placeholders(ids.length)})`)
    .bind(...ids)
    .all<{ id: number }>();
  return new Set(results.map((r) => r.id));
}

/**
 * 실패를 기록한다. permanent 이면 곧바로 재시도 한도까지 올려서 Cron 이 다시 시도하지 않게 한다.
 * status 는 실패가 일어난 단계의 상태다. 그 사이에 다른 작업이 행을 다음 단계로 옮겼으면 기록하지 않는다.
 */
export async function recordFailure(
  db: D1Database,
  id: number,
  status: UnfinishedStatus,
  message: string,
  maxAttempts: number,
  permanent: boolean,
): Promise<void> {
  await db
    .prepare(
      `UPDATE bookmarks
       SET embed_attempts = CASE WHEN ?4 THEN ?5 ELSE MIN(embed_attempts + 1, ?5) END, embed_error = ?3
       WHERE id = ?1 AND embed_status = ?2`,
    )
    .bind(id, status, message.slice(0, 500), permanent ? 1 : 0, maxAttempts)
    .run();
}

/** D1 에 저장된 벡터 사본을 읽는다. 벡터가 없는 행은 결과에서 빠진다. */
export async function getEmbeddings(db: D1Database, ids: number[]): Promise<Map<number, Float32Array>> {
  const out = new Map<number, Float32Array>();
  if (ids.length === 0) return out;
  const { results } = await db
    .prepare(`SELECT id, embedding FROM bookmarks WHERE embedding IS NOT NULL AND id IN (${placeholders(ids.length)})`)
    .bind(...ids)
    .all<{ id: number; embedding: unknown }>();
  for (const r of results) out.set(r.id, blobToFloat32(r.embedding));
  return out;
}

/** 여러 id 의 목록 항목. 없는 id 는 결과에 없다(순서는 보장하지 않음). */
export async function getByIds(db: D1Database, ids: number[]): Promise<BookmarkListItem[]> {
  if (ids.length === 0) return [];
  const { results } = await db
    .prepare(`SELECT ${LIST_COLUMNS} FROM bookmarks WHERE id IN (${placeholders(ids.length)})`)
    .bind(...ids)
    .all<BookmarkListItem>();
  return results;
}

// ── BLOB ↔ Float32Array ─────────────────────────────

/** Float32Array 가 가리키는 바이트만 잘라서 ArrayBuffer 로 넘긴다 (더 큰 버퍼의 일부일 수 있으므로). */
export function float32ToBlob(v: Float32Array): ArrayBuffer {
  return v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer;
}

/** D1 이 돌려준 BLOB 을 Float32Array 로 복원한다. ArrayBuffer, 바이트 배열 뷰, 숫자 배열을 모두 받는다. */
export function blobToFloat32(value: unknown): Float32Array {
  let bytes: Uint8Array;
  if (value instanceof ArrayBuffer) bytes = new Uint8Array(value);
  else if (ArrayBuffer.isView(value)) bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  else if (Array.isArray(value)) bytes = Uint8Array.from(value as number[]);
  else throw new Error(`unexpected BLOB type: ${Object.prototype.toString.call(value)}`);
  if (bytes.byteLength % 4 !== 0) throw new Error(`BLOB length ${bytes.byteLength} is not a multiple of 4`);
  // 새 버퍼로 복사해서 4바이트 정렬을 보장한다.
  return new Float32Array(bytes.slice().buffer);
}

function placeholders(n: number): string {
  return Array.from({ length: n }, (_, i) => `?${i + 1}`).join(", ");
}
