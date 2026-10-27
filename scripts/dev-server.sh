#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

export X_FILE_ALLOW_PUBLIC_HOST="${X_FILE_ALLOW_PUBLIC_HOST:-1}"
export X_FILE_SERVER_STATE_PATH="${X_FILE_SERVER_STATE_PATH:-${ROOT_DIR}/.x-file-dev/http-server-state.json}"
export X_FILE_NODE_SIDECAR_PROFILE="${X_FILE_NODE_SIDECAR_PROFILE:-full}"

echo "启动 X-File 后端，监听配置从 ${X_FILE_SERVER_STATE_PATH} 读取"
echo "后端状态文件：${X_FILE_SERVER_STATE_PATH}"
echo "Node sidecar profile：${X_FILE_NODE_SIDECAR_PROFILE}"

if [[ "${X_FILE_DEV_WATCH:-1}" == "0" ]]; then
  exec pnpm --filter @x-file/server exec node --import tsx src/main.ts
fi

exec pnpm --filter @x-file/server dev
