#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$ROOT_DIR"

echo "检查 X-File Windows 桌面构建脚本..."
pnpm --filter @x-file/shared build
pnpm --filter @x-file/desktop build

if [[ "${X_FILE_REQUIRE_RELEASE_SECRETS:-0}" == "1" ]]; then
  node scripts/check-desktop-release-secrets.mjs --platform windows --require-real-secrets
else
  echo "跳过真实签名和自动更新 secrets 检查；设置 X_FILE_REQUIRE_RELEASE_SECRETS=1 后会强制检查。"
fi

cat <<'EOF'
Windows MSI 正式产物需要在 Windows runner 上执行：
  pnpm --filter @x-file/desktop tauri:build

当前脚本只验证 shared 构建、desktop 骨架和 Rust cargo check，不代表已经在 Windows 上完成安装包验证。
自动更新和签名已预留配置占位；Windows runner 上必须配置 Tauri updater secrets 后再执行。Windows 代码签名证书是可选项，不影响 updater 正常更新，只影响安装包发布者可信度。
EOF
