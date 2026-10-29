import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { LibraryBackupService, readDirectoryFingerprint } from "./library-backup-service.js";
import { LibraryBindingStore } from "../storage/library-binding-store.js";
import { LibraryFavoritesStore } from "../storage/library-favorites-store.js";
import { TagStore } from "../storage/tag-store.js";
import { LibraryError } from "./library-errors.js";

test("备份往返恢复标签、收藏和索引快照到结构匹配的当前资料库", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "x-file-backup-roundtrip-"));
  const dataDir = path.join(temp, "data");
  const rootDir = path.join(temp, "Library");
  fs.mkdirSync(path.join(rootDir, "docs", "contracts"), { recursive: true });
  fs.writeFileSync(path.join(rootDir, "docs", "contracts", "one.md"), "one");
  const bindingStore = new LibraryBindingStore({ dataDir });
  const binding = createBinding(bindingStore, rootDir);
  const tags = new TagStore({ dataDir });
  tags.write({
    libraryId: binding.libraryId,
    rootDir,
    tags: [createTag()],
    tagRules: [],
    documentTags: [{ documentId: "docs/contracts/one.md", path: "docs/contracts/one.md", title: "one", manualTagIds: ["tag-1"], updatedAt: "2026-01-01T00:00:00.000Z" }],
    folderTags: [{ folderPath: "docs", bindingTagIds: ["tag-1"], updatedAt: "2026-01-01T00:00:00.000Z" }],
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  const favoritesStore = new LibraryFavoritesStore({ dataDir });
  favoritesStore.write(binding.libraryId, rootDir, [{ kind: "folder", path: "docs", label: "Docs" }]);
  const runtimeDir = path.join(rootDir, ".ai-index", "runtime");
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(path.join(runtimeDir, "export-catalog-snapshot.json"), JSON.stringify({
    version: 1,
    generatedAt: "2026-01-01T00:00:00.000Z",
    tags: [],
    documents: [{ documentId: "docs/contracts/one.md", path: "docs/contracts/one.md", title: "One", summary: "", tags: ["Topic"], derivedTags: [], mtime: "2026-01-01T00:00:00.000Z" }],
  }));

  const service = new LibraryBackupService(bindingStore, tags, favoritesStore, null);
  const backup = service.createBackup();
  assert.deepEqual(backup.library.directories, ["docs", "docs/contracts"]);
  assert.deepEqual(backup.tags.tags.map((tag) => (tag as { id: string }).id), ["tag-1"]);
  assert.equal(backup.index.runtimeStatus, null);
  assert.equal("rootDir" in backup.tags, false);

  fs.writeFileSync(path.join(rootDir, "docs", "contracts", "one.md"), "changed");
  fs.writeFileSync(path.join(rootDir, "docs", "contracts", "two.md"), "new");
  tags.write({ ...tags.read(binding.libraryId, rootDir), tags: [], documentTags: [], folderTags: [] });
  favoritesStore.write(binding.libraryId, rootDir, []);
  fs.writeFileSync(path.join(runtimeDir, "export-catalog-snapshot.json"), "{}");

  const result = service.importBackup(backup);
  assert.equal(result.imported, true);
  assert.equal(result.tagCount, 1);
  assert.equal(tags.read(binding.libraryId, rootDir).documentTags.length, 1);
  assert.equal(favoritesStore.read(binding.libraryId, rootDir)[0]?.path, "docs");
  assert.equal(JSON.parse(fs.readFileSync(path.join(runtimeDir, "export-catalog-snapshot.json"), "utf8")).documents.length, 1);
  assert.equal(result.refresh.status.state, "queued");
});

test("目录结构不匹配或备份格式无效时不写入资料库数据", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "x-file-backup-reject-"));
  const dataDir = path.join(temp, "data");
  const rootDir = path.join(temp, "Library");
  fs.mkdirSync(path.join(rootDir, "docs"), { recursive: true });
  const bindingStore = new LibraryBindingStore({ dataDir });
  const binding = createBinding(bindingStore, rootDir);
  const tags = new TagStore({ dataDir });
  tags.write({
    libraryId: binding.libraryId,
    rootDir,
    tags: [createTag("current")],
    tagRules: [],
    documentTags: [],
    folderTags: [],
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  const favoritesStore = new LibraryFavoritesStore({ dataDir });
  const service = new LibraryBackupService(bindingStore, tags, favoritesStore, null);
  const backup = service.createBackup();

  fs.mkdirSync(path.join(rootDir, "other"));
  assert.throws(() => service.importBackup(backup), (error) => error instanceof LibraryError && error.errorCode === "LIBRARY_BACKUP_MISMATCH");
  assert.equal(tags.read(binding.libraryId, rootDir).tags[0]?.id, "current");
  assert.throws(() => service.importBackup({ ...backup, version: 999 }), (error) => error instanceof LibraryError && error.errorCode === "LIBRARY_BACKUP_INVALID");
  assert.equal(tags.read(binding.libraryId, rootDir).tags[0]?.id, "current");
});

test("浅层目录指纹排除内部状态目录并比较到第二层", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "x-file-backup-depth-"));
  const root = path.join(temp, "Library");
  fs.mkdirSync(path.join(root, "docs", "contracts", "deep"), { recursive: true });
  fs.mkdirSync(path.join(root, ".ai-index", "runtime"), { recursive: true });
  fs.mkdirSync(path.join(root, ".x-file", "internal"), { recursive: true });
  assert.deepEqual(readDirectoryFingerprint(root), {
    rootName: "Library",
    directories: ["docs", "docs/contracts"],
  });
});

function createBinding(store: LibraryBindingStore, rootDir: string) {
  return store.write({
    libraryId: "default",
    rootDir,
    enabled: true,
    mirrorRoot: null,
    allowedExtensions: [".md"],
    includedHiddenPaths: [],
    hideDotFiles: true,
    hideSystemFolders: true,
    folderOpenBehavior: "double_click",
    configRelativePath: ".ai-index/doc-semantic-index.config.json",
    exportMode: "v2",
    initialized: true,
    initializedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
}

function createTag(id = "tag-1") {
  return {
    id,
    path: "Topic",
    name: "Topic",
    rootType: "Topic",
    parentId: null,
    parentPath: null,
    description: null,
    status: "active" as const,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    disabledAt: null,
  };
}
