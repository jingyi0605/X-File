#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# 检测是否在 Windows 环境（Git Bash / MSYS2 / Cygwin）。
is_windows_env() {
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*) return 0 ;;
    *) [[ "${OS:-}" == "Windows_NT" ]] ;;
  esac
}

if [[ "${X_FILE_REQUIRE_RELEASE_SECRETS:-0}" == "1" ]]; then
  node scripts/check-desktop-release-secrets.mjs --platform windows --require-real-secrets
else
  echo "跳过真实签名和自动更新 secrets 检查；设置 X_FILE_REQUIRE_RELEASE_SECRETS=1 后会强制检查。"
fi

if is_windows_env; then
  echo "在 Windows 环境构建 X-File 安装包..."
  # 按版本通道决定产物：预发布（VERSION 含 -）只产 NSIS exe；稳定版产 MSI + NSIS。
  # 与 CI 的「校验 Windows 产物符合版本通道」逻辑一致。
  VERSION_TEXT="$(tr -d '[:space:]' < "$ROOT_DIR/VERSION" 2>/dev/null || echo "")"
  BUNDLE_TARGETS="${X_FILE_WINDOWS_BUNDLES:-}"
  if [[ -z "$BUNDLE_TARGETS" ]]; then
    if [[ -n "$VERSION_TEXT" && "$VERSION_TEXT" == *-* ]]; then
      BUNDLE_TARGETS="nsis"
      echo "检测到预发布版本 ${VERSION_TEXT}，Windows 仅构建 NSIS 安装包，跳过 MSI。"
    else
      BUNDLE_TARGETS="msi,nsis"
    fi
  fi

  # tauri build 的 beforeBuildCommand 会构建 shared/indexer/server/web + 打包后端。
  pnpm --dir apps/desktop exec tauri build --ci --bundles "$BUNDLE_TARGETS" --target x86_64-pc-windows-msvc

  echo "Windows 构建完成。产物在："
  echo "  apps/desktop/src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/*.exe"
  echo "  apps/desktop/src-tauri/target/x86_64-pc-windows-msvc/release/bundle/msi/*.msi"
  echo "  以及对应 *.sig updater 签名"
else
  echo "非 Windows 环境，执行桌面骨架校验..."
  pnpm --filter @x-file/shared build
  pnpm --filter @x-file/web build
  pnpm --filter @x-file/desktop build
  cat <<'EOF'
Windows MSI/NSIS 正式产物需要在 Windows runner 上执行本脚本：
  bash scripts/build-windows.sh

当前只在非 Windows 环境做了 shared/web 构建和 desktop cargo check 骨架校验，
不代表已完成 Windows 安装包验证。Windows runner 上必须配置 Tauri updater secrets 后再执行。
Windows 代码签名证书是可选项，不影响 updater 正常更新，只影响安装包发布者可信度。
EOF
fi
