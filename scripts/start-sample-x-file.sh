#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SAMPLE_DIR="${X_FILE_SAMPLE_DIR:-${ROOT_DIR}/.x-file-sample}"
LIBRARY_ROOT="${X_FILE_SAMPLE_LIBRARY_ROOT:-${SAMPLE_DIR}/library}"
DATA_DIR="${X_FILE_SAMPLE_DATA_DIR:-${SAMPLE_DIR}/state}"
SERVER_STATE_PATH="${X_FILE_SAMPLE_SERVER_STATE_PATH:-${SAMPLE_DIR}/http-server-state.json}"

export X_FILE_DATA_DIR="$DATA_DIR"
export X_FILE_SERVER_STATE_PATH="$SERVER_STATE_PATH"
export X_FILE_SERVER_HOST="${X_FILE_SAMPLE_SERVER_HOST:-127.0.0.1}"
export X_FILE_SERVER_PORT="${X_FILE_SAMPLE_SERVER_PORT:-17341}"
export X_FILE_WEB_PORT="${X_FILE_SAMPLE_WEB_PORT:-17340}"
export X_FILE_NODE_SIDECAR_PROFILE="full"
export X_FILE_DEV_WATCH="0"

cd "$ROOT_DIR"

check_port_available() {
  node -e 'const net = require("node:net"); const port = Number(process.argv[1]); const server = net.createServer(); server.once("error", () => process.exit(1)); server.listen(port, "127.0.0.1", () => server.close(() => process.exit(0)));' "$1"
}

if ! check_port_available "$X_FILE_SERVER_PORT"; then
  echo "样例后端端口 ${X_FILE_SERVER_PORT} 已被占用。请先停止已有样例进程，或设置 X_FILE_SAMPLE_SERVER_PORT。" >&2
  exit 1
fi

if ! check_port_available "$X_FILE_WEB_PORT"; then
  echo "样例前端端口 ${X_FILE_WEB_PORT} 已被占用。请先停止已有样例进程，或设置 X_FILE_SAMPLE_WEB_PORT。" >&2
  exit 1
fi

node scripts/generate-sample-x-file-library.mjs \
  --sample-dir "$SAMPLE_DIR" \
  --library-root "$LIBRARY_ROOT" \
  --data-dir "$DATA_DIR"

children=()

cleanup() {
  local exit_code=$?
  trap - INT TERM EXIT
  for pid in "${children[@]}"; do
    stop_process_tree "$pid"
  done
  for pid in "${children[@]}"; do
    wait "$pid" 2>/dev/null || true
  done
  exit "$exit_code"
}

stop_process_tree() {
  local pid="$1"
  local child
  for child in $(pgrep -P "$pid" 2>/dev/null || true); do
    stop_process_tree "$child"
  done
  kill "$pid" 2>/dev/null || true
}

trap cleanup INT TERM EXIT

echo "样例 X-File 后端：http://${X_FILE_SERVER_HOST}:${X_FILE_SERVER_PORT}"
echo "样例 X-File 前端：http://127.0.0.1:${X_FILE_WEB_PORT}"
echo "样例文档库：${LIBRARY_ROOT}"
echo "独立状态目录：${DATA_DIR}"

pnpm --filter @x-file/server exec node --import tsx src/main.ts &
children+=("$!")

for _ in {1..60}; do
  if curl -fsS "http://127.0.0.1:${X_FILE_SERVER_PORT}/api/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done

if ! curl -fsS "http://127.0.0.1:${X_FILE_SERVER_PORT}/api/health" >/dev/null 2>&1; then
  echo "样例后端未能在预期时间内启动。" >&2
  exit 1
fi

X_FILE_SERVER_HOST="$X_FILE_SERVER_HOST" \
X_FILE_SERVER_PORT="$X_FILE_SERVER_PORT" \
X_FILE_WEB_PORT="$X_FILE_WEB_PORT" \
VITE_X_FILE_RUNTIME_MODE="mirror" \
VITE_X_FILE_API_BASE_URL="http://127.0.0.1:${X_FILE_SERVER_PORT}" \
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
