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
import { TaskManager } from "../tasks/task-manager.js";
import { LibraryError } from "./library-errors.js";

test("预览、下载和写入沿用文档库安全边界", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "x-file-library-"));
  const dataDir = path.join(tempDir, "data");
  const rootDir = path.join(tempDir, "library");
  fs.mkdirSync(rootDir, { recursive: true });
  fs.writeFileSync(path.join(rootDir, "note.md"), "# 标题\n", "utf8");

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
