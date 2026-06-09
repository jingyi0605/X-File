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
