import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { createLibraryRuntimeConfig } from "@x-file/indexer";

import { createWorkerBackedTextIndexExecutor } from "./library-worker-executor.js";

const execFileAsync = promisify(execFile);
const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("worker backed text executor 优先返回 worker 原始 index 结果而不是零值壳", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "x-file-worker-executor-native-index-"));
  fs.mkdirSync(path.join(rootDir, "docs"), { recursive: true });
  fs.writeFileSync(path.join(rootDir, "docs", "a.md"), "# A\n\nalpha", "utf8");

  const config = createLibraryRuntimeConfig({
    rootDir,
    allowedExtensions: [".md"],
    includedHiddenPaths: [],
  });
  const executor = createWorkerBackedTextIndexExecutor(async () => {
    throw new Error("不应该走 fallback executor");
  });

  const result = await executor({
    config,
    allowedExtensionsOverride: [".md"],
    collectChangedPaths: true,
  });

  assert.equal(result.scannedCount, 1);
  assert.equal(result.indexedCount, 1);
  assert.deepEqual(result.indexedPaths, ["docs/a.md"]);
  assert.equal(result.failedCount, 0);
  assert.equal(result.dirtyScope.trigger, "full");
});

test("找不到桌面原生 CLI 时会明确失败，不再回退 Node JS worker", async () => {
  const original = process.env.X_FILE_DESKTOP_CLI_PATH;
  process.env.X_FILE_DESKTOP_CLI_PATH = path.join(serverDir, "does-not-exist-x-file-desktop");
  try {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "x-file-worker-executor-missing-cli-"));
    const config = createLibraryRuntimeConfig({
      rootDir,
      allowedExtensions: [".md"],
      includedHiddenPaths: [],
    });
    const executor = createWorkerBackedTextIndexExecutor(async () => {
      throw new Error("不应该走 fallback executor");
    });

    await assert.rejects(
      executor({
        config,
        allowedExtensionsOverride: [".md"],
        collectChangedPaths: true,
      }),
      (error: unknown) => {
        assert.equal(error instanceof Error, true);
        assert.match((error as Error).message, /server 默认不再回退 Node JS worker/);
        return true;
      },
    );
  } finally {
    if (original === undefined) {
      delete process.env.X_FILE_DESKTOP_CLI_PATH;
    } else {
      process.env.X_FILE_DESKTOP_CLI_PATH = original;
    }
  }
});
