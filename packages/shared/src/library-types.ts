export type LibraryId = string;

export type LibraryExportMode = "v2";
export type LibraryFolderOpenBehavior = "single_click" | "double_click";
export type LibraryBrowseMode = "folder" | "tag";

export type LibraryFavoriteKind = "folder" | "tag" | "tag_filter";
export type LibraryIndexState = "fresh" | "stale" | "queued" | "running" | "queue_timeout" | "cooldown" | "failed";
export type LibraryDirectoryState = "idle" | "queued" | "running" | "queue_timeout" | "fresh" | "failed";
export type LibraryDirectorySource = "live" | "snapshot" | "mixed" | "stale_fallback";

export interface LibraryBinding {
  libraryId: LibraryId;
  rootDir: string;
  enabled: boolean;
  mirrorRoot: string | null;
  allowedExtensions: string[];
  includedHiddenPaths: string[];
  folderOpenBehavior: LibraryFolderOpenBehavior;
  configRelativePath: string;
  exportMode: LibraryExportMode;
  /**
   * 初始化是否真正完成。
   * 注意：binding 存在只表示选过路径，不表示初始化流程完成。
   */
  initialized: boolean;
  initializedAt: string | null;
  updatedAt: string;
}

export interface SaveLibraryBindingInput {
  rootDir: string;
  /** 只有初始化流程最后一步才传 true；普通保存路径不能伪装成初始化完成。 */
  completeInitialization?: boolean;
}

export interface HostDirectoryOption {
  path: string;
  name: string;
}

export interface HostDirectoryBrowseResult {
  currentPath: string;
  parentPath: string | null;
  roots: HostDirectoryOption[];
  items: HostDirectoryOption[];
}

export interface LibraryConfig {
  binding: LibraryBinding | null;
  mirrorRoot: string | null;
  allowedExtensions: string[];
  includedHiddenPaths: string[];
  folderOpenBehavior: LibraryFolderOpenBehavior;
  configRelativePath: string;
  canWrite: boolean;
  applyConfigTaskId?: string;
  applyConfigStatus?: LibraryIndexStatus;
}

export interface LibraryConfigWriteResult {
  config: LibraryConfig;
  refresh?: LibraryRefreshResult | null;
}

export interface SaveLibraryConfigInput {
  mirrorRoot?: string | null;
  allowedExtensions?: string[];
  includedHiddenPaths?: string[];
  folderOpenBehavior?: LibraryFolderOpenBehavior;
}

export interface LibraryIndexStatus {
  state: LibraryIndexState;
  dirtyReasons: string[];
  lastRequestedAt: string | null;
  lastStartedAt: string | null;
  lastCompletedAt: string | null;
  lastFailedAt: string | null;
  nextAllowedAt: string | null;
  runningTaskId: string | null;
  runningStage: string | null;
  errorSummary: string | null;
  workerHealth?: LibraryWorkerHealth | null;
  progress?: LibraryIndexProgress | null;
}

export interface LibraryWorkerHealth {
  workerKey: string;
  rootDir: string | null;
  state: "idle" | "running" | "terminating" | "recycled";
  pid: number | null;
  inflightLocalCount: number;
  inflightRemoteRequestCount: number;
  startedAt: string | null;
  lastHeartbeatAt: string | null;
  lastStartedAt: string | null;
  lastCompletedAt: string | null;
  lastFailedAt: string | null;
  lastSoftCancelRequestedAt: string | null;
  lastHardKillAt: string | null;
  lastExitAt: string | null;
  lastTerminationReason: string | null;
}

export interface LibraryIndexProgress {
  scannedCount: number;
  indexedCount: number;
  skippedCount: number;
  failedCount: number;
  unchangedCount: number;
  totalCount: number | null;
  maxConcurrency: number | null;
}

export interface LibraryDirectoryStatus {
  path: string;
  state: LibraryDirectoryState;
  source: LibraryDirectorySource;
  lastRequestedAt: string | null;
  lastCompletedAt: string | null;
  lastFailedAt: string | null;
  runningTaskId: string | null;
  errorSummary: string | null;
  generatedAt?: string | null;
  filesystemObservedAt?: string | null;
  staleReason?: string | null;
}

export interface LibraryFavoriteRecord {
  kind: LibraryFavoriteKind;
  path: string;
  label: string;
  tagPaths?: string[];
}

export interface LibraryDocumentRecord {
  documentId: string;
  path: string;
  title: string;
  summary: string;
  updatedAt: string;
  createdAt?: string | null;
  sizeBytes?: number | null;
  tags: string[];
  derivedTags: string[];
  isFavorite: boolean;
}

export interface LibraryTagNode {
  path: string;
  name: string;
  rootType: string;
  parentPath: string | null;
  depth: number;
  documentCount: number;
}

export interface LibraryFolderNode {
  path: string;
  name: string;
  parentPath: string | null;
  directDocumentCount: number;
  documentCount: number;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface LibrarySnapshot {
  binding: LibraryBinding | null;
  /**
   * 后端统一给出的初始化状态。
   * binding 不存在或 binding.initialized 不是 true 时必须为 true，前端据此固定进入初始化页面。
   */
  requiresInitialization: boolean;
  /** 初始化页面的稳定入口标识；当前前端没有路由系统，只作为重定向目标变量暴露。 */
  initializationRedirectPath: string;
  status: LibraryIndexStatus;
  tags: LibraryTagNode[];
  favorites: LibraryFavoriteRecord[];
  folders: LibraryFolderNode[];
  documentCount: number;
  lastError: string | null;
}

export interface ListLibraryDocumentsInput {
  browseMode: LibraryBrowseMode;
  selectedFolderPath?: string | null;
  selectedTagPath?: string | null;
  selectedTagPaths?: string[] | null;
  selectedFavoriteId?: string | null;
  keyword?: string | null;
  offset?: number;
  limit?: number;
}

export interface LibraryDocumentList {
  total: number;
  visibleEntryTotal?: number;
  offset: number;
  limit: number;
  items: LibraryDocumentRecord[];
  tagFacetCounts?: Record<string, number>;
  directoryStatus?: LibraryDirectoryStatus | null;
}

export interface ListLibraryFilesInput {
  path?: string | null;
  limit?: number;
}

export interface LibraryFileNode {
  path: string;
  name: string;
  kind: "file" | "directory";
  size: number | null;
  updatedAt: string | null;
  matchSource?: "path" | "content" | "path_and_content";
  snippet?: string | null;
  matchScore?: number | null;
  children?: LibraryFileNode[];
}

export interface LibraryFileList {
  items: LibraryFileNode[];
  path?: string;
  total?: number;
  limit?: number;
}

export type LibraryPreviewKind =
  | "text"
  | "markdown"
  | "html"
  | "image"
  | "pdf"
  | "office"
  | "binary"
  | "unsupported";

export interface LibraryPreviewCapabilities {
  canEdit: boolean;
  canRefresh: boolean;
  canResize: boolean;
  canZoom: boolean;
  canPaginate: boolean;
}

export interface LibraryOnlyOfficePreview {
  apiScriptUrl: string;
  editorMode: "edit" | "view";
  documentUrl: string;
  callbackUrl: string;
  editorConfig: Record<string, unknown>;
}

export type OnlyOfficeStatusState = "disabled" | "misconfigured" | "ready" | "warning" | "error";

export interface OnlyOfficeSettings {
  enabled: boolean;
  serverUrl: string | null;
  publicBaseUrl: string | null;
  callbackBaseUrl: string | null;
  userDisplayName: string | null;
  userAvatarUrl: string | null;
  jwtSecretConfigured: boolean;
  updatedAt: string | null;
}

export interface UpdateOnlyOfficeSettingsInput {
  enabled?: boolean;
  serverUrl?: string | null;
  publicBaseUrl?: string | null;
  callbackBaseUrl?: string | null;
  userDisplayName?: string | null;
  userAvatarUrl?: string | null;
  jwtSecret?: string | null;
  clearJwtSecret?: boolean;
}

export interface OnlyOfficeStatus {
  state: OnlyOfficeStatusState;
  summary: string;
  checkedAt: string;
  checks: Array<{
    key: string;
    label: string;
    status: "pass" | "warn" | "fail" | "skip";
    detail: string;
  }>;
}

export interface LibraryPreview {
  libraryId: LibraryId;
  path: string;
  supported: boolean;
  kind: LibraryPreviewKind;
  reason: string | null;
  content: string | null;
  version: string | null;
  size: number;
  updatedAt: string | null;
  previewPath: string | null;
  previewUrl: string | null;
  onlyOffice: LibraryOnlyOfficePreview | null;
  capabilities: LibraryPreviewCapabilities;
}

export interface GetLibraryPreviewInput {
  path: string;
  displayMode?: string;
}

export interface LibraryDownload {
  libraryId: LibraryId;
  path: string;
  fileName: string;
  contentBase64: string;
  size: number;
  updatedAt: string;
}

export type LibraryOperationType = "delete" | "move" | "copy" | "create_directory" | "create_file" | "write";

export interface LibraryOperationInput {
  opType: LibraryOperationType;
  srcPath?: string;
  dstPath?: string | null;
  content?: string | null;
  expectedVersion?: string | null;
}

export interface LibraryOperationResult {
  success: boolean;
  opType: LibraryOperationType | string;
  sourcePath: string;
  targetPath: string | null;
  detail?: string;
  todo?: boolean;
}

export interface RequestLibraryRefreshInput {
  reason?: string;
  targetPath?: string | null;
}

export interface LibraryRefreshResult {
  accepted?: boolean;
  libraryId?: LibraryId;
  reason?: string;
  targetPath?: string | null;
  scheduled?: boolean;
  taskId?: string;
  deduped?: boolean;
  status: LibraryIndexStatus;
  directoryStatus?: LibraryDirectoryStatus | null;
}

export interface UpdateLibraryFavoritesInput {
  favorites: LibraryFavoriteRecord[];
}

export interface LibraryFavoritesResult {
  items: LibraryFavoriteRecord[];
}

export type LibraryServerLifecycleState = "disabled" | "starting" | "running" | "failed" | "stopping";

export interface HttpServerState {
  enabled: boolean;
  host: string;
  port: number;
  running: boolean;
  persistent: boolean;
  lifecycleState?: LibraryServerLifecycleState;
  startedAt: string | null;
  lastError: string | null;
}

export interface SaveHttpServerStateInput {
  enabled?: boolean;
  port?: number;
  persistent?: boolean;
}

export interface LibraryHealth {
  ok: true;
  app: "X-File";
  version: string;
}

export interface LibraryErrorResponse {
  detail: string;
  errorCode: LibraryErrorCode;
  field?: string;
  timestamp: string;
}

export type LibraryErrorCode =
  | "LIBRARY_NOT_BOUND"
  | "LIBRARY_PATH_INVALID"
  | "LIBRARY_STORAGE_ERROR"
  | "LIBRARY_TODO"
  | "LIBRARY_CONFIG_PATH_INVALID"
  | "LIBRARY_CONFIG_WRITE_FAILED"
  | "LIBRARY_TAG_NAME_REQUIRED"
  | "LIBRARY_TAG_NOT_FOUND"
  | "LIBRARY_TAG_PATH_REQUIRED"
  | "LIBRARY_TAG_TARGET_REQUIRED"
  | "SERVER_STATE_PORT_INVALID"
  | "FILE_ALREADY_EXISTS"
  | "FILE_NOT_FOUND"
  | "FILE_PREVIEW_ASSET_NOT_SUPPORTED"
  | "FILE_PREVIEW_NOT_SUPPORTED"
  | "FILE_PREVIEW_TOKEN_EXPIRED"
  | "FILE_PREVIEW_TOKEN_INVALID"
  | "FILE_TOO_LARGE"
  | "FILE_VERSION_CONFLICT"
  | "BINARY_FILE_NOT_SUPPORTED"
  | "INVALID_CONTENT"
  | "INVALID_FILE_OPERATION"
  | "INVALID_INPUT"
  | "NOT_A_DIRECTORY"
  | "NOT_A_FILE"
  | "ONLYOFFICE_CALLBACK_TOKEN_INVALID"
  | "ONLYOFFICE_DISABLED"
  | "ONLYOFFICE_MISCONFIGURED";

export type LibraryTagRuleRelation = "and" | "or" | "not";

export type LibraryTagRuleType =
  | "file_name_contains"
  | "file_content_contains"
  | "file_extension_in"
  | "modified_time_between"
  | "document_path_in_folder";

export interface LibraryTagNodeDetail {
  id: string;
  path: string;
  name: string;
  rootType: string;
  parentId: string | null;
  parentPath: string | null;
  description: string | null;
  status: "active" | "disabled";
  documentCount: number;
  createdAt: string;
  updatedAt: string;
  disabledAt: string | null;
}

export interface LibraryTagRule {
  id: string;
  relation: LibraryTagRuleRelation;
  ruleType: LibraryTagRuleType;
  matcher: Record<string, unknown>;
  enabled: boolean;
  priority: number;
}

export interface LibraryTagDetailWithRules extends LibraryTagNodeDetail {
  smartRules: LibraryTagRule[];
  smartRuleEnabled: boolean;
}

export interface LibraryTagListSummary {
  totalActiveTags: number;
  totalDisabledTags: number;
  totalRuleEnabledTags: number;
  totalBoundDocuments: number;
}

export interface LibraryTagRecomputeStatus {
  recomputeState: "idle" | "queued" | "running" | "failed";
  lastRecomputedAt: string | null;
  lastError: string | null;
}

export interface LibraryTagListResult {
  items: LibraryTagDetailWithRules[];
  summary: LibraryTagListSummary;
  status: LibraryTagRecomputeStatus;
}

export interface SaveLibraryTagsInput {
  tagIds?: string[];
  createTagPaths?: string[];
}

export interface SaveLibraryFolderTagsInput extends SaveLibraryTagsInput {
  folderPath?: string;
}

export type LibraryResolvedTagSourceType =
  | "manual_document"
  | "folder_binding"
  | "smart_rule"
  | "system_derived";

export interface LibraryResolvedTagSource {
  path: string;
  sourceType: LibraryResolvedTagSourceType;
  sourceRef: string | null;
  evidence: string | null;
  confidence: number;
  priority: number;
}

export type LibraryTagRecommendationReason =
  | "name_match"
  | "folder_context"
  | "smart_rule"
  | "time_pattern";

export interface LibraryTagRecommendation {
  tagId: string;
  path: string;
  name: string;
  score: number;
  reason: LibraryTagRecommendationReason;
  evidence: string;
}

export interface LibraryDocumentTagDetails {
  documentId: string;
  path: string;
  title: string;
  manualTagIds: string[];
  effectiveFolderBindings: Array<{
    id: string;
    folderPath: string;
    tagId: string;
    tagPath: string;
  }>;
  resolvedTags: LibraryResolvedTagSource[];
  recommendedTags?: LibraryTagRecommendation[];
}

export interface LibraryFolderTagDetails {
  folderPath: string;
  exists: boolean;
  bindingTagIds: string[];
  bindings: Array<{
    id: string;
    tagId: string;
    tagPath: string;
    applyMode: string;
  }>;
  recommendedTags?: LibraryTagRecommendation[];
}

export interface HttpServerPersistentPolicy {
  keepAliveWhenWindowClosed: boolean;
  reason: string;
}

export interface HttpServerStateWithPolicy extends HttpServerState {
  persistentPolicy: HttpServerPersistentPolicy;
}
