import { ExportBuilder, type ExportBuildResult } from "./services/export/export-builder.js";
import { buildFallbackExport, type FallbackExportIndexResult, type FallbackExportResult } from "./services/export/fallback-export-builder.js";
import { TextIndexer, type TextIndexProgress, type TextIndexResult } from "./services/indexer/text-indexer.js";
import { initCatalog, type InitCatalogResult } from "./sqlite/init-catalog.js";
import { loadRuntimeConfig } from "./config/load-runtime-config.js";
import type { RuntimeConfig } from "./types/runtime-config.js";

export interface RunLibraryIndexOnceOptions {
  rootDir: string;
  targetPath?: string;
  allowedExtensions?: string[];
  includedHiddenPaths?: string[];
  reason?: string;
  signal?: AbortSignal;
  onStageChange?: (stage: RunLibraryIndexStage) => void;
  /** 文本索引阶段的流式进度回调，结构与上层 LibraryIndexProgress 一致。 */
  onProgress?: (progress: TextIndexProgress) => void;
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
  const config = loadRuntimeConfig(options.rootDir, {
    args: {
      rootDir: options.rootDir,
      allowedExtensions: options.allowedExtensions,
      includedHiddenPaths: options.includedHiddenPaths
    }
  });

  let catalog: InitCatalogResult;
  try {
    options.onStageChange?.("init_catalog");
    catalog = initCatalog(config);
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

  options.onStageChange?.("index_text");
  const index = await new TextIndexer(config).index(options.targetPath, {
    allowedExtensionsOverride: options.allowedExtensions,
    collectChangedPaths: Boolean(options.targetPath),
    dirtyScopeTrigger: options.targetPath ? "incremental" : "full",
    signal: options.signal,
    onProgress: options.onProgress
  });

  options.onStageChange?.("export_snapshot");
  const exportResult = await new ExportBuilder(config).build({
    dirtyScope: index.dirtyScope,
    reason: options.reason ?? "manual_refresh",
    targetPath: options.targetPath,
    signal: options.signal
  });

  return {
    config,
    catalog,
    index,
    exportResult,
    fallbackMode: false
  };
}

function isBetterSqliteBindingError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.message.includes("Could not locate the bindings file")
    || error.message.includes("better_sqlite3.node")
    || error.message.includes("better-sqlite3");
}
