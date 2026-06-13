import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { LibraryBinding } from "@x-file/shared";

import { LibraryIndexService } from "./index-service.js";
import { IndexRuntimeStore } from "../storage/index-runtime-store.js";
import { TaskManager } from "../tasks/task-manager.js";

test("索引完成后进入 cooldown，窗口结束后恢复 fresh", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "x-file-index-cooldown-"));
  const runtimeStore = new IndexRuntimeStore();
  const indexService = new LibraryIndexService(
    new TaskManager(),
    runtimeStore,
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
