import process from "node:process";

import {
  prepareLibraryIndexRuntime,
  refreshLibraryExportCatalogSnapshot,
  runLibraryTextIndex,
  type RunLibraryIndexStage,
  type TextIndexProgress,
} from "@x-file/indexer";
import type { LibraryIndexProgress } from "@x-file/shared";

import {
  createCooldownStatus,
  describeDirtyScope,
  createWorkerStatus,
  parseWorkerPayload,
  resolveExportCatalogSnapshotPath,
  resolveWorkerSqliteDriver,
  writeWorkerStatus,
} from "./library-worker-support.js";

async function main(): Promise<void> {
  const payload = parseWorkerPayload(process.argv[2], "index worker");
  const rootDir = payload.rootDir.trim();
  if (!rootDir) {
    throw new Error("index worker 缺少 rootDir");
  }

  const lastRequestedAt = payload.queuedAt ?? new Date().toISOString();
  const runningTaskId = payload.taskId?.trim() || null;
  const lastStartedAt = new Date().toISOString();
  if (payload.mode !== "index-only") {
    throw new Error("index worker 现在只接受 index-only；export 请改走独立 export worker");
  }
  const sqliteDriver = resolveWorkerSqliteDriver(payload.sqliteDriver);
  let latestProgress: LibraryIndexProgress | null = null;
  let runningStage: RunLibraryIndexStage | null = null;

  writeWorkerStatus(rootDir, createWorkerStatus("running", {
    lastRequestedAt,
    lastStartedAt,
    runningTaskId,
  }));

  try {
    runningStage = "init_catalog";
    writeWorkerStatus(rootDir, createWorkerStatus("running", {
      lastRequestedAt,
      lastStartedAt,
      runningTaskId,
      runningStage,
    }));
    const prepared = prepareLibraryIndexRuntime({
      rootDir,
      allowedExtensions: payload.allowedExtensions,
      includedHiddenPaths: payload.includedHiddenPaths,
      dbDriverKind: sqliteDriver,
    });
    runningStage = "index_text";
    writeWorkerStatus(rootDir, createWorkerStatus("running", {
      lastRequestedAt,
      lastStartedAt,
      runningTaskId,
      runningStage,
    }));
    const index = await runLibraryTextIndex({
      config: prepared.config,
      targetPath: payload.targetPath ?? undefined,
      allowedExtensions: payload.allowedExtensions,
      dbDriverKind: sqliteDriver,
      onProgress: (progress: TextIndexProgress) => {
        latestProgress = progress;
        writeWorkerStatus(rootDir, createWorkerStatus("running", {
          lastRequestedAt,
          lastStartedAt,
          runningTaskId,
          runningStage,
          progress,
        }));
      },
    });
    const status = createCooldownStatus(lastRequestedAt, lastStartedAt, latestProgress);
    const exportCatalogSnapshotPath = refreshLibraryExportCatalogSnapshot(prepared.config, sqliteDriver);
    writeWorkerStatus(rootDir, status);
    process.stdout.write(`${JSON.stringify({
      accepted: true,
      mode: "index-only",
      reason: payload.reason ?? "native_manual_refresh",
      targetPath: payload.targetPath ?? null,
      taskId: runningTaskId,
      deduped: false,
      status,
      dirtyScope: index.dirtyScope,
      dirtyScopeSummary: describeDirtyScope(index.dirtyScope),
      exportCatalogSnapshotPath: exportCatalogSnapshotPath || resolveExportCatalogSnapshotPath(rootDir),
      sqliteDriver: resolveWorkerSqliteDriver(payload.sqliteDriver),
    })}\n`);
  } catch (error) {
    writeWorkerStatus(rootDir, createWorkerStatus("failed", {
      lastRequestedAt,
      lastStartedAt,
      lastFailedAt: new Date().toISOString(),
      runningStage,
      errorSummary: error instanceof Error ? error.message : String(error),
      progress: latestProgress,
    }));
    throw error;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
