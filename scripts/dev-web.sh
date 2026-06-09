#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

export X_FILE_WEB_HOST="${X_FILE_WEB_HOST:-0.0.0.0}"
export X_FILE_WEB_PORT="${X_FILE_WEB_PORT:-17320}"
export X_FILE_SERVER_HOST="${X_FILE_SERVER_HOST:-0.0.0.0}"
export X_FILE_SERVER_PORT="${X_FILE_SERVER_PORT:-17321}"
export VITE_X_FILE_API_BASE_URL="${VITE_X_FILE_API_BASE_URL:-}"

echo "启动 X-File 前端：http://${X_FILE_WEB_HOST}:${X_FILE_WEB_PORT}"
echo "前端 /api/* 会代理到：http://127.0.0.1:${X_FILE_SERVER_PORT}"

exec pnpm --filter @x-file/web dev
