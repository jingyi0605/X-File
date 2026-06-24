import type { ExportBuildResult, ExportBuildOptions } from "./export-builder.js";
import type { RuntimeConfig } from "../../types/runtime-config.js";
import type { ExportCatalogDataSource } from "./export-data-source.js";

export type ExportBuilderExecutor = (
  config: RuntimeConfig,
  options?: ExportBuildOptions,
  dataSource?: ExportCatalogDataSource,
) => Promise<ExportBuildResult>;

let defaultExportBuilderExecutor: ExportBuilderExecutor | null = null;

export function registerDefaultExportBuilderExecutor(executor: ExportBuilderExecutor | null): void {
  defaultExportBuilderExecutor = executor;
}

export function resolveDefaultExportBuilderExecutor(
  fallback: ExportBuilderExecutor,
): ExportBuilderExecutor {
  if (defaultExportBuilderExecutor) {
    return defaultExportBuilderExecutor;
  }
  return async (config) => {
    void fallback;
    throw new Error(
      `未注册默认 ExportBuilderExecutor：默认主路径已经不再允许隐式回落到 in-process Node 执行面。` +
      `如需兼容 fallback，请显式调用 buildLibraryExportInProcess()。rootDir=${config.rootDir}`,
    );
  };
}

export type { ExportBuildResult, ExportBuildOptions, RuntimeConfig, ExportCatalogDataSource };
