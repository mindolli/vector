# smoke 스크립트 공통 도우미. 저장소 루트에서 PORT 를 정한 뒤 불러온다.
#   PORT="${PORT:-8798}"; source scripts/lib.sh
# 불러오면 임시 D1 폴더(STATE)를 만들고 .dev.vars 의 토큰을 읽는다.
# 정리는 각 스크립트의 cleanup 에서 stop_dev 와 rm -rf "$STATE" 로 한다.

BASE="http://localhost:$PORT"
STATE="$(mktemp -d)"
RESP="$STATE/resp.json"
LOG=""
DEV_PID=""
STATUS=""
PASS=0
FAIL=0

TOKEN="$(grep '^API_TOKEN=' .dev.vars 2>/dev/null | cut -d= -f2- || true)"
[[ -n "$TOKEN" ]] || { echo ".dev.vars 에 API_TOKEN 이 없습니다 (.dev.vars.example 참고)"; exit 1; }

# ── 요청과 판정 ─────────────────────────────────────

# call METHOD PATH [BODY] [TOKEN]   BODY 가 @로 시작하면 파일에서 읽는다. TOKEN 에 "" 를 주면 인증 헤더 없음.
call() {
  local method="$1" path="$2" body="${3-}" auth="${4-$TOKEN}"
  local args=(-s -o "$RESP" -w '%{http_code}' -X "$method")
  [[ -n "$auth" ]] && args+=(-H "Authorization: Bearer $auth")
  [[ -n "$body" ]] && args+=(-H 'Content-Type: application/json' --data-binary "$body")
  STATUS="$(curl "${args[@]}" "$BASE$path")"
}

# js '표현식'   마지막 응답 JSON 을 b 로 두고 표현식을 평가한다.
js() { node -e "const b=JSON.parse(require('fs').readFileSync(0,'utf8')); process.stdout.write(String($1))" < "$RESP"; }

enc() { node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$1"; }

# check "이름" 명령...   명령이 성공하면 PASS, 실패하면 FAIL 과 마지막 응답을 출력한다.
check() {
  local name="$1"; shift
  if "$@"; then PASS=$((PASS + 1)); echo "  PASS  $name"
  else FAIL=$((FAIL + 1)); echo "  FAIL  $name  (status=$STATUS body=$(head -c 300 "$RESP" 2>/dev/null))"; fi
}
status_is() { [[ "$STATUS" == "$1" ]]; }
js_true() { [[ "$(js "$1")" == "true" ]]; }

# 마지막 줄에서 호출한다. 실패가 하나라도 있으면 종료 코드 1.
summary() {
  echo
  echo "결과: PASS $PASS, FAIL $FAIL"
  [[ "$FAIL" -eq 0 ]]
}

# ── 임시 D1 과 Worker ───────────────────────────────

migrate() { npx wrangler d1 migrations apply vector-bookmarks --local --persist-to "$STATE" > "$STATE/migrate.log" 2>&1; }
sql() { npx wrangler d1 execute vector-bookmarks --local --persist-to "$STATE" --json --command "$1" 2>/dev/null; }

# start_dev local|remote   local 은 원격 바인딩(AI, Vectorize)을 끈다. Cron 은 /__scheduled 로 직접 실행한다.
start_dev() {
  LOG="$STATE/dev-$1-$(date +%s).log"
  local flags=(--port "$PORT" --persist-to "$STATE" --test-scheduled)
  [[ "$1" == "local" ]] && flags+=(--local)
  npx wrangler dev "${flags[@]}" > "$LOG" 2>&1 &
  DEV_PID=$!
  for _ in $(seq 1 90); do curl -s -o /dev/null "$BASE/" && return 0; sleep 0.5; done
  echo "서버가 뜨지 않았습니다:"; cat "$LOG"; exit 1
}

stop_dev() {
  if [[ -n "$DEV_PID" ]]; then
    kill "$DEV_PID" 2>/dev/null || true
    wait "$DEV_PID" 2>/dev/null || true # 종료한 작업을 거둬들여서 "Terminated" 메시지가 나오지 않게 한다
  fi
  pkill -f "persist-to $STATE" 2>/dev/null || true
  DEV_PID=""
  sleep 1
}
