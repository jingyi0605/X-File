import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  LibraryBinding,
  LibraryDocumentRecord,
  LibraryDocumentList,
  LibraryFavoriteRecord,
  LibraryFileList,
  LibraryFileNode,
  LibraryIndexStatus,
  LibraryOperationType,
  LibraryPreview,
  LibrarySnapshot,
  LibraryTagNode
} from "@x-file/shared";

import {
  downloadLibraryFile,
  getLibraryPreview,
  getLibrarySnapshot,
  listLibraryDocuments,
  listLibraryFiles,
  listLibraryTags,
  operateLibraryFile,
  requestLibraryRefresh,
  saveLibraryBinding,
  updateLibraryFavorites
} from "../../api/library";
import { toApiErrorMessage } from "../../api/http";
import {
  fetchNativeLibraryStatus,
  fetchNativeLibrarySnapshot,
  getNativeLibraryPreview,
  getNativeOnlyOfficePreview,
  listNativeLibraryDocuments,
  listNativeLibraryFiles,
  requestNativeLibraryRefresh,
  startNativeLibraryWatcher,
  stopNativeLibraryWatcher,
} from "../../runtime/native-library-bridge";
import { getRuntimeConfigSnapshot } from "../../runtime/runtime-config-store";
import { getPathName } from "../../shared/format";
import {
  createDefaultLibraryViewState,
  readLibraryViewState,
  sortLibraryEntries,
  writeLibraryViewState,
  type LibraryEntry,
  type LibraryViewState
} from "./library-view-state";

const DOCUMENT_PAGE_LIMIT = 60;
const FILE_LIST_LIMIT = 200;
const RUNNING_INDEX_POLL_INTERVAL_MS = 4000;
const DIRECTORY_PRIORITY_POLL_INTERVAL_MS = 800;
const DIRECTORY_PRIORITY_POLL_COUNT = 12;
const SUMMARY_BACKFILL_DIRECTORY_POLL_INTERVAL_MS = 3000;
let activeNativeWatcherRootDir: string | null = null;

function normalizeLibraryIndexStatus(
  status: Partial<LibraryIndexStatus> | null | undefined,
): LibraryIndexStatus {
  return {
    state: typeof status?.state === "string" && status.state.trim() ? status.state : "fresh",
    dirtyReasons: Array.isArray(status?.dirtyReasons) ? status.dirtyReasons : [],
    lastRequestedAt: status?.lastRequestedAt ?? null,
    lastStartedAt: status?.lastStartedAt ?? null,
    lastCompletedAt: status?.lastCompletedAt ?? null,
    lastFailedAt: status?.lastFailedAt ?? null,
    nextAllowedAt: status?.nextAllowedAt ?? null,
    runningTaskId: status?.runningTaskId ?? null,
    runningStage: status?.runningStage ?? null,
    errorSummary: status?.errorSummary ?? null,
    workerHealth: status?.workerHealth ?? null,
    progress: status?.progress ?? null,
    runtimeIndexState: status?.runtimeIndexState ?? null,
  };
}

function isLiveIndexState(state: string | null | undefined): boolean {
  return state === "queued" || state === "running" || state === "stale" || state === "queue_timeout";
}

function isSummaryBackfillStage(stage: string | null | undefined): boolean {
  return stage === "summary_backfill" || stage === "summary_backfill_search";
}

type LibraryDebugTransport = "native" | "http" | "idle";

interface LibraryDebugChannelState {
  transport: LibraryDebugTransport;
  detail: string;
  updatedAt: string | null;
}

interface LibraryDebugState {
  enabled: boolean;
  runtime: "desktop-tauri" | "web";
  mode: "local" | "mirror";
  nativeBridgeEligible: boolean;
  nativeBridgeAvailable: boolean;
  watcher: LibraryDebugChannelState;
  health: LibraryDebugChannelState;
  snapshot: LibraryDebugChannelState;
  documents: LibraryDebugChannelState;
  files: LibraryDebugChannelState;
  preview: LibraryDebugChannelState;
  refresh: LibraryDebugChannelState;
}

export interface LibraryState {
  viewState: LibraryViewState;
  snapshot: LibrarySnapshot | null;
  requiresInitialization: boolean;
  initializationRedirectPath: string;
  tags: LibraryTagNode[];
  documentPage: LibraryDocumentList | null;
  fileItems: LibraryFileNode[];
  preview: LibraryPreview | null;
  loading: boolean;
  documentsLoading: boolean;
  previewLoading: boolean;
  refreshPending: boolean;
  error: string | null;
  previewError: string | null;
  entries: LibraryEntry[];
  visibleEntryTotal: number;
  hasMore: boolean;
  selectedDocument: LibraryEntry & { kind: "document" } | null;
  selectedDocuments: Array<LibraryEntry & { kind: "document" }>;
  selectedFolderEntries: Array<Extract<LibraryEntry, { kind: "folder" | "tag-directory" }>>;
  debug: LibraryDebugState;
  setViewState: (updater: LibraryViewState | ((current: LibraryViewState) => LibraryViewState)) => void;
  bindLibrary: (rootDir: string) => Promise<LibraryBinding>;
  reload: () => Promise<void>;
  reloadDocuments: (reset?: boolean) => Promise<void>;
  loadMore: () => Promise<void>;
  refresh: () => Promise<void>;
  selectFolder: (path: string | null, selectedEntryPath?: string | null) => void;
  selectFolderEntry: (path: string | null) => void;
  toggleFolderEntrySelection: (path: string, additive?: boolean) => void;
  selectTag: (path: string | null) => void;
  selectFavorite: (favorite: LibraryFavoriteRecord) => void;
  selectDocument: (documentId: string) => void;
  toggleDocumentSelection: (documentId: string, additive?: boolean) => void;
  openPreview: (path: string) => Promise<void>;
  downloadSelected: (path: string) => Promise<void>;
  toggleFavorite: (favorite: LibraryFavoriteRecord) => Promise<void>;
  operateFile: (input: {
    opType: LibraryOperationType;
    srcPath?: string;
    dstPath?: string | null;
    content?: string | null;
    expectedVersion?: string | null;
  }) => Promise<void>;
}

export function useLibraryState(): LibraryState {
  const [viewState, setViewStateState] = useState(() => readLibraryViewState("default"));
  const [snapshot, setSnapshot] = useState<LibrarySnapshot | null>(null);
  const [tags, setTags] = useState<LibraryTagNode[]>([]);
  const [documentPage, setDocumentPage] = useState<LibraryDocumentList | null>(null);
  const [fileItems, setFileItems] = useState<LibraryFileNode[]>([]);
  const [preview, setPreview] = useState<LibraryPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [documentsLoading, setDocumentsLoading] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [refreshPending, setRefreshPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const nativeWatcherRootDirRef = useRef<string | null>(activeNativeWatcherRootDir);
  const listSignatureRef = useRef<{ queryKey: string; signature: string } | null>(null);
  const [debugChannels, setDebugChannels] = useState<Record<keyof Omit<LibraryDebugState, "enabled" | "runtime" | "mode" | "nativeBridgeEligible" | "nativeBridgeAvailable">, LibraryDebugChannelState>>(() => ({
    watcher: createIdleDebugChannelState("未尝试"),
    health: createIdleDebugChannelState("未读取"),
    snapshot: createIdleDebugChannelState("未读取"),
    documents: createIdleDebugChannelState("未读取"),
    files: createIdleDebugChannelState("未读取"),
    preview: createIdleDebugChannelState("未读取"),
    refresh: createIdleDebugChannelState("未触发"),
  }));
  const folderDocumentCountMap = useMemo(
    () => buildFolderDocumentCountMap(snapshot?.folders ?? []),
    [snapshot?.folders],
  );

  const entries = useMemo(
    () => buildVisibleEntries(folderDocumentCountMap, documentPage, fileItems, viewState),
    [
      documentPage,
      fileItems,
      folderDocumentCountMap,
      viewState.browseMode,
      viewState.librarySort,
      viewState.selectedTagPaths.length,
      viewState.tagResultStructureMode,
      viewState.viewMode
    ]
  );
  const visibleEntryTotal = useMemo(
    () => resolveVisibleEntryTotal(documentPage, fileItems, entries.length, viewState),
    [documentPage, entries.length, fileItems, viewState.browseMode]
  );

  const selectedDocument = useMemo(
    () => entries.find((entry): entry is LibraryEntry & { kind: "document" } => {
      return entry.kind === "document" && entry.documentId === viewState.selectedDocumentId;
    }) ?? null,
    [entries, viewState.selectedDocumentId]
  );
  const selectedDocuments = useMemo(
    () =>
      entries.filter((entry): entry is LibraryEntry & { kind: "document" } => {
        return entry.kind === "document" && viewState.selectedDocumentIds.includes(entry.documentId);
      }),
    [entries, viewState.selectedDocumentIds]
  );
  const selectedFolderEntries = useMemo(
    () =>
      entries.filter((entry): entry is Extract<LibraryEntry, { kind: "folder" | "tag-directory" }> => {
        return entry.kind !== "document" && viewState.selectedFolderEntryPaths.includes(entry.path);
      }),
    [entries, viewState.selectedFolderEntryPaths]
  );

  const requiresInitialization = snapshot?.requiresInitialization === true;
  const initializationRedirectPath = snapshot?.initializationRedirectPath ?? "/init";
  const hasMore = (documentPage?.items.length ?? 0) < (documentPage?.total ?? 0);

  const setViewState = useCallback((updater: LibraryViewState | ((current: LibraryViewState) => LibraryViewState)): void => {
    setViewStateState((current) => {
      const next = typeof updater === "function" ? updater(current) : updater;
      writeLibraryViewState(next);
      return next;
    });
  }, []);

  const runtimeConfig = getRuntimeConfigSnapshot().config;
  const nativeBridgeEligible = runtimeConfig.mode === "local";
  const nativeBridgeAvailable = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

  function shouldUseNativeLibraryBridge(): boolean {
    return nativeBridgeEligible && nativeBridgeAvailable;
  }

  function updateDebugChannel(
    channel: keyof typeof debugChannels,
    transport: LibraryDebugTransport,
    detail: string,
  ): void {
    setDebugChannels((current) => ({
      ...current,
      [channel]: {
        transport,
        detail,
        updatedAt: new Date().toISOString(),
      },
    }));
  }

  const debug = useMemo<LibraryDebugState>(() => ({
    enabled: import.meta.env.DEV,
    runtime: nativeBridgeAvailable ? "desktop-tauri" : "web",
    mode: runtimeConfig.mode,
    nativeBridgeEligible,
    nativeBridgeAvailable,
    ...debugChannels,
  }), [debugChannels, nativeBridgeAvailable, nativeBridgeEligible, runtimeConfig.mode]);

  async function syncNativeLibraryWatcher(rootDir: string | null): Promise<void> {
    if (!shouldUseNativeLibraryBridge()) {
      return;
    }

    const nextRootDir = rootDir?.trim() || null;
    const currentRootDir = nativeWatcherRootDirRef.current;
    if (nextRootDir === currentRootDir) {
      return;
    }

    if (!nextRootDir) {
      if (currentRootDir) {
        await stopNativeLibraryWatcher().catch(() => null);
      }
      nativeWatcherRootDirRef.current = null;
      activeNativeWatcherRootDir = null;
      updateDebugChannel("watcher", "idle", "当前没有已绑定 rootDir，native watcher 已停止");
      return;
    }

    if (currentRootDir && currentRootDir !== nextRootDir) {
      await stopNativeLibraryWatcher().catch(() => null);
    }

    const watcher = await startNativeLibraryWatcher(nextRootDir).catch(() => null);
    if (watcher) {
      nativeWatcherRootDirRef.current = nextRootDir;
      activeNativeWatcherRootDir = nextRootDir;
      updateDebugChannel("watcher", "native", `native watcher 已监控: ${nextRootDir}`);
      return;
    }

    nativeWatcherRootDirRef.current = null;
    activeNativeWatcherRootDir = null;
    updateDebugChannel("watcher", "http", "native watcher 启动失败，当前未拿到原生监控状态");
  }

  async function bindLibrary(rootDir: string): Promise<LibraryBinding> {
    setLoading(true);
    setError(null);
    try {
      const binding = await saveLibraryBinding({ rootDir, completeInitialization: true });
      setSnapshot((current) => current ? { ...current, binding } : current);
      setViewState(readLibraryViewState(binding.libraryId));
      await syncNativeLibraryWatcher(binding.enabled ? binding.rootDir : null);
      await reload();
      await reloadDocuments(true);
      return binding;
    } catch (err) {
      setError(toApiErrorMessage(err));
      throw err;
    } finally {
      setLoading(false);
    }
  }

  async function reload(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const nativeSnapshot = shouldUseNativeLibraryBridge()
        ? await fetchNativeLibrarySnapshot().catch(() => null)
        : null;
      updateDebugChannel(
        "snapshot",
        nativeSnapshot ? "native" : "http",
        nativeSnapshot
          ? "snapshot 直接由 Rust 读取本地 binding/runtime-status/exports 组装"
          : shouldUseNativeLibraryBridge()
            ? "native snapshot 不可用，已回退 HTTP /api/library/snapshot"
            : "当前模式不走 native snapshot",
      );
      const nextSnapshot = nativeSnapshot?.snapshot ?? await getLibrarySnapshot();
      const nextTags = nextSnapshot.requiresInitialization || !nextSnapshot.binding?.enabled
        ? []
        : await listLibraryTags().catch(() => [] as LibraryTagNode[]);
      setSnapshot(nextSnapshot);
      await syncNativeLibraryWatcher(nextSnapshot.binding?.enabled ? nextSnapshot.binding?.rootDir ?? null : null);
      setTags(mergeTagSources(nextSnapshot.tags, nextTags));
      const nextLibraryId = nextSnapshot.binding?.libraryId ?? "default";
      if (nextLibraryId !== viewState.libraryId) {
        setViewState(readLibraryViewState(nextLibraryId));
      }
    } catch (err) {
      setError(toApiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  async function reloadDocuments(
    reset = true,
    showLoading = true,
    options: { commitUnchanged?: boolean } = {},
  ): Promise<void> {
    if (requiresInitialization || !snapshot?.binding?.enabled) {
      listSignatureRef.current = null;
      setDocumentPage(null);
      setFileItems([]);
      return;
    }

    if (showLoading) {
      setDocumentsLoading(true);
    }
    setError(null);
    try {
      const offset = reset ? 0 : documentPage?.items.length ?? 0;
      const limit = reset
        ? Math.max(DOCUMENT_PAGE_LIMIT, documentPage?.items.length ?? 0)
        : DOCUMENT_PAGE_LIMIT;
      const queryKey = buildLibraryListQueryKey(viewState);
      const [nextDocuments, nextFiles] = await Promise.all([
        shouldUseNativeLibraryBridge()
          ? listNativeLibraryDocuments({
              browseMode: viewState.browseMode,
              selectedFolderPath: viewState.selectedFolderPath,
              selectedTagPath: viewState.selectedTagPath,
              selectedTagPaths: viewState.selectedTagPaths,
              selectedFavoriteId: viewState.selectedFavoriteId,
              offset,
              limit
            }).then((result) => {
              updateDebugChannel(
                "documents",
                result ? "native" : "http",
                result
                  ? `documents 由 Rust 本地读取 export 清单，browseMode=${viewState.browseMode}`
                  : "native documents 不可用，已回退 HTTP /api/library/documents",
              );
              return result ?? listLibraryDocuments({
                browseMode: viewState.browseMode,
                selectedFolderPath: viewState.selectedFolderPath,
                selectedTagPath: viewState.selectedTagPath,
                selectedTagPaths: viewState.selectedTagPaths,
                selectedFavoriteId: viewState.selectedFavoriteId,
                offset,
                limit
              });
            })
          : listLibraryDocuments({
              browseMode: viewState.browseMode,
              selectedFolderPath: viewState.selectedFolderPath,
              selectedTagPath: viewState.selectedTagPath,
              selectedTagPaths: viewState.selectedTagPaths,
              selectedFavoriteId: viewState.selectedFavoriteId,
              offset,
              limit
            }),
        viewState.browseMode === "folder"
          ? shouldUseNativeLibraryBridge()
            ? listNativeLibraryFiles(viewState.selectedFolderPath, FILE_LIST_LIMIT)
                .then((result) => {
                  updateDebugChannel(
                    "files",
                    result ? "native" : "http",
                    result
                      ? `files 由 Rust 直接遍历本地目录: ${viewState.selectedFolderPath ?? "."}`
                      : "native files 不可用，已回退 HTTP /api/library/files",
                  );
                  return result ?? listLibraryFiles(viewState.selectedFolderPath, FILE_LIST_LIMIT);
                })
            : listLibraryFiles(viewState.selectedFolderPath, FILE_LIST_LIMIT)
          : Promise.resolve({ items: [] })
      ]);

      if (!shouldUseNativeLibraryBridge()) {
        updateDebugChannel("documents", "http", "当前运行模式不走 native documents");
        updateDebugChannel(
          "files",
          viewState.browseMode === "folder" ? "http" : "idle",
          viewState.browseMode === "folder" ? "当前运行模式不走 native files" : "标签视图不读取目录文件列表",
        );
      } else if (viewState.browseMode !== "folder") {
        updateDebugChannel("files", "idle", "标签视图不读取目录文件列表");
      }

      const nextSignature = buildLibraryListSignature(nextDocuments, nextFiles);
      const previousSignature = listSignatureRef.current;
      const canSkipCommit =
        reset &&
        options.commitUnchanged !== true &&
        previousSignature?.queryKey === queryKey &&
        previousSignature.signature === nextSignature &&
        documentPage !== null;

      if (!canSkipCommit) {
        listSignatureRef.current = { queryKey, signature: nextSignature };
        setDocumentPage((current) => {
          if (reset || !current) {
            return nextDocuments;
          }
          return {
            ...nextDocuments,
            items: [...current.items, ...nextDocuments.items],
            offset: current.offset
          };
        });
        setFileItems(nextFiles.items);
      }
    } catch (err) {
      setError(toApiErrorMessage(err));
    } finally {
      if (showLoading) {
        setDocumentsLoading(false);
      }
    }
  }

  async function loadMore(): Promise<void> {
    if (!hasMore || documentsLoading) {
      return;
    }
    await reloadDocuments(false, true, { commitUnchanged: true });
  }

  async function refresh(): Promise<void> {
    setRefreshPending(true);
    setError(null);
    try {
      const nativeResult = shouldUseNativeLibraryBridge()
        ? await requestNativeLibraryRefresh({
            mode: "full",
            reason: "manual_refresh",
            targetPath: viewState.browseMode === "folder" ? viewState.selectedFolderPath : null
          }).catch(() => null)
        : null;
      updateDebugChannel(
        "refresh",
        nativeResult ? "native" : "http",
        nativeResult
          ? `refresh 入口命中 Rust；桌面宿主先跑 index-only，再用 dirtyScope 驱动 export-only，reason=manual_refresh`
          : shouldUseNativeLibraryBridge()
            ? "native refresh 不可用，已直连 HTTP /api/library/refresh"
            : "当前运行模式不走 native refresh",
      );
      const result = nativeResult?.backendResponse ?? await requestLibraryRefresh({
        reason: "manual_refresh",
        targetPath: viewState.browseMode === "folder" ? viewState.selectedFolderPath : null
      });
      setSnapshot((current) =>
        current
          ? { ...current, status: normalizeLibraryIndexStatus(result.status) }
          : current,
      );
      await reload();
      await reloadDocuments(true);
      if (shouldUseNativeLibraryBridge()) {
        await waitForNativeRefreshProgress(viewState.browseMode === "folder");
      }
    } catch (err) {
      setError(toApiErrorMessage(err));
    } finally {
      setRefreshPending(false);
    }
  }

  async function waitForNativeRefreshProgress(includeDocumentsReload: boolean): Promise<void> {
    const maxPollCount = 30;
    for (let attempt = 0; attempt < maxPollCount; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 1200));
      const nativeSnapshot = await fetchNativeLibrarySnapshot().catch(() => null);
      const nextSnapshot = nativeSnapshot?.snapshot ?? await getLibrarySnapshot();
      setSnapshot(nextSnapshot);
      await syncNativeLibraryWatcher(
        nextSnapshot.binding?.enabled ? nextSnapshot.binding?.rootDir ?? null : null,
      );
      if (includeDocumentsReload) {
        await reloadDocuments(true, false, { commitUnchanged: false });
      }
      const state = nextSnapshot.status.state;
      if (!isLiveIndexState(state)) {
        return;
      }
    }
  }

  const selectFolder = useCallback((
    path: string | null,
    selectedEntryPath: string | null = null,
  ): void => {
    setPreview(null);
    setPreviewError(null);
    setViewState((current) => ({
      ...current,
      browseMode: "folder",
      selectedFolderPath: path,
      selectedFolderEntryPath: selectedEntryPath,
      selectedFolderEntryPaths: selectedEntryPath ? [selectedEntryPath] : [],
      selectedTagPath: null,
      selectedTagPaths: [],
      selectedFavoriteId: null,
      selectedDocumentId: null,
      selectedDocumentIds: []
    }));
  }, [setViewState]);

  const selectFolderEntry = useCallback((path: string | null): void => {
    setPreview(null);
    setPreviewError(null);
    setViewState((current) => ({
      ...current,
      selectedFolderEntryPath: path,
      selectedFolderEntryPaths: path ? [path] : [],
      selectedDocumentId: null,
      selectedDocumentIds: []
    }));
  }, [setViewState]);

  const toggleFolderEntrySelection = useCallback((path: string, additive = false): void => {
    setPreview(null);
    setPreviewError(null);
    setViewState((current) => {
      const currentPaths = current.selectedFolderEntryPaths;
      const exists = currentPaths.includes(path);
      const nextPaths = additive
        ? exists
          ? currentPaths.filter((item) => item !== path)
          : [...currentPaths, path]
        : [path];
      return {
        ...current,
        selectedFolderEntryPath: nextPaths[0] ?? null,
        selectedFolderEntryPaths: nextPaths,
        selectedDocumentId: null,
        selectedDocumentIds: []
      };
    });
  }, [setViewState]);

  const selectTag = useCallback((path: string | null): void => {
    setPreview(null);
    setPreviewError(null);
    setViewState((current) => {
      const nextSelectedTagPaths = updateSelectedTagPaths(tags, current.selectedTagPaths, path);
      return {
        ...current,
        browseMode: "tag",
        selectedTagPath: nextSelectedTagPaths[nextSelectedTagPaths.length - 1] ?? null,
        selectedTagPaths: nextSelectedTagPaths,
        selectedFavoriteId: null,
        selectedDocumentId: null,
        selectedDocumentIds: [],
        selectedFolderEntryPath: null,
        selectedFolderEntryPaths: []
      };
    });
  }, [setViewState, tags]);

  const selectFavorite = useCallback((favorite: LibraryFavoriteRecord): void => {
    if (favorite.kind === "folder") {
      selectFolder(favorite.path);
      setViewState((current) => ({ ...current, selectedFavoriteId: favorite.path }));
      return;
    }

    const favoriteTagPaths = favorite.tagPaths?.length ? favorite.tagPaths : [favorite.path];
    setPreview(null);
    setPreviewError(null);
    setViewState((current) => ({
      ...current,
      browseMode: "tag",
      selectedTagPath: favoriteTagPaths[favoriteTagPaths.length - 1] ?? null,
      selectedTagPaths: favoriteTagPaths,
      selectedFavoriteId: favorite.path,
      selectedDocumentId: null,
      selectedDocumentIds: [],
      selectedFolderEntryPath: null,
      selectedFolderEntryPaths: []
    }));
  }, [selectFolder, setViewState]);

  const selectDocument = useCallback((documentId: string): void => {
    setViewState((current) => ({
      ...current,
      selectedDocumentId: documentId,
      selectedDocumentIds: [documentId],
      selectedFolderEntryPath: null,
      selectedFolderEntryPaths: []
    }));
  }, [setViewState]);

  const toggleDocumentSelection = useCallback((documentId: string, additive = false): void => {
    setViewState((current) => {
      const currentIds = current.selectedDocumentIds;
      const exists = currentIds.includes(documentId);
      const nextIds = additive
        ? exists
          ? currentIds.filter((item) => item !== documentId)
          : [...currentIds, documentId]
        : [documentId];
      return {
        ...current,
        selectedDocumentId: nextIds[0] ?? null,
        selectedDocumentIds: nextIds,
        selectedFolderEntryPath: null,
        selectedFolderEntryPaths: []
      };
    });
  }, [setViewState]);

  async function openPreview(path: string): Promise<void> {
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      const nativePreview = shouldUseNativeLibraryBridge()
        ? await getNativeLibraryPreview(path, "reading").catch(() => null)
        : null;
      const resolvedNativePreview = nativePreview?.kind === "office" && !nativePreview.onlyOffice
        ? await getNativeOnlyOfficePreview(path, "reading", true).catch(() => nativePreview)
        : nativePreview;
      updateDebugChannel(
        "preview",
        resolvedNativePreview ? "native" : "http",
        resolvedNativePreview
          ? `preview 命中 Rust，kind=${resolvedNativePreview.kind}${resolvedNativePreview.onlyOffice ? " onlyoffice=native" : ""}`
          : shouldUseNativeLibraryBridge()
            ? `native preview 不可用，已回退 HTTP /api/library/preview (${path})`
            : "当前运行模式不走 native preview",
      );
      setPreview(resolvedNativePreview ?? await getLibraryPreview(path, "reading"));
    } catch (err) {
      setPreview(null);
      setPreviewError(toApiErrorMessage(err));
    } finally {
      setPreviewLoading(false);
    }
  }

  async function downloadSelected(path: string): Promise<void> {
    const payload = await downloadLibraryFile(path);
    const link = document.createElement("a");
    link.href = `data:application/octet-stream;base64,${payload.contentBase64}`;
    link.download = payload.fileName;
    link.click();
  }

  async function toggleFavorite(favorite: LibraryFavoriteRecord): Promise<void> {
    const current = snapshot?.favorites ?? [];
    const exists = current.some((item) => item.kind === favorite.kind && item.path === favorite.path);
    const nextFavorites = exists
      ? current.filter((item) => !(item.kind === favorite.kind && item.path === favorite.path))
      : [...current, favorite];

    const result = await updateLibraryFavorites({ favorites: nextFavorites });
    setSnapshot((currentSnapshot) => currentSnapshot ? { ...currentSnapshot, favorites: result.items } : currentSnapshot);
  }

  async function operateFile(input: {
    opType: LibraryOperationType;
    srcPath?: string;
    dstPath?: string | null;
    content?: string | null;
    expectedVersion?: string | null;
  }): Promise<void> {
    setError(null);
    try {
      await operateLibraryFile(input);
      setPreview(null);
      setPreviewError(null);
      await reload();
      await reloadDocuments(true);
    } catch (err) {
      setError(toApiErrorMessage(err));
      throw err;
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  useEffect(() => {
    return () => {
      nativeWatcherRootDirRef.current = activeNativeWatcherRootDir;
    };
  }, []);

  useEffect(() => {
    void reloadDocuments(true);
  }, [
    snapshot?.binding?.enabled,
    viewState.browseMode,
    viewState.selectedFolderPath,
    viewState.selectedTagPath,
    viewState.selectedTagPaths.join("|"),
    viewState.selectedFavoriteId
  ]);

  useEffect(() => {
    if (selectedDocument) {
      void openPreview(selectedDocument.path);
    }
  }, [selectedDocument?.documentId]);

  useEffect(() => {
    const state = snapshot?.status.state;
    if (!isLiveIndexState(state)) {
      return;
    }

    if (isSummaryBackfillStage(snapshot?.status.runningStage)) {
      const timer = window.setInterval(() => {
        void (async () => {
          const nextStatus = shouldUseNativeLibraryBridge()
            ? await fetchNativeLibraryStatus().catch(() => null)
            : null;
          if (!nextStatus) {
            await reload();
            return;
          }
          setSnapshot((current) =>
            current
              ? { ...current, status: normalizeLibraryIndexStatus(nextStatus) }
              : current,
          );
          if (viewState.browseMode === "folder") {
            await reloadDocuments(true, false, { commitUnchanged: false });
          }
          if (!isLiveIndexState(nextStatus.state)) {
            await reload();
            if (viewState.browseMode === "folder") {
              await reloadDocuments(true, false, { commitUnchanged: false });
            }
          }
        })();
      }, SUMMARY_BACKFILL_DIRECTORY_POLL_INTERVAL_MS);
      return () => window.clearInterval(timer);
    }

    const timer = window.setInterval(() => {
      void (async () => {
        await reload();
        if (viewState.browseMode === "folder") {
          await reloadDocuments(true, false, { commitUnchanged: false });
        }
      })();
    }, RUNNING_INDEX_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [
    snapshot?.status.state,
    snapshot?.status.runningStage,
    snapshot?.status.runningTaskId,
    viewState.browseMode,
    viewState.selectedFolderPath,
  ]);

  useEffect(() => {
    if (
      !shouldUseNativeLibraryBridge() ||
      viewState.browseMode !== "folder" ||
      !isLiveIndexState(snapshot?.status.state) ||
      isSummaryBackfillStage(snapshot?.status.runningStage)
    ) {
      return;
    }

    let cancelled = false;
    let timer: number | null = null;
    let pollCount = 0;

    const pollDirectory = () => {
      if (cancelled || pollCount >= DIRECTORY_PRIORITY_POLL_COUNT) {
        return;
      }
      void (async () => {
        await reloadDocuments(true, false, { commitUnchanged: false });
        // 每几次同步一次整体状态即可；目录列表需要快，状态面板不用抢主线程。
        if (pollCount % 3 === 0) {
          await reload();
        }
        pollCount += 1;
        if (!cancelled && pollCount < DIRECTORY_PRIORITY_POLL_COUNT) {
          timer = window.setTimeout(pollDirectory, DIRECTORY_PRIORITY_POLL_INTERVAL_MS);
        }
      })();
    };

    timer = window.setTimeout(pollDirectory, DIRECTORY_PRIORITY_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (timer != null) {
        window.clearTimeout(timer);
      }
    };
  }, [
    snapshot?.status.state,
    snapshot?.status.runningStage,
    snapshot?.status.runningTaskId,
    viewState.browseMode,
    viewState.selectedFolderPath,
  ]);

  return {
    viewState,
    snapshot,
    requiresInitialization,
    initializationRedirectPath,
    tags,
    documentPage,
    fileItems,
    preview,
    loading,
    documentsLoading,
    previewLoading,
    refreshPending,
    error,
    previewError,
    entries,
    visibleEntryTotal,
    hasMore,
    selectedDocument,
    selectedDocuments,
    selectedFolderEntries,
    debug,
    setViewState,
    bindLibrary,
    reload,
    reloadDocuments,
    loadMore,
    refresh,
    selectFolder,
    selectFolderEntry,
    toggleFolderEntrySelection,
    selectTag,
    selectFavorite,
    selectDocument,
    toggleDocumentSelection,
    openPreview,
    downloadSelected,
    toggleFavorite,
    operateFile
  };
}

function createIdleDebugChannelState(detail: string): LibraryDebugChannelState {
  return {
    transport: "idle",
    detail,
    updatedAt: null,
  };
}

function buildLibraryListQueryKey(viewState: LibraryViewState): string {
  return [
    viewState.browseMode,
    viewState.selectedFolderPath ?? "",
    viewState.selectedTagPath ?? "",
    viewState.selectedTagPaths.join("\u001f"),
    viewState.selectedFavoriteId ?? "",
    viewState.keyword,
  ].join("\u001e");
}

function buildLibraryListSignature(
  documents: LibraryDocumentList,
  files: LibraryFileList,
): string {
  const documentSignature = documents.items
    .map((item) =>
      [
        item.documentId,
        item.path,
        item.updatedAt,
        item.sizeBytes ?? "",
        item.title,
        item.tags.join("\u001d"),
        item.derivedTags.join("\u001d"),
      ].join("\u001c"),
    )
    .join("\u001b");
  const fileSignature = files.items
    .map((item) =>
      [
        item.kind,
        item.path,
        item.name,
        item.updatedAt ?? "",
        item.size ?? "",
      ].join("\u001c"),
    )
    .join("\u001b");

  return [
    documents.total,
    documents.visibleEntryTotal ?? "",
    documents.offset,
    documents.limit,
    files.path ?? "",
    files.total ?? "",
    files.limit ?? "",
    documentSignature,
    fileSignature,
  ].join("\u001a");
}

function buildVisibleEntries(
  folderDocumentCountMap: Map<string, number>,
  documentPage: LibraryDocumentList | null,
  fileItems: LibraryFileNode[],
  viewState: LibraryViewState
): LibraryEntry[] {
  const baseEntries = buildEntries(folderDocumentCountMap, documentPage, fileItems, viewState);
  if (
    viewState.browseMode === "tag" &&
    viewState.viewMode === "list" &&
    viewState.selectedTagPaths.length > 0 &&
    viewState.tagResultStructureMode === "directory"
  ) {
    return buildTagDirectoryEntries(documentPage?.items ?? [], viewState.librarySort);
  }
  return sortLibraryEntries(baseEntries, viewState.librarySort);
}

function buildEntries(
  folderDocumentCountMap: Map<string, number>,
  documentPage: LibraryDocumentList | null,
  fileItems: LibraryFileNode[],
  viewState: LibraryViewState
): LibraryEntry[] {
  const folderEntries: LibraryEntry[] = viewState.browseMode === "folder"
    ? fileItems
        .filter((item) => item.kind === "directory")
        .map((item) => ({
          kind: "folder",
          path: item.path,
          name: item.name || getPathName(item.path),
          documentCount: resolveFolderCount(folderDocumentCountMap, item.path),
          updatedAt: item.updatedAt
        }))
    : [];

  const documentEntries: LibraryEntry[] = (documentPage?.items ?? []).map((item) => ({
    ...item,
    kind: "document" as const
  }));

  return [...folderEntries, ...documentEntries];
}

function resolveVisibleEntryTotal(
  documentPage: LibraryDocumentList | null,
  fileItems: LibraryFileNode[],
  entryCount: number,
  viewState: LibraryViewState
): number {
  const directoryCount = fileItems.filter((item) => item.kind === "directory").length;
  const serverVisibleTotal = documentPage?.visibleEntryTotal;

  if (viewState.browseMode === "folder") {
    const documentTotal = documentPage?.total;
    const normalizedServerVisibleTotal =
      typeof serverVisibleTotal === "number" && Number.isFinite(serverVisibleTotal)
        ? Math.floor(serverVisibleTotal)
        : null;
    if (typeof documentTotal === "number" && Number.isFinite(documentTotal)) {
      return Math.max(
        entryCount,
        Math.max(directoryCount + Math.floor(documentTotal), normalizedServerVisibleTotal ?? 0)
      );
    }
    return Math.max(entryCount, directoryCount, normalizedServerVisibleTotal ?? 0);
  }

  if (typeof serverVisibleTotal === "number" && Number.isFinite(serverVisibleTotal)) {
    return Math.max(entryCount, Math.floor(serverVisibleTotal));
  }

  const documentTotal = documentPage?.total;
  if (typeof documentTotal !== "number" || !Number.isFinite(documentTotal)) {
    return entryCount;
  }
  return Math.max(entryCount, Math.floor(documentTotal));
}

function buildTagDirectoryEntries(
  documents: LibraryDocumentRecord[],
  sortState: LibraryViewState["librarySort"]
): LibraryEntry[] {
  const directories = new Map<string, Extract<LibraryEntry, { kind: "tag-directory" }>>();
  const childDirectoryPathsByParent = new Map<string, Set<string>>();
  const documentsByParent = new Map<string, Extract<LibraryEntry, { kind: "document" }>[] >();

  const addChildDirectory = (parentPath: string, childPath: string) => {
    const children = childDirectoryPathsByParent.get(parentPath) ?? new Set<string>();
    children.add(childPath);
    childDirectoryPathsByParent.set(parentPath, children);
  };

  const touchDirectory = (directoryPath: string, document: LibraryDocumentRecord) => {
    const normalizedPath = normalizeFolderPath(directoryPath);
    if (!normalizedPath) return;
    const existing = directories.get(normalizedPath);
    directories.set(normalizedPath, {
      kind: "tag-directory",
      path: normalizedPath,
      name: getPathName(normalizedPath),
      depth: getFolderDepth(normalizedPath),
      documentCount: (existing?.documentCount ?? 0) + 1,
      updatedAt: pickLatestDate(existing?.updatedAt ?? null, document.updatedAt),
      createdAt: pickEarliestDate(existing?.createdAt ?? null, document.createdAt)
    });
  };

  for (const document of documents) {
    const parentPath = normalizeFolderPath(getDocumentParentPath(document.path));
    const documentEntry: Extract<LibraryEntry, { kind: "document" }> = {
      ...document,
      kind: "document",
      depth: parentPath ? parentPath.split("/").length : 0
    } as Extract<LibraryEntry, { kind: "document" }>;
    const siblingDocuments = documentsByParent.get(parentPath) ?? [];
    siblingDocuments.push(documentEntry);
    documentsByParent.set(parentPath, siblingDocuments);

    if (!parentPath) continue;
    const segments = parentPath.split("/").filter(Boolean);
    for (let index = 0; index < segments.length; index += 1) {
      const directoryPath = segments.slice(0, index + 1).join("/");
      const directoryParentPath = segments.slice(0, index).join("/");
      touchDirectory(directoryPath, document);
      addChildDirectory(directoryParentPath, directoryPath);
    }
  }

  const entries: LibraryEntry[] = [];
  const visit = (parentPath: string) => {
    const childDirectoryPaths = Array.from(childDirectoryPathsByParent.get(parentPath) ?? [])
      .sort((left, right) => getPathName(left).localeCompare(getPathName(right), "zh-CN"));
    for (const childPath of childDirectoryPaths) {
      const directory = directories.get(childPath);
      if (!directory) continue;
      entries.push(directory);
      visit(childPath);
    }
    entries.push(...sortLibraryEntries(documentsByParent.get(parentPath) ?? [], sortState));
  };

  visit("");
  return entries;
}

function buildFolderDocumentCountMap(folders: LibrarySnapshot["folders"] | null | undefined): Map<string, number> {
  const map = new Map<string, number>();
  for (const folder of folders ?? []) {
    map.set(folder.path, folder.documentCount);
  }
  return map;
}

function resolveFolderCount(folderDocumentCountMap: Map<string, number>, folderPath: string): number {
  return folderDocumentCountMap.get(folderPath) ?? 0;
}

function normalizeFolderPath(value: string): string {
  return value
    .replaceAll("\\\\", "/")
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment && segment !== "." && segment !== "..")
    .join("/");
}

function getDocumentParentPath(filePath: string): string {
  const segments = normalizeFolderPath(filePath).split("/").filter(Boolean);
  segments.pop();
  return segments.join("/");
}

function getFolderDepth(folderPath: string): number {
  return normalizeFolderPath(folderPath).split("/").filter(Boolean).length;
}

function pickLatestDate(left: string | null | undefined, right: string | null | undefined): string | null {
  if (!left) return right ?? null;
  if (!right) return left;
  return new Date(left).getTime() >= new Date(right).getTime() ? left : right;
}

function pickEarliestDate(left: string | null | undefined, right: string | null | undefined): string | null {
  if (!left) return right ?? null;
  if (!right) return left;
  return new Date(left).getTime() <= new Date(right).getTime() ? left : right;
}

function updateSelectedTagPaths(
  tagRecords: LibraryTagNode[],
  currentPaths: string[],
  nextPath: string | null,
): string[] {
  const normalizedPath = nextPath?.trim() ?? "";
  if (!normalizedPath) {
    return [];
  }
  const nextRootType = resolveTagRootType(tagRecords, normalizedPath);
  const alreadySelected = currentPaths.includes(normalizedPath);
  const nextPaths = currentPaths.filter((item) => resolveTagRootType(tagRecords, item) !== nextRootType);
  if (alreadySelected) {
    return nextPaths;
  }
  return [...nextPaths, normalizedPath];
}

function resolveTagRootType(tagRecords: LibraryTagNode[], pathValue: string): string {
  const normalizedPath = pathValue.trim();
  if (!normalizedPath) {
    return "";
  }
  const matched = tagRecords.find((item) => item.path === normalizedPath);
  if (matched?.rootType?.trim() === "manual") {
    return normalizedPath.split("/")[0] ?? normalizedPath;
  }
  if (matched?.rootType?.trim()) {
    return matched.rootType.trim();
  }
  return normalizedPath.split("/")[0] ?? normalizedPath;
}

/**
 * 合并快照标签与 API 标签。
 * 快照标签来自索引器导出，包含系统派生的内置标签（时间、类型）；
 * API 标签来自 X-File 标签存储，只包含用户创建的自定义标签。
 * 以快照标签为基底，补充 API 中快照尚未包含的新标签（如刚创建、重算尚未完成的自定义标签），
 * 确保侧边栏标签树始终同时展示内置标签和自定义标签。
 */
function mergeTagSources(snapshotTags: LibraryTagNode[], apiTags: LibraryTagNode[]): LibraryTagNode[] {
  if (!apiTags.length) {
    return snapshotTags;
  }
  if (!snapshotTags.length) {
    return apiTags;
  }
  const tagMap = new Map<string, LibraryTagNode>(snapshotTags.map((tag) => [tag.path, tag]));
  for (const tag of apiTags) {
    if (!tagMap.has(tag.path)) {
      tagMap.set(tag.path, tag);
    }
  }
  return Array.from(tagMap.values());
}
