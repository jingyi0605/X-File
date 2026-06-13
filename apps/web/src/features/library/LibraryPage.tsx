import {
  Fragment,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import type {
  HostDirectoryOption,
  LibraryDirectorySource,
  LibraryDirectoryState,
  LibraryDocumentTagDetails,
  LibraryDocumentList,
  LibraryDocumentRecord,
  LibraryFavoriteKind,
  LibraryFavoriteRecord,
  LibraryFolderTagDetails,
  LibraryIndexStatus,
  LibraryIndexState,
  LibraryPreview,
  LibraryTagNode,
  LibraryTagDetailWithRules,
  LibraryTagRule,
} from "@x-file/shared";

import {
  browseHostDirectories,
  createLibraryTag,
  deleteLibraryTag,
  getDocumentTagDetails,
  getFolderTagDetails,
  getLibraryPreview,
  getLibraryTagRecomputeTask,
  listLibraryDocuments,
  listLibraryTagDetails,
  requestLibraryTagRecompute,
  saveDocumentTags,
  saveFolderTags,
  updateLibraryTag,
} from "../../api/library";
import { toApiErrorMessage } from "../../api/http";
import { t } from "../../i18n";
import { formatBytes, formatDateTime, getPathName } from "../../shared/format";
import {
  DesktopModal,
  ModalActions,
  ModalEmptyState,
  ModalField,
  ModalSection,
  ModalTag,
} from "../../shared/modal";
import { resolveDocumentVisual } from "./document-visual";
import {
  StaticHtmlPresentationView,
  inspectStaticHtmlPresentation,
  type DocumentProject,
  writeStaticHtmlDocumentProject,
} from "../static-html-editor";
import {
  CodePreview,
  MarkdownPreview,
  detectLanguage,
} from "./LibraryFileCodeViewer";
import { useLibraryState, type LibraryState } from "./useLibraryState";
import {
  DEFAULT_FINDER_COLUMN_WIDTHS,
  FINDER_COLUMN_MIN_WIDTHS,
  type FinderColumnKey,
  type LibraryEntry,
  type LibrarySortDirection,
  type LibrarySortMode,
  type LibrarySortState,
} from "./library-view-state";

export interface WorkbenchPlatformData {
  runtimePlatform: "desktop" | "web";
  osFamily: "macos" | "windows" | "web";
  overlayTitlebar: boolean;
}

interface LibraryPageProps {
  onOpenSettings: () => void;
  platformData: WorkbenchPlatformData;
}

type LibraryDocumentEntry = Extract<LibraryEntry, { kind: "document" }>;
type LibraryFolderEntry = Extract<LibraryEntry, { kind: "folder" }>;
type LibraryDirectoryEntry = Extract<LibraryEntry, { kind: "folder" | "tag-directory" }>;

type LibraryContextMenuTarget =
  | { kind: "blank"; folderPath: string | null }
  | { kind: "folder"; entry: LibraryFolderEntry }
  | { kind: "document"; entry: LibraryDocumentEntry };

interface LibraryContextMenuState {
  left: number;
  top: number;
  target: LibraryContextMenuTarget;
}

type LibrarySubmenuKey = "copy" | "new";

type LibraryContextActionId =
  | "preview"
  | "open"
  | "locate"
  | "open-local-app"
  | "download"
  | "new-directory"
  | "new-markdown"
  | "new-text"
  | "new-file"
  | "copy-file"
  | "copy-file-name"
  | "copy-absolute-path"
  | "copy-relative-path"
  | "cut"
  | "paste"
  | "delete"
  | "tags"
  | "refresh"
  | "properties";

interface NativeLibraryContextMenuItem {
  id: LibraryContextActionId | "copy-group" | "new-group";
  label: string;
  disabled?: boolean;
  items?: NativeLibraryContextMenuItem[];
}

interface NativeLibraryContextMenuResult {
  supported: boolean;
  selectedActionId?: LibraryContextActionId | null;
  fallbackReason?: string | null;
}

interface NativeLibraryContextMenuActionEvent {
  payload: LibraryContextActionId;
}

interface LibraryClipboardState {
  mode: "cut" | "copy";
  target: Extract<LibraryContextMenuTarget, { kind: "document" | "folder" }>;
}

type PendingCreateKind = "directory" | "markdown" | "text" | "custom";
type ViewerMode = "preview" | "presentation" | "edit";

interface PendingCreateState {
  kind: PendingCreateKind;
  folderPath: string | null;
  fileName: string;
}

interface PendingRenameState {
  path: string;
  fileName: string;
}

type PendingTagAssignmentTarget =
  | { kind: "document"; documentId: string; path: string; title: string }
  | { kind: "folder"; folderPath: string; title: string };

interface LibraryTagAssignmentTaskState {
  readonly id: string;
  readonly kind: "document" | "folder";
  readonly targetPath: string;
  readonly status: "running" | "completed" | "failed";
  readonly message: string | null;
}

interface LibraryViewerState {
  filePath: string;
  title: string;
}

interface FinderResizeState {
  column: FinderColumnKey;
  startX: number;
  startWidth: number;
}

interface LibraryTagTreeNodeRecord {
  path: string;
  label: string;
  count: number;
  children: LibraryTagTreeNodeRecord[];
}

interface LibraryTagTreeState {
  expandedPaths: string[];
  expandedMorePaths: string[];
}

interface PendingTagFilterFavoriteState {
  tagPaths: string[];
  name: string;
  error: string | null;
}

const LIBRARY_TAG_TREE_DEFAULT_ROOTS = new Set(["时间", "类型", "time", "type"]);
const LIBRARY_TAG_TREE_NOISE_ROOTS = new Set([
  "来源",
  "主题",
  "状态",
  "source",
  "topic",
  "status",
]);
const LIBRARY_TAG_TREE_VISIBLE_LIMIT = 5;
const LIBRARY_TAG_TREE_STATE_KEY = "x-file.library.tag-tree";
const SIMPLE_PINYIN_MAP: Record<string, string> = {
  合: "he",
  同: "tong",
  售: "shou",
  前: "qian",
  文: "wen",
  档: "dang",
  项: "xiang",
  目: "mu",
  系: "xi",
  统: "tong",
  集: "ji",
  成: "cheng",
  类: "lei",
  型: "xing",
  时: "shi",
  间: "jian",
  最: "zui",
  近: "jin",
  天: "tian",
  高: "gao",
  频: "pin",
  低: "di",
  子: "zi",
  标: "biao",
  签: "qian",
};

export function LibraryPage({
  onOpenSettings,
  platformData,
}: LibraryPageProps) {
  const library = useLibraryState();
  const binding = library.snapshot?.binding ?? null;
  const shouldShowInitialization = library.requiresInitialization || !binding;
  const shouldShowDisabled = Boolean(binding && !binding.enabled);
  const [contextMenu, setContextMenu] =
    useState<LibraryContextMenuState | null>(null);
  const [libraryClipboard, setLibraryClipboard] =
    useState<LibraryClipboardState | null>(null);
  const [pendingCreate, setPendingCreate] = useState<PendingCreateState | null>(
    null,
  );
  const [pendingRename, setPendingRename] = useState<PendingRenameState | null>(
    null,
  );
  const [pendingDelete, setPendingDelete] =
    useState<LibraryContextMenuTarget | null>(null);
  const [pendingTagAssignment, setPendingTagAssignment] =
    useState<PendingTagAssignmentTarget | null>(null);
  const [tagAssignmentTask, setTagAssignmentTask] =
    useState<LibraryTagAssignmentTaskState | null>(null);
  const [tagAssignmentTaskExpanded, setTagAssignmentTaskExpanded] =
    useState(false);
  const [viewerState, setViewerState] = useState<LibraryViewerState | null>(null);
  const [tagManagerOpen, setTagManagerOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchDraft, setSearchDraft] = useState("");

  function openLibraryViewer(entry: LibraryDocumentEntry): void {
    setViewerState({
      filePath: entry.path,
      title: resolveLibraryDocumentDisplayName(entry),
    });
  }

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [contextMenu]);

  async function pasteIntoTarget(
    target: LibraryContextMenuTarget,
  ): Promise<void> {
    if (!libraryClipboard) return;
    const folderPath = resolvePasteDestinationFolder(target);
    const sourcePath = resolveContextPath(libraryClipboard.target);
    const destinationPath = buildUniqueLibraryTargetPath(
      folderPath,
      getPathName(sourcePath),
      library.entries,
    );
    await library.operateFile({
      opType: libraryClipboard.mode === "cut" ? "move" : "copy",
      srcPath: sourcePath,
      dstPath: destinationPath,
    });
    if (libraryClipboard.mode === "cut") {
      setLibraryClipboard(null);
    }
  }

  async function runContextAction(
    actionId: LibraryContextActionId,
    target: LibraryContextMenuTarget,
  ): Promise<void> {
    const absolutePath =
      target.kind === "document" || target.kind === "folder"
        ? resolveTargetAbsolutePath(library, target)
        : null;
    switch (actionId) {
      case "preview":
        if (target.kind === "document") {
          library.selectDocument(target.entry.documentId);
          openLibraryViewer(target.entry);
        }
        return;
      case "open":
        if (target.kind === "document" || target.kind === "folder") {
          await openContextTarget(library, target);
        }
        return;
      case "locate":
        if (target.kind === "document") {
          await locateDocumentFolder(library, target.entry.path);
        } else if (target.kind === "folder") {
          library.selectFolder(target.entry.path);
        }
        return;
      case "open-local-app":
        if (absolutePath) {
          await openPathInDesktop(absolutePath);
        }
        return;
      case "download":
        if (target.kind === "document") {
          await library.downloadSelected(target.entry.path);
        }
        return;
      case "new-directory":
      case "new-markdown":
      case "new-text":
      case "new-file": {
        const kind =
          actionId === "new-directory"
            ? "directory"
            : actionId === "new-markdown"
              ? "markdown"
              : actionId === "new-text"
                ? "text"
                : "custom";
        setPendingCreate({
          kind,
          folderPath: resolvePasteDestinationFolder(target),
          fileName: resolveDefaultCreateName(kind),
        });
        return;
      }
      case "copy-file":
      case "copy-relative-path":
        if (target.kind !== "blank") {
          await copyContextText(resolveContextPath(target));
        }
        return;
      case "copy-file-name":
        if (target.kind !== "blank") {
          await copyContextText(getContextTargetTitle(target));
        }
        return;
      case "copy-absolute-path":
        if (absolutePath) {
          await copyContextText(absolutePath);
        }
        return;
      case "cut":
        if (target.kind === "document" || target.kind === "folder") {
          setLibraryClipboard({ mode: "cut", target });
        }
        return;
      case "paste":
        await pasteIntoTarget(target);
        return;
      case "delete":
        if (target.kind === "document" || target.kind === "folder") {
          setPendingDelete(target);
        }
        return;
      case "tags": {
        const tagTarget = resolvePendingTagAssignmentTarget(target);
        if (tagTarget) {
          setPendingTagAssignment(tagTarget);
        }
        return;
      }
      case "refresh":
        await library.reloadDocuments(true);
        return;
      case "properties":
        selectContextProperties(library, target);
        return;
      default:
        return;
    }
  }

  async function openDesktopLibraryContextMenu(
    event: ReactMouseEvent<HTMLElement>,
    target: LibraryContextMenuTarget,
  ): Promise<boolean> {
    if (
      platformData.runtimePlatform !== "desktop" ||
      platformData.osFamily !== "macos"
    ) {
      return false;
    }

    const items = buildNativeLibraryContextMenuItems(
      library,
      target,
      libraryClipboard,
    );
    if (items.length === 0) {
      return false;
    }

    try {
      const tauriApi = await import("@tauri-apps/api/core");
      const tauriEvent = await import("@tauri-apps/api/event");
      let handledByEvent = false;
      const unlisten = await tauriEvent.listen<LibraryContextActionId>(
        "x-file-library-context-menu-action",
        (actionEvent: NativeLibraryContextMenuActionEvent) => {
          handledByEvent = true;
          void runContextAction(actionEvent.payload, target).finally(() => {
            void unlisten();
          });
        },
      );
      const result = await tauriApi.invoke<NativeLibraryContextMenuResult>(
        "show_library_context_menu",
        {
          request: {
            items,
            x: event.clientX,
            y: event.clientY,
          },
        },
      );
      if (!result.supported) {
        void unlisten();
        return false;
      }
      if (result.selectedActionId && !handledByEvent) {
        await runContextAction(result.selectedActionId, target);
        void unlisten();
      }
      return true;
    } catch {
      return false;
    }
  }

  async function handleOpenLibraryContextMenu(
    event: ReactMouseEvent<HTMLElement>,
    target: LibraryContextMenuTarget,
  ): Promise<void> {
    event.preventDefault();
    event.stopPropagation();
    if (target.kind === "document") {
      library.selectDocument(target.entry.documentId);
    }
    if (target.kind === "folder") {
      library.selectFolderEntry(target.entry.path);
    }

    if (await openDesktopLibraryContextMenu(event, target)) {
      return;
    }

    setContextMenu({ left: event.clientX, top: event.clientY, target });
  }

  if (shouldShowInitialization) {
    return (
      <LibraryBindingPanel
        library={library}
        onOpenSettings={onOpenSettings}
        platformData={platformData}
      />
    );
  }

  if (shouldShowDisabled) {
    return (
      <LibraryDisabledPanel
        library={library}
        onOpenSettings={onOpenSettings}
        platformData={platformData}
      />
    );
  }

  return (
    <main
      className="app-shell workbench-shell xfile-workbench-shell"
      data-runtime-platform={platformData.runtimePlatform}
      data-os-family={platformData.osFamily}
      data-overlay-titlebar={platformData.overlayTitlebar ? "true" : undefined}
    >
      <section className="workbench-window xfile-workbench-window">
        <LibraryDesktopSidebar
          library={library}
          onOpenSettings={onOpenSettings}
          onOpenTagManager={() => setTagManagerOpen(true)}
        />
        <section className="affairs-main-panel">
          {tagAssignmentTask ? (
            <LibraryTagTaskEntry
              task={tagAssignmentTask}
              expanded={tagAssignmentTaskExpanded}
              onToggle={() =>
                setTagAssignmentTaskExpanded((current) => !current)
              }
            />
          ) : null}
          {library.error ? (
            <div className="affairs-library-error-strip">
              <strong>{t("libraryErrorTitle")}</strong>
              <span>{library.error}</span>
            </div>
          ) : null}
          <LibraryStage
            library={library}
            onOpenSettings={onOpenSettings}
            onOpenContextMenu={(event, target) =>
              void handleOpenLibraryContextMenu(event, target)
            }
            onRequestCreate={(state) => setPendingCreate(state)}
            onRequestRename={(path) =>
              setPendingRename({ path, fileName: getPathName(path) })
            }
            onRequestDelete={(target) => setPendingDelete(target)}
            onRequestTagAssignment={(target) =>
              setPendingTagAssignment(resolvePendingTagAssignmentTarget(target))
            }
            onOpenSearch={() => setSearchOpen(true)}
            onOpenLibraryViewer={openLibraryViewer}
          />
        </section>
        <LibraryDetail
          library={library}
          onRequestRename={(path) =>
            setPendingRename({ path, fileName: getPathName(path) })
          }
          onRequestDelete={(target) => setPendingDelete(target)}
          onRequestTagAssignment={(target) =>
            setPendingTagAssignment(resolvePendingTagAssignmentTarget(target))
          }
        />
      </section>
      {contextMenu ? (
        <LibraryContextMenu
          state={contextMenu}
          library={library}
          libraryClipboard={libraryClipboard}
          onOpenLibraryViewer={openLibraryViewer}
          onSetClipboard={setLibraryClipboard}
          onClose={() => setContextMenu(null)}
          onRequestCreate={(state) => setPendingCreate(state)}
          onRequestRename={(path) =>
            setPendingRename({ path, fileName: getPathName(path) })
          }
          onRequestDelete={(target) => setPendingDelete(target)}
          onRequestTagAssignment={(target) =>
            setPendingTagAssignment(resolvePendingTagAssignmentTarget(target))
          }
        />
      ) : null}
      {searchOpen ? (
        <LibrarySearchModal
          library={library}
          keyword={searchDraft}
          onKeywordChange={setSearchDraft}
          onOpenDocument={(entry) => {
            library.selectDocument(entry.documentId);
            openLibraryViewer(entry);
            setSearchOpen(false);
          }}
          onLocateDocument={(entry) => {
            library.selectFolder(resolveDocumentFolderPath(entry.path));
            library.selectDocument(entry.documentId);
            setSearchOpen(false);
          }}
          onClose={() => setSearchOpen(false)}
        />
      ) : null}
      {pendingCreate ? (
        <LibraryCreateModal
          library={library}
          state={pendingCreate}
          onChange={setPendingCreate}
          onClose={() => setPendingCreate(null)}
        />
      ) : null}
      {pendingRename ? (
        <LibraryRenameModal
          library={library}
          state={pendingRename}
          onChange={setPendingRename}
          onClose={() => setPendingRename(null)}
        />
      ) : null}
      {pendingDelete ? (
        <LibraryDeleteModal
          library={library}
          target={pendingDelete}
          onClose={() => setPendingDelete(null)}
        />
      ) : null}
      {pendingTagAssignment ? (
        <LibraryTagAssignmentModal
          library={library}
          target={pendingTagAssignment}
          onClose={() => setPendingTagAssignment(null)}
          onTaskChange={(task) => {
            setTagAssignmentTask(task);
            setTagAssignmentTaskExpanded(false);
          }}
        />
      ) : null}
      {viewerState ? (
        <LibraryFileViewerModal
          library={library}
          viewerState={viewerState}
          onClose={() => setViewerState(null)}
        />
      ) : null}
      {tagManagerOpen ? (
        <LibraryTagManagerModal
          library={library}
          onClose={() => setTagManagerOpen(false)}
        />
      ) : null}
    </main>
  );
}


function LibraryDisabledPanel({
  library,
  onOpenSettings,
  platformData,
}: {
  library: LibraryState;
  onOpenSettings: () => void;
  platformData: WorkbenchPlatformData;
}) {
  return (
    <main
      className="app-shell workbench-shell xfile-workbench-shell"
      data-runtime-platform={platformData.runtimePlatform}
      data-os-family={platformData.osFamily}
      data-overlay-titlebar={platformData.overlayTitlebar ? "true" : undefined}
    >
      <section className="workbench-window xfile-workbench-window">
        <aside className="workbench-sidebar affairs-layout-sidebar">
          <div className="affairs-sidebar-panel">
            <div className="xfile-sidebar-brand" aria-label={t("appTitle")}>
              <span className="xfile-sidebar-brand-icon" aria-hidden="true">
                {renderXFileBrandIcon()}
              </span>
              <span className="xfile-sidebar-brand-copy">
                <strong>{t("appTitle")}</strong>
                <span>{t("appTagline")}</span>
              </span>
            </div>
            <footer className="workbench-sidebar-footer">
              <button
                type="button"
                className="workbench-sidebar-footer-button"
                onClick={onOpenSettings}
                aria-label={t("navSettings")}
                title={t("navSettings")}
              >
                {renderSettingsIcon()}
                <span>{t("navSettings")}</span>
              </button>
            </footer>
          </div>
        </aside>
        <section className="affairs-main-panel">
          <section className="affairs-stage-panel">
            <div className="affairs-stage-content" aria-label={t("libraryDocumentList")}>
              <div className="affairs-stage-empty">
                <strong>{t("librarySummaryDisabled")}</strong>
                <span>{library.snapshot?.binding?.rootDir ?? ""}</span>
                <button type="button" className="primary-button" onClick={onOpenSettings}>
                  {t("navSettings")}
                </button>
              </div>
            </div>
          </section>
        </section>
        <LibraryDetail
          library={library}
          onRequestRename={() => undefined}
          onRequestDelete={() => undefined}
          onRequestTagAssignment={() => undefined}
        />
      </section>
    </main>
  );
}

function LibraryTagTaskEntry({
  task,
  expanded,
  onToggle,
}: {
  task: LibraryTagAssignmentTaskState;
  expanded: boolean;
  onToggle: () => void;
}) {
  const statusText = resolveLibraryTagTaskStatusText(task.status);
  return (
    <div className="library-tag-task-entry">
      <button
        type="button"
        className="library-tag-task-trigger"
        aria-label={t("libraryTagTaskEntryLabel", { status: statusText })}
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <span>{t("libraryTagTaskEntryTitle")}</span>
        <strong>{statusText}</strong>
      </button>
      {expanded ? (
        <div
          className="library-tag-task-panel"
          role="status"
          aria-label={t("libraryTagTaskRecentLabel")}
        >
          <span>{task.targetPath}</span>
          <strong>{statusText}</strong>
          {task.message ? <small>{task.message}</small> : null}
        </div>
      ) : null}
    </div>
  );
}

function resolveLibraryTagTaskStatusText(
  status: LibraryTagAssignmentTaskState["status"],
): string {
  if (status === "completed") return t("libraryTagTaskCompleted");
  if (status === "failed") return t("libraryTagTaskFailed");
  return t("libraryTagTaskRunning");
}

function LibraryDesktopSidebar({
  library,
  onOpenSettings,
  onOpenTagManager,
}: {
  library: LibraryState;
  onOpenSettings: () => void;
  onOpenTagManager: () => void;
}) {
  const snapshot = library.snapshot;
  const selectedTagPath = library.viewState.selectedTagPath;
  // library.tags 已由 useLibraryState.mergeTagSources 合并了快照标签（含内置标签）与 API 标签（含自定义标签），
  // 直接使用即可，不再做有条件的切换，避免自定义标签存在时内置标签丢失。
  const tags = library.tags;
  const [tagSearchOpen, setTagSearchOpen] = useState(false);
  const [tagSearchQuery, setTagSearchQuery] = useState("");
  const [tagTreeState, setTagTreeState] = useState<LibraryTagTreeState>(() => readLibraryTagTreeState());
  const tagSearchInputRef = useRef<HTMLInputElement | null>(null);
  const selectedTagPaths = library.viewState.selectedTagPaths;
  const hasTagSelection = selectedTagPaths.length > 0;
  const tagFacetCounts = library.documentPage?.tagFacetCounts ?? {};
  const tagTree = useMemo(() => buildLibraryTagTree(tags), [tags]);
  const tagTreeWithCounts = useMemo(
    () => applyTagFacetCountsToTree(tagTree, tagFacetCounts, hasTagSelection),
    [hasTagSelection, tagFacetCounts, tagTree],
  );
  const tagTreeVisibility = useMemo(
    () => buildTagTreeVisibility(tagTreeWithCounts, selectedTagPaths, tagFacetCounts),
    [tagFacetCounts, selectedTagPaths, tagTreeWithCounts],
  );
  const visibleTagTree = useMemo(
    () => filterTagTreeByVisibility(tagTreeWithCounts, tagTreeVisibility.visiblePathSet),
    [tagTreeVisibility.visiblePathSet, tagTreeWithCounts],
  );
  const filteredTagTree = useMemo(
    () => filterLibraryTagTree(visibleTagTree, tagSearchQuery),
    [tagSearchQuery, visibleTagTree],
  );
  const [pendingTagFilterFavorite, setPendingTagFilterFavorite] = useState<PendingTagFilterFavoriteState | null>(null);
  const [tagFilterFavoriteSubmitting, setTagFilterFavoriteSubmitting] = useState(false);

  useEffect(() => {
    writeLibraryTagTreeState(tagTreeState);
  }, [tagTreeState]);

  useEffect(() => {
    if (selectedTagPaths.length === 0) {
      return;
    }
    setTagTreeState((current) => {
      const nextExpandedPaths = Array.from(
        new Set([
          ...current.expandedPaths,
          ...selectedTagPaths.flatMap(buildTagAncestorPaths),
        ]),
      );
      return areStringArraysEqual(current.expandedPaths, nextExpandedPaths)
        ? current
        : { ...current, expandedPaths: nextExpandedPaths };
    });
  }, [selectedTagPaths]);

  useEffect(() => {
    if (!tagSearchOpen) {
      return;
    }
    tagSearchInputRef.current?.focus();
    tagSearchInputRef.current?.select();
  }, [tagSearchOpen]);

  function toggleExpandedTagPath(path: string): void {
    setTagTreeState((current) => ({
      expandedPaths: current.expandedPaths.includes(path)
        ? current.expandedPaths.filter((item) => item !== path)
        : [...current.expandedPaths, path],
      expandedMorePaths: current.expandedMorePaths,
    }));
  }

  function toggleExpandedMoreTagPath(path: string): void {
    setTagTreeState((current) => ({
      expandedPaths: current.expandedPaths,
      expandedMorePaths: current.expandedMorePaths.includes(path)
        ? current.expandedMorePaths.filter((item) => item !== path)
        : [...current.expandedMorePaths, path],
    }));
  }

  function openTagFilterFavoriteModal(): void {
    if (selectedTagPaths.length === 0) return;
    const defaultName = selectedTagPaths.length === 1
      ? tags.find((item) => item.path === selectedTagPaths[0])?.name ?? selectedTagPaths[0]
      : "";
    setPendingTagFilterFavorite({
      tagPaths: selectedTagPaths,
      name: defaultName,
      error: null,
    });
  }

  async function submitTagFilterFavorite(): Promise<void> {
    if (!pendingTagFilterFavorite) return;
    const name = pendingTagFilterFavorite.name.trim();
    if (!name) {
      setPendingTagFilterFavorite((current) => current ? { ...current, error: t("libraryTagFilterFavoriteNameRequired") } : current);
      return;
    }
    const tagPaths = normalizeFavoriteTagPaths(pendingTagFilterFavorite.tagPaths);
    if (tagPaths.length === 0) {
      setPendingTagFilterFavorite(null);
      return;
    }
    const favorite: LibraryFavoriteRecord = {
      kind: tagPaths.length === 1 ? "tag" : "tag_filter",
      path: buildTagFilterFavoritePath(tagPaths),
      label: name,
      ...(tagPaths.length > 1 ? { tagPaths } : {}),
    };
    setTagFilterFavoriteSubmitting(true);
    try {
      await library.toggleFavorite(favorite);
      setPendingTagFilterFavorite(null);
    } finally {
      setTagFilterFavoriteSubmitting(false);
    }
  }

  return (
    <aside className="workbench-sidebar affairs-layout-sidebar">
      <div className="affairs-sidebar-panel">
        <div className="xfile-sidebar-brand" aria-label={t("appTitle")}>
          <span className="xfile-sidebar-brand-icon" aria-hidden="true">
            {renderXFileBrandIcon()}
          </span>
          <span className="xfile-sidebar-brand-copy">
            <strong>{t("appTitle")}</strong>
            <span>{t("appTagline")}</span>
          </span>
        </div>
        <div className="affairs-sidebar-shell">
          <div className="affairs-sidebar-content">
            <div className="affairs-sidebar-groups affairs-library-sidebar-groups">
              {(snapshot?.favorites.length ?? 0) > 0 ? (
                <div className="affairs-sidebar-group affairs-sidebar-group-plain affairs-favorites-panel">
                  <div className="affairs-sidebar-group-header">
                    <span>{t("libraryFavorites")}</span>
                    <span className="affairs-sidebar-block-count">
                      {snapshot?.favorites.length ?? 0}
                    </span>
                  </div>
                  <div className="affairs-sidebar-list affairs-sidebar-list-plain">
                    {snapshot?.favorites.map((favorite) => (
                      <SidebarPlainItem
                        key={`${favorite.kind}:${favorite.path}`}
                        active={library.viewState.selectedFavoriteId === favorite.path}
                        title={favorite.label || favorite.path || t("libraryRootFolder")}
                        icon={favorite.kind === "folder" ? "folder" : "tag"}
                        onClick={() => library.selectFavorite(favorite)}
                        onRemoveFavorite={() => void library.toggleFavorite(favorite)}
                      />
                    ))}
                  </div>
                </div>
              ) : null}

              <section className="affairs-sidebar-group affairs-sidebar-group-plain affairs-tag-tree-panel">
                <header className="affairs-sidebar-group-header">
                  <span className="affairs-tag-tree-title">
                    <span>{t("libraryTagTreeSectionTitle")}</span>
                    <button
                      type="button"
                      className={tagSearchOpen ? "affairs-tag-tree-icon-button active" : "affairs-tag-tree-icon-button"}
                      aria-label={t("libraryTagSearchAction")}
                      title={t("libraryTagSearchAction")}
                      onClick={() => setTagSearchOpen((current) => !current)}
                    >
                      {renderSearchIcon()}
                    </button>
                  </span>
                  <div className="affairs-sidebar-group-header-actions">
                    {selectedTagPaths.length > 0 ? (
                      <button
                        type="button"
                        className="affairs-tag-tree-icon-button affairs-tag-tree-reset"
                        aria-label={t("libraryTagTreeReset")}
                        title={t("libraryTagTreeReset")}
                        onClick={() => library.selectTag(null)}
                      >
                        {renderResetFilterIcon()}
                      </button>
                    ) : null}
                    {selectedTagPaths.length > 0 ? (
                      <button
                        type="button"
                        className="affairs-tag-tree-icon-button"
                        aria-label={t("libraryTagFilterFavoriteAction")}
                        title={t("libraryTagFilterFavoriteAction")}
                        onClick={openTagFilterFavoriteModal}
                      >
                        {renderFavoriteIcon()}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="affairs-tag-tree-icon-button"
                      aria-label={t("libraryTagManagerAction")}
                      title={t("libraryTagManagerAction")}
                      onClick={onOpenTagManager}
                    >
                      {renderTagManagerIcon()}
                    </button>
                  </div>
                </header>
                {tagSearchOpen ? (
                  <div className="affairs-tag-tree-search">
                    <div className="affairs-tag-tree-search-field">
                      {renderSearchIcon()}
                      <input
                        ref={tagSearchInputRef}
                        value={tagSearchQuery}
                        aria-label={t("libraryTagSearchInputLabel")}
                        placeholder={t("libraryTagSearchPlaceholder")}
                        onChange={(event) => setTagSearchQuery(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Escape") {
                            setTagSearchOpen(false);
                            setTagSearchQuery("");
                          }
                        }}
                      />
                    </div>
                  </div>
                ) : null}
                {filteredTagTree.length === 0 ? (
                  <div className="affairs-sidebar-empty affairs-sidebar-empty-plain compact">
                    {t("libraryTagTreeEmpty")}
                  </div>
                ) : (
                  <div className="affairs-tag-tree-list" role="tree" aria-label={t("libraryTagTreeSectionTitle")}>
                    {filteredTagTree.map((node) => (
                      <LibraryTagTreeNode
                        key={node.path}
                        node={node}
                        selectedTagPaths={selectedTagPaths}
                        expandedPaths={tagTreeState.expandedPaths}
                        expandedMorePaths={tagTreeState.expandedMorePaths}
                        forceExpanded={tagSearchQuery.trim().length > 0}
                        onSelect={library.selectTag}
                        onToggleExpand={toggleExpandedTagPath}
                        onToggleMore={toggleExpandedMoreTagPath}
                      />
                    ))}
                  </div>
                )}
              </section>
            </div>
          </div>
          <footer className="workbench-sidebar-footer">
            <button
              type="button"
              className="workbench-sidebar-footer-button"
              onClick={onOpenSettings}
              aria-label={t("navSettings")}
              title={t("navSettings")}
            >
              {renderSettingsIcon()}
              <span>{t("navSettings")}</span>
            </button>
          </footer>
        </div>
      </div>
      {pendingTagFilterFavorite ? (
        <LibraryTagFilterFavoriteModal
          pending={pendingTagFilterFavorite}
          submitting={tagFilterFavoriteSubmitting}
          onChangeName={(name) => setPendingTagFilterFavorite((current) => current ? { ...current, name, error: null } : current)}
          onCancel={() => setPendingTagFilterFavorite(null)}
          onSubmit={() => void submitTagFilterFavorite()}
        />
      ) : null}
    </aside>
  );
}

function LibraryTagFilterFavoriteModal({
  pending,
  submitting,
  onChangeName,
  onCancel,
  onSubmit,
}: {
  pending: PendingTagFilterFavoriteState;
  submitting: boolean;
  onChangeName: (name: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  return (
    <DesktopModal
      title={t("libraryTagFilterFavoriteModalTitle")}
      description={t("libraryTagFilterFavoriteModalDescription", { count: pending.tagPaths.length })}
      onClose={onCancel}
      dismissible={!submitting}
      footer={
        <ModalActions>
          <button type="button" className="secondary-button" disabled={submitting} onClick={onCancel}>
            {t("actionCancel")}
          </button>
          <button type="button" className="primary-button" disabled={submitting} onClick={onSubmit}>
            {submitting ? t("settingsSaving") : t("libraryTagFilterFavoriteSubmit")}
          </button>
        </ModalActions>
      }
    >
      <ModalSection className="affairs-tag-filter-favorite-summary">
        <div className="affairs-tag-filter-favorite-tags">
          {pending.tagPaths.map((tagPath) => (
            <ModalTag key={tagPath}>{tagPath}</ModalTag>
          ))}
        </div>
      </ModalSection>
      <ModalField
        label={t("libraryTagFilterFavoriteNameLabel")}
        description={pending.tagPaths.length === 1
          ? t("libraryTagFilterFavoriteSingleNameHint")
          : t("libraryTagFilterFavoriteMultiNameHint")}
      >
        <input
          value={pending.name}
          placeholder={t("libraryTagFilterFavoriteNamePlaceholder")}
          autoFocus
          onChange={(event) => onChangeName(event.target.value)}
        />
        {pending.error ? <small className="modal-field-error">{pending.error}</small> : null}
      </ModalField>
    </DesktopModal>
  );
}

function LibraryTagTreeNode({
  node,
  selectedTagPaths,
  expandedPaths,
  expandedMorePaths,
  forceExpanded,
  onSelect,
  onToggleExpand,
  onToggleMore,
  depth = 0,
}: {
  node: LibraryTagTreeNodeRecord;
  selectedTagPaths: string[];
  expandedPaths: string[];
  expandedMorePaths: string[];
  forceExpanded: boolean;
  onSelect: (path: string | null) => void;
  onToggleExpand: (path: string) => void;
  onToggleMore: (path: string) => void;
  depth?: number;
}) {
  const hasChildren = node.children.length > 0;
  const expanded = forceExpanded || (hasChildren && expandedPaths.includes(node.path));
  const active = selectedTagPaths.includes(node.path);
  const showAllChildren = forceExpanded || expandedMorePaths.includes(node.path);
  const visibleChildren = showAllChildren
    ? node.children
    : node.children.slice(0, LIBRARY_TAG_TREE_VISIBLE_LIMIT);
  const hiddenChildCount = Math.max(0, node.children.length - visibleChildren.length);
  return (
    <div
      className="affairs-tag-tree-node"
      role="treeitem"
      aria-label={node.label}
      aria-expanded={hasChildren ? expanded : undefined}
      data-depth={depth}
    >
      <div className={active ? "affairs-sidebar-item active" : "affairs-sidebar-item"} data-tone="tag">
        <div className="affairs-tag-tree-row">
          {hasChildren ? (
            <button
              type="button"
              className="affairs-tag-tree-toggle"
              aria-label={expanded ? t("libraryTagTreeCollapse") : t("libraryTagTreeExpand")}
              onClick={() => onToggleExpand(node.path)}
            >
              {renderTagTreeChevronIcon(expanded)}
            </button>
          ) : (
            <span className="affairs-tag-tree-toggle placeholder" aria-hidden="true" />
          )}
          <button
            type="button"
            className="affairs-sidebar-item-button affairs-sidebar-item-button-content"
            onClick={() => onSelect(node.path)}
          >
            <div className="affairs-sidebar-item-row">
              <span className="affairs-sidebar-item-title" title={node.label}>{node.label}</span>
              <div className="affairs-sidebar-item-actions">
                <span className="affairs-sidebar-item-badge">{node.count}</span>
              </div>
            </div>
          </button>
        </div>
      </div>
      {expanded ? (
        <div className="affairs-tag-tree-children" role="group">
          {visibleChildren.map((child) => (
            <LibraryTagTreeNode
              key={child.path}
              node={child}
              selectedTagPaths={selectedTagPaths}
              expandedPaths={expandedPaths}
              expandedMorePaths={expandedMorePaths}
              forceExpanded={forceExpanded}
              onSelect={onSelect}
              onToggleExpand={onToggleExpand}
              onToggleMore={onToggleMore}
              depth={depth + 1}
            />
          ))}
          {hiddenChildCount > 0 ? (
            <button
              type="button"
              className="affairs-tag-tree-more"
              onClick={() => onToggleMore(node.path)}
            >
              {t("libraryTagTreeShowMore", { count: hiddenChildCount })}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function SidebarPlainItem({
  active,
  title,
  count,
  icon,
  onClick,
  onRemoveFavorite,
}: {
  active: boolean;
  title: string;
  count?: string | number;
  icon: "folder" | "tag";
  onClick: () => void;
  /** 存在时渲染右侧取消收藏星标按钮 */
  onRemoveFavorite?: () => void;
}) {
  const itemClassName = active ? "affairs-sidebar-item active" : "affairs-sidebar-item";

  // 收藏项：左侧导航按钮 + 右侧取消收藏星标
  if (onRemoveFavorite) {
    return (
      <div className={itemClassName}>
        <button type="button" className="affairs-sidebar-item-button" onClick={onClick}>
          <span className="affairs-sidebar-item-row">
            <span className="affairs-sidebar-leading-icon" aria-hidden="true">
              {icon === "folder" ? renderMiniFolderIcon() : renderTagIcon()}
            </span>
            <span className="affairs-sidebar-item-title" title={title}>
              {title}
            </span>
          </span>
        </button>
        <div className="affairs-sidebar-item-actions">
          <button
            type="button"
            className="affairs-favorite-toggle active"
            onClick={(e) => {
              e.stopPropagation();
              onRemoveFavorite();
            }}
          >
            {renderFilledStarIcon()}
          </button>
        </div>
      </div>
    );
  }

  // 普通侧边栏项
  return (
    <button
      type="button"
      className={itemClassName}
      onClick={onClick}
    >
      <span className="affairs-sidebar-item-button">
        <span className="affairs-sidebar-item-row">
          <span className="affairs-sidebar-leading-icon" aria-hidden="true">
            {icon === "folder" ? renderMiniFolderIcon() : renderTagIcon()}
          </span>
          <span className="affairs-sidebar-item-title" title={title}>
            {title}
          </span>
          <span className="affairs-sidebar-item-badge">{count}</span>
        </span>
      </span>
    </button>
  );
}

function LibraryBindingPanel({
  library,
  onOpenSettings,
  platformData,
}: {
  library: LibraryState;
  onOpenSettings: () => void;
  platformData: WorkbenchPlatformData;
}) {
  const [rootDir, setRootDir] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [browserLoading, setBrowserLoading] = useState(false);
  const [browserError, setBrowserError] = useState<string | null>(null);
  const [browserCurrentPath, setBrowserCurrentPath] = useState("");
  const [browserInputPath, setBrowserInputPath] = useState("");
  const [browserParentPath, setBrowserParentPath] = useState<string | null>(
    null,
  );
  const [browserRoots, setBrowserRoots] = useState<HostDirectoryOption[]>([]);
  const [browserItems, setBrowserItems] = useState<HostDirectoryOption[]>([]);
  const pendingBindingRootDir = library.snapshot?.binding?.rootDir ?? "";
  const defaultRootDir = library.snapshot?.defaultRootDir ?? "";
  const busy = saving || browserLoading;

  useEffect(() => {
    const suggestedRootDir = pendingBindingRootDir || defaultRootDir;
    if (!rootDir.trim() && suggestedRootDir) {
      setRootDir(suggestedRootDir);
    }
  }, [defaultRootDir, pendingBindingRootDir, rootDir]);

  async function loadHostDirectory(targetPath?: string | null): Promise<void> {
    setBrowserLoading(true);
    setBrowserError(null);

    try {
      const snapshot = await browseHostDirectories(targetPath);
      setBrowserCurrentPath(snapshot.currentPath);
      setBrowserInputPath(snapshot.currentPath);
      setBrowserParentPath(snapshot.parentPath);
      setBrowserRoots(snapshot.roots);
      setBrowserItems(snapshot.items);
    } catch (err) {
      setBrowserCurrentPath("");
      setBrowserParentPath(null);
      setBrowserItems([]);
      setBrowserError(toApiErrorMessage(err));
    } finally {
      setBrowserLoading(false);
    }
  }

  function openDirectoryBrowser(): void {
    setBrowserOpen(true);
    void loadHostDirectory(rootDir.trim() || undefined);
  }

  function closeDirectoryBrowser(): void {
    if (browserLoading) {
      return;
    }

    setBrowserOpen(false);
    setBrowserError(null);
  }

  function applyBrowserCurrentPath(): void {
    if (!browserCurrentPath) {
      return;
    }

    setRootDir(browserCurrentPath);
    setBrowserOpen(false);
    setBrowserError(null);
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    const nextRootDir = rootDir.trim();
    if (!nextRootDir) {
      setError(t("settingsRequiredRootDir"));
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await library.bindLibrary(nextRootDir);
      setRootDir("");
    } catch (err) {
      setError(toApiErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <main
      className="app-shell workbench-shell xfile-workbench-shell"
      data-runtime-platform={platformData.runtimePlatform}
      data-os-family={platformData.osFamily}
      data-overlay-titlebar={platformData.overlayTitlebar ? "true" : undefined}
    >
      <section className="library-init-page affairs-binding-shell">
        <div className="library-init-panel affairs-binding-card">
          <header className="library-init-header">
            <span className="affairs-inline-pill">{t("libraryInitPill")}</span>
            <h1>{t("libraryInitTitle")}</h1>
            <p>{t("libraryInitSubtitle")}</p>
          </header>

          <div className="library-init-body">
            <form
              className="library-init-form"
              onSubmit={(event) => void submit(event)}
            >
              <label>
                <span>{t("settingsRootDir")}</span>
                <div className="library-init-path-row">
                  <input
                    value={rootDir}
                    placeholder={t("settingsRootDirPlaceholder")}
                    onChange={(event) => setRootDir(event.target.value)}
                  />
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={saving}
                    onClick={openDirectoryBrowser}
                  >
                    {t("hostDirectoryBrowseAction")}
                  </button>
                </div>
              </label>
              <p className="muted-copy">{t("libraryBindingInlineHint")}</p>
              <p className="muted-copy">
                {t("libraryInitDefaultRootHint", { rootDir: defaultRootDir || rootDir })}
              </p>
              {error ? (
                <div className="inline-alert compact">{error}</div>
              ) : null}
              {library.error ? (
                <div className="inline-alert compact">{library.error}</div>
              ) : null}
              <div className="button-row">
                <button
                  type="submit"
                  className="primary-button"
                  disabled={saving}
                >
                  {saving ? t("settingsSaving") : t("libraryInitSubmit")}
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => void library.reload()}
                >
                  {t("libraryReload")}
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={onOpenSettings}
                >
                  {t("libraryInitOpenAdvanced")}
                </button>
              </div>
            </form>

            <aside
              className="library-init-logo-panel"
              aria-label={t("appTitle")}
            >
              <img
                className="library-init-logo"
                src="/x-file-logo.svg"
                alt={t("appTitle")}
              />
            </aside>
          </div>
        </div>
      </section>
      <DesktopModal
        open={browserOpen}
        title={t("hostDirectoryBrowserTitle")}
        description={t("hostDirectoryBrowserDescription")}
        size="wide"
        layout="list"
        dismissible={!browserLoading}
        onClose={closeDirectoryBrowser}
        footer={
          <ModalActions align="between">
            <button
              type="button"
              className="secondary-button"
              disabled={browserLoading}
              onClick={closeDirectoryBrowser}
            >
              {t("actionCancel")}
            </button>
            <button
              type="button"
              className="primary-button"
              disabled={browserLoading || !browserCurrentPath}
              onClick={applyBrowserCurrentPath}
            >
              {t("hostDirectoryUseCurrent")}
            </button>
          </ModalActions>
        }
      >
        <div
          className="host-directory-browser"
          aria-label={t("hostDirectoryBrowserTitle")}
        >
          <form
            className="host-directory-browser-form"
            onSubmit={(event) => {
              event.preventDefault();
              void loadHostDirectory(browserInputPath);
            }}
          >
            <label>
              <span>{t("hostDirectoryCurrentPath")}</span>
              <input
                value={browserInputPath}
                placeholder={t("settingsRootDirPlaceholder")}
                onChange={(event) => setBrowserInputPath(event.target.value)}
              />
            </label>
            <div className="host-directory-browser-toolbar">
              <button
                type="button"
                className="secondary-button"
                disabled={busy || !browserParentPath}
                onClick={() => void loadHostDirectory(browserParentPath)}
              >
                {t("hostDirectoryOpenParent")}
              </button>
              <button
                type="submit"
                className="secondary-button"
                disabled={busy}
              >
                {t("hostDirectoryOpenPath")}
              </button>
            </div>
          </form>

          <section className="host-directory-browser-panel">
            <div className="host-directory-browser-roots">
              <span>{t("hostDirectoryRoots")}</span>
              <div>
                {browserRoots.map((item) => (
                  <button
                    key={item.path}
                    type="button"
                    className="host-directory-browser-chip"
                    disabled={busy}
                    onClick={() => void loadHostDirectory(item.path)}
                  >
                    {item.name}
                  </button>
                ))}
              </div>
            </div>

            <div
              className="host-directory-browser-current"
              title={browserCurrentPath}
            >
              {browserCurrentPath || t("hostDirectoryNotLoaded")}
            </div>

            {browserError ? (
              <div className="inline-alert compact">{browserError}</div>
            ) : null}

            {browserLoading ? (
              <p className="host-directory-browser-status">
                {t("hostDirectoryLoading")}
              </p>
            ) : browserItems.length > 0 ? (
              <div className="host-directory-browser-list">
                {browserItems.map((item) => (
                  <button
                    key={item.path}
                    type="button"
                    className="host-directory-browser-item"
                    disabled={busy}
                    onClick={() => void loadHostDirectory(item.path)}
                  >
                    <span className="host-directory-browser-item-name">
                      {item.name}
                    </span>
                    <span className="host-directory-browser-item-path">
                      {item.path}
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <p className="host-directory-browser-status">
                {t("hostDirectoryEmpty")}
              </p>
            )}
          </section>
        </div>
      </DesktopModal>
    </main>
  );
}

function LibraryStage({
  library,
  onOpenSettings,
  onOpenContextMenu,
  onRequestCreate,
  onRequestRename,
  onRequestDelete,
  onRequestTagAssignment: _onRequestTagAssignment,
  onOpenSearch,
  onOpenLibraryViewer,
}: {
  library: LibraryState;
  onOpenSettings: () => void;
  onOpenContextMenu: (
    event: ReactMouseEvent<HTMLElement>,
    target: LibraryContextMenuTarget,
  ) => void;
  onRequestCreate: (state: PendingCreateState) => void;
  onRequestRename: (path: string) => void;
  onRequestDelete: (target: LibraryContextMenuTarget) => void;
  onRequestTagAssignment: (target: LibraryContextMenuTarget) => void;
  onOpenSearch: () => void;
  onOpenLibraryViewer: (entry: LibraryDocumentEntry) => void;
}) {
  const directoryStatus = library.documentPage?.directoryStatus ?? null;
  const blankTarget: LibraryContextMenuTarget = {
    kind: "blank",
    folderPath: library.viewState.selectedFolderPath,
  };

  return (
    <section className="affairs-stage-panel">
      <LibraryStageToolbar
        library={library}
        directoryStatus={directoryStatus}
        onRequestCreate={onRequestCreate}
        onOpenSearch={onOpenSearch}
      />
      <div
        className="affairs-stage-content"
        aria-label={t("libraryDocumentList")}
        onContextMenu={(event) => onOpenContextMenu(event, blankTarget)}
      >
        {library.loading || library.documentsLoading ? (
          <LibrarySkeleton viewMode={library.viewState.viewMode} />
        ) : library.entries.length === 0 ? (
          <div className="affairs-stage-empty">
            {library.viewState.browseMode === "tag"
              ? t("libraryEmptyTag")
              : t("libraryEmptyFolder")}
          </div>
        ) : library.viewState.viewMode === "grid" ? (
          <VirtualLibraryGrid
            library={library}
            entries={library.entries}
            onOpenContextMenu={onOpenContextMenu}
            onOpenLibraryViewer={onOpenLibraryViewer}
          />
        ) : (
          <VirtualLibraryFinderList
            library={library}
            entries={library.entries}
            onOpenContextMenu={onOpenContextMenu}
            onOpenLibraryViewer={onOpenLibraryViewer}
          />
        )}
        {library.hasMore ? (
          <div className="affairs-doc-grid-loading-overlay" aria-hidden="true">
            <button
              type="button"
              className="affairs-doc-grid-loading"
              disabled={library.documentsLoading}
              onClick={() => void library.loadMore()}
            >
              {t("libraryLoadMore")}
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function LibraryStageToolbar({
  library,
  directoryStatus: _directoryStatus,
  onRequestCreate,
  onOpenSearch,
}: {
  library: LibraryState;
  directoryStatus: {
    state: LibraryDirectoryState;
    source: LibraryDirectorySource;
    errorSummary?: string | null;
  } | null;
  onRequestCreate: (state: PendingCreateState) => void;
  onOpenSearch: () => void;
}) {
  const sortOptions: Array<{ value: LibrarySortMode; label: string }> = [
    { value: "recent", label: t("librarySortRecent") },
    { value: "name", label: t("librarySortName") },
    { value: "type", label: t("librarySortType") },
    { value: "size", label: t("librarySortSize") },
    { value: "createdAt", label: t("librarySortCreatedAt") },
  ];

  return (
    <div className="affairs-stage-toolbar">
      <div className="affairs-stage-toolbar-left">
        <div className="affairs-stage-breadcrumb" aria-label={t("libraryCurrentFolder")}>
          <button
            type="button"
            className="affairs-stage-breadcrumb-button root"
            aria-label={t("libraryRootFolder")}
            title={t("libraryRootFolder")}
            onClick={() => library.selectFolder(null)}
          >
            {renderHomeIcon()}
          </button>
          <BreadcrumbItems
            path={
              library.viewState.browseMode === "folder"
                ? library.viewState.selectedFolderPath
                : library.viewState.selectedTagPath
            }
            browseMode={library.viewState.browseMode}
            onSelectFolder={library.selectFolder}
            onSelectTag={library.selectTag}
          />
        </div>
      </div>
      <div className="affairs-stage-toolbar-right">
        <div className="affairs-stage-toolbar-group">
          <button
            type="button"
            className={library.viewState.viewMode === "grid" ? "affairs-stage-toolbar-icon active" : "affairs-stage-toolbar-icon"}
            onClick={() => library.setViewState((current) => ({ ...current, viewMode: "grid" }))}
            aria-label={t("libraryViewGrid")}
            title={t("libraryViewGrid")}
          >
            {renderGridIcon()}
          </button>
          <button
            type="button"
            className={library.viewState.viewMode === "list" ? "affairs-stage-toolbar-icon active" : "affairs-stage-toolbar-icon"}
            onClick={() => library.setViewState((current) => ({ ...current, viewMode: "list" }))}
            aria-label={t("libraryViewList")}
            title={t("libraryViewList")}
          >
            {renderListIcon()}
          </button>
        </div>
        {library.viewState.browseMode === "tag" &&
        library.viewState.selectedTagPaths.length > 0 &&
        library.viewState.viewMode === "list" ? (
          <span
            className="affairs-tag-result-structure-switch"
            role="group"
            aria-label={t("libraryTagResultStructureLabel")}
          >
            <button
              type="button"
              className={library.viewState.tagResultStructureMode === "file" ? "active" : ""}
              onClick={() => library.setViewState((current) => ({ ...current, tagResultStructureMode: "file" }))}
              aria-pressed={library.viewState.tagResultStructureMode === "file"}
            >
              {t("libraryTagResultFileMode")}
            </button>
            <button
              type="button"
              className={library.viewState.tagResultStructureMode === "directory" ? "active" : ""}
              onClick={() => library.setViewState((current) => ({ ...current, tagResultStructureMode: "directory" }))}
              aria-pressed={library.viewState.tagResultStructureMode === "directory"}
            >
              {t("libraryTagResultDirectoryMode")}
            </button>
          </span>
        ) : null}
        <select
          className="affairs-stage-toolbar-select"
          value={library.viewState.librarySort.mode}
          onChange={(event) =>
            library.setViewState((current) => ({
              ...current,
              librarySort: {
                ...current.librarySort,
                mode: event.target.value as LibrarySortMode,
              },
            }))
          }
          aria-label={t("librarySortRecent")}
          title={t("librarySortRecent")}
        >
          {sortOptions.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
        <button
          type="button"
          className="affairs-stage-toolbar-icon"
          disabled={library.refreshPending}
          onClick={() => void library.refresh()}
          aria-label={t("libraryRefresh")}
          title={t("libraryRefresh")}
        >
          {renderRefreshIcon()}
        </button>
        <LibraryIndexStatusPopover status={library.snapshot?.status ?? null} />
        <button
          type="button"
          className="affairs-stage-toolbar-icon"
          onClick={onOpenSearch}
          aria-label={t("librarySearchAction")}
          title={t("librarySearchAction")}
        >
          {renderSearchIcon()}
        </button>
        <button
          type="button"
          className="affairs-stage-toolbar-icon"
          onClick={() => onRequestCreate({ kind: "directory", folderPath: library.viewState.selectedFolderPath, fileName: t("libraryCreateDirectoryDefaultName") })}
          aria-label={t("libraryContextNew")}
          title={t("libraryContextNew")}
        >
          {renderPlusIcon()}
        </button>
      </div>
    </div>
  );
}

function BreadcrumbItems({
  path,
  browseMode,
  onSelectFolder,
  onSelectTag,
}: {
  path: string | null;
  browseMode: "folder" | "tag";
  onSelectFolder: (path: string | null, selectedEntryPath?: string | null) => void;
  onSelectTag: (path: string | null) => void;
}) {
  const segments = path?.split("/").filter(Boolean) ?? [];
  if (!segments.length) {
    return null;
  }
  return (
    <>
      {segments.map((segment, index) => {
        const nextPath = segments.slice(0, index + 1).join("/");
        const sourceEntryPath = segments.slice(0, index + 2).join("/");
        const current = index === segments.length - 1;
        return (
          <span key={nextPath} className="affairs-stage-breadcrumb-fragment">
            <span
              className="affairs-stage-breadcrumb-separator"
              aria-hidden="true"
            >
              &gt;
            </span>
            <button
              type="button"
              className={
                current
                  ? "affairs-stage-breadcrumb-button current"
                  : "affairs-stage-breadcrumb-button"
              }
              onClick={() =>
                browseMode === "folder"
                  ? onSelectFolder(nextPath, sourceEntryPath || null)
                  : onSelectTag(nextPath)
              }
            >
              {segment}
            </button>
          </span>
        );
      })}
    </>
  );
}

function LibrarySkeleton({ viewMode }: { viewMode: "grid" | "list" }) {
  if (viewMode === "list") {
    return (
      <div
        className="affairs-stage-skeleton affairs-stage-skeleton-list"
        aria-hidden="true"
      >
        {Array.from({ length: 12 }).map((_, index) => (
          <div key={index} className="affairs-stage-skeleton-row" />
        ))}
      </div>
    );
  }
  return (
    <div
      className="affairs-stage-skeleton affairs-stage-skeleton-grid"
      aria-hidden="true"
    >
      {Array.from({ length: 24 }).map((_, index) => (
        <div key={index} className="affairs-stage-skeleton-card" />
      ))}
    </div>
  );
}

const VIRTUAL_GRID_TRACK_MIN_WIDTH = 132;
const VIRTUAL_GRID_COLUMN_GAP = 8;
const VIRTUAL_GRID_ITEM_HEIGHT = 106;
const VIRTUAL_GRID_ROW_GAP = 14;
const VIRTUAL_GRID_MIN_ITEMS = 80;
const VIRTUAL_LIST_ROW_HEIGHT = 40;
const VIRTUAL_OVERSCAN = 2;
const VIRTUAL_LIST_OVERSCAN = 8;
const VIRTUAL_LOAD_MORE_DISTANCE = 320;

type VirtualLibraryEntrySlot = {
  index: number;
  entry: LibraryEntry | null;
};

function VirtualLibraryGrid({
  library,
  entries,
  onOpenContextMenu,
  onOpenLibraryViewer,
}: {
  library: LibraryState;
  entries: LibraryEntry[];
  onOpenContextMenu: (
    event: ReactMouseEvent<HTMLElement>,
    target: LibraryContextMenuTarget,
  ) => void;
  onOpenLibraryViewer: (entry: LibraryDocumentEntry) => void;
}) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState({
    width: 0,
    height: 0,
    scrollTop: 0,
  });
  const [measuredColumns, setMeasuredColumns] = useState<number | null>(null);
  const [measuredItemHeight, setMeasuredItemHeight] = useState(
    VIRTUAL_GRID_ITEM_HEIGHT,
  );
  const [measuredRowGap, setMeasuredRowGap] = useState(VIRTUAL_GRID_ROW_GAP);

  useLayoutEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const sync = () =>
      setViewport((current) => ({
        ...current,
        width: measureStageScrollContentWidth(element),
        height: element.clientHeight,
        scrollTop: element.scrollTop,
      }));
    sync();
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(sync);
    observer?.observe(element);
    return () => observer?.disconnect();
  }, []);

  useLayoutEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const syncMeasurements = () => {
      const next = measureAffairsGridLayout(element);
      if (next.columns && next.columns !== measuredColumns) {
        setMeasuredColumns(next.columns);
      }
      if (
        next.itemHeight &&
        Math.abs(next.itemHeight - measuredItemHeight) > 0.5
      ) {
        setMeasuredItemHeight(next.itemHeight);
      }
      if (
        next.rowGap !== null &&
        Math.abs(next.rowGap - measuredRowGap) > 0.5
      ) {
        setMeasuredRowGap(next.rowGap);
      }
    };
    let frameId = window.requestAnimationFrame(syncMeasurements);
    const timeoutId = window.setTimeout(syncMeasurements, 80);
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            window.cancelAnimationFrame(frameId);
            frameId = window.requestAnimationFrame(syncMeasurements);
          });
    observer?.observe(element);
    return () => {
      observer?.disconnect();
      window.cancelAnimationFrame(frameId);
      window.clearTimeout(timeoutId);
    };
  }, [entries.length, measuredColumns, measuredItemHeight, measuredRowGap]);

  const columns = Math.max(
    1,
    measuredColumns ??
      resolveAffairsGridColumnCount(viewport.width, {
        trackMinWidth: VIRTUAL_GRID_TRACK_MIN_WIDTH,
        columnGap: VIRTUAL_GRID_COLUMN_GAP,
      }),
  );
  const virtualItemCount = Math.max(entries.length, library.visibleEntryTotal);
  const metrics = computeVirtualGridMetrics(
    virtualItemCount,
    viewport.width,
    viewport.height,
    viewport.scrollTop,
    {
      columns,
      itemHeight: measuredItemHeight,
      rowGap: measuredRowGap,
      trackMinWidth: VIRTUAL_GRID_TRACK_MIN_WIDTH,
      columnGap: VIRTUAL_GRID_COLUMN_GAP,
    },
  );
  const shouldVirtualize = shouldVirtualizeAffairsGrid(
    virtualItemCount,
    viewport.width,
    viewport.height,
    {
      itemHeight: measuredItemHeight,
      trackMinWidth: VIRTUAL_GRID_TRACK_MIN_WIDTH,
    },
  );
  const visibleSlots = shouldVirtualize
    ? buildVirtualLibraryEntrySlots(
        entries,
        metrics.startIndex,
        metrics.endIndex,
      )
    : buildVirtualLibraryEntrySlots(entries, 0, entries.length);

  function handleScroll(element: HTMLDivElement): void {
    setViewport((current) => ({
      ...current,
      scrollTop: element.scrollTop,
      width: measureStageScrollContentWidth(element),
      height: element.clientHeight,
    }));
    if (!library.hasMore || library.documentsLoading) return;
    const remaining =
      element.scrollHeight - element.scrollTop - element.clientHeight;
    const preloadRows = Math.max(columns * 3, 18);
    if (
      metrics.endIndex >= entries.length - preloadRows ||
      remaining <= VIRTUAL_LOAD_MORE_DISTANCE
    ) {
      void library.loadMore();
    }
  }

  const grid = (
    <div
      className={
        shouldVirtualize
          ? "affairs-doc-grid affairs-doc-grid-virtual"
          : "affairs-doc-grid"
      }
      style={
        shouldVirtualize
          ? {
              top: `${metrics.offsetTop}px`,
              gridTemplateColumns: `repeat(${columns}, minmax(116px, 1fr))`,
            }
          : undefined
      }
    >
      {visibleSlots.map((slot) =>
        slot.entry ? (
          <LibraryEntryCard
            key={resolveLibraryEntryKey(slot.entry)}
            entry={slot.entry}
            library={library}
            onOpenContextMenu={onOpenContextMenu}
            onOpenLibraryViewer={onOpenLibraryViewer}
          />
        ) : (
          <AffairsGridPlaceholderCard key={`grid-placeholder-${slot.index}`} />
        ),
      )}
    </div>
  );

  return (
    <div
      ref={viewportRef}
      className="affairs-doc-grid-scroll"
      onScroll={(event) => handleScroll(event.currentTarget)}
    >
      <div className="affairs-doc-grid-viewport">
        {shouldVirtualize ? (
          <div
            className="affairs-doc-grid-spacer"
            style={{ height: `${metrics.totalHeight}px` }}
          >
            {grid}
          </div>
        ) : (
          grid
        )}
      </div>
    </div>
  );
}

function VirtualLibraryFinderList({
  library,
  entries,
  onOpenContextMenu,
  onOpenLibraryViewer,
}: {
  library: LibraryState;
  entries: LibraryEntry[];
  onOpenContextMenu: (
    event: ReactMouseEvent<HTMLElement>,
    target: LibraryContextMenuTarget,
  ) => void;
  onOpenLibraryViewer: (entry: LibraryDocumentEntry) => void;
}) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState({ height: 0, scrollTop: 0 });
  const [measuredRowHeight, setMeasuredRowHeight] = useState(
    VIRTUAL_LIST_ROW_HEIGHT,
  );
  const finderResizeStateRef = useRef<FinderResizeState | null>(null);
  const finderGridTemplateColumns = useMemo(
    () => buildFinderGridTemplateColumns(library.viewState.finderColumnWidths),
    [library.viewState.finderColumnWidths],
  );

  useEffect(
    () => () => {
      document.documentElement.removeAttribute(
        "data-workbench-finder-column-resizing",
      );
    },
    [],
  );

  useLayoutEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const itemCount = Math.max(entries.length, library.visibleEntryTotal);
    const sync = () =>
      setViewport((current) => ({
        ...current,
        height: element.clientHeight,
        scrollTop: clampScrollTop(
          element.scrollTop,
          itemCount,
          measuredRowHeight,
          element.clientHeight,
        ),
      }));
    sync();
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(sync);
    observer?.observe(element);
    return () => observer?.disconnect();
  }, [entries.length, library.visibleEntryTotal, measuredRowHeight]);

  useLayoutEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const sync = () => {
      const nextHeight = measureAffairsFinderRowHeight(element);
      if (nextHeight && Math.abs(nextHeight - measuredRowHeight) > 0.5) {
        setMeasuredRowHeight(nextHeight);
      }
    };
    let frameId = window.requestAnimationFrame(sync);
    const timeoutId = window.setTimeout(sync, 80);
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            window.cancelAnimationFrame(frameId);
            frameId = window.requestAnimationFrame(sync);
          });
    observer?.observe(element);
    return () => {
      observer?.disconnect();
      window.cancelAnimationFrame(frameId);
      window.clearTimeout(timeoutId);
    };
  }, [entries.length, measuredRowHeight]);

  const virtualItemCount = Math.max(entries.length, library.visibleEntryTotal);
  const metrics = computeVirtualListMetrics(
    virtualItemCount,
    viewport.height,
    viewport.scrollTop,
    { rowHeight: measuredRowHeight },
  );
  const visibleSlots = buildVirtualLibraryEntrySlots(
    entries,
    metrics.startIndex,
    metrics.endIndex,
  );

  function handleScroll(element: HTMLDivElement): void {
    const nextScrollTop = clampScrollTop(
      element.scrollTop,
      virtualItemCount,
      measuredRowHeight,
      element.clientHeight,
    );
    if (nextScrollTop !== element.scrollTop) {
      element.scrollTop = nextScrollTop;
    }
    setViewport((current) => ({
      ...current,
      scrollTop: nextScrollTop,
      height: element.clientHeight,
    }));
    if (!library.hasMore || library.documentsLoading) return;
    const remaining =
      element.scrollHeight - element.scrollTop - element.clientHeight;
    const preloadRows = Math.max(
      12,
      Math.ceil(
        Math.max(viewport.height, measuredRowHeight) / measuredRowHeight,
      ),
    );
    const currentMetrics = computeVirtualListMetrics(
      virtualItemCount,
      element.clientHeight,
      nextScrollTop,
      { rowHeight: measuredRowHeight },
    );
    const loadedEndIndex = Math.min(currentMetrics.endIndex, entries.length);
    if (
      loadedEndIndex >= entries.length - preloadRows ||
      remaining <= VIRTUAL_LOAD_MORE_DISTANCE
    ) {
      void library.loadMore();
    }
  }

  function handleFinderColumnResizeStart(
    column: FinderColumnKey,
    event: ReactPointerEvent<HTMLSpanElement>,
  ): void {
    event.preventDefault();
    event.stopPropagation();
    finderResizeStateRef.current = {
      column,
      startX: event.clientX,
      startWidth:
        library.viewState.finderColumnWidths[column] ??
        DEFAULT_FINDER_COLUMN_WIDTHS[column],
    };
    document.documentElement.setAttribute(
      "data-workbench-finder-column-resizing",
      "true",
    );

    const target = event.currentTarget;
    if (typeof target.setPointerCapture === "function") {
      target.setPointerCapture(event.pointerId);
    }

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const current = finderResizeStateRef.current;
      if (
        !current ||
        current.column !== column ||
        !Number.isFinite(moveEvent.clientX)
      ) {
        return;
      }
      const delta = moveEvent.clientX - current.startX;
      const nextWidth = Math.max(
        FINDER_COLUMN_MIN_WIDTHS[column],
        Math.round(current.startWidth + delta),
      );
      library.setViewState((state) => {
        if (state.finderColumnWidths[column] === nextWidth) {
          return state;
        }
        return {
          ...state,
          finderColumnWidths: {
            ...state.finderColumnWidths,
            [column]: nextWidth,
          },
        };
      });
    };

    const finishResize = () => {
      finderResizeStateRef.current = null;
      document.documentElement.removeAttribute(
        "data-workbench-finder-column-resizing",
      );
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", finishResize);
      window.removeEventListener("pointercancel", finishResize);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", finishResize);
    window.addEventListener("pointercancel", finishResize);
  }

  function handleFinderSort(column: FinderColumnKey): void {
    library.setViewState((state) => ({
      ...state,
      librarySort: getNextSortState(state.librarySort, column),
    }));
  }

  return (
    <div className="affairs-finder-shell">
      <div
        className="affairs-finder-header"
        style={{ gridTemplateColumns: finderGridTemplateColumns }}
      >
        {[
          { key: "name", label: t("libraryFinderName") },
          { key: "size", label: t("libraryMetaSize") },
          { key: "updatedAt", label: t("libraryMetaUpdatedAt") },
          { key: "type", label: t("libraryFinderKind") },
          { key: "createdAt", label: t("libraryMetaCreatedAt") },
        ].map((column) => (
          <span
            key={column.key}
            className="affairs-finder-header-cell affairs-finder-cell"
          >
            <button
              type="button"
              className="affairs-finder-sort-button"
              onClick={() => handleFinderSort(column.key as FinderColumnKey)}
              aria-label={buildFinderSortButtonLabel(
                column.label,
                library.viewState.librarySort,
                column.key as FinderColumnKey,
              )}
              title={buildFinderSortButtonLabel(
                column.label,
                library.viewState.librarySort,
                column.key as FinderColumnKey,
              )}
            >
              <span>{column.label}</span>
              {renderFinderSortIndicator(
                library.viewState.librarySort,
                column.key as FinderColumnKey,
              )}
            </button>
            <span
              className="affairs-finder-column-resizer"
              role="separator"
              aria-orientation="vertical"
              aria-label={t("libraryColumnResizeLabel", {
                column: column.label,
              })}
              onPointerDown={(event) =>
                handleFinderColumnResizeStart(
                  column.key as FinderColumnKey,
                  event,
                )
              }
            />
          </span>
        ))}
      </div>
      <div
        ref={viewportRef}
        className="affairs-finder-list affairs-finder-viewport"
        onScroll={(event) => handleScroll(event.currentTarget)}
      >
        <div
          className="affairs-finder-spacer"
          style={{ height: `${metrics.totalHeight}px` }}
        >
          <div
            className="affairs-finder-virtual"
            style={{ top: `${metrics.offsetTop}px` }}
          >
            {visibleSlots.map((slot) =>
              slot.entry ? (
                <LibraryFinderRow
                  key={resolveLibraryEntryKey(slot.entry)}
                  entry={slot.entry}
                  library={library}
                  gridTemplateColumns={finderGridTemplateColumns}
                  onOpenContextMenu={onOpenContextMenu}
                  onOpenLibraryViewer={onOpenLibraryViewer}
                />
              ) : (
                <AffairsFinderPlaceholderRow
                  key={`list-placeholder-${slot.index}`}
                  gridTemplateColumns={finderGridTemplateColumns}
                />
              ),
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function resolveAffairsGridColumnCount(
  containerWidth: number,
  options?: { trackMinWidth?: number; columnGap?: number },
): number {
  const trackMinWidth = Math.max(
    1,
    options?.trackMinWidth ?? VIRTUAL_GRID_TRACK_MIN_WIDTH,
  );
  const columnGap = Math.max(0, options?.columnGap ?? VIRTUAL_GRID_COLUMN_GAP);
  return Math.max(
    1,
    Math.floor(
      (Math.max(0, containerWidth) + columnGap) / (trackMinWidth + columnGap),
    ),
  );
}

function shouldVirtualizeAffairsGrid(
  itemCount: number,
  viewportWidth: number,
  viewportHeight: number,
  options?: { itemHeight?: number; trackMinWidth?: number },
): boolean {
  const itemHeight = Math.max(
    1,
    options?.itemHeight ?? VIRTUAL_GRID_ITEM_HEIGHT,
  );
  const trackMinWidth = Math.max(
    1,
    options?.trackMinWidth ?? VIRTUAL_GRID_TRACK_MIN_WIDTH,
  );
  return (
    itemCount >= VIRTUAL_GRID_MIN_ITEMS &&
    viewportWidth >= trackMinWidth &&
    viewportHeight >= itemHeight * 2
  );
}

function computeVirtualGridMetrics(
  itemCount: number,
  viewportWidth: number,
  viewportHeight: number,
  scrollTop: number,
  options?: {
    columns?: number;
    itemHeight?: number;
    rowGap?: number;
    trackMinWidth?: number;
    columnGap?: number;
  },
) {
  const columns = Math.max(
    1,
    options?.columns ?? resolveAffairsGridColumnCount(viewportWidth, options),
  );
  const itemHeight = Math.max(
    1,
    options?.itemHeight ?? VIRTUAL_GRID_ITEM_HEIGHT,
  );
  const rowGap = Math.max(0, options?.rowGap ?? VIRTUAL_GRID_ROW_GAP);
  const rowHeight = itemHeight + rowGap;
  const rowCount = Math.ceil(itemCount / columns);
  const startRow = Math.max(
    0,
    Math.floor(scrollTop / rowHeight) - VIRTUAL_OVERSCAN,
  );
  const visibleRows = Math.max(
    1,
    Math.ceil(Math.max(viewportHeight, rowHeight) / rowHeight),
  );
  const endRow = Math.min(
    rowCount,
    startRow + visibleRows + VIRTUAL_OVERSCAN * 2,
  );
  return {
    columns,
    startIndex: startRow * columns,
    endIndex: Math.min(itemCount, endRow * columns),
    offsetTop: startRow * rowHeight,
    totalHeight: rowCount * itemHeight + Math.max(0, rowCount - 1) * rowGap,
  };
}

function computeVirtualListMetrics(
  itemCount: number,
  viewportHeight: number,
  scrollTop: number,
  options?: { rowHeight?: number },
) {
  const rowHeight = Math.max(1, options?.rowHeight ?? VIRTUAL_LIST_ROW_HEIGHT);
  const visibleRows = Math.max(
    1,
    Math.ceil(Math.max(viewportHeight, rowHeight) / rowHeight),
  );
  const startRow = Math.max(
    0,
    Math.floor(scrollTop / rowHeight) - VIRTUAL_LIST_OVERSCAN,
  );
  const endRow = Math.min(
    itemCount,
    startRow + visibleRows + VIRTUAL_LIST_OVERSCAN * 2,
  );
  return {
    startIndex: startRow,
    endIndex: endRow,
    offsetTop: startRow * rowHeight,
    totalHeight: itemCount * rowHeight,
  };
}

function clampScrollTop(
  scrollTop: number,
  itemCount: number,
  rowHeight: number,
  viewportHeight: number,
): number {
  const maxScrollTop = Math.max(
    0,
    itemCount * Math.max(1, rowHeight) - Math.max(0, viewportHeight),
  );
  return Math.min(Math.max(0, scrollTop), maxScrollTop);
}

function measureStageScrollContentWidth(element: HTMLElement): number {
  const styles = window.getComputedStyle(element);
  const paddingLeft = Number.parseFloat(styles.paddingLeft || "0");
  const paddingRight = Number.parseFloat(styles.paddingRight || "0");
  return Math.max(0, element.clientWidth - paddingLeft - paddingRight);
}

function readMeasuredPixelValue(
  value: string | null | undefined,
): number | null {
  const nextValue = Number.parseFloat(value ?? "");
  return Number.isFinite(nextValue) && nextValue > 0 ? nextValue : null;
}

function readMeasuredTrackCount(
  gridTemplateColumns: string | null | undefined,
): number | null {
  const normalized = String(gridTemplateColumns ?? "").trim();
  if (!normalized || normalized === "none") return null;
  const tracks = normalized
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
  return tracks.length || null;
}

function measureAffairsFinderRowHeight(
  container: HTMLElement | null,
): number | null {
  if (!container) return null;
  const row =
    container.querySelector<HTMLElement>(
      ".affairs-finder-row:not(.is-placeholder)",
    ) ?? container.querySelector<HTMLElement>(".affairs-finder-row");
  if (!row) return null;
  const rectHeight = row.getBoundingClientRect().height;
  return rectHeight > 0
    ? rectHeight
    : readMeasuredPixelValue(window.getComputedStyle(row).height);
}

function mapFinderColumnToSortMode(column: FinderColumnKey): LibrarySortMode {
  if (column === "name") return "name";
  if (column === "size") return "size";
  if (column === "type") return "type";
  if (column === "createdAt") return "createdAt";
  return "recent";
}

function getNextSortState(
  current: LibrarySortState,
  column: FinderColumnKey,
): LibrarySortState {
  const mode = mapFinderColumnToSortMode(column);
  if (current.mode === mode) {
    return {
      mode,
      direction: current.direction === "asc" ? "desc" : "asc",
    };
  }
  return {
    mode,
    direction: mode === "name" || mode === "type" ? "asc" : "desc",
  };
}

function renderFinderSortIndicator(
  sortState: LibrarySortState,
  column: FinderColumnKey,
) {
  if (sortState.mode !== mapFinderColumnToSortMode(column)) {
    return (
      <span className="affairs-finder-sort-indicator" aria-hidden="true" />
    );
  }
  return (
    <span className="affairs-finder-sort-indicator active" aria-hidden="true">
      {sortState.direction === "asc" ? "↑" : "↓"}
    </span>
  );
}

function buildFinderSortButtonLabel(
  label: string,
  sortState: LibrarySortState,
  column: FinderColumnKey,
): string {
  if (sortState.mode !== mapFinderColumnToSortMode(column)) {
    return t("librarySortByColumn", { column: label });
  }
  return t(
    sortState.direction === "asc"
      ? "librarySortColumnAsc"
      : "librarySortColumnDesc",
    { column: label },
  );
}

function buildFinderGridTemplateColumns(
  widths: Record<FinderColumnKey, number>,
): string {
  const normalized = {
    name: Number.isFinite(widths.name)
      ? widths.name
      : DEFAULT_FINDER_COLUMN_WIDTHS.name,
    size: Number.isFinite(widths.size)
      ? widths.size
      : DEFAULT_FINDER_COLUMN_WIDTHS.size,
    updatedAt: Number.isFinite(widths.updatedAt)
      ? widths.updatedAt
      : DEFAULT_FINDER_COLUMN_WIDTHS.updatedAt,
    type: Number.isFinite(widths.type)
      ? widths.type
      : DEFAULT_FINDER_COLUMN_WIDTHS.type,
    createdAt: Number.isFinite(widths.createdAt)
      ? widths.createdAt
      : DEFAULT_FINDER_COLUMN_WIDTHS.createdAt,
  };
  return [
    `minmax(${FINDER_COLUMN_MIN_WIDTHS.name}px, ${Math.max(FINDER_COLUMN_MIN_WIDTHS.name, Math.round(normalized.name))}px)`,
    `minmax(${FINDER_COLUMN_MIN_WIDTHS.size}px, ${Math.max(FINDER_COLUMN_MIN_WIDTHS.size, Math.round(normalized.size))}px)`,
    `minmax(${FINDER_COLUMN_MIN_WIDTHS.updatedAt}px, ${Math.max(FINDER_COLUMN_MIN_WIDTHS.updatedAt, Math.round(normalized.updatedAt))}px)`,
    `minmax(${FINDER_COLUMN_MIN_WIDTHS.type}px, ${Math.max(FINDER_COLUMN_MIN_WIDTHS.type, Math.round(normalized.type))}px)`,
    `minmax(${Math.max(FINDER_COLUMN_MIN_WIDTHS.createdAt, Math.round(normalized.createdAt))}px, 1fr)`,
  ].join(" ");
}

function measureAffairsGridLayout(container: HTMLElement | null): {
  columns: number | null;
  itemHeight: number | null;
  rowGap: number | null;
} {
  if (!container) {
    return { columns: null, itemHeight: null, rowGap: null };
  }
  const grid = container.querySelector<HTMLElement>(".affairs-doc-grid");
  const item =
    container.querySelector<HTMLElement>(
      ".affairs-doc-item.grid:not(.is-placeholder)",
    ) ?? container.querySelector<HTMLElement>(".affairs-doc-item.grid");
  const gridStyles = grid ? window.getComputedStyle(grid) : null;
  const itemHeight = item?.getBoundingClientRect().height ?? 0;
  return {
    columns: readMeasuredTrackCount(gridStyles?.gridTemplateColumns),
    itemHeight:
      itemHeight > 0
        ? itemHeight
        : readMeasuredPixelValue(
            item ? window.getComputedStyle(item).height : null,
          ),
    rowGap: readMeasuredPixelValue(gridStyles?.rowGap),
  };
}

function buildVirtualLibraryEntrySlots(
  loadedEntries: LibraryEntry[],
  startIndex: number,
  endIndex: number,
): VirtualLibraryEntrySlot[] {
  const slots: VirtualLibraryEntrySlot[] = [];
  for (let index = startIndex; index < endIndex; index += 1) {
    slots.push({ index, entry: loadedEntries[index] ?? null });
  }
  return slots;
}

function AffairsGridPlaceholderCard() {
  return (
    <div className="affairs-doc-item grid is-placeholder" aria-hidden="true">
      <div className="affairs-doc-icon">
        <div className="affairs-doc-placeholder-icon" />
      </div>
      <div className="affairs-doc-placeholder-lines">
        <span />
        <span />
      </div>
      <div className="affairs-doc-footer">
        <span className="affairs-doc-placeholder-meta" />
      </div>
    </div>
  );
}

function AffairsFinderPlaceholderRow({
  gridTemplateColumns,
}: {
  gridTemplateColumns: string;
}) {
  return (
    <div
      className="affairs-finder-row is-placeholder"
      style={{ gridTemplateColumns }}
      aria-hidden="true"
    >
      <span className="affairs-finder-name-cell">
        <span className="affairs-finder-placeholder-icon" />
        <span className="affairs-finder-placeholder-name" />
      </span>
      <span className="affairs-finder-placeholder-cell" />
      <span className="affairs-finder-placeholder-cell" />
      <span className="affairs-finder-placeholder-cell" />
      <span className="affairs-finder-placeholder-cell" />
    </div>
  );
}

function LibraryEntryCard({
  entry,
  library,
  onOpenContextMenu,
  onOpenLibraryViewer,
}: {
  entry: LibraryEntry;
  library: LibraryState;
  onOpenContextMenu: (
    event: ReactMouseEvent<HTMLElement>,
    target: LibraryContextMenuTarget,
  ) => void;
  onOpenLibraryViewer: (entry: LibraryDocumentEntry) => void;
}) {
  if (entry.kind !== "document") {
    const active = library.viewState.selectedFolderEntryPath === entry.path;
    return (
      <button
        type="button"
        className={
          active ? "affairs-doc-item grid active" : "affairs-doc-item grid"
        }
        onClick={() => { if (entry.kind === "folder") handleFolderClick(library, entry.path); }}
        onDoubleClick={() => { if (entry.kind === "folder") library.selectFolder(entry.path); }}
        onContextMenu={(event) => {
          if (entry.kind !== "folder") {
            return;
          }
          library.selectFolderEntry(entry.path);
          onOpenContextMenu(event, { kind: "folder", entry });
        }}
      >
        <div className="affairs-doc-icon">{renderFolderShape()}</div>
        <div className="affairs-doc-title" title={entry.name}>
          {entry.name}
        </div>
        <div className="affairs-doc-footer">
          <span className="affairs-doc-muted">
            {t("libraryCountDocuments", { count: entry.documentCount })}
          </span>
        </div>
      </button>
    );
  }

  const active = library.viewState.selectedDocumentId === entry.documentId;
  return (
    <button
      type="button"
      className={
        active ? "affairs-doc-item grid active" : "affairs-doc-item grid"
      }
      onClick={() => library.selectDocument(entry.documentId)}
      onContextMenu={(event) => {
        library.selectDocument(entry.documentId);
        onOpenContextMenu(event, { kind: "document", entry });
      }}
      onDoubleClick={() => onOpenLibraryViewer(entry)}
    >
      <div className="affairs-doc-icon">{renderDocumentShape(entry.path)}</div>
      <div
        className="affairs-doc-title"
        title={resolveLibraryDocumentDisplayName(entry)}
      >
        {resolveLibraryDocumentDisplayName(entry)}
      </div>
      <div className="affairs-doc-footer">
        <span className="affairs-doc-muted">
          {formatDateTime(entry.updatedAt)}
        </span>
      </div>
    </button>
  );
}

function LibraryFinderRow({
  entry,
  library,
  gridTemplateColumns,
  onOpenContextMenu,
  onOpenLibraryViewer,
}: {
  entry: LibraryEntry;
  library: LibraryState;
  gridTemplateColumns: string;
  onOpenContextMenu: (
    event: ReactMouseEvent<HTMLElement>,
    target: LibraryContextMenuTarget,
  ) => void;
  onOpenLibraryViewer: (entry: LibraryDocumentEntry) => void;
}) {
  if (entry.kind !== "document") {
    const active = library.viewState.selectedFolderEntryPath === entry.path;
    return (
      <button
        type="button"
        className={
          active
            ? "affairs-finder-row affairs-finder-directory-row active"
            : "affairs-finder-row affairs-finder-directory-row"
        }
        style={{ gridTemplateColumns }}
        onClick={() => { if (entry.kind === "folder") handleFolderClick(library, entry.path); }}
        onDoubleClick={() => { if (entry.kind === "folder") library.selectFolder(entry.path); }}
        onContextMenu={(event) => {
          if (entry.kind !== "folder") {
            return;
          }
          library.selectFolderEntry(entry.path);
          onOpenContextMenu(event, { kind: "folder", entry });
        }}
      >
        <span className="affairs-finder-name-cell">
          {entry.kind === "tag-directory" ? (
            <span className="affairs-finder-disclosure" aria-hidden="true">▾</span>
          ) : null}
          <span className="affairs-finder-icon">
            {renderFolderShape("row")}
          </span>
          <span className="affairs-finder-name" title={entry.name}>
            {entry.name}
          </span>
          {entry.kind === "tag-directory" ? (
            <span className="affairs-finder-directory-count">{t("libraryCountDocuments", { count: entry.documentCount })}</span>
          ) : null}
        </span>
        <span className="affairs-finder-cell">--</span>
        <span className="affairs-finder-cell">
          {formatDateTime(entry.updatedAt)}
        </span>
        <span className="affairs-finder-cell">
          {t("libraryFinderKindFolder")}
        </span>
        <span className="affairs-finder-cell">--</span>
      </button>
    );
  }

  const active = library.viewState.selectedDocumentId === entry.documentId;
  return (
    <button
      type="button"
      className={active ? "affairs-finder-row active" : "affairs-finder-row"}
      style={{ gridTemplateColumns }}
      onClick={() => library.selectDocument(entry.documentId)}
      onContextMenu={(event) => {
        library.selectDocument(entry.documentId);
        onOpenContextMenu(event, { kind: "document", entry });
      }}
      onDoubleClick={() => onOpenLibraryViewer(entry)}
    >
      <span className="affairs-finder-name-cell" style={{ "--affairs-finder-depth": entry.depth ?? 0 } as CSSProperties}>
        <span className="affairs-finder-icon">
          {renderDocumentShape(entry.path, "row")}
        </span>
        <span
          className="affairs-finder-name"
          title={resolveLibraryDocumentDisplayName(entry)}
        >
          {resolveLibraryDocumentDisplayName(entry)}
        </span>
      </span>
      <span className="affairs-finder-cell">
        {formatFinderBytes(entry.sizeBytes)}
      </span>
      <span className="affairs-finder-cell">
        {formatDateTime(entry.updatedAt)}
      </span>
      <span className="affairs-finder-cell">
        {resolveFinderKindLabel(entry.path)}
      </span>
      <span className="affairs-finder-cell">
        {formatDateTime(entry.createdAt)}
      </span>
    </button>
  );
}

function LibraryDetail({
  library,
  onRequestRename,
  onRequestDelete,
  onRequestTagAssignment,
}: {
  library: LibraryState;
  onRequestRename: (path: string) => void;
  onRequestDelete: (target: LibraryContextMenuTarget) => void;
  onRequestTagAssignment: (target: LibraryContextMenuTarget) => void;
}) {
  const selected = library.selectedDocument;
  const selectedLocalPath = selected
    ? resolveDocumentLocalPath(library, selected.path)
    : null;
  const selectedFolder = !selected
    ? library.entries.find(
        (entry): entry is LibraryDirectoryEntry =>
          isLibraryDirectoryEntry(entry) &&
          entry.path === library.viewState.selectedFolderEntryPath,
      ) ?? null
    : null;
  const preview = library.preview;

  return (
    <aside className="affairs-detail-panel library-detail" aria-label={t("libraryDetails")}>
      <header
        className="affairs-detail-tabs"
        role="tablist"
        aria-label={t("libraryDetails")}
      >
        <button type="button" className="active">
          {t("libraryObjectDetail")}
        </button>
        <button type="button" disabled>
          {t("libraryAssistant")}
        </button>
      </header>
      {!selected && !selectedFolder ? (
        <div className="affairs-detail-empty">{t("libraryNoSelection")}</div>
      ) : selectedFolder ? (
        <div className="affairs-detail-scroll">
          <section className="affairs-detail-block affairs-detail-summary-block">
            <span className="affairs-detail-eyebrow">
              {t("libraryDirectoryDetail")}
            </span>
            <div className="affairs-detail-title-block">
              <div className="affairs-doc-icon detail-doc-icon">
                {renderFolderShape("row")}
              </div>
              <h2>{selectedFolder.name}</h2>
              <LibraryDetailSummary
                summary={library.documentPage?.directoryStatus?.staleReason ?? ""}
              />
            </div>
            <DetailRow label={t("libraryMetaPath")} value={selectedFolder.path} />
            <DetailRow
              label={t("libraryMetaUpdatedAt")}
              value={formatDateTime(selectedFolder.updatedAt)}
            />
            <DetailRow
              label={t("libraryMetaKind")}
              value={t("libraryFinderKindFolder")}
            />
            <DetailRow
              label={t("libraryMetaTags")}
              value={t("libraryCountDocuments", {
                count: selectedFolder.documentCount,
              })}
            />
          </section>
        </div>
      ) : selected ? (
        <div className="affairs-detail-scroll">
          <section className="affairs-detail-block affairs-detail-summary-block">
            <span className="affairs-detail-eyebrow">
              {t("libraryDetails")}
            </span>
            <div className="affairs-detail-title-block">
              <div className="affairs-doc-icon detail-doc-icon">
                {renderDocumentShape(selected.path, "row")}
              </div>
              <h2>{resolveLibraryDocumentDisplayName(selected)}</h2>
              <LibraryDetailSummary summary={selected.summary} />
            </div>
            <DetailPathRow
              path={selected.path}
              onSelectFolder={library.selectFolder}
            />
            <DetailRow
              label={t("libraryMetaSize")}
              value={formatBytes(selected.sizeBytes)}
            />
            <DetailRow
              label={t("libraryMetaCreatedAt")}
              value={formatDateTime(selected.createdAt)}
            />
            <DetailRow
              label={t("libraryMetaUpdatedAt")}
              value={formatDateTime(selected.updatedAt)}
            />
            {selectedLocalPath ? (
              <DetailRow
                label={t("libraryMetaLocalPath")}
                value={selectedLocalPath}
              />
            ) : null}
          </section>

          <section className="affairs-detail-block">
            <div className="affairs-detail-headline">
              <h3>{t("libraryMetaTags")}</h3>
              <p>{t("libraryTagRecommend")}</p>
            </div>
            <TagPills items={[...selected.tags, ...selected.derivedTags]} />
            <button
              type="button"
              className="secondary-button"
              onClick={() =>
                onRequestTagAssignment({ kind: "document", entry: selected })
              }
            >
              {t("libraryEditTags")}
            </button>
          </section>

          <section className="affairs-detail-block">
            <div className="affairs-detail-actions-grid">
              <button
                type="button"
                className="secondary-button"
                onClick={() => void library.openPreview(selected.path)}
              >
                {t("libraryPreview")}
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={() => void library.downloadSelected(selected.path)}
              >
                {t("libraryDownload")}
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={() => onRequestRename(selected.path)}
              >
                {t("libraryRename")}
              </button>
              {selectedLocalPath ? (
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => void openPathInDesktop(selectedLocalPath)}
                >
                  {t("libraryContextOpenLocalApp")}
                </button>
              ) : null}
              <button
                type="button"
                className="danger-button"
                onClick={() =>
                  onRequestDelete({ kind: "document", entry: selected })
                }
              >
                {t("libraryDelete")}
              </button>
            </div>
          </section>

          <section className="affairs-detail-block affairs-preview-block">
            <div className="affairs-detail-headline">
              <h3>{t("libraryPreview")}</h3>
            </div>
            <PreviewPanel
              preview={preview}
              loading={library.previewLoading}
              error={library.previewError}
            />
          </section>
        </div>
      ) : null}
    </aside>
  );
}

function isLibraryDirectoryEntry(entry: LibraryEntry): entry is LibraryDirectoryEntry {
  return entry.kind === "folder" || entry.kind === "tag-directory";
}

const DETAIL_SUMMARY_COLLAPSE_LENGTH = 96;

function LibraryDetailSummary({ summary }: { summary: string | null | undefined }) {
  const [expanded, setExpanded] = useState(false);
  const normalized = summary?.trim() ?? "";
  if (!normalized) {
    return null;
  }

  const shouldCollapse = normalized.length > DETAIL_SUMMARY_COLLAPSE_LENGTH;
  const visibleSummary = shouldCollapse && !expanded
    ? `${normalized.slice(0, DETAIL_SUMMARY_COLLAPSE_LENGTH)}…`
    : normalized;

  return (
    <div className="affairs-detail-summary">
      <p className="affairs-detail-summary-text">{visibleSummary}</p>
      {shouldCollapse ? (
        <button
          type="button"
          className="affairs-detail-link-button"
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? t("libraryCollapseText") : t("libraryExpandText")}
        </button>
      ) : null}
    </div>
  );
}

function LibraryContextMenu({
  state,
  library,
  libraryClipboard,
  onOpenLibraryViewer,
  onSetClipboard,
  onClose,
  onRequestCreate,
  onRequestRename,
  onRequestDelete,
  onRequestTagAssignment,
}: {
  state: LibraryContextMenuState;
  library: LibraryState;
  libraryClipboard: LibraryClipboardState | null;
  onOpenLibraryViewer: (entry: LibraryDocumentEntry) => void;
  onSetClipboard: (state: LibraryClipboardState | null) => void;
  onClose: () => void;
  onRequestCreate: (state: PendingCreateState) => void;
  onRequestRename: (path: string) => void;
  onRequestDelete: (target: LibraryContextMenuTarget) => void;
  onRequestTagAssignment: (target: LibraryContextMenuTarget) => void;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const submenuCloseTimerRef = useRef<number | null>(null);
  const [activeSubmenu, setActiveSubmenu] = useState<LibrarySubmenuKey | null>(
    null,
  );
  const target = state.target;
  const isDocument = target.kind === "document";
  const isFileSystemTarget =
    target.kind === "document" || target.kind === "folder";
  const isBlankTarget = target.kind === "blank";
  const folderPath = resolvePasteDestinationFolder(target);
  const absolutePath = isFileSystemTarget
    ? resolveTargetAbsolutePath(library, target)
    : null;
  const canPaste = Boolean(libraryClipboard);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const rect = menu.getBoundingClientRect();
    const position = resolveContextMenuPosition(
      { x: state.left, y: state.top },
      { width: rect.width, height: rect.height },
      { width: window.innerWidth, height: window.innerHeight },
    );
    menu.style.left = `${position.left}px`;
    menu.style.top = `${position.top}px`;
    menu.style.width = `${position.width}px`;
    menu.style.maxHeight = `${position.maxHeight}px`;
    menu.style.transformOrigin = position.transformOrigin;
  }, [state.left, state.top, target]);

  useEffect(() => {
    return () => {
      if (submenuCloseTimerRef.current !== null) {
        window.clearTimeout(submenuCloseTimerRef.current);
      }
    };
  }, []);

  function closeSubmenuLater(): void {
    if (submenuCloseTimerRef.current !== null) {
      window.clearTimeout(submenuCloseTimerRef.current);
    }
    submenuCloseTimerRef.current = window.setTimeout(() => {
      setActiveSubmenu(null);
      submenuCloseTimerRef.current = null;
    }, 220);
  }

  function openSubmenu(key: LibrarySubmenuKey): void {
    if (submenuCloseTimerRef.current !== null) {
      window.clearTimeout(submenuCloseTimerRef.current);
      submenuCloseTimerRef.current = null;
    }
    setActiveSubmenu(key);
  }

  async function run(action: () => void | Promise<void>): Promise<void> {
    onClose();
    await action();
  }

  async function pasteIntoTarget(): Promise<void> {
    if (!libraryClipboard) return;
    const sourcePath = resolveContextPath(libraryClipboard.target);
    const destinationPath = buildUniqueLibraryTargetPath(
      folderPath,
      getPathName(sourcePath),
      library.entries,
    );
    await library.operateFile({
      opType: libraryClipboard.mode === "cut" ? "move" : "copy",
      srcPath: sourcePath,
      dstPath: destinationPath,
    });
    if (libraryClipboard.mode === "cut") {
      onSetClipboard(null);
    }
  }

  return (
    <div
      ref={menuRef}
      className="affairs-library-context-menu"
      role="menu"
      aria-label={t("libraryContextMenuLabel")}
      style={{ left: state.left, top: state.top }}
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      {isDocument ? (
        <button
          type="button"
          role="menuitem"
          onClick={() =>
            void run(() => {
              library.selectDocument(target.entry.documentId);
              onOpenLibraryViewer(target.entry);
            })
          }
        >
          {t("libraryContextPreview")}
        </button>
      ) : null}
      {isFileSystemTarget ? (
        <button
          type="button"
          role="menuitem"
          onClick={() => void run(() => openContextTarget(library, target))}
        >
          {t("libraryContextOpen")}
        </button>
      ) : null}
      {isFileSystemTarget ? (
        <button
          type="button"
          role="menuitem"
          onClick={() =>
            void run(() =>
              target.kind === "document"
                ? locateDocumentFolder(library, target.entry.path)
                : library.selectFolder(target.entry.path),
            )
          }
        >
          {t("libraryContextLocate")}
        </button>
      ) : null}
      {isDocument && absolutePath ? (
        <button
          type="button"
          role="menuitem"
          onClick={() =>
            void run(async () => {
              await openPathInDesktop(absolutePath);
            })
          }
        >
          {t("libraryContextOpenLocalApp")}
        </button>
      ) : null}
      {isDocument ? (
        <button
          type="button"
          role="menuitem"
          onClick={() =>
            void run(() => library.downloadSelected(target.entry.path))
          }
        >
          {t("libraryContextDownload")}
        </button>
      ) : null}
      {target.kind === "folder" ? (
        <button
          type="button"
          role="menuitem"
          onClick={() =>
            void run(() => toggleFolderFavorite(library, target.entry))
          }
        >
          {isFolderFavorite(library, target.entry.path)
            ? t("libraryFavoriteRemove")
            : t("libraryFavoriteAddFolder")}
        </button>
      ) : null}
      {isBlankTarget ? (
        <ContextSubmenu
          menuKey="new"
          activeSubmenu={activeSubmenu}
          label={t("libraryContextNew")}
          onOpen={openSubmenu}
          onCloseLater={closeSubmenuLater}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() =>
              void run(() =>
                onRequestCreate({
                  kind: "directory",
                  folderPath,
                  fileName: resolveDefaultCreateName("directory"),
                }),
              )
            }
          >
            {t("libraryContextNewDirectory")}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() =>
              void run(() =>
                onRequestCreate({
                  kind: "markdown",
                  folderPath,
                  fileName: resolveDefaultCreateName("markdown"),
                }),
              )
            }
          >
            {t("libraryContextNewMarkdown")}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() =>
              void run(() =>
                onRequestCreate({
                  kind: "text",
                  folderPath,
                  fileName: resolveDefaultCreateName("text"),
                }),
              )
            }
          >
            {t("libraryContextNewText")}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() =>
              void run(() =>
                onRequestCreate({
                  kind: "custom",
                  folderPath,
                  fileName: resolveDefaultCreateName("custom"),
                }),
              )
            }
          >
            {t("libraryContextNewCustom")}
          </button>
        </ContextSubmenu>
      ) : null}
      {isFileSystemTarget ? (
        <ContextSubmenu
          menuKey="copy"
          activeSubmenu={activeSubmenu}
          label={t("libraryContextCopy")}
          onOpen={openSubmenu}
          onCloseLater={closeSubmenuLater}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() =>
              void run(() => copyContextText(resolveContextPath(target)))
            }
          >
            {t("libraryContextCopyFile")}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() =>
              void run(() => copyContextText(getContextTargetTitle(target)))
            }
          >
            {t("libraryContextCopyFileName")}
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!absolutePath}
            onClick={() => void run(() => copyContextText(absolutePath ?? ""))}
          >
            {t("libraryContextCopyAbsolutePath")}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() =>
              void run(() => copyContextText(resolveContextPath(target)))
            }
          >
            {t("libraryContextCopyRelativePath")}
          </button>
        </ContextSubmenu>
      ) : null}
      {isFileSystemTarget ? (
        <button
          type="button"
          role="menuitem"
          onClick={() =>
            void run(() => onSetClipboard({ mode: "cut", target }))
          }
        >
          {t("libraryContextCut")}
        </button>
      ) : null}
      <button
        type="button"
        role="menuitem"
        disabled={!canPaste}
        onClick={() => void run(pasteIntoTarget)}
      >
        {t("libraryContextPaste")}
      </button>
      {isFileSystemTarget ? (
        <button
          type="button"
          role="menuitem"
          className="danger"
          onClick={() => void run(() => onRequestDelete(target))}
        >
          {t("libraryContextDelete")}
        </button>
      ) : null}
      {isFileSystemTarget ? (
        <button
          type="button"
          role="menuitem"
          onClick={() => void run(() => onRequestTagAssignment(target))}
        >
          {t("libraryContextTags")}
        </button>
      ) : null}
      {isBlankTarget ? (
        <button
          type="button"
          role="menuitem"
          onClick={() => void run(() => library.reloadDocuments(true))}
        >
          {t("libraryContextRefresh")}
        </button>
      ) : null}
      <button
        type="button"
        role="menuitem"
        onClick={() => void run(() => selectContextProperties(library, target))}
      >
        {t("libraryContextProperties")}
      </button>
    </div>
  );
}

function ContextSubmenu({
  menuKey,
  activeSubmenu,
  label,
  children,
  onOpen,
  onCloseLater,
}: {
  menuKey: LibrarySubmenuKey;
  activeSubmenu: LibrarySubmenuKey | null;
  label: string;
  children: ReactNode;
  onOpen: (key: LibrarySubmenuKey) => void;
  onCloseLater: () => void;
}) {
  return (
    <div
      className="affairs-library-context-submenu"
      data-open={activeSubmenu === menuKey ? "true" : undefined}
      onPointerEnter={() => onOpen(menuKey)}
      onPointerLeave={onCloseLater}
    >
      <button
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={activeSubmenu === menuKey}
      >
        <span>{label}</span>
        <span aria-hidden="true">›</span>
      </button>
      <div
        className="affairs-library-context-submenu-panel"
        role="menu"
        onPointerEnter={() => onOpen(menuKey)}
        onPointerLeave={onCloseLater}
      >
        {children}
      </div>
    </div>
  );
}

function LibrarySearchModal({
  library,
  keyword,
  onKeywordChange,
  onOpenDocument,
  onLocateDocument,
  onClose,
}: {
  library: LibraryState;
  keyword: string;
  onKeywordChange: (value: string) => void;
  onOpenDocument: (entry: LibraryDocumentEntry) => void;
  onLocateDocument: (entry: LibraryDocumentEntry) => void;
  onClose: () => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [activeKeyword, setActiveKeyword] = useState("");
  const [resultPage, setResultPage] = useState<LibraryDocumentList | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const searchResults = useMemo(
    () => (resultPage?.items ?? []).map((entry) => ({
      ...entry,
      kind: "document" as const,
    })),
    [resultPage],
  );
  const hasDraftKeyword = keyword.trim().length > 0;
  const showsResults = activeKeyword.length > 0;
  const hasMore = (resultPage?.items.length ?? 0) < (resultPage?.total ?? 0);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  async function runSearch(nextKeyword: string, reset = true): Promise<void> {
    const normalizedKeyword = nextKeyword.trim();
    setActiveKeyword(normalizedKeyword);
    if (!normalizedKeyword) {
      setResultPage(null);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const offset = reset ? 0 : resultPage?.items.length ?? 0;
      const nextPage = await listLibraryDocuments({
        browseMode: library.viewState.browseMode,
        selectedFolderPath: library.viewState.selectedFolderPath,
        selectedTagPath: library.viewState.selectedTagPath,
        selectedTagPaths: library.viewState.selectedTagPaths,
        selectedFavoriteId: library.viewState.selectedFavoriteId,
        keyword: normalizedKeyword,
        offset,
        limit: 60,
      });
      setResultPage((current) => {
        if (reset || !current) {
          return nextPage;
        }
        return {
          ...nextPage,
          items: [...current.items, ...nextPage.items],
          offset: current.offset,
        };
      });
    } catch (err) {
      setError(toApiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  function clearSearch(): void {
    onKeywordChange("");
    setActiveKeyword("");
    setResultPage(null);
    setError(null);
  }

  function handleSubmit(event?: FormEvent): void {
    event?.preventDefault();
    void runSearch(keyword, true);
  }

  return (
    <DesktopModal
      title={t("librarySearchModalTitle")}
      description={t("librarySearchModalDescription")}
      size="regular"
      layout="list"
      className="library-search-modal"
      bodyClassName="library-search-modal-body"
      onClose={onClose}
      footer={
        <ModalActions align="between">
          <span className="library-search-result-count">
            {showsResults
              ? t("librarySearchResultCount", {
                  count: resultPage?.total ?? searchResults.length,
                })
              : t("librarySearchReadyHint")}
          </span>
          <div className="button-row">
            <button type="button" className="secondary-button" onClick={onClose}>
              {t("actionClose")}
            </button>
            {activeKeyword ? (
              <button type="button" className="secondary-button" onClick={clearSearch}>
                {t("librarySearchClear")}
              </button>
            ) : null}
            <button
              type="button"
              className="primary-button"
              disabled={!hasDraftKeyword}
              onClick={() => handleSubmit()}
            >
              {t("librarySearchSubmit")}
            </button>
          </div>
        </ModalActions>
      }
    >
      <form className="library-search-form" onSubmit={handleSubmit}>
        <ModalField label={t("librarySearchKeywordLabel")} htmlFor="library-search-keyword">
          <div className="library-search-input-wrap">
            {renderSearchIcon()}
            <input
              ref={inputRef}
              id="library-search-keyword"
              type="search"
              value={keyword}
              placeholder={t("libraryKeywordPlaceholder")}
              onChange={(event) => onKeywordChange(event.target.value)}
            />
          </div>
        </ModalField>
      </form>
      <div className="library-search-results" role="list">
        {error ? <div className="inline-alert compact">{error}</div> : null}
        {loading && showsResults ? (
          <ModalEmptyState
            compact
            title={t("librarySearchLoading")}
            description={t("librarySearchLoadingDescription")}
          />
        ) : null}
        {!showsResults ? (
          <ModalEmptyState
            compact
            title={t("librarySearchEmptyTitle")}
            description={t("librarySearchEmptyDescription")}
          />
        ) : null}
        {showsResults && !loading && searchResults.length === 0 ? (
          <ModalEmptyState
            compact
            title={t("librarySearchNoResultsTitle")}
            description={t("librarySearchNoResultsDescription", {
              keyword: activeKeyword,
            })}
          />
        ) : null}
        {showsResults && searchResults.length > 0 ? (
          <div className="library-search-result-list">
            {searchResults.map((entry) => (
              <div
                key={entry.documentId}
                className="library-search-result-item"
                role="listitem"
              >
                <button
                  type="button"
                  className="library-search-result-main"
                  onClick={() => onOpenDocument(entry)}
                >
                  <span className="library-search-result-title">
                    {renderHighlightedText(resolveLibraryDocumentDisplayName(entry), activeKeyword)}
                  </span>
                  <span className="library-search-result-path">
                    {renderHighlightedText(entry.path, activeKeyword)}
                  </span>
                  {entry.summary ? (
                    <span className="library-search-result-summary">
                      {renderHighlightedText(entry.summary, activeKeyword)}
                    </span>
                  ) : null}
                </button>
                <div className="library-search-result-side">
                  <ModalTag>{resolveDocumentVisual(entry.path).extension.toUpperCase()}</ModalTag>
                  <button
                    type="button"
                    className="secondary-button library-search-locate-button"
                    onClick={() => onLocateDocument(entry)}
                  >
                    {t("libraryContextLocate")}
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : null}
        {hasMore && showsResults ? (
          <button
            type="button"
            className="secondary-button library-search-load-more"
            disabled={loading}
            onClick={() => void runSearch(activeKeyword, false)}
          >
            {t("libraryLoadMore")}
          </button>
        ) : null}
      </div>
    </DesktopModal>
  );
}

function LibraryCreateModal({
  library,
  state,
  onChange,
  onClose,
}: {
  library: LibraryState;
  state: PendingCreateState;
  onChange: (state: PendingCreateState | null) => void;
  onClose: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileNameInputId = useId();

  async function submit(): Promise<void> {
    const fileName = normalizeCreateFileName(state.fileName, state.kind);
    if (!fileName) {
      setError(t("libraryCreateNameRequired"));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await library.operateFile({
        opType: state.kind === "directory" ? "create_directory" : "create_file",
        dstPath: joinPath(state.folderPath, fileName),
        content:
          state.kind === "directory"
            ? null
            : resolveCreateInitialContent(state.kind),
      });
      onClose();
    } catch (err) {
      setError(toApiErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <DesktopModal
      title={t("libraryCreateModalTitle")}
      description={t("libraryCreateModalDescription", {
        path: state.folderPath || t("libraryRootFolder"),
      })}
      onClose={onClose}
      footer={
        <ModalActions>
          <button
            type="button"
            className="secondary-button"
            disabled={submitting}
            onClick={onClose}
          >
            {t("actionCancel")}
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={submitting}
            onClick={() => void submit()}
          >
            {submitting ? t("settingsSaving") : t("libraryCreateConfirm")}
          </button>
        </ModalActions>
      }
    >
      <ModalField
        label={t("libraryCreateNameLabel")}
        description={resolveCreateKindLabel(state.kind)}
        htmlFor={fileNameInputId}
      >
        <input
          id={fileNameInputId}
          value={state.fileName}
          autoFocus
          placeholder={resolveCreatePlaceholder(state.kind)}
          onChange={(event) =>
            onChange({ ...state, fileName: event.target.value })
          }
          onKeyDown={(event) => {
            if (event.key === "Enter") void submit();
          }}
        />
      </ModalField>
      {error ? (
        <div className="affairs-binding-hint affairs-create-error">{error}</div>
      ) : null}
    </DesktopModal>
  );
}

function LibraryRenameModal({
  library,
  state,
  onChange,
  onClose,
}: {
  library: LibraryState;
  state: PendingRenameState;
  onChange: (state: PendingRenameState | null) => void;
  onClose: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(): Promise<void> {
    const fileName = state.fileName.trim();
    if (!fileName) {
      setError(t("libraryCreateNameRequired"));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await library.operateFile({
        opType: "move",
        srcPath: state.path,
        dstPath: joinPath(getParentPath(state.path), fileName),
      });
      onClose();
    } catch (err) {
      setError(toApiErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <DesktopModal
      title={t("libraryRenameModalTitle")}
      description={state.path}
      onClose={onClose}
      footer={
        <ModalActions>
          <button
            type="button"
            className="secondary-button"
            disabled={submitting}
            onClick={onClose}
          >
            {t("actionCancel")}
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={submitting}
            onClick={() => void submit()}
          >
            {submitting ? t("settingsSaving") : t("libraryRenameConfirm")}
          </button>
        </ModalActions>
      }
    >
      <ModalField label={t("libraryCreateNameLabel")}>
        <input
          value={state.fileName}
          autoFocus
          onChange={(event) =>
            onChange({ ...state, fileName: event.target.value })
          }
          onKeyDown={(event) => {
            if (event.key === "Enter") void submit();
          }}
        />
      </ModalField>
      {error ? (
        <div className="affairs-binding-hint affairs-create-error">{error}</div>
      ) : null}
    </DesktopModal>
  );
}

function LibraryDeleteModal({
  library,
  target,
  onClose,
}: {
  library: LibraryState;
  target: LibraryContextMenuTarget;
  onClose: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const targetPath = resolveContextPath(target);

  async function submit(): Promise<void> {
    setSubmitting(true);
    setError(null);
    try {
      await library.operateFile({ opType: "delete", srcPath: targetPath });
      onClose();
    } catch (err) {
      setError(toApiErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <DesktopModal
      title={t("libraryDeleteModalTitle")}
      description={t("libraryDeleteModalDescription", { path: targetPath })}
      onClose={onClose}
      footer={
        <ModalActions>
          <button
            type="button"
            className="secondary-button"
            disabled={submitting}
            onClick={onClose}
          >
            {t("actionCancel")}
          </button>
          <button
            type="button"
            className="danger-button"
            disabled={submitting}
            onClick={() => void submit()}
          >
            {submitting ? t("settingsSaving") : t("libraryDeleteConfirmAction")}
          </button>
        </ModalActions>
      }
    >
      <ModalEmptyState title={t("libraryDeleteModalWarning")} tone="danger" />
      {error ? (
        <div className="affairs-binding-hint affairs-create-error">{error}</div>
      ) : null}
    </DesktopModal>
  );
}

function LibraryTagAssignmentModal({
  library,
  target,
  onClose,
  onTaskChange,
}: {
  library: LibraryState;
  target: PendingTagAssignmentTarget;
  onClose: () => void;
  onTaskChange: (task: LibraryTagAssignmentTaskState) => void;
}) {
  const [details, setDetails] = useState<
    LibraryDocumentTagDetails | LibraryFolderTagDetails | null
  >(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tagDetails, setTagDetails] = useState<LibraryTagDetailWithRules[]>([]);
  const assignableTags = useMemo(
    () => tagDetails.filter(isAssignableLibraryTag),
    [tagDetails],
  );

  async function refreshDetails(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const [nextDetails, nextTags] = await Promise.all([
        target.kind === "document"
          ? getDocumentTagDetails(target.documentId)
          : getFolderTagDetails(target.folderPath),
        listLibraryTagDetails(true),
      ]);
      setDetails(nextDetails);
      setTagDetails(nextTags);
    } catch (err) {
      setError(toApiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refreshDetails();
  }, [target]);

  async function saveTags(
    nextTagIds: string[],
    createTagPaths: string[] = [],
  ): Promise<void> {
    setError(null);
    const task: LibraryTagAssignmentTaskState = {
      id: `tag-assignment-${Date.now()}`,
      kind: target.kind,
      targetPath: target.kind === "document" ? target.path : target.folderPath,
      status: "running",
      message: null,
    };
    onTaskChange(task);
    try {
      const nextDetails = target.kind === "document"
        ? await saveDocumentTags(target.documentId, {
          tagIds: nextTagIds,
          createTagPaths,
        })
        : await saveFolderTags({
          folderPath: target.folderPath,
          tagIds: nextTagIds,
          createTagPaths,
        });
      setDetails(nextDetails);
      onTaskChange({ ...task, status: "completed" });
      await Promise.all([library.reload(), library.reloadDocuments(true)]);
    } catch (err) {
      const message = toApiErrorMessage(err);
      onTaskChange({ ...task, status: "failed", message });
      throw err;
    }
  }

  const assignedTagIds = details ? resolveAssignedTagIds(details) : [];
  const resolvedTagPaths = details && "resolvedTags" in details
    ? details.resolvedTags.map((item) => item.path)
    : [];

  return (
    <DesktopModal
      title={t("libraryTagAssignmentModalTitle")}
      description={target.kind === "document"
        ? t("libraryTagAssignmentDocumentDescription", { name: target.title })
        : t("libraryTagAssignmentFolderDescription", { name: target.title })}
      onClose={onClose}
      dismissible={!loading}
      footer={
        <ModalActions>
          <button type="button" className="secondary-button" onClick={onClose}>
            {t("actionClose")}
          </button>
        </ModalActions>
      }
    >
      {loading ? (
        <ModalEmptyState title={t("libraryTagAssignmentLoading")} compact />
      ) : null}
      {!loading && details ? (
        <LibraryQuickTagAssignmentEditor
          assignedTagIds={assignedTagIds}
          assignableTags={assignableTags}
          resolvedTagPaths={resolvedTagPaths}
          recommendedTags={details.recommendedTags ?? []}
          emptyText={t("libraryTagAssignmentEmpty")}
          inputLabel={t("libraryTagAssignmentTagsLabel")}
          suggestionsLabel={t("libraryTagAssignmentSuggestionsLabel")}
          onSave={saveTags}
          onSaved={() => void refreshDetails()}
          onError={(message) => setError(message)}
        />
      ) : null}
      {error ? (
        <div className="affairs-binding-hint affairs-create-error">{error}</div>
      ) : null}
    </DesktopModal>
  );
}

function LibraryQuickTagAssignmentEditor({
  assignedTagIds,
  assignableTags,
  resolvedTagPaths = [],
  recommendedTags = [],
  emptyText,
  inputLabel,
  suggestionsLabel,
  onSave,
  onSaved,
  onError,
}: {
  assignedTagIds: string[];
  assignableTags: LibraryTagDetailWithRules[];
  resolvedTagPaths?: string[];
  recommendedTags?: LibraryDocumentTagDetails["recommendedTags"];
  emptyText: string;
  inputLabel: string;
  suggestionsLabel: string;
  onSave: (nextTagIds: string[], createTagPaths?: string[]) => Promise<void>;
  onSaved?: () => void;
  onError?: (message: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [pendingAction, setPendingAction] = useState<"assign" | "create" | "remove" | null>(null);
  const selectedTagIds = useMemo(() => new Set(assignedTagIds), [assignedTagIds]);
  const selectedTags = useMemo(
    () => assignableTags.filter((tag) => selectedTagIds.has(tag.id)),
    [assignableTags, selectedTagIds],
  );
  const visibleTagPaths = useMemo(
    () => compactDocumentTagPaths([
      ...resolvedTagPaths,
      ...selectedTags.map((tag) => tag.path),
    ]),
    [resolvedTagPaths, selectedTags],
  );
  const recommendedVisibleTags = useMemo(() => {
    const assignableTagIdSet = new Set(assignableTags.map((tag) => tag.id));
    return (recommendedTags ?? [])
      .filter((tag) => assignableTagIdSet.has(tag.tagId) && !selectedTagIds.has(tag.tagId))
      .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path, "zh-Hans-CN"))
      .slice(0, 8);
  }, [assignableTags, recommendedTags, selectedTagIds]);
  const selectedTagByPath = useMemo(() => {
    const map = new Map<string, LibraryTagDetailWithRules>();
    selectedTags.forEach((tag) => map.set(tag.path, tag));
    return map;
  }, [selectedTags]);
  const normalizedQuery = normalizeTagPathInput(query);
  const normalizedQueryLower = normalizedQuery.toLowerCase();
  const matchedTags = useMemo(() => {
    if (!normalizedQueryLower) {
      return [];
    }
    return assignableTags
      .filter((tag) => !selectedTagIds.has(tag.id))
      .filter((tag) => {
        const searchable = `${tag.path} ${tag.name}`.toLowerCase();
        return searchable.includes(normalizedQueryLower);
      })
      .slice(0, 8);
  }, [assignableTags, normalizedQueryLower, selectedTagIds]);
  const exactMatchedTag = useMemo(
    () => assignableTags.find((tag) => tag.path.toLowerCase() === normalizedQueryLower) ?? null,
    [assignableTags, normalizedQueryLower],
  );
  const canCreateTag = normalizedQuery.length > 0 && !exactMatchedTag;

  const commitSelection = async (
    nextTagIds: string[],
    createTagPaths: string[] = [],
    action: "assign" | "create" | "remove" = createTagPaths.length > 0 ? "create" : "assign",
  ) => {
    setSubmitting(true);
    setPendingAction(action);
    onError?.("");
    try {
      await onSave(uniqueStringList(nextTagIds), createTagPaths);
      setQuery("");
      onSaved?.();
    } catch (err) {
      onError?.(toApiErrorMessage(err));
    } finally {
      setSubmitting(false);
      setPendingAction(null);
    }
  };

  const handleSubmitQuery = async () => {
    if (!normalizedQuery) {
      return;
    }
    if (exactMatchedTag) {
      const exactId = exactMatchedTag.id;
      if (selectedTagIds.has(exactId)) {
        setQuery("");
        return;
      }
      await commitSelection([...assignedTagIds, exactId], [], "assign");
      return;
    }
    await commitSelection([...assignedTagIds], [normalizedQuery], "create");
  };
  const pendingStatusText = pendingAction === "create"
    ? t("libraryTagQuickCreateSubmitting")
    : pendingAction === "remove"
      ? t("libraryTagQuickRemoveSubmitting")
      : pendingAction === "assign"
        ? t("libraryTagQuickAssignSubmitting")
        : null;

  return (
    <div className="affairs-document-tag-editor">
      {pendingStatusText ? (
        <div className="affairs-document-tag-submit-status" role="status" aria-live="polite">
          <span className="affairs-document-tag-submit-spinner" aria-hidden="true" />
          <span>{pendingStatusText}</span>
        </div>
      ) : null}
      <div className="affairs-document-tag-list">
        {visibleTagPaths.length === 0 ? (
          <span className="affairs-binding-hint">{emptyText}</span>
        ) : visibleTagPaths.map((tagPath) => {
          const manualTag = selectedTagByPath.get(tagPath);
          if (!manualTag) {
            return <LibraryColorTag key={tagPath} label={tagPath} path={tagPath} />;
          }
          const manualTagId = manualTag.id;
          return (
            <button
              key={manualTagId}
              type="button"
              className="affairs-document-tag-token"
              aria-label={t("libraryDocumentTagRemoveAction", { tag: manualTag.path })}
              disabled={submitting}
              onClick={() => {
                void commitSelection(assignedTagIds.filter((item) => item !== manualTagId), [], "remove");
              }}
            >
              <LibraryColorTag label={manualTag.path} path={manualTag.path} />
              <span aria-hidden="true">×</span>
            </button>
          );
        })}
      </div>
      {recommendedVisibleTags.length > 0 ? (
        <div className="affairs-document-tag-recommendations" aria-label={t("libraryTagAssignmentRecommendations")}>
          <span className="affairs-document-tag-recommendations-title">{t("libraryTagAssignmentRecommendations")}</span>
          <div className="affairs-document-tag-recommendation-list">
            {recommendedVisibleTags.map((tag) => (
              <button
                key={tag.tagId}
                type="button"
                className="affairs-document-tag-recommendation"
                disabled={submitting}
                aria-label={t("libraryTagRecommendationAssignAction", { tag: tag.path })}
                title={tag.evidence}
                onClick={() => {
                  void commitSelection([...assignedTagIds, tag.tagId], [], "assign");
                }}
              >
                <LibraryColorTag label={tag.path} path={tag.path} variant="recommended" />
                <span className="affairs-document-tag-recommendation-reason">
                  {resolveTagRecommendationReasonLabel(tag.reason)}
                </span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
      <div className="affairs-document-tag-picker">
        <label className="affairs-document-tag-input-label">
          <span>{inputLabel}</span>
          <input
            value={query}
            autoFocus
            disabled={submitting}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void handleSubmitQuery();
              }
            }}
            placeholder={t("libraryTagQuickSearchPlaceholder")}
          />
        </label>
        {normalizedQuery ? (
          <div className="affairs-document-tag-suggestions" role="listbox" aria-label={suggestionsLabel}>
            {matchedTags.map((tag) => {
              const tagId = tag.id;
              return (
                <button
                  key={tagId}
                  type="button"
                  className="affairs-document-tag-suggestion"
                  disabled={submitting}
                  onClick={() => {
                    void commitSelection([...assignedTagIds, tagId], [], "assign");
                  }}
                >
                  <LibraryColorTag label={tag.path} path={tag.path} />
                </button>
              );
            })}
            {canCreateTag ? (
              <button
                type="button"
                className="affairs-document-tag-suggestion affairs-document-tag-create-suggestion"
                disabled={submitting}
                onClick={() => {
                  void commitSelection([...assignedTagIds], [normalizedQuery], "create");
                }}
              >
                <span className="affairs-document-tag-create-label">{t("libraryTagQuickCreateAction", { tag: normalizedQuery })}</span>
                <span className="affairs-binding-hint">{t("libraryTagQuickCreateHint")}</span>
              </button>
            ) : null}
            {matchedTags.length === 0 && !canCreateTag ? (
              <span className="affairs-binding-hint">{t("libraryTagQuickAlreadyAssigned")}</span>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function LibraryColorTag({
  label,
  path,
  variant = "assigned",
}: {
  label: string;
  path: string;
  variant?: "assigned" | "recommended";
}) {
  return (
    <span
      className={`affairs-color-tag ${variant === "recommended" ? "recommended" : "assigned"}`}
      style={buildTagColorStyle(path)}
    >
      {label}
    </span>
  );
}

function resolveTagRecommendationReasonLabel(
  reason: NonNullable<LibraryDocumentTagDetails["recommendedTags"]>[number]["reason"],
): string {
  switch (reason) {
    case "name_match":
      return t("libraryTagRecommendationReasonName");
    case "folder_context":
      return t("libraryTagRecommendationReasonFolder");
    case "smart_rule":
      return t("libraryTagRecommendationReasonRule");
    case "time_pattern":
      return t("libraryTagRecommendationReasonTime");
  }
}

type EditableLibraryTagRule = LibraryTagRule;

function createEditableLibraryTagRule(
  priority: number,
): EditableLibraryTagRule {
  return {
    id: `draft-rule-${priority}-${Math.random().toString(36).slice(2, 8)}`,
    relation: "and",
    ruleType: "file_name_contains",
    matcher: { keyword: "" },
    enabled: true,
    priority,
  };
}

function cloneLibraryTagRules(
  rules: LibraryTagRule[],
): EditableLibraryTagRule[] {
  return rules
    .map((rule, index) => ({
      ...rule,
      matcher: { ...rule.matcher },
      priority: Number.isFinite(rule.priority) ? rule.priority : index,
    }))
    .sort((left, right) => left.priority - right.priority);
}

function normalizeLibraryTagRuleMatcher(
  rule: EditableLibraryTagRule,
): Record<string, unknown> {
  switch (rule.ruleType) {
    case "file_name_contains":
    case "file_content_contains":
      return {
        keyword: String(
          (rule.matcher as { keyword?: string }).keyword ?? "",
        ).trim(),
      };
    case "file_extension_in": {
      const rawValue = Array.isArray(
        (rule.matcher as { extensions?: string[] }).extensions,
      )
        ? ((rule.matcher as { extensions?: string[] }).extensions ?? []).join(
            ", ",
          )
        : String(
            (rule.matcher as { extensionsText?: string }).extensionsText ?? "",
          );
      return {
        extensions: rawValue
          .split(/[，,\n]/g)
          .map((item) => item.trim().toLowerCase())
          .filter(Boolean)
          .map((item) => (item.startsWith(".") ? item : `.${item}`)),
      };
    }
    case "modified_time_between": {
      const matcher = rule.matcher as {
        start?: string | null;
        end?: string | null;
      };
      return {
        start: matcher.start?.trim() || null,
        end: matcher.end?.trim() || null,
      };
    }
    case "document_path_in_folder":
      return {
        folderPath:
          String(
            (rule.matcher as { folderPath?: string | null }).folderPath ?? "",
          ).trim() || ".",
      };
  }
}

function buildDefaultLibraryTagRuleMatcher(
  ruleType: LibraryTagRule["ruleType"],
): Record<string, unknown> {
  switch (ruleType) {
    case "file_name_contains":
    case "file_content_contains":
      return { keyword: "" };
    case "file_extension_in":
      return { extensions: [] };
    case "modified_time_between":
      return { start: "", end: "" };
    case "document_path_in_folder":
      return { folderPath: "." };
  }
}

function resolveLibraryTagRuleRelationLabel(
  relation: LibraryTagRule["relation"],
): string {
  switch (relation) {
    case "and":
      return t("libraryTagSmartRuleRelationAnd");
    case "or":
      return t("libraryTagSmartRuleRelationOr");
    case "not":
      return t("libraryTagSmartRuleRelationNot");
  }
}

function resolveLibraryTagRuleTypeLabel(
  ruleType: LibraryTagRule["ruleType"],
): string {
  switch (ruleType) {
    case "file_name_contains":
      return t("libraryTagSmartRuleTypeFileNameContains");
    case "file_content_contains":
      return t("libraryTagSmartRuleTypeFileContentContains");
    case "file_extension_in":
      return t("libraryTagSmartRuleTypeFileExtensionIn");
    case "modified_time_between":
      return t("libraryTagSmartRuleTypeModifiedTimeBetween");
    case "document_path_in_folder":
      return t("libraryTagSmartRuleTypeDocumentPathInFolder");
  }
}

function formatLibraryTagRecomputeTask(task: {
  state: "queued" | "running" | "failed" | "fresh" | "queue_timeout";
  runningStage: string | null;
  errorSummary: string | null;
  completedAt: string | null;
}): string {
  if (task.state === "failed" || task.state === "queue_timeout") {
    return task.errorSummary || t("libraryTagRecoveryFailed");
  }
  if (task.state === "fresh") {
    return task.completedAt
      ? t("libraryTagRecoveryCompletedAt", {
          time: formatDateTime(task.completedAt),
        })
      : t("libraryTagRecoveryCompleted");
  }
  if (task.state === "running") {
    return task.runningStage || t("libraryTagRecoveryRunningAction");
  }
  return t("libraryTagRecoveryQueued");
}

/* ── 标签管理模态框 ── 迁移自 CodingNS AffairsTagManagementModal ── */

type TagManagementEditorMode = "create-root" | "create-child" | "edit";

interface ManagedTagTreeNode {
  tag: LibraryTagDetailWithRules;
  children: ManagedTagTreeNode[];
}

function buildManagedTagTree(tags: LibraryTagDetailWithRules[]): ManagedTagTreeNode[] {
  const map = new Map<string, ManagedTagTreeNode>();
  const roots: ManagedTagTreeNode[] = [];
  for (const tag of tags) {
    map.set(tag.id, { tag, children: [] });
  }
  for (const tag of tags) {
    const node = map.get(tag.id)!;
    if (tag.parentId && map.has(tag.parentId)) {
      map.get(tag.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

function flattenManagedTagTree(nodes: ManagedTagTreeNode[], depth = 0): Array<{ tag: LibraryTagDetailWithRules; depth: number }> {
  const result: Array<{ tag: LibraryTagDetailWithRules; depth: number }> = [];
  for (const node of nodes) {
    result.push({ tag: node.tag, depth });
    result.push(...flattenManagedTagTree(node.children, depth + 1));
  }
  return result;
}

function isSelectableParentTag(tag: LibraryTagDetailWithRules, selected: LibraryTagDetailWithRules | null): boolean {
  if (!selected) return true;
  if (tag.id === selected.id) return false;
  if (isTagDescendant([tag], selected.id, tag.id)) return false;
  return !isTagDescendant([selected], tag.id, selected.id);
}

function LibraryTagManagerModal({
  library,
  onClose,
}: {
  library: LibraryState;
  onClose: () => void;
}) {
  const [tags, setTags] = useState<LibraryTagDetailWithRules[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editorMode, setEditorMode] = useState<TagManagementEditorMode>("create-root");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [parentId, setParentId] = useState<string>("");
  const [status, setStatus] = useState<"active" | "disabled">("active");
  const [smartRules, setSmartRules] = useState<EditableLibraryTagRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [recomputing, setRecomputing] = useState(false);
  const [recomputeMessage, setRecomputeMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selectedEditableTag = tags.find((tag) => tag.id === selectedId) ?? null;
  const visibleTags = tags.filter((tag) => tag.status !== "disabled" || tag.id === selectedId);
  const treeNodes = useMemo(() => buildManagedTagTree(visibleTags), [visibleTags]);
  const flattenedTags = useMemo(() => flattenManagedTagTree(treeNodes), [treeNodes]);
  const parentOptions = useMemo(
    () => flattenedTags.filter(({ tag }) => isSelectableParentTag(tag, selectedEditableTag)),
    [flattenedTags, selectedEditableTag],
  );

  const currentEditTagId = editorMode === "edit" ? selectedEditableTag?.id ?? null : null;
  const currentTagDocumentCount = selectedEditableTag?.documentCount ?? 0;
  const normalizedSmartRules = smartRules.map((rule, index) => ({
    ...rule,
    priority: index,
    matcher: normalizeLibraryTagRuleMatcher(rule),
  }));

  async function loadTags(nextSelectedId = selectedId): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const items = await listLibraryTagDetails(true);
      setTags(items);
      const nextSelected =
        items.find((tag) => tag.id === nextSelectedId) ?? items[0] ?? null;
      applySelectedTag(nextSelected);
    } catch (err) {
      setError(toApiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  function applySelectedTag(tag: LibraryTagDetailWithRules | null): void {
    setSelectedId(tag?.id ?? null);
    setName(tag?.name ?? "");
    setDescription(tag?.description ?? "");
    setParentId(tag?.parentId ?? "");
    setStatus(tag?.status ?? "active");
    setSmartRules(cloneLibraryTagRules(tag?.smartRules ?? []));
  }

  const resetEditor = (nextMode: TagManagementEditorMode, parentTag?: LibraryTagDetailWithRules | null) => {
    setEditorMode(nextMode);
    setError(null);
    setName("");
    setDescription("");
    setParentId(nextMode === "create-child" ? parentTag?.id ?? "" : "");
    setStatus("active");
    setSmartRules([]);
  };

  const beginCreateRoot = () => {
    resetEditor("create-root");
  };

  const beginCreateChild = () => {
    if (!selectedEditableTag) return;
    resetEditor("create-child", selectedEditableTag);
  };

  const reloadEditorFromSelected = () => {
    if (!selectedEditableTag) {
      beginCreateRoot();
      return;
    }
    setEditorMode("edit");
    setName(selectedEditableTag.name);
    setDescription(selectedEditableTag.description ?? "");
    setParentId(selectedEditableTag.parentId ?? "");
    setStatus(selectedEditableTag.status);
    setSmartRules(cloneLibraryTagRules(selectedEditableTag.smartRules ?? []));
    setError(null);
  };

  useEffect(() => {
    void loadTags(null);
  }, []);

  // 自动切换编辑模式：有选中标签 → edit，无选中 → create-root
  useEffect(() => {
    if (selectedEditableTag) {
      setEditorMode("edit");
    } else if (!loading) {
      setEditorMode("create-root");
    }
  }, [selectedEditableTag, loading]);

  // 轮询恢复任务状态
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function poll(): Promise<void> {
      try {
        const task = await getLibraryTagRecomputeTask();
        if (cancelled) return;
        if (!task) {
          setRecomputeMessage(null);
          setRecomputing(false);
          return;
        }
        const isRunning = task.state === "queued" || task.state === "running";
        setRecomputing(isRunning);
        setRecomputeMessage(formatLibraryTagRecomputeTask(task));
        if (isRunning) {
          timer = setTimeout(() => void poll(), 1200);
        }
      } catch (err) {
        if (!cancelled) {
          setRecomputeMessage(toApiErrorMessage(err));
          setRecomputing(false);
        }
      }
    }

    void poll();
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [recomputing]);

  async function createRootTag(): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      const tag = await createLibraryTag({
        name: buildUniqueTagDraftName(tags, t("libraryTagNewName")),
        parentId: null,
        description: null,
        status: "active",
        smartRules: [],
      });
      await loadTags(tag.id);
    } catch (err) {
      setError(toApiErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function createChildTag(): Promise<void> {
    if (!selectedEditableTag) return;
    setSaving(true);
    setError(null);
    try {
      const tag = await createLibraryTag({
        name: buildUniqueTagDraftName(tags, t("libraryTagNewChildName")),
        parentId: selectedEditableTag.id,
        description: null,
        status: "active",
        smartRules: [],
      });
      await loadTags(tag.id);
    } catch (err) {
      setError(toApiErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function saveSelected(): Promise<void> {
    if (!selectedEditableTag) return;
    setSaving(true);
    setError(null);
    try {
      const tag = await updateLibraryTag(selectedEditableTag.id, {
        name,
        parentId: parentId || null,
        description: description.trim() || null,
        status,
        smartRules: normalizedSmartRules,
      });
      await loadTags(tag.id);
      await library.reload();
      await library.reloadDocuments(true);
    } catch (err) {
      setError(toApiErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function deleteSelected(): Promise<void> {
    if (
      !selectedEditableTag ||
      !window.confirm(t("libraryTagDeleteConfirm", { tag: selectedEditableTag.path }))
    ) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await deleteLibraryTag(selectedEditableTag.id);
      beginCreateRoot();
      await loadTags(null);
      await library.reload();
      await library.reloadDocuments(true);
    } catch (err) {
      setError(toApiErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function requestRecompute(): Promise<void> {
    setRecomputing(true);
    setError(null);
    try {
      const result = await requestLibraryTagRecompute();
      setRecomputeMessage(
        result.deduped
          ? t("libraryTagRecoveryQueuedDescription")
          : t("libraryTagRecoveryStartedDescription"),
      );
      await library.reload();
      await library.reloadDocuments(true);
    } catch (err) {
      setError(toApiErrorMessage(err));
    } finally {
      const task = await getLibraryTagRecomputeTask().catch(() => null);
      setRecomputing(task?.state === "queued" || task?.state === "running");
      setRecomputeMessage(task ? formatLibraryTagRecomputeTask(task) : null);
    }
  }

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      if (editorMode === "edit" && selectedEditableTag) {
        await updateLibraryTag(selectedEditableTag.id, {
          name: name.trim(),
          parentId: parentId || null,
          description: description.trim() || null,
          status,
          smartRules: normalizedSmartRules,
        });
      } else if (editorMode === "create-root") {
        await createLibraryTag({
          name: name.trim() || buildUniqueTagDraftName(tags, t("libraryTagNewName")),
          parentId: null,
          description: description.trim() || null,
          status,
          smartRules: normalizedSmartRules,
        });
      } else if (editorMode === "create-child") {
        await createLibraryTag({
          name: name.trim() || buildUniqueTagDraftName(tags, t("libraryTagNewChildName")),
          parentId: (selectedEditableTag?.id ?? parentId) || null,
          description: description.trim() || null,
          status,
          smartRules: normalizedSmartRules,
        });
      }
      if (editorMode === "edit") {
        await loadTags(selectedEditableTag?.id ?? null);
      } else {
        await loadTags(null);
      }
      await library.reload();
      await library.reloadDocuments(true);
    } catch (err) {
      setError(toApiErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const editorTitle = editorMode === "edit"
    ? t("libraryTagEditorEditTitle")
    : editorMode === "create-child"
      ? t("libraryTagNewChildName")
      : t("libraryTagCreateRootAction");

  const saveActionLabel = editorMode === "edit"
    ? t("libraryTagSaveAction")
    : t("libraryTagCreateRootAction");

  const content = (
    <div className="affairs-library-settings-form affairs-tag-management-shell">
      <div className="affairs-tag-management-layout">
        <ModalSection
          className="affairs-tag-management-tree-panel"
          heading={t("libraryTagTreeSectionTitle")}
        >
          <div className="affairs-tag-management-toolbar">
            <button
              type="button"
              className="secondary-button"
              disabled={saving}
              onClick={() => void createRootTag()}
            >
              {t("libraryTagCreateRootAction")}
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={saving || !selectedEditableTag}
              onClick={() => void createChildTag()}
            >
              {t("libraryTagCreateChildAction")}
            </button>
          </div>
          {loading ? (
            <ModalEmptyState title={t("libraryTagManagerLoading")} compact />
          ) : null}
          {!loading && tags.length === 0 ? (
            <ModalEmptyState
              compact
              title={t("libraryTagTreeEmpty")}
            />
          ) : null}
          {!loading && treeNodes.length > 0 ? (
            <div className="affairs-tag-management-tree" role="tree" aria-label={t("libraryTagTreeSectionTitle")}>
              <LibraryTagManagementTreeNodes
                nodes={treeNodes}
                selectedTagId={currentEditTagId}
                onSelect={(tagId) => {
                  const tag = tags.find((t) => t.id === tagId) ?? null;
                  if (tag) {
                    setSelectedId(tag.id);
                    setEditorMode("edit");
                    setName(tag.name);
                    setDescription(tag.description ?? "");
                    setParentId(tag.parentId ?? "");
                    setStatus(tag.status);
                    setSmartRules(cloneLibraryTagRules(tag.smartRules ?? []));
                    setError(null);
                  }
                }}
              />
            </div>
          ) : null}
        </ModalSection>

        <div className="affairs-tag-management-editor-column">
          <ModalSection
            className="affairs-tag-management-editor"
            heading={editorTitle}
          >
            {editorMode === "edit" && selectedEditableTag ? (
              <div className="affairs-tag-management-editor-summary">
                <div className="affairs-tag-management-editor-summary-item">
                  <span className="affairs-tag-management-editor-summary-label">路径</span>
                  <strong className="affairs-tag-management-editor-summary-value">{selectedEditableTag.path}</strong>
                </div>
                <div className="affairs-tag-management-editor-summary-item">
                  <span className="affairs-tag-management-editor-summary-label">{t("libraryTagDocumentCountLabel")}</span>
                  <strong className="affairs-tag-management-editor-summary-value">{currentTagDocumentCount}</strong>
                </div>
              </div>
            ) : null}
            <ModalField label={t("libraryTagNameLabel")}>
              <input
                className="affairs-tag-name-input"
                aria-label={t("libraryTagNameLabel")}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={t("libraryTagNameLabel")}
              />
            </ModalField>
            {editorMode === "edit" ? (
              <ModalField label={t("libraryTagParentLabel")}>
                <select
                  className="affairs-tag-parent-select"
                  aria-label={t("libraryTagParentLabel")}
                  value={parentId}
                  onChange={(event) => setParentId(event.target.value)}
                >
                  <option value="">{t("libraryTagParentRootOption")}</option>
                  {parentOptions.map(({ tag, depth }) => (
                    <option key={tag.id} value={tag.id}>
                      {`${"　".repeat(depth)}${tag.path}`}
                    </option>
                  ))}
                </select>
              </ModalField>
            ) : null}
          </ModalSection>

          <ModalSection
            className="affairs-tag-management-editor"
            heading={t("libraryTagSmartRulesSectionTitle")}
          >
            {smartRules.length === 0 ? (
              <div className="affairs-tag-management-empty-note">{t("libraryTagSmartRulesEmpty")}</div>
            ) : (
              <div className="affairs-tag-smart-rule-list">
                {smartRules.map((rule, index) => (
                  <div key={rule.id} className="affairs-tag-smart-rule-card">
                    <div className="affairs-tag-smart-rule-header">
                      <strong className="affairs-tag-smart-rule-title">
                        {t("libraryTagSmartRuleOrderHint", { index: index + 1 })}
                      </strong>
                      <div className="affairs-tag-smart-rule-header-actions">
                        <label className="affairs-tag-smart-rule-toggle" data-disabled={saving ? "true" : undefined}>
                          <span className="affairs-tag-smart-rule-toggle-switch">
                            <input
                              className="affairs-tag-smart-rule-toggle-input"
                              type="checkbox"
                              checked={rule.enabled !== false}
                              disabled={saving}
                              onChange={(event) => {
                                const enabled = event.target.checked;
                                setSmartRules((current) =>
                                  current.map((item) =>
                                    item.id === rule.id ? { ...item, enabled } : item,
                                  ),
                                );
                              }}
                            />
                            <span className="affairs-tag-smart-rule-toggle-track" aria-hidden="true">
                              <span className="affairs-tag-smart-rule-toggle-thumb" />
                            </span>
                          </span>
                          <span className="affairs-tag-smart-rule-toggle-label">{t("libraryTagSmartRuleEnabledLabel")}</span>
                        </label>
                        <button
                          type="button"
                          className="secondary-button"
                          disabled={saving}
                          onClick={() =>
                            setSmartRules((current) =>
                              current
                                .filter((item) => item.id !== rule.id)
                                .map((item, currentIndex) => ({
                                  ...item,
                                  priority: currentIndex,
                                })),
                            )
                          }
                        >
                          {t("libraryTagSmartRuleRemoveAction")}
                        </button>
                      </div>
                    </div>
                    <div className="affairs-tag-smart-rule-top-row">
                      <ModalField label={t("libraryTagSmartRuleRelationLabel")} className="affairs-tag-smart-rule-field">
                        <select
                          className="affairs-tag-smart-rule-relation-select"
                          aria-label={t("libraryTagSmartRuleRelationLabel")}
                          value={rule.relation}
                          disabled={saving}
                          onChange={(event) => {
                            const relation = event.target.value as LibraryTagRule["relation"];
                            setSmartRules((current) =>
                              current.map((item) =>
                                item.id === rule.id ? { ...item, relation } : item,
                              ),
                            );
                          }}
                        >
                          {(["and", "or", "not"] as const).map((relation) => (
                            <option key={relation} value={relation}>
                              {resolveLibraryTagRuleRelationLabel(relation)}
                            </option>
                          ))}
                        </select>
                      </ModalField>
                      <ModalField label={t("libraryTagSmartRuleTypeLabel")} className="affairs-tag-smart-rule-field">
                        <select
                          className="affairs-tag-smart-rule-type-select"
                          aria-label={t("libraryTagSmartRuleTypeLabel")}
                          value={rule.ruleType}
                          disabled={saving}
                          onChange={(event) => {
                            const ruleType = event.target.value as LibraryTagRule["ruleType"];
                            setSmartRules((current) =>
                              current.map((item) =>
                                item.id === rule.id
                                  ? { ...item, ruleType, matcher: buildDefaultLibraryTagRuleMatcher(ruleType) }
                                  : item,
                              ),
                            );
                          }}
                        >
                          {(
                            [
                              "file_name_contains",
                              "file_content_contains",
                              "file_extension_in",
                              "modified_time_between",
                              "document_path_in_folder",
                            ] as const
                          ).map((ruleType) => (
                            <option key={ruleType} value={ruleType}>
                              {resolveLibraryTagRuleTypeLabel(ruleType)}
                            </option>
                          ))}
                        </select>
                      </ModalField>
                    </div>
                    <div className="affairs-tag-smart-rule-value-row">
                      {rule.ruleType === "file_name_contains" ||
                      rule.ruleType === "file_content_contains" ? (
                        <ModalField label={t("libraryTagSmartRuleKeywordLabel")} className="affairs-tag-smart-rule-field">
                          <input
                            aria-label={t("libraryTagSmartRuleKeywordLabel")}
                            value={String(
                              (rule.matcher as { keyword?: string }).keyword ?? "",
                            )}
                            disabled={saving}
                            placeholder={t("libraryTagSmartRuleKeywordPlaceholder")}
                            onChange={(event) => {
                              const keyword = event.target.value;
                              setSmartRules((current) =>
                                current.map((item) =>
                                  item.id === rule.id
                                    ? { ...item, matcher: { keyword } }
                                    : item,
                                ),
                              );
                            }}
                          />
                        </ModalField>
                      ) : null}
                      {rule.ruleType === "file_extension_in" ? (
                        <ModalField label={t("libraryTagSmartRuleExtensionsLabel")} className="affairs-tag-smart-rule-field">
                          <input
                            aria-label={t("libraryTagSmartRuleExtensionsLabel")}
                            value={
                              Array.isArray(
                                (rule.matcher as { extensions?: string[] }).extensions,
                              )
                                ? (
                                    (rule.matcher as { extensions?: string[] }).extensions ?? []
                                  ).join(", ")
                                : ""
                            }
                            disabled={saving}
                            placeholder={t("libraryTagSmartRuleExtensionsPlaceholder")}
                            onChange={(event) => {
                              const extensions = event.target.value
                                .split(/[，,\n]/g)
                                .map((item) => item.trim())
                                .filter(Boolean);
                              setSmartRules((current) =>
                                current.map((item) =>
                                  item.id === rule.id
                                    ? { ...item, matcher: { extensions } }
                                    : item,
                                ),
                              );
                            }}
                          />
                        </ModalField>
                      ) : null}
                      {rule.ruleType === "modified_time_between" ? (
                        <>
                          <ModalField label={t("libraryTagSmartRuleModifiedStartLabel")} className="affairs-tag-smart-rule-field">
                            <input
                              type="datetime-local"
                              aria-label={t("libraryTagSmartRuleModifiedStartLabel")}
                              value={String(
                                (rule.matcher as { start?: string }).start ?? "",
                              )}
                              disabled={saving}
                              onChange={(event) => {
                                const start = event.target.value;
                                setSmartRules((current) =>
                                  current.map((item) =>
                                    item.id === rule.id
                                      ? {
                                          ...item,
                                          matcher: {
                                            ...(item.matcher as Record<string, unknown>),
                                            start,
                                          },
                                        }
                                      : item,
                                  ),
                                );
                              }}
                            />
                          </ModalField>
                          <ModalField label={t("libraryTagSmartRuleModifiedEndLabel")} className="affairs-tag-smart-rule-field">
                            <input
                              type="datetime-local"
                              aria-label={t("libraryTagSmartRuleModifiedEndLabel")}
                              value={String(
                                (rule.matcher as { end?: string }).end ?? "",
                              )}
                              disabled={saving}
                              onChange={(event) => {
                                const end = event.target.value;
                                setSmartRules((current) =>
                                  current.map((item) =>
                                    item.id === rule.id
                                      ? {
                                          ...item,
                                          matcher: {
                                            ...(item.matcher as Record<string, unknown>),
                                            end,
                                          },
                                        }
                                      : item,
                                  ),
                                );
                              }}
                            />
                          </ModalField>
                        </>
                      ) : null}
                      {rule.ruleType === "document_path_in_folder" ? (
                        <ModalField label={t("libraryTagSmartRuleFolderPathLabel")} className="affairs-tag-smart-rule-field">
                          <input
                            aria-label={t("libraryTagSmartRuleFolderPathLabel")}
                            value={String(
                              (rule.matcher as { folderPath?: string | null }).folderPath ?? ".",
                            )}
                            disabled={saving}
                            placeholder={t("libraryTagSmartRuleFolderPathPlaceholder")}
                            onChange={(event) => {
                              const folderPath = event.target.value;
                              setSmartRules((current) =>
                                current.map((item) =>
                                  item.id === rule.id
                                    ? { ...item, matcher: { folderPath } }
                                    : item,
                                ),
                              );
                            }}
                          />
                        </ModalField>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            )}
            <button
              type="button"
              className="secondary-button"
              disabled={saving}
              onClick={() => {
                setSmartRules((current) => [
                  ...current,
                  createEditableLibraryTagRule(current.length),
                ]);
              }}
            >
              {t("libraryTagSmartRuleAddAction")}
            </button>
          </ModalSection>

          <ModalSection
            className="affairs-tag-management-editor"
            heading={t("libraryTagRecoverySectionTitle")}
            description={t("libraryTagRecoverySectionDescription")}
          >
            <div className="affairs-tag-recovery-status">
              <div className="affairs-tag-recovery-status-grid">
                <span className="affairs-tag-recovery-status-label">状态</span>
                <span className="affairs-tag-recovery-status-value">
                  {recomputeMessage ?? t("libraryTagRecoveryStatusIdle")}
                </span>
              </div>
            </div>
            <div className="affairs-tag-management-batch-actions">
              <button
                type="button"
                className="secondary-button"
                disabled={saving || recomputing}
                onClick={() => void requestRecompute()}
              >
                {recomputing ? t("libraryTagRecoveryRunningAction") : t("libraryTagRecoveryAction")}
              </button>
            </div>
          </ModalSection>

          {editorMode === "edit" && selectedEditableTag ? (
            <ModalSection
              className="affairs-tag-management-danger"
              heading="危险操作"
            >
              <button
                type="button"
                className="secondary-button danger-button"
                disabled={saving}
                onClick={() => void deleteSelected()}
              >
                {t("libraryTagDeleteAction")}
              </button>
            </ModalSection>
          ) : null}
        </div>
      </div>
      <ModalActions className="affairs-library-settings-actions">
        <button type="button" className="secondary-button" disabled={saving} onClick={onClose}>
          关闭
        </button>
        <button
          type="button"
          className="secondary-button"
          disabled={saving}
          onClick={() => {
            if (editorMode === "edit") {
              reloadEditorFromSelected();
              return;
            }
            if (editorMode === "create-child") {
              resetEditor("create-child", selectedEditableTag);
              return;
            }
            beginCreateRoot();
          }}
        >
          {editorMode === "edit" ? "还原" : "重置"}
        </button>
        <button
          type="button"
          className="secondary-button"
          disabled={saving || !name.trim()}
          onClick={() => void handleSave()}
        >
          {saving ? "保存中…" : saveActionLabel}
        </button>
      </ModalActions>
      {error ? <span className="affairs-binding-error">{error}</span> : null}
    </div>
  );

  return (
    <DesktopModal
      title={t("libraryTagManagerTitle")}
      description={t("libraryTagManagerDescription")}
      size="wide"
      layout="form"
      className="affairs-library-settings-modal"
      onClose={onClose}
      dismissible={!saving}
    >
      {content}
    </DesktopModal>
  );
}

function LibraryTagManagementTreeNodes({
  nodes,
  selectedTagId,
  depth = 0,
  onSelect,
}: {
  nodes: ManagedTagTreeNode[];
  selectedTagId: string | null;
  depth?: number;
  onSelect: (tagId: string) => void;
}) {
  return (
    <ul className="affairs-tag-management-tree-list">
      {nodes.map((node) => (
        <li
          key={node.tag.id}
          className="affairs-tag-management-tree-node"
          role="treeitem"
          aria-selected={selectedTagId === node.tag.id}
          data-depth={depth}
        >
          <button
            type="button"
            className={selectedTagId === node.tag.id ? "affairs-tag-management-tree-button active" : "affairs-tag-management-tree-button"}
            aria-label={node.tag.name}
            onClick={() => onSelect(node.tag.id)}
          >
            <span className="affairs-tag-management-tree-button-main">
              <span className="affairs-tag-management-tree-main">
                <span className="affairs-tag-management-tree-name">{node.tag.name}</span>
              </span>
            </span>
          </button>
          {node.children.length > 0 ? (
            <LibraryTagManagementTreeNodes
              nodes={node.children}
              selectedTagId={selectedTagId}
              depth={depth + 1}
              onSelect={onSelect}
            />
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function LibraryFileViewerModal({
  library,
  viewerState,
  onClose,
}: {
  library: LibraryState;
  viewerState: LibraryViewerState;
  onClose: () => void;
}) {
  const [preview, setPreview] = useState<LibraryPreview | null>(null);
  const [editorContent, setEditorContent] = useState("");
  const [mode, setMode] = useState<ViewerMode>("preview");
  const [presentationProject, setPresentationProject] = useState<DocumentProject | null>(null);
  const [presentationSavedContent, setPresentationSavedContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSaveMessage(null);
    setPreview(null);
    setEditorContent("");
    setPresentationProject(null);
    setPresentationSavedContent(null);
    void getLibraryPreviewForViewer(viewerState.filePath)
      .then((nextPreview) => {
        if (cancelled) {
          return;
        }
        applyLibraryViewerPreviewState({
          filePath: viewerState.filePath,
          nextPreview,
          setPreview,
          setEditorContent,
          setMode,
        });
      })
      .catch((err) => {
        if (!cancelled) {
          setError(toApiErrorMessage(err));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [viewerState.filePath]);

  const htmlPresentationProbe = useMemo(() => {
    if (preview?.kind !== "html" || !editorContent.trim()) {
      return null;
    }
    return inspectStaticHtmlPresentation(editorContent, viewerState.filePath);
  }, [editorContent, preview?.kind, viewerState.filePath]);

  const canShowPresentationTab = shouldEnableHtmlPresentationMode({
    filePath: viewerState.filePath,
    html: editorContent,
    probe: htmlPresentationProbe,
  });
  const canShowPreviewTab = canUsePreviewMode(preview?.kind ?? null);
  const canShowEditTab = Boolean(preview?.capabilities.canEdit && preview.version && canUseEditMode(preview.kind));
  const viewerTabs = buildViewerTabs({
    canShowPresentationTab,
    canShowPreviewTab,
    canShowEditTab,
  });
  const canSave = canShowEditTab && (mode === "edit" || mode === "presentation");
  const savedComparableContent = mode === "presentation" && presentationSavedContent !== null
    ? presentationSavedContent
    : editorContent;
  const isDirty = Boolean(preview && canSave && savedComparableContent !== (preview.content ?? ""));

  useEffect(() => {
    if (!viewerTabs.length) {
      return;
    }
    if (!viewerTabs.includes(mode)) {
      setMode(viewerTabs[0] ?? "preview");
    }
  }, [mode, viewerTabs.join("|")]);

  async function refreshPreview(preserveMode = true): Promise<void> {
    setLoading(true);
    setError(null);
    setSaveMessage(null);
    try {
      const nextPreview = await getLibraryPreviewForViewer(viewerState.filePath);
      applyLibraryViewerPreviewState({
        filePath: viewerState.filePath,
        nextPreview,
        setPreview,
        setEditorContent,
        setMode: preserveMode
          ? (updater) => setMode((current) => {
              const next = typeof updater === "function" ? updater(current) : updater;
              return canUseMode(current, nextPreview.kind) ? current : next;
            })
          : setMode,
      });
      setPresentationProject(null);
      setPresentationSavedContent(null);
      await library.reloadDocuments(true);
    } catch (err) {
      setError(toApiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  async function saveContent(): Promise<void> {
    if (!preview || !canSave || !preview.version) {
      return;
    }

    const nextContent = mode === "presentation" && presentationProject
      ? presentationSavedContent ?? writeStaticHtmlDocumentProject({ html: editorContent, project: presentationProject }) ?? editorContent
      : editorContent;

    setSaving(true);
    setError(null);
    setSaveMessage(null);
    try {
      await library.operateFile({
        opType: "write",
        srcPath: viewerState.filePath,
        content: nextContent,
        expectedVersion: preview.version,
      });
      setSaveMessage(t("filePanelSaveSuccess"));
      const nextPreview = await getLibraryPreviewForViewer(viewerState.filePath);
      applyLibraryViewerPreviewState({
        filePath: viewerState.filePath,
        nextPreview,
        setPreview,
        setEditorContent,
        setMode,
      });
      setPresentationProject(null);
      setPresentationSavedContent(null);
      await library.reloadDocuments(true);
    } catch (err) {
      setError(toApiErrorMessage(err));
      setSaveMessage(t("filePanelSaveFailed"));
    } finally {
      setSaving(false);
    }
  }

  function openDetachedPreview(): void {
    openLibraryPreviewDetachedWindow(preview, viewerState, editorContent);
    onClose();
  }

  const detachControl = (
    <button
      type="button"
      className="desktop-modal-close file-viewer-detach-button"
      aria-label={t("libraryPreviewOpenInWindow")}
      title={t("libraryPreviewOpenInWindow")}
      disabled={loading || Boolean(error) || !preview}
      onClick={openDetachedPreview}
    >
      {renderDetachWindowIcon()}
    </button>
  );

  const headerActions = (
    <div className="file-viewer-header-controls">
      {viewerTabs.length > 1 ? (
        <div className="file-viewer-header-tabs" role="tablist" aria-label={t("fileViewerModeLabel")}>
          {viewerTabs.map((viewerMode) => (
            <button
              key={viewerMode}
              type="button"
              className="file-viewer-tab"
              data-active={mode === viewerMode ? "true" : undefined}
              onClick={() => setMode(viewerMode)}
            >
              {resolveViewerModeLabel(viewerMode)}
            </button>
          ))}
        </div>
      ) : null}
      <div className="file-viewer-header-action-buttons">
        {saveMessage ? <span className="file-viewer-save-status">{saveMessage}</span> : null}
        {canSave ? (
          <button
            type="button"
            className="primary-button file-viewer-action-button"
            disabled={saving || !isDirty}
            onClick={() => void saveContent()}
          >
            {saving ? t("filePanelSaving") : t("filePanelSave")}
          </button>
        ) : null}
        <button
          type="button"
          className="secondary-button file-viewer-action-button"
          disabled={loading || saving}
          onClick={() => void refreshPreview()}
        >
          {t("fileViewerRefreshPreview")}
        </button>
      </div>
    </div>
  );

  return (
    <DesktopModal
      open
      title={viewerState.title}
      description={viewerState.filePath}
      size="regular"
      layout="viewer"
      className="file-viewer-modal library-file-viewer-modal is-resizable"
      bodyClassName="file-viewer-modal-body library-file-viewer-body"
      titleClassName="file-viewer-title"
      headerActions={headerActions}
      beforeCloseButton={detachControl}
      onClose={onClose}
    >
      <LibraryFileViewerSurface
        preview={preview}
        filePath={viewerState.filePath}
        mode={mode}
        editorContent={editorContent}
        loading={loading}
        error={error}
        canSave={canSave}
        saving={saving}
        onEditorContentChange={setEditorContent}
        onPresentationProjectChange={(project) => {
          setPresentationProject(project);
          setPresentationSavedContent(
            project ? writeStaticHtmlDocumentProject({ html: editorContent, project }) : null,
          );
        }}
        onSave={() => void saveContent()}
      />
    </DesktopModal>
  );
}

function LibraryFileViewerSurface({
  preview,
  filePath,
  mode,
  editorContent,
  loading,
  error,
  canSave,
  saving,
  onEditorContentChange,
  onPresentationProjectChange,
  onSave,
}: {
  preview: LibraryPreview | null;
  filePath: string;
  mode: ViewerMode;
  editorContent: string;
  loading: boolean;
  error: string | null;
  canSave: boolean;
  saving: boolean;
  onEditorContentChange: (content: string) => void;
  onPresentationProjectChange: (project: DocumentProject | null) => void;
  onSave: () => void;
}) {
  if (loading || error || !preview || !preview.supported || preview.kind === "office") {
    return (
      <div className="library-file-viewer-fallback">
        <PreviewPanel preview={preview} loading={loading} error={error} />
      </div>
    );
  }

  if (mode === "presentation" && preview.kind === "html") {
    return (
      <StaticHtmlPresentationView
        filePath={filePath}
        html={editorContent}
        baseHref={preview.previewUrl}
        canSave={canSave}
        saving={saving}
        onSave={onSave}
        onProjectChange={onPresentationProjectChange}
      />
    );
  }

  if (mode === "edit") {
    return (
      <CodePreview
        content={editorContent}
        language={detectLanguage(filePath)}
        overviewTotalLines={editorContent.split(/\r?\n/).length}
        editable
        onContentChange={onEditorContentChange}
      />
    );
  }

  if (preview.kind === "markdown") {
    return <MarkdownPreview content={editorContent || t("libraryPreviewEmpty")} />;
  }

  if (preview.kind === "image" && preview.previewUrl) {
    return (
      <div className="library-file-viewer-image-wrap file-viewer-media-shell">
        <img className="library-file-viewer-image" src={preview.previewUrl} alt={preview.path} />
      </div>
    );
  }

  if (preview.kind === "pdf" && preview.previewUrl) {
    return (
      <div className="file-viewer-pdf-shell">
        <iframe className="library-file-viewer-frame file-viewer-pdf-frame" src={preview.previewUrl} title={preview.path} />
      </div>
    );
  }

  if (preview.kind === "html") {
    if (preview.previewUrl) {
      return (
        <div className="file-viewer-html-frame-shell">
          <iframe className="library-file-viewer-frame file-viewer-html-frame" src={preview.previewUrl} title={preview.path} />
        </div>
      );
    }
    return (
      <div className="file-viewer-html-frame-shell">
        <iframe className="library-file-viewer-frame file-viewer-html-frame" srcDoc={editorContent} title={preview.path} />
      </div>
    );
  }

  return (
    <CodePreview
      content={editorContent || t("libraryPreviewEmpty")}
      language={detectLanguage(filePath)}
      overviewTotalLines={editorContent.split(/\r?\n/).length}
    />
  );
}

function getLibraryPreviewForViewer(path: string): Promise<LibraryPreview> {
  return getLibraryPreview(path);
}

interface HtmlPresentationModeInput {
  filePath: string | null;
  html: string;
  probe: ReturnType<typeof inspectStaticHtmlPresentation> | null;
}

const PRESENTATION_DIRECTORY_SEGMENTS = new Set([
  "slides",
  "slide",
  "presentations",
  "presentation",
  "deck",
  "decks",
  "ppt",
  "pptx",
]);

const TOOL_DIRECTORY_SEGMENTS = new Set(["tools", "tool"]);

function applyLibraryViewerPreviewState(input: {
  filePath: string;
  nextPreview: LibraryPreview;
  setPreview: (preview: LibraryPreview) => void;
  setEditorContent: (content: string) => void;
  setMode: (updater: ViewerMode | ((current: ViewerMode) => ViewerMode)) => void;
}): void {
  input.setPreview(input.nextPreview);
  input.setEditorContent(input.nextPreview.content ?? "");
  input.setMode((current) => {
    if (canUseMode(current, input.nextPreview.kind)) {
      return current;
    }
    return resolveInitialViewerMode(input.filePath, input.nextPreview.kind);
  });
}

function shouldEnableHtmlPresentationMode(input: HtmlPresentationModeInput): boolean {
  const { filePath, html, probe } = input;

  if (!probe?.supported || !html.trim()) {
    return false;
  }

  const normalizedSegments = splitNormalizedPathSegments(filePath);

  if (normalizedSegments.some((segment) => TOOL_DIRECTORY_SEGMENTS.has(segment))) {
    return false;
  }

  if (hasExplicitPresentationOptIn(html)) {
    return true;
  }

  if (normalizedSegments.some((segment) => PRESENTATION_DIRECTORY_SEGMENTS.has(segment))) {
    return true;
  }

  if (probe.strategy === "deck-direct-child") {
    return false;
  }

  return hasStrongPresentationSignals(html);
}

function splitNormalizedPathSegments(filePath: string | null): string[] {
  if (!filePath) {
    return [];
  }

  return filePath
    .split(/[\\/]+/)
    .map((segment) => segment.trim().toLowerCase())
    .filter(Boolean);
}

function hasExplicitPresentationOptIn(html: string): boolean {
  return /<meta[^>]+name=["'](?:codingns-preview-mode|codingns-presentation|cns-preview-mode|cns-presentation)["'][^>]+content=["']presentation["'][^>]*>/i.test(html)
    || /\bdata-(?:codingns|cns)-(?:preview-mode|presentation)\s*=\s*["']presentation["']/i.test(html);
}

function hasStrongPresentationSignals(html: string): boolean {
  const hasDeckContainer = /\bclass\s*=\s*["'][^"']*\bdeck\b[^"']*["']/i.test(html);
  const hasSlideClass = /\bclass\s*=\s*["'][^"']*\bslide\b[^"']*["']/i.test(html);
  const hasSlideMetadata = /\bdata-(?:slide|title)\s*=\s*["'][^"']+["']/i.test(html);
  const hasDeckViewport = /--deck-width\s*:|--deck-height\s*:|aspect-ratio\s*:\s*16\s*\/\s*9/i.test(html);

  return hasSlideClass && (hasDeckContainer || hasSlideMetadata || hasDeckViewport);
}

function resolveInitialViewerMode(
  filePath: string | null,
  previewKind: LibraryPreview["kind"] | null,
): ViewerMode {
  if (
    previewKind === "markdown" ||
    previewKind === "html" ||
    previewKind === "image" ||
    previewKind === "pdf" ||
    previewKind === "office"
  ) {
    return "preview";
  }

  return "preview";
}

function canUsePreviewMode(previewKind: LibraryPreview["kind"] | null): boolean {
  return previewKind === "text" ||
    previewKind === "markdown" ||
    previewKind === "html" ||
    previewKind === "image" ||
    previewKind === "pdf" ||
    previewKind === "office";
}

function canUseEditMode(previewKind: LibraryPreview["kind"] | null): boolean {
  return previewKind === "text" || previewKind === "markdown" || previewKind === "html";
}

function canUseMode(mode: ViewerMode, previewKind: LibraryPreview["kind"] | null): boolean {
  if (mode === "presentation") {
    return previewKind === "html";
  }
  if (mode === "preview") {
    return canUsePreviewMode(previewKind);
  }
  return canUseEditMode(previewKind);
}

function buildViewerTabs(input: {
  canShowPresentationTab: boolean;
  canShowPreviewTab: boolean;
  canShowEditTab: boolean;
}): ViewerMode[] {
  const tabs: ViewerMode[] = [];
  if (input.canShowPresentationTab) tabs.push("presentation");
  if (input.canShowPreviewTab) tabs.push("preview");
  if (input.canShowEditTab) tabs.push("edit");
  return tabs;
}

function resolveViewerModeLabel(mode: ViewerMode): string {
  if (mode === "presentation") return t("fileViewerPresentation");
  if (mode === "preview") return t("fileViewerPreview");
  return t("fileViewerEdit");
}

function openLibraryPreviewDetachedWindow(
  preview: LibraryPreview | null,
  viewerState: LibraryViewerState,
  editorContent = "",
): void {
  const targetUrl = resolveLibraryPreviewDetachedUrl(preview, viewerState, editorContent);
  const opened = window.open(
    targetUrl,
    "_blank",
    "noopener,noreferrer,width=1180,height=820",
  );
  if (!opened && targetUrl.startsWith("blob:")) {
    window.location.href = targetUrl;
  }
}

function resolveLibraryPreviewDetachedUrl(
  preview: LibraryPreview | null,
  viewerState: LibraryViewerState,
  editorContent = "",
): string {
  if (preview?.onlyOffice?.documentUrl) {
    return preview.onlyOffice.documentUrl;
  }
  if (preview?.previewUrl) {
    return preview.previewUrl;
  }
  const content = editorContent || preview?.content || "";
  const title = escapeHtml(viewerState.title);
  const path = escapeHtml(viewerState.filePath);
  const body = escapeHtml(content || t("libraryPreviewEmpty"));
  return URL.createObjectURL(new Blob([`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>${title}</title>
<style>
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC",sans-serif;background:#f8f8f7;color:#1c1c1e;}
header{position:sticky;top:0;padding:14px 18px;border-bottom:1px solid rgba(0,0,0,.08);background:rgba(248,248,247,.92);backdrop-filter:blur(16px);}
h1{margin:0;font-size:15px;}
p{margin:6px 0 0;color:rgba(60,60,67,.68);font-size:12px;word-break:break-all;}
pre{margin:0;padding:20px 24px;white-space:pre-wrap;line-height:1.7;font:13px/1.7 -apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC",sans-serif;}
</style>
</head>
<body><header><h1>${title}</h1><p>${path}</p></header><pre>${body}</pre></body>
</html>`], { type: "text/html;charset=utf-8" }));
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function PreviewPanel({
  preview,
  loading,
  error,
}: {
  preview: LibraryPreview | null;
  loading: boolean;
  error: string | null;
}) {
  if (loading) {
    return <div className="preview-box">{t("libraryDocumentsLoading")}</div>;
  }

  if (error) {
    return <div className="preview-box error">{error}</div>;
  }

  if (!preview) {
    return <div className="preview-box">{t("libraryPreviewEmpty")}</div>;
  }

  if (!preview.supported) {
    return (
      <div className="preview-box">
        {preview.reason || t("libraryPreviewUnsupported")}
      </div>
    );
  }

  if (preview.kind === "image" && preview.previewUrl) {
    return (
      <img
        className="preview-image"
        src={preview.previewUrl}
        alt={preview.path}
      />
    );
  }

  if (
    (preview.kind === "pdf" || preview.kind === "html") &&
    preview.previewUrl
  ) {
    return (
      <a
        className="preview-link"
        href={preview.previewUrl}
        target="_blank"
        rel="noreferrer"
      >
        {t("libraryPreviewOpenResource")}
      </a>
    );
  }

  if (preview.kind === "office" && preview.onlyOffice) {
    return (
      <div className="preview-box">
        <a
          className="preview-link"
          href={preview.onlyOffice.documentUrl}
          target="_blank"
          rel="noreferrer"
        >
          {t("libraryPreviewOnlyOffice")}
        </a>
        <small>
          {preview.onlyOffice.editorMode === "edit"
            ? t("libraryPreviewOfficeEdit")
            : t("libraryPreviewOfficeView")}
        </small>
      </div>
    );
  }

  return (
    <pre className="preview-box text">
      {preview.content || t("libraryPreviewEmpty")}
    </pre>
  );
}

function DocumentTagEditor({
  library,
  documentId,
}: {
  library: LibraryState;
  documentId: string;
}) {
  const selected = library.selectedDocument;
  const [value, setValue] = useState(() => selected?.tags.join(", ") ?? "");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function save(): Promise<void> {
    setSaving(true);
    setMessage(null);
    try {
      await saveDocumentTags(documentId, {
        createTagPaths: splitTagInput(value),
      });
      setMessage(t("settingsSaveSuccess"));
      await library.reload();
      await library.reloadDocuments(true);
    } catch (err) {
      setMessage(toApiErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="tag-editor">
      <label>
        <span>{t("libraryEditTags")}</span>
        <input
          value={value}
          placeholder={t("libraryEditTagsPlaceholder")}
          onChange={(event) => setValue(event.target.value)}
        />
      </label>
      <button
        type="button"
        className="secondary-button"
        disabled={saving}
        onClick={() => void save()}
      >
        {saving ? t("settingsSaving") : t("librarySaveTags")}
      </button>
      {message ? <small>{message}</small> : null}
    </div>
  );
}

function FolderTagPanel({ library }: { library: LibraryState }) {
  const folderPath =
    library.viewState.browseMode === "folder"
      ? (library.viewState.selectedFolderPath ?? "")
      : null;
  const [value, setValue] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (folderPath === null) {
      return;
    }

    let cancelled = false;
    void getFolderTagDetails(folderPath)
      .then((details) => {
        if (!cancelled) {
          setValue(
            details.bindings
              .map((item) => item.tagPath)
              .filter(Boolean)
              .join(", "),
          );
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setMessage(toApiErrorMessage(err));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [folderPath]);

  if (folderPath === null) {
    return null;
  }

  async function save(): Promise<void> {
    try {
      await saveFolderTags({
        folderPath: folderPath ?? "",
        createTagPaths: splitTagInput(value),
      });
      setMessage(t("settingsSaveSuccess"));
      await library.reload();
    } catch (err) {
      setMessage(toApiErrorMessage(err));
    }
  }

  return (
    <div className="folder-tag-panel">
      <label>
        <span>{t("libraryFolderTags")}</span>
        <input
          value={value}
          placeholder={t("libraryFolderTagsPlaceholder")}
          onChange={(event) => setValue(event.target.value)}
        />
      </label>
      <button
        type="button"
        className="secondary-button"
        onClick={() => void save()}
      >
        {t("librarySaveTags")}
      </button>
      {message ? <small>{message}</small> : null}
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="detail-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function DetailPathRow({
  path,
  onSelectFolder,
}: {
  path: string;
  onSelectFolder: (path: string | null, selectedEntryPath?: string | null) => void;
}) {
  const segments = path.split("/").filter(Boolean);
  if (segments.length <= 1) {
    return (
      <DetailRow label={t("libraryMetaPath")} value={path} />
    );
  }

  return (
    <div className="detail-row" data-testid="library-detail-path-row">
      <span>{t("libraryMetaPath")}</span>
      <strong className="detail-path-segments">
        {segments.map((segment, index) => {
          const currentPath = segments.slice(0, index + 1).join("/");
          const isFileName = index === segments.length - 1;
          return (
            <Fragment key={currentPath}>
              {index > 0 ? <span className="detail-path-separator">/</span> : null}
              {isFileName ? (
                <span>{segment}</span>
              ) : (
                <button
                  type="button"
                  className="affairs-detail-link-button detail-path-button"
                  onClick={() => onSelectFolder(currentPath)}
                >
                  {segment}
                </button>
              )}
            </Fragment>
          );
        })}
      </strong>
    </div>
  );
}

function TagPills({ items }: { items: string[] }) {
  const visibleItems = compactDocumentTagPaths(items);
  return (
    <div className="tag-group">
      {visibleItems.length ? (
        visibleItems.map((item) => <mark key={item}>{item}</mark>)
      ) : (
        <small>{t("libraryNoTags")}</small>
      )}
    </div>
  );
}

function LibraryIndexStatusPopover({ status }: { status: LibraryIndexStatus | null }) {
  const [open, setOpen] = useState(false);
  const stateLabel = resolveIndexStatusLabel(status?.state);
  const stageLabel = resolveIndexStageLabel(status?.runningStage ?? null);
  const progress = status?.progress ?? null;
  const technicalRows = [
    [t("libraryStatusLastRequested"), formatNullableDateTime(status?.lastRequestedAt ?? null)],
    [t("libraryStatusLastStarted"), formatNullableDateTime(status?.lastStartedAt ?? null)],
    [t("libraryStatusLastCompleted"), formatNullableDateTime(status?.lastCompletedAt ?? null)],
    [t("libraryStatusLastFailed"), formatNullableDateTime(status?.lastFailedAt ?? null)],
    [t("libraryStatusDirtyReasons"), status?.dirtyReasons?.join(", ") || "--"],
    [t("libraryStatusErrorSummary"), status?.errorSummary || "--"],
  ];

  return (
    <span
      className="library-index-status-anchor"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        className="affairs-stage-status-trigger"
        title={stateLabel}
        aria-label={`${t("libraryStatusTitle")}：${stateLabel}`}
        aria-expanded={open}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
      >
        <span className={`affairs-stage-status-dot state-${resolveStatusDotState(status?.state)}`} />
        <span className="affairs-stage-status-text">
          {resolveIndexStatusShortLabel(status?.state)}
        </span>
      </button>
      {open ? (
        <div
          role="dialog"
          aria-label={t("libraryIndexStatusDetailsTitle")}
          className="library-index-status-popover"
        >
          <strong>{t("libraryIndexStatusDetailsTitle")}</strong>
          <dl className="library-index-status-summary">
            <div>
              <dt>{t("libraryIndexStatusCurrentLabel")}</dt>
              <dd>{stateLabel}</dd>
            </div>
            {status?.runningStage ? (
              <div>
                <dt>{t("libraryStatusRunningStage")}</dt>
                <dd>{stageLabel}</dd>
              </div>
            ) : null}
            {progress ? (
              <div>
                <dt>{t("libraryStatusProgress")}</dt>
                <dd>{t("libraryProgressSummary", {
                  scanned: progress.scannedCount,
                  indexed: progress.indexedCount,
                  failed: progress.failedCount,
                })}</dd>
              </div>
            ) : null}
          </dl>
          <div
            className="library-index-status-technical"
            data-testid="library-index-status-technical"
            style={{
              maxHeight: "min(220px, calc(100vh - 180px))",
              overflowY: "auto",
            }}
          >
            {technicalRows.map(([label, value]) => (
              <div key={label}>
                <span>{label}</span>
                <code>{value}</code>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </span>
  );
}

function resolveIndexStatusLabel(state: LibraryIndexState | undefined): string {
  switch (state) {
    case "fresh":
      return t("libraryStatusFresh");
    case "stale":
      return t("libraryStatusStale");
    case "queued":
      return t("libraryStatusQueued");
    case "running":
      return t("libraryStatusRunning");
    case "queue_timeout":
      return t("libraryStatusQueueTimeout");
    case "cooldown":
      return t("libraryStatusCooldown");
    case "failed":
      return t("libraryStatusFailed");
    default:
      return t("libraryStatusUnknown");
  }
}

function resolveIndexStatusShortLabel(state: LibraryIndexState | undefined): string {
  switch (state) {
    case "fresh":
      return t("libraryStatusFreshShort");
    case "running":
      return t("libraryStatusRunningShort");
    case "queued":
      return t("libraryStatusQueuedShort");
    case "cooldown":
      return t("libraryStatusCooldownShort");
    case "failed":
    case "queue_timeout":
      return t("libraryStatusFailedShort");
    case "stale":
      return t("libraryStatusStaleShort");
    default:
      return t("libraryStatusUnknownShort");
  }
}

function resolveIndexStageLabel(stage: string | null): string {
  const labels: Record<string, string> = {
    load_config: t("libraryIndexStageLoadConfig"),
    init_catalog: t("libraryIndexStageInitCatalog"),
    incremental_index: t("libraryIndexStageIncrementalIndex"),
    index: t("libraryIndexStageIndex"),
    index_text: t("libraryIndexStageIndexText"),
    export_snapshot: t("libraryIndexStageExportSnapshot"),
    export_search: t("libraryIndexStageExportSearch"),
    sqlite: t("libraryIndexStageSqlite"),
  };
  return stage ? labels[stage] ?? stage : "--";
}

function formatNullableDateTime(value: string | null): string {
  return value ? formatDateTime(value) : "--";
}

function resolveDirectoryStateLabel(state: LibraryDirectoryState): string {
  const labels: Record<LibraryDirectoryState, string> = {
    idle: t("libraryDirectoryStateIdle"),
    queued: t("libraryDirectoryStateQueued"),
    running: t("libraryDirectoryStateRunning"),
    queue_timeout: t("libraryDirectoryStateQueueTimeout"),
    fresh: t("libraryDirectoryStateFresh"),
    failed: t("libraryDirectoryStateFailed"),
  };
  return labels[state];
}

function resolveDirectorySourceLabel(source: LibraryDirectorySource): string {
  const labels: Record<LibraryDirectorySource, string> = {
    live: t("libraryDirectorySourceLive"),
    snapshot: t("libraryDirectorySourceSnapshot"),
    mixed: t("libraryDirectorySourceMixed"),
    stale_fallback: t("libraryDirectorySourceStaleFallback"),
  };
  return labels[source];
}


function buildLibraryTagTree(tags: LibraryTagNode[]): LibraryTagTreeNodeRecord[] {
  const nodes = new Map<string, LibraryTagTreeNodeRecord>();
  const roots: LibraryTagTreeNodeRecord[] = [];

  for (const tag of tags) {
    if (isNoiseLibraryTag(tag)) {
      continue;
    }
    nodes.set(tag.path, {
      path: tag.path,
      label: tag.name,
      count: tag.documentCount,
      children: [],
    });
  }

  for (const tag of tags) {
    const node = nodes.get(tag.path);
    if (!node) {
      continue;
    }
    const parent = tag.parentPath ? nodes.get(tag.parentPath) : null;
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  const compare = (left: LibraryTagTreeNodeRecord, right: LibraryTagTreeNodeRecord) => {
    const leftOrder = getLibraryTagRootOrder(left.path);
    const rightOrder = getLibraryTagRootOrder(right.path);
    if (leftOrder !== rightOrder) {
      return leftOrder - rightOrder;
    }
    if (isTimeLibraryTagPath(left.path) && isTimeLibraryTagPath(right.path)) {
      return getTimeTagOrder(left.label) - getTimeTagOrder(right.label);
    }
    if (left.count !== right.count) {
      return right.count - left.count;
    }
    return left.label.localeCompare(right.label, "zh-CN");
  };
  const sortNodes = (items: LibraryTagTreeNodeRecord[]) => {
    items.sort(compare);
    items.forEach((item) => sortNodes(item.children));
  };
  sortNodes(roots);
  return roots;
}

function isNoiseLibraryTag(tag: LibraryTagNode): boolean {
  const rootName = tag.path.split("/").filter(Boolean)[0] ?? tag.name;
  return LIBRARY_TAG_TREE_NOISE_ROOTS.has(rootName) || LIBRARY_TAG_TREE_NOISE_ROOTS.has(tag.rootType);
}

function getLibraryTagRootOrder(path: string): number {
  if (isTimeLibraryTagPath(path)) return 0;
  const root = path.split("/").filter(Boolean)[0] ?? path;
  if (root === "类型" || root === "type") return 1;
  return 2;
}

function isTimeLibraryTagPath(path: string): boolean {
  const root = path.split("/").filter(Boolean)[0] ?? path;
  return root === "时间" || root === "time";
}

function getTimeTagOrder(label: string): number {
  if (label.includes("最近7天") || label.toLowerCase().includes("last 7")) return 0;
  if (label.includes("今天")) return 1;
  if (label.includes("昨天")) return 2;
  if (label.includes("更早")) return 99;
  return 10;
}


function applyTagFacetCountsToTree(
  nodes: LibraryTagTreeNodeRecord[],
  tagFacetCounts: Record<string, number>,
  hasTagSelection: boolean,
): LibraryTagTreeNodeRecord[] {
  if (!hasTagSelection) {
    return nodes;
  }
  return nodes.map((node) => ({
    ...node,
    count: tagFacetCounts[node.path] ?? 0,
    children: applyTagFacetCountsToTree(node.children, tagFacetCounts, hasTagSelection),
  }));
}

function buildTagTreeVisibility(
  roots: LibraryTagTreeNodeRecord[],
  selectedTagPaths: string[],
  tagFacetCounts: Record<string, number>,
): { visiblePathSet: Set<string> } {
  const visiblePathSet = new Set<string>();
  const selectedSet = new Set(selectedTagPaths);
  const markAncestorsVisible = (pathValue: string) => {
    for (const ancestorPath of buildTagAncestorPaths(pathValue)) {
      visiblePathSet.add(ancestorPath);
    }
  };

  const visit = (node: LibraryTagTreeNodeRecord): boolean => {
    const nodeFacetCount = tagFacetCounts[node.path] ?? 0;
    const selectedRelated = selectedTagPaths.some((selectedPath) => (
      selectedPath === node.path ||
      selectedPath.startsWith(`${node.path}/`) ||
      node.path.startsWith(`${selectedPath}/`)
    ));
    const directVisible = selectedRelated || nodeFacetCount > 0;
    let childVisible = false;
    node.children.forEach((child) => {
      if (visit(child)) {
        childVisible = true;
      }
    });
    const visible = directVisible || childVisible || selectedTagPaths.length === 0;
    if (visible) {
      visiblePathSet.add(node.path);
      if (selectedSet.has(node.path)) {
        markAncestorsVisible(node.path);
      }
    }
    return visible;
  };

  roots.forEach((root) => visit(root));
  return { visiblePathSet };
}

function filterTagTreeByVisibility(
  nodes: LibraryTagTreeNodeRecord[],
  visiblePathSet: Set<string>,
): LibraryTagTreeNodeRecord[] {
  return nodes
    .filter((node) => visiblePathSet.has(node.path))
    .map((node) => ({
      ...node,
      children: filterTagTreeByVisibility(node.children, visiblePathSet),
    }));
}

function isDefaultLibraryTagPath(path: string): boolean {
  return path === "时间" || path.startsWith("时间/") || path === "类型" || path.startsWith("类型/");
}

function filterLibraryTagTree(
  nodes: LibraryTagTreeNodeRecord[],
  query: string,
): LibraryTagTreeNodeRecord[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return nodes;
  }

  return nodes.flatMap((node) => {
    const children = filterLibraryTagTree(node.children, normalizedQuery);
    if (matchesLibraryTagQuery(node, normalizedQuery) || children.length > 0) {
      return [{ ...node, children }];
    }
    return [];
  });
}

function matchesLibraryTagQuery(node: LibraryTagTreeNodeRecord, normalizedQuery: string): boolean {
  const label = node.label.toLowerCase();
  const pathValue = node.path.toLowerCase();
  return (
    label.includes(normalizedQuery) ||
    pathValue.includes(normalizedQuery) ||
    toSimplePinyin(label).includes(normalizedQuery) ||
    toSimplePinyin(pathValue).includes(normalizedQuery)
  );
}

function toSimplePinyin(value: string): string {
  return Array.from(value).map((char) => SIMPLE_PINYIN_MAP[char] ?? char).join("").toLowerCase();
}

function buildTagAncestorPaths(path: string): string[] {
  const parts = path.split("/").filter(Boolean);
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/"));
}

function readLibraryTagTreeState(): LibraryTagTreeState {
  try {
    const raw = window.localStorage.getItem(LIBRARY_TAG_TREE_STATE_KEY);
    if (!raw) {
      return { expandedPaths: [], expandedMorePaths: [] };
    }
    const parsed = JSON.parse(raw) as Partial<LibraryTagTreeState>;
    return {
      expandedPaths: Array.isArray(parsed.expandedPaths)
        ? parsed.expandedPaths.filter((item): item is string => typeof item === "string")
        : [],
      expandedMorePaths: Array.isArray(parsed.expandedMorePaths)
        ? parsed.expandedMorePaths.filter((item): item is string => typeof item === "string")
        : [],
    };
  } catch {
    return { expandedPaths: [], expandedMorePaths: [] };
  }
}

function writeLibraryTagTreeState(state: LibraryTagTreeState): void {
  try {
    window.localStorage.setItem(LIBRARY_TAG_TREE_STATE_KEY, JSON.stringify(state));
  } catch {
    // localStorage 不可用时忽略，树默认折叠即可。
  }
}

function areStringArraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function normalizeFavoriteTagPaths(tagPaths: string[]): string[] {
  return Array.from(new Set(tagPaths.map((item) => item.trim()).filter(Boolean)));
}

function buildTagFilterFavoritePath(tagPaths: string[]): string {
  return normalizeFavoriteTagPaths(tagPaths).join("|");
}

function resolveFavoriteKindLabel(kind: LibraryFavoriteKind): string {
  const labels: Record<LibraryFavoriteKind, string> = {
    folder: t("libraryFavoriteFolder"),
    tag: t("libraryFavoriteTag"),
    tag_filter: t("libraryFavoriteTagFilter"),
  };
  return labels[kind];
}

function resolveContextMenuPosition(
  point: { x: number; y: number },
  menu: { width: number; height: number },
  viewport: { width: number; height: number },
): {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
  transformOrigin: string;
} {
  const defaultWidth = 216;
  const margin = 12;
  const width = Math.max(defaultWidth, Math.ceil(menu.width || defaultWidth));
  const maxHeight = Math.max(180, viewport.height - margin * 2);
  const height = Math.min(Math.ceil(menu.height || 360), maxHeight);
  const opensLeft = point.x + width + margin > viewport.width;
  const opensUp = point.y + height + margin > viewport.height;
  return {
    left: opensLeft
      ? Math.max(margin, point.x - width)
      : Math.min(point.x, viewport.width - width - margin),
    top: opensUp
      ? Math.max(margin, point.y - height)
      : Math.min(point.y, viewport.height - height - margin),
    width,
    maxHeight,
    transformOrigin: `${opensLeft ? "right" : "left"} ${opensUp ? "bottom" : "top"}`,
  };
}

export function handleFolderClick(library: LibraryState, path: string): void {
  const openBehavior =
    library.snapshot?.binding?.folderOpenBehavior === "single_click"
      ? "single_click"
      : "double_click";
  if (openBehavior === "single_click") {
    library.selectFolder(path);
    return;
  }
  library.selectFolderEntry(path);
}

export function resolveLibraryDocumentDisplayName(
  entry: Pick<LibraryDocumentRecord, "path" | "title">,
): string {
  return getPathName(entry.path) || entry.title || t("libraryUntitled");
}

function resolveFinderKindLabel(path: string): string {
  const extension = resolveDocumentVisual(path).extension;
  if (extension === "txt" || extension === "text" || extension === "log" || extension === "rtf") {
    return t("libraryFinderKindText");
  }
  if (extension === "sql") {
    return t("libraryFinderKindSql");
  }
  if (extension === "html" || extension === "htm") {
    return t("libraryFinderKindHtml");
  }
  if (extension === "json") {
    return t("libraryFinderKindJson");
  }
  if (extension === "zip" || extension === "rar" || extension === "7z" || extension === "tar" || extension === "gz") {
    return t("libraryFinderKindArchive");
  }
  if (extension === "mp4" || extension === "mov" || extension === "mkv" || extension === "webm") {
    return t("libraryFinderKindVideo");
  }
  if (extension === "md" || extension === "mdx") {
    return t("libraryFinderKindMarkdown");
  }
  if (extension === "pdf") {
    return t("libraryFinderKindPdf");
  }
  if (extension === "document") {
    return t("libraryFinderKindDocument");
  }
  return extension.toUpperCase();
}

function formatFinderBytes(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return t("commonUnknown");
  }
  if (value < 1000) {
    return t("commonBytes", { count: value });
  }
  const kb = value / 1000;
  if (kb < 1000) {
    return `${kb.toFixed(1)} KB`;
  }
  const mb = kb / 1000;
  if (mb < 1000) {
    return `${mb.toFixed(1)} MB`;
  }
  return `${(mb / 1000).toFixed(1)} GB`;
}

function resolveLibraryEntryKey(entry: LibraryEntry): string {
  if (entry.kind === "document") {
    return `document:${entry.documentId}`;
  }
  return `${entry.kind}:${entry.path}`;
}

function resolveContextPath(target: LibraryContextMenuTarget): string {
  if (target.kind === "document") return target.entry.path;
  if (target.kind === "folder") return target.entry.path;
  return target.folderPath ?? "";
}

function resolvePasteDestinationFolder(
  target: LibraryContextMenuTarget,
): string | null {
  if (target.kind === "blank") return target.folderPath;
  if (target.kind === "folder") return target.entry.path;
  return getParentPath(target.entry.path);
}

function getContextTargetTitle(
  target: Extract<LibraryContextMenuTarget, { kind: "document" | "folder" }>,
): string {
  return target.kind === "document"
    ? resolveLibraryDocumentDisplayName(target.entry)
    : target.entry.name || getPathName(target.entry.path);
}

function resolveTargetAbsolutePath(
  library: LibraryState,
  target: Extract<LibraryContextMenuTarget, { kind: "document" | "folder" }>,
): string | null {
  return resolveLibraryLocalPath(library, resolveContextPath(target));
}

function resolveDocumentLocalPath(
  library: LibraryState,
  path: string,
): string | null {
  const mirrorRoot = library.snapshot?.binding?.mirrorRoot?.trim();
  if (!mirrorRoot) return null;
  return joinLibraryPath(mirrorRoot, path);
}

function resolveLibraryLocalPath(
  library: LibraryState,
  relativePath: string,
): string | null {
  const binding = library.snapshot?.binding;
  const root = (binding?.mirrorRoot || binding?.rootDir || "")
    .trim()
    .replace(/\/+$/g, "");
  if (!root) return null;
  return joinLibraryPath(root, relativePath);
}

function joinLibraryPath(root: string, relativePath: string): string | null {
  const normalizedRoot = root.trim().replace(/\/+$/g, "");
  const normalizedRelativePath = relativePath.trim().replace(/^\/+/, "");
  if (!normalizedRoot || !normalizedRelativePath) return null;
  return `${normalizedRoot}/${normalizedRelativePath}`.replace(/\/{2,}/g, "/");
}

function buildUniqueLibraryTargetPath(
  destinationFolder: string | null,
  fileName: string,
  entries: LibraryEntry[],
): string {
  const normalizedName = fileName.trim() || t("libraryUntitledFileName");
  const existing = new Set(entries.map((entry) => entry.path));
  const basePath = joinPath(destinationFolder, normalizedName);
  if (!existing.has(basePath)) return basePath;

  const dotIndex = normalizedName.lastIndexOf(".");
  const name =
    dotIndex > 0 ? normalizedName.slice(0, dotIndex) : normalizedName;
  const extension = dotIndex > 0 ? normalizedName.slice(dotIndex) : "";
  for (let index = 2; index < 1000; index += 1) {
    const candidate = joinPath(
      destinationFolder,
      `${name} ${index}${extension}`,
    );
    if (!existing.has(candidate)) return candidate;
  }
  return joinPath(destinationFolder, `${name} ${Date.now()}${extension}`);
}

async function copyContextText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "-9999px";
  document.body.append(textarea);
  textarea.focus();
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

async function locateDocumentFolder(
  library: LibraryState,
  path: string,
): Promise<void> {
  library.selectFolder(getParentPath(path));
}

function buildNativeLibraryContextMenuItems(
  library: LibraryState,
  target: LibraryContextMenuTarget,
  libraryClipboard: LibraryClipboardState | null,
): NativeLibraryContextMenuItem[] {
  const isDocument = target.kind === "document";
  const isFileSystemTarget =
    target.kind === "document" || target.kind === "folder";
  const isBlankTarget = target.kind === "blank";
  const absolutePath = isFileSystemTarget
    ? resolveTargetAbsolutePath(library, target)
    : null;
  const items: NativeLibraryContextMenuItem[] = [];

  if (isDocument) {
    items.push({ id: "preview", label: t("libraryContextPreview") });
  }
  if (isFileSystemTarget) {
    items.push({ id: "open", label: t("libraryContextOpen") });
    items.push({ id: "locate", label: t("libraryContextLocate") });
  }
  if (isDocument) {
    items.push({
      id: "open-local-app",
      label: t("libraryContextOpenLocalApp"),
      disabled: !absolutePath,
    });
    items.push({ id: "download", label: t("libraryContextDownload") });
  }
  if (isFileSystemTarget) {
    items.push({
      id: "copy-group",
      label: t("libraryContextCopy"),
      items: [
        { id: "copy-file", label: t("libraryContextCopyFile") },
        { id: "copy-file-name", label: t("libraryContextCopyFileName") },
        {
          id: "copy-absolute-path",
          label: t("libraryContextCopyAbsolutePath"),
          disabled: !absolutePath,
        },
        {
          id: "copy-relative-path",
          label: t("libraryContextCopyRelativePath"),
        },
      ],
    });
    items.push({ id: "cut", label: t("libraryContextCut") });
  }

  if (isBlankTarget) {
    items.push({
      id: "new-group",
      label: t("libraryContextNew"),
      items: [
        { id: "new-directory", label: t("libraryContextNewDirectory") },
        { id: "new-markdown", label: t("libraryContextNewMarkdown") },
        { id: "new-text", label: t("libraryContextNewText") },
        { id: "new-file", label: t("libraryContextNewCustom") },
      ],
    });
  }

  items.push({
    id: "paste",
    label: t("libraryContextPaste"),
    disabled: !libraryClipboard,
  });

  if (isFileSystemTarget) {
    items.push({ id: "delete", label: t("libraryContextDelete") });
    items.push({ id: "tags", label: t("libraryContextTags") });
  }
  if (isBlankTarget) {
    items.push({ id: "refresh", label: t("libraryContextRefresh") });
  }
  items.push({ id: "properties", label: t("libraryContextProperties") });

  return items;
}

async function openContextTarget(
  library: LibraryState,
  target: Extract<LibraryContextMenuTarget, { kind: "document" | "folder" }>,
): Promise<void> {
  const absolutePath = resolveTargetAbsolutePath(library, target);
  if (absolutePath && (await openPathInDesktop(absolutePath))) {
    return;
  }
  if (target.kind === "folder") {
    library.selectFolder(target.entry.path);
    return;
  }
  await library.openPreview(target.entry.path);
}

async function openPathInDesktop(path: string): Promise<boolean> {
  try {
    const tauriApi = await import("@tauri-apps/api/core");
    await tauriApi.invoke("open_path", { path });
    return true;
  } catch {
    return false;
  }
}

function isFolderFavorite(library: LibraryState, path: string): boolean {
  return Boolean(
    library.snapshot?.favorites.some(
      (item) => item.kind === "folder" && item.path === path,
    ),
  );
}

async function toggleFolderFavorite(
  library: LibraryState,
  entry: LibraryFolderEntry,
): Promise<void> {
  await library.toggleFavorite({
    kind: "folder",
    path: entry.path,
    label: entry.name || getPathName(entry.path),
  });
}

function selectContextProperties(
  library: LibraryState,
  target: LibraryContextMenuTarget,
): void {
  if (target.kind === "document") {
    library.selectDocument(target.entry.documentId);
    return;
  }
  library.selectFolderEntry(
    target.kind === "folder"
      ? target.entry.path
      : library.viewState.selectedFolderPath,
  );
}

function resolvePendingTagAssignmentTarget(
  target: LibraryContextMenuTarget,
): PendingTagAssignmentTarget | null {
  if (target.kind === "document") {
    return {
      kind: "document",
      documentId: target.entry.documentId,
      path: target.entry.path,
      title: resolveLibraryDocumentDisplayName(target.entry),
    };
  }
  if (target.kind === "folder") {
    return {
      kind: "folder",
      folderPath: target.entry.path,
      title: target.entry.name || getPathName(target.entry.path),
    };
  }
  return null;
}

function normalizeCreateFileName(
  value: string,
  kind: PendingCreateKind,
): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (kind === "markdown" && !/\.md$/i.test(trimmed)) return `${trimmed}.md`;
  if (kind === "text" && !/\.txt$/i.test(trimmed)) return `${trimmed}.txt`;
  return trimmed;
}

function resolveCreateInitialContent(kind: PendingCreateKind): string {
  if (kind === "markdown") return `# ${t("libraryCreateMarkdownHeading")}\n`;
  return "";
}

function resolveDefaultCreateName(kind: PendingCreateKind): string {
  switch (kind) {
    case "directory":
      return t("libraryCreateDirectoryDefaultName");
    case "markdown":
      return t("libraryCreateMarkdownDefaultName");
    case "text":
      return t("libraryCreateTextDefaultName");
    default:
      return t("libraryCreateCustomDefaultName");
  }
}

function resolveCreateKindLabel(kind: PendingCreateKind): string {
  switch (kind) {
    case "directory":
      return t("libraryCreateKindDirectory");
    case "markdown":
      return t("libraryCreateKindMarkdown");
    case "text":
      return t("libraryCreateKindText");
    default:
      return t("libraryCreateKindCustom");
  }
}

function resolveCreatePlaceholder(kind: PendingCreateKind): string {
  switch (kind) {
    case "directory":
      return t("libraryCreateFolderPlaceholder");
    case "markdown":
      return t("libraryCreateMarkdownPlaceholder");
    case "text":
      return t("libraryCreateTextPlaceholder");
    default:
      return t("libraryCreateCustomPlaceholder");
  }
}

function joinPath(basePath: string | null | undefined, name: string): string {
  const base = basePath?.trim().replace(/\/+$/, "");
  return base ? `${base}/${name}` : name;
}

function getParentPath(path: string): string | null {
  const segments = path.split("/").filter(Boolean);
  segments.pop();
  return segments.length ? segments.join("/") : null;
}

function resolveAssignedTagIds(
  details: LibraryDocumentTagDetails | LibraryFolderTagDetails,
): string[] {
  return "manualTagIds" in details ? details.manualTagIds : details.bindingTagIds;
}

function isAssignableLibraryTag(tag: LibraryTagNode | LibraryTagDetailWithRules): boolean {
  const detail = tag as LibraryTagDetailWithRules;
  if (detail.status && detail.status !== "active") {
    return false;
  }
  const rootType = tag.rootType.trim().toLowerCase();
  return rootType !== "类型" && rootType !== "type" && rootType !== "时间" && rootType !== "time";
}

function normalizeTagPathInput(value: string): string {
  return value
    .trim()
    .replace(/^\/+/, "")
    .replace(/\/+$/g, "")
    .split("/")
    .map((item) => item.trim())
    .filter(Boolean)
    .join("/");
}

function compactDocumentTagPaths(paths: string[]): string[] {
  const uniquePaths = Array.from(new Set(paths.map((tagPath) => tagPath.trim()).filter(Boolean)));
  const recentTimeTags = uniquePaths
    .map((tagPath) => ({ path: tagPath, days: resolveRecentTimeTagDays(tagPath) }))
    .filter((item): item is { path: string; days: number } => item.days !== null);
  const keptRecentPath = recentTimeTags.length > 0
    ? recentTimeTags.reduce((smallest, item) => item.days < smallest.days ? item : smallest).path
    : null;
  return uniquePaths.filter((tagPath) => {
    const days = resolveRecentTimeTagDays(tagPath);
    return days === null || tagPath === keptRecentPath;
  });
}

function resolveRecentTimeTagDays(path: string): number | null {
  const normalized = path.trim();
  const matched = /^时间\/最近(\d+)天$/.exec(normalized) ?? /^time\/recent-(\d+)-days$/i.exec(normalized);
  if (!matched) {
    return null;
  }
  const days = Number.parseInt(matched[1] ?? "", 10);
  return Number.isFinite(days) ? days : null;
}

function uniqueStringList(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function buildTagColorStyle(path: string): CSSProperties {
  return {
    "--affairs-tag-hue": String(resolveTagHue(path)),
  } as CSSProperties;
}

function resolveTagHue(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) % 360;
  }
  return hash;
}

function splitTagInput(value: string): string[] {
  return value
    .split(/[,\n，]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function resolveTagAssignmentInitialValue(
  details: LibraryDocumentTagDetails | LibraryFolderTagDetails,
): string {
  if ("resolvedTags" in details) {
    return details.resolvedTags
      .map((item) => item.path)
      .filter(Boolean)
      .join(", ");
  }
  return details.bindings
    .map((item) => item.tagPath)
    .filter(Boolean)
    .join(", ");
}

function appendTagPath(current: string, tagPath: string): string {
  return [
    ...new Set([...splitTagInput(current), tagPath.trim()].filter(Boolean)),
  ].join(", ");
}

function isTagDescendant(
  tags: LibraryTagDetailWithRules[],
  candidateId: string,
  ancestorId: string | null,
): boolean {
  if (!ancestorId) {
    return false;
  }
  let current = tags.find((tag) => tag.id === candidateId) ?? null;
  while (current?.parentId) {
    if (current.parentId === ancestorId) {
      return true;
    }
    current = tags.find((tag) => tag.id === current?.parentId) ?? null;
  }
  return false;
}

function buildUniqueTagDraftName(
  tags: LibraryTagDetailWithRules[],
  baseName: string,
): string {
  const names = new Set(tags.map((tag) => tag.name));
  if (!names.has(baseName)) {
    return baseName;
  }
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${baseName}${index}`;
    if (!names.has(candidate)) {
      return candidate;
    }
  }
  return `${baseName}${Date.now()}`;
}

function resolveStatusDotState(state: LibraryIndexState | undefined): string {
  if (state === "failed" || state === "queue_timeout") return "failed";
  if (state === "running" || state === "queued" || state === "stale")
    return "running";
  if (state === "cooldown") return "cooldown";
  return "fresh";
}

function renderFolderShape(mode: "grid" | "row" = "grid") {
  return (
    <span
      className={
        mode === "row" ? "affairs-folder-shape row" : "affairs-folder-shape"
      }
    >
      <span className="affairs-folder-tab-shape" />
      <span className="affairs-folder-body-shape" />
    </span>
  );
}

function renderDocumentShape(filePath: string, mode: "grid" | "row" = "grid") {
  const visual = resolveDocumentVisual(filePath);
  return (
    <span
      className={
        mode === "row"
          ? `affairs-document-sheet row tone-${visual.tone}`
          : `affairs-document-sheet tone-${visual.tone}`
      }
    >
      <span className="affairs-document-fold" />
      <span className="affairs-document-glyph">{visual.badge.slice(0, 1)}</span>
      <span className="affairs-document-lines" />
      <span className="affairs-document-badge">{visual.badge}</span>
    </span>
  );
}

function renderXFileBrandIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M4 7.5A2.5 2.5 0 0 1 6.5 5H10l2 2h5.5A2.5 2.5 0 0 1 20 9.5v8A2.5 2.5 0 0 1 17.5 20h-11A2.5 2.5 0 0 1 4 17.5z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
      />
      <path d="M4 9h16" fill="none" stroke="currentColor" strokeWidth="1.9" />
    </svg>
  );
}

function renderTagManagerIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M2.2 7.2V3.5c0-.7.6-1.3 1.3-1.3h3.7c.4 0 .7.1 1 .4l5.4 5.4a1.4 1.4 0 0 1 0 2l-3.6 3.6a1.4 1.4 0 0 1-2 0L2.6 8.2c-.3-.3-.4-.6-.4-1Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
      />
      <path d="M10.9 3.2v3M9.4 4.7h3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <circle cx="5.3" cy="5.3" r="0.9" fill="currentColor" />
    </svg>
  );
}

function renderResetFilterIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/** 实心五角星，用于收藏项的取消收藏按钮 */
function renderFilledStarIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M8 2.1l1.7 3.4 3.8.6-2.8 2.7.7 3.8L8 10.8l-3.4 1.8.7-3.8-2.8-2.7 3.8-.6z"
        fill="currentColor"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function renderFavoriteIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M8 2.1l1.7 3.4 3.8.6-2.8 2.7.7 3.8L8 10.8l-3.4 1.8.7-3.8-2.8-2.7 3.8-.6z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function resolveDocumentFolderPath(filePath: string): string | null {
  const segments = filePath.split("/").filter(Boolean);
  if (segments.length <= 1) {
    return null;
  }
  return segments.slice(0, -1).join("/");
}

function renderHighlightedText(value: string, keyword: string): ReactNode {
  const keywords = splitLibrarySearchKeywords(keyword);
  if (keywords.length === 0) {
    return value;
  }

  const lowerValue = value.toLowerCase();
  const parts: ReactNode[] = [];
  let cursor = 0;

  while (cursor < value.length) {
    const nextMatch = findNextLibrarySearchHighlight(lowerValue, keywords, cursor);
    if (!nextMatch) {
      parts.push(value.slice(cursor));
      break;
    }
    if (nextMatch.index > cursor) {
      parts.push(value.slice(cursor, nextMatch.index));
    }
    parts.push(
      <mark key={`${nextMatch.index}:${nextMatch.keyword}`} className="library-search-highlight">
        {value.slice(nextMatch.index, nextMatch.index + nextMatch.keyword.length)}
      </mark>,
    );
    cursor = nextMatch.index + nextMatch.keyword.length;
  }

  return parts.length ? parts : value;
}

function splitLibrarySearchKeywords(value: string): string[] {
  const seen = new Set<string>();
  return value
    .trim()
    .split(/\s+/)
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0)
    .filter((item) => {
      if (seen.has(item)) {
        return false;
      }
      seen.add(item);
      return true;
    });
}

function findNextLibrarySearchHighlight(
  lowerValue: string,
  keywords: string[],
  cursor: number,
): { index: number; keyword: string } | null {
  let matchedIndex = -1;
  let matchedKeyword = "";
  for (const keyword of keywords) {
    const index = lowerValue.indexOf(keyword, cursor);
    if (index < 0) {
      continue;
    }
    if (
      matchedIndex < 0 ||
      index < matchedIndex ||
      (index === matchedIndex && keyword.length > matchedKeyword.length)
    ) {
      matchedIndex = index;
      matchedKeyword = keyword;
    }
  }
  return matchedIndex < 0 ? null : { index: matchedIndex, keyword: matchedKeyword };
}

function renderTagTreeChevronIcon(expanded: boolean) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        d={expanded ? "M4.2 6.2 8 10l3.8-3.8" : "M6.2 4.2 10 8l-3.8 3.8"}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function renderDetachWindowIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <path
        d="M5 3.5h7.5V11M12.5 3.5 7.8 8.2M3.5 6.5v6h6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function renderPlusIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 3v10M3 8h10" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

function renderMiniFolderIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M1.8 4.8h4.3l1.1 1.3h8v7.1a1.4 1.4 0 0 1-1.4 1.4H2.2A1.4 1.4 0 0 1 .8 13.2V6.2c0-.8.2-1.4 1-1.4Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function renderTagIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M2.2 7.2V3.5c0-.7.6-1.3 1.3-1.3h3.7c.4 0 .7.1 1 .4l5.4 5.4a1.4 1.4 0 0 1 0 2l-3.6 3.6a1.4 1.4 0 0 1-2 0L2.6 8.2c-.3-.3-.4-.6-.4-1Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <circle cx="5.3" cy="5.3" r="1" fill="currentColor" />
    </svg>
  );
}

function renderHomeIcon() {
  return (
    <svg
      className="affairs-stage-breadcrumb-home-icon"
      viewBox="0 0 16 16"
      aria-hidden="true"
    >
      <path
        d="M2.2 7.4 8 2.7l5.8 4.7"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M4.1 6.9v6h3.1V9.5h1.6v3.4h3.1v-6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function renderGridIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M2.5 2.5h4v4h-4zm7 0h4v4h-4zm-7 7h4v4h-4zm7 0h4v4h-4z"
        fill="currentColor"
      />
    </svg>
  );
}

function renderListIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M3 4h10M3 8h10M3 12h10"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function renderRefreshIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M12.6 5.1A5 5 0 0 0 3.2 6M3.4 10.9a5 5 0 0 0 9.4-1.1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path
        d="M12.6 2.7v2.8H9.8M3.4 13.3v-2.8h2.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function renderSettingsIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M8 10.4A2.4 2.4 0 1 0 8 5.6a2.4 2.4 0 0 0 0 4.8Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
      />
      <path
        d="M13.5 8a5.6 5.6 0 0 0-.1-1l1.2-1-.9-1.6-1.5.5a5 5 0 0 0-1.7-1L10.2 2H6.3l-.3 1.5a5 5 0 0 0-1.7 1l-1.5-.5-.9 1.6 1.2 1a5.6 5.6 0 0 0 0 2L1.9 10l.9 1.6 1.5-.5a5 5 0 0 0 1.7 1l.3 1.5h3.9l.3-1.5a5 5 0 0 0 1.7-1l1.5.5.9-1.6-1.2-1c.1-.3.1-.7.1-1Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function renderSearchIcon() {
  return (
    <svg
      className="xfile-toolbar-search-icon"
      viewBox="0 0 16 16"
      aria-hidden="true"
    >
      <path
        d="m11.2 11.2 2.3 2.3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <circle
        cx="7.2"
        cy="7.2"
        r="4.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
      />
    </svg>
  );
}
