#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

export X_FILE_WEB_PORT=17322
export X_FILE_SERVER_HOST=127.0.0.1
export X_FILE_SERVER_PORT="${X_FILE_MIRROR_PRIMARY_API_PORT:-17321}"
unset VITE_X_FILE_API_BASE_URL

workspace_has_package() {
  local package_name="$1"
  rg --no-ignore -l "\"name\": \"${package_name}\"" apps packages --glob package.json >/dev/null 2>&1
}

build_workspace_package_if_exists() {
  local package_name="$1"

  if workspace_has_package "$package_name"; then
    pnpm --filter "$package_name" build
    return 0
  fi

  echo "跳过 ${package_name}#build：当前 workspace 不存在该包"
}

build_workspace_package_if_exists "@x-file/shared"
build_workspace_package_if_exists "@x-file/indexer"
build_workspace_package_if_exists "@x-file/library-engine"

exec bash "$ROOT_DIR/scripts/dev-web.sh"
