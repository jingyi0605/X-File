import fs from "node:fs";

import { LibraryIndexService } from "./index-service.js";

interface WatchHandle {
  rootDir: string;
  watcher: fs.FSWatcher;
  refreshTimer: NodeJS.Timeout | null;
  pendingTargetPaths: Set<string>;
}

const DEFAULT_QUIET_WINDOW_MS = 750;

export class LibraryWatchService {
  private readonly handles = new Map<string, WatchHandle>();

  constructor(
    private readonly indexService: LibraryIndexService,
    private readonly quietWindowMs = DEFAULT_QUIET_WINDOW_MS
  ) {}

  start(rootDir: string): void {
    if (this.handles.has(rootDir)) {
      return;
    }

    const handle: WatchHandle = {
      rootDir,
      watcher: null as unknown as fs.FSWatcher,
      refreshTimer: null,
      pendingTargetPaths: new Set<string>()
    };

    const watcher = fs.watch(rootDir, { recursive: true }, (_eventType, fileName) => {
      const targetPath = typeof fileName === "string" ? fileName.replaceAll("\\", "/") : null;
      this.recordChange(handle, targetPath);
    });
    handle.watcher = watcher;

    this.handles.set(rootDir, handle);
  }

  stop(rootDir: string): void {
    const handle = this.handles.get(rootDir);
    if (!handle) {
      return;
    }
    if (handle.refreshTimer) {
      clearTimeout(handle.refreshTimer);
    }
    handle.watcher.close();
    this.handles.delete(rootDir);
  }

  stopAll(): void {
    for (const rootDir of this.handles.keys()) {
      this.stop(rootDir);
    }
  }

  recordChangeForTest(rootDir: string, targetPath: string | null): void {
    const handle = this.handles.get(rootDir);
    if (!handle) {
      throw new Error(`watcher 未启动：${rootDir}`);
    }
    this.recordChange(handle, targetPath);
  }

  private recordChange(handle: WatchHandle, targetPath: string | null): void {
    if (targetPath?.startsWith(".ai-index/") || targetPath === ".ai-index") {
      return;
    }
    this.indexService.markDirty(handle.rootDir, "watcher_change", targetPath);
    if (targetPath) {
      handle.pendingTargetPaths.add(targetPath);
    }
    this.scheduleRefresh(handle);
  }

  private scheduleRefresh(handle: WatchHandle): void {
    if (handle.refreshTimer) {
      clearTimeout(handle.refreshTimer);
    }
    handle.refreshTimer = setTimeout(() => {
      handle.refreshTimer = null;
      const targetPath = collapseTargetPath(handle.pendingTargetPaths);
      handle.pendingTargetPaths.clear();
      this.indexService.requestRefresh({
        libraryId: "default",
        rootDir: handle.rootDir,
        enabled: true,
        mirrorRoot: null,
        allowedExtensions: [],
        includedHiddenPaths: [],
        folderOpenBehavior: "double_click",
        configRelativePath: ".ai-index/doc-semantic-index.config.json",
        exportMode: "v2",
        initialized: true,
        initializedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }, {
        reason: "watcher_change",
        targetPath
      });
    }, this.quietWindowMs);
  }
}

function collapseTargetPath(paths: Set<string>): string | null {
  if (paths.size === 0) {
    return null;
  }
  if (paths.size === 1) {
    return [...paths][0] ?? null;
  }
  return null;
}
