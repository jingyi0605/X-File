#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

TARGET_PLATFORM="${X_FILE_DESKTOP_PLATFORM:-all}"
PLATFORM_SELECTED=0
SKIP_PREFLIGHT=0
DRY_RUN=0

usage() {
  cat <<'EOF'
用法：
  bash scripts/package-all-platforms.sh [平台或数字索引] [选项]

平台：
  1 / macos   在 macOS runner 上生成 universal .app/.dmg
  2 / windows 在 Windows runner 上生成 NSIS，稳定版可额外生成 MSI
  3 / linux   在 Linux runner 上生成 AppImage、deb、rpm
  4 / all     严格执行 macOS、Windows、Linux 三个平台

选项：
  --platform <平台或数字索引>  使用选项指定平台
  --skip-preflight   跳过 updater 和资源边界前置检查
  --dry-run          只打印将要执行的命令
  -h, --help         显示帮助

交互模式：
  直接运行脚本且当前终端支持交互输入时，会显示数字菜单选择平台。
  无交互输入时默认选择 all，适用于 CI。

环境变量：
  X_FILE_MACOS_TARGET       默认 universal-apple-darwin
  X_FILE_LINUX_TARGET       默认当前 Rust host target
  X_FILE_LINUX_BUNDLES      默认 appimage,deb,rpm
  X_FILE_ALLOW_CROSS_PLATFORM=1
                            允许调用平台脚本；实际 Tauri 打包仍要求对应原生 runner
EOF
}

die() {
  echo "错误：$*" >&2
  exit 1
}

log() {
  echo "[package-all-platforms] $*"
}

run_command() {
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '+'
    printf ' %q' "$@"
    printf '\n'
    return 0
  fi

  "$@"
}

host_platform() {
  case "$(uname -s)" in
    Darwin) echo "macos" ;;
    Linux) echo "linux" ;;
    MINGW*|MSYS*|CYGWIN*) echo "windows" ;;
    *)
      if [[ "${OS:-}" == "Windows_NT" ]]; then
        echo "windows"
      else
        echo "unknown"
      fi
      ;;
  esac
}

normalize_platform() {
  case "$1" in
    1|macos)
      TARGET_PLATFORM="macos"
      ;;
    2|windows)
      TARGET_PLATFORM="windows"
      ;;
    3|linux)
      TARGET_PLATFORM="linux"
      ;;
    4|all)
      TARGET_PLATFORM="all"
      ;;
    *)
      die "未知平台：$1。可选值：1/macOS、2/Windows、3/Linux、4/全部平台。"
      ;;
  esac
}

select_platform_interactively() {
  local selection

  if [[ ! -t 0 ]]; then
    return 0
  fi

  cat <<'EOF'

请选择打包平台：
  1. macOS
  2. Windows
  3. Linux
  4. 全部平台
EOF
  printf "请输入数字 [1-4]: "
  IFS= read -r selection || die "未读取到平台选择。"
  normalize_platform "$selection"
}

require_native_runner() {
  local platform="$1"
  local host
  host="$(host_platform)"

  if [[ "$DRY_RUN" == "1" || "${X_FILE_ALLOW_CROSS_PLATFORM:-0}" == "1" ]]; then
    return 0
  fi

  if [[ "$host" != "$platform" ]]; then
    die "${platform} 打包必须在 ${platform} runner 上执行，当前 runner 是 ${host}。请在对应系统执行本脚本，或使用 X_FILE_ALLOW_CROSS_PLATFORM=1 进入底层流程后自行承担交叉编译工具链配置。"
  fi
}

run_preflight() {
  local platform="$1"
  if [[ "$SKIP_PREFLIGHT" == "1" ]]; then
    return 0
  fi

  run_command pnpm --dir "$ROOT_DIR" run verify:desktop -- \
    --platform "$platform" \
    --mode preflight
}

package_macos() {
  require_native_runner "macos"
  log "开始 macOS 打包。"
  run_preflight "macos"
  run_command bash "$ROOT_DIR/scripts/package-desktop.sh" macos --skip-preflight
}

package_windows() {
  require_native_runner "windows"
  log "开始 Windows 打包。"
  run_preflight "windows"
  run_command bash "$ROOT_DIR/scripts/package-desktop.sh" windows --skip-preflight
}

linux_target() {
  if [[ -n "${X_FILE_LINUX_TARGET:-}" ]]; then
    echo "$X_FILE_LINUX_TARGET"
    return 0
  fi

  if [[ "$(host_platform)" == "linux" ]]; then
    rustc -vV | sed -n 's/^host: //p'
  else
    echo "x86_64-unknown-linux-gnu"
  fi
}

verify_linux_artifacts() {
  local target="$1"
  local bundle_root="$ROOT_DIR/apps/desktop/src-tauri/target/$target/release/bundle"
  local bundles="${X_FILE_LINUX_BUNDLES:-appimage,deb,rpm}"
  local bundle
  local extension
  local found

  IFS=',' read -r -a bundle_list <<< "$bundles"
  for bundle in "${bundle_list[@]}"; do
    case "$bundle" in
      appimage) extension="AppImage" ;;
      deb) extension="deb" ;;
      rpm) extension="rpm" ;;
      app) extension="app" ;;
      *) die "不支持的 Linux bundle 类型：$bundle" ;;
    esac

    found=0
    while IFS= read -r -d '' artifact; do
      found=1
      log "已生成 Linux 产物：$artifact"
    done < <(find "$bundle_root/$bundle" -type f -name "*.$extension" -print0 2>/dev/null || true)

    if [[ "$found" == "0" ]]; then
      die "未找到 Linux $bundle 产物：$bundle_root/$bundle/*.$extension"
    fi
  done
}

package_linux() {
  local target
  local bundles

  require_native_runner "linux"
  log "开始 Linux 打包。"
  run_preflight "linux"

  target="$(linux_target)"
  [[ -n "$target" ]] || die "无法确定 Linux Rust target，请设置 X_FILE_LINUX_TARGET。"
  bundles="${X_FILE_LINUX_BUNDLES:-appimage,deb,rpm}"

  if [[ "$DRY_RUN" == "0" ]]; then
    if ! rustup target list --installed | rg -Fx "$target" >/dev/null; then
      die "Rust target 未安装：$target。请先执行 rustup target add $target。"
    fi
  fi

  run_command pnpm --dir "$ROOT_DIR/apps/desktop" exec tauri build \
    --bundles "$bundles" \
    --target "$target"

  if [[ "$DRY_RUN" == "0" ]]; then
    verify_linux_artifacts "$target"
  fi
}

package_all() {
  package_macos
  package_windows
  package_linux
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    macos|windows|linux|all)
      normalize_platform "$1"
      PLATFORM_SELECTED=1
      shift
      ;;
    1|2|3|4)
      normalize_platform "$1"
      PLATFORM_SELECTED=1
      shift
      ;;
    --platform)
      [[ $# -ge 2 ]] || die "--platform 需要一个平台值。"
      normalize_platform "$2"
      PLATFORM_SELECTED=1
      shift 2
      ;;
    --platform=*)
      normalize_platform "${1#*=}"
      PLATFORM_SELECTED=1
      shift
      ;;
    --skip-preflight)
      SKIP_PREFLIGHT=1
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "未知参数：$1。使用 --help 查看用法。"
      ;;
  esac
done

if [[ "$PLATFORM_SELECTED" == "0" ]]; then
  select_platform_interactively
fi

case "$TARGET_PLATFORM" in
  macos) package_macos ;;
  windows) package_windows ;;
  linux) package_linux ;;
  all) package_all ;;
  *) die "未知平台：$TARGET_PLATFORM。可选值：1/macOS、2/Windows、3/Linux、4/全部平台。" ;;
esac

log "打包流程完成。"
