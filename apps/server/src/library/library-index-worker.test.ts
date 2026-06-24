import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { LibraryExportReader } from "../storage/library-export-reader.js";
import type { LibraryBinding } from "@x-file/shared";

const execFileAsync = promisify(execFile);
const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

interface IndexWorkerResult {
  dirtyScope?: unknown;
  status: { state: string };
  exportCatalogSnapshotPath?: string;
  sqliteDriver?: string;
}

interface ExportWorkerResult {
  status: { state: string };
  exportDataSourceMode?: string;
  exportDataSourceModeRequested?: string;
  exportCatalogSnapshotPath?: string;
  exportCatalogSnapshotRequired?: boolean;
  exportFallbackToSqlite?: boolean;
  sqliteDriver?: string;
  dirtyScopeSummary?: {
    trigger: string | null;
    changedPathCount: number;
    deletedPathCount: number;
    dirtyDirectoryCount: number;
  };
}

test("library index worker 支持 index-only 后接 export-only 的两段执行", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "x-file-worker-split-"));
  fs.mkdirSync(path.join(rootDir, "docs"), { recursive: true });
  fs.writeFileSync(path.join(rootDir, "docs", "a.md"), "# A", "utf8");
  fs.writeFileSync(path.join(rootDir, "docs", "b.md"), "# B", "utf8");

  const indexWorkerPath = path.join(serverDir, "dist", "library", "library-index-worker.js");
  const exportWorkerPath = path.join(serverDir, "dist", "library", "library-export-worker.js");
  assert.equal(fs.existsSync(indexWorkerPath), true);
  assert.equal(fs.existsSync(exportWorkerPath), true);

  const indexPayload = {
    mode: "index-only",
    rootDir,
    allowedExtensions: [".md"],
    includedHiddenPaths: [],
    reason: "worker_split_test",
    queuedAt: new Date().toISOString(),
    taskId: null,
  };
  const indexResult = await execFileAsync(process.execPath, [
    indexWorkerPath,
    JSON.stringify(indexPayload),
  ], {
    cwd: serverDir,
  });
  const indexJson = JSON.parse(indexResult.stdout.trim()) as IndexWorkerResult;
  assert.equal(indexJson.status.state, "cooldown");
  assert.ok(indexJson.dirtyScope);
  assert.equal(
    typeof indexJson.exportCatalogSnapshotPath,
    "string",
  );
  assert.equal(
    fs.existsSync(indexJson.exportCatalogSnapshotPath ?? ""),
    true,
  );

  const exportPayload = {
    mode: "export-only",
    rootDir,
    allowedExtensions: [".md"],
    includedHiddenPaths: [],
    reason: "worker_split_test",
    queuedAt: new Date().toISOString(),
    taskId: null,
    dirtyScope: indexJson.dirtyScope,
  };
  const exportResult = await execFileAsync(process.execPath, [
    exportWorkerPath,
    JSON.stringify(exportPayload),
  ], {
    cwd: serverDir,
  });
  const exportJson = JSON.parse(exportResult.stdout.trim()) as ExportWorkerResult;
  assert.equal(exportJson.status.state, "cooldown");
  assert.equal(exportJson.exportDataSourceMode, "snapshot");
  assert.equal(exportJson.exportDataSourceModeRequested, "snapshot");
  assert.equal(exportJson.exportCatalogSnapshotRequired, true);
  assert.equal(exportJson.exportFallbackToSqlite, false);
  assert.equal(exportJson.exportCatalogSnapshotPath, indexJson.exportCatalogSnapshotPath);
  assert.equal(indexJson.sqliteDriver, "node:sqlite");
  assert.equal(exportJson.sqliteDriver, "node:sqlite");
  assert.deepEqual(exportJson.dirtyScopeSummary, {
    trigger: "full",
    changedPathCount: 0,
    deletedPathCount: 0,
    dirtyDirectoryCount: 0,
  });
  assert.equal(fs.existsSync(path.join(rootDir, ".ai-index", "exports", "manifest.json")), true);

  const reader = new LibraryExportReader();
  const documents = reader.listDocuments(createBinding(rootDir), {
    browseMode: "folder",
    selectedFolderPath: "docs",
    offset: 0,
    limit: 10,
  });
  assert.deepEqual(documents.items.map((document) => document.path), ["docs/a.md", "docs/b.md"]);
});

test("index-only 默认会直接产出 runtime export snapshot，不再依赖显式 sqlite refresh", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "x-file-worker-runtime-snapshot-"));
  fs.mkdirSync(path.join(rootDir, "docs"), { recursive: true });
  fs.writeFileSync(path.join(rootDir, "docs", "a.md"), "# A", "utf8");

  const indexWorkerPath = path.join(serverDir, "dist", "library", "library-index-worker.js");
  assert.equal(fs.existsSync(indexWorkerPath), true);

  const indexResult = await execFileAsync(process.execPath, [
    indexWorkerPath,
    JSON.stringify({
      mode: "index-only",
      rootDir,
      allowedExtensions: [".md"],
      includedHiddenPaths: [],
      reason: "runtime_snapshot_test",
      queuedAt: new Date().toISOString(),
      taskId: null,
    }),
  ], {
    cwd: serverDir,
  });
  const indexJson = JSON.parse(indexResult.stdout.trim()) as IndexWorkerResult;
  assert.equal(indexJson.status.state, "cooldown");
  assert.equal(typeof indexJson.exportCatalogSnapshotPath, "string");
  assert.equal(
    indexJson.exportCatalogSnapshotPath,
    path.join(rootDir, ".ai-index", "runtime", "export-catalog-snapshot.json"),
  );
  assert.equal(fs.existsSync(indexJson.exportCatalogSnapshotPath ?? ""), true);
});

test("export worker 在缺少 dirtyScope 时会直接失败并提示先执行 index-only", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "x-file-export-worker-missing-dirty-scope-"));
  fs.mkdirSync(path.join(rootDir, "docs"), { recursive: true });
  fs.writeFileSync(path.join(rootDir, "docs", "a.md"), "# A", "utf8");

  const exportWorkerPath = path.join(serverDir, "dist", "library", "library-export-worker.js");
  assert.equal(fs.existsSync(exportWorkerPath), true);

  await assert.rejects(
    execFileAsync(process.execPath, [
      exportWorkerPath,
      JSON.stringify({
        mode: "export-only",
        rootDir,
        allowedExtensions: [".md"],
        includedHiddenPaths: [],
        reason: "missing_dirty_scope",
        queuedAt: new Date().toISOString(),
        taskId: null,
        exportDataSourceMode: "snapshot",
      }),
    ], {
      cwd: serverDir,
    }),
    (error: unknown) => {
      assert.equal(error instanceof Error, true);
      const stderr = (error as { stderr?: string }).stderr ?? "";
      assert.match(stderr, /export worker 缺少 dirtyScope；请先执行 index-only/);
      return true;
    },
  );
});

test("export worker 仅在显式调试模式下才会回退到 sqlite", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "x-file-export-worker-sqlite-fallback-"));
  fs.mkdirSync(path.join(rootDir, "docs"), { recursive: true });
  fs.writeFileSync(path.join(rootDir, "docs", "a.md"), "# A", "utf8");

  const indexWorkerPath = path.join(serverDir, "dist", "library", "library-index-worker.js");
  const exportWorkerPath = path.join(serverDir, "dist", "library", "library-export-worker.js");
  assert.equal(fs.existsSync(indexWorkerPath), true);
  assert.equal(fs.existsSync(exportWorkerPath), true);

  const indexResult = await execFileAsync(process.execPath, [
    indexWorkerPath,
    JSON.stringify({
      mode: "index-only",
      rootDir,
      allowedExtensions: [".md"],
      includedHiddenPaths: [],
      reason: "sqlite_fallback_test",
      queuedAt: new Date().toISOString(),
      taskId: null,
    }),
  ], {
    cwd: serverDir,
  });
  const indexJson = JSON.parse(indexResult.stdout.trim()) as IndexWorkerResult;
  assert.ok(indexJson.dirtyScope);
  assert.equal(typeof indexJson.exportCatalogSnapshotPath, "string");
  fs.unlinkSync(indexJson.exportCatalogSnapshotPath!);

  const exportResult = await execFileAsync(process.execPath, [
    exportWorkerPath,
    JSON.stringify({
      mode: "export-only",
      rootDir,
      allowedExtensions: [".md"],
      includedHiddenPaths: [],
      reason: "sqlite_fallback_test",
      queuedAt: new Date().toISOString(),
      taskId: null,
      dirtyScope: indexJson.dirtyScope,
      exportDataSourceMode: "auto",
    }),
  ], {
    cwd: serverDir,
  });
  const exportJson = JSON.parse(exportResult.stdout.trim()) as ExportWorkerResult;
  assert.equal(exportJson.status.state, "cooldown");
  assert.equal(exportJson.exportDataSourceModeRequested, "auto");
  assert.equal(exportJson.exportDataSourceMode, "sqlite");
  assert.equal(exportJson.exportFallbackToSqlite, true);
  assert.equal(exportJson.exportCatalogSnapshotRequired, false);
  assert.equal(exportJson.sqliteDriver, "node:sqlite");
});

test("worker payload 可以显式切到 node:sqlite 实验 driver", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "x-file-node-sqlite-worker-"));
  fs.mkdirSync(path.join(rootDir, "docs"), { recursive: true });
  fs.writeFileSync(path.join(rootDir, "docs", "a.md"), "# A", "utf8");

  const indexWorkerPath = path.join(serverDir, "dist", "library", "library-index-worker.js");
  const exportWorkerPath = path.join(serverDir, "dist", "library", "library-export-worker.js");
  assert.equal(fs.existsSync(indexWorkerPath), true);
  assert.equal(fs.existsSync(exportWorkerPath), true);

  const indexResult = await execFileAsync(process.execPath, [
    indexWorkerPath,
    JSON.stringify({
      mode: "index-only",
      rootDir,
      allowedExtensions: [".md"],
      includedHiddenPaths: [],
      reason: "node_sqlite_worker_test",
      queuedAt: new Date().toISOString(),
      taskId: null,
      sqliteDriver: "node:sqlite",
    }),
  ], {
    cwd: serverDir,
  });
  const indexJson = JSON.parse(indexResult.stdout.trim()) as IndexWorkerResult;
  assert.equal(indexJson.status.state, "cooldown");
  assert.ok(indexJson.dirtyScope);
  assert.equal(indexJson.sqliteDriver, "node:sqlite");
  assert.equal(fs.existsSync(indexJson.exportCatalogSnapshotPath ?? ""), true);

  const exportResult = await execFileAsync(process.execPath, [
    exportWorkerPath,
    JSON.stringify({
      mode: "export-only",
      rootDir,
      allowedExtensions: [".md"],
      includedHiddenPaths: [],
      reason: "node_sqlite_worker_test",
      queuedAt: new Date().toISOString(),
      taskId: null,
      dirtyScope: indexJson.dirtyScope,
      sqliteDriver: "node:sqlite",
    }),
  ], {
    cwd: serverDir,
  });
  const exportJson = JSON.parse(exportResult.stdout.trim()) as ExportWorkerResult;
  assert.equal(exportJson.status.state, "cooldown");
  assert.equal(exportJson.exportDataSourceMode, "snapshot");
  assert.equal(exportJson.sqliteDriver, "node:sqlite");
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
    updatedAt: new Date().toISOString(),
  };
}
