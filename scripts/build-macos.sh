#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "构建 X-File macOS 安装包..."
pnpm --filter @x-file/shared build
pnpm --filter @x-file/indexer build
pnpm --filter @x-file/server build
pnpm --filter @x-file/web build
node scripts/prepare-bundled-server.mjs

if [[ "${X_FILE_REQUIRE_RELEASE_SECRETS:-0}" == "1" ]]; then
  node scripts/check-desktop-release-secrets.mjs --platform macos --require-real-secrets
else
  echo "跳过强制 secrets 检查；本地构建会使用当前环境里已有的签名配置。"
fi

TAURI_ARGS=(build --ci --bundles "${X_FILE_MACOS_BUNDLES:-app,dmg}")
if [[ -n "${APPLE_SIGN_IDENTITY:-}" ]]; then
  TAURI_ARGS+=(--config "{\"bundle\":{\"macOS\":{\"signingIdentity\":\"${APPLE_SIGN_IDENTITY}\"}}}")
fi

pnpm --dir apps/desktop exec tauri "${TAURI_ARGS[@]}"

cat <<'DONE'
macOS 构建命令已完成。
产物通常在：
  apps/desktop/src-tauri/target/release/bundle/macos/X-File.app
  apps/desktop/src-tauri/target/release/bundle/dmg/

如果 spctl 提示 Unnotarized Developer ID，说明还没做 Apple 公证，不是后端没有打进去。
DONE
