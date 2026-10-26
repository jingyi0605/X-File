import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readCatalogSnapshot, runLibraryIndexOnce, runNativeLibraryWorker, type NativeExportResult } from "@x-file/indexer";
import type { LibraryBinding, LibraryIndexStatus } from "@x-file/shared";
import { LibraryExportReader } from "../storage/library-export-reader.js";

function library(t: { after(fn: () => void): void }): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "x-file-native-e2e-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const directory of ["docs", "other"]) fs.mkdirSync(path.join(root, directory));
  fs.writeFileSync(path.join(root, "docs/a.md"), "alpha 正文");
  fs.writeFileSync(path.join(root, "other/b.md"), "banana 正文");
  return root;
}

function binding(rootDir: string): LibraryBinding {
  return { libraryId: "default", rootDir, enabled: true, mirrorRoot: null, allowedExtensions: [".md"],
    includedHiddenPaths: [], hideDotFiles: true, hideSystemFolders: true, folderOpenBehavior: "double_click",
    configRelativePath: ".ai-index/doc-semantic-index.config.json", exportMode: "v2", initialized: true,
    initializedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
}

const fresh: LibraryIndexStatus = { state: "fresh", dirtyReasons: [], lastRequestedAt: null, lastStartedAt: null,
  lastCompletedAt: null, lastFailedAt: null, nextAllowedAt: null, runningTaskId: null, runningStage: null,
  errorSummary: null, workerHealth: null, progress: null };

test("原生索引产出兼容导出和摘要，不创建 SQLite 数据库", async t => {
  const rootDir = library(t);
  const result = await runLibraryIndexOnce({ rootDir, allowedExtensions: [".md"] });
  assert.equal(result.index.scannedCount, 2);
  assert.equal(result.index.indexedCount, 2);
  assert.equal(fs.existsSync(path.join(rootDir, ".ai-index/catalog.db")), false);
  assert.equal(readCatalogSnapshot(rootDir)?.documents.find(d => d.path === "docs/a.md")?.summary, "alpha 正文");
  const reader = new LibraryExportReader();
  assert.equal(reader.readSnapshot(binding(rootDir), fresh).documentCount, 2);
  const list = reader.listDocuments(binding(rootDir), { browseMode: "folder", selectedFolderPath: "docs", offset: 0, limit: 10 });
  assert.deepEqual(list.items.map(item => item.path), ["docs/a.md"]);
});

test("无变化刷新不改写 catalog 和导出文件", async t => {
  const rootDir = library(t);
  await runLibraryIndexOnce({ rootDir });
  const catalog = path.join(rootDir, ".ai-index/runtime/export-catalog-snapshot.json");
  const manifest = path.join(rootDir, ".ai-index/exports/manifest.json");
  const before = [fs.readFileSync(catalog, "utf8"), fs.readFileSync(manifest, "utf8")];
  const result = await runLibraryIndexOnce({ rootDir });
  assert.equal(result.index.unchangedCount, 2);
  assert.equal(result.index.indexedCount, 0);
  assert.deepEqual(result.exportResult.filesWritten, []);
  assert.deepEqual([fs.readFileSync(catalog, "utf8"), fs.readFileSync(manifest, "utf8")], before);
});

test("局部更新保留其他目录分片，删除会清理详情和旧搜索词", async t => {
  const rootDir = library(t);
  await runLibraryIndexOnce({ rootDir });
  const exportDir = path.join(rootDir, ".ai-index/exports");
  const first = JSON.parse(fs.readFileSync(path.join(exportDir, "manifest.json"), "utf8"));
  const unrelated = first.meta_shards.find((shard: { directory: string }) => shard.directory === "other").path;
  const before = fs.readFileSync(path.join(exportDir, unrelated), "utf8");
  fs.writeFileSync(path.join(rootDir, "docs/a.md"), "changed alpha 正文内容");
  const changed = await runLibraryIndexOnce({ rootDir, targetPath: "docs/a.md" });
  assert.deepEqual(changed.index.dirtyScope.changedPaths, ["docs/a.md"]);
  assert.equal(fs.readFileSync(path.join(exportDir, unrelated), "utf8"), before);
  const deletedDetail = first.detail_shards.find((shard: { document_path: string }) => shard.document_path === "docs/a.md").path;
  fs.unlinkSync(path.join(rootDir, "docs/a.md"));
  const deleted = await runLibraryIndexOnce({ rootDir, targetPath: "docs/a.md" });
  assert.deepEqual(deleted.index.deletedPaths, ["docs/a.md"]);
  assert.equal(fs.existsSync(path.join(exportDir, deletedDetail)), false);
  const search = JSON.parse(fs.readFileSync(path.join(exportDir, "search/manifest.json"), "utf8"));
  for (const bucket of search.buckets) {
    const contents = JSON.parse(fs.readFileSync(path.join(exportDir, bucket.path), "utf8"));
    assert.equal(contents.documents.some((doc: { path: string }) => doc.path === "docs/a.md"), false);
  }
});

test("独立进程对同一根目录串行写入，最终保留所有文件", async t => {
  const rootDir = library(t);
  await Promise.all([runLibraryIndexOnce({ rootDir }), runLibraryIndexOnce({ rootDir })]);
  assert.equal(readCatalogSnapshot(rootDir)?.documents.length, 2);
  const status = JSON.parse(fs.readFileSync(path.join(rootDir, ".ai-index/runtime-status.json"), "utf8"));
  assert.equal(status.state, "cooldown");
});

test("仅导出原生快照，不再提供 SQLite 回退入口", async t => {
  const rootDir = library(t);
  await runNativeLibraryWorker("index-only", { rootDir });
  const result = await runNativeLibraryWorker<NativeExportResult>("export-only", { rootDir,
    dirtyScope: { trigger: "full", changedPaths: [], deletedPaths: [], dirtyDirectories: [], dirtyTagPaths: [],
      dirtyMetaShards: [], dirtyDetailShards: [], dirtyPostingBuckets: [], dirtyRelations: [] } });
  assert.equal(fs.existsSync(result.manifestPath), true);
});

test("摘要词项未变化时复用搜索桶和标签产物", async t => {
  const rootDir = library(t);
  fs.writeFileSync(path.join(rootDir, "docs/a.md"), "alpha 正文 ".repeat(100));
  await runLibraryIndexOnce({ rootDir });
  const manifestPath = path.join(rootDir, ".ai-index/exports/search/manifest.json");
  const before = fs.readFileSync(manifestPath, "utf8");
  fs.appendFileSync(path.join(rootDir, "docs/a.md"), "正文末尾变化");
  const result = await runLibraryIndexOnce({ rootDir, targetPath: "docs/a.md" });
  assert.equal(result.index.indexedCount, 1);
  assert.equal(fs.readFileSync(manifestPath, "utf8"), before);
  assert.equal(result.exportResult.filesWritten.some(file => file.includes("/search/") || file.includes("/tags/")), false);
});

test("扩展名范围缩小后移除旧目录记录和运行时文件记录", async t => {
  const rootDir = library(t);
  fs.writeFileSync(path.join(rootDir, "docs/extra.txt"), "text");
  await runLibraryIndexOnce({ rootDir });
  const result = await runLibraryIndexOnce({ rootDir, allowedExtensions: [".md"] });
  assert.deepEqual(result.index.deletedPaths, ["docs/extra.txt"]);
  assert.equal(readCatalogSnapshot(rootDir)?.documents.some(document => document.path.endsWith(".txt")), false);
  const active = JSON.parse(fs.readFileSync(path.join(rootDir, ".ai-index/runtime/active-file-state-snapshot.json"), "utf8"));
  assert.equal(active.files.some((file: { path: string }) => file.path.endsWith(".txt")), false);
});
