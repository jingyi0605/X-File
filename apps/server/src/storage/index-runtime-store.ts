import type { LibraryIndexStatus } from "@x-file/shared";

export interface DirtyMark {
  rootDir: string;
  reason: string;
  targetPath: string | null;
  markedAt: string;
}

export class IndexRuntimeStore {
  private readonly dirtyMarks = new Map<string, DirtyMark[]>();
  private readonly statuses = new Map<string, LibraryIndexStatus>();

  getStatus(rootDir: string): LibraryIndexStatus | null {
    const status = this.statuses.get(rootDir);
    return status ? cloneStatus(status) : null;
  }

  setStatus(rootDir: string, status: LibraryIndexStatus): void {
    this.statuses.set(rootDir, cloneStatus(status));
  }

  markDirty(rootDir: string, reason: string, targetPath: string | null = null): DirtyMark {
    const mark: DirtyMark = {
      rootDir,
      reason,
      targetPath,
      markedAt: new Date().toISOString()
    };
    const existing = this.dirtyMarks.get(rootDir) ?? [];
    existing.push(mark);
    this.dirtyMarks.set(rootDir, existing.slice(-100));
    return mark;
  }

  listDirtyReasons(rootDir: string): string[] {
    return [...new Set((this.dirtyMarks.get(rootDir) ?? []).map((mark) => mark.reason))];
  }

  clearDirty(rootDir: string): void {
    this.dirtyMarks.delete(rootDir);
  }
}

function cloneStatus(status: LibraryIndexStatus): LibraryIndexStatus {
  return {
    ...status,
    dirtyReasons: [...status.dirtyReasons],
    workerHealth: status.workerHealth ? { ...status.workerHealth } : status.workerHealth,
    progress: status.progress ? { ...status.progress } : status.progress
  };
}
