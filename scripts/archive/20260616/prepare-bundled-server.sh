#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
RESOURCES_DIR="${ROOT_DIR}/apps/desktop/src-tauri/resources"
SERVER_RESOURCE_DIR="${RESOURCES_DIR}/x-file-server"
RUNTIME_RESOURCE_DIR="${RESOURCES_DIR}/x-file-runtime"
LEGACY_ENGINE_RESOURCE_DIR="${RESOURCES_DIR}/x-file-library-engine"
BUNDLED_PLUGIN_RESOURCE_DIR="${RESOURCES_DIR}/x-file-plugins"
SOURCE_PLUGIN_DIR="${ROOT_DIR}/plugins"
RESOURCE_BOUNDARY_PATH="${RESOURCES_DIR}/x-file-resource-boundary.json"

prune_descriptor_only_plugin_backends() {
  local plugin_dir
  for plugin_dir in "${BUNDLED_PLUGIN_RESOURCE_DIR}"/*; do
    if [[ ! -d "${plugin_dir}" ]]; then
      continue
    fi

    local manifest_path="${plugin_dir}/manifest.json"
    if [[ ! -f "${manifest_path}" ]]; then
      continue
    fi

    if grep -q '"backend"[[:space:]]*:[[:space:]]*null' "${manifest_path}" && \
      grep -q '"descriptor"' "${manifest_path}"; then
      rm -rf "${plugin_dir}/backend"
    fi
  done
}

write_resource_boundary_manifest() {
  local generated_at
  generated_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

  cat > "${RESOURCE_BOUNDARY_PATH}" <<EOF
{
  "generatedAt": "${generated_at}",
  "resources": {
    "x-file-plugins": {
      "requiredInMainBundle": true,
      "purpose": [
        "提供内置 Integration Plugin 资源目录"
      ],
      "entry": "x-file-plugins/*",
      "mustKeepBecause": [
        "插件默认启用和运行时安装仍依赖这份内置资源"
      ],
      "removableAfter": [
        "改成外部安装或另一个明确的插件分发载体"
      ]
    }
  },
  "sidecarPolicy": {
    "bundledByDefault": false,
    "message": "正式包默认不再内置 Node sidecar；如需外部 sidecar，必须由调用方显式提供。"
  },
  "hostLookup": {
    "backendEntryPriority": [
      "server/dist/main.js",
      "server/main.js"
    ],
    "workerEntryPriority": [
      "apps/server/dist/library/*.js (dev fallback)"
    ]
  },
  "desktopHost": {
    "nodeWorkerFallback": {
      "allowHostNodeFallbackByDefault": false,
      "explicitOptInEnv": "X_FILE_ENABLE_HOST_NODE_WORKER_FALLBACK"
    },
    "nodeSidecar": {
      "profileInMainBundle": "none",
      "libraryCoreHttpRoutesServedByDefault": false,
      "explicitOptInEnv": "X_FILE_EXTERNAL_NODE_SIDECAR"
    }
  }
}
EOF
}

mkdir -p "${RESOURCES_DIR}"
rm -rf "${SERVER_RESOURCE_DIR}" "${RUNTIME_RESOURCE_DIR}" "${LEGACY_ENGINE_RESOURCE_DIR}"

if [[ ! -d "${SOURCE_PLUGIN_DIR}" ]]; then
  echo "内置插件目录不存在：${SOURCE_PLUGIN_DIR}" >&2
  exit 1
fi

rm -rf "${BUNDLED_PLUGIN_RESOURCE_DIR}"
mkdir -p "${BUNDLED_PLUGIN_RESOURCE_DIR}"
cp -R "${SOURCE_PLUGIN_DIR}/." "${BUNDLED_PLUGIN_RESOURCE_DIR}/"
prune_descriptor_only_plugin_backends
write_resource_boundary_manifest

echo "[x-file bundle] 已移除正式包默认内置的 x-file-server 与 x-file-runtime"
echo "[x-file bundle] 如需外部 Node sidecar，必须由调用方显式提供"
echo "[x-file bundle] 内置插件资源已刷新：${BUNDLED_PLUGIN_RESOURCE_DIR}"
