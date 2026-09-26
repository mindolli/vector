#!/usr/bin/env bash
# 운영 배포: npm run deploy
# wrangler 는 없는 환경(--env production)을 지정해도 경고만 출력하고 최상위(개발용) 설정으로 배포를 계속한다.
# 그래서 먼저 dry-run 으로 wrangler 가 env.production 을 찾는지 확인하고, 못 찾으면 배포하지 않는다.
set -euo pipefail
cd "$(dirname "$0")/.."

DRY="$(npx wrangler deploy --env production --dry-run 2>&1 | sed 's/\x1b\[[0-9;]*m//g')"
if grep -q 'No environment found in configuration with name "production"' <<< "$DRY"; then
  echo "배포 중단: wrangler.jsonc 에 env.production 이 없습니다."
  echo "지금 배포하면 개발용 자원(bookmarks-dev, 임시 D1 ID)에 묶인 Worker 가 만들어집니다."
  echo "5페이즈에서 env.production 을 추가한 뒤 다시 실행하세요."
  exit 1
fi

echo "배포 전 검사: 타입 검사와 단위 테스트"
npm run typecheck
npm test

echo "운영 배포: wrangler deploy --env production"
npx wrangler deploy --env production
