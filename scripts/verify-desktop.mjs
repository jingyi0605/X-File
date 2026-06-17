#!/usr/bin/env node
import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const platform = readArgValue("--platform") ?? detectDefaultPlatform();
const mode = readArgValue("--mode") ?? "full";
const requireRealSecrets =
  process.argv.slice(2).includes("--require-real-secrets") ||
  process.env.X_FILE_REQUIRE_RELEASE_SECRETS === "1";

const failures = [];
const warnings = [];

switch (mode) {
  case "preflight":
    logStep(`执行桌面前置检查。platform=${platform}`);
    runCommonChecks();
    runReleaseChecks();
    break;
  case "artifacts":
    logStep(`执行桌面产物检查。platform=${platform}`);
    runArtifactChecks();
    break;
  case "full":
    logStep(`执行完整桌面打包验证。platform=${platform}`);
    runCommonChecks();
    runReleaseChecks();
    runFullVerification();
    break;
  default:
    failures.push(`未知 mode：${mode}。可选值：preflight / artifacts / full`);
    break;
}

finish();

function runCommonChecks() {
  logStep("检查 VERSION 与 tauri.conf.json");

  const versionPath = path.join(rootDir, "VERSION");
  if (!existsSync(versionPath)) {
    failures.push("缺少 VERSION 文件。");
    return;
  }

  const version = readFileSync(versionPath, "utf8").trim();
  if (!isValidSemver(version)) {
    failures.push(`VERSION 文件中的版本号不合法：${version}`);
  }

  const configPath = path.join(rootDir, "apps/desktop/src-tauri/tauri.conf.json");
  if (!existsSync(configPath)) {
    failures.push("缺少 apps/desktop/src-tauri/tauri.conf.json。");
    return;
  }

  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const updater = config.plugins?.updater;

  if (!updater) {
    failures.push("缺少 plugins.updater 配置。");
  } else {
    if (config.bundle?.createUpdaterArtifacts !== true) {
      failures.push("bundle.createUpdaterArtifacts 必须为 true。");
    }

    if (!Array.isArray(updater.endpoints) || updater.endpoints.length === 0) {
      failures.push("plugins.updater.endpoints 至少要配置一个 HTTPS 地址。");
    } else {
      for (const endpoint of updater.endpoints) {
        if (!String(endpoint).startsWith("https://")) {
          failures.push(`更新地址必须使用 HTTPS：${endpoint}`);
        }
      }
    }

    if (!updater.pubkey) {
      failures.push("plugins.updater.pubkey 不能为空。");
    } else if (updater.pubkey === "__X_FILE_UPDATER_PUBLIC_KEY__") {
      const message = "plugins.updater.pubkey 仍是占位值，真实发布前必须替换。";
      if (requireRealSecrets) {
        failures.push(message);
      } else {
        warnings.push(message);
      }
    }
  }

  const configVersion = String(config.version ?? "").trim();
  if (configVersion && configVersion !== version) {
    failures.push(`tauri.conf.json 版本与 VERSION 不一致：VERSION=${version} tauri=${configVersion}`);
  }

  checkBundledResourceMapping(config);
}

function checkBundledResourceMapping(config) {
  const resources = config.bundle?.resources;
  if (!resources || typeof resources !== "object") {
    failures.push("bundle.resources 必须声明正式包资源映射。");
    return;
  }

  const requiredMappings = {
    "resources/x-file-library-engine": "x-file-library-engine",
    "resources/x-file-runtime": "x-file-runtime",
    "resources/x-file-plugins": "x-file-plugins",
  };

  for (const [source, target] of Object.entries(requiredMappings)) {
    if (resources[source] !== target) {
      failures.push(`bundle.resources 缺少或错误映射：${source} -> ${target}`);
    }
  }

  if ("resources/x-file-server" in resources) {
    failures.push("正式包 bundle.resources 不应再声明 resources/x-file-server。");
  }

  const boundaryManifestPath = path.join(
    rootDir,
    "apps/desktop/src-tauri/resources/x-file-resource-boundary.json",
  );
  if (!existsSync(boundaryManifestPath)) {
    warnings.push("缺少 x-file-resource-boundary.json；如刚改过打包脚本，请先执行 prepare-bundled-server。");
    return;
  }

  try {
    const boundaryManifest = JSON.parse(readFileSync(boundaryManifestPath, "utf8"));
    const resourcesConfig = boundaryManifest.resources;
    if (!resourcesConfig?.["x-file-library-engine"]?.requiredInMainBundle) {
      failures.push("x-file-resource-boundary.json 缺少 x-file-library-engine 主包声明。");
    }
    if (!resourcesConfig?.["x-file-plugins"]?.requiredInMainBundle) {
      failures.push("x-file-resource-boundary.json 缺少 x-file-plugins 主包声明。");
    }
    const hostConfig = boundaryManifest.desktopHost;
    if (hostConfig?.nodeWorkerFallback?.allowHostNodeFallbackByDefault !== false) {
      failures.push("x-file-resource-boundary.json 必须显式声明桌面宿主默认不允许 host Node worker fallback。");
    }
    if (hostConfig?.nodeWorkerFallback?.explicitOptInEnv !== "X_FILE_ENABLE_HOST_NODE_WORKER_FALLBACK") {
      failures.push("x-file-resource-boundary.json 的 host Node worker fallback 显式开关必须是 X_FILE_ENABLE_HOST_NODE_WORKER_FALLBACK。");
    }
    if (hostConfig?.nodeSidecar?.profileInMainBundle !== "sidecar-only") {
      failures.push("x-file-resource-boundary.json 必须显式声明正式包 Node sidecar profile=sidecar-only。");
    }
    if (hostConfig?.nodeSidecar?.libraryCoreHttpRoutesServedByDefault !== false) {
      failures.push("x-file-resource-boundary.json 必须显式声明正式包 Node sidecar 默认不承载 library 核心 HTTP 路由。");
    }
    checkBundledResourceContents(resourcesConfig);
  } catch (error) {
    failures.push(`解析 x-file-resource-boundary.json 失败：${error instanceof Error ? error.message : String(error)}`);
    checkBundledResourceContents();
  }
}

function checkBundledResourceContents(resourcesConfig = undefined) {
  const resourcesRoot = path.join(rootDir, "apps/desktop/src-tauri/resources");
  const runtimeRequired = resourcesConfig?.["x-file-runtime"]?.requiredInMainBundle ?? true;
  const runtimeNodeBin = path.join(resourcesRoot, "x-file-runtime", "node", "bin", process.platform === "win32" ? "node.exe" : "node");
  if (runtimeRequired && !existsSync(runtimeNodeBin)) {
    failures.push(`x-file-runtime 缺少随包 Node 入口：${runtimeNodeBin}`);
  }
  if (!runtimeRequired && existsSync(path.join(resourcesRoot, "x-file-runtime"))) {
    warnings.push("x-file-resource-boundary.json 已声明 x-file-runtime 可省略，但资源目录仍然存在。");
  }

  const legacyServerResourceDir = path.join(resourcesRoot, "x-file-server");
  if (existsSync(legacyServerResourceDir)) {
    failures.push("正式包资源目录不应再出现 x-file-server。");
  }

  const engineRoot = path.join(resourcesRoot, "x-file-library-engine");
  const leakedSourceDirs = [
    path.join(engineRoot, "node_modules", "@x-file", "indexer", "contracts", "src"),
  ].filter(existsSync).map((item) => path.relative(rootDir, item));
  if (leakedSourceDirs.length > 0) {
    failures.push(`x-file-library-engine 不应携带源码残留目录：${leakedSourceDirs.join(", ")}`);
  }

  const leakedTsconfigFiles = [
    path.join(engineRoot, "node_modules", "@x-file", "server", "tsconfig.json"),
    path.join(engineRoot, "node_modules", "@x-file", "shared", "tsconfig.json"),
    path.join(engineRoot, "node_modules", "@x-file", "indexer", "tsconfig.json"),
  ].filter(existsSync).map((item) => path.relative(rootDir, item));
  if (leakedTsconfigFiles.length > 0) {
    failures.push(`x-file-library-engine 不应携带 workspace tsconfig：${leakedTsconfigFiles.join(", ")}`);
  }

  const serverLibraryDistDir = path.join(engineRoot, "node_modules", "@x-file", "server", "dist", "library");
  const leakedTests = collectMatchingFiles(serverLibraryDistDir, /\.test\.(d\.ts|js|js\.map|d\.ts\.map)$/);
  if (leakedTests.length > 0) {
    failures.push(`x-file-library-engine 不应携带 library test 产物：${leakedTests.slice(0, 5).join(", ")}`);
  }
}

function runReleaseChecks() {
  if (!requireRealSecrets) {
    logStep("跳过真实发布 secrets 检查（未启用 --require-real-secrets）");
    return;
  }

  logStep("检查真实发布 secrets");

  const required = [
    ["TAURI_SIGNING_PRIVATE_KEY", "Tauri updater 私钥，用来生成更新包签名"],
    ["TAURI_SIGNING_PRIVATE_KEY_PASSWORD", "Tauri updater 私钥密码；如果私钥无密码，也要显式配置为空字符串"],
    ["X_FILE_UPDATER_PUBLIC_KEY", "Tauri updater 公钥，必须和 tauri.conf.json 的 plugins.updater.pubkey 一致"],
    ["X_FILE_UPDATER_ENDPOINT", "真实更新清单地址，需要和 tauri.conf.json 的 updater endpoint 对齐"],
  ];
  const optional = [];

  if (isWindowsPlatform(platform)) {
    optional.push(
      ["WINDOWS_SIGNING_CERTIFICATE", "Windows 代码签名证书；不影响 Tauri updater 正常更新，只影响发布者可信度"],
      ["WINDOWS_SIGNING_CERTIFICATE_PASSWORD", "Windows 代码签名证书密码"],
    );
  }

  const config = JSON.parse(
    readFileSync(path.join(rootDir, "apps/desktop/src-tauri/tauri.conf.json"), "utf8"),
  );
  const updater = config.plugins?.updater;

  for (const [name, description] of required) {
    if (process.env[name] === undefined) {
      failures.push(`缺少环境变量 ${name}：${description}`);
    }
  }

  for (const [name, description] of optional) {
    if (process.env[name] === undefined) {
      warnings.push(`未配置可选环境变量 ${name}：${description}`);
    }
  }

  if (
    process.env.X_FILE_UPDATER_PUBLIC_KEY &&
    updater?.pubkey &&
    updater.pubkey !== process.env.X_FILE_UPDATER_PUBLIC_KEY
  ) {
    failures.push("X_FILE_UPDATER_PUBLIC_KEY 和 tauri.conf.json 的 plugins.updater.pubkey 不一致。");
  }

  const configuredEndpoint = updater?.endpoints?.[0];
  if (
    process.env.X_FILE_UPDATER_ENDPOINT &&
    configuredEndpoint &&
    configuredEndpoint !== process.env.X_FILE_UPDATER_ENDPOINT
  ) {
    warnings.push("X_FILE_UPDATER_ENDPOINT 和 tauri.conf.json 的第一个 updater endpoint 不一致（双通道下仅作提醒）。");
  }
}

function runFullVerification() {
  if (failures.length > 0) {
    return;
  }

  if (isWindowsPlatform(platform)) {
    if (!isWindowsHost()) {
      failures.push("完整 Windows 桌面打包验证必须在 Windows 环境执行。");
      return;
    }
    runScript("bash", ["scripts/package-desktop.sh", "windows", "--skip-preflight"], "执行 Windows 桌面打包");
    runArtifactChecks();
    return;
  }

  if (isMacosPlatform(platform)) {
    runScript("bash", ["scripts/package-desktop.sh", "macos", "--skip-preflight"], "执行 macOS 桌面打包");
    runArtifactChecks();
    return;
  }

  failures.push(`不支持的平台：${platform}`);
}

function runArtifactChecks() {
  logStep(`检查桌面构建产物。platform=${platform}`);

  const version = readFileSync(path.join(rootDir, "VERSION"), "utf8").trim();

  if (isMacosPlatform(platform)) {
    const dmgPath = path.join(
      rootDir,
      "apps/desktop/src-tauri/target/release/macos-release/X-File.dmg",
    );
    if (!existsSync(dmgPath)) {
      failures.push(`缺少 macOS DMG 产物：${dmgPath}`);
    }

    const macUpdaterRoot = path.join(
      rootDir,
      "apps/desktop/src-tauri/target/universal-apple-darwin/release/bundle/macos",
    );
    const macUpdaterArtifact = findFirstExisting(macUpdaterRoot, ".app.tar.gz");
    const macUpdaterSignature = findFirstExisting(macUpdaterRoot, ".sig");
    if (!macUpdaterArtifact) {
      failures.push(`缺少 macOS updater 产物：${macUpdaterRoot}/*.app.tar.gz`);
    }
    if (!macUpdaterSignature) {
      failures.push(`缺少 macOS updater 签名：${macUpdaterRoot}/*.sig`);
    }
    return;
  }

  if (isWindowsPlatform(platform)) {
    const bundleRoot = path.join(
      rootDir,
      "apps/desktop/src-tauri/target/x86_64-pc-windows-msvc/release/bundle",
    );
    const nsisDir = path.join(bundleRoot, "nsis");
    const msiDir = path.join(bundleRoot, "msi");
    const exeCount = countFiles(nsisDir, ".exe");
    const msiCount = countFiles(msiDir, ".msi");

    if (exeCount === 0) {
      failures.push("Windows 构建没有产出 NSIS 安装包。");
    }

    if (version.includes("-")) {
      if (msiCount !== 0) {
        failures.push(`预发布版本 ${version} 不应产出 MSI。`);
      }
    } else if (msiCount === 0) {
      failures.push(`稳定版 ${version} 必须产出 MSI。`);
    }
  }
}

function finish() {
  if (failures.length > 0) {
    console.error("X-File 桌面验证失败：");
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    if (warnings.length > 0) {
      console.error("");
      console.error("附加提醒：");
      for (const warning of warnings) {
        console.error(`- ${warning}`);
      }
    }
    process.exit(1);
  }

  if (warnings.length > 0) {
    console.warn("X-File 桌面验证提醒：");
    for (const warning of warnings) {
      console.warn(`- ${warning}`);
    }
  }

  console.log(`X-File 桌面验证通过。platform=${platform} mode=${mode}`);
}

function runScript(command, args, title) {
  logStep(title);
  execFileSync(command, args, {
    cwd: rootDir,
    stdio: "inherit",
    env: process.env,
  });
}

function logStep(message) {
  console.log(`[verify-desktop] ${message}`);
}

function readArgValue(name) {
  const argv = process.argv.slice(2);
  const prefix = `${name}=`;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === name) {
      return argv[index + 1];
    }
    if (token.startsWith(prefix)) {
      return token.slice(prefix.length);
    }
  }
  return undefined;
}

function detectDefaultPlatform() {
  if (isWindowsHost()) {
    return "windows";
  }
  if (process.platform === "darwin") {
    return "macos";
  }
  return process.platform;
}

function isValidSemver(input) {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(input);
}

function isWindowsPlatform(value) {
  const normalized = String(value).toLowerCase();
  return normalized === "win32" || normalized === "windows" || normalized.startsWith("windows-");
}

function isMacosPlatform(value) {
  const normalized = String(value).toLowerCase();
  return normalized === "darwin" || normalized === "macos" || normalized.startsWith("macos-");
}

function isWindowsHost() {
  return process.platform === "win32" || process.env.OS === "Windows_NT";
}

function countFiles(dirPath, suffix) {
  if (!existsSync(dirPath)) {
    return 0;
  }
  return readdirSync(dirPath).filter((name) => name.endsWith(suffix)).length;
}

function findFirstExisting(dirPath, suffix) {
  if (!existsSync(dirPath)) {
    return null;
  }
  return readdirSync(dirPath).find((name) => name.endsWith(suffix)) ?? null;
}

function collectMatchingFiles(dirPath, pattern) {
  if (!existsSync(dirPath)) {
    return [];
  }
  const results = [];
  walkFiles(dirPath, (filePath) => {
    if (pattern.test(filePath)) {
      results.push(path.relative(rootDir, filePath));
    }
  });
  return results;
}

function walkFiles(dirPath, visitor) {
  for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      walkFiles(fullPath, visitor);
      continue;
    }
    visitor(fullPath);
  }
}
