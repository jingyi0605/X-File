#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import fs from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 这个脚本已经被归档到 scripts/archive/20260616，下游路径仍然要指向仓库根目录。
const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const resourcesDir = join(rootDir, "apps", "desktop", "src-tauri", "resources");
const legacyServerResourceDir = join(resourcesDir, "x-file-server");
const engineResourceDir = join(resourcesDir, "x-file-library-engine");
const runtimeResourceDir = join(resourcesDir, "x-file-runtime");
const bundledPluginResourceDir = join(resourcesDir, "x-file-plugins");
const sourcePluginDir = join(rootDir, "plugins");
const nodeVersion = process.env.X_FILE_BUNDLED_NODE_VERSION || "22.16.0";
const force = process.argv.includes("--force") || process.env.X_FILE_FORCE_BUNDLED_SERVER === "1";
const omitBundledNodeRuntime =
  process.argv.includes("--omit-node-runtime") ||
  process.env.X_FILE_OMIT_NODE_RUNTIME === "1";

// Windows 上 npm/pnpm 是 .cmd 批处理，execFileSync 直接执行会报 EINVAL；
// 对裸命令走 shell（cmd.exe 解析 .cmd），对可执行文件路径（nodeBin 等）直接执行。
function isExecutablePath(command) {
  return /[\\/]/.test(command) || /\.(exe|bat)$/i.test(command);
}

function run(command, args, options = {}) {
  console.log(`[x-file bundle] ${command} ${args.join(" ")}`);
  execFileSync(command, args, {
    cwd: options.cwd ?? rootDir,
    stdio: "inherit",
    shell: process.platform === "win32" && !isExecutablePath(command),
    env: {
      ...process.env,
      ...options.env
    }
  });
}

function runWithOutput(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd ?? rootDir,
    encoding: "utf8",
    shell: process.platform === "win32" && !isExecutablePath(command),
    env: {
      ...process.env,
      ...options.env
    }
  }).trim();
}

function ensureBuildOutputs() {
  const required = [
    join(rootDir, "packages", "library-engine", "dist", "main.js"),
    join(rootDir, "packages", "shared", "dist", "index.js"),
    join(rootDir, "packages", "indexer", "dist", "src", "index.js")
  ];

  for (const file of required) {
    if (!existsSync(file)) {
      throw new Error(`缺少构建产物：${file}。请先运行 pnpm --filter @x-file/shared build、pnpm --filter @x-file/indexer build、pnpm --filter @x-file/server build、pnpm --filter @x-file/library-engine build。`);
    }
  }
}

function ensureBundledNode() {
  if (omitBundledNodeRuntime) {
    console.log("[x-file bundle] 已启用 omit-node-runtime；跳过随包 Node runtime 准备");
    rmSync(runtimeResourceDir, { recursive: true, force: true });
    return null;
  }

  const nodeBin = resolveNodeBin(runtimeResourceDir);
  if (!force && nodeBin && existsSync(nodeBin)) {
    console.log(`[x-file bundle] 复用已准备的 Node ${runWithOutput(nodeBin, ["-v"])}`);
    return nodeBin;
  }

  const installDir = join(rootDir, "node_modules", ".x-file-bundled-node");
  rmSync(runtimeResourceDir, { recursive: true, force: true });
  rmSync(installDir, { recursive: true, force: true });
  mkdirSync(runtimeResourceDir, { recursive: true });

  // npm 包 node 会按当前平台安装官方 Node 二进制。不要用 Homebrew Node，那个二进制依赖用户机器上的 /opt/homebrew 动态库。
  run("npm", ["install", "--prefix", installDir, "--omit=dev", "--no-audit", "--no-fund", `node@${nodeVersion}`]);

  const installedNodeBin = resolveInstalledNodeBin(installDir);
  if (!installedNodeBin || !existsSync(installedNodeBin)) {
    throw new Error(`Node 运行时准备失败，缺少 ${join(installDir, "node_modules", "node", "bin", "node")}`);
  }

  const bundledNodeDir = join(runtimeResourceDir, "node", "bin");
  const bundledNodeBin = join(bundledNodeDir, process.platform === "win32" ? "node.exe" : "node");
  mkdirSync(bundledNodeDir, { recursive: true });
  copyFileSync(installedNodeBin, bundledNodeBin);
  // Windows 没有 chmod，文件权限由 ACL 管理，跳过。
  if (process.platform !== "win32") {
    run("chmod", ["755", bundledNodeBin]);
  }
  rmSync(installDir, { recursive: true, force: true });

  console.log(`[x-file bundle] 已准备 Node ${runWithOutput(bundledNodeBin, ["-v"])}`);
  return bundledNodeBin;
}

function resolveNodeBin(baseDir) {
  const candidates = [
    join(baseDir, "node", "bin", process.platform === "win32" ? "node.exe" : "node"),
    join(baseDir, "node_modules", "node", "bin", process.platform === "win32" ? "node.exe" : "node"),
    join(baseDir, "package", "node_modules", "node", "bin", process.platform === "win32" ? "node.exe" : "node"),
    join(baseDir, "package", "bin", process.platform === "win32" ? "node.exe" : "node"),
    join(baseDir, "bin", process.platform === "win32" ? "node.exe" : "node")
  ];

  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

function resolveInstalledNodeBin(baseDir) {
  const candidates = [
    join(baseDir, "node_modules", "node", "bin", process.platform === "win32" ? "node.exe" : "node"),
    join(baseDir, "node_modules", "node", "node_modules", "node-bin-darwin-arm64", "bin", "node"),
    join(baseDir, "node_modules", "node", "node_modules", "node-bin-darwin-x64", "bin", "node"),
    join(baseDir, "node_modules", "node", "node_modules", "node-bin-win-x64", "bin", "node.exe")
  ];

  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

function deployLibraryEngine(nodeBin) {
  mkdirSync(dirname(engineResourceDir), { recursive: true });
  rmSync(legacyServerResourceDir, { recursive: true, force: true });

  const deployEnv = {
    npm_execpath: process.env.npm_execpath ?? "",
    npm_node_execpath: nodeBin,
    NODE: nodeBin,
    npm_config_node_linker: "hoisted",
    npm_config_node_gyp: process.env.npm_config_node_gyp ?? ""
  };
  const isEngineDeployed = () => [
    join(engineResourceDir, "dist", "main.js"),
    join(engineResourceDir, "node_modules", "@x-file", "server", "dist", "app.js"),
    join(engineResourceDir, "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node")
  ].every(existsSync);

  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    rmSync(engineResourceDir, { recursive: true, force: true });
    try {
      run("pnpm", ["--filter", "@x-file/library-engine", "--prod", "deploy", engineResourceDir], {
        env: deployEnv
      });
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      console.error(`[x-file bundle] library-engine deploy 第 ${attempt} 次失败：${String(error.message || error)}`);
      if (isEngineDeployed()) {
        console.error("[x-file bundle] library-engine 关键依赖已部署，忽略非运行入口失败");
        lastError = null;
        break;
      }
    }
  }
  if (lastError) {
    throw lastError;
  }

  const entry = join(engineResourceDir, "dist", "main.js");
  if (!existsSync(entry)) {
    throw new Error(`文档引擎入口不存在：${entry}`);
  }
  pruneEngineDeployArtifacts(engineResourceDir);

  writeFileSync(
    join(engineResourceDir, "bundle-manifest.json"),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        nodeVersion: nodeBin ? runWithOutput(nodeBin, ["-v"]) : null,
        entry: "dist/main.js",
        packageName: "@x-file/library-engine"
      },
      null,
      2
    ) + "\n"
  );
}

function writeResourceBoundaryManifest(nodeBin) {
  const manifest = {
    generatedAt: new Date().toISOString(),
    resources: {
      "x-file-library-engine": {
        requiredInMainBundle: true,
        purpose: [
          "桌面壳默认后端入口 dist/main.js",
          "Node worker 入口所在包，承载 @x-file/server dist/library/*",
          "保留 OnlyOffice、插件宿主、server-state 等剩余 Node HTTP 服务"
        ],
        entry: "x-file-library-engine/dist/main.js",
        mustKeepBecause: [
          "native index-only worker 仍从这里解析 @x-file/server/dist/library/*.js",
          "剩余 Node sidecar 服务仍通过 library-engine 部署进资源目录"
        ],
        removableAfter: [
          "文档库主链不再依赖 library-engine 里的 Node worker 入口",
          "剩余 Node HTTP sidecar 另有更小载体，或也已 native 化"
        ]
      },
      "x-file-runtime": {
        requiredInMainBundle: !omitBundledNodeRuntime,
        purpose: [
          "提供随包 Node 二进制",
          "拉起 x-file-library-engine 主入口",
          "拉起默认 index-only 临时 Node worker"
        ],
        entry: "x-file-runtime/node/bin/node",
        nodeVersion: nodeBin ? runWithOutput(nodeBin, ["-v"]) : null,
        mustKeepBecause: [
          "默认正式主链的 TextIndexer / parser / SQLite 执行面仍运行在 Node",
          "桌面 Rust 宿主已经不再默认回退系统 Node；只要正式包还保留 Node worker 主路径，就必须显式携带这份 runtime"
        ],
        removableAfter: [
          "正式主链不再需要 Node worker 执行 index-only",
          "或改成更小 sidecar/独立 helper，而不是完整 Node runtime"
        ]
      },
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
    hostLookup: {
      backendEntryPriority: [
        "x-file-library-engine/dist/main.js",
        "x-file-server/dist/main.js",
        "server/dist/main.js",
        "x-file-server/main.js",
        "server/main.js"
      ],
      workerEntryPriority: [
        "x-file-library-engine/node_modules/@x-file/server/dist/library/*.js",
        "x-file-library-engine/node_modules/@x-file/server/dist/src/library/*.js",
        "apps/server/dist/library/*.js (dev fallback)"
      ],
      bundledNodePriority: [
        "x-file-runtime/node/bin/node",
        "x-file-runtime/node_modules/node/bin/node",
        "x-file-runtime/package/node_modules/node/bin/node",
        "x-file-runtime/package/bin/node"
      ]
    },
    desktopHost: {
      nodeWorkerFallback: {
        allowHostNodeFallbackByDefault: false,
        explicitOptInEnv: "X_FILE_ENABLE_HOST_NODE_WORKER_FALLBACK"
      },
      nodeSidecar: {
        profileInMainBundle: "sidecar-only",
        libraryCoreHttpRoutesServedByDefault: false,
        explicitOptInEnv: "X_FILE_NODE_SIDECAR_PROFILE"
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
}

function pruneEngineDeployArtifacts(deployDir) {
  pruneWorkspacePackageSources(deployDir);
  pruneAssistantArtifacts(deployDir);
  sanitizeDeployedServerPackageJson(deployDir);
  pruneTestArtifacts(deployDir);
}

function pruneWorkspacePackageSources(deployDir) {
  const scopedPackageDir = join(deployDir, "node_modules", "@x-file");
  for (const packageName of ["server", "shared", "indexer"]) {
    rmSync(join(scopedPackageDir, packageName, "src"), { recursive: true, force: true });
    rmSync(join(scopedPackageDir, packageName, "contracts", "src"), { recursive: true, force: true });
    rmSync(join(scopedPackageDir, packageName, "tsconfig.json"), { force: true });
  }
  rmSync(join(deployDir, "src"), { recursive: true, force: true });
  rmSync(join(deployDir, "tsconfig.json"), { force: true });
}

function pruneAssistantArtifacts(deployDir) {
  const serverDistDir = join(deployDir, "node_modules", "@x-file", "server", "dist");
  const sharedDistDir = join(deployDir, "node_modules", "@x-file", "shared", "dist");
  const targets = [
    join(serverDistDir, "app.js"),
    join(serverDistDir, "app.d.ts"),
    join(serverDistDir, "app.js.map"),
    join(serverDistDir, "main.js"),
    join(serverDistDir, "main.d.ts"),
    join(serverDistDir, "main.js.map"),
    join(serverDistDir, "assistant"),
    join(serverDistDir, "routes", "assistant-routes.js"),
    join(serverDistDir, "routes", "assistant-routes.d.ts"),
    join(serverDistDir, "routes", "assistant-routes.js.map"),
    join(sharedDistDir, "assistant-types.js"),
    join(sharedDistDir, "assistant-types.d.ts"),
    join(sharedDistDir, "assistant-types.js.map"),
    join(sharedDistDir, "assistant-types.d.ts.map")
  ];

  for (const target of targets) {
    rmSync(target, { recursive: true, force: true });
  }
}

function sanitizeDeployedServerPackageJson(deployDir) {
  const packageJsonPath = join(deployDir, "node_modules", "@x-file", "server", "package.json");
  if (!existsSync(packageJsonPath)) {
    return;
  }
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  delete packageJson.devDependencies;
  delete packageJson.scripts;
  if (packageJson.exports) {
    delete packageJson.exports["."];
    delete packageJson.exports["./app"];
  }
  writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + "\n");
}

function pruneTestArtifacts(deployDir) {
  const targets = [
    join(deployDir, "dist"),
    join(deployDir, "node_modules", "@x-file", "server", "dist"),
    join(deployDir, "node_modules", "@x-file", "shared", "dist"),
    join(deployDir, "node_modules", "@x-file", "indexer", "dist")
  ];

  for (const target of targets) {
    if (!existsSync(target)) {
      continue;
    }
    removeMatchingFiles(target, (filePath) => /\.test\.(d\.ts|js|js\.map|d\.ts\.map)$/.test(filePath));
  }
}

function removeMatchingFiles(baseDir, matcher) {
  const entries = fs.readdirSync(baseDir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(baseDir, entry.name);
    if (entry.isDirectory()) {
      removeMatchingFiles(fullPath, matcher);
      continue;
    }
    if (matcher(fullPath)) {
      rmSync(fullPath, { force: true });
    }
  }
}

function smokeTest(nodeBin) {
  if (!nodeBin) {
    console.log("[x-file bundle] 跳过 Node smoke test：当前未打包随包 runtime");
    return;
  }
  const script = [
    "import('fastify').then(() => import('@x-file/indexer')).then(() => import('@x-file/library-engine')).then(() => { console.log('ok') }).catch((error) => { console.error(error); process.exit(1); })"
  ].join("\n");
  run(nodeBin, ["--input-type=module", "-e", script], { cwd: engineResourceDir, env: { NODE_ENV: "production" } });
}

function directorySize(path) {
  if (!existsSync(path)) {
    return "0";
  }
  // Windows 没有 du，跳过大小统计（仅用于日志展示）。
  if (process.platform === "win32") {
    return "?";
  }
  const output = runWithOutput("du", ["-sh", path]);
  return output.split(/\s+/)[0] ?? "0";
}

ensureBuildOutputs();
const nodeBin = ensureBundledNode();
deployLibraryEngine(nodeBin);
deployBundledPlugins();
writeResourceBoundaryManifest(nodeBin);
smokeTest(nodeBin);

console.log(`[x-file bundle] 文档引擎资源：${engineResourceDir} (${directorySize(engineResourceDir)})`);
if (nodeBin) {
  console.log(`[x-file bundle] Node 运行时：${runtimeResourceDir} (${directorySize(runtimeResourceDir)})`);
} else {
  console.log("[x-file bundle] Node 运行时：已按配置省略");
}
console.log(`[x-file bundle] 内置插件资源：${bundledPluginResourceDir} (${directorySize(bundledPluginResourceDir)})`);
