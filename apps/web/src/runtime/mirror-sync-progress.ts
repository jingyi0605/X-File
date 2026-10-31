import { useSyncExternalStore } from "react";

export type MirrorSyncPhase = "idle" | "connecting" | "receiving" | "saving" | "complete" | "failed";
export type MirrorSyncTransport = "snapshot" | "legacy" | null;

export interface MirrorSyncProgress {
  phase: MirrorSyncPhase;
  transport: MirrorSyncTransport;
  startedAt: string | null;
  completedAt: string | null;
  receivedDocuments: number;
  totalDocuments: number | null;
  receivedBytes: number;
  totalBytes: number | null;
}

export interface MirrorSyncTask extends MirrorSyncProgress {
  taskId: string;
}

const IDLE_PROGRESS: MirrorSyncProgress = {
  phase: "idle",
  transport: null,
  startedAt: null,
  completedAt: null,
  receivedDocuments: 0,
  totalDocuments: null,
  receivedBytes: 0,
  totalBytes: null,
};

const MAX_TASK_HISTORY = 20;
let progress = IDLE_PROGRESS;
let tasks: MirrorSyncTask[] = [];
let taskSequence = 0;
const listeners = new Set<() => void>();

export function updateMirrorSyncProgress(next: Partial<MirrorSyncProgress>): void {
  const timestamp = new Date().toISOString();
  progress = {
    ...progress,
    ...next,
    ...(next.phase === "connecting" ? { startedAt: timestamp, completedAt: null } : {}),
    ...((next.phase === "complete" || next.phase === "failed") ? { completedAt: timestamp } : {}),
  };
  if (next.phase === "connecting") {
    const task: MirrorSyncTask = {
      taskId: `mirror-sync-${Date.now()}-${taskSequence += 1}`,
      ...progress,
    };
    tasks = [task, ...tasks].slice(0, MAX_TASK_HISTORY);
  } else if (next.phase !== "idle" && tasks.length > 0) {
    tasks = tasks.map((task, index) => index === 0 ? { ...task, ...progress } : task);
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): MirrorSyncProgress {
  return progress;
}

export function useMirrorSyncProgress(): MirrorSyncProgress {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function getTasks(): MirrorSyncTask[] {
  return tasks;
}

export function getMirrorSyncTasks(): MirrorSyncTask[] {
  return tasks;
}

export function useMirrorSyncTasks(): MirrorSyncTask[] {
  return useSyncExternalStore(subscribe, getTasks, getTasks);
}
