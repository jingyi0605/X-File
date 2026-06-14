#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# macOS 构建目标：默认 universal（与 updater 的 macos-universal 平台匹配）。
# universal 需要先安装两个 target：rustup target add aarch64-apple-darwin x86_64-apple-darwin
# 本地调试单架构可设 X_FILE_MACOS_TARGET=aarch64-apple-darwin。
MACOS_TARGET="${X_FILE_MACOS_TARGET:-universal-apple-darwin}"

echo "构建 X-File macOS 安装包（target=${MACOS_TARGET}）..."
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

TAURI_ARGS=(build --ci --bundles "${X_FILE_MACOS_BUNDLES:-app,dmg}" --target "$MACOS_TARGET")
if [[ -n "${APPLE_SIGN_IDENTITY:-}" ]]; then
  TAURI_ARGS+=(--config "{\"bundle\":{\"macOS\":{\"signingIdentity\":\"${APPLE_SIGN_IDENTITY}\"}}}")
fi

pnpm --dir apps/desktop exec tauri "${TAURI_ARGS[@]}"

cat <<DONE
macOS 构建命令已完成。
产物通常在：
  apps/desktop/src-tauri/target/${MACOS_TARGET}/release/bundle/macos/X-File.app
  apps/desktop/src-tauri/target/${MACOS_TARGET}/release/bundle/dmg/
  apps/desktop/src-tauri/target/${MACOS_TARGET}/release/bundle/macos/X-File.app.tar.gz (+ .sig)  # updater 产物

如需完整签名公证（Developer ID + notarization），执行：
  bash scripts/release-macos.sh
（需要 APPLE_SIGN_IDENTITY / APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID）
DONE

# 配置了 Apple 签名身份时自动接签名公证流程（CI 用）；本地无 secrets 会自动跳过。
if [[ -n "${APPLE_SIGN_IDENTITY:-}" && "${X_FILE_AUTO_RELEASE_MACOS:-1}" != "0" ]]; then
  bash "$ROOT_DIR/scripts/release-macos.sh"
fi
