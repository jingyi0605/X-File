import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  FileScanner,
  loadRuntimeConfig,
  normalizeIncludedHiddenPaths,
} from "@x-file/indexer";

import { createServer } from "../app.js";

/**
 * 第 11 批基础合约测试：锁住旧文档库索引配置文件位置、扩展名、隐藏目录白名单和大文件阈值语义。
 */
test("第 11 批基础合约：索引器运行时配置兼容旧配置文件并规范化输入", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "x-file-foundation-config-"));
  const indexDir = path.join(rootDir, ".ai-index");
  fs.mkdirSync(indexDir, { recursive: true });
  fs.writeFileSync(
    path.join(indexDir, "doc-semantic-index.config.json"),
    JSON.stringify({
      allowedExtensions: ["MD", ".PDF", "md"],
      includedHiddenPaths: [".obsidian", ".obsidian", "docs/.secret", ".ai-index"],
      maxFileSizeBytes: 1024,
      parserTimeoutMs: 777,
      watchDebounceMs: 333,
    }),
    "utf8",
  );

  const config = loadRuntimeConfig(rootDir);

  assert.equal(config.rootDir, rootDir);
  assert.equal(config.configFilePath, path.join(indexDir, "doc-semantic-index.config.json"));
  assert.deepEqual(config.allowedExtensions, [".md", ".pdf"]);
  assert.deepEqual(config.includedHiddenPaths, [".obsidian", "docs/.secret"]);
  assert.equal(config.maxFileSizeBytes, 1024);
  assert.equal(config.parserTimeoutMs, 777);
  assert.equal(config.watchDebounceMs, 333);
});

/**
 * 第 11 批基础合约测试：扫描器必须延续旧文档库的大目录安全策略，默认跳过隐藏目录，允许显式白名单，但永远不索引 .ai-index。
 */
test("第 11 批基础合约：文件扫描器拒绝扫描 rootDir 外的 targetPath", () => {
  const parentDir = fs.mkdtempSync(path.join(os.tmpdir(), "x-file-foundation-boundary-"));
  const rootDir = path.join(parentDir, "library");
  fs.mkdirSync(rootDir, { recursive: true });
  fs.writeFileSync(path.join(rootDir, "inside.md"), "inside", "utf8");
  fs.writeFileSync(path.join(parentDir, "outside.md"), "outside", "utf8");

  const scanner = new FileScanner(rootDir, { allowedExtensions: [".md"] });

  assert.deepEqual(scanner.scan("inside.md").map((item) => item.relativePath), ["inside.md"]);
  assert.deepEqual(scanner.scan("../outside.md"), []);
  assert.deepEqual(scanner.scan(path.join(parentDir, "outside.md")), []);
});

test("第 11 批基础合约：文件扫描器跳过隐藏目录并只放行显式白名单", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "x-file-foundation-scan-"));
  fs.mkdirSync(path.join(rootDir, "docs", ".secret"), { recursive: true });
  fs.mkdirSync(path.join(rootDir, ".obsidian"), { recursive: true });
  fs.mkdirSync(path.join(rootDir, ".ai-index"), { recursive: true });
  fs.writeFileSync(path.join(rootDir, "visible.md"), "visible", "utf8");
  fs.writeFileSync(path.join(rootDir, "docs", ".secret", "kept.md"), "secret", "utf8");
  fs.writeFileSync(path.join(rootDir, ".obsidian", "vault.md"), "vault", "utf8");
  fs.writeFileSync(path.join(rootDir, ".ai-index", "leak.md"), "index", "utf8");
  fs.writeFileSync(path.join(rootDir, "ignored.exe"), "exe", "utf8");

  assert.deepEqual(
    normalizeIncludedHiddenPaths([".obsidian", "docs/.secret", ".ai-index", "docs", "../bad"]),
    [".obsidian", "docs/.secret"],
  );

  const defaultPaths = new FileScanner(rootDir, { allowedExtensions: [".md"] })
    .scan()
    .map((item) => item.relativePath);
  assert.deepEqual(defaultPaths, ["visible.md"]);

  const includedPaths = new FileScanner(rootDir, {
    allowedExtensions: [".md"],
    includedHiddenPaths: [".obsidian", "docs/.secret", ".ai-index"],
  })
    .scan()
    .map((item) => item.relativePath)
    .sort((left, right) => left.localeCompare(right, "zh-Hans-CN"));

  assert.deepEqual(includedPaths, [".obsidian/vault.md", "docs/.secret/kept.md", "visible.md"]);
});

/**
 * 第 11 批基础合约测试：X-File 新路由必须保留旧文档库启用状态语义，配置保存后 DTO、binding 与后续快照一致。
 */
test("第 11 批基础合约：资料库配置路由持久化 enabled 并同步到快照 binding", async () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "x-file-foundation-home-"));
  const previousHome = process.env.HOME;
  process.env.HOME = tempHome;
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "x-file-foundation-library-"));
  const app = createServer({ httpServerRuntimeState: { running: false } });

  try {
    const bindResponse = await app.inject({
      method: "PUT",
      url: "/api/library/binding",
      payload: { rootDir },
    });
    assert.equal(bindResponse.statusCode, 200);
    assert.equal(bindResponse.json().enabled, true);

    const saveConfigResponse = await app.inject({
      method: "PUT",
      url: "/api/library/config",
      payload: {
        enabled: false,
        allowedExtensions: ["md", ".PDF", ".md"],
        includedHiddenPaths: [".obsidian", ".obsidian", "docs/.secret"],
        folderOpenBehavior: "single_click",
      },
    });
    assert.equal(saveConfigResponse.statusCode, 200);
    const config = saveConfigResponse.json();
    assert.equal(config.enabled, false);
    assert.equal(config.binding.enabled, false);
    assert.deepEqual(config.allowedExtensions, [".md", ".pdf"]);
    assert.deepEqual(config.includedHiddenPaths, [".obsidian", "docs/.secret"]);
    assert.equal(config.folderOpenBehavior, "single_click");

    const snapshotResponse = await app.inject({ method: "GET", url: "/api/library/snapshot" });
    assert.equal(snapshotResponse.statusCode, 200);
    assert.equal(snapshotResponse.json().binding.enabled, false);
  } finally {
    await app.close();
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
  }
});
