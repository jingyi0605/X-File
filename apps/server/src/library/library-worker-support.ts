import type { LibraryIndexProgress, LibraryIndexStatus } from "@x-file/shared";
import type { DirtyScope } from "@x-file/indexer";
import path from "node:path";

import { LibraryRuntimeStatusStore } from "../storage/library-runtime-status-store.js";

export const INDEX_COOLDOWN_MS = 1500;

export type LibraryWorkerMode = "index-only" | "export-only" | "search-only";
export type LibraryExportDataSourceMode = "auto" | "snapshot" | "sqlite";
export type LibraryWorkerSqliteDriver = "better-sqlite3" | "node:sqlite";

export interface LibraryWorkerPayload {
  rootDir: string;
  targetPath?: string | null;
  allowedExtensions?: string[];
  includedHiddenPaths?: string[];
  reason?: string;
  queuedAt?: string;
  taskId?: string | null;
  mode?: LibraryWorkerMode;
  dirtyScope?: DirtyScope | null;
  exportDataSourceMode?: LibraryExportDataSourceMode | null;
  sqliteDriver?: LibraryWorkerSqliteDriver | null;
}

const runtimeStatusStore = new LibraryRuntimeStatusStore();

export function parseWorkerPayload(
  raw: string | undefined,
  workerLabel: string,
): LibraryWorkerPayload {
  if (!raw?.trim()) {
    throw new Error(`${workerLabel} 缺少 payload`);
  }
  return JSON.parse(raw) as LibraryWorkerPayload;
}

export function writeWorkerStatus(rootDir: string, status: LibraryIndexStatus): void {
  runtimeStatusStore.write(rootDir, status);
}

export function resolveExportDataSourceMode(
  mode: LibraryExportDataSourceMode | null | undefined,
): LibraryExportDataSourceMode {
  return mode ?? "snapshot";
}

export function resolveWorkerSqliteDriver(
  driver: LibraryWorkerSqliteDriver | null | undefined,
): LibraryWorkerSqliteDriver {
  return driver ?? "node:sqlite";
}

export function resolveExportCatalogSnapshotPath(rootDir: string): string {
  return path.join(rootDir, ".ai-index", "runtime", "export-catalog-snapshot.json");
}

export function describeDirtyScope(dirtyScope: DirtyScope | null | undefined): {
  trigger: DirtyScope["trigger"] | null;
  changedPathCount: number;
  deletedPathCount: number;
  dirtyDirectoryCount: number;
} {
  return {
    trigger: dirtyScope?.trigger ?? null,
    changedPathCount: dirtyScope?.changedPaths.length ?? 0,
    deletedPathCount: dirtyScope?.deletedPaths?.length ?? 0,
    dirtyDirectoryCount: dirtyScope?.dirtyDirectories.length ?? 0,
  };
}

export function createWorkerStatus(
  state: LibraryIndexStatus["state"],
  overrides: Partial<LibraryIndexStatus> = {},
): LibraryIndexStatus {
  return {
    state,
    dirtyReasons: [],
    lastRequestedAt: null,
    lastStartedAt: null,
    lastCompletedAt: null,
    lastFailedAt: null,
    nextAllowedAt: null,
    runningTaskId: null,
    runningStage: null,
    errorSummary: null,
    workerHealth: null,
    progress: null,
    ...overrides,
  };
}

export function createCooldownStatus(
  lastRequestedAt: string,
  lastStartedAt: string,
  progress: LibraryIndexProgress | null,
): LibraryIndexStatus {
  const completedAt = new Date();
  return createWorkerStatus("cooldown", {
    lastRequestedAt,
    lastStartedAt,
    lastCompletedAt: completedAt.toISOString(),
    nextAllowedAt: new Date(completedAt.getTime() + INDEX_COOLDOWN_MS).toISOString(),
    progress,
  });
}
