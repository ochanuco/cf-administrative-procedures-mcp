#!/usr/bin/env bash
# 使い方: scripts/deploy.sh production
# D1 migration はここで適用しない。migration を含む変更は PR ごとに手で適用する。
# D1 のデータ（build:data / import:d1）もここでは扱わない。
set -euo pipefail

if [ "${1:-}" != "production" ]; then
  echo "usage: scripts/deploy.sh production" >&2
  exit 2
fi

pnpm exec wrangler deploy
