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
