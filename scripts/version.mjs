#!/usr/bin/env node
// X-File 版本管理命令：VERSION 是唯一真源，其他受管理文件由脚本同步。

import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const rootDir = path.resolve(path.dirname(scriptPath), "..");
const versionFilePath = path.join(rootDir, "VERSION");

const jsonTargets = [
  "package.json",
  "apps/web/package.json",
  "apps/server/package.json",
  "apps/desktop/package.json",
  "apps/desktop/src-tauri/tauri.conf.json",
];

const cargoTargets = ["apps/desktop/src-tauri/Cargo.toml"];
const cargoLockTargets = [
  { relativePath: "apps/desktop/src-tauri/Cargo.lock", packageName: "x-file-desktop" },
];

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const command = process.argv[2] ?? "check";

  try {
    switch (command) {
      case "set":
        await setVersion(readVersionArgument());
        break;
      case "sync":
        await syncVersion();
        break;
      case "check":
        await checkVersion(readOption("--tag"));
        break;
      default:
        printUsage();
        process.exitCode = 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export function isValidSemver(input) {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(input);
}

export function normalizeTagVersion(tag) {
  const normalized = String(tag ?? "").trim().replace(/^v/, "");
  if (!isValidSemver(normalized)) {
    throw new Error(`Git tag 不是合法版本号：${tag}`);
  }
  return normalized;
}

async function setVersion(nextVersion) {
  if (!isValidSemver(String(nextVersion ?? ""))) {
    throw new Error(`版本号不合法：${nextVersion ?? ""}`);
  }

  await writeFile(versionFilePath, `${nextVersion}\n`, "utf8");
  await syncVersion();
}

async function syncVersion() {
  const version = await readVersion();
  const changedFiles = [];

  for (const relativePath of jsonTargets) {
    if (await syncJsonVersion(relativePath, version)) {
      changedFiles.push(relativePath);
    }
  }

  for (const relativePath of cargoTargets) {
    if (await syncCargoVersion(relativePath, version)) {
      changedFiles.push(relativePath);
    }
  }

  for (const target of cargoLockTargets) {
    if (await syncCargoLockVersion(target.relativePath, target.packageName, version)) {
      changedFiles.push(target.relativePath);
    }
  }

  if (changedFiles.length === 0) {
    console.log(`版本已同步，无需更新：${version}`);
    return;
  }

  console.log(`已同步产品版本到 ${version}`);
  changedFiles.forEach((relativePath) => console.log(`- ${relativePath}`));
}

async function checkVersion(tag) {
  const version = await readVersion();
  const mismatches = [];

  for (const relativePath of jsonTargets) {
    const json = JSON.parse(await readFile(path.join(rootDir, relativePath), "utf8"));
    if (json.version !== version) {
      mismatches.push(`${relativePath}: ${json.version ?? "<missing>"}`);
    }
  }

  for (const relativePath of cargoTargets) {
    const source = await readFile(path.join(rootDir, relativePath), "utf8");
    const actual = source.match(/\[package\][\s\S]*?\r?\nversion = "([^"]+)"/)?.[1];
    if (actual !== version) {
      mismatches.push(`${relativePath}: ${actual ?? "<missing>"}`);
    }
  }

  for (const target of cargoLockTargets) {
    if (!(await fileExists(target.relativePath))) {
      continue;
    }
    const source = await readFile(path.join(rootDir, target.relativePath), "utf8");
    const pattern = new RegExp(
      `\\[\\[package\\]\\]\\r?\\nname = "${escapeRegExp(target.packageName)}"\\r?\\nversion = "([^"]+)"`,
    );
    const actual = source.match(pattern)?.[1];
    if (actual !== version) {
      mismatches.push(`${target.relativePath} (${target.packageName}): ${actual ?? "<missing>"}`);
    }
  }

  if (tag) {
    const tagVersion = normalizeTagVersion(tag);
    if (tagVersion !== version) {
      mismatches.push(`tag ${tag}: ${tagVersion}，VERSION: ${version}`);
    }
  }

  if (mismatches.length > 0) {
    throw new Error(`版本检查失败：\n${mismatches.map((item) => `- ${item}`).join("\n")}`);
  }

  console.log(`版本检查通过：${version}${tag ? `（tag ${tag}）` : ""}`);
}

async function readVersion() {
  const version = (await readFile(versionFilePath, "utf8")).trim();
  if (!isValidSemver(version)) {
    throw new Error(`VERSION 文件中的版本号不合法：${version}`);
  }
  return version;
}

async function syncJsonVersion(relativePath, version) {
  const filePath = path.join(rootDir, relativePath);
  const json = JSON.parse(await readFile(filePath, "utf8"));
  if (json.version === version) {
    return false;
  }
  json.version = version;
  await writeFile(filePath, `${JSON.stringify(json, null, 2)}\n`, "utf8");
  return true;
}

async function syncCargoVersion(relativePath, version) {
  const filePath = path.join(rootDir, relativePath);
  const source = await readFile(filePath, "utf8");
  const nextSource = source.replace(
    /(\[package\][\s\S]*?\r?\nversion = ")([^"]+)(")/,
    `$1${version}$3`,
  );
  if (nextSource === source) {
    return false;
  }
  await writeFile(filePath, nextSource, "utf8");
  return true;
}

async function syncCargoLockVersion(relativePath, packageName, version) {
  if (!(await fileExists(relativePath))) {
    console.warn(`跳过不存在的文件：${relativePath}（首次构建生成后再同步）`);
    return false;
  }

  const filePath = path.join(rootDir, relativePath);
  const source = await readFile(filePath, "utf8");
  const nextSource = source.replace(
    new RegExp(
      `(\\[\\[package\\]\\]\\r?\\nname = "${escapeRegExp(packageName)}"\\r?\\nversion = ")([^"]+)(")`,
    ),
    `$1${version}$3`,
  );
  if (nextSource === source) {
    return false;
  }
  await writeFile(filePath, nextSource, "utf8");
  return true;
}

async function fileExists(relativePath) {
  try {
    await access(path.join(rootDir, relativePath));
    return true;
  } catch {
    return false;
  }
}

function readOption(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function readVersionArgument() {
  const first = process.argv[3];
  return first === "--" ? process.argv[4] : first;
}

function escapeRegExp(input) {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function printUsage() {
  console.error("用法：node scripts/version.mjs set <version> | sync | check [--tag <tag>]");
}
