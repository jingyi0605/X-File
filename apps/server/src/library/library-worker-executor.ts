import { execFile } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import type {
  ExportBuildOptions,
  ExportBuildResult,
  ExportBuilderExecutor,
  RunTextIndexExecutorOptions,
  SearchIndexBuildOptions,
  SearchIndexBuildResult,
  SearchIndexExecutor,
  TextIndexExecutor,
  TextIndexResult,
} from "@x-file/indexer";

const execFileAsync = promisify(execFile);
const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const desktopCliCandidates = [
  path.resolve(serverDir, "..", "desktop", "target", "debug", "x-file-desktop"),
  path.resolve(serverDir, "..", "desktop", "target", "release", "x-file-desktop"),
  path.resolve(serverDir, "..", "desktop", "src-tauri", "target", "debug", "x-file-desktop"),
  path.resolve(serverDir, "..", "desktop", "src-tauri", "target", "release", "x-file-desktop"),
];

interface WorkerResultEnvelope {
  index?: TextIndexResult | null;
  dirtyScope?: TextIndexResult["dirtyScope"];
  status?: { state?: string | null } | null;
  searchBucketCount?: number;
  searchManifestPath?: string;
  filesWritten?: string[];
  exportedAt?: string;
  exportResult?: ExportBuildResult | null;
}

function withDefaultTextIndexResult(
  partial: Partial<TextIndexResult>,
  options: RunTextIndexExecutorOptions,
  dirtyScope: TextIndexResult["dirtyScope"],
): TextIndexResult {
  const indexedCount = partial.indexedCount ?? partial.indexedPaths?.length ?? 0;
  const skippedCount = partial.skipStats?.skippedCount ?? partial.skippedPaths?.length ?? 0;
  return {
    scannedCount: partial.scannedCount ?? indexedCount + skippedCount,
    indexedCount,
    unchangedCount: partial.unchangedCount ?? 0,
    indexedPaths: partial.indexedPaths ?? [],
    skippedPaths: partial.skippedPaths ?? [],
    failedPaths: partial.failedPaths ?? [],
    failedCount: partial.failedCount ?? 0,
    failures: partial.failures ?? [],
    failureOverflowCount: partial.failureOverflowCount ?? 0,
    deletedCount: partial.deletedCount ?? partial.deletedPaths?.length ?? 0,
    deletedPaths: partial.deletedPaths ?? [],
    dirtyScope: partial.dirtyScope ?? dirtyScope,
    timingsMs: {
      scanFs: partial.timingsMs?.scanFs ?? 0,
      parse: partial.timingsMs?.parse ?? 0,
      tagInference: partial.timingsMs?.tagInference ?? 0,
      skipCatalog: partial.timingsMs?.skipCatalog ?? 0,
      writeIndexed: partial.timingsMs?.writeIndexed ?? 0,
      writeSkipped: partial.timingsMs?.writeSkipped ?? 0,
      scanAndParse: partial.timingsMs?.scanAndParse ?? 0,
      writeSuccess: partial.timingsMs?.writeSuccess ?? 0,
      writeFailure: partial.timingsMs?.writeFailure ?? 0,
      scanLoop: partial.timingsMs?.scanLoop ?? 0,
      cleanup: partial.timingsMs?.cleanup ?? 0,
      reconcile: partial.timingsMs?.reconcile ?? 0,
      dirtyScope: partial.timingsMs?.dirtyScope ?? 0,
      total: partial.timingsMs?.total ?? 0,
    },
    batchStats: {
      writeBatchSize: partial.batchStats?.writeBatchSize ?? options.config.writeBatchSize,
      successBatchCount: partial.batchStats?.successBatchCount ?? indexedCount + skippedCount,
      failureBatchCount: partial.batchStats?.failureBatchCount ?? 0,
    },
    tagStats: {
      directAssignedCount: partial.tagStats?.directAssignedCount ?? 0,
      derivedAssignedCount: partial.tagStats?.derivedAssignedCount ?? 0,
      avgDirectPerIndexedDocument: partial.tagStats?.avgDirectPerIndexedDocument ?? 0,
      avgDerivedPerIndexedDocument: partial.tagStats?.avgDerivedPerIndexedDocument ?? 0,
    },
    skipStats: {
      skippedCount,
      skippedByExtension: partial.skipStats?.skippedByExtension ?? {},
      skipCatalogRecords: partial.skipStats?.skipCatalogRecords ?? skippedCount,
    },
  };
}

function resolveNativeDesktopCli(): string | null {
  const explicit = process.env.X_FILE_DESKTOP_CLI_PATH?.trim();
  if (explicit) {
    return fs.existsSync(explicit) ? explicit : null;
  }
  return desktopCliCandidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

async function execWorkerPayload(
  mode: "index-only" | "search-only" | "export-only",
  payload: Record<string, unknown>,
): Promise<string> {
  const nativeCli = resolveNativeDesktopCli();
  if (nativeCli) {
    const output = await execFileAsync(nativeCli, [
      "library-worker",
      mode,
      JSON.stringify(payload),
    ], {
      cwd: serverDir,
    });
    return output.stdout;
  }

  throw new Error(`未找到桌面原生 library worker CLI：${desktopCliCandidates.join(", ")}；server 默认不再回退 Node JS worker`);
}

function canUseWorkerTextExecutor(options: RunTextIndexExecutorOptions): boolean {
  return !options.catalogStore
    && !options.dirtyScopeResolver
    && !options.parser
    && !options.dbDriver;
}

function canUseWorkerSearchExecutor(_config: Parameters<SearchIndexExecutor>[0], _options?: SearchIndexBuildOptions): boolean {
  return true;
}

export function createWorkerBackedTextIndexExecutor(
  fallback: TextIndexExecutor,
): TextIndexExecutor {
  return async (options) => {
    if (!canUseWorkerTextExecutor(options)) {
      return fallback(options);
    }

    const payload = {
      mode: "index-only",
      rootDir: options.config.rootDir,
      targetPath: options.targetPath ?? null,
      allowedExtensions: options.allowedExtensionsOverride ?? options.config.allowedExtensions,
      includedHiddenPaths: options.config.includedHiddenPaths,
      reason: "worker_default_text_index",
      queuedAt: new Date().toISOString(),
      taskId: null,
      sqliteDriver: "node:sqlite",
    };
    const parsed = JSON.parse((await execWorkerPayload("index-only", payload)).trim()) as WorkerResultEnvelope;
    if (!parsed.dirtyScope) {
      throw new Error("index worker 未返回 dirtyScope，无法映射默认 text executor 结果");
    }
    if (parsed.index) {
      return withDefaultTextIndexResult(parsed.index, options, parsed.dirtyScope);
    }
    return withDefaultTextIndexResult({}, options, parsed.dirtyScope);
  };
}

export function createWorkerBackedSearchIndexExecutor(
  fallback: SearchIndexExecutor,
): SearchIndexExecutor {
  return async (config, options = {}, dataSource) => {
    if (!canUseWorkerSearchExecutor(config, options)) {
      return fallback(config, options, dataSource);
    }

    const payload = {
      mode: "search-only",
      rootDir: config.rootDir,
      targetPath: options.targetPath ?? null,
      allowedExtensions: config.allowedExtensions,
      includedHiddenPaths: config.includedHiddenPaths,
      reason: options.reason ?? "worker_default_search_index",
      queuedAt: new Date().toISOString(),
      taskId: null,
      dirtyScope: options.dirtyScope ?? null,
      exportDataSourceMode: "snapshot",
      sqliteDriver: "node:sqlite",
    };
    const parsed = JSON.parse((await execWorkerPayload("search-only", payload)).trim()) as WorkerResultEnvelope;
    return {
      outputDir: path.join(config.exportDir, "search"),
      bucketCount: parsed.searchBucketCount ?? 0,
      manifestPath: parsed.searchManifestPath ?? path.join(config.exportDir, "search", "manifest.json"),
      filesWritten: parsed.filesWritten ?? [parsed.searchManifestPath ?? path.join(config.exportDir, "search", "manifest.json")],
      exportedAt: parsed.exportedAt ?? new Date().toISOString(),
    } satisfies SearchIndexBuildResult;
  };
}

export function createWorkerBackedExportExecutor(
  fallback: ExportBuilderExecutor,
): ExportBuilderExecutor {
  return async (config, options = {}, dataSource) => {
    if (!options.dirtyScope) {
      return fallback(config, options, dataSource);
    }

    const payload = {
      mode: "export-only",
      rootDir: config.rootDir,
      targetPath: options.targetPath ?? null,
      allowedExtensions: config.allowedExtensions,
      includedHiddenPaths: config.includedHiddenPaths,
      reason: options.reason ?? "worker_default_export",
      queuedAt: new Date().toISOString(),
      taskId: null,
      dirtyScope: options.dirtyScope,
      exportDataSourceMode: "snapshot",
      sqliteDriver: "node:sqlite",
    };
    const parsed = JSON.parse((await execWorkerPayload("export-only", payload)).trim()) as WorkerResultEnvelope;
    if (!parsed.exportResult) {
      throw new Error("export worker 未返回 exportResult，无法映射默认 export executor 结果");
    }
    return parsed.exportResult;
  };
}
