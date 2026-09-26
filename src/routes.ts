// /api/* 요청 처리: 인증 → 경로·메서드 분기 → 입력 검증 → db.ts 호출 → 응답 변환.
// D1 을 직접 부르지 않고 db.ts 를 통해서만 접근한다.

import { isAuthorized } from "./auth.ts";
import { kstDayRange, toKst } from "./time.ts";
import {
  deleteBookmark,
  findByUrl,
  getBookmark,
  insertBookmark,
  searchBookmarks,
  type BookmarkInput,
  type BookmarkListItem,
} from "./db.ts";

/** 필드별 최대 길이 (코드 포인트 기준). url 은 자르지 않고 넘으면 거부한다. */
export const LIMITS = { url: 2048, title: 500, description: 1000, content: 2000, memo: 2000 } as const;
const MAX_BODY_CHARS = 100_000;
const MAX_QUERY_CHARS = 200;
const DEFAULT_PAGE = 20;
const MAX_PAGE = 100;

export async function handleApi(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!(await isAuthorized(request, env.API_TOKEN))) return error(401, "unauthorized");

  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, ""); // 끝의 / 는 무시
  const method = request.method;

  if (path === "/api/bookmarks") {
    if (method === "GET") return listBookmarks(env, url.searchParams);
    if (method === "POST") return createBookmark(env, request);
    return error(405, "method not allowed");
  }
  if (path === "/api/bookmarks/lookup") {
    if (method === "GET") return lookupBookmark(env, url.searchParams);
    return error(405, "method not allowed");
  }
  const idMatch = /^\/api\/bookmarks\/([1-9]\d{0,15})$/.exec(path);
  if (idMatch) {
    const id = Number(idMatch[1]);
    if (method === "GET") return showBookmark(env, id);
    if (method === "DELETE") return removeBookmark(env, id);
    return error(405, "method not allowed");
  }
  return error(404, "not found");
}

// ── 핸들러 ──────────────────────────────────────────

async function createBookmark(env: Env, request: Request): Promise<Response> {
  const text = await request.text();
  if (text.length > MAX_BODY_CHARS) return error(413, "request body too large");

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return error(400, "invalid json");
  }

  const input = validateBookmarkInput(body);
  if (!input.ok) return error(400, input.error);

  const result = await insertBookmark(env.DB, input.value, Date.now());
  if (!result.ok) return Response.json({ error: "duplicate", id: result.duplicateOf }, { status: 409 });
  // 3페이즈: 여기서 ctx.waitUntil 로 임베딩 파이프라인을 시작한다.
  return Response.json({ id: result.id, embed_status: "pending" }, { status: 201 });
}

async function lookupBookmark(env: Env, params: URLSearchParams): Promise<Response> {
  const raw = params.get("url");
  if (!raw) return error(400, "url is required");
  const normalized = normalizeUrl(raw);
  if (!normalized.ok) return error(400, normalized.error);

  const item = await findByUrl(env.DB, normalized.value);
  return Response.json(item ? { found: true, item: toSummary(item) } : { found: false });
}

async function listBookmarks(env: Env, params: URLSearchParams): Promise<Response> {
  const q = (params.get("q") ?? "").trim();
  if ([...q].length > MAX_QUERY_CHARS) return error(400, `q must be at most ${MAX_QUERY_CHARS} characters`);

  let from = 0;
  let to = Number.MAX_SAFE_INTEGER;
  const fromParam = params.get("from");
  const toParam = params.get("to");
  if (fromParam) {
    const r = kstDayRange(fromParam);
    if (!r) return error(400, "from must be YYYY-MM-DD");
    from = r.start;
  }
  if (toParam) {
    const r = kstDayRange(toParam);
    if (!r) return error(400, "to must be YYYY-MM-DD");
    to = r.end;
  }
  if (from > to) return error(400, "from must not be after to");

  const limit = parseIntParam(params.get("limit"), DEFAULT_PAGE, 1, MAX_PAGE);
  const offset = parseIntParam(params.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
  if (limit === null) return error(400, `limit must be an integer between 1 and ${MAX_PAGE}`);
  if (offset === null) return error(400, "offset must be a non-negative integer");

  // 1개 더 읽어서 다음 페이지가 있는지 판단한다.
  const rows = await searchBookmarks(env.DB, { q, from, to, limit: limit + 1, offset });
  const hasMore = rows.length > limit;
  return Response.json({
    items: rows.slice(0, limit).map(toSummary),
    next_offset: hasMore ? offset + limit : null,
  });
}

async function showBookmark(env: Env, id: number): Promise<Response> {
  const row = await getBookmark(env.DB, id);
  if (!row) return error(404, "not found");
  return Response.json({ ...row, created_at: toKst(row.created_at) });
}

async function removeBookmark(env: Env, id: number): Promise<Response> {
  const deleted = await deleteBookmark(env.DB, id);
  // 3페이즈: D1 삭제 후 Vectorize 에서도 지운다.
  return deleted ? new Response(null, { status: 204 }) : error(404, "not found");
}

// ── 검증·변환 (순수 함수, 단위 테스트 대상) ──────────────

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

/** POST 본문을 검사해서 저장 가능한 BookmarkInput 으로 만든다. */
export function validateBookmarkInput(body: unknown): Result<BookmarkInput> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, error: "body must be a JSON object" };
  }
  const b = body as Record<string, unknown>;

  const fields = ["url", "title", "description", "content", "memo"] as const;
  for (const f of fields) {
    if (b[f] !== undefined && typeof b[f] !== "string") return { ok: false, error: `${f} must be a string` };
  }

  if (!b.url) return { ok: false, error: "url is required" };
  const url = normalizeUrl(b.url as string);
  if (!url.ok) return url;

  const text = (f: "title" | "description" | "content" | "memo") =>
    truncate(((b[f] as string | undefined) ?? "").trim(), LIMITS[f]);

  return {
    ok: true,
    value: { url: url.value, title: text("title"), description: text("description"), content: text("content"), memo: text("memo") },
  };
}

/**
 * 저장과 중복 확인이 반드시 같은 규칙을 쓰도록 URL 정규화를 한곳에 둔다.
 * new URL() 은 스킴·호스트를 소문자로 바꾸고, 루트 경로에 / 를 붙인다.
 */
export function normalizeUrl(raw: string): Result<string> {
  const trimmed = raw.trim();
  if ([...trimmed].length > LIMITS.url) return { ok: false, error: `url must be at most ${LIMITS.url} characters` };

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, error: "url is invalid" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: "url must start with http:// or https://" };
  }
  return { ok: true, value: parsed.href };
}

/** 코드 포인트 단위로 자른다. slice() 는 UTF-16 단위라서 이모지를 반으로 자를 수 있다. */
export function truncate(s: string, max: number): string {
  const chars = [...s];
  return chars.length <= max ? s : chars.slice(0, max).join("");
}

function toSummary(item: BookmarkListItem) {
  return { ...item, created_at: toKst(item.created_at) };
}

/** 비어 있으면 fallback, 범위를 벗어나거나 정수가 아니면 null */
function parseIntParam(raw: string | null, fallback: number, min: number, max: number): number | null {
  if (raw === null || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return n >= min && n <= max ? n : null;
}

function error(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}
