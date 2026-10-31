#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

MIRROR_DATA_DIR="${X_FILE_MIRROR_DATA_DIR:-${ROOT_DIR}/.x-file-mirror-dev}"
export X_FILE_DATA_DIR="$MIRROR_DATA_DIR"
export X_FILE_SERVER_STATE_PATH="${MIRROR_DATA_DIR}/http-server-state.json"
mkdir -p "$MIRROR_DATA_DIR"

echo "启动 X-File 镜像端桌面调试窗口"
echo "镜像端前端：http://127.0.0.1:17322"
echo "默认主端 API：http://127.0.0.1:${X_FILE_MIRROR_PRIMARY_API_PORT:-17321}"
echo "镜像端数据目录：${X_FILE_DATA_DIR}"
echo "镜像端 HTTP 状态：${X_FILE_SERVER_STATE_PATH}"
echo "镜像模式和主端地址请在应用设置中保存"

exec pnpm --filter @x-file/desktop tauri:dev \
  --config "$ROOT_DIR/apps/desktop/src-tauri/tauri.mirror.conf.json" \
  --no-watch \
  "$@"
