import type {
  SearchIndexBuildOptions,
  SearchIndexBuildResult,
  SearchIndexExecutor,
} from "./search-index-builder.js";
import type { RuntimeConfig } from "../../types/runtime-config.js";
import type { ExportCatalogDataSource } from "../export/export-data-source.js";

let defaultSearchIndexExecutor: SearchIndexExecutor | null = null;

/**
 * 允许宿主注册默认搜索索引执行器。
 * 后续 native/sidecar 可以接管主入口，而不是继续把 Node builder 写死。
 */
export function registerDefaultSearchIndexExecutor(executor: SearchIndexExecutor | null): void {
  defaultSearchIndexExecutor = executor;
}

export function getRegisteredDefaultSearchIndexExecutor(): SearchIndexExecutor | null {
  return defaultSearchIndexExecutor;
}

export function resolveDefaultSearchIndexExecutor(
  fallback: SearchIndexExecutor,
): SearchIndexExecutor {
  if (defaultSearchIndexExecutor) {
    return defaultSearchIndexExecutor;
  }
  return async (config) => {
    void fallback;
    throw new Error(
      `未注册默认 SearchIndexExecutor：默认主路径已经不再允许隐式回落到 in-process Node 执行面。` +
      `如需兼容 fallback，请显式调用 executeSearchIndexInProcess()。rootDir=${config.rootDir}`,
    );
  };
}

export async function withDefaultSearchIndexExecutor<T>(
  executor: SearchIndexExecutor | null,
  run: () => Promise<T>,
): Promise<T> {
  const previous = defaultSearchIndexExecutor;
  defaultSearchIndexExecutor = executor;
  try {
    return await run();
  } finally {
    defaultSearchIndexExecutor = previous;
  }
}

export type {
  SearchIndexBuildOptions,
  SearchIndexBuildResult,
  SearchIndexExecutor,
  RuntimeConfig,
  ExportCatalogDataSource,
};
