import { Fragment, useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { LibraryIndexStatus, LibraryTask } from "@x-file/shared";

import { listLibraryTasks, listenLibraryTaskUpdates } from "../../api/library";
import { toApiErrorMessage } from "../../api/http";
import { getLocaleForIntl, t } from "../../i18n";
import { formatDateTime } from "../../shared/format";

function taskTypeLabel(type: string): string {
  if (type === "library.file_scan") return t("libraryTaskTypeScan");
  if (type === "library.tag_assignment" || type === "library.tag_recompute") return t("libraryTaskTypeTags");
  return t("libraryTaskTypeIndex");
}

function taskStateLabel(state: LibraryTask["state"]): string {
  switch (state) {
    case "queued": return t("libraryTaskQueued");
    case "running": return t("libraryTagTaskRunning");
    case "completed": return t("libraryTagTaskCompleted");
    case "failed": return t("libraryTagTaskFailed");
  }
}

function taskStageLabel(stage: string): string {
  switch (stage) {
    case "count_tag_files": return t("libraryTaskCountingFiles");
    case "apply_tags": return t("libraryTaskApplyingTags");
    case "save_tag_results": return t("libraryTaskWritingSnapshot");
    case "export_details": return t("libraryTaskExportDetails");
    case "export_metadata": return t("libraryTaskExportMetadata");
    case "export_tags": return t("libraryTaskExportTags");
    case "export_relations": return t("libraryTaskExportRelations");
    case "export_search": return t("libraryTaskExportSearch");
    case "publish_tag_results": return t("libraryTaskPublishResults");
    case "waiting_for_lock": return t("libraryTaskWaitingForLock");
    case "save_tags": return t("libraryTaskSavingTags");
    case "write_snapshot": return t("libraryTaskWritingSnapshot");
    case "scan_files": return t("libraryTaskTypeScan");
    case "index_text": return t("libraryTaskTypeIndex");
    case "export_snapshot": return t("libraryTaskExporting");
    default: return stage;
  }
}

function isTagTask(type: string): boolean {
  return type === "library.tag_assignment" || type === "library.tag_recompute";
}

function isSavingTags(task: LibraryTask): boolean {
  return task.state === "running" && isTagTask(task.taskType)
    && (task.stage === "save_tag_results" || task.stage === "publish_tag_results" || task.stage?.startsWith("export_") === true);
}

function taskStatusLabel(task: LibraryTask): string {
  if (task.state === "running" && isTagTask(task.taskType)) {
    if (task.stage === "count_tag_files") return t("libraryTaskCounting");
    if (task.stage === "apply_tags") return t("libraryTaskApplyingTags");
    if (isSavingTags(task)) return t("libraryTaskSavingResults");
  }
  return taskStateLabel(task.state);
}

function taskIcon(type: string, state: LibraryTask["state"]) {
  const path = state === "completed"
    ? "M20 6 9 17l-5-5"
    : type === "library.tag_assignment" || type === "library.tag_recompute"
      ? "M20.6 13.4 13 21l-10-10V3h8l9.6 9.6a.6.6 0 0 1 0 .8ZM7 7h.01"
      : type === "library.file_scan"
        ? "M11 19a8 8 0 1 1 5.7-2.3L21 21m-10-9 2 2 4-4"
        : "M5 3h10l4 4v14H5zM14 3v5h5M8 12h8m-8 4h8";
  return (
    <svg className="library-task-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d={path} />
    </svg>
  );
}

function isIndexTask(type: string): boolean {
  return type === "library.index" || type === "library.index_refresh";
}

type TaskProgressCounts = Pick<LibraryTask, "processedCount" | "totalCount">;

function TaskProgress({ processedCount, totalCount, label, pendingLabel, saving, stageProgress }: TaskProgressCounts & {
  label: string; pendingLabel?: string; saving?: boolean; stageProgress?: LibraryTask["stageProgress"];
}) {
  const knownTotal = totalCount !== null && totalCount >= 0;
  const progress = saving ? stageProgress ?? { processedCount: 0, totalCount: null } : { processedCount, totalCount };
  const percent = progress?.totalCount !== null && progress?.totalCount !== undefined ? (progress.totalCount > 0
    ? progress.processedCount >= progress.totalCount ? 100 : Math.min(99, Math.round(progress.processedCount / progress.totalCount * 100))
    : 0) : null;
  return (
    <span className="library-task-progress-row">
      {percent !== null || saving ? (
        <span className="library-task-progress-track" role="progressbar" aria-label={label} aria-valuenow={percent ?? undefined} aria-valuemin={0} aria-valuemax={100} aria-busy={saving || undefined}>
          <span className={`library-task-progress-fill${percent === null ? " is-indeterminate" : ""}`} style={percent !== null ? { width: `${percent}%` } : undefined} />
        </span>
      ) : null}
      <span className="library-task-count">{knownTotal
        ? `${processedCount.toLocaleString(getLocaleForIntl())} / ${totalCount.toLocaleString(getLocaleForIntl())}`
        : pendingLabel ?? t("libraryTaskProcessed", { count: processedCount })}</span>
    </span>
  );
}

function TaskRow({ task, statusLabel, children }: { task: LibraryTask; statusLabel?: string; children?: ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const finished = task.state === "completed" || task.state === "failed";
  const knownTotal = task.totalCount !== null && task.totalCount > 0;
  const completedAt = task.completedAt ?? task.queuedAt;
  return (
    <section className="library-task-card" aria-label={taskTypeLabel(task.taskType)} data-state={task.state}>
      <button
        type="button"
        className="secondary-button library-task-row-toggle"
        aria-label={taskTypeLabel(task.taskType)}
        aria-expanded={expanded}
        aria-controls={detailsId}
        onClick={() => setExpanded((current) => !current)}
      >
        <span className="library-task-card-heading">
          {taskIcon(task.taskType, task.state)}
          <span className="library-task-title">
            <strong>{taskTypeLabel(task.taskType)}</strong>
            {task.categoryTitle ? <span className="library-task-category" title={task.categoryTitle}>{task.categoryTitle}</span> : null}
          </span>
          {task.state === "completed" && task.completedAt ? (
            <time className="library-task-time" dateTime={completedAt} title={formatDateTime(completedAt)}>
              {new Date(completedAt).toLocaleTimeString(getLocaleForIntl(), { hour: "2-digit", minute: "2-digit", hour12: false })}
            </time>
          ) : <span className={`library-task-badge state-${task.state}`}>{statusLabel ?? taskStatusLabel(task)}</span>}
        </span>
        <TaskProgress
          processedCount={task.processedCount}
          totalCount={task.totalCount}
          label={taskTypeLabel(task.taskType)}
          saving={isSavingTags(task)}
          stageProgress={task.stageProgress}
          pendingLabel={isTagTask(task.taskType) && !finished
            ? t(task.stage === "count_tag_files" ? "libraryTaskCountingFiles" : "libraryTaskPreparingTags")
            : undefined}
        />
        {isSavingTags(task) ? <span className="library-task-stage">
          {taskStageLabel(task.stage!)}
          {task.stageProgress?.totalCount != null
            ? ` · ${task.stageProgress.processedCount.toLocaleString(getLocaleForIntl())} / ${task.stageProgress.totalCount.toLocaleString(getLocaleForIntl())}`
            : ""}
        </span> : null}
      </button>
      {task.errorSummary ? <p className="library-tag-task-popover-error">{task.errorSummary}</p> : null}
      {expanded ? (
        <div id={detailsId} className="library-task-expanded-details" role="region" aria-label={isIndexTask(task.taskType) ? t("libraryIndexStatusDetailsTitle") : taskTypeLabel(task.taskType)}>
          <span className="library-task-target">{task.targetPath ?? task.rootDir}</span>
          <span className="library-task-stage">{taskStateLabel(task.state)}{task.stage ? ` · ${taskStageLabel(task.stage)}` : ""}</span>
          {finished ? <span className="library-task-stage">{knownTotal
            ? t("libraryTaskProcessedTotal", { current: task.processedCount, total: task.totalCount! })
            : t("libraryTaskProcessed", { count: task.processedCount })}</span> : null}
          {children}
        </div>
      ) : null}
    </section>
  );
}

export function LibraryTaskCenter({
  rootDir, fallbackState, fallbackLabel, indexStatus, indexProgress = { processedCount: 0, totalCount: null }, children,
}: {
  rootDir: string | null;
  fallbackState: string;
  fallbackLabel: string;
  indexProgress?: TaskProgressCounts;
  indexStatus?: LibraryIndexStatus | null;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<{ root: string | null; tasks: LibraryTask[]; error: string | null }>({
    root: null, tasks: [], error: null,
  });
  const anchorRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dialogId = useId();
  const registeredTasks = result.root === rootDir ? result.tasks : [];
  const fallback: LibraryTask = {
    taskId: `index-status:${rootDir}`, taskType: "library.index", rootDir: rootDir ?? "",
    targetPath: null, source: "index_status",
    state: fallbackState === "running" ? "running" : fallbackState === "failed" ? "failed" : "completed",
    stage: indexStatus?.runningStage ?? null, ...indexProgress,
    errorSummary: indexStatus?.errorSummary ?? null,
    queuedAt: indexStatus?.lastRequestedAt ?? "",
    startedAt: indexStatus?.lastStartedAt ?? null,
    completedAt: fallbackState === "failed" ? indexStatus?.lastFailedAt ?? null : indexStatus?.lastCompletedAt ?? null,
  };
  const tasks = rootDir && !registeredTasks.some((task) => isIndexTask(task.taskType))
    ? [...registeredTasks, fallback] : registeredTasks;
  const active = tasks.filter((task) => task.state === "queued" || task.state === "running");
  const finished = tasks.filter((task) => task.state !== "queued" && task.state !== "running")
    .sort((left, right) => taskCompletionTime(right) - taskCompletionTime(left))
    .slice(0, 5);
  const latestIndexTask = tasks.find((task) => isIndexTask(task.taskType));
  const activeStatusLabel = active.some((task) => task.source === "index_status") ? ` · ${fallbackLabel}` : "";
  const dot = active.length ? "running" : tasks.some((task) => task.state === "failed") ? "failed" : fallbackState;

  // 串行轮询小型任务快照；请求未结束时不叠加请求，切库和卸载时丢弃旧结果。
  useEffect(() => {
    if (!rootDir) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let revision = 0;
    let unlisten: (() => void) | undefined;
    void listenLibraryTaskUpdates((task) => {
      if (disposed || task.rootDir !== rootDir) return;
      revision += 1;
      setResult((current) => ({
        root: rootDir, error: null,
        tasks: [task, ...(current.root === rootDir ? current.tasks : []).filter((item) => item.taskId !== task.taskId)],
      }));
    }).then((stop) => { if (disposed) stop(); else unlisten = stop; }).catch(() => {});
    const poll = async () => {
      const startedRevision = revision;
      try {
        const next = await listLibraryTasks();
        if (!disposed && revision === startedRevision) setResult({ root: rootDir, tasks: next.filter((task) => task.rootDir === rootDir), error: null });
      } catch (error) {
        if (!disposed && revision === startedRevision) setResult((current) => ({
          root: rootDir,
          tasks: current.root === rootDir ? current.tasks : [],
          error: toApiErrorMessage(error),
        }));
      } finally {
        if (!disposed) timer = setTimeout(() => void poll(), open ? 250 : 1500);
      }
    };
    void poll();
    return () => { disposed = true; clearTimeout(timer); unlisten?.(); };
  }, [rootDir, open]);

  const cancelClose = () => {
    if (closeTimerRef.current !== null) clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimerRef.current = setTimeout(() => {
      if (!anchorRef.current?.contains(document.activeElement)) setOpen(false);
    }, 320);
  };
  useEffect(() => () => {
    if (closeTimerRef.current !== null) clearTimeout(closeTimerRef.current);
  }, []);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!anchorRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);

  return (
    <span
      ref={anchorRef}
      className="library-index-status-anchor"
      onMouseEnter={() => { cancelClose(); setOpen(true); }}
      onMouseLeave={scheduleClose}
      onBlur={scheduleClose}
      onFocus={cancelClose}
      onKeyDown={(event) => {
        if (event.key === "Escape") { setOpen(false); triggerRef.current?.focus(); }
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className="affairs-stage-toolbar-icon library-task-center-trigger"
        data-state={dot}
        title={t("libraryTaskCenterTitle")}
        aria-label={`${t("libraryTaskCenterTitle")}：${active.length ? t("libraryTaskActiveCount", { count: active.length }) : fallbackLabel}${activeStatusLabel}`}
        aria-haspopup="dialog"
        aria-controls={dialogId}
        aria-expanded={open}
        onClick={() => { cancelClose(); setOpen(true); }}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m3 5 1.5 1.5L7 4M10 5h11M3 12l1.5 1.5L7 11m3 1h11M3 19l1.5 1.5L7 18m3 1h11" />
        </svg>
        {active.length ? <span className="library-task-active-count" aria-hidden="true">{active.length}</span> : null}
      </button>
      {open ? (
        <div id={dialogId} role="dialog" aria-label={t("libraryTaskCenterTitle")} className="library-index-status-popover library-task-center-popover">
          <div className="library-index-status-popover-card">
            <div className="library-index-status-popover-header library-task-center-header">
              <strong>{t("libraryTaskCenterTitle")}</strong>
              <button type="button" className="secondary-button" onClick={() => { setOpen(false); triggerRef.current?.focus(); }}>
                {t("actionClose")}
              </button>
            </div>
            <div className="library-task-center-body">
              {result.root === rootDir && result.error ? <p className="library-tag-task-popover-error" role="alert">{result.error}</p> : null}
              <div className="library-task-list">
                {!tasks.length && !rootDir ? <p className="library-tag-task-popover-detail">{t("libraryTaskCenterEmpty")}</p> : null}
                {[...active, ...finished].map((task, index) => (
                  <Fragment key={`${rootDir}:${task.taskId}`}>
                    {finished.length > 0 && active.length > 0 && index === active.length ? <div className="library-task-divider" aria-hidden="true" /> : null}
                    <TaskRow task={task} statusLabel={task.source === "index_status" ? fallbackLabel : undefined}>
                      {task.taskId === latestIndexTask?.taskId ? children : null}
                    </TaskRow>
                  </Fragment>
                ))}
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </span>
  );
}

function taskCompletionTime(task: LibraryTask): number {
  const time = Date.parse(task.completedAt ?? task.queuedAt);
  return Number.isNaN(time) ? 0 : time;
}
