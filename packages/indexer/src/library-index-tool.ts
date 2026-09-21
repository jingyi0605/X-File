import fs from "node:fs";
import path from "node:path";

import { buildLibraryExport, type ExportBuildResult } from "./services/export/export-builder.js";
import {
  createExportCatalogDataSource,
  type ExportCatalogDataSourceMode,
  resolveExportCatalogDataSource,
  resolveExportCatalogSnapshotPath,
  writeExportCatalogSnapshot,
} from "./services/export/export-data-source.js";
import { buildFallbackExport, type FallbackExportIndexResult, type FallbackExportResult } from "./services/export/fallback-export-builder.js";
import type { DirtyScope } from "./services/dirty/dirty-scope-resolver.js";
import {
  executeTextIndex,
  type TextIndexExecutor,
  type TextIndexProgress,
  type TextIndexResult,
} from "./services/indexer/text-indexer.js";
import type { TextIndexParser } from "./services/indexer/text-indexer.js";
import {
  createDefaultRuntimeBackedTextIndexStores,
  createSqliteTextIndexCatalogWriteStore,
  createRuntimePreferredTextIndexCatalogReadStore,
  createSqliteTextIndexCatalogReadStore,
  type TextIndexCatalogReadStore,
  writeRuntimeIndexStateSnapshot,
  writeRuntimeActiveFileStateSnapshot,
} from "./services/indexer/text-index-catalog-store.js";
import { initCatalog, type InitCatalogResult } from "./sqlite/init-catalog.js";
import { loadRuntimeConfig } from "./config/load-runtime-config.js";
import type { RuntimeConfig } from "./types/runtime-config.js";
import {
  resolveLibraryIndexerDatabaseDriver,
  type LibraryIndexerDatabaseDriver,
  type LibraryIndexerDatabaseDriverKind,
} from "./sqlite/open-database.js";
import { CatalogWriteRepository } from "./repositories/catalog-write-repository.js";
import type { ExportDocumentRecord } from "./repositories/catalog-repository.js";

export interface RunLibraryIndexOnceOptions {
  rootDir: string;
  targetPath?: string;
  allowedExtensions?: string[];
  includedHiddenPaths?: string[];
  hideDotFiles?: boolean;
  hideSystemFolders?: boolean;
  reason?: string;
  signal?: AbortSignal;
  onStageChange?: (stage: RunLibraryIndexStage) => void;
  /** 文本索引阶段的流式进度回调，结构与上层 LibraryIndexProgress 一致。 */
  onProgress?: (progress: TextIndexProgress) => void;
  dbDriverKind?: LibraryIndexerDatabaseDriverKind;
  parser?: TextIndexParser;
}

export interface PrepareLibraryIndexRuntimeOptions {
  rootDir: string;
  allowedExtensions?: string[];
  includedHiddenPaths?: string[];
  hideDotFiles?: boolean;
  hideSystemFolders?: boolean;
  dbDriver?: LibraryIndexerDatabaseDriver;
  dbDriverKind?: LibraryIndexerDatabaseDriverKind;
}

export interface PrepareLibraryIndexRuntimeResult {
  config: RuntimeConfig;
  catalog: InitCatalogResult;
}

export interface RunLibraryTextIndexOptions {
  config: RuntimeConfig;
  targetPath?: string;
  allowedExtensions?: string[];
  signal?: AbortSignal;
  onProgress?: (progress: TextIndexProgress) => void;
  dbDriver?: LibraryIndexerDatabaseDriver;
  dbDriverKind?: LibraryIndexerDatabaseDriverKind;
  parser?: TextIndexParser;
  executor?: TextIndexExecutor;
}

export interface RunLibraryExportOnceOptions {
  config: RuntimeConfig;
  dirtyScope?: DirtyScope;
  reason?: string;
  targetPath?: string;
  signal?: AbortSignal;
  dataSourceMode?: ExportCatalogDataSourceMode;
  dbDriver?: LibraryIndexerDatabaseDriver;
  dbDriverKind?: LibraryIndexerDatabaseDriverKind;
}

export interface RunLibraryExportOnceResult {
  exportResult: ExportBuildResult;
  requestedDataSourceMode: ExportCatalogDataSourceMode;
  resolvedDataSourceMode: Exclude<ExportCatalogDataSourceMode, "auto">;
  exportCatalogSnapshotPath: string;
}

export type RunLibraryIndexStage =
  | "load_config"
  | "init_catalog"
  | "index_text"
  | "export_snapshot";

export interface RunLibraryIndexOnceResult {
  config: RuntimeConfig;
  catalog: InitCatalogResult | null;
  index: TextIndexResult | FallbackExportIndexResult;
  exportResult: ExportBuildResult | FallbackExportResult;
  fallbackMode: boolean;
}

/**
 * X-File 后端使用的最小索引工具入口。
 * 它只串起一次“加载配置 -> 初始化 SQLite -> 文本索引 -> 导出快照”，不在这里实现队列、watcher 或重试。
 */
export async function runLibraryIndexOnce(
  options: RunLibraryIndexOnceOptions
): Promise<RunLibraryIndexOnceResult> {
  options.onStageChange?.("load_config");
  const config = createLibraryRuntimeConfig({
    rootDir: options.rootDir,
    allowedExtensions: options.allowedExtensions,
    includedHiddenPaths: options.includedHiddenPaths,
    hideDotFiles: options.hideDotFiles,
    hideSystemFolders: options.hideSystemFolders,
    dbDriverKind: options.dbDriverKind,
  });
  try {
    options.onStageChange?.("init_catalog");
    const prepared = prepareLibraryIndexRuntime({
      rootDir: options.rootDir,
      allowedExtensions: options.allowedExtensions,
      includedHiddenPaths: options.includedHiddenPaths,
      hideDotFiles: options.hideDotFiles,
      hideSystemFolders: options.hideSystemFolders,
      dbDriverKind: options.dbDriverKind,
    });

    options.onStageChange?.("index_text");
    const index = await runLibraryTextIndex({
      config: prepared.config,
      targetPath: options.targetPath,
      allowedExtensions: options.allowedExtensions,
      signal: options.signal,
      onProgress: options.onProgress,
      dbDriverKind: options.dbDriverKind,
      parser: options.parser,
    });

    options.onStageChange?.("export_snapshot");
    const exportStage = await runLibraryExportOnce({
      config: prepared.config,
      dirtyScope: index.dirtyScope,
      reason: options.reason ?? "manual_refresh",
      targetPath: options.targetPath,
      signal: options.signal,
      dataSourceMode: "snapshot",
      dbDriverKind: options.dbDriverKind,
    });

    return {
      config: prepared.config,
      catalog: prepared.catalog,
      index,
      exportResult: exportStage.exportResult,
      fallbackMode: false,
    };
  } catch (error) {
    if (!isBetterSqliteBindingError(error)) {
      throw error;
    }
    options.onStageChange?.("export_snapshot");
    const fallback = await buildFallbackExport(config, {
      targetPath: options.targetPath,
      reason: options.reason,
      signal: options.signal
    });
    return {
      config,
      catalog: null,
      index: fallback.index,
      exportResult: fallback.exportResult,
      fallbackMode: true
    };
  }

}

export function createLibraryRuntimeConfig(
  options: PrepareLibraryIndexRuntimeOptions,
): RuntimeConfig {
  return loadRuntimeConfig(options.rootDir, {
    args: {
      rootDir: options.rootDir,
      allowedExtensions: options.allowedExtensions,
      includedHiddenPaths: options.includedHiddenPaths,
      hideDotFiles: options.hideDotFiles,
      hideSystemFolders: options.hideSystemFolders,
    },
  });
}

export function prepareLibraryIndexRuntime(
  options: PrepareLibraryIndexRuntimeOptions,
): PrepareLibraryIndexRuntimeResult {
  const config = createLibraryRuntimeConfig(options);
  const dbDriver = resolveRuntimeDbDriver(options.dbDriver, options.dbDriverKind);
  const catalog = initCatalog(config, {
    dbDriver,
  });
  return { config, catalog };
}

export async function runLibraryTextIndex(
  options: RunLibraryTextIndexOptions,
): Promise<TextIndexResult> {
  const dbDriver = resolveRuntimeDbDriver(options.dbDriver, options.dbDriverKind);
  const stores = createDefaultRuntimeBackedTextIndexStores(options.config, dbDriver ?? null);
  const executor = options.executor ?? executeTextIndex;
  const result = await executor({
    config: options.config,
    targetPath: options.targetPath,
    dbDriver,
    readStore: stores.readStore,
    writeStore: stores.writeStore,
    parser: options.parser,
    allowedExtensionsOverride: options.allowedExtensions,
    collectChangedPaths: Boolean(options.targetPath),
    dirtyScopeTrigger: options.targetPath ? "incremental" : "full",
    signal: options.signal,
    onProgress: options.onProgress,
  });
  refreshRuntimeActiveFileStateSnapshot(options.config, stores.readStore);
  ensureRuntimeExportCatalogSnapshot(options.config, stores.readStore);
  return result;
}

export async function runLibraryExportOnce(
  options: RunLibraryExportOnceOptions,
): Promise<RunLibraryExportOnceResult> {
  const requestedDataSourceMode = options.dataSourceMode ?? "snapshot";
  const dbDriver = resolveRuntimeDbDriver(options.dbDriver, options.dbDriverKind);
  const resolved = resolveExportCatalogDataSource(
    options.config,
    requestedDataSourceMode,
    dbDriver,
  );
  const exportResult = await buildLibraryExport(
    options.config,
    {
      dirtyScope: options.dirtyScope,
      reason: options.reason,
      targetPath: options.targetPath,
      signal: options.signal,
    },
    resolved.dataSource,
  );
  return {
    exportResult,
    requestedDataSourceMode,
    resolvedDataSourceMode: resolved.resolvedMode,
    exportCatalogSnapshotPath: resolved.snapshotPath,
  };
}

export function refreshLibraryExportCatalogSnapshot(
  config: RuntimeConfig,
  dbDriverOrKind: LibraryIndexerDatabaseDriver | LibraryIndexerDatabaseDriverKind | null = null,
): string {
  const dbDriver = typeof dbDriverOrKind === "string"
    ? resolveLibraryIndexerDatabaseDriver(dbDriverOrKind)
    : dbDriverOrKind;
  return writeExportCatalogSnapshot(
    config,
    createExportCatalogDataSource(config, "sqlite", dbDriver),
  );
}

export function refreshRuntimeActiveFileStateSnapshot(
  config: RuntimeConfig,
  readStore = createRuntimePreferredTextIndexCatalogReadStore(
    config,
    createSqliteTextIndexCatalogReadStore({ dbPath: config.dbPath }),
  ),
): string {
  const files = readStore.listActiveFiles({ kind: "all" }).map((item) => ({
    path: item.path,
    extension: item.extension,
    size: item.size,
    mtime: item.mtime,
    indexStatus: item.indexStatus,
  }));
  return writeRuntimeActiveFileStateSnapshot(config, files);
}

export function refreshRuntimeIndexStateSnapshot(
  config: RuntimeConfig,
  dbDriver: LibraryIndexerDatabaseDriver | null = null,
): string {
  const writer = new CatalogWriteRepository(config.dbPath, dbDriver);
  const allFiles = writer.listActiveFiles({ kind: "all" });
  const failedDocuments = allFiles.filter((item) => item.indexStatus === "failed");
  const skippedDocuments = allFiles.filter((item) => item.indexStatus === "skipped");
  return writeRuntimeIndexStateSnapshot(config, {
    version: 1,
    generatedAt: new Date().toISOString(),
    failedDocuments,
    skippedDocuments,
    parserSkips: writer.listParserSkips(200),
  });
}

function resolveRuntimeDbDriver(
  dbDriver: LibraryIndexerDatabaseDriver | null | undefined,
  dbDriverKind: LibraryIndexerDatabaseDriverKind | null | undefined,
): LibraryIndexerDatabaseDriver | undefined {
  if (dbDriver) {
    return dbDriver;
  }
  if (dbDriverKind) {
    return resolveLibraryIndexerDatabaseDriver(dbDriverKind);
  }
  return undefined;
}

function isBetterSqliteBindingError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.message.includes("Could not locate the bindings file")
    || error.message.includes("better_sqlite3.node")
    || error.message.includes("better-sqlite3");
}

function ensureRuntimeExportCatalogSnapshot(
  config: RuntimeConfig,
  readStore: TextIndexCatalogReadStore,
): string {
  const snapshotPath = resolveExportCatalogSnapshotPath(config);
  const activePaths = readStore.listActiveFiles({ kind: "all" })
    .filter((item) => item.indexStatus === "indexed")
    .map((item) => item.path);
  const documents = readStore.listExportDocumentsByPaths(activePaths);
  const tagPaths = new Set<string>();
  for (const document of documents) {
    document.tags.forEach((item) => tagPaths.add(item));
    document.derivedTags.forEach((item) => tagPaths.add(item));
  }

  const snapshot = {
    version: 1 as const,
    generatedAt: new Date().toISOString(),
    tags: buildExportTagRecords(tagPaths),
    documents: documents
      .map(cloneExportDocumentRecord)
      .sort((left, right) => left.path.localeCompare(right.path, "zh-Hans-CN")),
  };
  fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
  fs.writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf-8");
  return snapshotPath;
}

function buildExportTagRecords(tagPaths: Iterable<string>) {
  const tagMap = new Map<string, {
    path: string;
    name: string;
    rootType: string;
    parentPath: string | null;
    depth: number;
  }>();
  for (const tagPath of tagPaths) {
    const parts = tagPath.split("/").map((item) => item.trim()).filter(Boolean);
    for (let index = 0; index < parts.length; index += 1) {
      const currentPath = parts.slice(0, index + 1).join("/");
      if (tagMap.has(currentPath)) {
        continue;
      }
      tagMap.set(currentPath, {
        path: currentPath,
        name: parts[index]!,
        rootType: parts[0]!,
        parentPath: index === 0 ? null : parts.slice(0, index).join("/"),
        depth: index,
      });
    }
  }
  return [...tagMap.values()].sort((left, right) => left.path.localeCompare(right.path, "zh-Hans-CN"));
}

function cloneExportDocumentRecord(document: ExportDocumentRecord): ExportDocumentRecord {
  return {
    ...document,
    tags: [...document.tags],
    derivedTags: [...document.derivedTags],
  };
}
