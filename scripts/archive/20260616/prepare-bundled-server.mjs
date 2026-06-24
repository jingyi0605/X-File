#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import fs from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 这个脚本已经被归档到 scripts/archive/20260616，下游路径仍然要指向仓库根目录。
const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const resourcesDir = join(rootDir, "apps", "desktop", "src-tauri", "resources");
const serverResourceDir = join(resourcesDir, "x-file-server");
const runtimeResourceDir = join(resourcesDir, "x-file-runtime");
const legacyEngineResourceDir = join(resourcesDir, "x-file-library-engine");
const bundledPluginResourceDir = join(resourcesDir, "x-file-plugins");
const sourcePluginDir = join(rootDir, "plugins");
function writeResourceBoundaryManifest() {
  const manifest = {
    generatedAt: new Date().toISOString(),
    resources: {
      "x-file-plugins": {
        requiredInMainBundle: true,
        purpose: [
          "提供内置 Integration Plugin 资源目录"
        ],
        entry: "x-file-plugins/*",
        mustKeepBecause: [
          "插件默认启用和运行时安装仍依赖这份内置资源"
        ],
        removableAfter: [
          "改成外部安装或另一个明确的插件分发载体"
        ]
      }
    },
    sidecarPolicy: {
      bundledByDefault: false,
      message: "正式包默认不再内置 Node sidecar；如需外部 sidecar，必须由调用方显式提供。"
    },
    hostLookup: {
      backendEntryPriority: [
        "server/dist/main.js",
        "server/main.js"
      ],
      workerEntryPriority: [
        "apps/server/dist/library/*.js (dev fallback)"
      ]
    },
    desktopHost: {
      nodeWorkerFallback: {
        allowHostNodeFallbackByDefault: false,
        explicitOptInEnv: "X_FILE_ENABLE_HOST_NODE_WORKER_FALLBACK"
      },
      nodeSidecar: {
        profileInMainBundle: "none",
        libraryCoreHttpRoutesServedByDefault: false,
        explicitOptInEnv: "X_FILE_EXTERNAL_NODE_SIDECAR"
      }
    }
  };

  writeFileSync(
    join(resourcesDir, "x-file-resource-boundary.json"),
    JSON.stringify(manifest, null, 2) + "\n"
  );
}

function deployBundledPlugins() {
  rmSync(bundledPluginResourceDir, { recursive: true, force: true });
  mkdirSync(dirname(bundledPluginResourceDir), { recursive: true });
  if (!existsSync(sourcePluginDir)) {
    throw new Error(`内置插件目录不存在：${sourcePluginDir}`);
  }
  fs.cpSync(sourcePluginDir, bundledPluginResourceDir, { recursive: true });
  pruneDescriptorOnlyPluginBackends();
}

function pruneDescriptorOnlyPluginBackends() {
  const pluginDirs = readdirSync(bundledPluginResourceDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(bundledPluginResourceDir, entry.name));

  for (const pluginDir of pluginDirs) {
    const manifestPath = join(pluginDir, "manifest.json");
    if (!existsSync(manifestPath)) {
      continue;
    }
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const hasDescriptor = Boolean(manifest?.assistant?.descriptor);
    const backendEntry = manifest?.entry?.backend;
    if (!hasDescriptor || backendEntry) {
      continue;
    }
    rmSync(join(pluginDir, "backend"), { recursive: true, force: true });
  }
}
mkdirSync(resourcesDir, { recursive: true });
rmSync(serverResourceDir, { recursive: true, force: true });
rmSync(runtimeResourceDir, { recursive: true, force: true });
rmSync(legacyEngineResourceDir, { recursive: true, force: true });
deployBundledPlugins();
writeResourceBoundaryManifest();

console.log("[x-file bundle] 已移除正式包默认内置的 x-file-server 与 x-file-runtime");
console.log("[x-file bundle] 如需外部 Node sidecar，必须由调用方显式提供");
console.log(`[x-file bundle] 内置插件资源已刷新：${bundledPluginResourceDir}`);
