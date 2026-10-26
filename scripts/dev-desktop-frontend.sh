#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

export X_FILE_DEV_WATCH=0

echo "启动桌面前端热更新模式；后端改动需手动重启此命令才会生效"
exec pnpm --filter @x-file/desktop tauri:dev --no-watch "$@"
