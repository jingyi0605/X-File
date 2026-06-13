import { useEffect, useMemo, useState } from "react";
import type {
  LibraryBinding,
  LibraryDocumentRecord,
  LibraryDocumentList,
  LibraryFavoriteRecord,
  LibraryFileNode,
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
  setViewState: (updater: LibraryViewState | ((current: LibraryViewState) => LibraryViewState)) => void;
  bindLibrary: (rootDir: string) => Promise<LibraryBinding>;
  reload: () => Promise<void>;
  reloadDocuments: (reset?: boolean) => Promise<void>;
  loadMore: () => Promise<void>;
  refresh: () => Promise<void>;
  selectFolder: (path: string | null, selectedEntryPath?: string | null) => void;
  selectFolderEntry: (path: string | null) => void;
  selectTag: (path: string | null) => void;
  selectFavorite: (favorite: LibraryFavoriteRecord) => void;
  selectDocument: (documentId: string) => void;
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

  const entries = useMemo(
    () => buildVisibleEntries(snapshot, documentPage, fileItems, viewState),
    [documentPage, fileItems, snapshot, viewState]
  );
  const visibleEntryTotal = useMemo(
    () => resolveVisibleEntryTotal(documentPage, fileItems, entries.length, viewState),
    [documentPage, entries.length, fileItems, viewState]
  );

  const selectedDocument = useMemo(
    () => entries.find((entry): entry is LibraryEntry & { kind: "document" } => {
      return entry.kind === "document" && entry.documentId === viewState.selectedDocumentId;
    }) ?? null,
    [entries, viewState.selectedDocumentId]
  );

  const requiresInitialization = snapshot?.requiresInitialization === true;
  const initializationRedirectPath = snapshot?.initializationRedirectPath ?? "/init";
  const hasMore = (documentPage?.items.length ?? 0) < (documentPage?.total ?? 0);

  function setViewState(updater: LibraryViewState | ((current: LibraryViewState) => LibraryViewState)): void {
    setViewStateState((current) => {
      const next = typeof updater === "function" ? updater(current) : updater;
      writeLibraryViewState(next);
      return next;
    });
  }

  async function bindLibrary(rootDir: string): Promise<LibraryBinding> {
    setLoading(true);
    setError(null);
    try {
      const binding = await saveLibraryBinding({ rootDir, completeInitialization: true });
      setSnapshot((current) => current ? { ...current, binding } : current);
      setViewState(readLibraryViewState(binding.libraryId));
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
      const nextSnapshot = await getLibrarySnapshot();
      const nextTags = nextSnapshot.requiresInitialization || !nextSnapshot.binding?.enabled
        ? []
        : await listLibraryTags().catch(() => [] as LibraryTagNode[]);
      setSnapshot(nextSnapshot);
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

  async function reloadDocuments(reset = true): Promise<void> {
    if (requiresInitialization || !snapshot?.binding?.enabled) {
      setDocumentPage(null);
      setFileItems([]);
      return;
    }

    setDocumentsLoading(true);
    setError(null);
    try {
      const offset = reset ? 0 : documentPage?.items.length ?? 0;
      const [nextDocuments, nextFiles] = await Promise.all([
        listLibraryDocuments({
          browseMode: viewState.browseMode,
          selectedFolderPath: viewState.selectedFolderPath,
          selectedTagPath: viewState.selectedTagPath,
          selectedTagPaths: viewState.selectedTagPaths,
          selectedFavoriteId: viewState.selectedFavoriteId,
          offset,
          limit: DOCUMENT_PAGE_LIMIT
        }),
        viewState.browseMode === "folder"
          ? listLibraryFiles(viewState.selectedFolderPath, FILE_LIST_LIMIT)
          : Promise.resolve({ items: [] })
      ]);

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
    } catch (err) {
      setError(toApiErrorMessage(err));
    } finally {
      setDocumentsLoading(false);
    }
  }

  async function loadMore(): Promise<void> {
    if (!hasMore || documentsLoading) {
      return;
    }
    await reloadDocuments(false);
  }

  async function refresh(): Promise<void> {
    setRefreshPending(true);
    setError(null);
    try {
      const result = await requestLibraryRefresh({
        reason: "manual_refresh",
        targetPath: viewState.browseMode === "folder" ? viewState.selectedFolderPath : null
      });
      setSnapshot((current) => current ? { ...current, status: result.status } : current);
      await reload();
      await reloadDocuments(true);
    } catch (err) {
      setError(toApiErrorMessage(err));
    } finally {
      setRefreshPending(false);
    }
  }

  function selectFolder(
    path: string | null,
    selectedEntryPath: string | null = null,
  ): void {
    setPreview(null);
    setPreviewError(null);
    setViewState((current) => ({
      ...current,
      browseMode: "folder",
      selectedFolderPath: path,
      selectedFolderEntryPath: selectedEntryPath,
      selectedTagPath: null,
      selectedTagPaths: [],
      selectedFavoriteId: null,
      selectedDocumentId: null
    }));
  }

  function selectFolderEntry(path: string | null): void {
    setPreview(null);
    setPreviewError(null);
    setViewState((current) => ({
      ...current,
      selectedFolderEntryPath: path,
      selectedDocumentId: null
    }));
  }

  function selectTag(path: string | null): void {
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
        selectedDocumentId: null
      };
    });
  }

  function selectFavorite(favorite: LibraryFavoriteRecord): void {
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
      selectedDocumentId: null
    }));
  }

  function selectDocument(documentId: string): void {
    setViewState((current) => ({
      ...current,
      selectedDocumentId: documentId,
      selectedFolderEntryPath: null
    }));
  }

  async function openPreview(path: string): Promise<void> {
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      setPreview(await getLibraryPreview(path, "reading"));
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
    if (state !== "queued" && state !== "running" && state !== "stale" && state !== "queue_timeout") {
      return;
    }

    const timer = window.setInterval(() => {
      void (async () => {
        await reload();
        if (viewState.browseMode === "folder") {
          await reloadDocuments(true);
        }
      })();
    }, 4000);
    return () => window.clearInterval(timer);
  }, [
    snapshot?.status.state,
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
    setViewState,
    bindLibrary,
    reload,
    reloadDocuments,
    loadMore,
    refresh,
    selectFolder,
    selectFolderEntry,
    selectTag,
    selectFavorite,
    selectDocument,
    openPreview,
    downloadSelected,
    toggleFavorite,
    operateFile
  };
}

function buildVisibleEntries(
  snapshot: LibrarySnapshot | null,
  documentPage: LibraryDocumentList | null,
  fileItems: LibraryFileNode[],
  viewState: LibraryViewState
): LibraryEntry[] {
  const baseEntries = buildEntries(snapshot, documentPage, fileItems, viewState);
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
  snapshot: LibrarySnapshot | null,
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
          documentCount: resolveFolderCount(snapshot, item.path),
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

function resolveFolderCount(snapshot: LibrarySnapshot | null, folderPath: string): number {
  return snapshot?.folders.find((folder) => folder.path === folderPath)?.documentCount ?? 0;
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
