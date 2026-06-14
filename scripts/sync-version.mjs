#!/usr/bin/env node
// X-File 版本同步脚本：以根目录 VERSION 文件为唯一真源，把版本号写入所有需要的地方。
// 用法：修改 VERSION 后执行 `pnpm version:sync`，再 commit + 打 tag。
// 参考父项目 CodingNS 的 scripts/sync-version.mjs（去掉 iOS / Android / 移动端 Tauri 相关）。

import { readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const versionFilePath = path.join(rootDir, 'VERSION');

// JSON 文件（package.json / tauri.conf.json）的 version 字段
const jsonTargets = [
  'package.json',
  'apps/web/package.json',
  'apps/server/package.json',
  'apps/desktop/package.json',
  'apps/desktop/src-tauri/tauri.conf.json',
];

// Cargo.toml 的 [package] version
const cargoTargets = ['apps/desktop/src-tauri/Cargo.toml'];

// Cargo.lock 中 [[package]] name=<packageName> 的 version
const cargoLockTargets = [
  { relativePath: 'apps/desktop/src-tauri/Cargo.lock', packageName: 'x-file-desktop' },
];

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

for (const { relativePath, packageName } of cargoLockTargets) {
  if (await syncCargoLockVersion(relativePath, packageName, version)) {
    changedFiles.push(relativePath);
  }
}

if (changedFiles.length === 0) {
  console.log(`版本已同步，无需更新：${version}`);
} else {
  console.log(`已同步产品版本到 ${version}`);
  for (const relativePath of changedFiles) {
    console.log(`- ${relativePath}`);
  }
}

async function fileExists(relativePath) {
  try {
    await access(path.join(rootDir, relativePath));
    return true;
  } catch {
    return false;
  }
}

async function readVersion() {
  const rawVersion = (await readFile(versionFilePath, 'utf8')).trim();
  if (!isValidSemver(rawVersion)) {
    throw new Error(`VERSION 文件中的版本号不合法：${rawVersion}`);
  }
  return rawVersion;
}

function isValidSemver(input) {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(input);
}

async function syncJsonVersion(relativePath, nextVersion) {
  const filePath = path.join(rootDir, relativePath);
  const source = await readFile(filePath, 'utf8');
  const json = JSON.parse(source);

  if (json.version === nextVersion) {
    return false;
  }

  json.version = nextVersion;
  await writeFile(filePath, `${JSON.stringify(json, null, 2)}\n`, 'utf8');
  return true;
}

async function syncCargoVersion(relativePath, nextVersion) {
  const filePath = path.join(rootDir, relativePath);
  const source = await readFile(filePath, 'utf8');
  const nextSource = source.replace(
    /(\[package\][\s\S]*?\nversion = ")([^"]+)(")/,
    `$1${nextVersion}$3`,
  );

  if (nextSource === source) {
    return false;
  }

  await writeFile(filePath, nextSource, 'utf8');
  return true;
}

async function syncCargoLockVersion(relativePath, packageName, nextVersion) {
  if (!(await fileExists(relativePath))) {
    console.warn(`跳过不存在的文件：${relativePath}（首次构建生成后再同步）`);
    return false;
  }

  const filePath = path.join(rootDir, relativePath);
  const source = await readFile(filePath, 'utf8');
  const nextSource = source.replace(
    new RegExp(
      `(\\[\\[package\\]\\]\\nname = "${escapeRegExp(packageName)}"\\nversion = ")([^"]+)(")`,
    ),
    `$1${nextVersion}$3`,
  );

  if (nextSource === source) {
    return false;
  }

  await writeFile(filePath, nextSource, 'utf8');
  return true;
}

function escapeRegExp(input) {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
