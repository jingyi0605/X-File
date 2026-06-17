import process from "node:process";

import {
  buildLibrarySearchIndex,
  createLibraryRuntimeConfig,
  createExportCatalogDataSource,
} from "@x-file/indexer";

import {
  createCooldownStatus,
  describeDirtyScope,
  createWorkerStatus,
  parseWorkerPayload,
  resolveExportDataSourceMode,
  resolveWorkerSqliteDriver,
  writeWorkerStatus,
} from "./library-worker-support.js";

async function main(): Promise<void> {
  const payload = parseWorkerPayload(process.argv[2], "search worker");
  const rootDir = payload.rootDir.trim();
  if (!rootDir) {
    throw new Error("search worker 缺少 rootDir");
  }
  if (payload.mode !== "search-only") {
    throw new Error("search worker 现在只接受 search-only");
  }
  if (!payload.dirtyScope) {
    throw new Error("search worker 缺少 dirtyScope");
  }

  const lastRequestedAt = payload.queuedAt ?? new Date().toISOString();
  const runningTaskId = payload.taskId?.trim() || null;
  const lastStartedAt = new Date().toISOString();
  const sqliteDriver = resolveWorkerSqliteDriver(payload.sqliteDriver);
  const dataSourceMode = resolveExportDataSourceMode(payload.exportDataSourceMode);

  writeWorkerStatus(rootDir, createWorkerStatus("running", {
    lastRequestedAt,
    lastStartedAt,
    runningTaskId,
    runningStage: "export_search",
  }));

  try {
    const config = createLibraryRuntimeConfig({
      rootDir,
      allowedExtensions: payload.allowedExtensions,
      includedHiddenPaths: payload.includedHiddenPaths,
    });
    const dataSource = createExportCatalogDataSource(config, dataSourceMode, null);
    const searchResult = await buildLibrarySearchIndex(config, {
      dirtyScope: payload.dirtyScope,
      reason: payload.reason,
      targetPath: payload.targetPath ?? undefined,
    }, dataSource);
    const status = createCooldownStatus(lastRequestedAt, lastStartedAt, null);
    writeWorkerStatus(rootDir, status);
    process.stdout.write(`${JSON.stringify({
      accepted: true,
      mode: "search-only",
      reason: payload.reason ?? "native_manual_refresh",
      targetPath: payload.targetPath ?? null,
      taskId: runningTaskId,
      deduped: false,
      status,
      dirtyScope: payload.dirtyScope,
      dirtyScopeSummary: describeDirtyScope(payload.dirtyScope),
      searchBucketCount: searchResult.bucketCount,
      searchManifestPath: searchResult.manifestPath,
      exportDataSourceMode: dataSourceMode,
      sqliteDriver,
    })}\n`);
  } catch (error) {
    writeWorkerStatus(rootDir, createWorkerStatus("failed", {
      lastRequestedAt,
      lastStartedAt,
      lastFailedAt: new Date().toISOString(),
      runningStage: "export_search",
      errorSummary: error instanceof Error ? error.message : String(error),
      progress: null,
    }));
    throw error;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
