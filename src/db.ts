// D1 쿼리 모음. 다른 파일은 SQL 을 직접 쓰지 않는다.
// 입력 검증(길이 제한 등)은 routes.ts 가 끝낸 뒤 이곳으로 넘긴다.

export type EmbedStatus = "pending" | "embedded" | "indexed";

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
