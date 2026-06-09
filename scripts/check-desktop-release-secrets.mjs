#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const platform = readArgValue("--platform") ?? process.platform;
const requireRealSecrets =
  args.has("--require-real-secrets") || process.env.X_FILE_REQUIRE_RELEASE_SECRETS === "1";

const configPath = path.join(rootDir, "apps/desktop/src-tauri/tauri.conf.json");
const configText = readFileSync(configPath, "utf8");
const config = JSON.parse(configText);
const updater = config.plugins?.updater;

const warnings = [];
const required = [
  ["TAURI_SIGNING_PRIVATE_KEY", "Tauri updater 私钥，用来生成更新包签名"],
  ["TAURI_SIGNING_PRIVATE_KEY_PASSWORD", "Tauri updater 私钥密码；如果私钥无密码，也要显式配置为空字符串"],
  ["X_FILE_UPDATER_PUBLIC_KEY", "Tauri updater 公钥，必须同步写入 tauri.conf.json 的 plugins.updater.pubkey"],
  ["X_FILE_UPDATER_ENDPOINT", "真实更新清单地址，需要和 tauri.conf.json 的 endpoints 对齐"],
];

const optional = [];

if (isWindowsPlatform(platform)) {
  optional.push(
    ["WINDOWS_SIGNING_CERTIFICATE", "Windows 代码签名证书；不影响 Tauri updater 验签更新，只影响安装包发布者可信度"],
    ["WINDOWS_SIGNING_CERTIFICATE_PASSWORD", "Windows 代码签名证书密码"],
  );
}

const failures = [];

if (!updater) {
  failures.push("缺少 plugins.updater 配置。");
} else {
  if (config.bundle?.createUpdaterArtifacts !== true) {
    failures.push("bundle.createUpdaterArtifacts 必须为 true，发布构建才会产出 updater artifacts。");
  }

  if (!Array.isArray(updater.endpoints) || updater.endpoints.length === 0) {
    failures.push("plugins.updater.endpoints 至少要配置一个 HTTPS 地址。");
  }

  for (const endpoint of updater.endpoints ?? []) {
    if (!String(endpoint).startsWith("https://")) {
      failures.push(`更新地址必须使用 HTTPS：${endpoint}`);
    }
  }

  if (!updater.pubkey) {
    failures.push("plugins.updater.pubkey 不能为空。");
  } else if (updater.pubkey === "__X_FILE_UPDATER_PUBLIC_KEY__") {
    const message = "plugins.updater.pubkey 仍是占位值，真实发布前必须替换为 Tauri CLI 生成的公钥。";
    if (requireRealSecrets) {
      failures.push(message);
    } else {
      warnings.push(message);
    }
  }
}

if (requireRealSecrets) {
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
    failures.push("X_FILE_UPDATER_ENDPOINT 和 tauri.conf.json 的第一个 updater endpoint 不一致。");
  }
}

if (failures.length > 0) {
  console.error("X-File 桌面发布前置检查失败：");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  console.error("");
  console.error("说明：普通骨架构建可以不带真实 secrets；Tauri updater 签名、自动更新或 Windows 实机构建必须带 --require-real-secrets。Windows 代码签名证书是可选项，不影响 updater 正常更新。");
  process.exit(1);
}

if (warnings.length > 0) {
  console.warn("X-File 桌面发布前置检查提醒：");
  for (const warning of warnings) {
    console.warn(`- ${warning}`);
  }
}

console.log("X-File 桌面发布前置检查通过。");

function readArgValue(name) {
  const prefix = `${name}=`;
  const found = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

function isWindowsPlatform(value) {
  const normalized = String(value).toLowerCase();
  return normalized === "win32" || normalized === "windows" || normalized.startsWith("windows-");
}
