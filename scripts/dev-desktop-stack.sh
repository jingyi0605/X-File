#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

export X_FILE_NODE_SIDECAR_PROFILE="${X_FILE_NODE_SIDECAR_PROFILE:-full}"

children=()

workspace_has_package() {
  local package_name="$1"
  rg -l "\"name\": \"${package_name}\"" apps packages --glob package.json >/dev/null 2>&1
}

run_workspace_script_if_exists() {
  local package_name="$1"
  local script_name="$2"

  if workspace_has_package "$package_name"; then
    pnpm --filter "$package_name" "$script_name"
    return 0
  fi

  echo "跳过 ${package_name}#${script_name}：当前 workspace 不存在该包"
}

start_workspace_script_if_exists() {
  local package_name="$1"
  local script_name="$2"

  if workspace_has_package "$package_name"; then
    pnpm --filter "$package_name" "$script_name" &
    children+=("$!")
    return 0
  fi

  echo "跳过 ${package_name}#${script_name}：当前 workspace 不存在该包"
}

cleanup() {
  local exit_code=$?
  trap - INT TERM EXIT
  if ((${#children[@]} > 0)); then
    kill "${children[@]}" 2>/dev/null || true
    wait "${children[@]}" 2>/dev/null || true
  fi
  exit "$exit_code"
}

trap cleanup INT TERM EXIT

echo "预编译 X-File 开发依赖包"
run_workspace_script_if_exists "@x-file/shared" build
run_workspace_script_if_exists "@x-file/indexer" build
run_workspace_script_if_exists "@x-file/library-engine" build

echo "启动共享包监听编译"
start_workspace_script_if_exists "@x-file/shared" dev
start_workspace_script_if_exists "@x-file/indexer" dev
start_workspace_script_if_exists "@x-file/library-engine" dev

bash scripts/dev-server.sh &
children+=("$!")

bash scripts/dev-web.sh &
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
