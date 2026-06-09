export interface LibraryDebugLogEntry {
  event: string;
  processRole?: string;
  rootDir?: string;
  command?: string;
  taskId?: string | null;
  taskType?: string | null;
  reason?: string | null;
  targetPath?: string | null;
  status?: string;
  durationMs?: number;
  details?: Record<string, unknown>;
}

/**
 * X-File indexer 包不依赖 Host 调试日志。
 * 第一轮只保留可替换的边界，后续由 server 注入真实日志落点。
 */
export function writeLibraryDebugLog(entry: LibraryDebugLogEntry): void {
  if (process.env.X_FILE_INDEXER_DEBUG !== "1") {
    return;
  }
  console.debug(JSON.stringify({
    source: "@x-file/indexer",
    ...entry,
    loggedAt: new Date().toISOString(),
  }));
}
