import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { LibraryBinding } from "@x-file/shared";

import { LibraryIndexService } from "./index-service.js";
import { IndexRuntimeStore } from "../storage/index-runtime-store.js";
import { LibraryRuntimeStatusStore } from "../storage/library-runtime-status-store.js";
import { TaskManager } from "../tasks/task-manager.js";

test("索引完成后进入 cooldown，窗口结束后恢复 fresh", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "x-file-index-cooldown-"));
  const runtimeStore = new IndexRuntimeStore();
  const indexService = new LibraryIndexService(
    new TaskManager(),
    runtimeStore,
    new LibraryRuntimeStatusStore(),
    async ({ onStageChange }) => {
      onStageChange?.("export_search");
    },
  );
  const binding = createBinding(rootDir);

  const queued = indexService.requestRefresh(binding, { reason: "manual_refresh" });
  assert.equal(queued.status.state, "queued");

  await waitFor(() => indexService.getStatus(rootDir).state === "cooldown");
  const cooldown = indexService.getStatus(rootDir);
  assert.equal(cooldown.state, "cooldown");
  assert.equal(typeof cooldown.lastCompletedAt, "string");
  assert.equal(typeof cooldown.nextAllowedAt, "string");

  await new Promise((resolve) => setTimeout(resolve, 1600));
  const fresh = indexService.getStatus(rootDir);
  assert.equal(fresh.state, "fresh");
  assert.equal(fresh.nextAllowedAt, null);
});

test("索引失败后记录 failed 状态，后续刷新不会被旧失败卡住", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "x-file-index-recovery-"));
  const runtimeStore = new IndexRuntimeStore();
  let runCount = 0;
  const indexService = new LibraryIndexService(
    new TaskManager(),
    runtimeStore,
    new LibraryRuntimeStatusStore(),
    async ({ onStageChange }) => {
      runCount += 1;
      onStageChange?.("index_text");
      if (runCount === 1) {
        throw new Error("模拟索引失败");
      }
    },
  );
  const binding = createBinding(rootDir);

  indexService.requestRefresh(binding, { reason: "manual_refresh" });
  await waitFor(() => indexService.getStatus(rootDir).state === "failed");
  const failed = indexService.getStatus(rootDir);
  assert.equal(failed.state, "failed");
  assert.equal(failed.errorSummary, "模拟索引失败");
  assert.equal(failed.runningStage, "index_text");

  const retried = indexService.requestRefresh(binding, { reason: "manual_refresh" });
  assert.equal(retried.status.state, "queued");
  await waitFor(() => indexService.getStatus(rootDir).state === "cooldown");
  assert.equal(indexService.getStatus(rootDir).state, "cooldown");
});

test("索引运行中通过 onProgress 写入的进度会映射到状态并随轮询暴露", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "x-file-index-progress-"));
  const runtimeStore = new IndexRuntimeStore();
  const indexService = new LibraryIndexService(
    new TaskManager(),
    runtimeStore,
    new LibraryRuntimeStatusStore(),
    async ({ onProgress, onStageChange }) => {
      onStageChange?.("index_text");
      onProgress?.({
        scannedCount: 12,
        indexedCount: 3,
        unchangedCount: 8,
        skippedCount: 1,
        failedCount: 0,
        totalCount: null,
        maxConcurrency: 1,
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
    },
  );
  const binding = createBinding(rootDir);

  indexService.requestRefresh(binding, { reason: "manual_refresh" });
  await waitFor(() => indexService.getStatus(rootDir).state === "cooldown");
  const final = indexService.getStatus(rootDir);
  assert.equal(final.state, "cooldown");
  assert.equal(final.progress?.scannedCount, 12);
  assert.equal(final.progress?.indexedCount, 3);
});

test("索引运行状态会持久化到磁盘，重启后新实例仍能读回进度与时间线", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "x-file-index-persist-"));
  // 两个独立的 runtimeStatusStore 共享同一磁盘文件，模拟"同一仓库、不同进程/重启"
  const serviceA = new LibraryIndexService(
    new TaskManager(),
    new IndexRuntimeStore(),
    new LibraryRuntimeStatusStore(),
    async ({ onProgress, onStageChange }) => {
      onStageChange?.("index_text");
      onProgress?.({
        scannedCount: 9,
        indexedCount: 9,
        unchangedCount: 0,
        skippedCount: 0,
        failedCount: 0,
        totalCount: 9,
        maxConcurrency: 1,
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
    },
  );
  const binding = createBinding(rootDir);
  serviceA.requestRefresh(binding, { reason: "manual_refresh" });
  await waitFor(() => serviceA.getStatus(rootDir).state === "cooldown");
  const cooldownA = serviceA.getStatus(rootDir);
  assert.equal(cooldownA.progress?.indexedCount, 9);
  assert.equal(typeof cooldownA.lastCompletedAt, "string");

  // 新实例：内存 store 全新（模拟重启后内存丢失），仅靠磁盘快照恢复
  const serviceB = new LibraryIndexService(
    new TaskManager(),
    new IndexRuntimeStore(),
    new LibraryRuntimeStatusStore(),
  );
  const recovered = serviceB.getStatus(rootDir);
  // 状态可能仍在 cooldown 窗口、也可能已自然转 fresh，但进度与完成时间必须从磁盘恢复
  assert.ok(recovered.state === "cooldown" || recovered.state === "fresh");
  assert.equal(recovered.progress?.indexedCount, 9);
  assert.equal(recovered.lastCompletedAt, cooldownA.lastCompletedAt);
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

async function waitFor(check: () => boolean): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 3000) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail("等待索引状态超时");
}
