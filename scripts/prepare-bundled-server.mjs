#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const resourcesDir = join(rootDir, "apps", "desktop", "src-tauri", "resources");
const serverResourceDir = join(resourcesDir, "x-file-server");
const runtimeResourceDir = join(resourcesDir, "x-file-runtime");
const nodeVersion = process.env.X_FILE_BUNDLED_NODE_VERSION || "22.16.0";
const force = process.argv.includes("--force") || process.env.X_FILE_FORCE_BUNDLED_SERVER === "1";

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
    join(rootDir, "apps", "server", "dist", "main.js"),
    join(rootDir, "packages", "shared", "dist", "index.js"),
    join(rootDir, "packages", "indexer", "dist", "src", "index.js")
  ];

  for (const file of required) {
    if (!existsSync(file)) {
      throw new Error(`缺少构建产物：${file}。请先运行 pnpm --filter @x-file/shared build、pnpm --filter @x-file/indexer build、pnpm --filter @x-file/server build。`);
    }
  }
}

function ensureBundledNode() {
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

function deployServer(nodeBin) {
  mkdirSync(dirname(serverResourceDir), { recursive: true });

  // pnpm deploy 使用 hoisted node_modules，避免 Tauri 复制资源时丢掉 pnpm 顶层 symlink。
  // Windows 上创建 node_modules/.bin/*.CMD 偶发 EPERM（Defender 实时扫描占用句柄），清理后重试。
  const deployEnv = {
    npm_execpath: process.env.npm_execpath ?? "",
    npm_node_execpath: nodeBin,
    NODE: nodeBin,
    npm_config_node_linker: "hoisted",
    npm_config_node_gyp: process.env.npm_config_node_gyp ?? ""
  };
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    rmSync(serverResourceDir, { recursive: true, force: true });
    try {
      run("pnpm", ["--filter", "@x-file/server", "--prod", "deploy", serverResourceDir], {
        env: deployEnv
      });
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      console.error(`[x-file bundle] pnpm deploy 第 ${attempt} 次失败：${String(error.message || error)}`);
    }
  }
  if (lastError) {
    throw lastError;
  }

  const entry = join(serverResourceDir, "dist", "main.js");
  if (!existsSync(entry)) {
    throw new Error(`后端入口不存在：${entry}`);
  }

  writeFileSync(
    join(serverResourceDir, "bundle-manifest.json"),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        nodeVersion: runWithOutput(nodeBin, ["-v"]),
        entry: "dist/main.js",
        packageName: "@x-file/server"
      },
      null,
      2
    ) + "\n"
  );
}

function smokeTest(nodeBin) {
  const script = [
    "import('fastify').then(() => import('@x-file/indexer')).then(() => { console.log('ok') }).catch((error) => { console.error(error); process.exit(1); })"
  ].join("\n");
  run(nodeBin, ["--input-type=module", "-e", script], { cwd: serverResourceDir, env: { NODE_ENV: "production" } });
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
deployServer(nodeBin);
smokeTest(nodeBin);

console.log(`[x-file bundle] 后端资源：${serverResourceDir} (${directorySize(serverResourceDir)})`);
console.log(`[x-file bundle] Node 运行时：${runtimeResourceDir} (${directorySize(runtimeResourceDir)})`);
