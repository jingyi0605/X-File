import type {
  HttpServerState,
  HostDirectoryBrowseResult,
  LibraryBinding,
  LibraryConfig,
  LibraryDocumentList,
  LibraryDocumentTagDetails,
  LibraryDownload,
  LibraryFavoritesResult,
  LibraryFileList,
  LibraryFolderTagDetails,
  LibraryOperationInput,
  LibraryOperationResult,
  LibraryPreview,
  LibraryRefreshResult,
  LibrarySnapshot,
  LibraryTagDetailWithRules,
  LibraryTagNode,
  OnlyOfficeSettings,
  OnlyOfficeStatus,
  RequestLibraryRefreshInput,
  SaveHttpServerStateInput,
  SaveLibraryBindingInput,
  SaveLibraryConfigInput,
  UpdateLibraryFavoritesInput,
  UpdateOnlyOfficeSettingsInput
} from "@x-file/shared";

import { apiRequest, postJson, putJson } from "./http";

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

export function getLibraryBinding(): Promise<LibraryBinding | null> {
  return apiRequest<LibraryBinding | null>("/api/library/binding");
}

export function saveLibraryBinding(input: SaveLibraryBindingInput): Promise<LibraryBinding> {
  return putJson<LibraryBinding>("/api/library/binding", input);
}

export function browseHostDirectories(path?: string | null): Promise<HostDirectoryBrowseResult> {
  const search = new URLSearchParams();
  appendSearch(search, "path", path);
  const query = search.toString();
  return apiRequest<HostDirectoryBrowseResult>(`/api/host/directories${query ? `?${query}` : ""}`);
}

export function getLibraryConfig(): Promise<LibraryConfig> {
  return apiRequest<LibraryConfig>("/api/library/config");
}

export function saveLibraryConfig(input: SaveLibraryConfigInput): Promise<LibraryConfig> {
  return putJson<LibraryConfig>("/api/library/config", input);
}

export function getLibrarySnapshot(): Promise<LibrarySnapshot> {
  return apiRequest<LibrarySnapshot>("/api/library/snapshot");
}

export function listLibraryDocuments(query: ListDocumentsQuery): Promise<LibraryDocumentList> {
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

  return apiRequest<LibraryDocumentList>(`/api/library/documents?${search.toString()}`);
}

export function listLibraryFiles(path: string | null, limit = 200): Promise<LibraryFileList> {
  const search = new URLSearchParams();
  appendSearch(search, "path", path);
  search.set("limit", String(limit));
  return apiRequest<LibraryFileList>(`/api/library/files?${search.toString()}`);
}

export function getLibraryPreview(path: string, displayMode?: "default" | "reading"): Promise<LibraryPreview> {
  const search = new URLSearchParams();
  search.set("path", path);
  if (displayMode) {
    search.set("displayMode", displayMode);
  }
  return apiRequest<LibraryPreview>(`/api/library/preview?${search.toString()}`);
}

export function downloadLibraryFile(path: string): Promise<LibraryDownload> {
  const search = new URLSearchParams();
  search.set("path", path);
  return apiRequest<LibraryDownload>(`/api/library/download?${search.toString()}`);
}

export function operateLibraryFile(input: LibraryOperationInput): Promise<LibraryOperationResult> {
  return postJson<LibraryOperationResult>("/api/library/ops", input);
}

export function requestLibraryRefresh(input: RequestLibraryRefreshInput): Promise<LibraryRefreshResult> {
  return postJson<LibraryRefreshResult>("/api/library/refresh", input);
}

export function updateLibraryFavorites(input: UpdateLibraryFavoritesInput): Promise<LibraryFavoritesResult> {
  return putJson<LibraryFavoritesResult>("/api/library/favorites", input);
}

export async function listLibraryTags(): Promise<LibraryTagNode[]> {
  const payload = await apiRequest<LibraryTagListResponse | LibraryTagNode[]>("/api/library/tags");
  if (Array.isArray(payload)) {
    return payload;
  }
  return payload.items.map((item) => ({
    path: item.path,
    name: item.name,
    rootType: item.rootType,
    parentPath: item.parentPath,
    depth: item.path.split("/").filter(Boolean).length - 1,
    documentCount: item.documentCount
  }));
}

export function getDocumentTagDetails(documentId: string): Promise<LibraryDocumentTagDetails> {
  return apiRequest<LibraryDocumentTagDetails>(`/api/library/documents/${encodeURIComponent(documentId)}/tag-details`);
}

export function saveDocumentTags(documentId: string, input: SaveLibraryTagsInput): Promise<LibraryDocumentTagDetails> {
  return putJson<LibraryDocumentTagDetails>(`/api/library/documents/${encodeURIComponent(documentId)}/tags`, input);
}

export function getFolderTagDetails(folderPath: string): Promise<LibraryFolderTagDetails> {
  const search = new URLSearchParams();
  appendSearch(search, "folderPath", folderPath);
  return apiRequest<LibraryFolderTagDetails>(`/api/library/folders/tag-details?${search.toString()}`);
}

export function saveFolderTags(input: SaveLibraryFolderTagsInput): Promise<LibraryFolderTagDetails> {
  return putJson<LibraryFolderTagDetails>("/api/library/folders/tags", input);
}

export function getOnlyOfficeSettings(): Promise<OnlyOfficeSettings> {
  return apiRequest<OnlyOfficeSettings>("/api/office/onlyoffice/settings");
}

export function saveOnlyOfficeSettings(input: UpdateOnlyOfficeSettingsInput): Promise<OnlyOfficeSettings> {
  return putJson<OnlyOfficeSettings>("/api/office/onlyoffice/settings", input);
}

export function getOnlyOfficeStatus(): Promise<OnlyOfficeStatus> {
  return apiRequest<OnlyOfficeStatus>("/api/office/onlyoffice/status");
}

export function getHttpServerState(): Promise<HttpServerState> {
  return apiRequest<HttpServerState>("/api/server/state");
}

export function saveHttpServerState(input: SaveHttpServerStateInput): Promise<HttpServerState> {
  return putJson<HttpServerState>("/api/server/state", input);
}

function appendSearch(search: URLSearchParams, key: string, value: string | null | undefined): void {
  const normalized = value?.trim();
  if (normalized) {
    search.set(key, normalized);
  }
}

export interface SaveLibraryTagsInput {
  tagIds?: string[];
  createTagPaths?: string[];
}

export interface SaveLibraryFolderTagsInput extends SaveLibraryTagsInput {
  folderPath?: string;
}

interface LibraryTagListResponse {
  items: LibraryTagDetailWithRules[];
}
