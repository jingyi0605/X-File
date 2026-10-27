export interface LibraryTask {
  taskId: string;
  taskType: string;
  rootDir: string;
  targetPath: string | null;
  categoryTitle?: string | null;
  source: string;
  state: "queued" | "running" | "completed" | "failed";
  stage: string | null;
  totalCount: number | null;
  processedCount: number;
  stageProgress?: { processedCount: number; totalCount: number | null } | null;
  errorSummary: string | null;
  queuedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}
export type LibraryTagAssignmentScope =
  | { kind: "full" }
  | { kind: "document"; documentId: string }
  | { kind: "folder"; folderPath: string };
