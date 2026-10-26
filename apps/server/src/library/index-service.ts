import { runLibraryIndexOnce as runNativeIndex } from "@x-file/indexer";
import type { LibraryBinding, LibraryIndexProgress, LibraryIndexStatus, LibraryRefreshResult } from "@x-file/shared";

import { IndexRuntimeStore } from "../storage/index-runtime-store.js";
import { LibraryRuntimeStatusStore } from "../storage/library-runtime-status-store.js";
import { TaskManager, type TaskSummary } from "../tasks/task-manager.js";

export const LIBRARY_INDEX_TASK_TYPE = "library.index_refresh";
const INDEX_COOLDOWN_MS = 1500;
const INDEX_RUN_TIMEOUT_MS = 30 * 60_000;

export interface RequestIndexRefreshInput {
  reason?: string | null;
  targetPath?: string | null;
}

interface LibraryIndexTaskInput {
  binding: LibraryBinding;
  reason: string;
  targetPath: string | null;
  targetPaths?: string[];
}

interface RunLibraryIndexOnceOptions {
  rootDir: string;
  targetPath?: string;
  targetPaths?: string[];
  allowedExtensions?: string[];
  includedHiddenPaths?: string[];
  hideDotFiles?: boolean;
  hideSystemFolders?: boolean;
  reason?: string;
  signal?: AbortSignal;
  onStageChange?: (stage: string) => void;
  onProgress?: (progress: LibraryIndexProgress) => void;
}

type RunLibraryIndexOnce = (options: RunLibraryIndexOnceOptions) => Promise<unknown>;

export class LibraryIndexService {
  private readonly runtimeStatusStore: LibraryRuntimeStatusStore;
  private readonly pending = new Map<string, LibraryIndexTaskInput>();

  constructor(
    private readonly taskManager: TaskManager,
    private readonly runtimeStore: IndexRuntimeStore,
    runtimeStatusStore?: LibraryRuntimeStatusStore,
    private readonly runLibraryIndexOnceOverride?: RunLibraryIndexOnce
  ) {
    this.runtimeStatusStore = runtimeStatusStore ?? new LibraryRuntimeStatusStore();
    this.registerTasks();
  }

  requestRefresh(binding: LibraryBinding, input: RequestIndexRefreshInput): LibraryRefreshResult {
    const reason = input.reason?.trim() || "manual_refresh";
    const targetPath = input.targetPath?.trim() || null;
    this.runtimeStore.markDirty(binding.rootDir, reason, targetPath);

    const next = { binding, reason, targetPath, targetPaths: targetPath ? [targetPath] : [] };
    const previous = this.pending.get(binding.rootDir);
    this.pending.set(binding.rootDir, previous ? {
      ...next,
      targetPath: previous.targetPath === next.targetPath ? next.targetPath : null,
      targetPaths: previous.targetPaths?.length && next.targetPaths.length
        ? [...new Set([...previous.targetPaths, ...next.targetPaths])]
        : [],
    } : next);

    const task = this.taskManager.enqueue<LibraryIndexTaskInput, void>(LIBRARY_INDEX_TASK_TYPE, {
      key: binding.rootDir,
      source: "library.request_refresh",
      input: {
        binding,
        reason,
        targetPath
      }
    });

    const status = this.statusFromTask(binding.rootDir, task);
    this.applyStatus(binding.rootDir, status);
    return {
      accepted: true,
      libraryId: binding.libraryId,
      reason,
      targetPath,
      taskId: task.taskId,
      deduped: task.deduped === true,
      status
    };
  }

  getStatus(rootDir: string): LibraryIndexStatus {
    const task = this.taskManager.get(LIBRARY_INDEX_TASK_TYPE, rootDir);
    if (task && task.state !== "fresh") {
      const status = this.withRuntimeIndexState(rootDir, this.statusFromTask(rootDir, task));
      if (task.state === "queued" || task.state === "running" || task.state === "queue_timeout" || task.state === "failed") {
        this.runtimeStore.setStatus(rootDir, status);
      }
      return status;
    }

    // 稳态：优先内存，内存缺失（例如重启后）则回读磁盘持久化快照
    const storedStatus = this.runtimeStore.getStatus(rootDir)
      ?? this.runtimeStatusStore.read(rootDir);
    if (storedStatus?.state === "cooldown" && storedStatus.nextAllowedAt) {
      const nextAllowedAt = Date.parse(storedStatus.nextAllowedAt);
      if (Number.isFinite(nextAllowedAt) && nextAllowedAt <= Date.now()) {
        const freshStatus = this.withRuntimeIndexState(rootDir, createStatus("fresh", {
          ...storedStatus,
          state: "fresh",
          nextAllowedAt: null,
          runningTaskId: null,
          runningStage: null,
          dirtyReasons: this.runtimeStore.listDirtyReasons(rootDir)
        }));
        this.applyStatus(rootDir, freshStatus);
        return freshStatus;
      }
    }

    if (storedStatus) {
      return this.withRuntimeIndexState(rootDir, storedStatus);
    }

    return this.withRuntimeIndexState(rootDir, createStatus("fresh", {
      dirtyReasons: this.runtimeStore.listDirtyReasons(rootDir)
    }));
  }

  markDirty(rootDir: string, reason: string, targetPath: string | null = null): void {
    this.runtimeStore.markDirty(rootDir, reason, targetPath);
    const current = this.getStatus(rootDir);
    if (current.state === "fresh") {
      this.applyStatus(rootDir, {
        ...current,
        state: "stale",
        dirtyReasons: this.runtimeStore.listDirtyReasons(rootDir)
      });
    }
  }

  /** 宿主只维护队列视图，磁盘状态统一由持有根目录锁的原生任务写入。 */
  private applyStatus(rootDir: string, status: LibraryIndexStatus): void {
    const nextStatus = this.withRuntimeIndexState(rootDir, status);
    this.runtimeStore.setStatus(rootDir, nextStatus);
  }

  private withRuntimeIndexState(rootDir: string, status: LibraryIndexStatus): LibraryIndexStatus {
    return {
      ...status,
      runtimeIndexState: this.runtimeStatusStore.readRuntimeIndexState(rootDir),
    };
  }

  private registerTasks(): void {
    if (this.taskManager.has(LIBRARY_INDEX_TASK_TYPE)) {
      return;
    }

    this.taskManager.register<LibraryIndexTaskInput, void>({
      taskType: LIBRARY_INDEX_TASK_TYPE,
      timeoutMs: INDEX_RUN_TIMEOUT_MS,
      run: async (input, context) => {
        let latestProgress: LibraryIndexProgress | null = null;
        this.applyStatus(input.binding.rootDir, createStatus("running", {
          dirtyReasons: this.runtimeStore.listDirtyReasons(input.binding.rootDir),
          lastRequestedAt: new Date().toISOString(),
          lastStartedAt: new Date().toISOString(),
          runningTaskId: context.taskId
        }));

        try {
          const runLibraryIndexOnce = this.runLibraryIndexOnceOverride ?? runNativeIndex;
          let work = this.pending.get(input.binding.rootDir);
          while (work) {
            this.pending.delete(input.binding.rootDir);
            await runLibraryIndexOnce({
              rootDir: work.binding.rootDir,
              targetPath: work.targetPath ?? undefined,
              ...(work.targetPaths && work.targetPaths.length > 1 ? { targetPaths: work.targetPaths } : {}),
              allowedExtensions: work.binding.allowedExtensions,
              includedHiddenPaths: work.binding.includedHiddenPaths,
              hideDotFiles: work.binding.hideDotFiles,
              hideSystemFolders: work.binding.hideSystemFolders,
              reason: work.reason,
              signal: context.signal,
              onStageChange: context.setStage,
              onProgress: (progress) => {
                latestProgress = progress;
                context.setProgress(progress);
              }
            });
            work = this.pending.get(input.binding.rootDir);
          }

          this.runtimeStore.clearDirty(input.binding.rootDir);
          const completedAt = new Date();
          const persisted = this.runtimeStatusStore.read(input.binding.rootDir);
          this.applyStatus(input.binding.rootDir, createStatus("cooldown", {
            lastRequestedAt: context.queuedAt,
            lastStartedAt: context.startedAt(),
            lastCompletedAt: persisted?.lastCompletedAt ?? completedAt.toISOString(),
            nextAllowedAt: persisted?.nextAllowedAt ?? new Date(completedAt.getTime() + INDEX_COOLDOWN_MS).toISOString(),
            progress: latestProgress ?? persisted?.progress ?? null
          }));
        } catch (error) {
          // 任务失败保留在宿主队列中，原生任务负责自己的磁盘状态。
          this.applyStatus(input.binding.rootDir, createStatus("failed", {
            lastRequestedAt: context.queuedAt,
            lastStartedAt: context.startedAt(),
            lastFailedAt: new Date().toISOString(),
            errorSummary: error instanceof Error ? error.message : String(error),
            progress: latestProgress
          }));
          throw error;
        }
      }
    });
  }

  private statusFromTask(rootDir: string, task: TaskSummary): LibraryIndexStatus {
    return createStatus(task.state, {
      dirtyReasons: this.runtimeStore.listDirtyReasons(rootDir),
      lastRequestedAt: task.queuedAt,
      lastStartedAt: task.startedAt,
      lastCompletedAt: task.completedAt,
      lastFailedAt: task.failedAt,
      runningTaskId: task.state === "running" || task.state === "queued" ? task.taskId : null,
      runningStage: task.runningStage,
      errorSummary: task.errorSummary,
      progress: (task.progress as LibraryIndexProgress | null) ?? null
    });
  }
}

function createStatus(
  state: LibraryIndexStatus["state"],
  overrides: Partial<LibraryIndexStatus> = {}
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
    ...overrides
  };
}
