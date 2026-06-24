import {
  registerDefaultExportBuilderExecutor,
  registerDefaultSearchIndexExecutor,
  registerDefaultTextIndexExecutor,
  type ExportBuilderExecutor,
  type SearchIndexExecutor,
  type TextIndexExecutor,
} from "@x-file/indexer";

let registered = false;

/**
 * 把 packages/indexer 的默认执行入口注册为宿主 worker 调用。
 * 这样 executeTextIndex / executeSearchIndex 的默认路径就不会再把 Node 类实现当主执行面。
 */
export function registerLibraryDefaultExecutors(options: {
  runTextIndex: TextIndexExecutor;
  runSearchIndex: SearchIndexExecutor;
  runExport: ExportBuilderExecutor;
}): void {
  if (registered) {
    return;
  }
  registerDefaultTextIndexExecutor(options.runTextIndex);
  registerDefaultSearchIndexExecutor(options.runSearchIndex);
  registerDefaultExportBuilderExecutor(options.runExport);
  registered = true;
}

export function clearLibraryDefaultExecutors(): void {
  registerDefaultTextIndexExecutor(null);
  registerDefaultSearchIndexExecutor(null);
  registerDefaultExportBuilderExecutor(null);
  registered = false;
}

export function createDefaultLibraryTextExecutor(): TextIndexExecutor {
  return async (options) => {
    throw new Error(
      `server 默认 TextIndexExecutor 未注册 worker/native 实现；` +
      `正式主链已经不再允许回落到 in-process Node。rootDir=${options.config.rootDir}`,
    );
  };
}

export function createDefaultLibrarySearchExecutor(): SearchIndexExecutor {
  return async (config) => {
    throw new Error(
      `server 默认 SearchIndexExecutor 未注册 worker/native 实现；` +
      `正式主链已经不再允许回落到 in-process Node。rootDir=${config.rootDir}`,
    );
  };
}

export function createDefaultLibraryExportExecutor(): ExportBuilderExecutor {
  return async (config) => {
    throw new Error(
      `server 默认 ExportBuilderExecutor 未注册 worker/native 实现；` +
      `正式主链已经不再允许回落到 in-process Node。rootDir=${config.rootDir}`,
    );
  };
}
