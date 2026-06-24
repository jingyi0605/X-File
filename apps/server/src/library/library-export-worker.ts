import process from "node:process";

import {
  createLibraryRuntimeConfig,
  runLibraryExportOnce,
} from "@x-file/indexer";

import {
  createCooldownStatus,
  describeDirtyScope,
  createWorkerStatus,
  parseWorkerPayload,
  resolveExportCatalogSnapshotPath,
  resolveExportDataSourceMode,
  resolveWorkerSqliteDriver,
  writeWorkerStatus,
} from "./library-worker-support.js";

async function main(): Promise<void> {
  const payload = parseWorkerPayload(process.argv[2], "export worker");
  const rootDir = payload.rootDir.trim();
  if (!rootDir) {
    throw new Error("export worker 缺少 rootDir");
  }
  if (payload.mode !== "export-only") {
    throw new Error("export worker 现在只接受 export-only");
  }
  if (!payload.dirtyScope) {
    throw new Error("export worker 缺少 dirtyScope；请先执行 index-only，再由宿主驱动 export-only");
  }

  const lastRequestedAt = payload.queuedAt ?? new Date().toISOString();
  const runningTaskId = payload.taskId?.trim() || null;
  const lastStartedAt = new Date().toISOString();
  const dataSourceMode = resolveExportDataSourceMode(payload.exportDataSourceMode);
  const sqliteDriver = resolveWorkerSqliteDriver(payload.sqliteDriver);
  const snapshotPath = resolveExportCatalogSnapshotPath(rootDir);

  writeWorkerStatus(rootDir, createWorkerStatus("running", {
    lastRequestedAt,
    lastStartedAt,
    runningTaskId,
    runningStage: "export_snapshot",
  }));

  try {
    const config = createLibraryRuntimeConfig({
      rootDir,
      allowedExtensions: payload.allowedExtensions,
      includedHiddenPaths: payload.includedHiddenPaths,
    });
    const exportStage = await runLibraryExportOnce({
      config,
      dirtyScope: payload.dirtyScope,
      reason: payload.reason,
      targetPath: payload.targetPath ?? undefined,
      dataSourceMode,
      dbDriverKind: sqliteDriver,
    });
    const status = createCooldownStatus(lastRequestedAt, lastStartedAt, null);
    writeWorkerStatus(rootDir, status);
    process.stdout.write(`${JSON.stringify({
      accepted: true,
      mode: "export-only",
      reason: payload.reason ?? "native_manual_refresh",
      targetPath: payload.targetPath ?? null,
      taskId: runningTaskId,
      deduped: false,
      status,
      exportResult: exportStage.exportResult,
      dirtyScope: payload.dirtyScope,
      dirtyScopeSummary: describeDirtyScope(payload.dirtyScope),
      exportDataSourceMode: exportStage.resolvedDataSourceMode,
      exportDataSourceModeRequested: exportStage.requestedDataSourceMode,
      exportCatalogSnapshotPath: exportStage.exportCatalogSnapshotPath || snapshotPath,
      exportCatalogSnapshotRequired: dataSourceMode === "snapshot",
      exportFallbackToSqlite: exportStage.resolvedDataSourceMode === "sqlite",
      sqliteDriver: resolveWorkerSqliteDriver(payload.sqliteDriver),
    })}\n`);
  } catch (error) {
    const errorSummary = toExportWorkerErrorSummary(error, dataSourceMode, snapshotPath);
    writeWorkerStatus(rootDir, createWorkerStatus("failed", {
      lastRequestedAt,
      lastStartedAt,
      lastFailedAt: new Date().toISOString(),
      runningStage: "export_snapshot",
      errorSummary,
      progress: null,
    }));
    throw new Error(errorSummary);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

function toExportWorkerErrorSummary(
  error: unknown,
  dataSourceMode: string,
  snapshotPath: string,
): string {
  const rawMessage = error instanceof Error ? error.message : String(error);
  if (dataSourceMode === "snapshot" && rawMessage.includes("export catalog snapshot 不存在")) {
    return `export worker 缺少 snapshot 主路径输入：${snapshotPath}；请先执行 index-only，或仅在调试/应急场景下显式改用 sqlite`;
  }
  return rawMessage;
}
