import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { LibraryIndexService } from "./index-service.js";
import { LibraryWatchService } from "./watch-service.js";
import { IndexRuntimeStore } from "../storage/index-runtime-store.js";
import { TaskManager } from "../tasks/task-manager.js";

test("watcher 只打脏标记并在 quiet window 后调度后台刷新", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "x-file-watch-"));
  const runtimeStore = new IndexRuntimeStore();
  const indexService = new LibraryIndexService(new TaskManager(), runtimeStore);
  const watchService = new LibraryWatchService(indexService, 50);

  watchService.start(rootDir);
  fs.writeFileSync(path.join(rootDir, "changed.md"), "watcher", "utf8");
  watchService.recordChangeForTest(rootDir, ".ai-index/ignored.json");
  assert.equal(runtimeStore.listDirtyReasons(rootDir).length, 0);

  watchService.recordChangeForTest(rootDir, "changed.md");

  await waitFor(() => runtimeStore.listDirtyReasons(rootDir).includes("watcher_change"));
  await waitFor(() => {
    const status = indexService.getStatus(rootDir);
    return ["queued", "running", "cooldown", "fresh", "failed"].includes(status.state)
      && status.lastRequestedAt !== null;
  });

  watchService.stopAll();
});

class RecordingIndexService extends LibraryIndexService {
  readonly requests: Array<{ reason?: string | null; targetPath?: string | null }> = [];

  override requestRefresh(
    binding: Parameters<LibraryIndexService["requestRefresh"]>[0],
    input: Parameters<LibraryIndexService["requestRefresh"]>[1],
  ): ReturnType<LibraryIndexService["requestRefresh"]> {
    this.requests.push(input);
    return super.requestRefresh(binding, input);
  }
}

async function waitFor(check: () => boolean): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 3000) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail("等待 watcher 状态超时");
}


test("watcher 会合并 quiet window 内的连续变更，只调度一次刷新", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "x-file-watch-quiet-"));
  const runtimeStore = new IndexRuntimeStore();
  const taskManager = new TaskManager();
  const indexService = new RecordingIndexService(taskManager, runtimeStore);
  const watchService = new LibraryWatchService(indexService, 80);

  watchService.start(rootDir);
  try {
    watchService.recordChangeForTest(rootDir, "docs/a.md");
    await new Promise((resolve) => setTimeout(resolve, 30));
    watchService.recordChangeForTest(rootDir, "docs/b.md");
    await new Promise((resolve) => setTimeout(resolve, 30));
    watchService.recordChangeForTest(rootDir, "docs/c.md");

    await new Promise((resolve) => setTimeout(resolve, 55));
    assert.equal(taskManager.get("library.index_refresh", rootDir), null);

    await waitFor(() => indexService.requests.length === 1);
    assert.equal(indexService.requests[0]?.reason, "watcher_change");
    assert.equal(indexService.requests[0]?.targetPath, null);
  } finally {
    watchService.stopAll();
  }
});
