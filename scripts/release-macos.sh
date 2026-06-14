#!/usr/bin/env bash
# X-File macOS 发布签名公证脚本。
# 从 CodingNS scripts/build-desktop.sh 的 release_macos() 函数族抽离，适配 X-File。
# 作用：对 build-macos.sh 产出的 .app 执行 Developer ID 签名、重建 DMG、Apple 公证、
#       stapling、Gatekeeper 校验，产出可直接分发的 .app / .dmg。
# 前置：必须先跑 build-macos.sh 产出 .app（默认 universal-apple-darwin）。
# 需要 secrets：APPLE_SIGN_IDENTITY、APPLE_ID、APPLE_APP_SPECIFIC_PASSWORD、APPLE_TEAM_ID。
# 无这些 secrets 时直接退出（exit 0），不阻塞 build-macos.sh 的产物生成。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TAURI_DIR="$REPO_DIR/apps/desktop/src-tauri"
MACOS_RELEASE_DIR="$TAURI_DIR/target/release/macos-release"
MACOS_TARGET="${X_FILE_MACOS_TARGET:-universal-apple-darwin}"

# 颜色输出
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
log_info()    { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
log_warn()    { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error()   { echo -e "${RED}[ERROR]${NC} $1" >&2; }

# 校验签名公证必需的环境变量；缺失则提示并跳过（不报错）。
require_release_env() {
  local missing=()
  [[ -z "${APPLE_SIGN_IDENTITY:-}" ]] && missing+=("APPLE_SIGN_IDENTITY")
  [[ -z "${APPLE_ID:-}" ]] && missing+=("APPLE_ID")
  [[ -z "${APPLE_APP_SPECIFIC_PASSWORD:-}" ]] && missing+=("APPLE_APP_SPECIFIC_PASSWORD")
  [[ -z "${APPLE_TEAM_ID:-}" ]] && missing+=("APPLE_TEAM_ID")
  if [[ ${#missing[@]} -gt 0 ]]; then
    log_warn "缺少 macOS 签名公证 secrets：${missing[*]}"
    log_warn "跳过 release-macos（产物未签名）。如需发布，请在 CI 或本地配置 Apple secrets。"
    exit 0
  fi
}

# notarytool 凭证参数（直接用 app-specific password，不需要 keychain profile）。
NOTARYTOOL_ARGS=()
resolve_notarytool_args() {
  NOTARYTOOL_ARGS=(
    --apple-id "$APPLE_ID"
    --password "$APPLE_APP_SPECIFIC_PASSWORD"
    --team-id "$APPLE_TEAM_ID"
  )
}

# 定位 build 阶段产出的 .app（优先 universal target，回退默认 target）。
find_built_macos_app() {
  local candidates=(
    "$TAURI_DIR/target/${MACOS_TARGET}/release/bundle/macos"
    "$TAURI_DIR/target/release/bundle/macos"
  )
  for dir in "${candidates[@]}"; do
    if compgen -G "$dir/*.app" > /dev/null; then
      ls -1 "$dir"/*.app | head -n 1
      return 0
    fi
  done
  log_error "找不到 build 阶段产出的 .app（target=${MACOS_TARGET}）。请先跑 build-macos.sh。"
  return 1
}

sign_macos_app() {
  local app_path="$1"
  log_info "对 .app 执行 Developer ID 签名..."
  codesign --force --deep --timestamp --options runtime --sign "$APPLE_SIGN_IDENTITY" "$app_path"
}

verify_macos_signature() {
  local app_path="$1"
  log_info "校验签名完整性..."
  codesign --verify --deep --strict --verbose=2 "$app_path"
}

# CI runner 上 Spotlight/Finder 常占用 DMG 句柄，普通 detach 失败时强拆。
detach_macos_hdi_device() {
  local device="$1"
  hdiutil detach "$device" -quiet > /dev/null 2>&1 \
    || hdiutil detach "$device" -force -quiet > /dev/null 2>&1 || true
}

# 清理残留挂载点与旧 dmg，避免 hdiutil create 因句柄占用失败。
cleanup_stale_macos_dmg_state() {
  local dmg_path="$1"
  local volume_name="$2"
  local mount_point="/Volumes/$volume_name"
  while IFS= read -r dev; do
    [[ -z "$dev" ]] && continue
    log_warn "卸载残留 DMG 设备：$dev"
    detach_macos_hdi_device "$dev"
  done < <(hdiutil info | grep -A6 -F "$dmg_path" | grep -oE '/dev/disk[0-9]+' || true)
  if [[ -d "$mount_point" ]] && ! mount | grep -F "on $mount_point (" > /dev/null 2>&1; then
    rmdir "$mount_point" > /dev/null 2>&1 || rm -rf "$mount_point" || true
  fi
  rm -f "$dmg_path"
}

# 用临时目录重建发布 DMG，带一次重试（应对 CI 上的瞬时句柄占用）。
create_macos_release_dmg() {
  local signed_app_path="$1"
  local app_name staging_dir tmp_dmg_dir dmg_path tmp_dmg_path volume_name attempt hdiutil_output
  app_name="$(basename "$signed_app_path" .app)"
  dmg_path="$MACOS_RELEASE_DIR/${app_name}.dmg"
  volume_name="$app_name"
  staging_dir="$(mktemp -d "${TMPDIR:-/tmp}/xfile-macos-dmg-src.XXXXXX")"
  tmp_dmg_dir="$(mktemp -d "${TMPDIR:-/tmp}/xfile-macos-dmg-out.XXXXXX")"
  tmp_dmg_path="$tmp_dmg_dir/${app_name}.dmg"

  if ! ditto "$signed_app_path" "$staging_dir/${app_name}.app"; then
    log_error "复制 .app 到 DMG staging 目录失败"
    rm -rf "$staging_dir" "$tmp_dmg_dir"
    return 1
  fi

  log_info "重新生成用于发布的 DMG..."
  for attempt in 1 2; do
    cleanup_stale_macos_dmg_state "$dmg_path" "$volume_name"
    rm -f "$tmp_dmg_path"
    if hdiutil_output="$(hdiutil create -volname "$volume_name" -srcfolder "$staging_dir" -ov -format UDZO "$tmp_dmg_path" 2>&1)"; then
      break
    fi
    log_warn "第 ${attempt} 次 DMG 生成失败，清理后重试。"
    [[ -n "$hdiutil_output" ]] && log_warn "$hdiutil_output"
    cleanup_stale_macos_dmg_state "$tmp_dmg_path" "$volume_name"
    if [[ "$attempt" -eq 2 ]]; then
      log_error "DMG 生成失败，hdiutil 无法写出镜像"
      rm -rf "$staging_dir" "$tmp_dmg_dir"
      return 1
    fi
    sleep 1
  done

  if ! mv "$tmp_dmg_path" "$dmg_path"; then
    log_error "无法把临时 DMG 移动到发布目录：$dmg_path"
    rm -rf "$staging_dir" "$tmp_dmg_dir"
    return 1
  fi
  rm -rf "$staging_dir" "$tmp_dmg_dir"
  echo "$dmg_path"
}

sign_macos_dmg() {
  local dmg_path="$1"
  log_info "对 DMG 执行签名..."
  codesign --force --timestamp --sign "$APPLE_SIGN_IDENTITY" "$dmg_path"
}

notarize_macos_file() {
  local file_path="$1"
  local submit_output submission_id status_output status
  log_info "提交 Apple notarization..."
  submit_output="$(xcrun notarytool submit "$file_path" "${NOTARYTOOL_ARGS[@]}" --no-wait --output-format json)"
  submission_id="$(printf '%s\n' "$submit_output" | sed -n 's/.*"id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
  if [[ -z "$submission_id" ]]; then
    log_error "无法从 notarytool submit 输出中解析 submission id"
    printf '%s\n' "$submit_output"
    return 1
  fi
  log_info "notarization submission id: $submission_id"
  log_info "等待 Apple 处理（最长 30 分钟）..."
  xcrun notarytool wait "$submission_id" "${NOTARYTOOL_ARGS[@]}" --timeout 30m || true
  status_output="$(xcrun notarytool info "$submission_id" "${NOTARYTOOL_ARGS[@]}" --output-format json)"
  status="$(printf '%s\n' "$status_output" | sed -n 's/.*"status"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
  if [[ "$status" != "Accepted" ]]; then
    log_error "notarization 未通过，状态：${status:-unknown}"
    printf '%s\n' "$status_output"
    xcrun notarytool log "$submission_id" "${NOTARYTOOL_ARGS[@]}" || true
    return 1
  fi
  log_success "notarization 已通过：$submission_id"
}

staple_macos_artifact() {
  local path="$1"
  log_info "回写 notarization 票据：$path"
  xcrun stapler staple -v "$path"
}

validate_notarized_macos_release() {
  local app_path="$1"
  local dmg_path="$2"
  log_info "执行最终 Gatekeeper 校验..."
  xcrun stapler validate -v "$dmg_path"
  log_info "复核 .app 签名完整性..."
  codesign --verify --deep --strict --verbose=2 "$app_path"
  spctl --assess --type execute -vv "$app_path"
  spctl --assess --type open --context context:primary-signature -vv "$dmg_path"
}

# ============================================
# 主流程
# ============================================
main() {
  log_info "============================================"
  log_info "X-File macOS 发布签名公证流程..."
  log_info "============================================"

  require_release_env
  resolve_notarytool_args

  local source_app_path release_app_path release_dmg_path app_name
  source_app_path="$(find_built_macos_app)" || exit 1
  app_name="$(basename "$source_app_path" .app)"

  rm -rf "$MACOS_RELEASE_DIR"
  mkdir -p "$MACOS_RELEASE_DIR"
  release_app_path="$MACOS_RELEASE_DIR/${app_name}.app"

  log_info "复制 build 产物到发布目录..."
  ditto "$source_app_path" "$release_app_path"

  sign_macos_app "$release_app_path"
  verify_macos_signature "$release_app_path"

  if ! release_dmg_path="$(create_macos_release_dmg "$release_app_path")"; then
    log_error "DMG 生成失败，终止后续签名公证"
    exit 1
  fi
  sign_macos_dmg "$release_dmg_path"
  notarize_macos_file "$release_dmg_path"
  staple_macos_artifact "$release_dmg_path"
  validate_notarized_macos_release "$release_app_path" "$release_dmg_path"

  log_success "X-File macOS 发布流程完成！"
  log_info "产物："
  log_info "  .app: $release_app_path"
  log_info "  .dmg: $release_dmg_path"
  log_info "  updater: $TAURI_DIR/target/${MACOS_TARGET}/release/bundle/macos/${app_name}.app.tar.gz (+ .sig)"
}

main "$@"
