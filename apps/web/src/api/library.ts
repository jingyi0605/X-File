import type {
  HttpServerState,
  HostDirectoryBrowseResult,
  LibraryBinding,
  LibraryConfig,
  LibraryDirectoryStatus,
  LibraryDocumentList,
  LibraryDocumentTagDetails,
  LibraryDownload,
  LibraryFavoritesResult,
  LibraryFileList,
  LibraryFolderTagDetails,
  LibraryIndexStatus,
  LibraryOperationInput,
  LibraryOperationResult,
  LibraryPreview,
  LibraryRefreshResult,
  LibrarySnapshot,
  LibraryTagDetailWithRules,
  LibraryTagNode,
  LibraryTagRule,
  OnlyOfficeSettings,
  OnlyOfficeStatus,
  PluginMutationResult,
  PluginListResult,
  InstallPluginInput,
  RequestLibraryRefreshInput,
  SaveHttpServerStateInput,
  SaveLibraryBindingInput,
  SaveLibraryConfigInput,
  UpdatePluginInput,
  UpdateLibraryFavoritesInput,
  UpdateOnlyOfficeSettingsInput,
} from "@x-file/shared";

import { apiRequest, postJson, putJson } from "./http";
import { getRuntimeConfigSnapshot } from "../runtime/runtime-config-store";
import {
  browseNativeHostDirectories,
  createNativeLibraryTag,
  deleteNativeLibraryTag,
  disableNativePlugin,
  enableNativePlugin,
  fetchNativeLibrarySnapshot,
  getNativeDocumentTagDetails,
  getNativeFolderTagDetails,
  getNativeLibraryPreview,
  getNativeHttpServerState,
  getNativeLibraryBinding,
  getNativeLibraryConfig,
  getNativeLibraryTagDetail,
  getNativeLibraryTagRecomputeTask,
  getNativeLibraryTagRecomputeTaskOptional,
  getNativeOnlyOfficeSettings,
  getNativeOnlyOfficeStatus,
  listNativeLibraryTagDetails,
  listNativeLibraryDocuments,
  listNativeLibraryFiles,
  listNativePlugins,
  requestNativeLibraryRefresh,
  requestNativeLibraryTagRecompute,
  saveNativeHttpServerState,
  saveNativeLibraryBinding,
  saveNativeLibraryConfig,
  saveNativeDocumentTags,
  saveNativeFolderTags,
  saveNativeOnlyOfficeSettings,
  updateNativeLibraryTag,
} from "../runtime/native-library-bridge";

export interface ListDocumentsQuery {
  browseMode: "folder" | "tag";
  selectedFolderPath?: string | null;
  selectedTagPath?: string | null;
  selectedTagPaths?: string[] | null;
  selectedFavoriteId?: string | null;
  keyword?: string | null;
  offset?: number;
  limit?: number;
}

export async function getLibraryBinding(): Promise<LibraryBinding | null> {
  if (getRuntimeConfigSnapshot().config.mode === "local") {
    const native = await getNativeLibraryBinding();
    if (native !== null) {
      return native;
    }
  }
  return apiRequest<LibraryBinding | null>("/api/library/binding");
}

export async function listPlugins(): Promise<PluginListResult> {
  if (getRuntimeConfigSnapshot().config.mode === "local") {
    const native = await listNativePlugins();
    if (native) {
      return native;
    }
    throw new Error("主包本地模式已移除内建插件 sidecar，且缺少 native_list_plugins。");
  }
  return apiRequest<PluginListResult>("/api/plugins");
}

export function installPlugin(input: InstallPluginInput): Promise<PluginMutationResult> {
  if (getRuntimeConfigSnapshot().config.mode === "local") {
    throw new Error("主包本地模式已移除内建插件安装 sidecar。");
  }
  return postJson<PluginMutationResult>("/api/plugins/install", input);
}

export function updatePlugin(pluginId: string, input: UpdatePluginInput): Promise<PluginMutationResult> {
  if (getRuntimeConfigSnapshot().config.mode === "local") {
    throw new Error("主包本地模式已移除内建插件更新 sidecar。");
  }
  return postJson<PluginMutationResult>(`/api/plugins/${encodeURIComponent(pluginId)}/update`, input);
}

export async function enablePlugin(pluginId: string): Promise<PluginMutationResult> {
  if (getRuntimeConfigSnapshot().config.mode === "local") {
    const native = await enableNativePlugin(pluginId);
    if (native) {
      return native;
    }
    throw new Error("主包本地模式已移除内建插件 sidecar，且缺少 native_enable_plugin。");
  }
  return putJson<PluginMutationResult>(`/api/plugins/${encodeURIComponent(pluginId)}/enable`, {});
}

export async function disablePlugin(pluginId: string): Promise<PluginMutationResult> {
  if (getRuntimeConfigSnapshot().config.mode === "local") {
    const native = await disableNativePlugin(pluginId);
    if (native) {
      return native;
    }
    throw new Error("主包本地模式已移除内建插件 sidecar，且缺少 native_disable_plugin。");
  }
  return putJson<PluginMutationResult>(`/api/plugins/${encodeURIComponent(pluginId)}/disable`, {});
}

export function uninstallPlugin(pluginId: string): Promise<PluginListResult> {
  if (getRuntimeConfigSnapshot().config.mode === "local") {
    throw new Error("主包本地模式已移除内建插件卸载 sidecar。");
  }
  return apiRequest<PluginListResult>(`/api/plugins/${encodeURIComponent(pluginId)}`, {
    method: "DELETE",
  });
}

export async function saveLibraryBinding(
  input: SaveLibraryBindingInput,
): Promise<LibraryBinding> {
  if (getRuntimeConfigSnapshot().config.mode === "local") {
    const native = await saveNativeLibraryBinding(input);
    if (native) {
      return native;
    }
  }
  return putJson<LibraryBinding>("/api/library/binding", input);
}

export async function browseHostDirectories(
  path?: string | null,
): Promise<HostDirectoryBrowseResult> {
  if (getRuntimeConfigSnapshot().config.mode === "local") {
    const native = await browseNativeHostDirectories(path ?? null);
    if (native) {
      return native;
    }
  }
  const search = new URLSearchParams();
  appendSearch(search, "path", path);
  const query = search.toString();
  return apiRequest<HostDirectoryBrowseResult>(
    `/api/host/directories${query ? `?${query}` : ""}`,
  );
}

export async function getLibraryConfig(): Promise<LibraryConfig> {
  if (getRuntimeConfigSnapshot().config.mode === "local") {
    const native = await getNativeLibraryConfig();
    if (native) {
      return native;
    }
  }
  return apiRequest<LibraryConfig>("/api/library/config");
}

export async function saveLibraryConfig(
  input: SaveLibraryConfigInput,
): Promise<LibraryConfig> {
  if (getRuntimeConfigSnapshot().config.mode === "local") {
    const native = await saveNativeLibraryConfig(input);
    if (native) {
      return native;
    }
  }
  return putJson<LibraryConfig>("/api/library/config", input);
}

export function getLibrarySnapshot(): Promise<LibrarySnapshot> {
  if (shouldUseNativeLibraryBridge()) {
    return getLibrarySnapshotWithNative();
  }
  return apiRequest<LibrarySnapshot>("/api/library/snapshot");
}

export function listLibraryDocuments(
  query: ListDocumentsQuery,
): Promise<LibraryDocumentList> {
  if (shouldUseNativeLibraryBridge()) {
    return listLibraryDocumentsWithNative(query);
  }
  const search = new URLSearchParams();
  search.set("browseMode", query.browseMode);
  appendSearch(search, "selectedFolderPath", query.selectedFolderPath);
  appendSearch(search, "selectedTagPath", query.selectedTagPath);
  appendSearch(search, "selectedFavoriteId", query.selectedFavoriteId);
  appendSearch(search, "keyword", query.keyword);

  if (query.selectedTagPaths?.length) {
    search.set("selectedTagPaths", query.selectedTagPaths.join(","));
  }
  if (typeof query.offset === "number") {
    search.set("offset", String(query.offset));
  }
  if (typeof query.limit === "number") {
    search.set("limit", String(query.limit));
  }

  return apiRequest<LibraryDocumentList>(
    `/api/library/documents?${search.toString()}`,
  );
}

export function listLibraryFiles(
  path: string | null,
  limit = 200,
): Promise<LibraryFileList> {
  if (shouldUseNativeLibraryBridge()) {
    return listLibraryFilesWithNative(path, limit);
  }
  const search = new URLSearchParams();
  appendSearch(search, "path", path);
  search.set("limit", String(limit));
  return apiRequest<LibraryFileList>(`/api/library/files?${search.toString()}`);
}

export function getLibraryPreview(
  path: string,
  displayMode?: "default" | "reading",
): Promise<LibraryPreview> {
  if (shouldUseNativeLibraryBridge()) {
    return getLibraryPreviewWithNative(path, displayMode);
  }
  const search = new URLSearchParams();
  search.set("path", path);
  if (displayMode) {
    search.set("displayMode", displayMode);
  }
  return apiRequest<LibraryPreview>(
    `/api/library/preview?${search.toString()}`,
  );
}

export function downloadLibraryFile(path: string): Promise<LibraryDownload> {
  const search = new URLSearchParams();
  search.set("path", path);
  return apiRequest<LibraryDownload>(
    `/api/library/download?${search.toString()}`,
  );
}

export function operateLibraryFile(
  input: LibraryOperationInput,
): Promise<LibraryOperationResult> {
  return postJson<LibraryOperationResult>("/api/library/ops", input);
}

export function requestLibraryRefresh(
  input: RequestLibraryRefreshInput,
): Promise<LibraryRefreshResult> {
  if (shouldUseNativeLibraryBridge()) {
    return requestLibraryRefreshWithNative(input);
  }
  return postJson<LibraryRefreshResult>("/api/library/refresh", input);
}

export function updateLibraryFavorites(
  input: UpdateLibraryFavoritesInput,
): Promise<LibraryFavoritesResult> {
  return putJson<LibraryFavoritesResult>("/api/library/favorites", input);
}

export async function listLibraryTags(): Promise<LibraryTagNode[]> {
  if (shouldUseNativeLibraryBridge()) {
    const native = await listNativeLibraryTagDetails(false);
    if (native) {
      return native.items.map(mapLibraryTagDetailToNode);
    }
  }
  const payload = await apiRequest<LibraryTagListResponse | LibraryTagNode[]>(
    "/api/library/tags",
  );
  if (Array.isArray(payload)) {
    return payload;
  }
  return payload.items.map((item) => ({
    path: item.path,
    name: item.name,
    rootType: item.rootType,
    parentPath: item.parentPath,
    depth: item.path.split("/").filter(Boolean).length - 1,
    documentCount: item.documentCount,
  }));
}

export async function listLibraryTagDetails(
  includeDisabled = true,
): Promise<LibraryTagDetailWithRules[]> {
  if (shouldUseNativeLibraryBridge()) {
    const native = await listNativeLibraryTagDetails(includeDisabled);
    if (native) {
      return native.items;
    }
  }
  const search = new URLSearchParams();
  if (includeDisabled) {
    search.set("includeDisabled", "true");
  }
  const payload = await apiRequest<
    LibraryTagListResponse | LibraryTagDetailWithRules[]
  >(`/api/library/tags${search.toString() ? `?${search.toString()}` : ""}`);
  return Array.isArray(payload) ? payload : payload.items;
}

export function getDocumentTagDetails(
  documentId: string,
): Promise<LibraryDocumentTagDetails> {
  if (shouldUseNativeLibraryBridge()) {
    return getDocumentTagDetailsWithNative(documentId);
  }
  return apiRequest<LibraryDocumentTagDetails>(
    `/api/library/documents/${encodeURIComponent(documentId)}/tag-details`,
  );
}

export function saveDocumentTags(
  documentId: string,
  input: SaveLibraryTagsInput,
): Promise<LibraryDocumentTagDetails> {
  if (shouldUseNativeLibraryBridge()) {
    return saveDocumentTagsWithNative(documentId, input);
  }
  return putJson<LibraryDocumentTagDetails>(
    `/api/library/documents/${encodeURIComponent(documentId)}/tags`,
    input,
  );
}

export function getFolderTagDetails(
  folderPath: string,
): Promise<LibraryFolderTagDetails> {
  if (shouldUseNativeLibraryBridge()) {
    return getFolderTagDetailsWithNative(folderPath);
  }
  const search = new URLSearchParams();
  appendSearch(search, "folderPath", folderPath);
  return apiRequest<LibraryFolderTagDetails>(
    `/api/library/folders/tag-details?${search.toString()}`,
  );
}

export function saveFolderTags(
  input: SaveLibraryFolderTagsInput,
): Promise<LibraryFolderTagDetails> {
  if (shouldUseNativeLibraryBridge()) {
    return saveFolderTagsWithNative(input);
  }
  return putJson<LibraryFolderTagDetails>("/api/library/folders/tags", input);
}

export function getLibraryTagDetail(
  tagId: string,
): Promise<LibraryTagDetailWithRules> {
  if (shouldUseNativeLibraryBridge()) {
    return getLibraryTagDetailWithNative(tagId);
  }
  return apiRequest<LibraryTagDetailWithRules>(
    `/api/library/tags/${encodeURIComponent(tagId)}`,
  );
}

export function createLibraryTag(
  input: SaveLibraryTagDefinitionInput,
): Promise<LibraryTagDetailWithRules> {
  if (shouldUseNativeLibraryBridge()) {
    return createLibraryTagWithNative(input);
  }
  return postJson<LibraryTagDetailWithRules>("/api/library/tags", input);
}

export function updateLibraryTag(
  tagId: string,
  input: SaveLibraryTagDefinitionInput,
): Promise<LibraryTagDetailWithRules> {
  if (shouldUseNativeLibraryBridge()) {
    return updateLibraryTagWithNative(tagId, input);
  }
  return putJson<LibraryTagDetailWithRules>(
    `/api/library/tags/${encodeURIComponent(tagId)}`,
    input,
  );
}

export function deleteLibraryTag(
  tagId: string,
): Promise<{ deletedTagIds: string[] }> {
  if (shouldUseNativeLibraryBridge()) {
    return deleteLibraryTagWithNative(tagId);
  }
  return apiRequest<{ deletedTagIds: string[] }>(
    `/api/library/tags/${encodeURIComponent(tagId)}`,
    {
      method: "DELETE",
    },
  );
}

export function requestLibraryTagRecompute(): Promise<LibraryTagRecomputeRequestResult> {
  if (shouldUseNativeLibraryBridge()) {
    return requestLibraryTagRecomputeWithNative();
  }
  return postJson<LibraryTagRecomputeRequestResult>(
    "/api/library/tags/recompute",
    {},
  );
}

export function getLibraryTagRecomputeTask(): Promise<LibraryTagRecomputeTask | null> {
  if (shouldUseNativeLibraryBridge()) {
    return getLibraryTagRecomputeTaskWithNative();
  }
  return apiRequest<LibraryTagRecomputeTask | null>(
    "/api/library/tags/recompute-task",
  );
}

export async function getOnlyOfficeSettings(): Promise<OnlyOfficeSettings> {
  if (getRuntimeConfigSnapshot().config.mode === "local") {
    const native = await getNativeOnlyOfficeSettings();
    if (native) {
      return native;
    }
    throw new Error("主包本地模式已移除内建 ONLYOFFICE sidecar，且缺少 native_get_onlyoffice_settings。");
  }
  return apiRequest<OnlyOfficeSettings>("/api/office/onlyoffice/settings");
}

export async function saveOnlyOfficeSettings(
  input: UpdateOnlyOfficeSettingsInput,
): Promise<OnlyOfficeSettings> {
  if (getRuntimeConfigSnapshot().config.mode === "local") {
    const native = await saveNativeOnlyOfficeSettings(input);
    if (native) {
      return native;
    }
    throw new Error("主包本地模式已移除内建 ONLYOFFICE sidecar，且缺少 native_save_onlyoffice_settings。");
  }
  return putJson<OnlyOfficeSettings>("/api/office/onlyoffice/settings", input);
}

export async function getOnlyOfficeStatus(): Promise<OnlyOfficeStatus> {
  if (getRuntimeConfigSnapshot().config.mode === "local") {
    const native = await getNativeOnlyOfficeStatus();
    if (native) {
      return native;
    }
    throw new Error("主包本地模式已移除内建 ONLYOFFICE sidecar，且缺少 native_get_onlyoffice_status。");
  }
  return apiRequest<OnlyOfficeStatus>("/api/office/onlyoffice/status");
}

export async function getHttpServerState(): Promise<HttpServerState> {
  if (getRuntimeConfigSnapshot().config.mode === "local") {
    const native = await getNativeHttpServerState();
    if (native) {
      return native;
    }
    throw new Error("主包本地模式已移除内建 HTTP server sidecar，且缺少 native_get_http_server_state。");
  }
  return apiRequest<HttpServerState>("/api/server/state");
}

export async function saveHttpServerState(
  input: SaveHttpServerStateInput,
): Promise<HttpServerState> {
  if (getRuntimeConfigSnapshot().config.mode === "local") {
    const native = await saveNativeHttpServerState(input);
    if (native) {
      return native;
    }
    throw new Error("主包本地模式已移除内建 HTTP server sidecar，且缺少 native_save_http_server_state。");
  }
  return putJson<HttpServerState>("/api/server/state", input);
}

function appendSearch(
  search: URLSearchParams,
  key: string,
  value: string | null | undefined,
): void {
  const normalized = value?.trim();
  if (normalized) {
    search.set(key, normalized);
  }
}

function shouldUseNativeLibraryBridge(): boolean {
  return (
    getRuntimeConfigSnapshot().config.mode === "local"
    && typeof window !== "undefined"
    && "__TAURI_INTERNALS__" in window
  );
}

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

function normalizeLibraryDirectoryStatus(
  status: Partial<LibraryDirectoryStatus> | null | undefined,
): LibraryDirectoryStatus | null {
  if (!status || typeof status.path !== "string" || !status.path.trim()) {
    return null;
  }
  return {
    path: status.path,
    state: typeof status.state === "string" && status.state.trim() ? status.state : "idle",
    source: typeof status.source === "string" && status.source.trim() ? status.source : "snapshot",
    lastRequestedAt: status.lastRequestedAt ?? null,
    lastCompletedAt: status.lastCompletedAt ?? null,
    lastFailedAt: status.lastFailedAt ?? null,
    runningTaskId: status.runningTaskId ?? null,
    errorSummary: status.errorSummary ?? null,
    generatedAt: status.generatedAt ?? null,
    filesystemObservedAt: status.filesystemObservedAt ?? null,
    staleReason: status.staleReason ?? null,
  };
}

function normalizeLibrarySnapshot(snapshot: LibrarySnapshot): LibrarySnapshot {
  return {
    ...snapshot,
    status: normalizeLibraryIndexStatus(snapshot.status),
  };
}

function normalizeLibraryRefreshResult(
  result: LibraryRefreshResult,
): LibraryRefreshResult {
  return {
    ...result,
    status: normalizeLibraryIndexStatus(result.status),
    directoryStatus: normalizeLibraryDirectoryStatus(result.directoryStatus),
  };
}

async function getLibrarySnapshotWithNative(): Promise<LibrarySnapshot> {
  const native = await fetchNativeLibrarySnapshot();
  if (!native) {
    throw new Error("本地模式缺少 native_get_library_snapshot");
  }
  return normalizeLibrarySnapshot(native.snapshot);
}

async function listLibraryDocumentsWithNative(
  query: ListDocumentsQuery,
): Promise<LibraryDocumentList> {
  const native = await listNativeLibraryDocuments({
    browseMode: query.browseMode,
    selectedFolderPath: query.selectedFolderPath,
    selectedTagPath: query.selectedTagPath,
    selectedTagPaths: query.selectedTagPaths,
    selectedFavoriteId: query.selectedFavoriteId,
    keyword: query.keyword,
    offset: query.offset,
    limit: query.limit,
  });
  if (!native) {
    throw new Error("本地模式缺少 native_list_library_documents");
  }
  return native;
}

async function listLibraryFilesWithNative(
  path: string | null,
  limit: number,
): Promise<LibraryFileList> {
  const native = await listNativeLibraryFiles(path, limit);
  if (!native) {
    throw new Error("本地模式缺少 native_list_library_files");
  }
  return native;
}

async function getLibraryPreviewWithNative(
  path: string,
  displayMode?: "default" | "reading",
): Promise<LibraryPreview> {
  const native = await getNativeLibraryPreview(path, displayMode);
  if (!native) {
    throw new Error("本地模式缺少 native_get_library_preview");
  }
  return native;
}

async function requestLibraryRefreshWithNative(
  input: RequestLibraryRefreshInput,
): Promise<LibraryRefreshResult> {
  const native = await requestNativeLibraryRefresh({
    reason: input.reason ?? null,
    targetPath: input.targetPath ?? null,
    mode: "full",
  });
  if (!native) {
    throw new Error("本地模式缺少 native_request_library_refresh");
  }
  return normalizeLibraryRefreshResult(native.backendResponse);
}

async function getDocumentTagDetailsWithNative(
  documentId: string,
): Promise<LibraryDocumentTagDetails> {
  const native = await getNativeDocumentTagDetails(documentId);
  if (!native) {
    throw new Error("本地模式缺少 native_get_document_tag_details");
  }
  return native;
}

async function saveDocumentTagsWithNative(
  documentId: string,
  input: SaveLibraryTagsInput,
): Promise<LibraryDocumentTagDetails> {
  const native = await saveNativeDocumentTags(documentId, input);
  if (!native) {
    throw new Error("本地模式缺少 native_save_document_tags");
  }
  return native;
}

async function getFolderTagDetailsWithNative(
  folderPath: string,
): Promise<LibraryFolderTagDetails> {
  const native = await getNativeFolderTagDetails(folderPath);
  if (!native) {
    throw new Error("本地模式缺少 native_get_folder_tag_details");
  }
  return native;
}

async function saveFolderTagsWithNative(
  input: SaveLibraryFolderTagsInput,
): Promise<LibraryFolderTagDetails> {
  const native = await saveNativeFolderTags(input);
  if (!native) {
    throw new Error("本地模式缺少 native_save_folder_tags");
  }
  return native;
}

async function getLibraryTagDetailWithNative(
  tagId: string,
): Promise<LibraryTagDetailWithRules> {
  const native = await getNativeLibraryTagDetail(tagId);
  if (!native) {
    throw new Error("本地模式缺少 native_get_library_tag_detail");
  }
  return native;
}

async function createLibraryTagWithNative(
  input: SaveLibraryTagDefinitionInput,
): Promise<LibraryTagDetailWithRules> {
  const native = await createNativeLibraryTag(input);
  if (!native) {
    throw new Error("本地模式缺少 native_create_library_tag");
  }
  return native;
}

async function updateLibraryTagWithNative(
  tagId: string,
  input: SaveLibraryTagDefinitionInput,
): Promise<LibraryTagDetailWithRules> {
  const native = await updateNativeLibraryTag(tagId, input);
  if (!native) {
    throw new Error("本地模式缺少 native_update_library_tag");
  }
  return native;
}

async function deleteLibraryTagWithNative(
  tagId: string,
): Promise<{ deletedTagIds: string[] }> {
  const native = await deleteNativeLibraryTag(tagId);
  if (!native) {
    throw new Error("本地模式缺少 native_delete_library_tag");
  }
  return native;
}

async function requestLibraryTagRecomputeWithNative(): Promise<LibraryTagRecomputeRequestResult> {
  const native = await requestNativeLibraryTagRecompute();
  if (!native) {
    throw new Error("本地模式缺少 native_request_library_tag_recompute");
  }
  return native;
}

async function getLibraryTagRecomputeTaskWithNative(): Promise<LibraryTagRecomputeTask | null> {
  const native = await getNativeLibraryTagRecomputeTaskOptional();
  if (!native.available) {
    throw new Error("本地模式缺少 native_get_library_tag_recompute_task");
  }
  return native.value;
}

function mapLibraryTagDetailToNode(item: LibraryTagDetailWithRules): LibraryTagNode {
  return {
    path: item.path,
    name: item.name,
    rootType: item.rootType,
    parentPath: item.parentPath,
    depth: item.path.split("/").filter(Boolean).length - 1,
    documentCount: item.documentCount,
  };
}

export interface SaveLibraryTagsInput {
  tagIds?: string[];
  createTagPaths?: string[];
}

export interface SaveLibraryFolderTagsInput extends SaveLibraryTagsInput {
  folderPath?: string;
}

export interface SaveLibraryTagDefinitionInput {
  name?: string;
  parentId?: string | null;
  description?: string | null;
  status?: "active" | "disabled";
  smartRules?: LibraryTagRule[];
}

interface LibraryTagListResponse {
  items: LibraryTagDetailWithRules[];
}

export interface LibraryTagRecomputeRequestResult {
  taskId: string;
  deduped: boolean;
  status: "queued";
}

export interface LibraryTagRecomputeTask {
  taskId: string;
  taskType: string;
  key: string;
  state: "queued" | "running" | "failed" | "fresh" | "queue_timeout";
  source: string;
  queuedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
  errorSummary: string | null;
  runningStage: string | null;
  deduped?: boolean;
}
