import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createLibraryRuntimeConfig,
  prepareLibraryIndexRuntime,
  runLibraryExportOnce,
  runLibraryIndexOnce,
  runLibraryTextIndex,
} from "@x-file/indexer";

import type { LibraryBinding, LibraryIndexStatus } from "@x-file/shared";

import { LibraryExportReader } from "../storage/library-export-reader.js";

test("索引工具能产出后端可读取的文档库 export", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "x-file-index-reader-"));
  fs.mkdirSync(path.join(rootDir, "docs"));
  fs.writeFileSync(path.join(rootDir, "docs", "hello.md"), "# Hello\n\nX-File 端到端索引验证", "utf8");

  const result = await runLibraryIndexOnce({
    rootDir,
    allowedExtensions: [".md"],
    reason: "server_index_e2e"
  });

  assert.equal(fs.existsSync(path.join(rootDir, ".ai-index", "exports", "manifest.json")), true);
  assert.equal(typeof result.fallbackMode, "boolean");

  const reader = new LibraryExportReader();
  const binding = createBinding(rootDir);
  const snapshot = reader.readSnapshot(binding, createFreshStatus());
  const documents = reader.listDocuments(binding, {
    browseMode: "folder",
    selectedFolderPath: "docs",
    offset: 0,
    limit: 10
  });

  assert.equal(snapshot.documentCount, 1);
  assert.deepEqual(documents.items.map((document) => document.path), ["docs/hello.md"]);
});

function createBinding(rootDir: string): LibraryBinding {
  return {
    libraryId: "default",
    rootDir,
    enabled: true,
    mirrorRoot: null,
    allowedExtensions: [".md"],
    includedHiddenPaths: [],
    folderOpenBehavior: "double_click",
    configRelativePath: ".ai-index/doc-semantic-index.config.json",
    exportMode: "v2",
    initialized: true,
    initializedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function createFreshStatus(): LibraryIndexStatus {
  return {
    state: "fresh",
    dirtyReasons: [],
    lastRequestedAt: null,
    lastStartedAt: null,
    lastCompletedAt: null,
    lastFailedAt: null,
    nextAllowedAt: null,
    runningTaskId: null,
    runningStage: null,
    errorSummary: null,
    workerHealth: null,
    progress: null
  };
}


test("索引会跳过超过大小上限的文件并继续产出可读取 export", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "x-file-index-large-skip-"));
  fs.writeFileSync(path.join(rootDir, "small.md"), "ok", "utf8");
  fs.writeFileSync(path.join(rootDir, "large.md"), "0123456789abcdef", "utf8");

  fs.mkdirSync(path.join(rootDir, ".ai-index"), { recursive: true });
  fs.writeFileSync(path.join(rootDir, ".ai-index", "doc-semantic-index.config.json"), JSON.stringify({
    maxFileSizeBytes: 8,
  }), "utf8");

  const result = await runLibraryIndexOnce({
    rootDir,
    allowedExtensions: [".md"],
    reason: "large_file_skip_test",
  });

  assert.equal(result.index.scannedCount, 2);
  assert.equal(result.index.indexedCount, 1);
  assert.equal(result.index.skipStats.skippedCount, 1);

  const reader = new LibraryExportReader();
  const documents = reader.listDocuments(createBinding(rootDir), {
    browseMode: "folder",
    selectedFolderPath: ".",
    offset: 0,
    limit: 10,
  });
  assert.deepEqual(documents.items.map((document) => document.path), ["small.md"]);
});

test("增量索引会返回限定 targetPath 的 dirty scope", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "x-file-index-dirty-scope-"));
  fs.mkdirSync(path.join(rootDir, "docs"), { recursive: true });
  fs.writeFileSync(path.join(rootDir, "docs", "a.md"), "# A", "utf8");
  fs.writeFileSync(path.join(rootDir, "docs", "b.md"), "# B", "utf8");

  await runLibraryIndexOnce({ rootDir, allowedExtensions: [".md"], reason: "initial" });
  fs.writeFileSync(path.join(rootDir, "docs", "a.md"), "# A\n\n更新后只应该污染 a", "utf8");

  const result = await runLibraryIndexOnce({
    rootDir,
    targetPath: "docs/a.md",
    allowedExtensions: [".md"],
    reason: "dirty_scope_test",
  });

  assert.equal(result.index.dirtyScope.trigger, "incremental");
  assert.deepEqual(result.index.dirtyScope.changedPaths, ["docs/a.md"]);
  assert.deepEqual(result.index.dirtyScope.dirtyDirectories, ["docs"]);
  assert.equal(result.index.deletedCount, 0);
});

test("export 可以从 full worker 中拆出并独立执行", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "x-file-export-only-"));
  fs.mkdirSync(path.join(rootDir, "docs"), { recursive: true });
  fs.writeFileSync(path.join(rootDir, "docs", "a.md"), "# A", "utf8");
  fs.writeFileSync(path.join(rootDir, "docs", "b.md"), "# B", "utf8");

  const prepared = prepareLibraryIndexRuntime({
    rootDir,
    allowedExtensions: [".md"],
  });
  const index = await runLibraryTextIndex({
    config: prepared.config,
    allowedExtensions: [".md"],
  });
  const snapshotPath = path.join(rootDir, ".ai-index", "runtime", "export-catalog-snapshot.json");
  assert.equal(fs.existsSync(snapshotPath), true);
  const exportResult = await runLibraryExportOnce({
    config: prepared.config,
    dirtyScope: index.dirtyScope,
    reason: "export_only_test",
  });

  assert.equal(fs.existsSync(path.join(rootDir, ".ai-index", "exports", "manifest.json")), true);
  assert.equal(exportResult.resolvedDataSourceMode, "snapshot");
  assert.equal(exportResult.requestedDataSourceMode, "snapshot");
  assert.equal(exportResult.exportResult.outputDir, path.join(rootDir, ".ai-index", "exports"));

  const reader = new LibraryExportReader();
  const binding = createBinding(rootDir);
  const documents = reader.listDocuments(binding, {
    browseMode: "folder",
    selectedFolderPath: "docs",
    offset: 0,
    limit: 10,
  });
  assert.deepEqual(documents.items.map((document) => document.path), ["docs/a.md", "docs/b.md"]);
});

test("export 可以优先消费 index 阶段写出的 catalog snapshot", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "x-file-export-snapshot-"));
  fs.mkdirSync(path.join(rootDir, "docs"), { recursive: true });
  fs.writeFileSync(path.join(rootDir, "docs", "a.md"), "# A", "utf8");
  fs.writeFileSync(path.join(rootDir, "docs", "b.md"), "# B", "utf8");

  const prepared = prepareLibraryIndexRuntime({
    rootDir,
    allowedExtensions: [".md"],
  });
  const index = await runLibraryTextIndex({
    config: prepared.config,
    allowedExtensions: [".md"],
  });
  const snapshotPath = path.join(rootDir, ".ai-index", "runtime", "export-catalog-snapshot.json");
  assert.equal(fs.existsSync(snapshotPath), true);
  fs.unlinkSync(prepared.config.dbPath);

  const config = createLibraryRuntimeConfig({
    rootDir,
    allowedExtensions: [".md"],
  });
  const exportResult = await runLibraryExportOnce({
    config,
    dirtyScope: index.dirtyScope,
    reason: "export_snapshot_test",
    dataSourceMode: "snapshot",
  });

  assert.equal(fs.existsSync(path.join(rootDir, ".ai-index", "exports", "manifest.json")), true);
  assert.equal(exportResult.resolvedDataSourceMode, "snapshot");
  assert.equal(exportResult.requestedDataSourceMode, "snapshot");
  assert.equal(exportResult.exportResult.outputDir, path.join(rootDir, ".ai-index", "exports"));

  const reader = new LibraryExportReader();
  const documents = reader.listDocuments(createBinding(rootDir), {
    browseMode: "folder",
    selectedFolderPath: "docs",
    offset: 0,
    limit: 10,
  });
  assert.deepEqual(documents.items.map((document) => document.path), ["docs/a.md", "docs/b.md"]);
});

test("snapshot 主路径缺失时 export-only 会报出明确错误，不做静默 sqlite 回退", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "x-file-export-snapshot-required-"));
  fs.mkdirSync(path.join(rootDir, "docs"), { recursive: true });
  fs.writeFileSync(path.join(rootDir, "docs", "a.md"), "# A", "utf8");

  const prepared = prepareLibraryIndexRuntime({
    rootDir,
    allowedExtensions: [".md"],
  });
  const index = await runLibraryTextIndex({
    config: prepared.config,
    allowedExtensions: [".md"],
  });
  fs.rmSync(path.join(rootDir, ".ai-index", "runtime", "export-catalog-snapshot.json"), { force: true });

  await assert.rejects(
    runLibraryExportOnce({
      config: prepared.config,
      dirtyScope: index.dirtyScope,
      reason: "export_snapshot_required_test",
      dataSourceMode: "snapshot",
    }),
    /export catalog snapshot 不存在/,
  );
});

test("只有显式 auto 模式才会在 snapshot 缺失时退回 sqlite", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "x-file-export-auto-fallback-"));
  fs.mkdirSync(path.join(rootDir, "docs"), { recursive: true });
  fs.writeFileSync(path.join(rootDir, "docs", "a.md"), "# A", "utf8");

  const prepared = prepareLibraryIndexRuntime({
    rootDir,
    allowedExtensions: [".md"],
  });
  const index = await runLibraryTextIndex({
    config: prepared.config,
    allowedExtensions: [".md"],
  });
  fs.rmSync(path.join(rootDir, ".ai-index", "runtime", "export-catalog-snapshot.json"), { force: true });

  const exportStage = await runLibraryExportOnce({
    config: prepared.config,
    dirtyScope: index.dirtyScope,
    reason: "export_auto_fallback_test",
    dataSourceMode: "auto",
  });

  assert.equal(exportStage.requestedDataSourceMode, "auto");
  assert.equal(exportStage.resolvedDataSourceMode, "sqlite");
  assert.equal(fs.existsSync(path.join(rootDir, ".ai-index", "exports", "manifest.json")), true);
});
