#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

export X_FILE_SERVER_HOST="${X_FILE_SERVER_HOST:-0.0.0.0}"
export X_FILE_SERVER_PORT="${X_FILE_SERVER_PORT:-17321}"
export X_FILE_ALLOW_PUBLIC_HOST="${X_FILE_ALLOW_PUBLIC_HOST:-1}"
export X_FILE_SERVER_STATE_PATH="${X_FILE_SERVER_STATE_PATH:-${ROOT_DIR}/.x-file-dev/http-server-state.json}"

echo "启动 X-File 后端：http://${X_FILE_SERVER_HOST}:${X_FILE_SERVER_PORT}"
echo "后端状态文件：${X_FILE_SERVER_STATE_PATH}"

exec pnpm --filter @x-file/server dev
