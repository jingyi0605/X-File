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
export X_FILE_SAMPLE_WEB_PORT="${X_FILE_SAMPLE_WEB_PORT:-17340}"
export X_FILE_WEB_PORT="$X_FILE_SAMPLE_WEB_PORT"
export X_FILE_NODE_SIDECAR_PROFILE="full"
unset VITE_X_FILE_RUNTIME_MODE
unset VITE_X_FILE_API_BASE_URL

cd "$ROOT_DIR"

check_port_available() {
  node -e 'const net = require("node:net"); const port = Number(process.argv[1]); const server = net.createServer(); server.once("error", () => process.exit(1)); server.listen(port, "127.0.0.1", () => server.close(() => process.exit(0)));' "$1"
}

if ! check_port_available "$X_FILE_WEB_PORT"; then
  echo "样例桌面端前端端口 ${X_FILE_WEB_PORT} 已被占用。请先停止已有样例进程，或设置 X_FILE_SAMPLE_WEB_PORT。" >&2
  exit 1
fi

node scripts/generate-sample-x-file-library.mjs \
  --sample-dir "$SAMPLE_DIR" \
  --library-root "$LIBRARY_ROOT" \
  --data-dir "$DATA_DIR"

echo "启动独立 X-File 桌面客户端"
echo "样例文档库：${LIBRARY_ROOT}"
echo "独立状态目录：${DATA_DIR}"
echo "桌面开发前端端口：${X_FILE_WEB_PORT}"
echo "独立 HTTP 状态文件：${SERVER_STATE_PATH}"

exec pnpm --filter @x-file/desktop tauri:dev \
  --config "$ROOT_DIR/apps/desktop/src-tauri/tauri.sample.conf.json" \
  --no-watch
