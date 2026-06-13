import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runLibraryIndexOnce } from "@x-file/indexer";

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
