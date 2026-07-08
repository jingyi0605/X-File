import type {
  HttpServerState,
  HostDirectoryBrowseResult,
  LibraryBinding,
  LibraryIndexStatus,
  LibraryConfig,
  LibraryDocumentList,
  LibraryDocumentTagDetails,
  LibraryFileList,
  LibraryFolderTagDetails,
  LibraryHealth,
  LibraryPreview,
  LibraryRefreshResult,
  LibrarySnapshot,
  LibraryTagDetailWithRules,
  LibraryTagListResult,
  SaveLibraryFolderTagsInput,
  SaveLibraryTagDefinitionInput,
  SaveLibraryTagsInput,
  OnlyOfficeSettings,
  OnlyOfficeStatus,
  PluginListResult,
  PluginMutationResult,
  SaveHttpServerStateInput,
  SaveLibraryBindingInput,
  SaveLibraryConfigInput,
  UpdateOnlyOfficeSettingsInput,
} from "@x-file/shared";

export interface NativeLibraryWatcherStatus {
  active: boolean;
  rootDir: string | null;
  startedAt: string | null;
  lastEventAt: string | null;
  lastRefreshRequestedAt: string | null;
  lastRefreshReason: string | null;
  lastError: string | null;
}

interface NativeLibrarySnapshotResponse {
  watcher: NativeLibraryWatcherStatus;
  snapshot: LibrarySnapshot;
}

interface NativeLibraryRefreshResponse {
  watcher: NativeLibraryWatcherStatus;
  backendResponse: LibraryRefreshResult;
}

export interface NativeMacOsTitlebarMetrics {
  overlay: boolean;
  trafficLightCenterY: number;
  trafficLightLeadingInset: number;
  trafficLightSafeZoneWidth: number;
  trafficLightButtonDiameter: number;
  titlebarHeight: number;
}

export interface NativeDesktopWindowChromeInfo {
  macosTitlebar?: NativeMacOsTitlebarMetrics | null;
}

export interface NativeDesktopRuntimeInfo {
  version: string;
  appDataDir: string | null;
  windowChrome?: NativeDesktopWindowChromeInfo | null;
}

export interface NativeResetApplicationDataResult {
  dataDir: string;
  appDataDir: string | null;
  clearedLibraryIndexDir: string | null;
}

export interface NativeSidebarLayoutInput {
  leftWidth: number;
  rightWidth: number;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  prefersDarkAppearance: boolean;
  isResizing: boolean;
}

export interface NativeLibraryTagRecomputeRequestResult {
  taskId: string;
  deduped: boolean;
  status: "queued";
}

export interface NativeLibraryTagRecomputeTask {
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

export interface NativeOptionalResult<T> {
  available: boolean;
  value: T;
}

function isDesktopTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const tauriApi = await import("@tauri-apps/api/core");
  return tauriApi.invoke<T>(command, args);
}

function isNativeCommandUnavailable(error: unknown): boolean {
  const message = extractErrorMessage(error).toLowerCase();
  return (
    message.includes("command") &&
    (message.includes("not found") ||
      message.includes("not registered") ||
      message.includes("unknown"))
  );
}

function extractErrorMessage(error: unknown): string {
  if (typeof error === "string") {
    return error;
  }
  if (error instanceof Error) {
    return error.message;
  }
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") {
      return message;
    }
  }
  return String(error);
}

async function invokeOptional<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T | null> {
  if (!isDesktopTauriRuntime()) {
    return null;
  }
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    if (isNativeCommandUnavailable(error)) {
      return null;
    }
    throw error;
  }
}

export async function fetchNativeLibraryHealth(): Promise<LibraryHealth | null> {
  return invokeOptional<LibraryHealth>("native_fetch_library_health");
}

export async function fetchNativeLibrarySnapshot(): Promise<NativeLibrarySnapshotResponse | null> {
  return invokeOptional<NativeLibrarySnapshotResponse>("native_get_library_snapshot");
}

export async function fetchNativeLibraryStatus(): Promise<LibraryIndexStatus | null> {
  return invokeOptional<LibraryIndexStatus>("native_get_library_status");
}

export async function requestNativeLibraryRefresh(input: {
  reason?: string | null;
  targetPath?: string | null;
  mode?: "full" | "index-only" | "export-only" | null;
}): Promise<NativeLibraryRefreshResponse | null> {
  return invokeOptional<NativeLibraryRefreshResponse>("native_request_library_refresh", { request: input });
}

export async function listNativeLibraryDocuments(query: {
  browseMode: "folder" | "tag";
  selectedFolderPath?: string | null;
  selectedTagPath?: string | null;
  selectedTagPaths?: string[] | null;
  selectedFavoriteId?: string | null;
  keyword?: string | null;
  offset?: number;
  limit?: number;
}): Promise<LibraryDocumentList | null> {
  return invokeOptional<LibraryDocumentList>("native_list_library_documents", { request: query });
}

export async function listNativeLibraryFiles(
  path: string | null,
  limit = 200,
): Promise<LibraryFileList | null> {
  return invokeOptional<LibraryFileList>("native_list_library_files", { path, limit });
}

export async function getNativeLibraryPreview(
  path: string,
  displayMode?: "default" | "reading",
): Promise<LibraryPreview | null> {
  return invokeOptional<LibraryPreview>("native_get_library_preview", {
    request: { path, displayMode },
  });
}

export async function getNativeOnlyOfficePreview(
  path: string,
  displayMode?: "default" | "reading",
  editable = true,
): Promise<LibraryPreview | null> {
  return invokeOptional<LibraryPreview>("native_build_onlyoffice_preview", {
    request: { path, displayMode, editable },
  });
}

export async function startNativeLibraryWatcher(rootDir: string): Promise<NativeLibraryWatcherStatus | null> {
  return invokeOptional<NativeLibraryWatcherStatus>("start_native_library_watcher", {
    request: { rootDir },
  });
}

export async function stopNativeLibraryWatcher(): Promise<NativeLibraryWatcherStatus | null> {
  return invokeOptional<NativeLibraryWatcherStatus>("stop_native_library_watcher");
}

export async function getNativeDesktopRuntimeInfo(): Promise<NativeDesktopRuntimeInfo | null> {
  return invokeOptional<NativeDesktopRuntimeInfo>("get_runtime_info");
}

export async function setInitializationWindowMode(active: boolean): Promise<boolean> {
  if (!isDesktopTauriRuntime()) {
    return false;
  }
  await invoke<void>("set_initialization_window_mode", { active });
  return true;
}

export async function clearNativeApplicationData(): Promise<NativeResetApplicationDataResult | null> {
  return invokeOptional<NativeResetApplicationDataResult>("native_clear_application_data");
}

export async function requestNativeAppRestart(): Promise<boolean> {
  if (!isDesktopTauriRuntime()) {
    return false;
  }
  return invoke<boolean>("request_native_app_restart");
}

export async function notifyWindowReadyForNativeSidebar(): Promise<boolean> {
  if (!isDesktopTauriRuntime()) {
    return false;
  }
  return invoke<boolean>("window_ready_for_native_sidebar");
}

export async function syncNativeSidebarLayout(
  layout: NativeSidebarLayoutInput,
): Promise<boolean> {
  if (!isDesktopTauriRuntime()) {
    return false;
  }
  await invoke("sync_native_sidebar_layout", { layout });
  return true;
}


export async function getNativeOnlyOfficeSettings(): Promise<OnlyOfficeSettings | null> {
  return invokeOptional<OnlyOfficeSettings>("native_get_onlyoffice_settings");
}

export async function saveNativeOnlyOfficeSettings(
  input: UpdateOnlyOfficeSettingsInput,
): Promise<OnlyOfficeSettings | null> {
  return invokeOptional<OnlyOfficeSettings>("native_save_onlyoffice_settings", { input });
}

export async function getNativeOnlyOfficeStatus(): Promise<OnlyOfficeStatus | null> {
  return invokeOptional<OnlyOfficeStatus>("native_get_onlyoffice_status");
}

export async function listNativePlugins(): Promise<PluginListResult | null> {
  return invokeOptional<PluginListResult>("native_list_plugins");
}

export async function enableNativePlugin(pluginId: string): Promise<PluginMutationResult | null> {
  return invokeOptional<PluginMutationResult>("native_enable_plugin", {
    request: { pluginId },
  });
}

export async function disableNativePlugin(pluginId: string): Promise<PluginMutationResult | null> {
  return invokeOptional<PluginMutationResult>("native_disable_plugin", {
    request: { pluginId },
  });
}

export async function getNativeHttpServerState(): Promise<HttpServerState | null> {
  return invokeOptional<HttpServerState>("native_get_http_server_state");
}

export async function saveNativeHttpServerState(
  input: SaveHttpServerStateInput,
): Promise<HttpServerState | null> {
  return invokeOptional<HttpServerState>("native_save_http_server_state", {
    request: input,
  });
}


export async function getNativeLibraryBinding(): Promise<LibraryBinding | null> {
  return invokeOptional<LibraryBinding | null>("native_get_library_binding");
}

export async function saveNativeLibraryBinding(
  input: SaveLibraryBindingInput,
): Promise<LibraryBinding | null> {
  return invokeOptional<LibraryBinding>("native_save_library_binding", { request: input });
}

export async function getNativeLibraryConfig(): Promise<LibraryConfig | null> {
  return invokeOptional<LibraryConfig>("native_get_library_config");
}

export async function saveNativeLibraryConfig(
  input: SaveLibraryConfigInput,
): Promise<LibraryConfig | null> {
  return invokeOptional<LibraryConfig>("native_save_library_config", { request: input });
}

export async function browseNativeHostDirectories(
  path: string | null,
): Promise<HostDirectoryBrowseResult | null> {
  return invokeOptional<HostDirectoryBrowseResult>("native_browse_host_directories", { path });
}

export async function listNativeLibraryTagDetails(
  includeDisabled = true,
): Promise<LibraryTagListResult | null> {
  return invokeOptional<LibraryTagListResult>("native_list_library_tag_details", {
    request: { includeDisabled },
  });
}

export async function getNativeDocumentTagDetails(
  documentId: string,
): Promise<LibraryDocumentTagDetails | null> {
  return invokeOptional<LibraryDocumentTagDetails>("native_get_document_tag_details", {
    request: { documentId },
  });
}

export async function saveNativeDocumentTags(
  documentId: string,
  input: SaveLibraryTagsInput,
): Promise<LibraryDocumentTagDetails | null> {
  return invokeOptional<LibraryDocumentTagDetails>("native_save_document_tags", {
    request: {
      documentId,
      ...input,
    },
  });
}

export async function getNativeFolderTagDetails(
  folderPath: string,
): Promise<LibraryFolderTagDetails | null> {
  return invokeOptional<LibraryFolderTagDetails>("native_get_folder_tag_details", {
    request: { folderPath },
  });
}

export async function saveNativeFolderTags(
  input: SaveLibraryFolderTagsInput,
): Promise<LibraryFolderTagDetails | null> {
  return invokeOptional<LibraryFolderTagDetails>("native_save_folder_tags", {
    request: input,
  });
}

export async function getNativeLibraryTagDetail(
  tagId: string,
): Promise<LibraryTagDetailWithRules | null> {
  return invokeOptional<LibraryTagDetailWithRules>("native_get_library_tag_detail", {
    request: { tagId },
  });
}

export async function createNativeLibraryTag(
  input: SaveLibraryTagDefinitionInput,
): Promise<LibraryTagDetailWithRules | null> {
  return invokeOptional<LibraryTagDetailWithRules>("native_create_library_tag", {
    request: input,
  });
}

export async function updateNativeLibraryTag(
  tagId: string,
  input: SaveLibraryTagDefinitionInput,
): Promise<LibraryTagDetailWithRules | null> {
  return invokeOptional<LibraryTagDetailWithRules>("native_update_library_tag", {
    request: {
      tagId,
      ...input,
    },
  });
}

export async function deleteNativeLibraryTag(
  tagId: string,
): Promise<{ deletedTagIds: string[] } | null> {
  return invokeOptional<{ deletedTagIds: string[] }>("native_delete_library_tag", {
    request: { tagId },
  });
}

export async function requestNativeLibraryTagRecompute(): Promise<NativeLibraryTagRecomputeRequestResult | null> {
  return invokeOptional<NativeLibraryTagRecomputeRequestResult>("native_request_library_tag_recompute");
}

export async function getNativeLibraryTagRecomputeTask(): Promise<NativeLibraryTagRecomputeTask | null> {
  const result = await invokeOptionalWithAvailability<NativeLibraryTagRecomputeTask | null>(
    "native_get_library_tag_recompute_task",
  );
  return result.available ? result.value : null;
}

export async function getNativeLibraryTagRecomputeTaskOptional(): Promise<
  NativeOptionalResult<NativeLibraryTagRecomputeTask | null>
> {
  return invokeOptionalWithAvailability<NativeLibraryTagRecomputeTask | null>(
    "native_get_library_tag_recompute_task",
  );
}

async function invokeOptionalWithAvailability<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<NativeOptionalResult<T | null>> {
  if (!isDesktopTauriRuntime()) {
    return {
      available: false,
      value: null,
    };
  }
  try {
    return {
      available: true,
      value: await invoke<T>(command, args),
    };
  } catch (error) {
    if (isNativeCommandUnavailable(error)) {
      return {
        available: false,
        value: null,
      };
    }
    throw error;
  }
}
