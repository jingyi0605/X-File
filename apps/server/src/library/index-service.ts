import type { LibraryBinding, LibraryIndexProgress, LibraryIndexStatus, LibraryRefreshResult } from "@x-file/shared";

import { IndexRuntimeStore } from "../storage/index-runtime-store.js";
import { LibraryRuntimeStatusStore } from "../storage/library-runtime-status-store.js";
import { TaskManager, type TaskSummary } from "../tasks/task-manager.js";

export const LIBRARY_INDEX_TASK_TYPE = "library.index_refresh";
const INDEX_COOLDOWN_MS = 1500;

export interface RequestIndexRefreshInput {
  reason?: string | null;
  targetPath?: string | null;
}

interface LibraryIndexTaskInput {
  binding: LibraryBinding;
  reason: string;
  targetPath: string | null;
}

interface RunLibraryIndexOnceOptions {
  rootDir: string;
  targetPath?: string;
  allowedExtensions?: string[];
  includedHiddenPaths?: string[];
  reason?: string;
  signal?: AbortSignal;
  onStageChange?: (stage: string) => void;
  onProgress?: (progress: LibraryIndexProgress) => void;
}

type RunLibraryIndexOnce = (options: RunLibraryIndexOnceOptions) => Promise<unknown>;

export class LibraryIndexService {
  private readonly runtimeStatusStore: LibraryRuntimeStatusStore;

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
      const status = this.statusFromTask(rootDir, task);
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
        const freshStatus = createStatus("fresh", {
          ...storedStatus,
          state: "fresh",
          nextAllowedAt: null,
          runningTaskId: null,
          runningStage: null,
          dirtyReasons: this.runtimeStore.listDirtyReasons(rootDir)
        });
        this.applyStatus(rootDir, freshStatus);
        return freshStatus;
      }
    }

    if (storedStatus) {
      return storedStatus;
    }

    return createStatus("fresh", {
      dirtyReasons: this.runtimeStore.listDirtyReasons(rootDir)
    });
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

  /** 统一写入：内存缓存 + 磁盘持久化，保证重启后面板仍能读取进度与时间线。 */
  private applyStatus(rootDir: string, status: LibraryIndexStatus): void {
    this.runtimeStore.setStatus(rootDir, status);
    this.runtimeStatusStore.write(rootDir, status);
  }

  private registerTasks(): void {
    if (this.taskManager.has(LIBRARY_INDEX_TASK_TYPE)) {
      return;
    }

    this.taskManager.register<LibraryIndexTaskInput, void>({
      taskType: LIBRARY_INDEX_TASK_TYPE,
      timeoutMs: 120_000,
      run: async (input, context) => {
        let latestProgress: LibraryIndexProgress | null = null;
        this.applyStatus(input.binding.rootDir, createStatus("running", {
          dirtyReasons: this.runtimeStore.listDirtyReasons(input.binding.rootDir),
          lastRequestedAt: new Date().toISOString(),
          lastStartedAt: new Date().toISOString(),
          runningTaskId: context.taskId
        }));

        try {
          const runLibraryIndexOnce = this.runLibraryIndexOnceOverride ?? await loadRunLibraryIndexOnce();
          await runLibraryIndexOnce({
            rootDir: input.binding.rootDir,
            targetPath: input.targetPath ?? undefined,
            allowedExtensions: input.binding.allowedExtensions,
            includedHiddenPaths: input.binding.includedHiddenPaths,
            reason: input.reason,
            signal: context.signal,
            onStageChange: context.setStage,
            onProgress: (progress) => {
              latestProgress = progress;
              context.setProgress(progress);
            }
          });

          this.runtimeStore.clearDirty(input.binding.rootDir);
          const completedAt = new Date();
          this.applyStatus(input.binding.rootDir, createStatus("cooldown", {
            lastRequestedAt: context.queuedAt,
            lastStartedAt: context.startedAt(),
            lastCompletedAt: completedAt.toISOString(),
            nextAllowedAt: new Date(completedAt.getTime() + INDEX_COOLDOWN_MS).toISOString(),
            progress: latestProgress
          }));
        } catch (error) {
          // 失败状态也持久化到磁盘，重启后面板仍能展示失败原因与进度
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

async function loadRunLibraryIndexOnce(): Promise<RunLibraryIndexOnce> {
  const importIndexer = new Function("specifier", "return import(specifier)") as (
    specifier: string
  ) => Promise<{ runLibraryIndexOnce: RunLibraryIndexOnce }>;
  const indexer = await importIndexer("@x-file/indexer");
  return indexer.runLibraryIndexOnce;
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
