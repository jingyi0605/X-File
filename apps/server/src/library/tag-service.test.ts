import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { LibraryService } from "./library-service.js";
import { TagService } from "./tag-service.js";
import { LibraryBindingStore } from "../storage/library-binding-store.js";
import { TagStore } from "../storage/tag-store.js";

test("tag ensure 使用 libraryId/rootDir 存储并创建层级标签", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "x-file-tags-"));
  const dataDir = path.join(tempDir, "data");
  const rootDir = path.join(tempDir, "library");
  fs.mkdirSync(rootDir, { recursive: true });

  const bindingStore = new LibraryBindingStore({ dataDir });
  new LibraryService(bindingStore).saveBinding({ rootDir, completeInitialization: true });
  const tagService = new TagService(bindingStore, new TagStore({ dataDir }));

  const ensured = tagService.ensureTag({ path: " 项目 / 设计 " });
  assert.equal(ensured.path, "项目/设计");
  assert.equal(ensured.name, "设计");
  assert.equal(ensured.parentPath, "项目");

  const list = tagService.listTags();
  assert.equal(list.items.length, 2);

  const details = tagService.saveDocumentTags("docs/a.md", {
    tagIds: [ensured.id],
    createTagPaths: ["状态/进行中"]
  });
  assert.equal(details.documentId, "docs/a.md");
  assert.equal(details.manualTagIds.length, 2);
  assert.equal(details.resolvedTags.length, 2);
});
