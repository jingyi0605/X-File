import fs from "node:fs";
import path from "node:path";

import type { LibraryIndexProgress, LibraryIndexStatus } from "@x-file/shared";

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
      const parsed = JSON.parse(raw) as Partial<PersistedRuntimeStatus>;
      return normalizePersistedStatus(parsed);
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
  };
}
