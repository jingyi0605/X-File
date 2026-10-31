import type {
  LibraryConfig,
  LibraryDocumentList,
  LibraryDocumentRecord,
  LibraryDocumentTagDetails,
  LibraryFileList,
  LibraryFileNode,
  LibraryFolderTagDetails,
  LibraryMirrorMutation,
  LibraryMirrorMutationBatchResult,
  LibraryMirrorMutationStatus,
  LibraryMirrorSnapshot,
  LibraryMirrorSnapshotDelta,
  LibraryMirrorSnapshotUnchanged,
  LibrarySnapshot,
  LibraryTagDetailWithRules,
  LibraryTagNode,
} from "@x-file/shared";

import { ApiClientError, apiRequest, postJson } from "../api/http";
import { getRuntimeConfigSnapshot } from "./runtime-config-store";
import {
  loadMirrorCache,
  markMirrorCacheSynced,
  saveMirrorCache,
  type MirrorCacheState,
} from "./mirror-cache";
import { updateMirrorSyncProgress } from "./mirror-sync-progress";

const MIRROR_SNAPSHOT_TIMEOUT_MS = 15_000;
const LEGACY_DOCUMENT_PAGE_SIZE = 500;
const LEGACY_DOCUMENT_PAGE_CONCURRENCY = 8;

export class MirrorUnavailableError extends Error {
  readonly code = "MIRROR_SNAPSHOT_UNAVAILABLE";

  constructor(message = "主端暂时不可用，且镜像端没有可用快照") {
    super(message);
    this.name = "MirrorUnavailableError";
  }
}

export function isMirrorRuntime(): boolean {
  return getRuntimeConfigSnapshot().config.mode === "mirror";
}

export async function getMirrorSnapshot(): Promise<LibraryMirrorSnapshot> {
  const baseUrl = getMirrorBaseUrl();
  updateMirrorSyncProgress({
    phase: "connecting",
    transport: "snapshot",
    receivedDocuments: 0,
    totalDocuments: null,
    receivedBytes: 0,
    totalBytes: null,
  });
  const cached = await loadMirrorCache(baseUrl);
  try {
    const remote = await fetchRemoteMirrorSnapshot(cached.snapshot);
    const queued = cached.pendingMutations;
    if (queued.length === 0 && cached.snapshot?.revision === remote.revision) {
      await markMirrorCacheSynced(baseUrl);
      updateMirrorSyncProgress({ phase: "complete" });
      return remote;
    }
    updateMirrorSyncProgress({ phase: "saving" });
    await saveMirrorCache(baseUrl, {
      snapshot: remote,
      pendingMutations: queued,
      syncResults: cached.syncResults,
      source: "primary",
      lastSyncedAt: new Date().toISOString(),
      lastError: null,
    });
    if (queued.length > 0) {
      await flushMirrorMutations(baseUrl, queued);
      const refreshed = await apiRequest<LibraryMirrorSnapshot>("/api/library/mirror/snapshot");
      updateMirrorSyncProgress({ phase: "saving" });
      await saveMirrorCache(baseUrl, {
        snapshot: refreshed,
        pendingMutations: [],
        syncResults: (await loadMirrorCache(baseUrl)).syncResults,
        source: "primary",
        lastSyncedAt: new Date().toISOString(),
        lastError: null,
      });
      updateMirrorSyncProgress({ phase: "complete" });
      return refreshed;
    }
    updateMirrorSyncProgress({ phase: "complete" });
    return remote;
  } catch (error) {
    if (!cached.snapshot) {
      updateMirrorSyncProgress({ phase: "failed" });
      throw new MirrorUnavailableError(
        error instanceof Error ? `${error.message}；请先连接主端完成首次同步` : undefined,
      );
    }
    const offline = {
      ...cached,
      source: "cache" as const,
      lastError: error instanceof Error ? error.message : "主端不可用",
    };
    await saveMirrorCache(baseUrl, offline);
    updateMirrorSyncProgress({ phase: "complete" });
    return materializeSnapshot(offline);
  }
}

async function fetchRemoteMirrorSnapshot(
  cached: LibraryMirrorSnapshot | null,
): Promise<LibraryMirrorSnapshot> {
  updateMirrorSyncProgress({ phase: "receiving", transport: "snapshot" });
  try {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), MIRROR_SNAPSHOT_TIMEOUT_MS);
    try {
      return await fetchRemoteMirrorSnapshotPayload(cached, controller.signal);
    } finally {
      window.clearTimeout(timeout);
    }
  } catch (error) {
    if (
      error instanceof ApiClientError
      && error.status !== 0
      && error.status !== 404
      && error.status !== 405
      && error.status < 500
    ) {
      throw error;
    }

    return fetchLegacyMirrorSnapshot();
  }
}

async function fetchRemoteMirrorSnapshotPayload(
  cached: LibraryMirrorSnapshot | null,
  signal: AbortSignal,
): Promise<LibraryMirrorSnapshot> {
  const search = new URLSearchParams();
  if (cached) search.set("sinceRevision", cached.revision);
  const suffix = search.size > 0 ? `?${search.toString()}` : "";
  const remote = await apiRequest<
    LibraryMirrorSnapshot | LibraryMirrorSnapshotDelta | LibraryMirrorSnapshotUnchanged
  >(`/api/library/mirror/snapshot${suffix}`, {
        signal,
        onDownloadProgress: ({ loadedBytes, totalBytes }) => updateMirrorSyncProgress({
          phase: "receiving",
          receivedBytes: loadedBytes,
          totalBytes,
        }),
      });

  if (isUnchangedMirrorSnapshot(remote)) {
    if (!cached || cached.revision !== remote.revision) {
      throw new Error("主端返回了无法匹配本地缓存的镜像版本");
    }
    return { ...cached, generatedAt: remote.generatedAt };
  }

  if (isMirrorSnapshotDelta(remote)) {
    if (!cached || cached.revision !== remote.baseRevision) {
      return fetchRemoteMirrorSnapshotPayload(null, signal);
    }
    return applyMirrorSnapshotDelta(cached, remote);
  }

  return remote;
}

function isMirrorSnapshotDelta(
  value: LibraryMirrorSnapshot | LibraryMirrorSnapshotDelta | LibraryMirrorSnapshotUnchanged,
): value is LibraryMirrorSnapshotDelta {
  return "kind" in value && value.kind === "delta";
}

function isUnchangedMirrorSnapshot(
  value: LibraryMirrorSnapshot | LibraryMirrorSnapshotDelta | LibraryMirrorSnapshotUnchanged,
): value is LibraryMirrorSnapshotUnchanged {
  return "kind" in value && value.kind === "unchanged";
}

function applyMirrorSnapshotDelta(
  cached: LibraryMirrorSnapshot,
  delta: LibraryMirrorSnapshotDelta,
): LibraryMirrorSnapshot {
  return {
    version: 1,
    revision: delta.revision,
    generatedAt: delta.generatedAt,
    config: delta.config,
    snapshot: delta.snapshot,
    documents: applyRecordChanges(cached.documents, delta.documentUpserts, delta.deletedDocumentIds, (item) => item.documentId),
    tagDetails: applyRecordChanges(cached.tagDetails, delta.tagDetailUpserts, delta.deletedTagIds, (item) => item.id),
    documentTagBindings: applyRecordChanges(
      cached.documentTagBindings,
      delta.documentTagBindingUpserts,
      delta.deletedDocumentTagBindingIds,
      (item) => item.documentId,
    ),
    folderTagBindings: applyRecordChanges(
      cached.folderTagBindings,
      delta.folderTagBindingUpserts,
      delta.deletedFolderTagPaths,
      (item) => item.folderPath,
    ),
  };
}

function applyRecordChanges<T>(
  current: T[],
  upserts: T[],
  deletedKeys: string[],
  getKey: (item: T) => string,
): T[] {
  const next = new Map(current.map((item) => [getKey(item), item]));
  for (const key of deletedKeys) next.delete(key);
  for (const item of upserts) next.set(getKey(item), item);
  return [...next.values()];
}

async function fetchLegacyMirrorSnapshot(): Promise<LibraryMirrorSnapshot> {
  updateMirrorSyncProgress({
    phase: "receiving",
    transport: "legacy",
    receivedDocuments: 0,
    totalDocuments: null,
    receivedBytes: 0,
    totalBytes: null,
  });
  const [snapshot, config, tagPayload] = await Promise.all([
    apiRequest<LibrarySnapshot>("/api/library/snapshot"),
    apiRequest<LibraryConfig>("/api/library/config"),
    apiRequest<unknown>("/api/library/tags?includeDisabled=true"),
  ]);
  const documents = await fetchLegacyMirrorDocuments();
  const tagDetails = normalizeLegacyTagDetails(tagPayload);
  const generatedAt = new Date().toISOString();

  return {
    version: 1,
    revision: `legacy-${hashText(JSON.stringify({ snapshot, config, documents, tagDetails }))}`,
    generatedAt,
    config: { ...config, canWrite: false },
    snapshot: {
      ...snapshot,
      tags: tagDetails.map(mapTagToNode),
    },
    documents,
    tagDetails,
    documentTagBindings: [],
    folderTagBindings: [],
  };
}

async function fetchLegacyMirrorDocuments(): Promise<LibraryDocumentRecord[]> {
  const firstPage = await fetchLegacyMirrorDocumentPage(0);
  let receivedDocuments = firstPage.items.length;
  updateMirrorSyncProgress({
    phase: "receiving",
    transport: "legacy",
    receivedDocuments,
    totalDocuments: firstPage.total,
    receivedBytes: 0,
    totalBytes: null,
  });
  const offsets = Array.from(
    { length: Math.ceil((firstPage.total - firstPage.items.length) / LEGACY_DOCUMENT_PAGE_SIZE) },
    (_, index) => firstPage.items.length + index * LEGACY_DOCUMENT_PAGE_SIZE,
  );
  const remainingPages: LibraryDocumentRecord[][] = [];

  for (let index = 0; index < offsets.length; index += LEGACY_DOCUMENT_PAGE_CONCURRENCY) {
    const batch = offsets.slice(index, index + LEGACY_DOCUMENT_PAGE_CONCURRENCY);
    remainingPages.push(...await Promise.all(batch.map(async (offset) => {
      const items = (await fetchLegacyMirrorDocumentPage(offset)).items;
      receivedDocuments += items.length;
      updateMirrorSyncProgress({ receivedDocuments });
      return items;
    })));
  }

  return firstPage.items.concat(...remainingPages);
}

async function fetchLegacyMirrorDocumentPage(offset: number): Promise<LibraryDocumentList> {
  const search = new URLSearchParams({
    browseMode: "tag",
    searchScope: "all",
    searchMode: "all",
    offset: String(offset),
    limit: String(LEGACY_DOCUMENT_PAGE_SIZE),
  });
  return apiRequest<LibraryDocumentList>(`/api/library/documents?${search.toString()}`);
}

function normalizeLegacyTagDetails(value: unknown): LibraryTagDetailWithRules[] {
  if (Array.isArray(value)) {
    return value as LibraryTagDetailWithRules[];
  }
  if (!value || typeof value !== "object") {
    return [];
  }
  const items = (value as { items?: unknown }).items;
  return Array.isArray(items) ? items as LibraryTagDetailWithRules[] : [];
}

export async function listMirrorTags(): Promise<LibraryTagNode[]> {
  const snapshot = await getUsableSnapshot();
  return snapshot.tagDetails.map(mapTagToNode);
}

export async function listMirrorTagDetails(): Promise<LibraryTagDetailWithRules[]> {
  const snapshot = await getUsableSnapshot();
  return snapshot.tagDetails;
}

export async function listMirrorDocuments(query: {
  browseMode: "folder" | "tag";
  selectedFolderPath?: string | null;
  selectedTagPath?: string | null;
  selectedTagPaths?: string[] | null;
  selectedFavoriteId?: string | null;
  keyword?: string | null;
  searchScope?: "all" | "current_directory" | "current_results";
  searchMode?: "all" | "name" | "content";
  updatedAtOrder?: "asc" | "desc";
  offset?: number;
  limit?: number;
}): Promise<LibraryDocumentList> {
  const model = await getUsableSnapshot();
  const selectedTags = query.selectedTagPaths?.length
    ? query.selectedTagPaths
    : query.selectedTagPath
      ? [query.selectedTagPath]
      : [];
  const favorite = query.selectedFavoriteId
    ? model.snapshot.favorites.find((item) => item.path === query.selectedFavoriteId) ?? null
    : null;
  const keywords = (query.keyword ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const filtered = model.documents.filter((document) => {
    const documentDir = getParentPath(document.path);
    const folderPath = query.selectedFolderPath?.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "") ?? "";
    const scope = query.searchScope ?? "current_results";
    if (scope !== "all" && (scope === "current_directory" || query.browseMode !== "tag") && documentDir !== folderPath) {
      return false;
    }
    if (favorite && !matchesFavorite(document, favorite)) {
      return false;
    }
    const documentTags = [...document.tags, ...document.derivedTags];
    if (selectedTags.some((tag) => !documentTags.some((item) => item === tag || item.startsWith(`${tag}/`)))) {
      return false;
    }
    if (keywords.length > 0) {
      const text = query.searchMode === "name"
        ? document.title
        : query.searchMode === "content"
          ? document.summary
          : `${document.title}\n${document.path}\n${document.summary}`;
      const haystack = text.toLowerCase();
      if (keywords.some((keyword) => !haystack.includes(keyword))) {
        return false;
      }
    }
    return true;
  });
  const ordered = [...filtered].sort((left, right) => {
    if (query.updatedAtOrder) {
      const delta = Date.parse(left.updatedAt) - Date.parse(right.updatedAt);
      return (query.updatedAtOrder === "asc" ? delta : -delta) || left.path.localeCompare(right.path);
    }
    return left.path.localeCompare(right.path);
  });
  const offset = Math.max(0, query.offset ?? 0);
  const limit = Math.max(1, query.limit ?? 60);
  return {
    total: ordered.length,
    visibleEntryTotal: ordered.length,
    offset,
    limit,
    items: ordered.slice(offset, offset + limit),
    tagFacetCounts: countDocumentTags(ordered),
    directoryStatus: {
      path: query.selectedFolderPath ?? "",
      state: "fresh",
      source: "snapshot",
      lastRequestedAt: null,
      lastCompletedAt: model.generatedAt,
      lastFailedAt: null,
      runningTaskId: null,
      errorSummary: null,
      generatedAt: model.generatedAt,
    },
  };
}

export async function listMirrorFiles(path: string | null, limit: number): Promise<LibraryFileList> {
  const model = await getUsableSnapshot();
  const root = normalizePath(path ?? "");
  const visible = new Map<string, LibraryFileNode>();
  for (const folder of model.snapshot.folders) {
    const folderPath = normalizePath(folder.path);
    if (!root || folderPath === root || folderPath.startsWith(`${root}/`)) {
      const rest = root && folderPath.startsWith(`${root}/`)
        ? folderPath.slice(root.length + 1)
        : folderPath === root ? "" : folderPath;
      const head = rest.split("/")[0];
      if (!head) continue;
      const entryPath = root ? `${root}/${head}` : head;
      visible.set(entryPath, {
        path: entryPath,
        name: head,
        kind: "directory",
        size: null,
        updatedAt: null,
      });
    }
  }
  for (const document of model.documents) {
    const relative = normalizePath(document.path);
    if (root && relative !== root && !relative.startsWith(`${root}/`)) {
      continue;
    }
    const rest = root ? relative.slice(root.length + 1) : relative;
    const [head] = rest.split("/");
    if (!head) continue;
    const entryPath = root ? `${root}/${head}` : head;
    const isDirectory = rest.includes("/");
    visible.set(entryPath, {
      path: entryPath,
      name: head,
      kind: isDirectory ? "directory" : "file",
      size: isDirectory ? null : document.sizeBytes ?? null,
      updatedAt: isDirectory ? null : document.updatedAt,
    });
  }
  const items = [...visible.values()].sort((left, right) => left.path.localeCompare(right.path)).slice(0, limit);
  return { items, path: root, total: visible.size, limit };
}

export async function getMirrorDocumentTagDetails(documentId: string): Promise<LibraryDocumentTagDetails> {
  const model = await getUsableSnapshot();
  const document = model.documents.find((item) => item.documentId === documentId);
  const binding = model.documentTagBindings.find((item) => item.documentId === documentId);
  const manualTagIds = binding?.manualTagIds ?? [];
  const tagById = new Map(model.tagDetails.map((tag) => [tag.id, tag]));
  const folderBindings = model.folderTagBindings
    .filter((item) => !item.folderPath || document?.path === item.folderPath || document?.path.startsWith(`${item.folderPath}/`))
    .flatMap((item) => item.bindingTagIds.map((tagId) => ({
      id: `folder_${item.folderPath}:${tagId}`,
      folderPath: item.folderPath,
      tagId,
      tagPath: tagById.get(tagId)?.path ?? "",
    })));
  const resolvedTags = [
    ...manualTagIds.map((tagId) => tagById.get(tagId)).filter(Boolean).map((tag) => ({
      path: tag!.path,
      sourceType: "manual_document" as const,
      sourceRef: documentId,
      evidence: null,
      confidence: 1,
      priority: 100,
    })),
    ...folderBindings.map((item) => ({
      path: item.tagPath,
      sourceType: "folder_binding" as const,
      sourceRef: item.id,
      evidence: null,
      confidence: 1,
      priority: 80,
    })),
  ];
  return {
    documentId,
    path: document?.path ?? binding?.path ?? documentId,
    title: document?.title ?? binding?.title ?? documentId,
    manualTagIds,
    effectiveFolderBindings: folderBindings,
    resolvedTags,
    suppressedTags: [],
    recommendedTags: [],
  };
}

export async function getMirrorFolderTagDetails(folderPath: string): Promise<LibraryFolderTagDetails> {
  const model = await getUsableSnapshot();
  const normalized = normalizePath(folderPath);
  const binding = model.folderTagBindings.find((item) => item.folderPath === normalized);
  const tagById = new Map(model.tagDetails.map((tag) => [tag.id, tag]));
  const bindingTagIds = binding?.bindingTagIds ?? [];
  return {
    folderPath: normalized,
    exists: true,
    bindingTagIds,
    bindings: bindingTagIds.map((tagId) => ({
      id: `folder_${normalized}:${tagId}`,
      tagId,
      tagPath: tagById.get(tagId)?.path ?? "",
      applyMode: "recursive",
    })),
    recommendedTags: [],
  };
}

export async function saveMirrorDocumentTags(
  documentId: string,
  input: { tagIds?: string[]; createTagPaths?: string[] },
): Promise<LibraryDocumentTagDetails> {
  const result = await queueMirrorMutation("document_tags", {
    documentId,
    input,
  });
  const details = await getMirrorDocumentTagDetails(documentId);
  return { ...details, syncState: result };
}

export async function saveMirrorFolderTags(
  input: { folderPath?: string; tagIds?: string[]; createTagPaths?: string[] },
): Promise<LibraryFolderTagDetails> {
  const result = await queueMirrorMutation("folder_tags", { input });
  const details = await getMirrorFolderTagDetails(input.folderPath ?? "");
  return { ...details, syncState: result };
}

export async function saveMirrorTagDefinition(
  operation: "create" | "update" | "delete",
  tagId: string | null,
  input: unknown,
): Promise<LibraryTagDetailWithRules | { deletedTagIds: string[] }> {
  const result = await queueMirrorMutation("tag_definition", {
    operation,
    ...(tagId ? { tagId } : {}),
    input,
  });
  const model = await getUsableSnapshot();
  if (operation === "delete") {
    return { deletedTagIds: tagId ? [tagId] : [] };
  }
  const name = typeof input === "object" && input && "name" in input ? String((input as { name?: unknown }).name ?? "") : "";
  const parentId = typeof input === "object" && input && "parentId" in input ? String((input as { parentId?: unknown }).parentId ?? "") : "";
  const path = parentId
    ? `${model.tagDetails.find((tag) => tag.id === parentId)?.path ?? ""}/${name}`
    : name;
  const tag = model.tagDetails.find((item) => item.id === tagId || item.path === path);
  if (!tag) {
    throw new MirrorUnavailableError("标签修改已排队，等待主端返回最新标签定义");
  }
  return { ...tag, syncState: result };
}

export async function requestMirrorTagRecompute(): Promise<{ taskId: string; deduped: boolean; status: "queued" }> {
  try {
    return await postJson("/api/library/tags/recompute", {});
  } catch (error) {
    if (error instanceof MirrorUnavailableError) throw error;
    throw new MirrorUnavailableError("镜像端需要连接主端后才能执行标签重算");
  }
}

export async function flushMirrorMutations(
  baseUrl = getMirrorBaseUrl(),
  mutations?: LibraryMirrorMutation[],
): Promise<LibraryMirrorMutationBatchResult | null> {
  const current = await loadMirrorCache(baseUrl);
  const batch = mutations ?? current.pendingMutations;
  if (batch.length === 0) return null;
  const result = await postJson<LibraryMirrorMutationBatchResult>("/api/library/mirror/mutations", {
    mutations: batch,
  });
  const processed = new Set(result.results.map((item) => item.mutationId));
  await saveMirrorCache(baseUrl, {
    ...current,
    pendingMutations: current.pendingMutations.filter((item) => !processed.has(item.mutationId)),
    syncResults: [...current.syncResults, ...result.results].slice(-20),
    source: "primary",
    lastSyncedAt: new Date().toISOString(),
    lastError: null,
  });
  return result;
}

async function queueMirrorMutation(
  kind: LibraryMirrorMutation["kind"],
  payload: unknown,
): Promise<LibraryMirrorMutationStatus> {
  const baseUrl = getMirrorBaseUrl();
  const current = await loadMirrorCache(baseUrl);
  const mutation: LibraryMirrorMutation = {
    mutationId: cryptoRandomId(),
    kind,
    updatedAt: new Date().toISOString(),
    baseRevision: current.snapshot?.revision ?? null,
    payload: normalizeMutationPayload(
      current.snapshot ? materializeSnapshot(current) : null,
      kind,
      payload,
    ),
  };
  await saveMirrorCache(baseUrl, {
    ...current,
    pendingMutations: [...current.pendingMutations, mutation],
    source: current.snapshot ? "cache" : "empty",
    lastError: null,
  });
  try {
    const result = await flushMirrorMutations(baseUrl, [mutation]);
    const status = result?.results.find((item) => item.mutationId === mutation.mutationId)?.status;
    if (status) {
      const remote = await apiRequest<LibraryMirrorSnapshot>("/api/library/mirror/snapshot");
      const latest = await loadMirrorCache(baseUrl);
      await saveMirrorCache(baseUrl, {
        ...latest,
        snapshot: remote,
        source: "primary",
        lastSyncedAt: new Date().toISOString(),
        lastError: null,
      });
      return status;
    }
  } catch (error) {
    await saveMirrorCache(baseUrl, {
      ...(await loadMirrorCache(baseUrl)),
      lastError: error instanceof Error ? error.message : "镜像同步失败",
    });
  }
  return "queued";
}

function normalizeMutationPayload(
  snapshot: LibraryMirrorSnapshot | null,
  kind: LibraryMirrorMutation["kind"],
  payload: unknown,
): unknown {
  if (!snapshot || (kind !== "document_tags" && kind !== "folder_tags")) {
    return payload;
  }
  const root = asRecord(payload);
  const input = asRecord(root.input);
  const tagById = new Map(snapshot.tagDetails.map((tag) => [tag.id, tag]));
  const tagIds = Array.isArray(input.tagIds) ? input.tagIds.filter((item): item is string => typeof item === "string") : [];
  const createTagPaths = Array.isArray(input.createTagPaths)
    ? input.createTagPaths.filter((item): item is string => typeof item === "string")
    : [];
  const primaryTagIds = tagIds.filter((id) => !id.startsWith("mirror_pending_"));
  const pendingPaths = tagIds.flatMap((id) => {
    const path = tagById.get(id)?.path;
    return id.startsWith("mirror_pending_") && path ? [path] : [];
  });
  return {
    ...root,
    input: {
      ...input,
      tagIds: primaryTagIds,
      createTagPaths: [...new Set([...createTagPaths, ...pendingPaths])],
    },
  };
}

async function getUsableSnapshot(): Promise<LibraryMirrorSnapshot> {
  const cached = await loadMirrorCache(getMirrorBaseUrl());
  if (cached.snapshot) {
    return materializeSnapshot(cached);
  }

  try {
    return await getMirrorSnapshot();
  } catch (error) {
    if (error instanceof MirrorUnavailableError) throw error;
    throw new MirrorUnavailableError();
  }
}

function materializeSnapshot(state: MirrorCacheState): LibraryMirrorSnapshot {
  if (!state.snapshot) {
    throw new MirrorUnavailableError();
  }
  const snapshot = structuredClone(state.snapshot);
  for (const mutation of state.pendingMutations) {
    applyOptimisticMutation(snapshot, mutation);
  }
  snapshot.snapshot.tags = snapshot.tagDetails.map(mapTagToNode);
  return snapshot;
}

function applyOptimisticMutation(model: LibraryMirrorSnapshot, mutation: LibraryMirrorMutation): void {
  const payload = asRecord(mutation.payload);
  if (mutation.kind === "document_tags") {
    const documentId = String(payload.documentId ?? "");
    const input = asRecord(payload.input);
    const document = model.documents.find((item) => item.documentId === documentId);
    const existing = model.documentTagBindings.find((item) => item.documentId === documentId);
    const tagIds = resolveTagIds(model, input.tagIds, input.createTagPaths);
    const binding = {
      documentId,
      path: document?.path ?? existing?.path ?? documentId,
      title: document?.title ?? existing?.title ?? documentId,
      manualTagIds: tagIds,
      updatedAt: mutation.updatedAt,
    };
    model.documentTagBindings = [...model.documentTagBindings.filter((item) => item.documentId !== documentId), binding];
    if (document) {
      document.tags = tagIds.map((tagId) => model.tagDetails.find((tag) => tag.id === tagId)?.path).filter(Boolean) as string[];
    }
    return;
  }
  if (mutation.kind === "folder_tags") {
    const input = asRecord(payload.input);
    const folderPath = normalizePath(String(input.folderPath ?? ""));
    const tagIds = resolveTagIds(model, input.tagIds, input.createTagPaths);
    model.folderTagBindings = [
      ...model.folderTagBindings.filter((item) => item.folderPath !== folderPath),
      { folderPath, bindingTagIds: tagIds, updatedAt: mutation.updatedAt },
    ];
    return;
  }
  if (payload.operation === "delete") {
    const tagId = String(payload.tagId ?? "");
    model.tagDetails = model.tagDetails.filter((tag) => tag.id !== tagId);
    return;
  }
  if (payload.operation === "create") {
    const input = asRecord(payload.input);
    const name = String(input.name ?? "").trim();
    const parentId = String(input.parentId ?? "");
    const parentPath = model.tagDetails.find((tag) => tag.id === parentId)?.path;
    const tagPath = parentPath ? `${parentPath}/${name}` : name;
    if (tagPath && !model.tagDetails.some((tag) => tag.path === tagPath)) {
      model.tagDetails.push({
        id: `mirror_pending_${hashText(tagPath)}`,
        path: tagPath,
        name,
        rootType: tagPath.split("/")[0] ?? name,
        parentId: parentId || null,
        parentPath: parentPath ?? null,
        description: typeof input.description === "string" ? input.description : null,
        status: "active",
        documentCount: 0,
        createdAt: mutation.updatedAt,
        updatedAt: mutation.updatedAt,
        disabledAt: null,
        childTagSelectionMode: input.childTagSelectionMode === "single" ? "single" : "multiple",
        smartRules: [],
        smartRuleEnabled: false,
      });
    }
    return;
  }
  const tagId = String(payload.tagId ?? "");
  const tag = model.tagDetails.find((item) => item.id === tagId);
  if (tag) {
    const input = asRecord(payload.input);
    Object.assign(tag, {
      ...("name" in input ? { name: String(input.name ?? tag.name) } : {}),
      ...("description" in input ? { description: input.description } : {}),
      ...("status" in input ? { status: input.status } : {}),
      updatedAt: mutation.updatedAt,
    });
  }
}

function resolveTagIds(model: LibraryMirrorSnapshot, tagIds: unknown, createTagPaths: unknown): string[] {
  const ids = Array.isArray(tagIds) ? tagIds.filter((item): item is string => typeof item === "string") : [];
  const created = Array.isArray(createTagPaths)
    ? createTagPaths.filter((item): item is string => typeof item === "string").map((path) => {
        const existing = model.tagDetails.find((tag) => tag.path === path);
        if (existing) return existing.id;
        const id = `mirror_pending_${hashText(path)}`;
        model.tagDetails.push({
          id,
          path,
          name: path.split("/").at(-1) ?? path,
          rootType: path.split("/")[0] ?? path,
          parentId: null,
          parentPath: null,
          description: null,
          status: "active",
          documentCount: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          disabledAt: null,
          smartRules: [],
          smartRuleEnabled: false,
        });
        return id;
      })
    : [];
  return [...new Set([...ids, ...created])];
}

function mapTagToNode(tag: LibraryTagDetailWithRules): LibraryTagNode {
  return {
    path: tag.path,
    name: tag.name,
    rootType: tag.rootType,
    parentPath: tag.parentPath,
    depth: tag.path.split("/").filter(Boolean).length - 1,
    documentCount: tag.documentCount,
  };
}

function countDocumentTags(documents: LibraryDocumentRecord[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const document of documents) {
    for (const tag of [...document.tags, ...document.derivedTags]) {
      counts[tag] = (counts[tag] ?? 0) + 1;
    }
  }
  return counts;
}

function matchesFavorite(document: LibraryDocumentRecord, favorite: { kind: string; path: string; tagPaths?: string[] }): boolean {
  if (favorite.kind === "folder") {
    return document.path === favorite.path || document.path.startsWith(`${favorite.path}/`);
  }
  const paths = favorite.tagPaths?.length ? favorite.tagPaths : [favorite.path];
  return paths.every((path) => [...document.tags, ...document.derivedTags].some((tag) => tag === path || tag.startsWith(`${path}/`)));
}

function getMirrorBaseUrl(): string {
  return getRuntimeConfigSnapshot().config.remoteApiBaseUrl.trim().replace(/\/+$/g, "");
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
}

function getParentPath(value: string): string {
  const normalized = normalizePath(value);
  const index = normalized.lastIndexOf("/");
  return index < 0 ? "" : normalized.slice(0, index);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function cryptoRandomId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `mirror_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function hashText(value: string): string {
  let hash = 0;
  for (const character of value) {
    hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
  }
  return Math.abs(hash).toString(36);
}
