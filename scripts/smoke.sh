#!/usr/bin/env bash
# 2페이즈 API 흐름 검증.
# 임시 폴더에 새 로컬 D1 을 만들고 wrangler dev --local 을 띄워서, 명세 10절의 완료 기준을 요청으로 확인한다.
# 개발용 로컬 D1(.wrangler/state)은 건드리지 않으며, 끝나면 임시 폴더를 지운다.
# 사용법: npm run smoke
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-8798}"
source scripts/lib.sh

cleanup() { stop_dev; rm -rf "$STATE"; }
trap cleanup EXIT

# ── 준비: 임시 D1 + 경계 시각 데이터 ─────────────────────

echo "준비: 임시 D1 에 마이그레이션 적용"
migrate

# KST 2026-09-26 의 시작·끝과 그 1ms 바깥
read -r START END < <(node -e 'import("./src/time.ts").then(m => { const r = m.kstDayRange("2026-09-26"); console.log(r.start, r.end); })')
sql "
  INSERT INTO bookmarks (url, title, created_at) VALUES
    ('https://edge.test/before', '경계 before', $((START - 1))),
    ('https://edge.test/start',  '경계 start',  $START),
    ('https://edge.test/end',    '경계 end',    $END),
    ('https://edge.test/after',  '경계 after',  $((END + 1)));" > /dev/null

echo "준비: wrangler dev --local (포트 $PORT)"
start_dev local

# ── 인증 ───────────────────────────────────────────
echo "인증"
call GET /api/bookmarks "" "";            check "토큰 없으면 401" status_is 401
call GET /api/bookmarks "" "wrong-token"; check "틀린 토큰은 401" status_is 401

# ── 저장과 중복 ─────────────────────────────────────
echo "저장과 중복"
call POST /api/bookmarks '{"url":"https://Example.com","title":"  벡터를 저장한다 ","memo":"100% 확실"}'
check "정상 저장은 201" status_is 201
check "응답은 pending" js_true 'b.embed_status === "pending" && Number.isInteger(b.id)'
FIRST_ID="$(js 'b.id')"

call POST /api/bookmarks '{"url":"https://example.com/","title":"dup"}'
check "정규화 후 같은 URL 은 409" status_is 409
check "409 는 기존 id 를 돌려줌" js_true "b.error === 'duplicate' && b.id === $FIRST_ID"

call GET "/api/bookmarks/lookup?url=$(enc 'HTTPS://EXAMPLE.COM')"
check "lookup 은 정규화해서 찾음" js_true "b.found === true && b.item.id === $FIRST_ID"
call GET "/api/bookmarks/lookup?url=$(enc 'https://nothing.test')"
check "없는 URL 은 found=false" js_true 'b.found === false'

# ── 입력 검증 ───────────────────────────────────────
echo "입력 검증"
call POST /api/bookmarks '{"title":"no url"}';                  check "url 없으면 400" status_is 400
call POST /api/bookmarks '{"url":"javascript:alert(1)"}';       check "javascript: 는 400" status_is 400
call POST /api/bookmarks '{"url":"https://a.test","memo":123}'; check "문자열 아닌 필드는 400" status_is 400
call POST /api/bookmarks '{not json';                            check "깨진 JSON 은 400" status_is 400
node -e 'process.stdout.write(JSON.stringify({ url: "https://big.test", content: "x".repeat(100001) }))' > "$STATE/big.json"
call POST /api/bookmarks "@$STATE/big.json";                     check "너무 큰 본문은 413" status_is 413

# ── 길이 제한 ───────────────────────────────────────
echo "길이 제한"
node -e 'process.stdout.write(JSON.stringify({ url: "https://long.test", content: "가".repeat(3000), memo: "😀".repeat(2500) }))' > "$STATE/long.json"
call POST /api/bookmarks "@$STATE/long.json"
LONG_ID="$(js 'b.id')"
call GET "/api/bookmarks/$LONG_ID"
check "content 는 2,000자로 잘림" js_true '[...b.content].length === 2000'
check "memo 는 이모지를 깨뜨리지 않고 2,000자로 잘림" js_true '[...b.memo].length === 2000 && b.memo === "😀".repeat(2000)'
check "상세의 created_at 은 KST 문자열" js_true '/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+09:00$/.test(b.created_at)'

# ── 키워드 검색 ─────────────────────────────────────
echo "키워드 검색"
call POST /api/bookmarks '{"url":"https://b.test","title":"snake_case guide","memo":"1000 확실","content":"본문에만있는단어"}'
# 이스케이프하지 않으면 '_' 가 아무 글자와 일치해서 이 행까지 걸린다.
call POST /api/bookmarks '{"url":"https://c.test","title":"snakeXcase guide"}'
call GET "/api/bookmarks?q=$(enc '100%')"
check "'100%' 는 문자 그대로 찾음 (1000 제외)" js_true "b.items.length === 1 && b.items[0].id === $FIRST_ID"
call GET "/api/bookmarks?q=$(enc 'snake_case')"
check "'_' 도 문자 그대로 찾음 (snakeXcase 제외)" js_true 'b.items.length === 1 && b.items[0].title === "snake_case guide"'
call GET "/api/bookmarks?q=$(enc '본문에만있는단어')"
check "content 는 검색 대상이 아님" js_true 'b.items.length === 0'
call GET "/api/bookmarks?q=$(enc '벡터')"
check "title 에서 한국어 부분 일치" js_true "b.items.length === 1 && b.items[0].id === $FIRST_ID"
check "목록에는 embedding·content 가 없음" js_true 'b.items.every(i => !("embedding" in i) && !("content" in i))'
check "목록의 created_at 은 KST 문자열" js_true 'b.items.every(i => i.created_at.endsWith("+09:00"))'

# ── 날짜 범위 (KST) ─────────────────────────────────
echo "날짜 범위"
call GET "/api/bookmarks?q=$(enc '경계')&from=2026-09-26&to=2026-09-26"
check "KST 하루의 양 끝은 포함, 1ms 바깥은 제외" js_true 'b.items.map(i => i.title).join(",") === "경계 end,경계 start"'
check "UTC 09-25T15:00Z 는 KST 09-26 00:00" js_true 'b.items[1].created_at === "2026-09-26T00:00:00+09:00"'
call GET "/api/bookmarks?from=2026-09-27&to=2026-09-26"; check "from 이 to 보다 늦으면 400" status_is 400
call GET "/api/bookmarks?from=2026-02-30";                check "없는 날짜는 400" status_is 400

# ── 페이지 ─────────────────────────────────────────
echo "페이지"
call GET "/api/bookmarks?q=$(enc '경계')&limit=3"
check "다음 페이지가 있으면 next_offset" js_true 'b.items.length === 3 && b.next_offset === 3'
check "최신순 정렬" js_true 'b.items[0].title === "경계 after"'
call GET "/api/bookmarks?q=$(enc '경계')&limit=3&offset=3"
check "마지막 페이지는 next_offset=null" js_true 'b.items.length === 1 && b.next_offset === null'
call GET "/api/bookmarks?limit=0";   check "limit=0 은 400" status_is 400
call GET "/api/bookmarks?limit=101"; check "limit=101 은 400" status_is 400

# ── 삭제와 기타 경로 ─────────────────────────────────
echo "삭제와 기타"
call DELETE "/api/bookmarks/$FIRST_ID";  check "삭제는 204" status_is 204
call DELETE "/api/bookmarks/$FIRST_ID";  check "두 번째 삭제는 404" status_is 404
call GET "/api/bookmarks/$FIRST_ID";     check "삭제 후 상세는 404" status_is 404
call PUT /api/bookmarks '{}';            check "허용하지 않는 메서드는 405" status_is 405
call GET /api/nothing;                   check "없는 경로는 404" status_is 404
call GET /api/bookmarks/abc;             check "숫자가 아닌 id 는 404" status_is 404

summary
