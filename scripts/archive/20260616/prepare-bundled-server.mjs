#!/usr/bin/env node
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 这个脚本位于归档目录，但仍是桌面构建的资源准备入口。
const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const resourcesDir = join(rootDir, "apps", "desktop", "src-tauri", "resources");
function writeResourceBoundaryManifest() {
  const manifest = {
    generatedAt: new Date().toISOString(),
    resources: {},
    sidecarPolicy: {
      bundledByDefault: false,
      message: "正式包默认不再内置 Node sidecar；如需外部 sidecar，必须由调用方显式提供。"
    },
    hostLookup: {
      backendEntryPriority: [
        "server/dist/main.js",
        "server/main.js"
      ]
    },
    desktopHost: {
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

mkdirSync(resourcesDir, { recursive: true });
for (const resource of ["x-file-server", "x-file-runtime", "x-file-library-engine", "x-file-plugins"]) {
  rmSync(join(resourcesDir, resource), { recursive: true, force: true });
}
writeResourceBoundaryManifest();
console.log("[x-file bundle] 已清理旧 Node 资源与内置助手插件，主包仅保留资源边界声明");
