export type TaskState = "queued" | "running" | "failed" | "fresh" | "queue_timeout";

export interface TaskSummary {
  taskId: string;
  taskType: string;
  key: string;
  state: TaskState;
  source: string;
  categoryTitle?: string | null;
  queuedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
  errorSummary: string | null;
  runningStage: string | null;
  /** 任务运行时进度快照，由具体任务通过 setProgress 写入；TaskManager 本身不解释其结构。 */
  progress?: unknown;
  deduped?: boolean;
}

export interface TaskDefinition<Input, Output> {
  taskType: string;
  timeoutMs: number;
  run: (input: Input, context: TaskRunContext) => Promise<Output>;
}

export interface TaskRunContext {
  taskId: string;
  queuedAt: string;
  startedAt: () => string | null;
  signal: AbortSignal;
  setStage: (stage: string) => void;
  /** 写入任务运行时进度快照，会随 TaskSummary.progress 暴露给外部读取。 */
  setProgress: (progress: unknown) => void;
}

export interface EnqueueTaskInput<Input> {
  key: string;
  source: string;
  categoryTitle?: string | null;
  dedupe?: boolean;
  input: Input;
}

interface TaskRecord<Output = unknown> {
  summary: TaskSummary;
  promise: Promise<Output>;
  controller: AbortController;
  timeout: NodeJS.Timeout | null;
  runningStage: string | null;
  progress: unknown;
}

export interface TaskManagerOptions {
  queueTimeoutMs?: number;
}

const DEFAULT_QUEUE_TIMEOUT_MS = 30_000;

export class TaskManager {
  private readonly definitions = new Map<string, TaskDefinition<unknown, unknown>>();
  private readonly inflight = new Map<string, TaskRecord>();
  private readonly latest = new Map<string, TaskRecord>();
  private readonly history = new Map<string, TaskSummary>();
  private readonly queueTimeoutMs: number;
  private taskSequence = 0;

  constructor(options: TaskManagerOptions = {}) {
    this.queueTimeoutMs = options.queueTimeoutMs ?? DEFAULT_QUEUE_TIMEOUT_MS;
  }

  has(taskType: string): boolean {
    return this.definitions.has(taskType);
  }

  register<Input, Output>(definition: TaskDefinition<Input, Output>): void {
    if (this.definitions.has(definition.taskType)) {
      return;
    }
    this.definitions.set(definition.taskType, definition as TaskDefinition<unknown, unknown>);
  }

  enqueue<Input, Output>(taskType: string, input: EnqueueTaskInput<Input>): TaskSummary {
    const definition = this.definitions.get(taskType);
    if (!definition) {
      throw new Error(`Task type is not registered: ${taskType}`);
    }

    const baseKey = buildRuntimeKey(taskType, input.key);
    const existing = input.dedupe === false ? undefined : this.inflight.get(baseKey);
    if (existing) {
      const deduped = {
        ...this.snapshotRecord(existing),
        deduped: true
      };
      return deduped;
    }

    const taskId = `${taskType}:${hashKey(input.key)}:${Date.now().toString(36)}:${(this.taskSequence += 1).toString(36)}`;
    const runtimeKey = input.dedupe === false ? `${baseKey}:${taskId}` : baseKey;
    const controller = new AbortController();
    const summary: TaskSummary = {
      taskId,
      taskType,
      key: input.key,
      state: "queued",
      source: input.source,
      categoryTitle: input.categoryTitle,
      queuedAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      failedAt: null,
      errorSummary: null,
      runningStage: null
    };

    let record: TaskRecord<Output>;
    let startTask!: () => void;
    let rejectTask!: (error: Error) => void;

    const expireQueuedTask = (): void => {
      if (record.summary.state !== "queued") {
        return;
      }
      record.summary.state = "queue_timeout";
      record.summary.failedAt = new Date().toISOString();
      record.summary.errorSummary = "任务排队超时";
      this.inflight.delete(runtimeKey);
      this.pruneHistory();
      rejectTask(new Error("任务排队超时"));
    };

    const promise = new Promise<Output>((resolve, reject) => {
      rejectTask = reject;
      startTask = () => {
        void Promise.resolve().then(async () => {
          if (summary.state === "queue_timeout") {
            throw new Error("任务排队超时");
          }
          summary.state = "running";
          summary.startedAt = new Date().toISOString();
          const runTimeout = setTimeout(() => controller.abort(), definition.timeoutMs);
          try {
            const output = await definition.run(input.input as unknown, {
              taskId,
              queuedAt: summary.queuedAt,
              startedAt: () => summary.startedAt,
              signal: controller.signal,
              setStage: (stage) => {
                record.runningStage = stage;
                record.summary.runningStage = stage;
              },
              setProgress: (progress) => {
                record.progress = progress;
                summary.progress = progress;
              }
            });
            summary.state = "fresh";
            summary.completedAt = new Date().toISOString();
            summary.errorSummary = null;
            resolve(output as Output);
          } catch (error) {
            summary.state = "failed";
            summary.failedAt = new Date().toISOString();
            summary.errorSummary = error instanceof Error ? error.message : String(error);
            reject(error instanceof Error ? error : new Error(String(error)));
          } finally {
            clearTimeout(runTimeout);
            if (record.timeout) {
              clearTimeout(record.timeout);
            }
            this.inflight.delete(runtimeKey);
            this.pruneHistory();
          }
        });
      };
    });

    promise.catch(() => {
      // 后台任务失败只更新状态，不能变成未处理拒绝。
    });

    record = {
      summary,
      promise,
      controller,
      timeout: null,
      runningStage: null,
      progress: null
    };
    this.inflight.set(runtimeKey, record as TaskRecord);
    this.latest.set(baseKey, record as TaskRecord);
    this.history.set(taskId, summary);

    if (this.queueTimeoutMs <= 0) {
      expireQueuedTask();
    } else {
      record.timeout = setTimeout(expireQueuedTask, this.queueTimeoutMs);
      startTask();
    }

    return this.snapshotRecord(record);
  }

  get(taskType: string, key: string): TaskSummary | null {
    const runtimeKey = buildRuntimeKey(taskType, key);
    const record = this.latest.get(runtimeKey)
      ?? [...this.inflight.values()].reverse()
        .find((item) => item.summary.taskType === taskType && item.summary.key === key);
    return record ? this.snapshotRecord(record) : null;
  }

  list(key: string): TaskSummary[] {
    this.pruneHistory();
    const tasks = [...this.history.values()].filter((task) => task.key === key);
    const active = tasks.filter((task) => task.state === "queued" || task.state === "running");
    const finished = tasks.filter((task) => task.state !== "queued" && task.state !== "running")
      .sort((left, right) => completionTime(right) - completionTime(left));
    return [...active, ...finished].map((task) => ({ ...task }));
  }

  private pruneHistory(): void {
    const finishedByKey = new Map<string, TaskSummary[]>();
    for (const task of this.history.values()) {
      if (task.state === "queued" || task.state === "running") continue;
      const finished = finishedByKey.get(task.key) ?? [];
      finished.push(task);
      finishedByKey.set(task.key, finished);
    }
    for (const finished of finishedByKey.values()) {
      finished.sort((left, right) => completionTime(right) - completionTime(left));
      for (const task of finished.slice(5)) this.history.delete(task.taskId);
    }
  }

  private snapshotRecord(record: TaskRecord): TaskSummary {
    return {
      ...record.summary,
      runningStage: record.runningStage ?? record.summary.runningStage,
      progress: record.progress
    };
  }
}

function completionTime(task: TaskSummary): number {
  const time = Date.parse(task.completedAt ?? task.failedAt ?? task.queuedAt);
  return Number.isNaN(time) ? 0 : time;
}

function buildRuntimeKey(taskType: string, key: string): string {
  return `${taskType}:${key}`;
}

function hashKey(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
}
