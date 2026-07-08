import fs from "node:fs";
import path from "node:path";

import type {
  LibraryIndexProgress,
  LibraryIndexStatus,
  LibraryRuntimeIndexState,
} from "@x-file/shared";
import { readRuntimeIndexStateSnapshot, type RuntimeIndexStateSnapshot } from "@x-file/indexer";

/**
 * 索引运行时状态在磁盘上的持久化快照。
 * 文件位于 `<rootDir>/.ai-index/runtime-status.json`，由索引任务在运行/完成/失败时写入，
 * 在服务器重启后的稳态下供面板读取，确保进度与时间线不丢失。
 */
const RUNTIME_STATUS_RELATIVE_PATH = path.join(".ai-index", "runtime-status.json");

/** 仅持久化稳态有意义的字段，过滤掉 workerHealth（X-File 恒为 null）和 dirtyReasons（仅内存）。 */
interface PersistedRuntimeStatus {
  state: LibraryIndexStatus["state"];
  lastRequestedAt: string | null;
  lastStartedAt: string | null;
  lastCompletedAt: string | null;
  lastFailedAt: string | null;
  nextAllowedAt: string | null;
  runningStage: string | null;
  errorSummary: string | null;
  progress: LibraryIndexProgress | null;
}

interface LegacyPersistedRuntimeStatus {
  status?: string | null;
  stage?: string | null;
  command?: string | null;
  updatedAt?: string | null;
  errorSummary?: string | null;
  progress?: Partial<LibraryIndexProgress> | null;
}

export class LibraryRuntimeStatusStore {
  /** 读取磁盘上的运行时状态快照；文件缺失或损坏时返回 null。 */
  read(rootDir: string): LibraryIndexStatus | null {
    const filePath = this.resolveFilePath(rootDir);
    if (!filePath) {
      return null;
    }
    try {
      if (!fs.existsSync(filePath)) {
        return null;
      }
      const raw = fs.readFileSync(filePath, "utf8");
      const parsed = normalizeRuntimeStatusPayload(JSON.parse(raw));
      return normalizePersistedStatus(parsed, this.readRuntimeIndexState(rootDir));
    } catch {
      return null;
    }
  }

  /** 把运行时状态写入磁盘；rootDir 为空或写入失败时静默跳过，不影响索引主流程。 */
  write(rootDir: string, status: LibraryIndexStatus): void {
    const filePath = this.resolveFilePath(rootDir);
    if (!filePath) {
      return;
    }
    const payload: PersistedRuntimeStatus = {
      state: status.state,
      lastRequestedAt: status.lastRequestedAt,
      lastStartedAt: status.lastStartedAt,
      lastCompletedAt: status.lastCompletedAt,
      lastFailedAt: status.lastFailedAt,
      nextAllowedAt: status.nextAllowedAt,
      runningStage: status.runningStage,
      errorSummary: status.errorSummary,
      progress: status.progress ?? null,
    };
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    } catch {
      // 磁盘写入失败不阻断索引流程，仅丢失持久化快照。
    }
  }

  readRuntimeIndexState(rootDir: string): LibraryRuntimeIndexState | null {
    const normalized = rootDir?.trim();
    if (!normalized) {
      return null;
    }
    try {
      const snapshot = readRuntimeIndexStateSnapshot({
        indexDir: path.join(normalized, ".ai-index"),
      } as Parameters<typeof readRuntimeIndexStateSnapshot>[0]);
      return normalizeRuntimeIndexState(snapshot);
    } catch {
      return null;
    }
  }

  private resolveFilePath(rootDir: string): string | null {
    const normalized = rootDir?.trim();
    if (!normalized) {
      return null;
    }
    return path.join(normalized, RUNTIME_STATUS_RELATIVE_PATH);
  }
}

/** 把磁盘上的部分字段还原为完整的 LibraryIndexStatus，补齐默认值。 */
function normalizePersistedStatus(
  parsed: Partial<PersistedRuntimeStatus>,
  runtimeIndexState: LibraryRuntimeIndexState | null,
): LibraryIndexStatus | null {
  if (!parsed || !parsed.state) {
    return null;
  }
  return {
    state: parsed.state,
    dirtyReasons: [],
    lastRequestedAt: parsed.lastRequestedAt ?? null,
    lastStartedAt: parsed.lastStartedAt ?? null,
    lastCompletedAt: parsed.lastCompletedAt ?? null,
    lastFailedAt: parsed.lastFailedAt ?? null,
    nextAllowedAt: parsed.nextAllowedAt ?? null,
    runningTaskId: null,
    runningStage: parsed.runningStage ?? null,
    errorSummary: parsed.errorSummary ?? null,
    workerHealth: null,
    progress: parsed.progress ?? null,
    runtimeIndexState,
  };
}

function normalizeRuntimeStatusPayload(
  parsed: unknown,
): Partial<PersistedRuntimeStatus> {
  if (!parsed || typeof parsed !== "object") {
    return {};
  }
  if ("state" in parsed && typeof (parsed as { state?: unknown }).state === "string") {
    return parsed as Partial<PersistedRuntimeStatus>;
  }
  return normalizeLegacyRuntimeStatus(parsed as LegacyPersistedRuntimeStatus);
}

function normalizeLegacyRuntimeStatus(
  parsed: LegacyPersistedRuntimeStatus,
): Partial<PersistedRuntimeStatus> {
  const state = mapLegacyRuntimeStatusState(parsed.status, parsed.stage, parsed.command);
  if (!state) {
    return {};
  }
  const updatedAt = normalizeNullableString(parsed.updatedAt);
  return {
    state,
    lastRequestedAt: null,
    lastStartedAt: updatedAt,
    lastCompletedAt: state === "fresh" ? updatedAt : null,
    lastFailedAt: state === "failed" ? updatedAt : null,
    nextAllowedAt: null,
    runningStage: normalizeNullableString(parsed.stage) === "finished"
      ? null
      : normalizeNullableString(parsed.stage),
    errorSummary: normalizeNullableString(parsed.errorSummary),
    progress: normalizeLegacyProgress(parsed.progress),
  };
}

function mapLegacyRuntimeStatusState(
  status: string | null | undefined,
  stage: string | null | undefined,
  command: string | null | undefined,
): LibraryIndexStatus["state"] | null {
  const normalizedStatus = normalizeNullableString(status);
  switch (normalizedStatus) {
    case "fresh":
    case "stale":
    case "queued":
    case "running":
    case "queue_timeout":
    case "cooldown":
    case "failed":
      return normalizedStatus;
    case "finished":
    case "success":
      return "fresh";
    case "error":
      return "failed";
    case "pending":
      return "queued";
    default:
      break;
  }
  if (normalizeNullableString(stage) === "finished") {
    return "fresh";
  }
  if (normalizeNullableString(stage) === "failed" || normalizeNullableString(stage) === "error") {
    return "failed";
  }
  if (["index", "export", "search"].includes(normalizeNullableString(command) ?? "")) {
    return "running";
  }
  return null;
}

function normalizeLegacyProgress(
  progress: Partial<LibraryIndexProgress> | null | undefined,
): LibraryIndexProgress | null {
  if (!progress || typeof progress !== "object") {
    return null;
  }
  return {
    scannedCount: normalizeCount(progress.scannedCount),
    indexedCount: normalizeCount(progress.indexedCount),
    skippedCount: normalizeCount(progress.skippedCount),
    failedCount: normalizeCount(progress.failedCount),
    unchangedCount: normalizeCount(progress.unchangedCount),
    totalCount: typeof progress.totalCount === "number" ? progress.totalCount : null,
    maxConcurrency: typeof progress.maxConcurrency === "number" ? progress.maxConcurrency : null,
    activeTaskCount: normalizeCount(progress.activeTaskCount),
    pendingTaskCount: normalizeCount(progress.pendingTaskCount),
    completedTaskCount: normalizeCount(progress.completedTaskCount),
  };
}

function normalizeCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function normalizeNullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeRuntimeIndexState(
  snapshot: RuntimeIndexStateSnapshot | null,
): LibraryRuntimeIndexState | null {
  if (!snapshot) {
    return null;
  }
  return {
    generatedAt: snapshot.generatedAt,
    failedDocuments: snapshot.failedDocuments.map((item) => ({
      path: item.path,
      extension: item.extension,
      size: item.size,
      mtime: item.mtime,
      indexStatus: item.indexStatus,
    })),
    skippedDocuments: snapshot.skippedDocuments.map((item) => ({
      path: item.path,
      extension: item.extension,
      size: item.size,
      mtime: item.mtime,
      indexStatus: item.indexStatus,
    })),
    parserSkips: snapshot.parserSkips.map((item) => ({
      skipKey: item.skipKey,
      adapter: item.adapter,
      reasonCode: item.reasonCode,
      extension: item.extension,
      samplePaths: [...item.samplePaths],
      sampleCount: item.sampleCount,
      totalCount: item.totalCount,
      lastMessage: item.lastMessage,
      firstSeenAt: item.firstSeenAt,
      lastSeenAt: item.lastSeenAt,
      lastRunAt: item.lastRunAt,
    })),
  };
}
