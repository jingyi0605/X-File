import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { LibraryRuntimeStatusStore } from "./library-runtime-status-store.js";

test("runtime-status 契约：磁盘快照字段 shape 保持稳定", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "x-file-runtime-status-store-"));
  fs.mkdirSync(path.join(rootDir, ".ai-index", "runtime"), { recursive: true });

  fs.writeFileSync(
    path.join(rootDir, ".ai-index", "runtime-status.json"),
    `${JSON.stringify(
      {
        state: "cooldown",
        lastRequestedAt: "2026-06-18T10:00:00.000Z",
        lastStartedAt: "2026-06-18T10:00:01.000Z",
        lastCompletedAt: "2026-06-18T10:00:05.000Z",
        lastFailedAt: null,
        nextAllowedAt: "2026-06-18T10:00:06.500Z",
        runningStage: null,
        errorSummary: null,
        progress: {
          scannedCount: 4,
          indexedCount: 3,
          skippedCount: 1,
          failedCount: 0,
          unchangedCount: 0,
          totalCount: 4,
          maxConcurrency: null,
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(rootDir, ".ai-index", "runtime", "index-state.json"),
    `${JSON.stringify(
      {
        version: 1,
        generatedAt: "2026-06-18T10:00:05.000Z",
        failedDocuments: [],
        skippedDocuments: [
          {
            path: "docs/legacy.doc",
            extension: ".doc",
            size: 1024,
            mtime: "2026-06-18T09:59:59.000Z",
            indexStatus: "skipped",
          },
        ],
        parserSkips: [
          {
            skipKey: "legacy/.doc",
            adapter: "native_skip_only",
            reasonCode: "legacy_binary",
            extension: ".doc",
            samplePaths: ["docs/legacy.doc"],
            sampleCount: 1,
            totalCount: 1,
            lastMessage: "legacy office binary",
            firstSeenAt: "2026-06-18T10:00:05.000Z",
            lastSeenAt: "2026-06-18T10:00:05.000Z",
            lastRunAt: "2026-06-18T10:00:05.000Z",
          },
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const store = new LibraryRuntimeStatusStore();
  const status = store.read(rootDir);

  assert.ok(status);
  assert.equal(status?.state, "cooldown");
  assert.equal(status?.lastRequestedAt, "2026-06-18T10:00:00.000Z");
  assert.equal(status?.progress?.scannedCount, 4);
  assert.equal(status?.workerHealth, null);
  assert.deepEqual(status?.dirtyReasons, []);
  assert.equal(status?.runtimeIndexState?.generatedAt, "2026-06-18T10:00:05.000Z");
  assert.equal(status?.runtimeIndexState?.skippedDocuments[0]?.path, "docs/legacy.doc");
  assert.equal(status?.runtimeIndexState?.parserSkips[0]?.skipKey, "legacy/.doc");
});

test("runtime-status 兼容旧版 finished 文件结构", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "x-file-runtime-status-legacy-"));
  fs.mkdirSync(path.join(rootDir, ".ai-index"), { recursive: true });

  fs.writeFileSync(
    path.join(rootDir, ".ai-index", "runtime-status.json"),
    `${JSON.stringify(
      {
        version: 1,
        command: "index",
        status: "finished",
        stage: "finished",
        updatedAt: "2026-07-06T09:56:22.640Z",
        taskId: "legacy-task",
        taskType: "affairs.library_index",
        errorSummary: null,
        progress: {
          scannedCount: 17320,
          indexedCount: 0,
          skippedCount: 0,
          failedCount: 0,
          unchangedCount: 17320,
          totalCount: 17320,
          maxConcurrency: 1,
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const store = new LibraryRuntimeStatusStore();
  const status = store.read(rootDir);

  assert.ok(status);
  assert.equal(status?.state, "fresh");
  assert.equal(status?.lastCompletedAt, "2026-07-06T09:56:22.640Z");
  assert.equal(status?.runningStage, null);
  assert.equal(status?.progress?.totalCount, 17320);
});
