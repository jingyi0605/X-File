#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

children=()

cleanup() {
  local exit_code=$?
  trap - INT TERM EXIT
  if ((${#children[@]} > 0)); then
    echo "停止 X-File 调试进程..."
    kill "${children[@]}" 2>/dev/null || true
    wait "${children[@]}" 2>/dev/null || true
  fi
  exit "$exit_code"
}

trap cleanup INT TERM EXIT

bash scripts/dev-server.sh &
children+=("$!")

bash scripts/dev-web.sh &
children+=("$!")

while true; do
  for pid in "${children[@]}"; do
    if ! kill -0 "$pid" 2>/dev/null; then
      wait "$pid"
      exit $?
    fi
  done
  sleep 1
done
