import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
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
  LibraryFavoriteKind,
  LibraryFavoriteRecord,
  LibraryFolderTagDetails,
  LibraryIndexState,
  LibraryPreview,
  LibraryTagDetailWithRules,
  LibraryTagRule,
} from "@x-file/shared";

import {
  browseHostDirectories,
  createLibraryTag,
  deleteLibraryTag,
  getDocumentTagDetails,
  getFolderTagDetails,
  getLibraryTagRecomputeTask,
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
  onOpenHealth: () => void;
  platformData: WorkbenchPlatformData;
}

type LibraryDocumentEntry = Extract<LibraryEntry, { kind: "document" }>;
type LibraryFolderEntry = Extract<LibraryEntry, { kind: "folder" }>;

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
  id: LibraryContextActionId | "copy-group";
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

interface FinderResizeState {
  column: FinderColumnKey;
  startX: number;
  startWidth: number;
}

export function LibraryPage({
  onOpenSettings,
  onOpenHealth,
  platformData,
}: LibraryPageProps) {
  const library = useLibraryState();
  const binding = library.snapshot?.binding ?? null;
  const shouldShowInitialization = library.requiresInitialization || !binding;
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
  const [tagManagerOpen, setTagManagerOpen] = useState(false);

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
          await library.openPreview(target.entry.path);
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
          onOpenHealth={onOpenHealth}
          onOpenTagManager={() => setTagManagerOpen(true)}
        />
        <section className="affairs-main-panel">
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
          />
        </section>
        <LibraryDetail
          library={library}
          onRequestRename={(path) =>
            setPendingRename({ path, fileName: getPathName(path) })
          }
          onRequestDelete={(target) => setPendingDelete(target)}
        />
      </section>
      {contextMenu ? (
        <LibraryContextMenu
          state={contextMenu}
          library={library}
          libraryClipboard={libraryClipboard}
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

function LibraryDesktopSidebar({
  library,
  onOpenSettings,
  onOpenHealth,
  onOpenTagManager,
}: {
  library: LibraryState;
  onOpenSettings: () => void;
  onOpenHealth: () => void;
  onOpenTagManager: () => void;
}) {
  const snapshot = library.snapshot;
  const currentFolder = library.viewState.selectedFolderPath;
  const selectedTagPath = library.viewState.selectedTagPath;
  const tags = library.tags.length ? library.tags : (snapshot?.tags ?? []);

  return (
    <aside className="workbench-sidebar affairs-layout-sidebar">
      <div className="workbench-traffic-lights" aria-hidden="true">
        <span className="red" />
        <span className="yellow" />
        <span className="green" />
      </div>
      <div className="workbench-sidebar-tools" aria-label={t("appTitle")}>
        <button
          type="button"
          className="workbench-tool-icon"
          aria-label={t("navLibrary")}
        >
          {renderSidebarGlyph("library")}
        </button>
        <button
          type="button"
          className="workbench-tool-icon"
          aria-label={t("navHealth")}
          onClick={onOpenHealth}
        >
          {renderSidebarGlyph("health")}
        </button>
        <button
          type="button"
          className="workbench-tool-icon"
          aria-label={t("navSettings")}
          onClick={onOpenSettings}
        >
          {renderSidebarGlyph("settings")}
        </button>
      </div>

      <div
        className="workbench-mode-switch"
        role="group"
        aria-label={t("xfileModeSwitchLabel")}
      >
        <button type="button" disabled>
          {t("xfileCodeMode")}
        </button>
        <button type="button" className="active">
          {t("xfileLibraryMode")}
        </button>
      </div>

      <div className="affairs-sidebar-panel">
        <div className="affairs-sidebar-shell">
          <div className="affairs-sidebar-content">
            <div className="affairs-sidebar-groups affairs-library-sidebar-groups">
              <div className="affairs-sidebar-group affairs-sidebar-group-plain affairs-sidebar-primary-nav">
                <SidebarPlainItem
                  active={
                    library.viewState.browseMode === "folder" && !currentFolder
                  }
                  title={t("libraryAllFiles")}
                  count={snapshot?.documentCount ?? 0}
                  icon="folder"
                  onClick={() => library.selectFolder(null)}
                />
              </div>

              <div className="affairs-sidebar-group affairs-sidebar-group-plain affairs-favorites-panel">
                <div className="affairs-sidebar-group-header">
                  <span>{t("libraryFavorites")}</span>
                  <span className="affairs-sidebar-block-count">
                    {snapshot?.favorites.length ?? 0}
                  </span>
                </div>
                <div className="affairs-sidebar-list affairs-sidebar-list-plain">
                  {(snapshot?.favorites.length ?? 0) === 0 ? (
                    <p className="affairs-sidebar-empty">
                      {t("libraryEmptyFavorite")}
                    </p>
                  ) : (
                    snapshot?.favorites.map((favorite) => (
                      <SidebarPlainItem
                        key={`${favorite.kind}:${favorite.path}`}
                        active={
                          library.viewState.selectedFavoriteId === favorite.path
                        }
                        title={
                          favorite.label ||
                          favorite.path ||
                          t("libraryRootFolder")
                        }
                        count={resolveFavoriteKindLabel(favorite.kind)}
                        icon={favorite.kind === "folder" ? "folder" : "tag"}
                        onClick={() => library.selectFavorite(favorite)}
                      />
                    ))
                  )}
                </div>
              </div>

              <div className="affairs-sidebar-group affairs-sidebar-group-plain affairs-tag-tree-panel">
                <div className="affairs-sidebar-group-header">
                  <span className="affairs-tag-tree-title">
                    <span>{t("libraryTags")}</span>
                  </span>
                  <span className="affairs-sidebar-block-count">
                    {tags.length}
                  </span>
                </div>
                <button
                  type="button"
                  className="affairs-sidebar-footer-button"
                  onClick={onOpenTagManager}
                >
                  {renderTagIcon()}
                  {t("libraryTagManagerAction")}
                </button>
                <div className="affairs-sidebar-list affairs-sidebar-list-plain affairs-tag-tree-list">
                  <SidebarPlainItem
                    active={
                      library.viewState.browseMode === "tag" && !selectedTagPath
                    }
                    title={t("libraryTags")}
                    count={snapshot?.documentCount ?? 0}
                    icon="tag"
                    onClick={() => library.selectTag(null)}
                  />
                  {tags.slice(0, 64).map((tag) => (
                    <SidebarPlainItem
                      key={tag.path}
                      active={selectedTagPath === tag.path}
                      title={tag.name}
                      count={tag.documentCount}
                      icon="tag"
                      onClick={() => library.selectTag(tag.path)}
                    />
                  ))}
                </div>
              </div>

              <div className="affairs-sidebar-group affairs-sidebar-group-plain affairs-tag-tree-panel">
                <div className="affairs-sidebar-group-header">
                  <span>{t("libraryFolders")}</span>
                  <span className="affairs-sidebar-block-count">
                    {snapshot?.folders.length ?? 0}
                  </span>
                </div>
                <div className="affairs-sidebar-list affairs-sidebar-list-plain">
                  {(snapshot?.folders ?? []).slice(0, 36).map((folder) => (
                    <SidebarPlainItem
                      key={folder.path}
                      active={currentFolder === folder.path}
                      title={folder.name || getPathName(folder.path)}
                      count={folder.documentCount}
                      icon="folder"
                      onClick={() => library.selectFolder(folder.path)}
                    />
                  ))}
                </div>
              </div>
            </div>
          </div>

          <footer className="workbench-sidebar-footer">
            <button
              type="button"
              className="workbench-sidebar-footer-button"
              onClick={onOpenSettings}
            >
              {renderSidebarGlyph("settings")}
              {t("navSettings")}
            </button>
            <span className="workbench-device-pill">{t("appTitle")}</span>
          </footer>
        </div>
      </div>
    </aside>
  );
}

function SidebarPlainItem({
  active,
  title,
  count,
  icon,
  onClick,
}: {
  active: boolean;
  title: string;
  count: string | number;
  icon: "folder" | "tag";
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={
        active ? "affairs-sidebar-item active" : "affairs-sidebar-item"
      }
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
  const busy = saving || browserLoading;

  useEffect(() => {
    if (!rootDir.trim() && pendingBindingRootDir) {
      setRootDir(pendingBindingRootDir);
    }
  }, [pendingBindingRootDir, rootDir]);

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
}) {
  const currentPath =
    library.viewState.browseMode === "folder"
      ? library.viewState.selectedFolderPath
      : library.viewState.selectedTagPath;
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
        onOpenSettings={onOpenSettings}
        onRequestCreate={onRequestCreate}
      />
      <div
        className="affairs-stage-content"
        onContextMenu={(event) => onOpenContextMenu(event, blankTarget)}
      >
        <div className="affairs-stage-meta-row">
          <span>
            {currentPath ? getPathName(currentPath) : t("libraryRootFolder")}
          </span>
          <span>
            {t("libraryCountDocuments", {
              count:
                library.documentPage?.total ??
                library.snapshot?.documentCount ??
                0,
            })}
          </span>
          {directoryStatus ? (
            <span>
              {resolveDirectoryStateLabel(directoryStatus.state)} ·{" "}
              {resolveDirectorySourceLabel(directoryStatus.source)}
            </span>
          ) : null}
        </div>
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
          />
        ) : (
          <VirtualLibraryFinderList
            library={library}
            entries={library.entries}
            onOpenContextMenu={onOpenContextMenu}
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
  directoryStatus,
  onOpenSettings,
  onRequestCreate,
}: {
  library: LibraryState;
  directoryStatus: {
    state: LibraryDirectoryState;
    source: LibraryDirectorySource;
    errorSummary?: string | null;
  } | null;
  onOpenSettings: () => void;
  onRequestCreate: (state: PendingCreateState) => void;
}) {
  return (
    <div className="affairs-stage-toolbar">
      <div className="affairs-stage-toolbar-left">
        <div
          className="affairs-stage-breadcrumb"
          aria-label={t("libraryCurrentFolder")}
        >
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
            className={
              library.viewState.viewMode === "grid"
                ? "affairs-stage-toolbar-icon active"
                : "affairs-stage-toolbar-icon"
            }
            onClick={() =>
              library.setViewState((current) => ({
                ...current,
                viewMode: "grid",
              }))
            }
            aria-label={t("libraryViewGrid")}
            title={t("libraryViewGrid")}
          >
            {renderGridIcon()}
          </button>
          <button
            type="button"
            className={
              library.viewState.viewMode === "list"
                ? "affairs-stage-toolbar-icon active"
                : "affairs-stage-toolbar-icon"
            }
            onClick={() =>
              library.setViewState((current) => ({
                ...current,
                viewMode: "list",
              }))
            }
            aria-label={t("libraryViewList")}
            title={t("libraryViewList")}
          >
            {renderListIcon()}
          </button>
        </div>
        <div className="affairs-stage-toolbar-group xfile-search-group">
          {renderSearchIcon()}
          <input
            className="affairs-stage-toolbar-search"
            value={library.viewState.keyword}
            placeholder={t("libraryKeywordPlaceholder")}
            onChange={(event) =>
              library.setViewState((current) => ({
                ...current,
                keyword: event.target.value,
              }))
            }
          />
        </div>
        <div className="affairs-stage-toolbar-group">
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
            <option value="recent">{t("librarySortRecent")}</option>
            <option value="name">{t("librarySortName")}</option>
            <option value="type">{t("librarySortType")}</option>
            <option value="size">{t("librarySortSize")}</option>
            <option value="createdAt">{t("librarySortCreatedAt")}</option>
          </select>
        </div>
        <div className="affairs-stage-toolbar-group">
          <button
            type="button"
            className="affairs-stage-toolbar-segment"
            onClick={() =>
              library.setViewState((current) => ({
                ...current,
                librarySort: {
                  ...current.librarySort,
                  direction:
                    current.librarySort.direction === "desc"
                      ? "asc"
                      : ("desc" as LibrarySortDirection),
                },
              }))
            }
          >
            {library.viewState.librarySort.direction === "desc"
              ? t("librarySortDesc")
              : t("librarySortAsc")}
          </button>
        </div>
        <div className="affairs-stage-toolbar-group">
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
        </div>
        <div className="affairs-stage-toolbar-group">
          <button
            type="button"
            className="affairs-stage-status-trigger"
            title={resolveIndexStatusLabel(library.snapshot?.status.state)}
          >
            <span
              className={`affairs-stage-status-dot state-${resolveStatusDotState(library.snapshot?.status.state)}`}
            />
            {directoryStatus?.errorSummary ? (
              <span className="affairs-stage-status-text">
                {directoryStatus.errorSummary}
              </span>
            ) : null}
          </button>
        </div>
        {library.viewState.browseMode === "folder" ? (
          <div className="affairs-stage-toolbar-group">
            <button
              type="button"
              className="affairs-stage-toolbar-segment"
              onClick={() =>
                onRequestCreate({
                  kind: "directory",
                  folderPath: library.viewState.selectedFolderPath,
                  fileName: "",
                })
              }
            >
              {t("libraryCreateFolder")}
            </button>
            <button
              type="button"
              className="affairs-stage-toolbar-segment"
              onClick={() =>
                onRequestCreate({
                  kind: "markdown",
                  folderPath: library.viewState.selectedFolderPath,
                  fileName: "",
                })
              }
            >
              {t("libraryCreateFile")}
            </button>
          </div>
        ) : null}
        <div className="affairs-stage-toolbar-group">
          <button
            type="button"
            className="affairs-stage-toolbar-icon"
            onClick={onOpenSettings}
            aria-label={t("navSettings")}
            title={t("navSettings")}
          >
            {renderSettingsIcon()}
          </button>
        </div>
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
  onSelectFolder: (path: string | null) => void;
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
                  ? onSelectFolder(nextPath)
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
}: {
  library: LibraryState;
  entries: LibraryEntry[];
  onOpenContextMenu: (
    event: ReactMouseEvent<HTMLElement>,
    target: LibraryContextMenuTarget,
  ) => void;
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
  const metrics = computeVirtualGridMetrics(
    entries.length,
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
    entries.length,
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
            key={`${slot.entry.kind}:${slot.entry.kind === "folder" ? slot.entry.path : slot.entry.documentId}`}
            entry={slot.entry}
            library={library}
            onOpenContextMenu={onOpenContextMenu}
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
}: {
  library: LibraryState;
  entries: LibraryEntry[];
  onOpenContextMenu: (
    event: ReactMouseEvent<HTMLElement>,
    target: LibraryContextMenuTarget,
  ) => void;
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
    const sync = () =>
      setViewport((current) => ({
        ...current,
        height: element.clientHeight,
        scrollTop: clampScrollTop(
          element.scrollTop,
          entries.length,
          measuredRowHeight,
          element.clientHeight,
        ),
      }));
    sync();
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(sync);
    observer?.observe(element);
    return () => observer?.disconnect();
  }, [entries.length, measuredRowHeight]);

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

  const metrics = computeVirtualListMetrics(
    entries.length,
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
      entries.length,
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
    if (
      metrics.endIndex >= entries.length - preloadRows ||
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
                  key={`${slot.entry.kind}:${slot.entry.kind === "folder" ? slot.entry.path : slot.entry.documentId}`}
                  entry={slot.entry}
                  library={library}
                  gridTemplateColumns={finderGridTemplateColumns}
                  onOpenContextMenu={onOpenContextMenu}
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
}: {
  entry: LibraryEntry;
  library: LibraryState;
  onOpenContextMenu: (
    event: ReactMouseEvent<HTMLElement>,
    target: LibraryContextMenuTarget,
  ) => void;
}) {
  if (entry.kind === "folder") {
    const active = library.viewState.selectedFolderEntryPath === entry.path;
    return (
      <button
        type="button"
        className={
          active ? "affairs-doc-item grid active" : "affairs-doc-item grid"
        }
        onClick={() => handleFolderClick(library, entry.path)}
        onDoubleClick={() => library.selectFolder(entry.path)}
        onContextMenu={(event) => {
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
      onDoubleClick={() => void library.openPreview(entry.path)}
    >
      <div className="affairs-doc-icon">{renderDocumentShape(entry.path)}</div>
      <div
        className="affairs-doc-title"
        title={entry.title || t("libraryUntitled")}
      >
        {entry.title || t("libraryUntitled")}
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
}: {
  entry: LibraryEntry;
  library: LibraryState;
  gridTemplateColumns: string;
  onOpenContextMenu: (
    event: ReactMouseEvent<HTMLElement>,
    target: LibraryContextMenuTarget,
  ) => void;
}) {
  if (entry.kind === "folder") {
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
        onClick={() => handleFolderClick(library, entry.path)}
        onDoubleClick={() => library.selectFolder(entry.path)}
        onContextMenu={(event) => {
          library.selectFolderEntry(entry.path);
          onOpenContextMenu(event, { kind: "folder", entry });
        }}
      >
        <span className="affairs-finder-name-cell">
          <span className="affairs-finder-icon">
            {renderFolderShape("row")}
          </span>
          <span className="affairs-finder-name" title={entry.name}>
            {entry.name}
          </span>
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
      onDoubleClick={() => void library.openPreview(entry.path)}
    >
      <span className="affairs-finder-name-cell">
        <span className="affairs-finder-icon">
          {renderDocumentShape(entry.path, "row")}
        </span>
        <span
          className="affairs-finder-name"
          title={entry.title || t("libraryUntitled")}
        >
          {entry.title || t("libraryUntitled")}
        </span>
      </span>
      <span className="affairs-finder-cell">
        {formatBytes(entry.sizeBytes)}
      </span>
      <span className="affairs-finder-cell">
        {formatDateTime(entry.updatedAt)}
      </span>
      <span className="affairs-finder-cell">
        {resolveDocumentVisual(entry.path).extension.toUpperCase()}
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
}: {
  library: LibraryState;
  onRequestRename: (path: string) => void;
  onRequestDelete: (target: LibraryContextMenuTarget) => void;
}) {
  const selected = library.selectedDocument;
  const preview = library.preview;

  return (
    <aside className="affairs-detail-panel library-detail">
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
      {!selected ? (
        <div className="affairs-detail-empty">{t("libraryNoSelection")}</div>
      ) : (
        <div className="affairs-detail-scroll">
          <section className="affairs-detail-block affairs-detail-summary-block">
            <span className="affairs-detail-eyebrow">
              {t("libraryDetails")}
            </span>
            <div className="affairs-detail-title-block">
              <div className="affairs-doc-icon detail-doc-icon">
                {renderDocumentShape(selected.path, "row")}
              </div>
              <h2>{selected.title || t("libraryUntitled")}</h2>
              {selected.summary ? <p>{selected.summary}</p> : null}
            </div>
            <button type="button" className="affairs-detail-link-button">
              {t("libraryExpandText")}
            </button>
            <DetailRow label={t("libraryMetaPath")} value={selected.path} />
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
          </section>

          <section className="affairs-detail-block">
            <div className="affairs-detail-headline">
              <h3>{t("libraryMetaTags")}</h3>
              <p>{t("libraryTagRecommend")}</p>
            </div>
            <TagPills items={[...selected.tags, ...selected.derivedTags]} />
            <DocumentTagEditor
              key={selected.documentId}
              library={library}
              documentId={selected.documentId}
            />
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
      )}
    </aside>
  );
}

function LibraryContextMenu({
  state,
  library,
  libraryClipboard,
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
              return library.openPreview(target.entry.path);
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
      >
        <input
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
}: {
  library: LibraryState;
  target: PendingTagAssignmentTarget;
  onClose: () => void;
}) {
  const [value, setValue] = useState("");
  const [details, setDetails] = useState<
    LibraryDocumentTagDetails | LibraryFolderTagDetails | null
  >(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const request =
      target.kind === "document"
        ? getDocumentTagDetails(target.documentId)
        : getFolderTagDetails(target.folderPath);
    void request
      .then((nextDetails) => {
        if (cancelled) return;
        setDetails(nextDetails);
        setValue(resolveTagAssignmentInitialValue(nextDetails));
      })
      .catch((err) => {
        if (!cancelled) setError(toApiErrorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [target]);

  async function submit(): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      if (target.kind === "document") {
        await saveDocumentTags(target.documentId, {
          createTagPaths: splitTagInput(value),
        });
      } else {
        await saveFolderTags({
          folderPath: target.folderPath,
          createTagPaths: splitTagInput(value),
        });
      }
      await library.reload();
      await library.reloadDocuments(true);
      onClose();
    } catch (err) {
      setError(toApiErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  const recommendations = details?.recommendedTags ?? [];

  return (
    <DesktopModal
      title={t("libraryTagAssignmentModalTitle")}
      description={t("libraryTagAssignmentModalDescription", {
        name: target.title,
      })}
      onClose={onClose}
      dismissible={!saving}
      footer={
        <ModalActions>
          <button
            type="button"
            className="secondary-button"
            disabled={saving}
            onClick={onClose}
          >
            {t("actionCancel")}
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={saving || loading}
            onClick={() => void submit()}
          >
            {saving ? t("settingsSaving") : t("librarySaveTags")}
          </button>
        </ModalActions>
      }
    >
      {loading ? (
        <ModalEmptyState title={t("libraryTagAssignmentLoading")} compact />
      ) : null}
      <ModalField
        label={t("libraryTagAssignmentTagsLabel")}
        description={t("libraryTagAssignmentTagsDescription")}
      >
        <input
          value={value}
          autoFocus
          placeholder={t("libraryEditTagsPlaceholder")}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void submit();
          }}
        />
      </ModalField>
      {recommendations.length ? (
        <ModalSection
          heading={t("libraryTagAssignmentRecommendations")}
          className="affairs-tag-assignment-recommendations"
        >
          <div className="tag-group">
            {recommendations.map((item) => (
              <button
                key={item.path}
                type="button"
                className="modal-tag-button"
                onClick={() =>
                  setValue((current) => appendTagPath(current, item.path))
                }
                title={item.evidence}
              >
                <ModalTag tone="accent">{item.name}</ModalTag>
              </button>
            ))}
          </div>
        </ModalSection>
      ) : null}
      {error ? (
        <div className="affairs-binding-hint affairs-create-error">{error}</div>
      ) : null}
    </DesktopModal>
  );
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

function LibraryTagManagerModal({
  library,
  onClose,
}: {
  library: LibraryState;
  onClose: () => void;
}) {
  const [tags, setTags] = useState<LibraryTagDetailWithRules[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [parentId, setParentId] = useState<string | null>(null);
  const [status, setStatus] = useState<"active" | "disabled">("active");
  const [smartRules, setSmartRules] = useState<EditableLibraryTagRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [recomputing, setRecomputing] = useState(false);
  const [recomputeMessage, setRecomputeMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selected = tags.find((tag) => tag.id === selectedId) ?? null;

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
    setParentId(tag?.parentId ?? null);
    setStatus(tag?.status ?? "active");
    setSmartRules(cloneLibraryTagRules(tag?.smartRules ?? []));
  }

  useEffect(() => {
    void loadTags(null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;
    async function poll(): Promise<void> {
      try {
        const task = await getLibraryTagRecomputeTask();
        if (cancelled) return;
        if (!task) {
          setRecomputeMessage(null);
          setRecomputing(false);
          return;
        }
        setRecomputing(task.state === "queued" || task.state === "running");
        setRecomputeMessage(formatLibraryTagRecomputeTask(task));
        if (task.state === "queued" || task.state === "running") {
          timer = window.setTimeout(() => void poll(), 1200);
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
      if (timer !== null) window.clearTimeout(timer);
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
    if (!selected) return;
    setSaving(true);
    setError(null);
    try {
      const tag = await createLibraryTag({
        name: buildUniqueTagDraftName(tags, t("libraryTagNewChildName")),
        parentId: selected.id,
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
    if (!selected) return;
    setSaving(true);
    setError(null);
    try {
      const tag = await updateLibraryTag(selected.id, {
        name,
        parentId,
        description: description.trim() || null,
        status,
        smartRules: smartRules.map((rule, index) => ({
          ...rule,
          priority: index,
          matcher: normalizeLibraryTagRuleMatcher(rule),
        })),
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
      !selected ||
      !window.confirm(t("libraryTagDeleteConfirm", { tag: selected.path }))
    ) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await deleteLibraryTag(selected.id);
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

  const parentOptions = tags.filter(
    (tag) =>
      tag.id !== selectedId && !isTagDescendant(tags, tag.id, selectedId),
  );

  return (
    <DesktopModal
      title={t("libraryTagManagerTitle")}
      description={t("libraryTagManagerDescription")}
      onClose={onClose}
      dismissible={!saving}
      footer={
        <ModalActions>
          <button
            type="button"
            className="secondary-button"
            disabled={saving}
            onClick={onClose}
          >
            {t("actionClose")}
          </button>
        </ModalActions>
      }
    >
      {error ? (
        <div className="affairs-binding-hint affairs-create-error">{error}</div>
      ) : null}
      <div className="library-tag-manager-grid">
        <ModalSection
          heading={t("libraryTagTreeSectionTitle")}
          actions={
            <button
              type="button"
              className="secondary-button"
              disabled={saving}
              onClick={() => void createRootTag()}
            >
              {t("libraryTagCreateRootAction")}
            </button>
          }
        >
          {loading ? (
            <ModalEmptyState title={t("libraryTagAssignmentLoading")} compact />
          ) : null}
          {!loading && tags.length === 0 ? (
            <ModalEmptyState title={t("libraryTagTreeEmpty")} compact />
          ) : null}
          <div className="library-tag-manager-list">
            {tags.map((tag) => (
              <button
                key={tag.id}
                type="button"
                className={selectedId === tag.id ? "active" : undefined}
                style={{
                  paddingLeft: `${12 + tag.path.split("/").length * 12}px`,
                }}
                onClick={() => applySelectedTag(tag)}
              >
                <span>{tag.name}</span>
                <small>
                  {tag.status === "disabled"
                    ? t("libraryTagDisabled")
                    : `${tag.documentCount}`}
                </small>
              </button>
            ))}
          </div>
        </ModalSection>

        <ModalSection
          heading={
            selected
              ? t("libraryTagEditorEditTitle")
              : t("libraryTagEditorEmptyTitle")
          }
          actions={
            selected ? (
              <button
                type="button"
                className="secondary-button"
                disabled={saving}
                onClick={() => void createChildTag()}
              >
                {t("libraryTagCreateChildAction")}
              </button>
            ) : null
          }
        >
          {!selected ? (
            <ModalEmptyState
              title={t("libraryTagEditorEmptyDescription")}
              compact
            />
          ) : (
            <>
              <ModalField label={t("libraryTagNameLabel")}>
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </ModalField>
              <ModalField label={t("libraryTagParentLabel")}>
                <select
                  value={parentId ?? ""}
                  onChange={(event) => setParentId(event.target.value || null)}
                >
                  <option value="">{t("libraryTagParentRootOption")}</option>
                  {parentOptions.map((tag) => (
                    <option key={tag.id} value={tag.id}>
                      {tag.path}
                    </option>
                  ))}
                </select>
              </ModalField>
              <ModalField label={t("libraryTagDescriptionLabel")}>
                <textarea
                  value={description}
                  rows={3}
                  onChange={(event) => setDescription(event.target.value)}
                />
              </ModalField>
              <ModalField label={t("libraryTagStatusLabel")}>
                <select
                  value={status}
                  onChange={(event) =>
                    setStatus(
                      event.target.value === "disabled" ? "disabled" : "active",
                    )
                  }
                >
                  <option value="active">{t("libraryTagStatusActive")}</option>
                  <option value="disabled">
                    {t("libraryTagStatusDisabled")}
                  </option>
                </select>
              </ModalField>
              <ModalSection
                className="library-tag-smart-rules-section"
                heading={t("libraryTagSmartRulesSectionTitle")}
                description={t("libraryTagSmartRulesSectionDescription")}
                actions={
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={saving}
                    onClick={() =>
                      setSmartRules((current) => [
                        ...current,
                        createEditableLibraryTagRule(current.length),
                      ])
                    }
                  >
                    {t("libraryTagSmartRuleAddAction")}
                  </button>
                }
              >
                {smartRules.length === 0 ? (
                  <ModalEmptyState
                    title={t("libraryTagSmartRulesEmpty")}
                    description={t("libraryTagSmartRulesEmptyDescription")}
                    compact
                  />
                ) : (
                  <div className="library-tag-smart-rule-list">
                    {smartRules.map((rule, index) => (
                      <div
                        key={rule.id}
                        className="library-tag-smart-rule-card"
                      >
                        <div className="library-tag-smart-rule-header">
                          <strong>
                            {t("libraryTagSmartRuleOrderHint", {
                              index: index + 1,
                            })}
                          </strong>
                          <label className="library-tag-smart-rule-enabled">
                            <input
                              type="checkbox"
                              checked={rule.enabled !== false}
                              disabled={saving}
                              onChange={(event) => {
                                const enabled = event.target.checked;
                                setSmartRules((current) =>
                                  current.map((item) =>
                                    item.id === rule.id
                                      ? { ...item, enabled }
                                      : item,
                                  ),
                                );
                              }}
                            />
                            {t("libraryTagSmartRuleEnabledLabel")}
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
                        <div className="library-tag-smart-rule-grid">
                          <ModalField
                            label={t("libraryTagSmartRuleRelationLabel")}
                          >
                            <select
                              value={rule.relation}
                              disabled={saving}
                              onChange={(event) => {
                                const relation = event.target
                                  .value as LibraryTagRule["relation"];
                                setSmartRules((current) =>
                                  current.map((item) =>
                                    item.id === rule.id
                                      ? { ...item, relation }
                                      : item,
                                  ),
                                );
                              }}
                            >
                              {(["and", "or", "not"] as const).map(
                                (relation) => (
                                  <option key={relation} value={relation}>
                                    {resolveLibraryTagRuleRelationLabel(
                                      relation,
                                    )}
                                  </option>
                                ),
                              )}
                            </select>
                          </ModalField>
                          <ModalField label={t("libraryTagSmartRuleTypeLabel")}>
                            <select
                              value={rule.ruleType}
                              disabled={saving}
                              onChange={(event) => {
                                const ruleType = event.target
                                  .value as LibraryTagRule["ruleType"];
                                setSmartRules((current) =>
                                  current.map((item) =>
                                    item.id === rule.id
                                      ? {
                                          ...item,
                                          ruleType,
                                          matcher:
                                            buildDefaultLibraryTagRuleMatcher(
                                              ruleType,
                                            ),
                                        }
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
                        <div className="library-tag-smart-rule-value">
                          {rule.ruleType === "file_name_contains" ||
                          rule.ruleType === "file_content_contains" ? (
                            <ModalField
                              label={t("libraryTagSmartRuleKeywordLabel")}
                            >
                              <input
                                value={String(
                                  (rule.matcher as { keyword?: string })
                                    .keyword ?? "",
                                )}
                                disabled={saving}
                                placeholder={t(
                                  "libraryTagSmartRuleKeywordPlaceholder",
                                )}
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
                            <ModalField
                              label={t("libraryTagSmartRuleExtensionsLabel")}
                            >
                              <input
                                value={
                                  Array.isArray(
                                    (rule.matcher as { extensions?: string[] })
                                      .extensions,
                                  )
                                    ? (
                                        (
                                          rule.matcher as {
                                            extensions?: string[];
                                          }
                                        ).extensions ?? []
                                      ).join(", ")
                                    : ""
                                }
                                disabled={saving}
                                placeholder={t(
                                  "libraryTagSmartRuleExtensionsPlaceholder",
                                )}
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
                            <div className="library-tag-smart-rule-grid">
                              <ModalField
                                label={t(
                                  "libraryTagSmartRuleModifiedStartLabel",
                                )}
                              >
                                <input
                                  type="datetime-local"
                                  value={String(
                                    (rule.matcher as { start?: string })
                                      .start ?? "",
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
                                                ...(item.matcher as Record<
                                                  string,
                                                  unknown
                                                >),
                                                start,
                                              },
                                            }
                                          : item,
                                      ),
                                    );
                                  }}
                                />
                              </ModalField>
                              <ModalField
                                label={t("libraryTagSmartRuleModifiedEndLabel")}
                              >
                                <input
                                  type="datetime-local"
                                  value={String(
                                    (rule.matcher as { end?: string }).end ??
                                      "",
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
                                                ...(item.matcher as Record<
                                                  string,
                                                  unknown
                                                >),
                                                end,
                                              },
                                            }
                                          : item,
                                      ),
                                    );
                                  }}
                                />
                              </ModalField>
                            </div>
                          ) : null}
                          {rule.ruleType === "document_path_in_folder" ? (
                            <ModalField
                              label={t("libraryTagSmartRuleFolderPathLabel")}
                            >
                              <input
                                value={String(
                                  (
                                    rule.matcher as {
                                      folderPath?: string | null;
                                    }
                                  ).folderPath ?? ".",
                                )}
                                disabled={saving}
                                placeholder={t(
                                  "libraryTagSmartRuleFolderPathPlaceholder",
                                )}
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
              </ModalSection>
              <ModalSection
                className="library-tag-recovery-section"
                heading={t("libraryTagRecoverySectionTitle")}
                description={t("libraryTagRecoverySectionDescription")}
              >
                <div className="library-tag-recovery-status">
                  <span>
                    {recomputeMessage ?? t("libraryTagRecoveryStatusIdle")}
                  </span>
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={saving || recomputing}
                    onClick={() => void requestRecompute()}
                  >
                    {recomputing
                      ? t("libraryTagRecoveryRunningAction")
                      : t("libraryTagRecoveryAction")}
                  </button>
                </div>
              </ModalSection>
              <ModalActions align="between">
                <button
                  type="button"
                  className="danger-button"
                  disabled={saving}
                  onClick={() => void deleteSelected()}
                >
                  {t("libraryTagDeleteAction")}
                </button>
                <button
                  type="button"
                  className="primary-button"
                  disabled={saving}
                  onClick={() => void saveSelected()}
                >
                  {saving ? t("settingsSaving") : t("libraryTagSaveAction")}
                </button>
              </ModalActions>
            </>
          )}
        </ModalSection>
      </div>
    </DesktopModal>
  );
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

function TagPills({ items }: { items: string[] }) {
  return (
    <div className="tag-group">
      {items.length ? (
        items.map((item) => <mark key={item}>{item}</mark>)
      ) : (
        <small>{t("libraryNoTags")}</small>
      )}
    </div>
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

function handleFolderClick(library: LibraryState, path: string): void {
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
    ? target.entry.title || getPathName(target.entry.path)
    : target.entry.name || getPathName(target.entry.path);
}

function resolveTargetAbsolutePath(
  library: LibraryState,
  target: Extract<LibraryContextMenuTarget, { kind: "document" | "folder" }>,
): string | null {
  const root =
    library.snapshot?.binding?.rootDir.trim().replace(/\/+$/g, "") ?? "";
  const relativePath = resolveContextPath(target).trim().replace(/^\/+/, "");
  if (!root || !relativePath) return null;
  return `${root}/${relativePath}`.replace(/\/{2,}/g, "/");
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
      title: target.entry.title || getPathName(target.entry.path),
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

function renderSidebarGlyph(kind: "library" | "health" | "settings") {
  if (kind === "settings") return renderSettingsIcon();
  if (kind === "health")
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path
          d="M2.5 8.5h2.2l1.2-3.1 2.2 6.2 1.7-4.1h3.7"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  return renderMiniFolderIcon();
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
