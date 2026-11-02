#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

export X_FILE_WEB_PORT="${X_FILE_SAMPLE_WEB_PORT:-17340}"
unset VITE_X_FILE_RUNTIME_MODE
unset VITE_X_FILE_API_BASE_URL

exec pnpm --filter @x-file/web dev
