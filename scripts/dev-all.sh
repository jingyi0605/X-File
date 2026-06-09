#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

export X_FILE_WEB_HOST="${X_FILE_WEB_HOST:-0.0.0.0}"
export X_FILE_WEB_PORT="${X_FILE_WEB_PORT:-17320}"
export X_FILE_SERVER_HOST="${X_FILE_SERVER_HOST:-0.0.0.0}"
export X_FILE_ALLOW_PUBLIC_HOST="${X_FILE_ALLOW_PUBLIC_HOST:-1}"
export X_FILE_SERVER_PORT="${X_FILE_SERVER_PORT:-17321}"
export X_FILE_SERVER_STATE_PATH="${X_FILE_SERVER_STATE_PATH:-${ROOT_DIR}/.x-file-dev/http-server-state.json}"
export VITE_X_FILE_API_BASE_URL="${VITE_X_FILE_API_BASE_URL:-}"

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

echo "启动 X-File 后端：http://${X_FILE_SERVER_HOST}:${X_FILE_SERVER_PORT}"
pnpm --filter @x-file/server dev &
children+=("$!")

echo "启动 X-File 前端：http://${X_FILE_WEB_HOST}:${X_FILE_WEB_PORT}"
echo "前端 /api/* 会代理到：http://127.0.0.1:${X_FILE_SERVER_PORT}"
pnpm --filter @x-file/web dev &
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
