#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

TARGET_PLATFORM="${1:-${X_FILE_DESKTOP_PLATFORM:-auto}}"
SKIP_PREFLIGHT=0
if [[ "$TARGET_PLATFORM" == "--platform" ]]; then
  TARGET_PLATFORM="${2:-auto}"
fi
for arg in "$@"; do
  if [[ "$arg" == "--skip-preflight" ]]; then
    SKIP_PREFLIGHT=1
  fi
done

MACOS_TARGET="${X_FILE_MACOS_TARGET:-universal-apple-darwin}"

run_verify_desktop() {
  pnpm --dir "$ROOT_DIR" run verify:desktop -- "$@"
}

is_windows_env() {
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*) return 0 ;;
    *) [[ "${OS:-}" == "Windows_NT" ]] ;;
  esac
}

find_built_macos_app() {
  local candidates=(
    "$ROOT_DIR/apps/desktop/src-tauri/target/${MACOS_TARGET}/release/bundle/macos"
    "$ROOT_DIR/apps/desktop/src-tauri/target/release/bundle/macos"
  )

  local dir
  for dir in "${candidates[@]}"; do
    local app_path
    for app_path in "$dir"/*.app; do
      if [[ -e "$app_path" ]]; then
        echo "$app_path"
        return 0
      fi
    done
  done

  echo "未找到 macOS .app 产物。"
  return 1
}

create_unsigned_macos_dmg() {
  local app_path
  app_path="$(find_built_macos_app)"

  local app_name
  app_name="$(basename "$app_path" .app)"

  local release_dir="$ROOT_DIR/apps/desktop/src-tauri/target/release/macos-release"
  local staging_dir
  local temp_dmg_dir
  local temp_dmg_path
  local final_dmg_path

  staging_dir="$(mktemp -d "${TMPDIR:-/tmp}/x-file-macos-dmg-src.XXXXXX")"
  temp_dmg_dir="$(mktemp -d "${TMPDIR:-/tmp}/x-file-macos-dmg-out.XXXXXX")"
  temp_dmg_path="$temp_dmg_dir/${app_name}.dmg"
  final_dmg_path="$release_dir/${app_name}.dmg"

  mkdir -p "$release_dir"
  rm -f "$final_dmg_path"

  # 不再依赖 Finder AppleScript 美化 DMG；Sequoia 上这一步经常超时。
  ditto "$app_path" "$staging_dir/${app_name}.app"
  ln -s /Applications "$staging_dir/Applications"

  hdiutil create -volname "$app_name" -srcfolder "$staging_dir" -ov -format UDZO "$temp_dmg_path"
  mv "$temp_dmg_path" "$final_dmg_path"

  rm -rf "$staging_dir" "$temp_dmg_dir"
  echo "已生成 macOS DMG：$final_dmg_path"
}

package_macos() {
  echo "执行 macOS 打包..."
  if [[ "$SKIP_PREFLIGHT" != "1" ]]; then
    run_verify_desktop --platform macos --mode preflight
  fi

  if [[ "${X_FILE_REQUIRE_RELEASE_SECRETS:-0}" == "1" ]]; then
    run_verify_desktop --platform macos --mode preflight --require-real-secrets
  fi

  # 只让 Tauri 负责生成 .app。DMG 改为后置用 hdiutil 生成，避开 Finder AppleScript 超时。
  pnpm --dir apps/desktop exec tauri build --bundles app --target "$MACOS_TARGET"

  if [[ -n "${APPLE_SIGN_IDENTITY:-}" && "${X_FILE_AUTO_RELEASE_MACOS:-1}" != "0" ]]; then
    sign_and_notarize_macos
  else
    create_unsigned_macos_dmg
  fi

  run_verify_desktop --platform macos --mode artifacts
}

sign_and_notarize_macos() {
  local missing=()
  [[ -z "${APPLE_SIGN_IDENTITY:-}" ]] && missing+=("APPLE_SIGN_IDENTITY")
  [[ -z "${APPLE_ID:-}" ]] && missing+=("APPLE_ID")
  [[ -z "${APPLE_APP_SPECIFIC_PASSWORD:-}" ]] && missing+=("APPLE_APP_SPECIFIC_PASSWORD")
  [[ -z "${APPLE_TEAM_ID:-}" ]] && missing+=("APPLE_TEAM_ID")
  if [[ ${#missing[@]} -gt 0 ]]; then
    echo "缺少 macOS 签名公证 secrets：${missing[*]}"
    echo "跳过 macOS 签名公证，只保留原始构建产物。"
    return 0
  fi

  bash "$ROOT_DIR/scripts/archive/20260616/release-macos.sh"
}

package_windows() {
  echo "执行 Windows 打包..."
  if [[ "$SKIP_PREFLIGHT" != "1" ]]; then
    run_verify_desktop --platform windows --mode preflight
  fi

  if [[ "${X_FILE_REQUIRE_RELEASE_SECRETS:-0}" == "1" ]]; then
    run_verify_desktop --platform windows --mode preflight --require-real-secrets
  fi

  if is_windows_env; then
    local version_text
    local bundle_targets

    version_text="$(tr -d '[:space:]' < "$ROOT_DIR/VERSION" 2>/dev/null || echo "")"
    bundle_targets="${X_FILE_WINDOWS_BUNDLES:-}"
    if [[ -z "$bundle_targets" ]]; then
      if [[ -n "$version_text" && "$version_text" == *-* ]]; then
        bundle_targets="nsis"
        echo "检测到预发布版本 ${version_text}，Windows 仅构建 NSIS 安装包。"
      else
        bundle_targets="msi,nsis"
      fi
    fi

    pnpm --dir apps/desktop exec tauri build --bundles "$bundle_targets" --target x86_64-pc-windows-msvc
    run_verify_desktop --platform windows --mode artifacts
    return 0
  fi

  echo "当前不是 Windows 环境，只做桌面骨架校验。"
  pnpm --filter @x-file/shared build
  pnpm --filter @x-file/web build
  pnpm --filter @x-file/desktop build
}

case "$TARGET_PLATFORM" in
  auto)
    if is_windows_env; then
      package_windows
    else
      package_macos
    fi
    ;;
  macos)
    package_macos
    ;;
  windows)
    package_windows
    ;;
  all)
    package_macos
    package_windows
    ;;
  *)
    echo "未知平台：$TARGET_PLATFORM"
    echo "用法：bash scripts/package-desktop.sh [macos|windows|all|auto]"
    exit 1
    ;;
esac
