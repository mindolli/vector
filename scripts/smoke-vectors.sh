#!/usr/bin/env bash
# 3페이즈 벡터 파이프라인 검증 (원격 Workers AI + 개발용 Vectorize 인덱스 bookmarks-dev 사용).
# 임시 폴더의 새 D1 하나를 공유하면서 Worker 를 세 번 띄운다.
#   A. --local (원격 AI 꺼짐): 일시적 실패와 영구 실패(빈 입력)를 만든다
#   B. 원격: 전이, Cron 회복, BLOB, 유사 조회, 삭제된 id 버리기
#   C. 원격: SQL 한 줄 재구축 → AI 호출 없이 다시 indexed
# 끝나면 API 로 북마크를 지우고, 이번에 만든 id 의 벡터를 인덱스에서 한 번 더 지운다.
# 사용법: npm run smoke:vectors   (wrangler login 필요, 4~5분 걸릴 수 있음)
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-8795}"
BASE="http://localhost:$PORT"
INDEX="bookmarks-dev"
CRON_URL="$BASE/__scheduled?cron=0+*+*+*+*"
STATE="$(mktemp -d)"
RESP="$STATE/resp.json"
LOG=""
DEV_PID=""
CREATED=()
PASS=0
FAIL=0

TOKEN="$(grep '^API_TOKEN=' .dev.vars | cut -d= -f2-)"
[[ -n "$TOKEN" ]] || { echo ".dev.vars 에 API_TOKEN 이 없습니다"; exit 1; }

# ── 도우미 ─────────────────────────────────────────

call() {
  local method="$1" path="$2" body="${3-}"
  local args=(-s -o "$RESP" -w '%{http_code}' -X "$method" -H "Authorization: Bearer $TOKEN")
  [[ -n "$body" ]] && args+=(-H 'Content-Type: application/json' --data-binary "$body")
  STATUS="$(curl "${args[@]}" "$BASE$path")"
}
js() { node -e "const b=JSON.parse(require('fs').readFileSync(0,'utf8')); process.stdout.write(String($1))" < "$RESP"; }
check() {
  local name="$1"; shift
  if "$@"; then PASS=$((PASS + 1)); echo "  PASS  $name"
  else FAIL=$((FAIL + 1)); echo "  FAIL  $name  (status=${STATUS-} body=$(head -c 300 "$RESP" 2>/dev/null))"; fi
}
js_true() { [[ "$(js "$1")" == "true" ]]; }

start_dev() { # start_dev local|remote
  LOG="$STATE/dev-$1-$(date +%s).log"
  local flags=(--port "$PORT" --persist-to "$STATE" --test-scheduled)
  [[ "$1" == "local" ]] && flags+=(--local)
  npx wrangler dev "${flags[@]}" > "$LOG" 2>&1 &
  DEV_PID=$!
  for _ in $(seq 1 90); do curl -s -o /dev/null "$BASE/" && return 0; sleep 0.5; done
  echo "서버가 뜨지 않았습니다:"; cat "$LOG"; exit 1
}
stop_dev() {
  [[ -n "$DEV_PID" ]] && kill "$DEV_PID" 2>/dev/null || true
  pkill -f "persist-to $STATE" 2>/dev/null || true
  DEV_PID=""
  sleep 1
}
run_cron() { curl -s -o /dev/null "$CRON_URL"; sleep 2; }
sql() { npx wrangler d1 execute vector-bookmarks --local --persist-to "$STATE" --json --command "$1" 2>/dev/null; }

save() { # save JSON → 새 id 를 SAVED 에 담는다
  call POST /api/bookmarks "$1"
  SAVED="$(js 'b.id')"
  CREATED+=("$SAVED")
}
detail() { call GET "/api/bookmarks/$1"; }
wait_status() { # wait_status id status 초
  local end=$((SECONDS + $3))
  while (( SECONDS < end )); do
    detail "$1"; [[ "$(js 'b.embed_status')" == "$2" ]] && return 0; sleep 2
  done
  return 1
}

cleanup() {
  set +e
  stop_dev
  if ((${#CREATED[@]})); then
    npx wrangler vectorize delete-vectors "$INDEX" --ids "${CREATED[@]}" > /dev/null 2>&1 \
      && echo "정리: $INDEX 에서 벡터 ${#CREATED[@]}개 삭제 요청 (id ${CREATED[*]})"
  fi
  rm -rf "$STATE"
}
trap cleanup EXIT

echo "준비: 임시 D1 에 마이그레이션 적용"
npx wrangler d1 migrations apply vector-bookmarks --local --persist-to "$STATE" > /dev/null 2>&1

# ── A. 원격 AI 없이: 실패 기록 ─────────────────────────
echo "A. --local (원격 AI 꺼짐)"
start_dev local
save '{"url":"https://smoke.test/transient","title":"Cloudflare Workers에서 벡터 검색 구현하기","memo":"일시적 실패 후 회복"}'
TRANSIENT="$SAVED"
save '{"url":"https://smoke.test/empty"}'
EMPTY="$SAVED"
sleep 3
detail "$TRANSIENT"; check "AI 호출 실패: pending 유지, attempts=1, 오류 기록" js_true 'b.embed_status==="pending" && b.embed_attempts===1 && !!b.embed_error'
detail "$EMPTY";     check "빈 입력: 곧바로 attempts=5 (영구 실패)" js_true 'b.embed_status==="pending" && b.embed_attempts===5 && b.embed_error.includes("EmptyInputError")'
run_cron
detail "$TRANSIENT"; check "Cron 재시도도 실패하면 attempts=2" js_true 'b.embed_attempts===2'
detail "$EMPTY";     check "한도에 닿은 항목은 Cron 이 다시 시도하지 않음" js_true 'b.embed_attempts===5'
stop_dev

# ── B. 원격: 전이, 회복, 유사 조회 ──────────────────────
echo "B. 원격 (Workers AI + $INDEX)"
start_dev remote
save '{"url":"https://smoke.test/ko-vector","title":"Cloudflare Workers에서 벡터 유사도 검색을 구현하는 방법"}'
KO="$SAVED"
save '{"url":"https://smoke.test/en-vector","title":"How to build vector similarity search on Cloudflare Workers"}'
EN="$SAVED"
save '{"url":"https://smoke.test/stew","title":"김치찌개를 맛있게 끓이는 법"}'
STEW="$SAVED"
for id in "$KO" "$EN" "$STEW"; do
  wait_status "$id" indexed 30 || true   # Cron 없이 저장 직후 waitUntil 만으로 진행되어야 한다
  check "id $id: Cron 없이 indexed, attempts=0, model=bge-m3" js_true 'b.embed_status==="indexed" && b.embed_attempts===0 && b.embed_model==="@cf/baai/bge-m3"'
done

run_cron
detail "$TRANSIENT"; check "Cron 이 일시적 실패를 회복: indexed, 오류 지움" js_true 'b.embed_status==="indexed" && b.embed_attempts===0 && b.embed_error===null'
detail "$EMPTY";     check "빈 입력은 여전히 pending, attempts=5" js_true 'b.embed_status==="pending" && b.embed_attempts===5'
grep -q "processUnfinished" "$LOG" && echo "     Cron 로그: $(sed 's/\x1b\[[0-9;]*m//g' "$LOG" | grep processUnfinished | tail -1 | sed 's/^ *//')"

echo "     유사 조회가 반영되기를 기다리는 중 (최대 180초)"
t0=$SECONDS
while (( SECONDS - t0 < 180 )); do
  call GET "/api/bookmarks/$KO/similar?k=5"
  [[ "$(js 'b.items.length >= 3')" == "true" ]] && break
  sleep 5
done
echo "     반영까지 약 $((SECONDS - t0))초, 결과: $(js 'JSON.stringify(b.items.map(i => [i.id, +i.score.toFixed(3)]))')"
check "유사 조회: 자기 자신은 없음" js_true "b.items.length > 0 && b.items.every(i => i.id !== $KO)"
check "유사 조회: 1등은 같은 주제의 영어 문장" js_true "b.items[0]?.id === $EN"
check "유사 조회: 점수 내림차순" js_true 'b.items.every((m, i, a) => i === 0 || a[i-1].score >= m.score)'
check "유사 조회: created_at 은 KST 문자열" js_true 'b.items.every(i => i.created_at.endsWith("+09:00"))'

call DELETE "/api/bookmarks/$STEW"; check "삭제는 204" [ "$STATUS" == 204 ]
call GET "/api/bookmarks/$KO/similar?k=5"
check "삭제 직후 유사 조회에 삭제된 id 가 없음 (벡터가 아직 남아 있어도 D1 기준으로 버림)" js_true "b.items.every(i => i.id !== $STEW)"
call GET "/api/bookmarks/$EMPTY/similar"; check "indexed 가 아닌 북마크의 유사 조회는 빈 결과와 상태" js_true 'b.status==="pending" && b.items.length===0'
call GET "/api/bookmarks/$KO/similar?k=21"; check "k=21 은 400" [ "$STATUS" == 400 ]
stop_dev

BYTES="$(sql "SELECT COUNT(*) AS n FROM bookmarks WHERE embedding IS NOT NULL AND (length(embedding) != 4096 OR typeof(embedding) != 'blob')" | node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(0,"utf8"))[0].results[0].n))')"
check "D1 의 모든 벡터가 4,096 bytes BLOB" [ "$BYTES" == 0 ]

# ── C. 재구축: AI 호출 없이 ───────────────────────────
echo "C. 재구축 (SQL 한 줄 → Cron)"
sql "UPDATE bookmarks SET embed_status = 'embedded' WHERE embed_status = 'indexed'" > /dev/null
start_dev remote
run_cron
SUMMARY="$(sed 's/\x1b\[[0-9;]*m//g' "$LOG" | grep processUnfinished | tail -1 | sed 's/^ *//')"
echo "     Cron 로그: $SUMMARY"
check "재구축 Cron 은 AI 를 부르지 않음 (embedded: 0) 그리고 3개를 다시 인덱싱" bash -c "[[ '$SUMMARY' == *'indexed: 3'* && '$SUMMARY' == *'embedded: 0'* ]]"
for id in "$TRANSIENT" "$KO" "$EN"; do
  detail "$id"; check "  id $id: 다시 indexed" js_true 'b.embed_status==="indexed"'
done

echo "정리: API 로 북마크 삭제"
for id in "${CREATED[@]}"; do call DELETE "/api/bookmarks/$id"; done

echo
echo "결과: PASS $PASS, FAIL $FAIL"
[[ "$FAIL" -eq 0 ]]
