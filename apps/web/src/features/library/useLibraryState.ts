import { useEffect, useMemo, useState } from "react";
import type {
  LibraryBinding,
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
  hasMore: boolean;
  selectedDocument: LibraryEntry & { kind: "document" } | null;
  setViewState: (updater: LibraryViewState | ((current: LibraryViewState) => LibraryViewState)) => void;
  bindLibrary: (rootDir: string) => Promise<LibraryBinding>;
  reload: () => Promise<void>;
  reloadDocuments: (reset?: boolean) => Promise<void>;
  loadMore: () => Promise<void>;
  refresh: () => Promise<void>;
  selectFolder: (path: string | null) => void;
  selectTag: (path: string | null) => void;
  selectFavorite: (favorite: LibraryFavoriteRecord) => void;
  selectDocument: (documentId: string) => void;
  openPreview: (path: string) => Promise<void>;
  downloadSelected: (path: string) => Promise<void>;
  toggleFavorite: (favorite: LibraryFavoriteRecord) => Promise<void>;
  operateFile: (input: { opType: LibraryOperationType; srcPath?: string; dstPath?: string | null; content?: string | null }) => Promise<void>;
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
    () => sortLibraryEntries(buildEntries(snapshot, documentPage, fileItems, viewState), viewState.librarySort),
    [documentPage, fileItems, snapshot, viewState]
  );

  const selectedDocument = useMemo(
    () => entries.find((entry): entry is LibraryEntry & { kind: "document" } => {
      return entry.kind === "document" && entry.documentId === viewState.selectedDocumentId;
    }) ?? null,
    [entries, viewState.selectedDocumentId]
  );

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
      const binding = await saveLibraryBinding({ rootDir });
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
      const [nextSnapshot, nextTags] = await Promise.all([
        getLibrarySnapshot(),
        listLibraryTags().catch(() => [] as LibraryTagNode[])
      ]);
      setSnapshot(nextSnapshot);
      setTags(nextTags.length ? nextTags : nextSnapshot.tags);
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
    if (!snapshot?.binding?.enabled) {
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
          keyword: viewState.keyword,
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
        reason: "manual",
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

  function selectFolder(path: string | null): void {
    setPreview(null);
    setPreviewError(null);
    setViewState((current) => ({
      ...current,
      browseMode: "folder",
      selectedFolderPath: path,
      selectedFolderEntryPath: null,
      selectedTagPath: null,
      selectedTagPaths: [],
      selectedFavoriteId: null,
      selectedDocumentId: null
    }));
  }

  function selectTag(path: string | null): void {
    setPreview(null);
    setPreviewError(null);
    setViewState((current) => ({
      ...current,
      browseMode: "tag",
      selectedTagPath: path,
      selectedTagPaths: path ? [path] : [],
      selectedFavoriteId: null,
      selectedDocumentId: null
    }));
  }

  function selectFavorite(favorite: LibraryFavoriteRecord): void {
    if (favorite.kind === "folder") {
      selectFolder(favorite.path);
      setViewState((current) => ({ ...current, selectedFavoriteId: favorite.path }));
      return;
    }

    setPreview(null);
    setPreviewError(null);
    setViewState((current) => ({
      ...current,
      browseMode: "tag",
      selectedTagPath: favorite.path,
      selectedTagPaths: favorite.tagPaths?.length ? favorite.tagPaths : [favorite.path],
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
      setPreview(await getLibraryPreview(path));
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
    viewState.selectedFavoriteId,
    viewState.keyword,
    snapshot?.status.lastCompletedAt
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
      void reload();
    }, 4000);
    return () => window.clearInterval(timer);
  }, [snapshot?.status.state, snapshot?.status.runningTaskId]);

  return {
    viewState,
    snapshot,
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
    hasMore,
    selectedDocument,
    setViewState,
    bindLibrary,
    reload,
    reloadDocuments,
    loadMore,
    refresh,
    selectFolder,
    selectTag,
    selectFavorite,
    selectDocument,
    openPreview,
    downloadSelected,
    toggleFavorite,
    operateFile
  };
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

function resolveFolderCount(snapshot: LibrarySnapshot | null, folderPath: string): number {
  return snapshot?.folders.find((folder) => folder.path === folderPath)?.documentCount ?? 0;
}
