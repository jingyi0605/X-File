import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { LibraryService } from "./library-service.js";
import { LibraryIndexService } from "./index-service.js";
import { LibraryBindingStore } from "../storage/library-binding-store.js";
import { LibraryExportReader } from "../storage/library-export-reader.js";
import { IndexRuntimeStore } from "../storage/index-runtime-store.js";
import { LibraryRuntimeStatusStore } from "../storage/library-runtime-status-store.js";
import { LibraryConfigStore } from "../storage/library-config-store.js";
import { LibraryFavoritesStore } from "../storage/library-favorites-store.js";
import { TagStore } from "../storage/tag-store.js";
import { TaskManager } from "../tasks/task-manager.js";
import { LibraryError } from "./library-errors.js";

test("预览、下载和写入沿用文档库安全边界", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "x-file-library-"));
  const dataDir = path.join(tempDir, "data");
  const rootDir = path.join(tempDir, "library");
  fs.mkdirSync(rootDir, { recursive: true });
  fs.writeFileSync(path.join(rootDir, "note.md"), "# 标题\n", "utf8");
  fs.writeFileSync(path.join(rootDir, "legacy.doc"), Buffer.from([0x00, 0x01, 0x02]));

  const service = new LibraryService(new LibraryBindingStore({ dataDir }));
  assert.equal(service.getSnapshot().requiresInitialization, true);
  assert.equal(service.getSnapshot().initializationRedirectPath, "/init");
  assert.equal(service.getSnapshot().defaultRootDir, path.join(os.homedir(), "X-File"));

  const pendingBinding = service.saveBinding({ rootDir });
  assert.equal(pendingBinding.initialized, true);
  assert.equal(service.getSnapshot().requiresInitialization, false);

  const initializedBinding = service.saveBinding({ rootDir, completeInitialization: true });
  assert.equal(initializedBinding.initialized, true);
  assert.equal(service.getSnapshot().requiresInitialization, false);

  const preview = service.previewFile({ path: "note.md" });
  assert.equal(preview.supported, true);
  assert.equal(preview.kind, "markdown");
  assert.equal(preview.content, "# 标题\n");
  assert.equal(typeof preview.version, "string");
  assert.equal(preview.capabilities.canEdit, true);

  const unsupportedPreview = service.previewFile({ path: "legacy.doc" });
  assert.equal(unsupportedPreview.supported, false);
  assert.equal(unsupportedPreview.kind, "unsupported");

  const download = service.downloadFile({ path: "note.md" });
  assert.equal(download.fileName, "note.md");
  assert.equal(Buffer.from(download.contentBase64, "base64").toString("utf8"), "# 标题\n");

  assert.throws(
    () => service.operateFile({
      opType: "write",
      srcPath: "note.md",
      content: "被旧版本覆盖",
      expectedVersion: "stale"
    }),
    (error) => error instanceof LibraryError && error.errorCode === "FILE_VERSION_CONFLICT"
  );

  const result = service.operateFile({
    opType: "write",
    srcPath: "note.md",
    content: "新内容",
    expectedVersion: preview.version ?? ""
  });
  assert.equal(result.success, true);
  assert.equal(fs.readFileSync(path.join(rootDir, "note.md"), "utf8"), "新内容");

  assert.throws(
    () => service.downloadFile({ path: "../outside.md" }),
    (error) => error instanceof LibraryError && error.errorCode === "LIBRARY_PATH_INVALID"
  );

  assert.throws(
    () => service.operateFile({
      opType: "create_file",
      dstPath: ".ai-index/internal.txt",
      content: "不能写"
    }),
    (error) => error instanceof LibraryError && error.errorCode === "INVALID_FILE_OPERATION"
  );
});

test("默认资料库根目录使用用户主目录 X-File，且首次绑定会自动创建", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "x-file-default-root-home-"));
  const dataDir = path.join(tempDir, "data");
  const previousHome = process.env.HOME;
  process.env.HOME = tempDir;
  const service = new LibraryService(new LibraryBindingStore({ dataDir }));

  try {
    const defaultRootDir = path.join(tempDir, "X-File");
    const snapshot = service.getSnapshot();
    assert.equal(snapshot.defaultRootDir, defaultRootDir);
    assert.equal(fs.existsSync(defaultRootDir), false);

    const binding = service.saveBinding({ rootDir: defaultRootDir, completeInitialization: true });
    assert.equal(binding.rootDir, defaultRootDir);
    assert.equal(binding.initialized, true);
    assert.equal(fs.statSync(defaultRootDir).isDirectory(), true);
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
  }
});

test("文件操作支持创建、复制、移动和删除", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "x-file-library-ops-"));
  const dataDir = path.join(tempDir, "data");
  const rootDir = path.join(tempDir, "library");
  fs.mkdirSync(rootDir, { recursive: true });

  const service = new LibraryService(new LibraryBindingStore({ dataDir }));
  service.saveBinding({ rootDir, completeInitialization: true });

  service.operateFile({ opType: "create_directory", dstPath: "docs" });
  service.operateFile({ opType: "create_file", dstPath: "docs/a.txt", content: "A" });
  service.operateFile({ opType: "copy", srcPath: "docs/a.txt", dstPath: "docs/b.txt" });
  service.operateFile({ opType: "move", srcPath: "docs/b.txt", dstPath: "docs/c.txt" });
  assert.equal(fs.readFileSync(path.join(rootDir, "docs/c.txt"), "utf8"), "A");

  service.operateFile({ opType: "delete", srcPath: "docs/c.txt" });
  assert.equal(fs.existsSync(path.join(rootDir, "docs/c.txt")), false);
});

test("文件树遵守隐藏规则并始终排除索引目录", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "x-file-library-hidden-tree-"));
  const dataDir = path.join(tempDir, "data");
  const rootDir = path.join(tempDir, "library");
  fs.mkdirSync(path.join(rootDir, ".obsidian"), { recursive: true });
  fs.mkdirSync(path.join(rootDir, ".secret"), { recursive: true });
  fs.mkdirSync(path.join(rootDir, "node_modules"), { recursive: true });
  fs.mkdirSync(path.join(rootDir, ".ai-index"), { recursive: true });
  fs.mkdirSync(path.join(rootDir, "docs"), { recursive: true });

  const bindingStore = new LibraryBindingStore({ dataDir });
  const configStore = new LibraryConfigStore();
  const service = new LibraryService(bindingStore, new LibraryExportReader(), null, configStore);
  service.saveBinding({ rootDir, completeInitialization: true });

  assert.deepEqual(service.listFiles({}).items.map((item) => item.name), ["docs"]);

  const binding = bindingStore.read();
  assert.ok(binding);
  bindingStore.write({
    ...binding,
    includedHiddenPaths: [".obsidian"],
  });
  assert.deepEqual(
    service.listFiles({}).items.map((item) => item.name).sort(),
    [".obsidian", "docs"],
  );

  bindingStore.write({
    ...binding,
    hideDotFiles: false,
    hideSystemFolders: false,
  });
  assert.deepEqual(
    service.listFiles({}).items.map((item) => item.name).sort(),
    [".obsidian", ".secret", "docs", "node_modules"],
  );
  assert.deepEqual(service.listFiles({ path: ".ai-index" }).items, []);
});

test("读快照和列表只读取 export，不触发索引刷新", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "x-file-library-readonly-"));
  const dataDir = path.join(tempDir, "data");
  const rootDir = path.join(tempDir, "library");
  writeExportFixture(rootDir);

  class FailingIndexService extends LibraryIndexService {
    override requestRefresh(): never {
      throw new Error("读接口不应该触发索引");
    }
  }

  const service = new LibraryService(
    new LibraryBindingStore({ dataDir }),
    new LibraryExportReader(),
    new FailingIndexService(new TaskManager(), new IndexRuntimeStore())
  );
  service.saveBinding({ rootDir, completeInitialization: true });

  assert.equal(service.getSnapshot().documentCount, 2);
  assert.equal(service.listDocuments({ browseMode: "folder", selectedFolderPath: "docs" }).items.length, 1);
});

test("索引 running 时列表仍只读当前 export，不阻塞也不触发二次刷新", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "x-file-library-running-readonly-"));
  const dataDir = path.join(tempDir, "data");
  const rootDir = path.join(tempDir, "library");
  writeExportFixture(rootDir);

  class RecordingIndexService extends LibraryIndexService {
    requestCount = 0;

    override requestRefresh(
      binding: Parameters<LibraryIndexService["requestRefresh"]>[0],
      input: Parameters<LibraryIndexService["requestRefresh"]>[1],
    ): ReturnType<LibraryIndexService["requestRefresh"]> {
      this.requestCount += 1;
      return super.requestRefresh(binding, input);
    }
  }

  const indexService = new RecordingIndexService(
    new TaskManager(),
    new IndexRuntimeStore(),
    new LibraryRuntimeStatusStore(),
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    },
  );
  const service = new LibraryService(
    new LibraryBindingStore({ dataDir }),
    new LibraryExportReader(),
    indexService,
  );
  service.saveBinding({ rootDir, completeInitialization: true });
  service.requestRefresh({ reason: "manual_refresh" });
  await waitForLibraryTest(() => service.getSnapshot().status.state === "running");

  const list = service.listDocuments({ browseMode: "folder", selectedFolderPath: "docs" });
  assert.equal(list.items.length, 1);
  assert.equal(indexService.requestCount, 1);
});

test("收藏会持久化并参与列表筛选", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "x-file-library-favorites-"));
  const dataDir = path.join(tempDir, "data");
  const rootDir = path.join(tempDir, "library");
  writeExportFixture(rootDir);

  const bindingStore = new LibraryBindingStore({ dataDir });
  const createService = () => new LibraryService(
    bindingStore,
    new LibraryExportReader(),
    null,
    new LibraryConfigStore(),
    new LibraryFavoritesStore({ dataDir })
  );

  const service = createService();
  service.saveBinding({ rootDir, completeInitialization: true });
  service.updateFavorites({
    favorites: [{ kind: "tag", path: "主题/后端", label: "后端" }]
  });

  assert.equal(service.getSnapshot().favorites.length, 1);
  assert.equal(service.listDocuments({ browseMode: "tag", selectedFavoriteId: "主题/后端" }).items.length, 1);

  const reloaded = createService();
  assert.equal(reloaded.getSnapshot().favorites[0]?.path, "主题/后端");
});

test("标签筛选返回直接绑定目录，并按完整筛选文件集计算目录计数", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "x-file-library-tag-directories-"));
  const dataDir = path.join(tempDir, "data");
  const rootDir = path.join(tempDir, "library");
  writeExportFixture(rootDir);
  const exportFile = path.join(rootDir, ".ai-index", "exports", "meta", "meta_docs.json");
  const exportData = JSON.parse(fs.readFileSync(exportFile, "utf8")) as {
    documents: Array<{ document_id: string; path: string; direct_tags: string[] }>;
  };
  exportData.documents[0]!.direct_tags = ["主题/后端", "项目/Alpha"];
  exportData.documents.push(
    { document_id: "doc_backend_2", path: "docs/another.md", direct_tags: ["主题/后端", "项目/Alpha"] },
    { document_id: "doc_backend_nested", path: "docs/child/nested.md", direct_tags: ["主题/后端", "项目/Alpha"] },
    { document_id: "doc_unmatched", path: "docs/unmatched.md", direct_tags: [] },
  );
  fs.writeFileSync(exportFile, JSON.stringify(exportData), "utf8");

  const bindingStore = new LibraryBindingStore({ dataDir });
  const tagStore = new TagStore({ dataDir });
  const service = new LibraryService(
    bindingStore,
    new LibraryExportReader(),
    null,
    new LibraryConfigStore(),
    new LibraryFavoritesStore({ dataDir }),
    tagStore,
  );
  const binding = service.saveBinding({ rootDir, completeInitialization: true });
  tagStore.write({
    libraryId: binding.libraryId,
    rootDir: binding.rootDir,
    tags: [
      { id: "backend", path: "主题/后端", name: "后端", rootType: "主题", parentId: null, parentPath: "主题", description: null, status: "active", createdAt: "2026-06-08T00:00:00.000Z", updatedAt: "2026-06-08T00:00:00.000Z", disabledAt: null },
      { id: "alpha", path: "项目/Alpha", name: "Alpha", rootType: "项目", parentId: null, parentPath: "项目", description: null, status: "active", createdAt: "2026-06-08T00:00:00.000Z", updatedAt: "2026-06-08T00:00:00.000Z", disabledAt: null },
    ],
    tagRules: [],
    documentTags: [],
    folderTags: [{ folderPath: "docs", bindingTagIds: ["backend", "alpha"], updatedAt: "2026-06-08T00:00:00.000Z" }],
    updatedAt: "2026-06-08T00:00:00.000Z",
  });

  const singleTagResult = service.listDocuments({
    browseMode: "tag",
    selectedTagPaths: ["主题"],
    offset: 0,
    limit: 1,
  });
  assert.deepEqual(singleTagResult.items.map((item) => item.path), ["docs/another.md"]);
  assert.deepEqual(singleTagResult.tagDirectories, [{
    path: "docs",
    documentCount: 3,
    updatedAt: "2026-06-08T00:00:00.000Z",
    matchedTagPaths: ["主题/后端"],
  }]);

  const multiTagResult = service.listDocuments({
    browseMode: "tag",
    selectedTagPaths: ["主题/后端", "项目"],
    offset: 0,
    limit: 1,
  });
  assert.equal(multiTagResult.total, 3);
  assert.deepEqual(multiTagResult.tagDirectories?.[0]?.matchedTagPaths, ["主题/后端", "项目/Alpha"]);

  const unfilteredResult = service.listDocuments({ browseMode: "folder", offset: 0, limit: 10 });
  assert.deepEqual(unfilteredResult.tagDirectories, []);
});

test("刷新任务按同 rootDir 同类任务去重", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "x-file-library-dedupe-"));
  const dataDir = path.join(tempDir, "data");
  const rootDir = path.join(tempDir, "library");
  fs.mkdirSync(rootDir, { recursive: true });

  const taskManager = new TaskManager();
  const indexService = new LibraryIndexService(taskManager, new IndexRuntimeStore());
  const service = new LibraryService(
    new LibraryBindingStore({ dataDir }),
    new LibraryExportReader(),
    indexService
  );
  service.saveBinding({ rootDir, completeInitialization: true });

  const first = service.requestRefresh({ reason: "manual" });
  const second = service.requestRefresh({ reason: "manual" });

  assert.equal(first.taskId, second.taskId);
  assert.equal(second.deduped, true);
  assert.equal(second.status.state, "queued");
});

test("文件操作完成后只把刷新放进后台任务", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "x-file-library-mutation-refresh-"));
  const dataDir = path.join(tempDir, "data");
  const rootDir = path.join(tempDir, "library");
  fs.mkdirSync(rootDir, { recursive: true });

  const taskManager = new TaskManager();
  const runtimeStore = new IndexRuntimeStore();
  const indexService = new LibraryIndexService(taskManager, runtimeStore);
  const service = new LibraryService(
    new LibraryBindingStore({ dataDir }),
    new LibraryExportReader(),
    indexService
  );
  service.saveBinding({ rootDir, completeInitialization: true });

  service.operateFile({ opType: "create_file", dstPath: "docs/a.md", content: "A" });
  const status = service.getSnapshot().status;

  assert.equal(status.state, "queued");
  assert.deepEqual(status.dirtyReasons, ["file_create_file"]);
  assert.equal(typeof status.runningTaskId, "string");
});

test("从临时 export 读取文档、标签和文件夹", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "x-file-library-export-"));
  const dataDir = path.join(tempDir, "data");
  const rootDir = path.join(tempDir, "library");
  writeExportFixture(rootDir);

  const service = new LibraryService(new LibraryBindingStore({ dataDir }));
  service.saveBinding({ rootDir, completeInitialization: true });

  const snapshot = service.getSnapshot();
  assert.equal(snapshot.documentCount, 2);
  assert.equal(snapshot.tags.length, 1);
  assert.equal(snapshot.tags[0]?.documentCount, 1);
  assert.equal(snapshot.folders.some((folder) => folder.path === "docs"), true);

  const list = service.listDocuments({ browseMode: "tag", selectedTagPath: "主题/后端" });
  assert.equal(list.total, 1);
  assert.equal(list.items[0]?.path, "docs/backend.md");
});

test("修改时间先全局排序再分页，支持双向排序、时区和相同时间", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "x-file-time-sort-"));
  const rootDir = path.join(tempDir, "library");
  writeExportFixture(rootDir);
  const documents = [
    { document_id: "a", path: "a.md", mtime: "2026-10-26T10:00:00+08:00" },
    { document_id: "b", path: "b.md", mtime: "2026-10-26T03:00:00Z" },
    { document_id: "c", path: "c.md", mtime: "2026-10-26T02:00:00Z" },
    { document_id: "d", path: "d.md", mtime: "2025-01-01T00:00:00Z" },
    { document_id: "invalid", path: "invalid.md", mtime: "invalid" },
  ];
  fs.writeFileSync(path.join(rootDir, ".ai-index/exports/meta/meta_docs.json"), JSON.stringify({ documents }));
  const service = new LibraryService(
    new LibraryBindingStore({ dataDir: path.join(tempDir, "data") }),
    new LibraryExportReader(),
    null,
  );
  service.saveBinding({ rootDir, completeInitialization: true });

  try {
    for (const browseMode of ["folder", "tag"]) {
      for (const updatedAtOrder of ["asc", "desc"] as const) {
        const expected = updatedAtOrder === "asc"
          ? ["invalid.md", "d.md", "a.md", "c.md", "b.md"]
          : ["b.md", "a.md", "c.md", "d.md", "invalid.md"];
        const paths: string[] = [];
        for (let offset = 0; offset < documents.length; offset += 2) {
          const page = service.listDocuments({ browseMode, updatedAtOrder, offset, limit: 2 });
          assert.equal(page.total, documents.length);
          paths.push(...page.items.map((item) => item.path));
        }
        assert.deepEqual(paths, expected);
      }
    }
    assert.deepEqual(
      service.listDocuments({ browseMode: "folder" }).items.map((item) => item.path),
      documents.map((item) => item.path),
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("最近时间标签按当前本地日期计算，旧标签、分页和跨天缓存不会混入过期文件", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date(2026, 9, 26, 12) });
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "x-file-recent-tags-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const rootDir = path.join(tempDir, "library");
  writeExportFixture(rootDir);
  const recentTags = ["时间/最近3天", "时间/最近7天", "时间/最近30天"];
  const documents = [0, 2, 3, 6, 7, 29, 30, -1].map((days) => ({
    document_id: `day-${days}`,
    path: `day-${days}.md`,
    mtime: new Date(2026, 9, 26 - days, 0, 30).toISOString(),
    direct_tags: ["主题/保留", ...recentTags],
    derived_tags: ["类型/文本/Markdown", "时间/2026/10", ...recentTags],
  }));
  documents.push(
    { document_id: "july", path: "july.md", mtime: "2026-07-21T14:30:00Z", direct_tags: recentTags, derived_tags: recentTags },
    { document_id: "invalid", path: "invalid.md", mtime: "invalid", direct_tags: recentTags, derived_tags: recentTags },
  );
  // 新文件即使没有保存相对时间标签，也应进入今天的结果。
  documents[0]!.direct_tags = ["主题/保留"];
  documents[0]!.derived_tags = ["类型/文本/Markdown", "时间/2026/10"];
  const exportDir = path.join(rootDir, ".ai-index/exports");
  fs.writeFileSync(path.join(exportDir, "meta/meta_docs.json"), JSON.stringify({ documents }));
  fs.writeFileSync(path.join(exportDir, "taxonomy.json"), JSON.stringify({
    nodes: ["时间", ...recentTags].map((tag) => ({
      path: tag, name: tag.split("/").at(-1), root_type: "时间",
      parent_path: tag === "时间" ? null : "时间", depth: tag === "时间" ? 0 : 1,
    })),
  }));
  const service = new LibraryService(
    new LibraryBindingStore({ dataDir: path.join(tempDir, "data") }),
    new LibraryExportReader(),
    null,
  );
  service.saveBinding({ rootDir, completeInitialization: true });

  const query = (tag: string, offset = 0, limit = 50) => service.listDocuments({
    browseMode: "tag", selectedTagPaths: [tag], updatedAtOrder: "desc", offset, limit,
  });
  for (const [index, expected] of [[0, 2], [1, 4], [2, 6]] as const) {
    const tag = recentTags[index]!;
    const page = query(tag, 0, 1);
    assert.equal(page.total, expected);
    assert.equal(page.tagFacetCounts?.[tag], expected);
    assert.equal(service.getSnapshot().tags.find((item) => item.path === tag)?.documentCount, expected);
  }
  assert.deepEqual(
    [query(recentTags[0]!, 0, 1), query(recentTags[0]!, 1, 1)].flatMap((page) => page.items.map((item) => item.path)),
    ["day-0.md", "day-2.md"],
  );
  assert.ok(query(recentTags[0]!).items[0]!.tags.includes("主题/保留"));
  assert.ok(query(recentTags[0]!).items[0]!.derivedTags.includes("时间/2026/10"));
  t.mock.timers.setTime(new Date(2026, 9, 27, 0, 1).getTime());
  assert.deepEqual(query(recentTags[0]!).items.map((item) => item.path), ["day--1.md", "day-0.md"]);
});

test("近期筛选优先读取原生运行时快照，兼容旧导出滞后或缺失", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date(2026, 9, 26, 12) });
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "x-file-runtime-recent-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const rootDir = path.join(tempDir, "library");
  writeExportFixture(rootDir);
  const runtimeDir = path.join(rootDir, ".ai-index/runtime");
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(path.join(runtimeDir, "export-catalog-snapshot.json"), JSON.stringify({
    version: 1, generatedAt: new Date().toISOString(), tags: [],
    documents: [{
      documentId: "recent", path: "recent.md", title: "近期文件", summary: "",
      mtime: new Date(2026, 9, 26, 10).toISOString(), tags: [], derivedTags: [],
    }],
  }));
  const service = new LibraryService(
    new LibraryBindingStore({ dataDir: path.join(tempDir, "data") }),
    new LibraryExportReader(),
    null,
  );
  service.saveBinding({ rootDir, completeInitialization: true });
  const verify = () => {
    const list = service.listDocuments({ browseMode: "tag", selectedTagPath: "时间/最近3天" });
    assert.deepEqual(list.items.map((item) => item.path), ["recent.md"]);
    const snapshot = service.getSnapshot();
    assert.equal(snapshot.documentCount, 1);
    assert.equal(snapshot.tags.find((tag) => tag.path === "时间/最近3天")?.documentCount, 1);
  };
  verify();
  fs.unlinkSync(path.join(rootDir, ".ai-index/exports/manifest.json"));
  verify();
});

test("listDocuments 对当前页文档补全大小与创建时间（对齐父仓库 stat 补全）", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "x-file-library-stats-"));
  const rootDir = path.join(tempDir, "library");
  fs.mkdirSync(path.join(rootDir, "docs"), { recursive: true });
  const readmeContent = "# 说明文档\n";
  const backendContent = "# 后端任务\n".repeat(10);
  fs.writeFileSync(path.join(rootDir, "readme.md"), readmeContent, "utf8");
  fs.writeFileSync(path.join(rootDir, "docs", "backend.md"), backendContent, "utf8");
  writeExportFixture(rootDir);

  const service = new LibraryService(new LibraryBindingStore({ dataDir: path.join(tempDir, "data") }));
  service.saveBinding({ rootDir, completeInitialization: true });

  // 根目录直接子文档：readme.md
  const rootList = service.listDocuments({ browseMode: "folder", selectedFolderPath: "" });
  const readme = rootList.items.find((item) => item.path === "readme.md");
  assert.ok(readme, "根目录应列出 readme.md");
  assert.equal(readme!.sizeBytes, Buffer.byteLength(readmeContent, "utf8"));
  assert.equal(typeof readme!.createdAt, "string");
  assert.ok(readme!.createdAt!.length > 0);

  // docs 子目录文档：backend.md
  const docsList = service.listDocuments({ browseMode: "folder", selectedFolderPath: "docs" });
  const backend = docsList.items.find((item) => item.path === "docs/backend.md");
  assert.ok(backend, "docs 目录应列出 backend.md");
  assert.equal(backend!.sizeBytes, Buffer.byteLength(backendContent, "utf8"));
  assert.equal(typeof backend!.createdAt, "string");
});

test("listDocuments 在文件缺失时大小与创建时间回退为 null（不报错）", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "x-file-library-stats-missing-"));
  const rootDir = path.join(tempDir, "library");
  fs.mkdirSync(rootDir, { recursive: true });
  // 只写导出分片、不创建真实文件 → stat 应优雅回退 null，且不影响列表其它字段
  writeExportFixture(rootDir);

  const service = new LibraryService(new LibraryBindingStore({ dataDir: path.join(tempDir, "data") }));
  service.saveBinding({ rootDir, completeInitialization: true });

  const list = service.listDocuments({ browseMode: "folder", selectedFolderPath: "" });
  assert.ok(list.items.length > 0, "应能正常返回文档列表");
  for (const item of list.items) {
    assert.equal(item.sizeBytes, null);
    assert.equal(item.createdAt, null);
  }
});

test("根目录列表不会混入子目录文档", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "x-file-library-root-only-"));
  const rootDir = path.join(tempDir, "library");
  writeExportFixture(rootDir);

  const service = new LibraryService(new LibraryBindingStore({ dataDir: path.join(tempDir, "data") }));
  service.saveBinding({ rootDir, completeInitialization: true });

  const rootList = service.listDocuments({ browseMode: "folder", selectedFolderPath: "" });
  assert.deepEqual(rootList.items.map((item) => item.path), ["readme.md"]);
});

test("文档搜索支持全部文件、当前目录和当前结果范围，并区分文件名与索引内容", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "x-file-library-search-scope-"));
  const rootDir = path.join(tempDir, "library");
  writeExportFixture(rootDir);

  const service = new LibraryService(new LibraryBindingStore({ dataDir: path.join(tempDir, "data") }));
  service.saveBinding({ rootDir, completeInitialization: true });

  const allFiles = service.listDocuments({
    browseMode: "folder",
    selectedFolderPath: "docs",
    keyword: "readme",
    searchScope: "all",
    searchMode: "name",
  });
  assert.deepEqual(allFiles.items.map((item) => item.path), ["readme.md"]);

  const currentDirectory = service.listDocuments({
    browseMode: "folder",
    selectedFolderPath: "docs",
    keyword: "后台",
    searchScope: "current_directory",
    searchMode: "content",
  });
  assert.deepEqual(currentDirectory.items.map((item) => item.path), ["docs/backend.md"]);

  const currentResults = service.listDocuments({
    browseMode: "folder",
    selectedFolderPath: "docs",
    keyword: "根目录",
    searchScope: "current_results",
    searchMode: "content",
  });
  assert.deepEqual(currentResults.items, []);
});

function writeExportFixture(rootDir: string): void {
  const exportDir = path.join(rootDir, ".ai-index", "exports");
  fs.mkdirSync(path.join(exportDir, "meta"), { recursive: true });
  const exportedAt = "2026-06-08T00:00:00.000Z";

  fs.writeFileSync(path.join(exportDir, "manifest.json"), JSON.stringify({
    version: 2,
    format: "static-v2",
    generated_at: exportedAt,
    entries: {
      status: "status.json",
      taxonomy: "taxonomy.json",
      bootstrap: "bootstrap.json"
    },
    meta_shards: [
      { id: "meta_docs", path: "meta/meta_docs.json", document_count: 2 }
    ]
  }), "utf8");
  fs.writeFileSync(path.join(exportDir, "status.json"), JSON.stringify({
    exported_at: exportedAt,
    document_count: 2
  }), "utf8");
  fs.writeFileSync(path.join(exportDir, "taxonomy.json"), JSON.stringify({
    nodes: [
      {
        path: "主题/后端",
        name: "后端",
        root_type: "主题",
        parent_path: "主题",
        depth: 1
      }
    ]
  }), "utf8");
  fs.writeFileSync(path.join(exportDir, "bootstrap.json"), JSON.stringify({
    folders: [
      {
        path: ".",
        name: "资料库",
        parent_path: null,
        direct_document_count: 1,
        document_count: 2
      },
      {
        path: "docs",
        name: "docs",
        parent_path: ".",
        direct_document_count: 1,
        document_count: 1
      }
    ]
  }), "utf8");
  fs.writeFileSync(path.join(exportDir, "meta", "meta_docs.json"), JSON.stringify({
    documents: [
      {
        document_id: "doc_backend",
        path: "docs/backend.md",
        title: "后端任务",
        summary: "后台索引任务",
        mtime: exportedAt,
        direct_tags: ["主题/后端"],
        derived_tags: []
      },
      {
        document_id: "doc_root",
        path: "readme.md",
        title: "说明",
        summary: "根目录文档",
        mtime: exportedAt,
        direct_tags: [],
        derived_tags: []
      }
    ]
  }), "utf8");
}

async function waitForLibraryTest(check: () => boolean): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 1000) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("等待文档库状态超时");
}
