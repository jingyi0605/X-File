mod native_export;
mod native_index;
mod native_core;
mod updater;

use notify::{Config as NotifyConfig, Event, RecommendedWatcher, RecursiveMode, Watcher};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use hmac::{Hmac, Mac};
use jwt::SignWithKey;
use mime_guess::from_path;
use native_core::export_core::{run_native_library_export_core, NativeLibraryExportCoreRequest};
use native_core::index_core::{run_native_library_index_core, NativeLibraryIndexCoreRequest};
use native_core::search_core::{run_native_library_search_core, NativeLibrarySearchCoreRequest};
use native_core::tag_core::{
    count_local_tags, create_native_library_tag, delete_native_library_tag, get_native_document_tag_details,
    get_native_folder_tag_details, get_native_library_tag_detail,
    get_native_library_tag_recompute_task, list_native_library_tag_details,
    request_native_library_tag_recompute, save_native_document_tags,
    save_native_folder_tags, update_native_library_tag, expand_local_tag_ancestor_paths,
    NativeFolderTagDetailsRequest, NativeLibraryTagIdRequest,
    NativeSaveDocumentTagsRequest, NativeSaveFolderTagsRequest,
    NativeSaveLibraryTagDefinitionRequest,
};
use native_export::{run_native_export_worker, run_native_search_worker, NativeExportRequest, NativeSearchRequest};
use native_index::{
    run_native_index_worker, run_native_parser, NativeIndexRequest, NativeParserRequest,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::env;
use std::fs;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::menu::{
    Menu, MenuBuilder, MenuEvent, MenuItemBuilder, SubmenuBuilder,
};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow, Window, WindowEvent};
use tiny_http::{Header, Method, Response, Server, StatusCode};

#[cfg(target_os = "macos")]
use {
    objc2::MainThreadMarker,
    objc2_app_kit::{
        NSAppearance, NSAppearanceCustomization, NSAppearanceNameVibrantDark, NSAppearanceNameVibrantLight, NSAutoresizingMaskOptions,
        NSColor, NSView,
        NSViewLayerContentsRedrawPolicy, NSVisualEffectBlendingMode, NSVisualEffectMaterial,
        NSVisualEffectState, NSVisualEffectView, NSWindow, NSWindowOrderingMode,
    },
    objc2_foundation::{NSPoint, NSRect, NSSize},
};

const MAIN_WINDOW_LABEL: &str = "main";
const MENU_SHOW_WINDOW: &str = "show_window";
const MENU_HIDE_WINDOW: &str = "hide_window";
const MENU_ENABLE_PERSISTENCE: &str = "enable_persistence";
const MENU_DISABLE_PERSISTENCE: &str = "disable_persistence";
const MENU_START_BACKEND: &str = "start_backend";
const MENU_STOP_BACKEND: &str = "stop_backend";
const MENU_QUIT: &str = "quit";
const LIBRARY_CONTEXT_MENU_ID_PREFIX: &str = "xfile_library_context:";
const LIBRARY_CONTEXT_MENU_ACTION_EVENT: &str = "x-file-library-context-menu-action";
const DEFAULT_SIGNING_SECRET: &str = "x-file-local-preview-development-secret";
const LIBRARY_PREVIEW_TOKEN_TTL_MS: i64 = 2 * 60 * 60 * 1000;
const CALLBACK_TOKEN_TTL_MS: i64 = 24 * 60 * 60 * 1000;
const ONLYOFFICE_BRIDGE_BIND: &str = "127.0.0.1:17322";
const CALLBACK_DOWNLOAD_TIMEOUT_MS: u64 = 20_000;

#[cfg(target_os = "macos")]
const MACOS_NATIVE_LEFT_SIDEBAR_WIDTH: f64 = 272.0;

#[cfg(target_os = "macos")]
const MACOS_NATIVE_RIGHT_SIDEBAR_WIDTH: f64 = 340.0;

#[cfg(target_os = "macos")]
const MACOS_NATIVE_SIDEBAR_MIN_VISIBLE_WIDTH: f64 = 1.0;

#[cfg(target_os = "macos")]
const MACOS_NATIVE_RIGHT_SIDEBAR_OVERSCAN_WIDTH: f64 = 240.0;

#[cfg(target_os = "macos")]
const MACOS_NATIVE_LEFT_SIDEBAR_AUTOREZING_MASK: NSAutoresizingMaskOptions =
    NSAutoresizingMaskOptions::ViewMaxXMargin.union(NSAutoresizingMaskOptions::ViewHeightSizable);

#[cfg(target_os = "macos")]
const MACOS_NATIVE_RIGHT_SIDEBAR_AUTOREZING_MASK: NSAutoresizingMaskOptions =
    NSAutoresizingMaskOptions::ViewMinXMargin.union(NSAutoresizingMaskOptions::ViewHeightSizable);

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeSidebarLayoutPayload {
    left_width: f64,
    right_width: f64,
    left_collapsed: bool,
    right_collapsed: bool,
    prefers_dark_appearance: bool,
    is_resizing: bool,
}

#[derive(Debug, Clone, Default)]
struct MacosNativeSidebarState {
    #[cfg(target_os = "macos")]
    windows: Arc<Mutex<HashMap<String, MacosNativeSidebarWindowState>>>,
}

#[cfg(target_os = "macos")]
#[derive(Debug, Clone, Default)]
struct MacosNativeSidebarWindowState {
    layout: MacosNativeSidebarLayoutState,
    left_view_ptr: Option<usize>,
    right_view_ptr: Option<usize>,
    rendered_left_width: f64,
    rendered_right_width: f64,
}

#[cfg(target_os = "macos")]
#[derive(Debug, Clone)]
struct MacosNativeSidebarLayoutState {
    left_width: f64,
    right_width: f64,
    left_collapsed: bool,
    right_collapsed: bool,
    prefers_dark_appearance: bool,
    is_resizing: bool,
}

#[cfg(target_os = "macos")]
impl Default for MacosNativeSidebarLayoutState {
    fn default() -> Self {
        Self {
            left_width: MACOS_NATIVE_LEFT_SIDEBAR_WIDTH,
            right_width: MACOS_NATIVE_RIGHT_SIDEBAR_WIDTH,
            left_collapsed: false,
            right_collapsed: false,
            prefers_dark_appearance: false,
            is_resizing: false,
        }
    }
}

#[cfg(target_os = "macos")]
impl From<&NativeSidebarLayoutPayload> for MacosNativeSidebarLayoutState {
    fn from(value: &NativeSidebarLayoutPayload) -> Self {
        Self {
            left_width: sanitize_native_sidebar_width(value.left_width),
            right_width: sanitize_native_sidebar_width(value.right_width),
            left_collapsed: value.left_collapsed,
            right_collapsed: value.right_collapsed,
            prefers_dark_appearance: value.prefers_dark_appearance,
            is_resizing: value.is_resizing,
        }
    }
}

#[cfg(target_os = "macos")]
impl MacosNativeSidebarState {
    fn upsert_layout(
        &self,
        window_label: &str,
        payload: &NativeSidebarLayoutPayload,
    ) -> MacosNativeSidebarWindowState {
        let mut guard = self.windows.lock().expect("macOS 原生侧栏状态锁被污染");
        let entry = guard.entry(window_label.to_string()).or_default();
        let next_layout = MacosNativeSidebarLayoutState::from(payload);

        entry.rendered_left_width = resolve_macos_native_sidebar_rendered_width(
            entry.rendered_left_width,
            next_layout.left_width,
            next_layout.left_collapsed,
            next_layout.is_resizing,
        );
        entry.rendered_right_width = resolve_macos_native_sidebar_rendered_width(
            entry.rendered_right_width,
            next_layout.right_width,
            next_layout.right_collapsed,
            next_layout.is_resizing,
        );
        entry.layout = next_layout;
        entry.clone()
    }

    fn get_window_state(&self, window_label: &str) -> Option<MacosNativeSidebarWindowState> {
        let guard = self.windows.lock().expect("macOS 原生侧栏状态锁被污染");
        guard.get(window_label).cloned()
    }

    fn update_view_pointers(
        &self,
        window_label: &str,
        left_view_ptr: Option<usize>,
        right_view_ptr: Option<usize>,
    ) {
        let mut guard = self.windows.lock().expect("macOS 原生侧栏状态锁被污染");
        let entry = guard.entry(window_label.to_string()).or_default();
        entry.left_view_ptr = left_view_ptr;
        entry.right_view_ptr = right_view_ptr;
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
enum BackendProcessState {
    Stopped,
    Starting,
    Running,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BackendProcessSnapshot {
    state: BackendProcessState,
    pid: Option<u32>,
    started_at: Option<u64>,
    last_exit_code: Option<i32>,
    last_error: Option<String>,
    command: String,
    args: Vec<String>,
    cwd: String,
    managed_by_desktop_shell: bool,
    note: &'static str,
}

struct BackendProcessManager {
    child: Option<Child>,
    state: BackendProcessState,
    started_at: Option<u64>,
    last_exit_code: Option<i32>,
    last_error: Option<String>,
    command: String,
    args: Vec<String>,
    cwd: PathBuf,
    server_state_path: PathBuf,
    command_overridden: bool,
    args_overridden: bool,
}

impl BackendProcessManager {
    fn from_env() -> Self {
        let raw_command = env::var("X_FILE_BACKEND_COMMAND").ok();
        let command_overridden = raw_command.is_some();
        let command = raw_command.unwrap_or_else(default_backend_command);
        let raw_args = env::var("X_FILE_BACKEND_ARGS").ok();
        let args_overridden = raw_args.is_some();
        let args = raw_args.map(parse_command_args).unwrap_or_else(default_backend_args);

        Self {
            child: None,
            state: BackendProcessState::Stopped,
            started_at: None,
            last_exit_code: None,
            last_error: None,
            command,
            args,
            cwd: default_backend_cwd(),
            server_state_path: resolve_local_http_server_state_path(),
            command_overridden,
            args_overridden,
        }
    }

    fn prefer_resource_entry(
        &mut self,
        resource_dir: PathBuf,
        resource_boundary: Option<&ResourceBoundaryManifest>,
    ) {
        if self.args_overridden {
            return;
        }

        if let Some(node) = bundled_node_candidates(&resource_dir, resource_boundary)
            .into_iter()
            .find(|path| path.is_file())
        {
            self.command = node.to_string_lossy().to_string();
        } else if resource_boundary
            .and_then(|manifest| manifest.resources.as_ref())
            .and_then(|resources| resources.get("x-file-runtime"))
            .and_then(|resource| resource.required_in_main_bundle)
            == Some(false)
            && !self.command_overridden
        {
            self.command.clear();
        }

        let candidates = bundled_backend_entry_candidates(&resource_dir);

        let Some(entry) = candidates.iter().find(|path| path.is_file()) else {
            return;
        };

        self.args = vec![entry.to_string_lossy().to_string()];
        self.cwd = entry
            .parent()
            .map(PathBuf::from)
            .unwrap_or_else(|| resource_dir.clone());
    }

    fn start(&mut self) -> BackendProcessSnapshot {
        if self.child_is_running() {
            return self.snapshot();
        }

        self.state = BackendProcessState::Starting;
        self.last_error = None;

        if self.command.trim().is_empty() {
            self.child = None;
            self.state = BackendProcessState::Failed;
            self.last_error = Some(
                "正式包默认不再内置 Node sidecar；如需显式启动后端，请通过 X_FILE_BACKEND_COMMAND 提供外部 Node/sidecar 入口。".to_string(),
            );
            return self.snapshot();
        }

        match Command::new(&self.command)
            .args(&self.args)
            .current_dir(&self.cwd)
            .envs(resolve_backend_extra_env(&self.cwd, &self.server_state_path))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
        {
            Ok(child) => {
                self.child = Some(child);
                self.state = BackendProcessState::Running;
                self.started_at = Some(epoch_millis());
            }
            Err(error) => {
                self.child = None;
                self.state = BackendProcessState::Failed;
                self.last_error = Some(error.to_string());
            }
        }

        self.snapshot()
    }

    fn stop(&mut self) -> BackendProcessSnapshot {
        if let Some(mut child) = self.child.take() {
            if let Err(error) = child.kill() {
                self.last_error = Some(error.to_string());
            }

            match child.wait() {
                Ok(status) => {
                    self.last_exit_code = status.code();
                }
                Err(error) => {
                    self.last_error = Some(error.to_string());
                }
            }
        }

        self.state = BackendProcessState::Stopped;
        self.started_at = None;
        self.snapshot()
    }

    fn snapshot(&mut self) -> BackendProcessSnapshot {
        let pid = if self.child_is_running() {
            self.child.as_ref().map(Child::id)
        } else {
            None
        };

        BackendProcessSnapshot {
            state: self.state.clone(),
            pid,
            started_at: self.started_at,
            last_exit_code: self.last_exit_code,
            last_error: self.last_error.clone(),
            command: self.command.clone(),
            args: self.args.clone(),
            cwd: self.cwd.to_string_lossy().to_string(),
            managed_by_desktop_shell: true,
            note: "桌面壳已经具备生产托管入口；正式包默认不再内置 Node sidecar，如需后端能力必须显式提供外部 sidecar 入口。",
        }
    }

    fn child_is_running(&mut self) -> bool {
        let Some(child) = self.child.as_mut() else {
            self.state = BackendProcessState::Stopped;
            return false;
        };

        match child.try_wait() {
            Ok(Some(status)) => {
                self.last_exit_code = status.code();
                self.child = None;
                self.started_at = None;
                self.state = BackendProcessState::Stopped;
                false
            }
            Ok(None) => {
                self.state = BackendProcessState::Running;
                true
            }
            Err(error) => {
                self.last_error = Some(error.to_string());
                self.state = BackendProcessState::Failed;
                false
            }
        }
    }
}

fn bundled_node_candidates(
    _resource_dir: &std::path::Path,
    resource_boundary: Option<&ResourceBoundaryManifest>,
) -> Vec<PathBuf> {
    let runtime_required = resource_boundary
        .and_then(|manifest| manifest.resources.as_ref())
        .and_then(|resources| resources.get("x-file-runtime"))
        .and_then(|resource| resource.required_in_main_bundle)
        .unwrap_or(true);

    if !runtime_required {
        return Vec::new();
    }

    Vec::new()
}

fn bundled_backend_entry_candidates(resource_dir: &std::path::Path) -> Vec<PathBuf> {
    let _ = resource_dir;
    Vec::new()
}

fn resolve_backend_extra_env(
    cwd: &std::path::Path,
    server_state_path: &PathBuf,
) -> Vec<(String, String)> {
    let bundled_plugin_dir = cwd
        .parent()
        .and_then(|dir| dir.parent().map(|parent| parent.join("x-file-plugins")))
        .unwrap_or_else(|| cwd.join("x-file-plugins"));
    let mut envs = Vec::new();
    envs.push((
        "X_FILE_SERVER_STATE_PATH".to_string(),
        server_state_path.to_string_lossy().to_string(),
    ));
    if let Ok(saved) = read_optional_json_file::<Value>(server_state_path) {
        if let Some(port) = saved
            .as_ref()
            .and_then(|payload| payload.get("port"))
            .and_then(Value::as_u64)
        {
            envs.push(("X_FILE_SERVER_PORT".to_string(), port.to_string()));
        }
        if let Some(host) = saved
            .as_ref()
            .and_then(|payload| payload.get("host"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            envs.push(("X_FILE_SERVER_HOST".to_string(), host.to_string()));
        }
    }
    if env::var("X_FILE_BUNDLED_PLUGIN_DIR").is_err() {
        envs.push((
            "X_FILE_BUNDLED_PLUGIN_DIR".to_string(),
            bundled_plugin_dir.to_string_lossy().to_string(),
        ));
    }
    if env::var("X_FILE_DESKTOP_CLI_PATH").is_err() {
        if let Ok(current_exe) = env::current_exe() {
            envs.push((
                "X_FILE_DESKTOP_CLI_PATH".to_string(),
                current_exe.to_string_lossy().to_string(),
            ));
        }
    }
    envs
}

struct DesktopState {
    backend_persistent: bool,
    is_quitting: bool,
    main_window_geometry: Option<MainWindowGeometry>,
    backend: BackendProcessManager,
    resource_dir: Option<PathBuf>,
    native_context_menu_selection: Option<String>,
    native_library: NativeLibraryState,
    onlyoffice_bridge: OnlyOfficeBridgeState,
}

impl DesktopState {
    fn new() -> Self {
        let backend_persistent = load_initial_backend_persistence();
        Self {
            backend_persistent,
            is_quitting: false,
            main_window_geometry: None,
            backend: BackendProcessManager::from_env(),
            resource_dir: None,
            native_context_menu_selection: None,
            native_library: NativeLibraryState::new(),
            onlyoffice_bridge: OnlyOfficeBridgeState::new(),
        }
    }
}

const MAIN_WINDOW_GEOMETRY_FILE_NAME: &str = "main-window-geometry.json";

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MainWindowGeometry {
    position_x: i32,
    position_y: i32,
    width: u32,
    height: u32,
}

#[derive(Debug, Clone)]
struct OnlyOfficeBridgeState {
    bridge_base_url: Option<String>,
    last_error: Option<String>,
    started: bool,
}

impl OnlyOfficeBridgeState {
    fn new() -> Self {
        Self {
            bridge_base_url: None,
            last_error: None,
            started: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OnlyOfficeSettingRecord {
    enabled: bool,
    server_url: Option<String>,
    public_base_url: Option<String>,
    callback_base_url: Option<String>,
    user_display_name: Option<String>,
    user_avatar_url: Option<String>,
    jwt_secret: Option<String>,
    created_at: Option<String>,
    updated_at: Option<String>,
}

#[derive(Debug, Clone)]
struct LocalOnlyOfficeResolvedSetting {
    enabled: bool,
    server_url: Option<String>,
    public_base_url: Option<String>,
    effective_callback_base_url: Option<String>,
    user_display_name: Option<String>,
    user_avatar_url: Option<String>,
    jwt_secret: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct LocalPluginRegistryFile {
    records: Vec<LocalPluginRegistryRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalPluginRegistryRecord {
    plugin_id: String,
    version: String,
    install_dir: String,
    enabled: bool,
    installed_at: String,
    updated_at: String,
    last_health_status: String,
    last_error: Option<String>,
    runtime_install_dir: Option<String>,
    granted_capabilities: Vec<String>,
}

#[derive(Debug, Clone)]
struct LocalPluginCatalogItem {
    manifest: Value,
    registry: LocalPluginRegistryRecord,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OnlyOfficeCallbackTokenPayload {
    library_id: String,
    file_path: String,
    expires_at: i64,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ResourceBoundaryManifest {
    resources: Option<HashMap<String, ResourceBoundaryResource>>,
    #[allow(dead_code)]
    desktop_host: Option<ResourceBoundaryDesktopHost>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ResourceBoundaryResource {
    required_in_main_bundle: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ResourceBoundaryDesktopHost {
    #[allow(dead_code)]
    node_worker_fallback: Option<ResourceBoundaryNodeWorkerFallback>,
    #[allow(dead_code)]
    node_sidecar: Option<ResourceBoundaryNodeSidecar>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ResourceBoundaryNodeWorkerFallback {
    #[allow(dead_code)]
    allow_host_node_fallback_by_default: Option<bool>,
    #[allow(dead_code)]
    explicit_opt_in_env: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ResourceBoundaryNodeSidecar {
    #[allow(dead_code)]
    profile_in_main_bundle: Option<String>,
    #[allow(dead_code)]
    library_core_http_routes_served_by_default: Option<bool>,
    #[allow(dead_code)]
    explicit_opt_in_env: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalPreviewTokenPayload {
    library_id: String,
    expires_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeLibraryWatcherStatus {
    active: bool,
    root_dir: Option<String>,
    started_at: Option<String>,
    last_event_at: Option<String>,
    last_refresh_requested_at: Option<String>,
    last_refresh_reason: Option<String>,
    last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeLibraryEngineState {
    watcher: NativeLibraryWatcherStatus,
    backend_managed: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeLibraryRefreshResponse {
    watcher: NativeLibraryWatcherStatus,
    backend_response: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeLibrarySnapshotResponse {
    watcher: NativeLibraryWatcherStatus,
    snapshot: Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeLibraryWatcherRequest {
    root_dir: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeLibraryRefreshRequest {
    reason: Option<String>,
    target_path: Option<String>,
    mode: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeLibraryWorkerCliPayload {
    root_dir: String,
    target_path: Option<String>,
    allowed_extensions: Option<Vec<String>>,
    included_hidden_paths: Option<Vec<String>>,
    reason: Option<String>,
    dirty_scope: Option<Value>,
    file_path: Option<String>,
    extension: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeOnlyOfficeSettingsInput {
    enabled: Option<bool>,
    server_url: Option<String>,
    public_base_url: Option<String>,
    callback_base_url: Option<String>,
    user_display_name: Option<String>,
    user_avatar_url: Option<String>,
    jwt_secret: Option<String>,
    clear_jwt_secret: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativePluginToggleRequest {
    plugin_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeSaveHttpServerStateRequest {
    enabled: Option<bool>,
    persistent: Option<bool>,
    port: Option<u16>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeSaveLibraryBindingRequest {
    root_dir: String,
    complete_initialization: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeSaveLibraryConfigRequest {
    enabled: Option<bool>,
    mirror_root: Option<String>,
    allowed_extensions: Option<Vec<String>>,
    included_hidden_paths: Option<Vec<String>>,
    folder_open_behavior: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeListLibraryTagDetailsRequest {
    include_disabled: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeDocumentTagDetailsRequest {
    document_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeListDocumentsRequest {
    browse_mode: String,
    selected_folder_path: Option<String>,
    selected_tag_path: Option<String>,
    selected_tag_paths: Option<Vec<String>>,
    selected_favorite_id: Option<String>,
    keyword: Option<String>,
    offset: Option<usize>,
    limit: Option<usize>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativePreviewRequest {
    path: String,
    display_mode: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeOnlyOfficePreviewRequest {
    path: String,
    display_mode: Option<String>,
    editable: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalLibraryPreviewCapabilities {
    can_edit: bool,
    can_refresh: bool,
    can_resize: bool,
    can_zoom: bool,
    can_paginate: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalLibraryPreview {
    library_id: String,
    path: String,
    supported: bool,
    kind: String,
    reason: Option<String>,
    content: Option<String>,
    version: Option<String>,
    size: u64,
    updated_at: Option<String>,
    preview_path: Option<String>,
    preview_url: Option<String>,
    only_office: Option<Value>,
    capabilities: LocalLibraryPreviewCapabilities,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalLibraryDocumentRecord {
    document_id: String,
    path: String,
    title: String,
    summary: String,
    updated_at: String,
    created_at: Option<String>,
    size_bytes: Option<u64>,
    tags: Vec<String>,
    derived_tags: Vec<String>,
    is_favorite: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalLibraryDirectoryStatus {
    path: String,
    state: String,
    source: String,
    last_requested_at: Option<String>,
    last_completed_at: Option<String>,
    last_failed_at: Option<String>,
    running_task_id: Option<String>,
    error_summary: Option<String>,
    generated_at: Option<String>,
    filesystem_observed_at: Option<String>,
    stale_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalLibraryDocumentList {
    total: usize,
    visible_entry_total: usize,
    offset: usize,
    limit: usize,
    items: Vec<LocalLibraryDocumentRecord>,
    tag_facet_counts: HashMap<String, usize>,
    directory_status: Option<LocalLibraryDirectoryStatus>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalLibraryFileNode {
    path: String,
    name: String,
    kind: String,
    size: Option<u64>,
    updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalLibraryFileList {
    items: Vec<LocalLibraryFileNode>,
    path: String,
    total: usize,
    limit: usize,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredLibraryBinding {
    library_id: Option<String>,
    root_dir: Option<String>,
    enabled: Option<bool>,
    mirror_root: Option<String>,
    allowed_extensions: Option<Vec<String>>,
    included_hidden_paths: Option<Vec<String>>,
    folder_open_behavior: Option<String>,
    config_relative_path: Option<String>,
    export_mode: Option<String>,
    initialized: Option<bool>,
    initialized_at: Option<String>,
    updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalLibraryBinding {
    library_id: String,
    root_dir: String,
    enabled: bool,
    mirror_root: Option<String>,
    allowed_extensions: Vec<String>,
    included_hidden_paths: Vec<String>,
    folder_open_behavior: String,
    config_relative_path: String,
    export_mode: String,
    initialized: bool,
    initialized_at: Option<String>,
    updated_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedRuntimeStatus {
    state: String,
    last_requested_at: Option<String>,
    last_started_at: Option<String>,
    last_completed_at: Option<String>,
    last_failed_at: Option<String>,
    next_allowed_at: Option<String>,
    running_stage: Option<String>,
    error_summary: Option<String>,
    progress: Option<LocalLibraryIndexProgress>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalLibraryIndexProgress {
    scanned_count: usize,
    indexed_count: usize,
    skipped_count: usize,
    failed_count: usize,
    unchanged_count: usize,
    total_count: Option<usize>,
    max_concurrency: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalLibraryIndexStatus {
    state: String,
    dirty_reasons: Vec<String>,
    last_requested_at: Option<String>,
    last_started_at: Option<String>,
    last_completed_at: Option<String>,
    last_failed_at: Option<String>,
    next_allowed_at: Option<String>,
    running_task_id: Option<String>,
    running_stage: Option<String>,
    error_summary: Option<String>,
    worker_health: Option<Value>,
    progress: Option<LocalLibraryIndexProgress>,
    runtime_index_state: Option<LocalRuntimeIndexState>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalRuntimeIndexedDocumentState {
    path: String,
    extension: String,
    size: u64,
    mtime: String,
    index_status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalParserSkipState {
    skip_key: String,
    adapter: String,
    reason_code: String,
    extension: String,
    sample_paths: Vec<String>,
    sample_count: usize,
    total_count: usize,
    last_message: Option<String>,
    first_seen_at: String,
    last_seen_at: String,
    last_run_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalRuntimeIndexState {
    generated_at: String,
    failed_documents: Vec<LocalRuntimeIndexedDocumentState>,
    skipped_documents: Vec<LocalRuntimeIndexedDocumentState>,
    parser_skips: Vec<LocalParserSkipState>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedRuntimeIndexState {
    generated_at: Option<String>,
    failed_documents: Option<Vec<LocalRuntimeIndexedDocumentState>>,
    skipped_documents: Option<Vec<LocalRuntimeIndexedDocumentState>>,
    parser_skips: Option<Vec<LocalParserSkipState>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalLibraryTagNode {
    path: String,
    name: String,
    root_type: String,
    parent_path: Option<String>,
    depth: usize,
    document_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalLibraryFolderNode {
    path: String,
    name: String,
    parent_path: Option<String>,
    direct_document_count: usize,
    document_count: usize,
    created_at: Option<String>,
    updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalLibraryFavoriteRecord {
    kind: String,
    path: String,
    label: String,
    tag_paths: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalStoredTagDefinition {
    id: String,
    path: String,
    name: String,
    root_type: String,
    parent_id: Option<String>,
    parent_path: Option<String>,
    description: Option<String>,
    status: String,
    created_at: String,
    updated_at: String,
    disabled_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalStoredDocumentTagBinding {
    document_id: String,
    path: String,
    title: String,
    manual_tag_ids: Vec<String>,
    updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalStoredFolderTagBinding {
    folder_path: String,
    binding_tag_ids: Vec<String>,
    updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalStoredTagRule {
    id: String,
    tag_id: String,
    relation: String,
    rule_type: String,
    matcher: Value,
    enabled: bool,
    priority: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalStoredLibraryTags {
    library_id: String,
    root_dir: String,
    tags: Vec<LocalStoredTagDefinition>,
    tag_rules: Vec<LocalStoredTagRule>,
    document_tags: Vec<LocalStoredDocumentTagBinding>,
    folder_tags: Vec<LocalStoredFolderTagBinding>,
    updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalLibraryTagRuleView {
    id: String,
    relation: String,
    rule_type: String,
    matcher: Value,
    enabled: bool,
    priority: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalLibraryTagDetailWithRules {
    id: String,
    path: String,
    name: String,
    root_type: String,
    parent_id: Option<String>,
    parent_path: Option<String>,
    description: Option<String>,
    status: String,
    document_count: usize,
    created_at: String,
    updated_at: String,
    disabled_at: Option<String>,
    smart_rules: Vec<LocalLibraryTagRuleView>,
    smart_rule_enabled: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalLibraryTagListSummary {
    total_active_tags: usize,
    total_disabled_tags: usize,
    total_rule_enabled_tags: usize,
    total_bound_documents: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalLibraryTagRecomputeStatus {
    recompute_state: String,
    last_recomputed_at: Option<String>,
    last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalLibraryTagListResult {
    items: Vec<LocalLibraryTagDetailWithRules>,
    summary: LocalLibraryTagListSummary,
    status: LocalLibraryTagRecomputeStatus,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalResolvedTagSource {
    path: String,
    source_type: String,
    source_ref: Option<String>,
    evidence: Option<String>,
    confidence: f64,
    priority: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalLibraryTagRecommendation {
    tag_id: String,
    path: String,
    name: String,
    score: f64,
    reason: String,
    evidence: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalLibraryDocumentTagDetails {
    document_id: String,
    path: String,
    title: String,
    manual_tag_ids: Vec<String>,
    effective_folder_bindings: Vec<Value>,
    resolved_tags: Vec<LocalResolvedTagSource>,
    recommended_tags: Vec<LocalLibraryTagRecommendation>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalLibraryFolderTagDetails {
    folder_path: String,
    exists: bool,
    binding_tag_ids: Vec<String>,
    bindings: Vec<Value>,
    recommended_tags: Vec<LocalLibraryTagRecommendation>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalLibraryTagRecomputeTask {
    task_id: String,
    task_type: String,
    key: String,
    state: String,
    source: String,
    queued_at: String,
    started_at: Option<String>,
    completed_at: Option<String>,
    failed_at: Option<String>,
    error_summary: Option<String>,
    running_stage: Option<String>,
    deduped: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalRuntimeSnapshotTag {
    path: String,
    name: String,
    root_type: String,
    parent_path: Option<String>,
    depth: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalRuntimeSnapshotDocument {
    document_id: String,
    path: String,
    title: String,
    summary: String,
    tags: Vec<String>,
    derived_tags: Vec<String>,
    mtime: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalRuntimeExportCatalogSnapshot {
    version: u32,
    generated_at: Option<String>,
    generated_at_legacy: Option<String>,
    tags: Vec<LocalRuntimeSnapshotTag>,
    documents: Vec<LocalRuntimeSnapshotDocument>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalLibrarySnapshot {
    binding: Option<LocalLibraryBinding>,
    default_root_dir: String,
    requires_initialization: bool,
    initialization_redirect_path: String,
    status: LocalLibraryIndexStatus,
    tags: Vec<LocalLibraryTagNode>,
    favorites: Vec<LocalLibraryFavoriteRecord>,
    folders: Vec<LocalLibraryFolderNode>,
    document_count: usize,
    last_error: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct ManifestFile {
    generated_at: Option<String>,
    entries: Option<ManifestEntries>,
    meta_shards: Option<Vec<ManifestMetaShard>>,
}

#[derive(Debug, Clone, Deserialize)]
struct ManifestEntries {
    status: Option<String>,
    taxonomy: Option<String>,
    bootstrap: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct ManifestMetaShard {
    path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalLibraryConfig {
    binding: Option<LocalLibraryBinding>,
    enabled: bool,
    mirror_root: Option<String>,
    allowed_extensions: Vec<String>,
    included_hidden_paths: Vec<String>,
    folder_open_behavior: String,
    config_relative_path: String,
    can_write: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalHostDirectoryOption {
    path: String,
    name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalHostDirectoryBrowseResult {
    current_path: String,
    parent_path: Option<String>,
    roots: Vec<LocalHostDirectoryOption>,
    items: Vec<LocalHostDirectoryOption>,
}

#[derive(Debug, Clone, Deserialize)]
struct StatusFile {
    exported_at: Option<String>,
    document_count: Option<usize>,
}

#[derive(Debug, Clone, Deserialize)]
struct TaxonomyFile {
    nodes: Option<Vec<TaxonomyNode>>,
}

#[derive(Debug, Clone, Deserialize)]
struct TaxonomyNode {
    path: String,
    name: String,
    root_type: String,
    parent_path: Option<String>,
    depth: usize,
}

#[derive(Debug, Clone, Deserialize)]
struct BootstrapFile {
    folders: Option<Vec<BootstrapFolder>>,
}

#[derive(Debug, Clone, Deserialize)]
struct BootstrapFolder {
    path: String,
    name: String,
    parent_path: Option<String>,
    direct_document_count: usize,
    document_count: usize,
}

#[derive(Debug, Clone, Deserialize)]
struct MetaShardFile {
    documents: Option<Vec<MetaDocument>>,
}

#[derive(Debug, Clone, Deserialize)]
struct MetaDocument {
    document_id: String,
    path: String,
    title: Option<String>,
    summary: Option<String>,
    mtime: Option<String>,
    direct_tags: Option<Vec<String>>,
    derived_tags: Option<Vec<String>>,
}

struct NativeWatcherHandle {
    _watcher: RecommendedWatcher,
    runtime: Arc<Mutex<NativeWatcherRuntime>>,
}

struct NativeWatcherRuntime {
    last_event_at: Option<String>,
    last_refresh_requested_at: Option<String>,
    last_refresh_reason: Option<String>,
    last_error: Option<String>,
    last_event_unix_ms: Option<i64>,
}

impl NativeWatcherRuntime {
    fn new() -> Self {
        Self {
            last_event_at: None,
            last_refresh_requested_at: None,
            last_refresh_reason: None,
            last_error: None,
            last_event_unix_ms: None,
        }
    }
}

struct NativeLibraryState {
    watcher_handle: Option<NativeWatcherHandle>,
    watcher_root_dir: Option<String>,
    watcher_started_at: Option<String>,
    last_event_at: Option<String>,
    last_refresh_requested_at: Option<String>,
    last_refresh_reason: Option<String>,
    last_error: Option<String>,
}

impl NativeLibraryState {
    fn new() -> Self {
        Self {
            watcher_handle: None,
            watcher_root_dir: None,
            watcher_started_at: None,
            last_event_at: None,
            last_refresh_requested_at: None,
            last_refresh_reason: None,
            last_error: None,
        }
    }

    fn snapshot(&self) -> NativeLibraryWatcherStatus {
        let mut snapshot = NativeLibraryWatcherStatus {
            active: self.watcher_handle.is_some(),
            root_dir: self.watcher_root_dir.clone(),
            started_at: self.watcher_started_at.clone(),
            last_event_at: self.last_event_at.clone(),
            last_refresh_requested_at: self.last_refresh_requested_at.clone(),
            last_refresh_reason: self.last_refresh_reason.clone(),
            last_error: self.last_error.clone(),
        };

        if let Some(handle) = &self.watcher_handle {
            if let Ok(runtime) = handle.runtime.lock() {
                snapshot.last_event_at = runtime.last_event_at.clone().or(snapshot.last_event_at);
                snapshot.last_refresh_requested_at = runtime
                    .last_refresh_requested_at
                    .clone()
                    .or(snapshot.last_refresh_requested_at);
                snapshot.last_refresh_reason = runtime
                    .last_refresh_reason
                    .clone()
                    .or(snapshot.last_refresh_reason);
                snapshot.last_error = runtime.last_error.clone().or(snapshot.last_error);
            }
        }

        snapshot
    }

    fn stop(&mut self) -> NativeLibraryWatcherStatus {
        self.watcher_handle = None;
        self.watcher_root_dir = None;
        self.watcher_started_at = None;
        self.snapshot()
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BackendArchitecture {
    mode: &'static str,
    host: &'static str,
    port: u16,
    frontend_dev_url: &'static str,
    api_base_url: &'static str,
    desktop_shell_owns_process: bool,
    tray_implemented: bool,
    note: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BackendPolicy {
    persistent: bool,
    keep_backend_on_window_close: bool,
    close_window_behavior: &'static str,
    quit_application_behavior: &'static str,
    implemented_by_desktop_shell: bool,
    requires_system_tray: bool,
    note: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopShellStatus {
    policy: BackendPolicy,
    backend_process: BackendProcessSnapshot,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeContextMenuItem {
    id: String,
    label: String,
    disabled: Option<bool>,
    items: Option<Vec<NativeContextMenuItem>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeContextMenuRequest {
    items: Vec<NativeContextMenuItem>,
    x: Option<f64>,
    y: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeContextMenuResult {
    supported: bool,
    selected_action_id: Option<String>,
    fallback_reason: Option<String>,
}

#[tauri::command]
fn describe_backend_policy(persistent: bool) -> BackendPolicy {
    backend_policy(persistent)
}

#[tauri::command]
fn set_backend_persistence(
    state: tauri::State<'_, Mutex<DesktopState>>,
    persistent: bool,
) -> DesktopShellStatus {
    let mut state = lock_desktop_state(&state);
    state.backend_persistent = persistent;
    desktop_status(&mut state)
}

#[tauri::command]
fn start_managed_backend(state: tauri::State<'_, Mutex<DesktopState>>) -> DesktopShellStatus {
    let mut state = lock_desktop_state(&state);
    state.backend.start();
    desktop_status(&mut state)
}

#[tauri::command]
fn stop_managed_backend(state: tauri::State<'_, Mutex<DesktopState>>) -> DesktopShellStatus {
    let mut state = lock_desktop_state(&state);
    state.backend.stop();
    desktop_status(&mut state)
}

#[tauri::command]
fn desktop_shell_status(state: tauri::State<'_, Mutex<DesktopState>>) -> DesktopShellStatus {
    let mut state = lock_desktop_state(&state);
    desktop_status(&mut state)
}

#[tauri::command]
fn get_native_library_engine_state(
    state: tauri::State<'_, Mutex<DesktopState>>,
) -> NativeLibraryEngineState {
    let state = lock_desktop_state(&state);
    NativeLibraryEngineState {
        watcher: state.native_library.snapshot(),
        backend_managed: true,
    }
}

#[tauri::command]
fn stop_native_library_watcher(
    state: tauri::State<'_, Mutex<DesktopState>>,
) -> NativeLibraryWatcherStatus {
    let mut state = lock_desktop_state(&state);
    state.native_library.stop()
}

#[tauri::command]
fn start_native_library_watcher(
    state: tauri::State<'_, Mutex<DesktopState>>,
    request: NativeLibraryWatcherRequest,
) -> Result<NativeLibraryWatcherStatus, String> {
    let root_dir = request.root_dir.trim();
    if root_dir.is_empty() {
        return Err("rootDir 不能为空".to_string());
    }

    let canonical_root = fs::canonicalize(root_dir)
        .map_err(|error| format!("无法解析 watcher 根目录：{error}"))?;
    if !canonical_root.is_dir() {
        return Err("watcher 根目录不是文件夹".to_string());
    }

    let root_dir_string = canonical_root.to_string_lossy().to_string();
    {
        let state = lock_desktop_state(&state);
        if state.native_library.watcher_handle.is_some()
            && state.native_library.watcher_root_dir.as_deref() == Some(root_dir_string.as_str())
        {
            return Ok(state.native_library.snapshot());
        }
    }
    println!(
        "[x-file native] watcher.start rootDir={} transport=native",
        root_dir_string
    );
    let watcher_resource_dir = {
        let state = lock_desktop_state(&state);
        state.resource_dir.clone()
    };
    let runtime = Arc::new(Mutex::new(NativeWatcherRuntime::new()));
    let runtime_for_callback = Arc::clone(&runtime);
    let canonical_root_for_callback = canonical_root.clone();
    let mut watcher = RecommendedWatcher::new(
        move |result: Result<Event, notify::Error>| {
            match result {
                Ok(event) => {
                    if !should_handle_native_watcher_event(&canonical_root_for_callback, &event) {
                        return;
                    }
                    let now_ms = chrono::Utc::now().timestamp_millis();
                    if let Ok(mut runtime) = runtime_for_callback.lock() {
                        if runtime
                            .last_event_unix_ms
                            .is_some_and(|last_ms| now_ms.saturating_sub(last_ms) < 1200)
                        {
                            return;
                        }
                        runtime.last_event_unix_ms = Some(now_ms);
                    }
                    println!(
                        "[x-file native] watcher.event reason=native_watcher_change transport=native"
                    );
                    if let Ok(mut runtime) = runtime_for_callback.lock() {
                        runtime.last_event_at = Some(iso_now());
                        runtime.last_refresh_requested_at = Some(iso_now());
                        runtime.last_refresh_reason = Some("native_watcher_change".to_string());
                        runtime.last_error = None;
                    }
                    let _ = run_native_library_index_worker_detached(
                        watcher_resource_dir.clone(),
                        NativeLibraryRefreshRequest {
                        reason: Some("native_watcher_change".to_string()),
                        target_path: None,
                        mode: None,
                    });
                }
                Err(error) => {
                    if let Ok(mut runtime) = runtime_for_callback.lock() {
                        runtime.last_error = Some(error.to_string());
                    }
                    eprintln!("native watcher error: {error}");
                }
            }
        },
        NotifyConfig::default(),
    )
    .map_err(|error| format!("创建 native watcher 失败：{error}"))?;

    watcher
        .watch(&canonical_root, RecursiveMode::Recursive)
        .map_err(|error| format!("启动 native watcher 失败：{error}"))?;

    let mut state = lock_desktop_state(&state);
    state.native_library.stop();
    state.native_library.watcher_root_dir = Some(root_dir_string);
    state.native_library.watcher_started_at = Some(iso_now());
    state.native_library.last_error = None;
    state.native_library.watcher_handle = Some(NativeWatcherHandle {
        _watcher: watcher,
        runtime,
    });
    Ok(state.native_library.snapshot())
}

fn should_handle_native_watcher_event(root_dir: &Path, event: &Event) -> bool {
    event.paths.iter().any(|path| !is_native_runtime_artifact_path(root_dir, path))
}

fn is_native_runtime_artifact_path(root_dir: &Path, path: &Path) -> bool {
    let Ok(relative) = path.strip_prefix(root_dir) else {
        return false;
    };
    let mut components = relative.components();
    if let Some(component) = components.next() {
        if let Some(name) = component.as_os_str().to_str() {
            return name == ".ai-index" || name == ".x-file";
        }
    }
    false
}

#[tauri::command]
fn native_request_library_refresh(
    state: tauri::State<'_, Mutex<DesktopState>>,
    request: NativeLibraryRefreshRequest,
) -> Result<NativeLibraryRefreshResponse, String> {
    let mut state = lock_desktop_state(&state);
    println!(
        "[x-file native] refresh.request transport=native reason={} targetPath={}",
        request.reason.as_deref().unwrap_or("native_manual_refresh"),
        request.target_path.as_deref().unwrap_or("<root>")
    );
    let backend_response = run_native_library_index_worker(&mut state, request)?;
    Ok(NativeLibraryRefreshResponse {
        watcher: state.native_library.snapshot(),
        backend_response,
    })
}

#[tauri::command]
fn native_get_library_binding() -> Result<Value, String> {
    serde_json::to_value(read_local_library_binding()?)
        .map_err(|error| format!("序列化本地 binding 失败：{error}"))
}

#[tauri::command]
fn native_save_library_binding(
    request: NativeSaveLibraryBindingRequest,
) -> Result<Value, String> {
    serde_json::to_value(save_local_library_binding(request)?)
        .map_err(|error| format!("序列化本地 binding 失败：{error}"))
}

#[tauri::command]
fn native_get_library_config() -> Result<Value, String> {
    serde_json::to_value(read_local_library_config()?)
        .map_err(|error| format!("序列化本地 config 失败：{error}"))
}

#[tauri::command]
fn native_save_library_config(
    request: NativeSaveLibraryConfigRequest,
) -> Result<Value, String> {
    serde_json::to_value(save_local_library_config(request)?)
        .map_err(|error| format!("序列化本地 config 失败：{error}"))
}

#[tauri::command]
fn native_browse_host_directories(
    path: Option<String>,
) -> Result<Value, String> {
    serde_json::to_value(browse_local_host_directories(path)?)
        .map_err(|error| format!("序列化本地 host directories 失败：{error}"))
}

#[tauri::command]
fn native_get_library_snapshot(
    state: tauri::State<'_, Mutex<DesktopState>>,
) -> Result<NativeLibrarySnapshotResponse, String> {
    let watcher = {
        let state = lock_desktop_state(&state);
        state.native_library.snapshot()
    };
    let snapshot = serde_json::to_value(read_local_library_snapshot(&watcher)?)
        .map_err(|error| format!("序列化本地 snapshot 失败：{error}"))?;
    Ok(NativeLibrarySnapshotResponse { watcher, snapshot })
}

#[tauri::command]
fn native_list_library_tag_details(
    request: NativeListLibraryTagDetailsRequest,
) -> Result<Value, String> {
    list_native_library_tag_details(request.include_disabled.unwrap_or(true))
}

#[tauri::command]
fn native_get_library_tag_detail(
    request: NativeLibraryTagIdRequest,
) -> Result<Value, String> {
    get_native_library_tag_detail(&request.tag_id)
}

#[tauri::command]
fn native_create_library_tag(
    request: NativeSaveLibraryTagDefinitionRequest,
) -> Result<Value, String> {
    create_native_library_tag(request)
}

#[tauri::command]
fn native_update_library_tag(
    request: NativeSaveLibraryTagDefinitionRequest,
) -> Result<Value, String> {
    let tag_id = request
        .tag_id
        .clone()
        .ok_or_else(|| "tagId 不能为空".to_string())?;
    update_native_library_tag(tag_id, request)
}

#[tauri::command]
fn native_delete_library_tag(
    request: NativeLibraryTagIdRequest,
) -> Result<Value, String> {
    delete_native_library_tag(&request.tag_id)
}

#[tauri::command]
fn native_get_document_tag_details(
    request: NativeDocumentTagDetailsRequest,
) -> Result<Value, String> {
    get_native_document_tag_details(&request.document_id)
}

#[tauri::command]
fn native_save_document_tags(
    request: NativeSaveDocumentTagsRequest,
) -> Result<Value, String> {
    save_native_document_tags(request)
}

#[tauri::command]
fn native_get_folder_tag_details(
    request: NativeFolderTagDetailsRequest,
) -> Result<Value, String> {
    get_native_folder_tag_details(&request.folder_path)
}

#[tauri::command]
fn native_save_folder_tags(
    request: NativeSaveFolderTagsRequest,
) -> Result<Value, String> {
    save_native_folder_tags(request)
}

#[tauri::command]
fn native_request_library_tag_recompute() -> Result<Value, String> {
    request_native_library_tag_recompute()
}

#[tauri::command]
fn native_get_library_tag_recompute_task() -> Result<Value, String> {
    get_native_library_tag_recompute_task()
}

#[tauri::command]
fn native_list_library_documents(
    request: NativeListDocumentsRequest,
) -> Result<Value, String> {
    serde_json::to_value(read_local_library_documents(request)?)
        .map_err(|error| format!("序列化本地 documents 失败：{error}"))
}

#[tauri::command]
fn native_list_library_files(
    path: Option<String>,
    limit: Option<usize>,
) -> Result<Value, String> {
    serde_json::to_value(read_local_library_files(path, limit)?)
        .map_err(|error| format!("序列化本地 files 失败：{error}"))
}

#[tauri::command]
fn native_get_library_preview(
    request: NativePreviewRequest,
) -> Result<Value, String> {
    println!(
        "[x-file native] preview.request transport=native path={} displayMode={}",
        request.path,
        request.display_mode.as_deref().unwrap_or("default")
    );
    serde_json::to_value(read_local_library_preview(request)?)
        .map_err(|error| format!("序列化本地 preview 失败：{error}"))
}

#[tauri::command]
fn native_build_onlyoffice_preview(
    state: tauri::State<'_, Mutex<DesktopState>>,
    request: NativeOnlyOfficePreviewRequest,
) -> Result<Value, String> {
    println!(
        "[x-file native] onlyoffice.preview.request transport=native path={} displayMode={}",
        request.path,
        request.display_mode.as_deref().unwrap_or("default")
    );
    serde_json::to_value(build_native_onlyoffice_preview(&state, request)?)
        .map_err(|error| format!("序列化 native onlyoffice preview 失败：{error}"))
}

#[tauri::command]
fn native_fetch_library_health(
    state: tauri::State<'_, Mutex<DesktopState>>,
) -> Result<Value, String> {
    let mut state = lock_desktop_state(&state);
    let watcher = state.native_library.snapshot();
    let backend = state.backend.snapshot();
    Ok(json!({
        "ok": true,
        "app": "X-File",
        "version": "0.1.0",
        "native": {
            "watcherActive": watcher.active,
            "watcherRootDir": watcher.root_dir,
            "lastRefreshReason": watcher.last_refresh_reason,
            "lastError": watcher.last_error,
            "backendState": backend.state,
            "backendPid": backend.pid,
        }
    }))
}

#[tauri::command]
fn native_get_onlyoffice_settings() -> Result<Value, String> {
    read_local_onlyoffice_settings_view()
}

#[tauri::command]
fn native_save_onlyoffice_settings(
    input: NativeOnlyOfficeSettingsInput,
) -> Result<Value, String> {
    save_local_onlyoffice_settings(input)
}

#[tauri::command]
fn native_get_onlyoffice_status() -> Result<Value, String> {
    read_local_onlyoffice_status_view()
}

#[tauri::command]
fn native_list_plugins(
    state: tauri::State<'_, Mutex<DesktopState>>,
) -> Result<Value, String> {
    let resource_dir = {
        let state = lock_desktop_state(&state);
        state.resource_dir.clone()
    };
    read_local_plugin_list(resource_dir.as_ref())
}

#[tauri::command]
fn native_enable_plugin(
    state: tauri::State<'_, Mutex<DesktopState>>,
    request: NativePluginToggleRequest,
) -> Result<Value, String> {
    let resource_dir = {
        let state = lock_desktop_state(&state);
        state.resource_dir.clone()
    };
    set_local_plugin_enabled(resource_dir.as_ref(), &request.plugin_id, true)
}

#[tauri::command]
fn native_disable_plugin(
    state: tauri::State<'_, Mutex<DesktopState>>,
    request: NativePluginToggleRequest,
) -> Result<Value, String> {
    let resource_dir = {
        let state = lock_desktop_state(&state);
        state.resource_dir.clone()
    };
    set_local_plugin_enabled(resource_dir.as_ref(), &request.plugin_id, false)
}

#[tauri::command]
fn native_get_http_server_state(
    state: tauri::State<'_, Mutex<DesktopState>>,
) -> Result<Value, String> {
    let mut state = lock_desktop_state(&state);
    Ok(read_local_http_server_state(&mut state))
}

#[tauri::command]
fn native_save_http_server_state(
    state: tauri::State<'_, Mutex<DesktopState>>,
    request: NativeSaveHttpServerStateRequest,
) -> Result<Value, String> {
    let mut state = lock_desktop_state(&state);
    save_local_http_server_state(&mut state, request)
}

#[tauri::command]
fn http_service_hint() -> BackendArchitecture {
    BackendArchitecture {
        mode: "tauri_shell_plus_node_fastify",
        host: "127.0.0.1",
        port: 17321,
        frontend_dev_url: "http://127.0.0.1:17320",
        api_base_url: "http://127.0.0.1:17321",
        desktop_shell_owns_process: true,
        tray_implemented: true,
        note: "桌面壳已实现托盘菜单、关闭窗口隐藏和后端子进程托管入口；正式包默认不再内置 Node sidecar，如需后端能力必须显式提供外部 sidecar 入口。",
    }
}

#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
    let normalized = path.trim();
    if normalized.is_empty() {
        return Err("路径不能为空".to_string());
    }

    let mut command = build_open_path_command(normalized);
    command
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("打开本机路径失败：{error}"))
}

#[tauri::command]
fn reveal_path_in_file_manager(path: String) -> Result<(), String> {
    let normalized = path.trim();
    if normalized.is_empty() {
        return Err("路径不能为空".to_string());
    }

    let mut command = build_reveal_path_command(normalized);
    command
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("在文件管理器中定位失败：{error}"))
}

#[tauri::command]
fn show_library_context_menu(
    app: AppHandle,
    state: tauri::State<'_, Mutex<DesktopState>>,
    request: NativeContextMenuRequest,
) -> Result<NativeContextMenuResult, String> {
    if request.items.is_empty() {
        return Ok(NativeContextMenuResult {
            supported: true,
            selected_action_id: None,
            fallback_reason: Some("菜单项为空，已跳过原生菜单。".to_string()),
        });
    }

    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        return Ok(NativeContextMenuResult {
            supported: false,
            selected_action_id: None,
            fallback_reason: Some("找不到主窗口，回退到 Web 右键菜单。".to_string()),
        });
    };

    {
        let mut state = lock_desktop_state(&state);
        state.native_context_menu_selection = None;
    }

    let menu = build_native_context_menu(&app, &request.items)?;
    let popup_result = match (request.x, request.y) {
        (Some(x), Some(y)) => window.popup_menu_at(&menu, tauri::LogicalPosition::new(x, y)),
        _ => window.popup_menu(&menu),
    };

    if let Err(error) = popup_result {
        return Ok(NativeContextMenuResult {
            supported: false,
            selected_action_id: None,
            fallback_reason: Some(format!("原生菜单打开失败，回退到 Web 右键菜单：{error}")),
        });
    }

    let selected_action_id = {
        let mut state = lock_desktop_state(&state);
        state.native_context_menu_selection.take()
    };

    Ok(NativeContextMenuResult {
        supported: true,
        selected_action_id,
        fallback_reason: None,
    })
}

fn build_native_context_menu(
    app: &AppHandle,
    items: &[NativeContextMenuItem],
) -> Result<Menu<tauri::Wry>, String> {
    let menu = Menu::new(app).map_err(|error| format!("创建原生菜单失败：{error}"))?;
    append_native_context_menu_items(app, &menu, items)?;
    Ok(menu)
}

fn append_native_context_menu_items(
    app: &AppHandle,
    menu: &Menu<tauri::Wry>,
    items: &[NativeContextMenuItem],
) -> Result<(), String> {
    for item in items {
        if item.items.as_ref().is_some_and(|children| !children.is_empty()) {
            let submenu = build_native_context_submenu(app, item)?;
            menu.append(&submenu)
                .map_err(|error| format!("添加原生子菜单失败：{error}"))?;
            continue;
        }

        let menu_item = MenuItemBuilder::with_id(
            format!("{LIBRARY_CONTEXT_MENU_ID_PREFIX}{}", item.id),
            item.label.as_str(),
        )
        .enabled(!item.disabled.unwrap_or(false))
        .build(app)
        .map_err(|error| format!("创建原生菜单项失败：{error}"))?;

        menu.append(&menu_item)
            .map_err(|error| format!("添加原生菜单项失败：{error}"))?;
    }

    Ok(())
}

fn build_native_context_submenu(
    app: &AppHandle,
    item: &NativeContextMenuItem,
) -> Result<tauri::menu::Submenu<tauri::Wry>, String> {
    let submenu = SubmenuBuilder::with_id(
        app,
        format!("{LIBRARY_CONTEXT_MENU_ID_PREFIX}{}", item.id),
        item.label.as_str(),
    )
    .enabled(!item.disabled.unwrap_or(false))
    .build()
    .map_err(|error| format!("创建原生子菜单失败：{error}"))?;

    for child in item.items.as_deref().unwrap_or(&[]) {
        if child.items.as_ref().is_some_and(|children| !children.is_empty()) {
            let child_submenu = build_native_context_submenu(app, child)?;
            submenu
                .append(&child_submenu)
                .map_err(|error| format!("添加原生子菜单失败：{error}"))?;
            continue;
        }

        let child_item = MenuItemBuilder::with_id(
            format!("{LIBRARY_CONTEXT_MENU_ID_PREFIX}{}", child.id),
            child.label.as_str(),
        )
        .enabled(!child.disabled.unwrap_or(false))
        .build(app)
        .map_err(|error| format!("创建原生子菜单项失败：{error}"))?;

        submenu
            .append(&child_item)
            .map_err(|error| format!("添加原生子菜单项失败：{error}"))?;
    }

    Ok(submenu)
}

#[cfg(target_os = "macos")]
fn build_open_path_command(path: &str) -> Command {
    let mut command = Command::new("open");
    command.arg(path);
    command
}

#[cfg(target_os = "macos")]
fn build_reveal_path_command(path: &str) -> Command {
    let mut command = Command::new("open");
    command.args(["-R", path]);
    command
}

#[cfg(target_os = "windows")]
fn build_open_path_command(path: &str) -> Command {
    let mut command = Command::new("cmd");
    command.args(["/C", "start", "", path]);
    command
}

#[cfg(target_os = "windows")]
fn build_reveal_path_command(path: &str) -> Command {
    let mut command = Command::new("explorer");
    command.arg(format!("/select,{path}"));
    command
}

#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
fn build_open_path_command(path: &str) -> Command {
    let mut command = Command::new("xdg-open");
    command.arg(path);
    command
}

#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
fn build_reveal_path_command(path: &str) -> Command {
    build_open_path_command(path)
}

fn backend_policy(persistent: bool) -> BackendPolicy {
    if persistent {
        BackendPolicy {
            persistent,
            keep_backend_on_window_close: true,
            close_window_behavior: "hide_window_keep_backend",
            quit_application_behavior: "stop_backend_and_quit_application",
            implemented_by_desktop_shell: true,
            requires_system_tray: true,
            note: "关闭窗口时隐藏主窗口并保留后台服务；用户可以从顶部菜单栏图标恢复窗口或退出应用。",
        }
    } else {
        BackendPolicy {
            persistent,
            keep_backend_on_window_close: false,
            close_window_behavior: "quit_application",
            quit_application_behavior: "stop_backend_and_quit_application",
            implemented_by_desktop_shell: true,
            requires_system_tray: false,
            note: "关闭窗口按普通退出处理；退出前会停止桌面壳托管的后端子进程。",
        }
    }
}

fn desktop_status(state: &mut DesktopState) -> DesktopShellStatus {
    DesktopShellStatus {
        policy: backend_policy(state.backend_persistent),
        backend_process: state.backend.snapshot(),
    }
}

fn lock_desktop_state<'a>(
    state: &'a tauri::State<'_, Mutex<DesktopState>>,
) -> std::sync::MutexGuard<'a, DesktopState> {
    state.lock().expect("桌面状态锁已损坏")
}

fn default_backend_command() -> String {
    env::var("X_FILE_BACKEND_COMMAND").unwrap_or_default()
}

fn default_backend_args() -> Vec<String> {
    Vec::new()
}

fn default_backend_cwd() -> PathBuf {
    env::var("X_FILE_BACKEND_CWD")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            env::current_exe()
                .ok()
                .and_then(|path| path.parent().map(PathBuf::from))
                .unwrap_or_else(|| PathBuf::from("."))
        })
}

fn parse_command_args(value: String) -> Vec<String> {
    value
        .split_whitespace()
        .filter(|part| !part.is_empty())
        .map(ToString::to_string)
        .collect()
}

fn epoch_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn resolve_main_window_geometry_path() -> PathBuf {
    x_file_data_dir().join(MAIN_WINDOW_GEOMETRY_FILE_NAME)
}

fn read_persisted_main_window_geometry() -> Option<MainWindowGeometry> {
    read_optional_json_file::<MainWindowGeometry>(&resolve_main_window_geometry_path())
        .ok()
        .flatten()
}

fn persist_main_window_geometry(geometry: MainWindowGeometry) -> Result<(), String> {
    write_json_file(&resolve_main_window_geometry_path(), &geometry)
}

fn update_main_window_geometry_state(app: &AppHandle, geometry: MainWindowGeometry) {
    let Some(desktop_state) = app.try_state::<Mutex<DesktopState>>() else {
        return;
    };
    let Some(mut state) = desktop_state.try_lock().ok() else {
        return;
    };
    state.main_window_geometry = Some(geometry);
}

fn apply_main_window_geometry(window: &WebviewWindow, geometry: MainWindowGeometry) {
    let _ = window.set_size(tauri::Size::Physical(tauri::PhysicalSize::new(
        geometry.width,
        geometry.height,
    )));
    let _ = window.set_position(tauri::Position::Physical(
        tauri::PhysicalPosition::new(geometry.position_x, geometry.position_y),
    ));
}

fn capture_main_window_geometry_from_window(window: &Window) -> Option<MainWindowGeometry> {
    let position = window.outer_position().ok()?;
    let size = window.outer_size().ok()?;
    if size.width == 0 || size.height == 0 {
        return None;
    }
    Some(MainWindowGeometry {
        position_x: position.x,
        position_y: position.y,
        width: size.width,
        height: size.height,
    })
}

fn capture_main_window_geometry_from_webview(window: &WebviewWindow) -> Option<MainWindowGeometry> {
    let position = window.outer_position().ok()?;
    let size = window.outer_size().ok()?;
    if size.width == 0 || size.height == 0 {
        return None;
    }
    Some(MainWindowGeometry {
        position_x: position.x,
        position_y: position.y,
        width: size.width,
        height: size.height,
    })
}

fn remember_main_window_geometry(window: &Window) {
    let Some(geometry) = capture_main_window_geometry_from_window(window) else {
        return;
    };
    let desktop_state = window.state::<Mutex<DesktopState>>();
    let Some(mut state) = desktop_state.try_lock().ok() else {
        return;
    };
    state.main_window_geometry = Some(geometry);
}

fn remember_main_window_geometry_from_webview(window: &WebviewWindow) {
    let Some(geometry) = capture_main_window_geometry_from_webview(window) else {
        return;
    };
    let desktop_state = window.state::<Mutex<DesktopState>>();
    let Some(mut state) = desktop_state.try_lock().ok() else {
        return;
    };
    state.main_window_geometry = Some(geometry);
}

fn persist_main_window_geometry_from_window(window: &Window) {
    let Some(geometry) = capture_main_window_geometry_from_window(window) else {
        return;
    };
    remember_main_window_geometry(window);
    if let Err(error) = persist_main_window_geometry(geometry) {
        eprintln!("持久化主窗口尺寸失败: {error}");
    }
}

fn show_main_window(app: &AppHandle) {
    let _ = app.show();
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let saved_geometry = app
            .try_state::<Mutex<DesktopState>>()
            .and_then(|desktop_state| {
                desktop_state
                    .try_lock()
                    .ok()
                    .and_then(|state| state.main_window_geometry)
            });
        if let Some(geometry) = saved_geometry {
            apply_main_window_geometry(&window, geometry);
        }
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn hide_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let _ = window.hide();
    }
}

fn quit_application(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        if let Some(geometry) = capture_main_window_geometry_from_webview(&window) {
            update_main_window_geometry_state(app, geometry);
            if let Err(error) = persist_main_window_geometry(geometry) {
                eprintln!("退出前持久化主窗口尺寸失败: {error}");
            }
        }
    }

    if let Some(state) = app.try_state::<Mutex<DesktopState>>() {
        let mut state = state.lock().expect("桌面状态锁已损坏");
        state.is_quitting = true;
        state.backend.stop();
    }

    app.exit(0);
}

fn handle_menu_event(app: &AppHandle, event: MenuEvent) {
    let id = event.id().as_ref();
    if let Some(action_id) = id.strip_prefix(LIBRARY_CONTEXT_MENU_ID_PREFIX) {
        if let Some(state) = app.try_state::<Mutex<DesktopState>>() {
            let mut state = state.lock().expect("桌面状态锁已损坏");
            state.native_context_menu_selection = Some(action_id.to_string());
        }
        let _ = app.emit(LIBRARY_CONTEXT_MENU_ACTION_EVENT, action_id);
        return;
    }

    match id {
        MENU_SHOW_WINDOW => show_main_window(app),
        MENU_HIDE_WINDOW => hide_main_window(app),
        MENU_ENABLE_PERSISTENCE => {
            if let Some(state) = app.try_state::<Mutex<DesktopState>>() {
                let mut state = state.lock().expect("桌面状态锁已损坏");
                state.backend_persistent = true;
            }
        }
        MENU_DISABLE_PERSISTENCE => {
            if let Some(state) = app.try_state::<Mutex<DesktopState>>() {
                let mut state = state.lock().expect("桌面状态锁已损坏");
                state.backend_persistent = false;
            }
        }
        MENU_START_BACKEND => {
            if let Some(state) = app.try_state::<Mutex<DesktopState>>() {
                let mut state = state.lock().expect("桌面状态锁已损坏");
                state.backend.start();
            }
        }
        MENU_STOP_BACKEND => {
            if let Some(state) = app.try_state::<Mutex<DesktopState>>() {
                let mut state = state.lock().expect("桌面状态锁已损坏");
                state.backend.stop();
            }
        }
        MENU_QUIT => quit_application(app),
        _ => {}
    }
}

fn setup_tray(app: &mut tauri::App) -> tauri::Result<()> {
    let show_window = MenuItemBuilder::with_id(MENU_SHOW_WINDOW, "显示 X-File").build(app)?;
    let hide_window = MenuItemBuilder::with_id(MENU_HIDE_WINDOW, "隐藏窗口").build(app)?;
    let enable_persistence =
        MenuItemBuilder::with_id(MENU_ENABLE_PERSISTENCE, "开启后端常驻").build(app)?;
    let disable_persistence =
        MenuItemBuilder::with_id(MENU_DISABLE_PERSISTENCE, "关闭后端常驻").build(app)?;
    let start_backend =
        MenuItemBuilder::with_id(MENU_START_BACKEND, "启动内置后端").build(app)?;
    let stop_backend = MenuItemBuilder::with_id(MENU_STOP_BACKEND, "停止内置后端").build(app)?;
    let quit = MenuItemBuilder::with_id(MENU_QUIT, "退出 X-File").build(app)?;

    let menu = MenuBuilder::new(app)
        .item(&show_window)
        .item(&hide_window)
        .separator()
        .item(&enable_persistence)
        .item(&disable_persistence)
        .separator()
        .item(&start_backend)
        .item(&stop_backend)
        .separator()
        .item(&quit)
        .build()?;

    let mut tray_builder = TrayIconBuilder::with_id("main-tray")
        .tooltip("X-File 文档库")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(handle_menu_event)
        .on_tray_icon_event(|tray, event| match event {
            TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            }
            | TrayIconEvent::DoubleClick {
                button: MouseButton::Left,
                ..
            } => show_main_window(tray.app_handle()),
            _ => {}
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        tray_builder = tray_builder.icon(icon);
    }

    #[cfg(target_os = "macos")]
    {
        tray_builder = tray_builder.icon_as_template(false);
    }

    tray_builder.build(app)?;

    Ok(())
}

fn configure_backend_process(app: &tauri::App) {
    let resource_dir = app.path().resource_dir().ok();
    let resource_boundary = resource_dir
        .as_ref()
        .and_then(|dir| read_resource_boundary_manifest(dir).ok().flatten());

    let state = app.state::<Mutex<DesktopState>>();
    let mut state = state.lock().expect("桌面状态锁已损坏");

    state.resource_dir = resource_dir.clone();

    if let Some(resource_dir) = resource_dir {
        state.backend.prefer_resource_entry(resource_dir, resource_boundary.as_ref());
    }

    if should_autostart_backend() {
        state.backend.start();
    }
}

fn run_native_library_index_worker(
    state: &mut DesktopState,
    request: NativeLibraryRefreshRequest,
) -> Result<Value, String> {
    let native_library = &mut state.native_library;
    let binding = read_local_library_binding()?
        .ok_or_else(|| "文档库绑定不存在，无法执行索引 worker".to_string())?;
    let reason = request
        .reason
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("native_manual_refresh")
        .to_string();
    let target_path = request
        .target_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string);
    let mode = request
        .mode
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("full")
        .to_string();

    native_library.last_refresh_requested_at = Some(iso_now());
    native_library.last_refresh_reason = Some(reason.clone());
    native_library.last_error = None;

    println!(
        "[x-file native] refresh.forward transport=worker mode={} reason={} targetPath={}",
        mode,
        reason,
        target_path.as_deref().unwrap_or("<root>")
    );
    if mode == "full" {
        let index_result = run_native_library_index_worker_once(
            state,
            &binding,
            &reason,
            target_path.clone(),
            "index-only",
            None,
        )?;
        let dirty_scope = index_result
            .get("dirtyScope")
            .cloned()
            .ok_or_else(|| "index-only worker 未返回 dirtyScope，无法继续执行 export-only".to_string())?;
        if dirty_scope.is_null() {
            return Err("index-only worker 返回了空 dirtyScope，宿主不会继续触发 export-only".to_string());
        }
        let export_result = run_native_library_index_worker_once(
            state,
            &binding,
            &reason,
            target_path.clone(),
            "export-only",
            Some(dirty_scope.clone()),
        )?;
        run_native_library_index_worker_once(
            state,
            &binding,
            &reason,
            target_path,
            "search-only",
            Some(dirty_scope),
        )?;
        return Ok(export_result);
    }

    run_native_library_index_worker_once(state, &binding, &reason, target_path, &mode, None)
}

fn run_native_library_index_worker_once(
    state: &mut DesktopState,
    binding: &LocalLibraryBinding,
    reason: &str,
    target_path: Option<String>,
    mode: &str,
    dirty_scope: Option<Value>,
) -> Result<Value, String> {
    let native_library = &mut state.native_library;
    if mode == "export-only" {
        let payload = dirty_scope
            .ok_or_else(|| "export-only 缺少 dirtyScope，无法执行 Rust 原生导出".to_string())?;
        return run_native_library_export_once(binding, reason, target_path, payload);
    }
    if mode == "search-only" {
        return run_native_library_search_once(binding, reason, target_path, dirty_scope);
    }
    if mode == "index-only" {
        println!(
            "[x-file native] index-only force rust core executor for extensions={} targetPath={}",
            binding.allowed_extensions.join(","),
            target_path.as_deref().unwrap_or("<root>")
        );
        return run_native_library_index_once(binding, reason, target_path);
    }
    let message = format!("未知的桌面原生 library 模式：{mode}");
    native_library.last_error = Some(message.clone());
    Err(message)
}

fn run_native_library_export_once(
    binding: &LocalLibraryBinding,
    reason: &str,
    target_path: Option<String>,
    dirty_scope: Value,
) -> Result<Value, String> {
    run_native_library_export_core(NativeLibraryExportCoreRequest {
        root_dir: binding.root_dir.clone(),
        reason: reason.to_string(),
        target_path,
        dirty_scope,
    })
}

fn run_native_library_search_once(
    binding: &LocalLibraryBinding,
    reason: &str,
    target_path: Option<String>,
    dirty_scope: Option<Value>,
) -> Result<Value, String> {
    run_native_library_search_core(NativeLibrarySearchCoreRequest {
        root_dir: binding.root_dir.clone(),
        reason: reason.to_string(),
        target_path,
        dirty_scope,
    })
}

fn run_native_library_index_once(
    binding: &LocalLibraryBinding,
    reason: &str,
    target_path: Option<String>,
) -> Result<Value, String> {
    run_native_library_index_core(NativeLibraryIndexCoreRequest {
        root_dir: binding.root_dir.clone(),
        allowed_extensions: binding.allowed_extensions.clone(),
        included_hidden_paths: binding.included_hidden_paths.clone(),
        config_relative_path: binding.config_relative_path.clone(),
        reason: reason.to_string(),
        target_path,
    })
}

fn run_native_library_index_worker_detached(
    resource_dir: Option<PathBuf>,
    request: NativeLibraryRefreshRequest,
) -> Result<Value, String> {
    let mut state = DesktopState::new();
    state.resource_dir = resource_dir;
    run_native_library_index_worker(&mut state, request)
}

fn read_local_library_snapshot(
    watcher: &NativeLibraryWatcherStatus,
) -> Result<LocalLibrarySnapshot, String> {
    let default_root_dir = default_library_root_dir();
    let binding = read_local_library_binding()?;
    let favorites = binding
        .as_ref()
        .map(read_local_library_favorites)
        .transpose()?
        .unwrap_or_default();

    let Some(binding) = binding else {
        return Ok(LocalLibrarySnapshot {
            binding: None,
            default_root_dir,
            requires_initialization: true,
            initialization_redirect_path: "/init".to_string(),
            status: empty_local_status("fresh", None),
            tags: vec![],
            favorites,
            folders: vec![],
            document_count: 0,
            last_error: None,
        });
    };

    if !binding.initialized {
        return Ok(LocalLibrarySnapshot {
            binding: Some(binding),
            default_root_dir,
            requires_initialization: true,
            initialization_redirect_path: "/init".to_string(),
            status: empty_local_status("fresh", None),
            tags: vec![],
            favorites,
            folders: vec![],
            document_count: 0,
            last_error: None,
        });
    }

    let manifest_path = PathBuf::from(&binding.root_dir)
        .join(".ai-index")
        .join("exports")
        .join("manifest.json");
    let runtime_status = read_local_runtime_status(&binding.root_dir)?;
    if !manifest_path.is_file() {
        return Ok(LocalLibrarySnapshot {
            binding: Some(binding),
            default_root_dir,
            requires_initialization: false,
            initialization_redirect_path: "/init".to_string(),
            status: runtime_status.unwrap_or_else(|| empty_local_status("fresh", None)),
            tags: vec![],
            favorites,
            folders: vec![],
            document_count: 0,
            last_error: None,
        });
    }

    let export_dir = manifest_path
        .parent()
        .map(PathBuf::from)
        .ok_or_else(|| "无法定位 exports 目录".to_string())?;
    let manifest: ManifestFile = read_json_file(&manifest_path)?;
    let documents = read_meta_documents(&export_dir, &manifest)?;
    let status_file: Option<StatusFile> = read_optional_json_file(
        &export_dir.join(
            manifest
                .entries
                .as_ref()
                .and_then(|entries| entries.status.clone())
                .unwrap_or_else(|| "status.json".to_string()),
        ),
    )?;
    let document_count = status_file
        .as_ref()
        .and_then(|status| status.document_count)
        .unwrap_or(documents.len());
    let tag_counts = count_local_tags(&documents);
    let tags = read_local_tags(&export_dir, &manifest, &tag_counts)?;
    let folders = read_local_folders(&export_dir, &manifest)?;
    let status = merge_runtime_status(
        runtime_status,
        manifest.generated_at.clone(),
        status_file.and_then(|item| item.exported_at),
        document_count,
        watcher,
    );

    Ok(LocalLibrarySnapshot {
        binding: Some(binding),
        default_root_dir,
        requires_initialization: false,
        initialization_redirect_path: "/init".to_string(),
        status: status.clone(),
        tags,
        favorites,
        folders,
        document_count,
        last_error: status.error_summary,
    })
}

fn read_local_library_documents(
    request: NativeListDocumentsRequest,
) -> Result<LocalLibraryDocumentList, String> {
    let binding = read_local_library_binding()?
        .ok_or_else(|| "当前未绑定文档库".to_string())?;
    let favorites = read_local_library_favorites(&binding)?;
    let export_dir = PathBuf::from(&binding.root_dir).join(".ai-index").join("exports");
    let manifest: ManifestFile = read_json_file(&export_dir.join("manifest.json"))?;
    let documents = read_meta_documents(&export_dir, &manifest)?;
    let keyword = request.keyword.unwrap_or_default().trim().to_lowercase();
    let offset = request.offset.unwrap_or(0);
    let limit = request.limit.unwrap_or(50);
    let selected_tags = request.selected_tag_paths.unwrap_or_else(|| {
        request
            .selected_tag_path
            .clone()
            .map(|value| vec![value])
            .unwrap_or_default()
    });

    let mut items = Vec::new();
    for document in documents {
        let normalized_path = normalize_document_path(&document.path);
        let title = document
            .title
            .clone()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| file_name_from_path(&normalized_path));
        let summary = document.summary.clone().unwrap_or_default();
        let tags = document.direct_tags.clone().unwrap_or_default();
        let derived_tags = document.derived_tags.clone().unwrap_or_default();
        let document_dir = normalize_folder_path(
            &PathBuf::from(&normalized_path)
                .parent()
                .map(|value| value.to_string_lossy().replace('\\', "/"))
                .unwrap_or_else(|| ".".to_string()),
        );

        if request.browse_mode != "tag" {
            let selected_folder = normalize_folder_path(
                request
                    .selected_folder_path
                    .as_deref()
                    .unwrap_or("."),
            );
            if document_dir != selected_folder {
                continue;
            }
        }

        if !selected_tags.is_empty() {
            let all_tags: Vec<String> = tags.iter().chain(derived_tags.iter()).cloned().collect();
            let matched_all = selected_tags.iter().all(|selected| {
                all_tags.iter().any(|tag_path| {
                    tag_path == selected || tag_path.starts_with(&format!("{selected}/"))
                })
            });
            if !matched_all {
                continue;
            }
        }

        if let Some(selected_favorite_id) = request.selected_favorite_id.as_deref() {
            let Some(favorite) = favorites.iter().find(|item| item.path == selected_favorite_id) else {
                continue;
            };
            if !document_matches_favorite(&tags, &derived_tags, &document_dir, favorite) {
                continue;
            }
        }

        if !keyword.is_empty() {
            let haystack = format!(
                "{}\n{}\n{}",
                title.to_lowercase(),
                normalized_path.to_lowercase(),
                summary.to_lowercase()
            );
            if !keyword
                .split_whitespace()
                .all(|token| haystack.contains(token))
            {
                continue;
            }
        }

        let absolute_path = PathBuf::from(&binding.root_dir).join(&normalized_path);
        let metadata = fs::metadata(&absolute_path).ok();
        let is_favorite = favorites.iter().any(|favorite| {
            favorite.kind != "folder"
                && document_matches_favorite(&tags, &derived_tags, &document_dir, favorite)
        });

        items.push(LocalLibraryDocumentRecord {
            document_id: document.document_id,
            path: normalized_path,
            title,
            summary,
            updated_at: document
                .mtime
                .or_else(|| manifest.generated_at.clone())
                .unwrap_or_else(|| chrono::Utc::now().to_rfc3339()),
            created_at: metadata
                .as_ref()
                .and_then(|meta| meta.created().ok())
                .map(system_time_to_rfc3339),
            size_bytes: metadata.as_ref().map(|meta| meta.len()),
            tags,
            derived_tags,
            is_favorite,
        });
    }

    items.sort_by(|left, right| left.path.cmp(&right.path));
    let total = items.len();
    let paged_items = items
        .into_iter()
        .skip(offset)
        .take(limit)
        .collect::<Vec<_>>();
    let tag_facet_counts = count_document_tag_facets(&paged_items);

    Ok(LocalLibraryDocumentList {
        total,
        visible_entry_total: total,
        offset,
        limit,
        items: paged_items,
        tag_facet_counts,
        directory_status: Some(LocalLibraryDirectoryStatus {
            path: normalize_folder_path(request.selected_folder_path.as_deref().unwrap_or(".")),
            state: "fresh".to_string(),
            source: "snapshot".to_string(),
            last_requested_at: None,
            last_completed_at: manifest.generated_at.clone(),
            last_failed_at: None,
            running_task_id: None,
            error_summary: None,
            generated_at: manifest.generated_at,
            filesystem_observed_at: None,
            stale_reason: None,
        }),
    })
}

fn read_local_library_files(
    path: Option<String>,
    limit: Option<usize>,
) -> Result<LocalLibraryFileList, String> {
    let binding = read_local_library_binding()?
        .ok_or_else(|| "当前未绑定文档库".to_string())?;
    let normalized_path = normalize_folder_path(path.as_deref().unwrap_or("."));
    let absolute_path = if normalized_path == "." {
        PathBuf::from(&binding.root_dir)
    } else {
        PathBuf::from(&binding.root_dir).join(&normalized_path)
    };
    let limit = limit.unwrap_or(200);

    if !absolute_path.exists() {
        return Ok(LocalLibraryFileList {
            items: vec![],
            path: normalized_path,
            total: 0,
            limit,
        });
    }

    let metadata = fs::metadata(&absolute_path)
        .map_err(|error| format!("读取目录信息失败：{error}"))?;
    if !metadata.is_dir() {
        return Err("指定路径不是目录".to_string());
    }

    let mut items = Vec::new();
    for entry in fs::read_dir(&absolute_path).map_err(|error| format!("读取目录失败：{error}"))? {
        let entry = entry.map_err(|error| format!("读取目录项失败：{error}"))?;
        let name = entry.file_name().to_string_lossy().to_string();
        let entry_path = if normalized_path == "." {
            name.clone()
        } else {
            format!("{normalized_path}/{name}")
        };
        let entry_metadata = entry.metadata().ok();
        let is_dir = entry_metadata.as_ref().is_some_and(|meta| meta.is_dir());
        items.push(LocalLibraryFileNode {
            path: entry_path,
            name,
            kind: if is_dir { "directory" } else { "file" }.to_string(),
            size: entry_metadata.as_ref().and_then(|meta| if meta.is_dir() { None } else { Some(meta.len()) }),
            updated_at: entry_metadata
                .as_ref()
                .and_then(|meta| meta.modified().ok())
                .map(system_time_to_rfc3339),
        });
    }

    items.sort_by(|left, right| left.path.cmp(&right.path));
    let total = items.len();
    items.truncate(limit);
    Ok(LocalLibraryFileList {
        items,
        path: normalized_path,
        total,
        limit,
    })
}

fn read_local_library_preview(
    request: NativePreviewRequest,
) -> Result<LocalLibraryPreview, String> {
    let binding = read_local_library_binding()?
        .ok_or_else(|| "当前未绑定文档库".to_string())?;
    let relative_path = normalize_document_path(&request.path);
    let absolute_path = PathBuf::from(&binding.root_dir).join(&relative_path);
    let metadata = fs::metadata(&absolute_path)
        .map_err(|error| format!("读取预览文件失败：{error}"))?;
    if !metadata.is_file() {
        return Err("预览目标不是文件".to_string());
    }

    let extension = absolute_path
        .extension()
        .map(|value| value.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let size = metadata.len();
    let updated_at = metadata.modified().ok().map(system_time_to_rfc3339);
    let kind = detect_local_preview_kind(&extension);

    if matches!(kind.as_str(), "image" | "pdf") && size > 20 * 1024 * 1024 {
        return Ok(unsupported_preview(&binding.library_id, &relative_path, size, updated_at, "文件过大，当前内置资源预览暂不处理这么大的文件"));
    }
    if !matches!(kind.as_str(), "image" | "pdf" | "office") && size > 512 * 1024 {
        return Ok(unsupported_preview(&binding.library_id, &relative_path, size, updated_at, "文件过大，本轮只提供轻量预览"));
    }

    if kind == "office" {
        println!(
            "[x-file native] preview.resolve kind=office transport=native-fallback path={}",
            relative_path
        );
        return Ok(LocalLibraryPreview {
            library_id: binding.library_id,
            path: relative_path,
            supported: true,
            kind,
            reason: Some("当前桌面本地模式下，Office 文件改走原生替代路径：可直接用系统应用打开或在 Finder 中定位。".to_string()),
            content: None,
            version: None,
            size,
            updated_at,
            preview_path: None,
            preview_url: None,
            only_office: None,
            capabilities: build_local_preview_capabilities(false, true, true, false, false),
        });
    }

    println!(
        "[x-file native] preview.resolve kind={} transport=native path={}",
        kind,
        relative_path
    );

    if kind == "image" || kind == "pdf" {
        let is_pdf = kind == "pdf";
        let preview_url = absolute_path
            .canonicalize()
            .ok()
            .map(|value| format!("file://{}", value.to_string_lossy()));
        return Ok(LocalLibraryPreview {
            library_id: binding.library_id,
            path: relative_path,
            supported: true,
            kind,
            reason: None,
            content: None,
            version: None,
            size,
            updated_at,
            preview_path: None,
            preview_url,
            only_office: None,
            capabilities: build_local_preview_capabilities(false, true, true, true, is_pdf),
        });
    }

    let buffer = fs::read(&absolute_path).map_err(|error| format!("读取预览文件内容失败：{error}"))?;
    if buffer.contains(&0) {
        return Ok(LocalLibraryPreview {
            library_id: binding.library_id,
            path: relative_path,
            supported: false,
            kind: "binary".to_string(),
            reason: Some("二进制文件暂不支持直接预览".to_string()),
            content: None,
            version: None,
            size,
            updated_at,
            preview_path: None,
            preview_url: None,
            only_office: None,
            capabilities: build_local_preview_capabilities(false, false, false, false, false),
        });
    }

    let content = String::from_utf8(buffer.clone())
        .map_err(|error| format!("读取文本预览失败：{error}"))?;
    let version = if size <= 256 * 1024 && matches!(kind.as_str(), "text" | "markdown" | "html") {
        Some(sha256_hex(&buffer))
    } else {
        None
    };
    let preview_url = if kind == "html" && request.display_mode.as_deref() != Some("reading") {
        absolute_path
            .canonicalize()
            .ok()
            .map(|value| format!("file://{}", value.to_string_lossy()))
    } else {
        None
    };

    Ok(LocalLibraryPreview {
        library_id: binding.library_id,
        path: relative_path,
        supported: true,
        kind: kind.clone(),
        reason: None,
        content: Some(content),
        version,
        size,
        updated_at,
        preview_path: None,
        preview_url,
        only_office: None,
        capabilities: build_local_preview_capabilities(
            matches!(kind.as_str(), "text" | "markdown" | "html") && size <= 256 * 1024,
            true,
            true,
            false,
            false,
        ),
    })
}

fn save_local_library_binding(
    request: NativeSaveLibraryBindingRequest,
) -> Result<LocalLibraryBinding, String> {
    let root_dir = request.root_dir.trim();
    if root_dir.is_empty() {
        return Err("rootDir 不能为空".to_string());
    }
    let canonical_root = fs::canonicalize(root_dir)
        .map_err(|error| format!("无法解析文档库根目录：{error}"))?;
    if !canonical_root.is_dir() {
        return Err("文档库根目录不是文件夹".to_string());
    }
    let existing = read_local_library_binding()?.unwrap_or_else(default_local_library_binding);
    let updated_at = iso_now();
    let initialized = request.complete_initialization.unwrap_or(false);
    let next = LocalLibraryBinding {
        library_id: existing.library_id,
        root_dir: canonical_root.to_string_lossy().to_string(),
        enabled: existing.enabled,
        mirror_root: existing.mirror_root,
        allowed_extensions: existing.allowed_extensions,
        included_hidden_paths: existing.included_hidden_paths,
        folder_open_behavior: existing.folder_open_behavior,
        config_relative_path: existing.config_relative_path,
        export_mode: existing.export_mode,
        initialized,
        initialized_at: if initialized { Some(updated_at.clone()) } else { existing.initialized_at },
        updated_at,
    };
    write_json_file(&x_file_data_dir().join("library-binding.json"), &binding_to_stored(&next))?;
    Ok(next)
}

fn read_local_library_binding() -> Result<Option<LocalLibraryBinding>, String> {
    let file_path = x_file_data_dir().join("library-binding.json");
    if !file_path.is_file() {
        return Ok(None);
    }
    let stored: StoredLibraryBinding = read_json_file(&file_path)?;
    let root_dir = stored.root_dir.unwrap_or_default();
    let updated_at = stored.updated_at.unwrap_or_else(iso_now);
    let initialized = !root_dir.trim().is_empty();
    Ok(Some(LocalLibraryBinding {
        library_id: stored.library_id.unwrap_or_else(|| "default".to_string()),
        root_dir,
        enabled: stored.enabled.unwrap_or(true),
        mirror_root: stored.mirror_root,
        allowed_extensions: stored.allowed_extensions.unwrap_or_default(),
        included_hidden_paths: stored.included_hidden_paths.unwrap_or_default(),
        folder_open_behavior: stored
            .folder_open_behavior
            .unwrap_or_else(|| "double_click".to_string()),
        config_relative_path: stored
            .config_relative_path
            .unwrap_or_else(|| ".ai-index/doc-semantic-index.config.json".to_string()),
        export_mode: stored.export_mode.unwrap_or_else(|| "v2".to_string()),
        initialized,
        initialized_at: stored.initialized_at.or_else(|| {
            if initialized {
                Some(updated_at.clone())
            } else {
                None
            }
        }),
        updated_at,
    }))
}

fn read_resource_boundary_manifest(
    resource_dir: &std::path::Path,
) -> Result<Option<ResourceBoundaryManifest>, String> {
    let path = resource_dir.join("x-file-resource-boundary.json");
    if !path.is_file() {
        return Ok(None);
    }
    read_json_file::<ResourceBoundaryManifest>(&path).map(Some)
}

fn read_local_library_config() -> Result<LocalLibraryConfig, String> {
    let binding = read_local_library_binding()?;
    let default_extensions = default_allowed_extensions();
    Ok(LocalLibraryConfig {
        binding: binding.clone(),
        enabled: binding.as_ref().map(|item| item.enabled).unwrap_or(false),
        mirror_root: binding.as_ref().and_then(|item| item.mirror_root.clone()),
        allowed_extensions: binding.as_ref().map(|item| {
            if item.allowed_extensions.is_empty() {
                default_extensions.clone()
            } else {
                item.allowed_extensions.clone()
            }
        }).unwrap_or_else(|| default_extensions.clone()),
        included_hidden_paths: binding.as_ref().map(|item| item.included_hidden_paths.clone()).unwrap_or_default(),
        folder_open_behavior: binding.as_ref().map(|item| item.folder_open_behavior.clone()).unwrap_or_else(|| "double_click".to_string()),
        config_relative_path: binding.as_ref().map(|item| item.config_relative_path.clone()).unwrap_or_else(|| ".ai-index/doc-semantic-index.config.json".to_string()),
        can_write: binding.is_some(),
    })
}

fn save_local_library_config(request: NativeSaveLibraryConfigRequest) -> Result<LocalLibraryConfig, String> {
    let mut binding = read_local_library_binding()?.ok_or_else(|| "请先绑定文档库根目录".to_string())?;
    binding.enabled = request.enabled.unwrap_or(binding.enabled);
    if let Some(mirror_root) = request.mirror_root {
        binding.mirror_root = normalize_nullable_path(mirror_root, binding.mirror_root);
    }
    if let Some(allowed_extensions) = request.allowed_extensions {
        binding.allowed_extensions = normalize_extensions(allowed_extensions, binding.allowed_extensions);
    }
    if let Some(included_hidden_paths) = request.included_hidden_paths {
        binding.included_hidden_paths = normalize_string_list(included_hidden_paths, binding.included_hidden_paths);
    }
    binding.folder_open_behavior = if request.folder_open_behavior.as_deref() == Some("single_click") {
        "single_click".to_string()
    } else {
        "double_click".to_string()
    };
    binding.updated_at = iso_now();
    write_json_file(&x_file_data_dir().join("library-binding.json"), &binding_to_stored(&binding))?;
    write_library_config_sidecar(&binding)?;
    read_local_library_config()
}

fn browse_local_host_directories(requested_path: Option<String>) -> Result<LocalHostDirectoryBrowseResult, String> {
    let roots = list_local_host_directory_roots();
    let fallback_path = resolve_default_local_host_browse_path(&roots);
    let current_path = resolve_local_host_browse_path(requested_path.as_deref(), &fallback_path)?;
    Ok(LocalHostDirectoryBrowseResult {
        current_path: current_path.clone(),
        parent_path: resolve_local_host_parent_path(&current_path),
        roots,
        items: list_local_child_directories(&current_path)?,
    })
}

fn read_local_library_favorites(
    binding: &LocalLibraryBinding,
) -> Result<Vec<LocalLibraryFavoriteRecord>, String> {
    let file_path = x_file_data_dir().join("library-favorites.json");
    if !file_path.is_file() {
        return Ok(vec![]);
    }
    let payload: HashMap<String, Value> = read_json_file(&file_path)?;
    let store_key = format!("{}:{}", binding.library_id, binding.root_dir);
    let Some(record) = payload.get(&store_key) else {
        return Ok(vec![]);
    };
    let favorites = record
        .get("favorites")
        .cloned()
        .unwrap_or_else(|| Value::Array(vec![]));
    serde_json::from_value::<Vec<LocalLibraryFavoriteRecord>>(favorites)
        .map_err(|error| format!("解析 favorites 失败：{error}"))
}

fn read_local_runtime_status(root_dir: &str) -> Result<Option<LocalLibraryIndexStatus>, String> {
    let file_path = PathBuf::from(root_dir)
        .join(".ai-index")
        .join("runtime-status.json");
    let Some(payload) = read_optional_json_file::<PersistedRuntimeStatus>(&file_path)? else {
        return Ok(None);
    };
    Ok(Some(LocalLibraryIndexStatus {
        state: payload.state,
        dirty_reasons: vec![],
        last_requested_at: payload.last_requested_at,
        last_started_at: payload.last_started_at,
        last_completed_at: payload.last_completed_at,
        last_failed_at: payload.last_failed_at,
        next_allowed_at: payload.next_allowed_at,
        running_task_id: None,
        running_stage: payload.running_stage,
        error_summary: payload.error_summary,
        worker_health: None,
        progress: payload.progress,
        runtime_index_state: read_local_runtime_index_state(root_dir)?,
    }))
}

fn read_local_runtime_index_state(root_dir: &str) -> Result<Option<LocalRuntimeIndexState>, String> {
    let file_path = PathBuf::from(root_dir)
        .join(".ai-index")
        .join("runtime")
        .join("index-state.json");
    let Some(payload) = read_optional_json_file::<PersistedRuntimeIndexState>(&file_path)? else {
        return Ok(None);
    };
    Ok(Some(LocalRuntimeIndexState {
        generated_at: payload
            .generated_at
            .unwrap_or_else(|| chrono::Utc::now().to_rfc3339()),
        failed_documents: payload.failed_documents.unwrap_or_default(),
        skipped_documents: payload.skipped_documents.unwrap_or_default(),
        parser_skips: payload.parser_skips.unwrap_or_default(),
    }))
}

fn read_meta_documents(
    export_dir: &PathBuf,
    manifest: &ManifestFile,
) -> Result<Vec<MetaDocument>, String> {
    let mut documents = Vec::new();
    for shard in manifest.meta_shards.as_ref().into_iter().flatten() {
        let shard_file: Option<MetaShardFile> = read_optional_json_file(&export_dir.join(&shard.path))?;
        if let Some(shard_file) = shard_file {
            documents.extend(shard_file.documents.unwrap_or_default());
        }
    }
    Ok(documents)
}

fn read_local_tags(
    export_dir: &PathBuf,
    manifest: &ManifestFile,
    tag_counts: &HashMap<String, usize>,
) -> Result<Vec<LocalLibraryTagNode>, String> {
    let taxonomy_path = export_dir.join(
        manifest
            .entries
            .as_ref()
            .and_then(|entries| entries.taxonomy.clone())
            .unwrap_or_else(|| "taxonomy.json".to_string()),
    );
    let taxonomy: Option<TaxonomyFile> = read_optional_json_file(&taxonomy_path)?;
    Ok(taxonomy
        .and_then(|item| item.nodes)
        .unwrap_or_default()
        .into_iter()
        .map(|node| LocalLibraryTagNode {
            document_count: *tag_counts.get(&node.path).unwrap_or(&0),
            path: node.path,
            name: node.name,
            root_type: node.root_type,
            parent_path: node.parent_path,
            depth: node.depth,
        })
        .collect())
}

fn read_local_folders(
    export_dir: &PathBuf,
    manifest: &ManifestFile,
) -> Result<Vec<LocalLibraryFolderNode>, String> {
    let bootstrap_path = export_dir.join(
        manifest
            .entries
            .as_ref()
            .and_then(|entries| entries.bootstrap.clone())
            .unwrap_or_else(|| "bootstrap.json".to_string()),
    );
    let bootstrap: Option<BootstrapFile> = read_optional_json_file(&bootstrap_path)?;
    Ok(bootstrap
        .and_then(|item| item.folders)
        .unwrap_or_default()
        .into_iter()
        .map(|folder| LocalLibraryFolderNode {
            path: folder.path,
            name: folder.name,
            parent_path: folder.parent_path,
            direct_document_count: folder.direct_document_count,
            document_count: folder.document_count,
            created_at: None,
            updated_at: None,
        })
        .collect())
}

fn write_runtime_export_catalog_snapshot(
    root_dir: &str,
    snapshot: &LocalRuntimeExportCatalogSnapshot,
) -> Result<String, String> {
    let path = resolve_runtime_export_catalog_snapshot_path(root_dir);
    write_json_file(&path, snapshot)?;
    Ok(path.to_string_lossy().to_string())
}

fn resolve_runtime_export_catalog_snapshot_path(root_dir: &str) -> PathBuf {
    PathBuf::from(root_dir)
        .join(".ai-index")
        .join("runtime")
        .join("export-catalog-snapshot.json")
}

fn merge_runtime_status(
    runtime_status: Option<LocalLibraryIndexStatus>,
    generated_at: Option<String>,
    exported_at: Option<String>,
    document_count: usize,
    watcher: &NativeLibraryWatcherStatus,
) -> LocalLibraryIndexStatus {
    let fallback_completed_at = exported_at.or(generated_at);
    let mut status = runtime_status.unwrap_or_else(|| empty_local_status("fresh", fallback_completed_at.clone()));
    if status.last_completed_at.is_none() {
        status.last_completed_at = fallback_completed_at;
    }
    if status.progress.is_none() && document_count > 0 {
        status.progress = Some(LocalLibraryIndexProgress {
            scanned_count: document_count,
            indexed_count: 0,
            skipped_count: 0,
            failed_count: 0,
            unchanged_count: document_count,
            total_count: Some(document_count),
            max_concurrency: None,
        });
    }
    if watcher.active && status.state == "fresh" {
        status.state = "fresh".to_string();
    }
    status
}

fn empty_local_status(state: &str, last_completed_at: Option<String>) -> LocalLibraryIndexStatus {
    LocalLibraryIndexStatus {
        state: state.to_string(),
        dirty_reasons: vec![],
        last_requested_at: None,
        last_started_at: None,
        last_completed_at,
        last_failed_at: None,
        next_allowed_at: None,
        running_task_id: None,
        running_stage: None,
        error_summary: None,
        worker_health: None,
        progress: None,
        runtime_index_state: None,
    }
}

fn count_document_tag_facets(
    documents: &[LocalLibraryDocumentRecord],
) -> HashMap<String, usize> {
    let mut counts = HashMap::new();
    for document in documents {
        let mut expanded_paths = HashSet::new();
        for tag_path in document.tags.iter().chain(document.derived_tags.iter()) {
            for ancestor_path in expand_local_tag_ancestor_paths(tag_path) {
                expanded_paths.insert(ancestor_path);
            }
        }
        for path in expanded_paths {
            *counts.entry(path).or_insert(0) += 1;
        }
    }
    counts
}

fn document_matches_favorite(
    tags: &[String],
    derived_tags: &[String],
    document_dir: &str,
    favorite: &LocalLibraryFavoriteRecord,
) -> bool {
    if favorite.kind == "folder" {
        let folder_path = normalize_folder_path(&favorite.path);
        return folder_path == "." || document_dir == folder_path || document_dir.starts_with(&format!("{folder_path}/"));
    }
    let required_tags = if favorite.kind == "tag_filter" {
        favorite
            .tag_paths
            .clone()
            .unwrap_or_else(|| favorite.path.split('|').map(ToString::to_string).collect())
    } else {
        vec![favorite.path.clone()]
    };
    let document_tags: HashSet<String> = tags.iter().chain(derived_tags.iter()).cloned().collect();
    required_tags
        .into_iter()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .all(|value| document_tags.contains(&value))
}

fn normalize_folder_path(value: &str) -> String {
    let normalized = value
        .trim()
        .replace('\\', "/")
        .trim_matches('/')
        .to_string();
    if normalized.is_empty() {
        ".".to_string()
    } else {
        normalized
    }
}

fn normalize_document_path(value: &str) -> String {
    value.trim().replace('\\', "/").trim_start_matches('/').to_string()
}

fn file_name_from_path(path: &str) -> String {
    PathBuf::from(path)
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string())
}

fn system_time_to_rfc3339(value: SystemTime) -> String {
    chrono::DateTime::<chrono::Utc>::from(value).to_rfc3339()
}

fn detect_local_preview_kind(extension: &str) -> String {
    match extension {
        "md" | "markdown" | "mdown" | "mkd" => "markdown".to_string(),
        "html" | "htm" => "html".to_string(),
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "bmp" | "ico" => "image".to_string(),
        "pdf" => "pdf".to_string(),
        "docx" | "xlsx" | "pptx" => "office".to_string(),
        _ => "text".to_string(),
    }
}

fn build_local_preview_capabilities(
    can_edit: bool,
    can_refresh: bool,
    can_resize: bool,
    can_zoom: bool,
    can_paginate: bool,
) -> LocalLibraryPreviewCapabilities {
    LocalLibraryPreviewCapabilities {
        can_edit,
        can_refresh,
        can_resize,
        can_zoom,
        can_paginate,
    }
}

fn unsupported_preview(
    library_id: &str,
    path: &str,
    size: u64,
    updated_at: Option<String>,
    reason: &str,
) -> LocalLibraryPreview {
    LocalLibraryPreview {
        library_id: library_id.to_string(),
        path: path.to_string(),
        supported: false,
        kind: "unsupported".to_string(),
        reason: Some(reason.to_string()),
        content: None,
        version: None,
        size,
        updated_at,
        preview_path: None,
        preview_url: None,
        only_office: None,
        capabilities: build_local_preview_capabilities(false, false, false, false, false),
    }
}

fn read_local_onlyoffice_setting_record() -> Result<Option<OnlyOfficeSettingRecord>, String> {
    let file_path = x_file_data_dir().join("onlyoffice-settings.json");
    read_optional_json_file::<OnlyOfficeSettingRecord>(&file_path)
}

fn read_local_onlyoffice_settings_view() -> Result<Value, String> {
    let record = read_local_onlyoffice_setting_record()?;
    Ok(json!({
        "enabled": record.as_ref().map(|item| item.enabled).unwrap_or(false),
        "serverUrl": record.as_ref().and_then(|item| item.server_url.clone()),
        "publicBaseUrl": record.as_ref().and_then(|item| item.public_base_url.clone()),
        "callbackBaseUrl": record.as_ref().and_then(|item| item.callback_base_url.clone()),
        "userDisplayName": record.as_ref().and_then(|item| item.user_display_name.clone()),
        "userAvatarUrl": record.as_ref().and_then(|item| item.user_avatar_url.clone()),
        "jwtSecretConfigured": record.as_ref().and_then(|item| item.jwt_secret.as_ref()).map(|value| !value.trim().is_empty()).unwrap_or(false),
        "updatedAt": record.and_then(|item| item.updated_at),
    }))
}

fn save_local_onlyoffice_settings(input: NativeOnlyOfficeSettingsInput) -> Result<Value, String> {
    let current = read_local_onlyoffice_setting_record()?.unwrap_or(OnlyOfficeSettingRecord {
        enabled: false,
        server_url: None,
        public_base_url: None,
        callback_base_url: None,
        user_display_name: None,
        user_avatar_url: None,
        jwt_secret: None,
        created_at: None,
        updated_at: None,
    });
    let next_enabled = input.enabled.unwrap_or(current.enabled);
    let next_server_url = normalize_optional_absolute_url(input.server_url.as_deref())?;
    let next_public_base_url = normalize_optional_absolute_url(input.public_base_url.as_deref())?;
    let next_callback_base_url = normalize_optional_absolute_url(input.callback_base_url.as_deref())?;
    let next_user_display_name = normalize_optional_text(input.user_display_name.as_deref());
    let next_user_avatar_url = normalize_optional_absolute_url(input.user_avatar_url.as_deref())?;
    let mut next_jwt_secret = current.jwt_secret.clone();
    if input.clear_jwt_secret.unwrap_or(false) {
        next_jwt_secret = None;
    }
    if let Some(jwt_secret) = input.jwt_secret.as_deref() {
        next_jwt_secret = normalize_optional_text(Some(jwt_secret));
    }
    if next_enabled && next_server_url.is_none() {
        return Err("启用 ONLYOFFICE 前必须填写服务地址".to_string());
    }
    if next_enabled && next_public_base_url.is_none() {
        return Err("启用 ONLYOFFICE 前必须填写 X-File 对外地址".to_string());
    }
    let now = iso_now();
    let record = OnlyOfficeSettingRecord {
        enabled: next_enabled,
        server_url: next_server_url,
        public_base_url: next_public_base_url,
        callback_base_url: next_callback_base_url,
        user_display_name: next_user_display_name,
        user_avatar_url: next_user_avatar_url,
        jwt_secret: next_jwt_secret,
        created_at: current.created_at.or_else(|| Some(now.clone())),
        updated_at: Some(now),
    };
    write_json_file(&x_file_data_dir().join("onlyoffice-settings.json"), &record)?;
    read_local_onlyoffice_settings_view()
}

fn read_local_onlyoffice_status_view() -> Result<Value, String> {
    let checked_at = iso_now();
    let Some(record) = read_local_onlyoffice_setting_record()? else {
        return Ok(json!({
            "state": "disabled",
            "summary": "当前未启用 ONLYOFFICE 集成。",
            "checkedAt": checked_at,
            "checks": [{
                "key": "enabled",
                "label": "启用状态",
                "status": "skip",
                "detail": "开关未打开，X-File 会继续保持当前默认预览行为。"
            }]
        }));
    };
    if !record.enabled {
        return Ok(json!({
            "state": "disabled",
            "summary": "当前未启用 ONLYOFFICE 集成。",
            "checkedAt": checked_at,
            "checks": [{
                "key": "enabled",
                "label": "启用状态",
                "status": "skip",
                "detail": "开关未打开，X-File 会继续保持当前默认预览行为。"
            }]
        }));
    }
    let mut checks = vec![];
    let server_url = record.server_url.clone().filter(|value| !value.trim().is_empty());
    let public_base_url = record.public_base_url.clone().filter(|value| !value.trim().is_empty());
    let callback_base_url = record.callback_base_url.clone().or(public_base_url.clone());
    checks.push(json!({
        "key": "serverUrl",
        "label": "ONLYOFFICE 服务地址",
        "status": if server_url.is_some() { "pass" } else { "fail" },
        "detail": server_url.clone().unwrap_or_else(|| "缺少 ONLYOFFICE 服务地址。".to_string())
    }));
    checks.push(json!({
        "key": "publicBaseUrl",
        "label": "X-File 对外地址",
        "status": if public_base_url.is_some() { "pass" } else { "fail" },
        "detail": public_base_url.clone().unwrap_or_else(|| "缺少 X-File 对外地址，ONLYOFFICE 将无法拉取文件。".to_string())
    }));
    if server_url.is_none() || public_base_url.is_none() {
        return Ok(json!({
            "state": "misconfigured",
            "summary": "配置还没填完整，先把服务地址和 X-File 对外地址补齐。",
            "checkedAt": checked_at,
            "checks": checks,
        }));
    }
    let server_url = server_url.unwrap();
    let public_base_url = public_base_url.unwrap();
    let health_check_url = format!("{}healthcheck", ensure_trailing_slash(&server_url));
    let api_script_url = format!("{}web-apps/apps/api/documents/api.js", ensure_trailing_slash(&server_url));
    let health_probe = probe_text_endpoint(&health_check_url);
    let script_probe = probe_text_endpoint(&api_script_url);
    checks.push(json!({
        "key": "healthcheck",
        "label": "ONLYOFFICE healthcheck",
        "status": if health_probe.0 { "pass" } else { "fail" },
        "detail": health_probe.1,
    }));
    checks.push(json!({
        "key": "apiScript",
        "label": "ONLYOFFICE api.js",
        "status": if script_probe.0 { "pass" } else { "fail" },
        "detail": script_probe.1,
    }));
    let Some(callback_base_url) = callback_base_url else {
        return Ok(json!({
            "state": "misconfigured",
            "summary": "回调地址还没配好，ONLYOFFICE 不能正常保存。",
            "checkedAt": checked_at,
            "checks": checks,
        }));
    };
    let loopback_risk = detect_loopback_mismatch(&server_url, &callback_base_url);
    checks.push(json!({
        "key": "callbackReachability",
        "label": "回调地址可达性",
        "status": if loopback_risk.is_some() { "warn" } else { "pass" },
        "detail": loopback_risk.unwrap_or_else(|| format!("当前回调基地址为 {}", callback_base_url)),
    }));
    if !health_probe.0 || !script_probe.0 {
        return Ok(json!({
            "state": "error",
            "summary": "ONLYOFFICE 服务现在不可用，先确认服务是否真的启动。",
            "checkedAt": checked_at,
            "checks": checks,
        }));
    }
    if is_loopback_url(&public_base_url) {
        return Ok(json!({
            "state": "warning",
            "summary": "ONLYOFFICE 服务可访问，但当前回调地址看起来只适合同机环境。",
            "checkedAt": checked_at,
            "checks": checks,
        }));
    }
    Ok(json!({
        "state": "ready",
        "summary": "ONLYOFFICE 服务和回调地址都已通过基础检查，可以启用 Office 预览。",
        "checkedAt": checked_at,
        "checks": checks,
    }))
}

fn read_local_onlyoffice_setting() -> Result<Option<LocalOnlyOfficeResolvedSetting>, String> {
    let Some(record) = read_local_onlyoffice_setting_record()? else {
        return Ok(None);
    };
    Ok(Some(LocalOnlyOfficeResolvedSetting {
        enabled: record.enabled,
        server_url: record.server_url,
        public_base_url: record.public_base_url.clone(),
        effective_callback_base_url: record.callback_base_url.or(record.public_base_url),
        user_display_name: record.user_display_name,
        user_avatar_url: record.user_avatar_url,
        jwt_secret: record.jwt_secret,
    }))
}

fn normalize_onlyoffice_display_mode(value: Option<&str>) -> &'static str {
    match value.unwrap_or_default().trim() {
        "reading" => "reading",
        _ => "default",
    }
}

fn build_library_api_preview_path(token: &str, relative_path: &str) -> String {
    let encoded_path = relative_path
        .replace('\\', "/")
        .split('/')
        .map(urlencoding::encode)
        .collect::<Vec<_>>()
        .join("/");
    format!(
        "/api/library/preview-file/{}/{}",
        urlencoding::encode(token),
        encoded_path
    )
}

fn create_signed_preview_token(library_id: &str) -> Result<String, String> {
    let payload = LocalPreviewTokenPayload {
        library_id: library_id.to_string(),
        expires_at: chrono::Utc::now().timestamp_millis() + LIBRARY_PREVIEW_TOKEN_TTL_MS,
    };
    let encoded_payload = URL_SAFE_NO_PAD
        .encode(serde_json::to_vec(&payload).map_err(|error| format!("序列化 preview token 失败：{error}"))?);
    let signature = sign_hmac(&encoded_payload, &read_signing_secret());
    Ok(format!("{encoded_payload}.{signature}"))
}

fn create_onlyoffice_callback_token(payload: &OnlyOfficeCallbackTokenPayload) -> Result<String, String> {
    let encoded_payload = URL_SAFE_NO_PAD
        .encode(serde_json::to_vec(payload).map_err(|error| format!("序列化 callback token 失败：{error}"))?);
    let signature = sign_hmac(&encoded_payload, &read_signing_secret());
    Ok(format!("{encoded_payload}.{signature}"))
}

fn verify_signed_preview_token(token: &str) -> Result<LocalPreviewTokenPayload, String> {
    let (encoded_payload, signature) = token
        .split_once('.')
        .ok_or_else(|| "预览链接无效，请重新打开文件预览".to_string())?;
    let expected_signature = sign_hmac(encoded_payload, &read_signing_secret());
    if signature != expected_signature {
        return Err("预览链接无效，请重新打开文件预览".to_string());
    }
    let payload_bytes = URL_SAFE_NO_PAD
        .decode(encoded_payload.as_bytes())
        .map_err(|_| "预览链接无效，请重新打开文件预览".to_string())?;
    let payload = serde_json::from_slice::<LocalPreviewTokenPayload>(&payload_bytes)
        .map_err(|_| "预览链接无效，请重新打开文件预览".to_string())?;
    if payload.library_id.trim().is_empty() || payload.expires_at <= chrono::Utc::now().timestamp_millis() {
        return Err("预览链接已经过期，请重新打开文件预览".to_string());
    }
    Ok(payload)
}

fn verify_onlyoffice_callback_token(token: &str) -> Result<OnlyOfficeCallbackTokenPayload, String> {
    let (encoded_payload, signature) = token
        .split_once('.')
        .ok_or_else(|| "ONLYOFFICE 回调 token 无效或已过期。".to_string())?;
    let expected_signature = sign_hmac(encoded_payload, &read_signing_secret());
    if signature != expected_signature {
        return Err("ONLYOFFICE 回调 token 无效或已过期。".to_string());
    }
    let payload_bytes = URL_SAFE_NO_PAD
        .decode(encoded_payload.as_bytes())
        .map_err(|_| "ONLYOFFICE 回调 token 无效或已过期。".to_string())?;
    let payload = serde_json::from_slice::<OnlyOfficeCallbackTokenPayload>(&payload_bytes)
        .map_err(|_| "ONLYOFFICE 回调 token 无效或已过期。".to_string())?;
    if payload.library_id.trim().is_empty()
        || payload.file_path.trim().is_empty()
        || payload.expires_at <= chrono::Utc::now().timestamp_millis()
    {
        return Err("ONLYOFFICE 回调 token 无效或已过期。".to_string());
    }
    Ok(payload)
}

fn sign_hmac(payload: &str, secret: &str) -> String {
    let mut mac = Hmac::<sha2::Sha256>::new_from_slice(secret.as_bytes())
        .expect("HMAC 初始化失败");
    mac.update(payload.as_bytes());
    URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
}

fn read_signing_secret() -> String {
    env::var("X_FILE_SIGNING_SECRET")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_SIGNING_SECRET.to_string())
}

fn build_onlyoffice_preview_payload(
    setting: &LocalOnlyOfficeResolvedSetting,
    library_id: &str,
    file_path: &str,
    version: Option<&str>,
    document_url: String,
    display_mode: &str,
    editable: bool,
) -> Result<Value, String> {
    let callback_token = create_onlyoffice_callback_token(&OnlyOfficeCallbackTokenPayload {
        library_id: library_id.to_string(),
        file_path: file_path.to_string(),
        expires_at: chrono::Utc::now().timestamp_millis() + CALLBACK_TOKEN_TTL_MS,
    })?;
    let callback_base = setting
        .effective_callback_base_url
        .as_ref()
        .or(setting.public_base_url.as_ref())
        .ok_or_else(|| "ONLYOFFICE callbackBaseUrl/publicBaseUrl 未配置".to_string())?;
    let callback_url = format!(
        "{}/api/office/onlyoffice/callback/{}",
        callback_base.trim_end_matches('/'),
        urlencoding::encode(&callback_token)
    );
    let extension = PathBuf::from(file_path)
        .extension()
        .map(|value| value.to_string_lossy().to_lowercase())
        .unwrap_or_else(|| "docx".to_string());
    let document_type = match extension.as_str() {
        "xlsx" => "cell",
        "pptx" => "slide",
        _ => "word",
    };
    let title = file_name_from_path(file_path);
    let key_source = format!("x-file:{file_path}:{}", version.unwrap_or("unknown"));
    let key = sha256_hex(key_source.as_bytes())
        .chars()
        .take(48)
        .collect::<String>();
    let reading_mode = display_mode == "reading";
    let base_config = json!({
        "documentType": document_type,
        "type": if reading_mode { "embedded" } else { "desktop" },
        "width": "100%",
        "height": "100%",
        "document": {
            "fileType": extension,
            "key": key,
            "title": title,
            "url": document_url,
            "permissions": {
                "edit": if reading_mode { false } else { editable },
                "review": if reading_mode { false } else { editable },
                "comment": if reading_mode { false } else { editable },
                "download": true,
                "print": true,
                "copy": true
            }
        },
        "editorConfig": {
            "callbackUrl": callback_url,
            "mode": if reading_mode || !editable { "view" } else { "edit" },
            "lang": "zh-CN",
            "user": {
                "id": "local",
                "name": setting.user_display_name.clone().unwrap_or_else(|| "X-File".to_string()),
                "image": setting.user_avatar_url
            },
            "coEditing": if reading_mode {
                json!({
                    "mode": "strict",
                    "change": false
                })
            } else {
                Value::Null
            },
            "customization": {
                "autosave": true,
                "forcesave": true,
                "compactToolbar": false,
                "features": {
                    "spellcheck": false
                },
                "anonymous": {
                    "request": false
                }
            }
        }
    });
    let editor_config = if let Some(secret) = setting.jwt_secret.as_deref().filter(|value| !value.trim().is_empty()) {
        let key: Hmac<sha2::Sha256> = Hmac::new_from_slice(secret.as_bytes())
            .map_err(|error| format!("初始化 ONLYOFFICE JWT key 失败：{error}"))?;
        let token = base_config
            .clone()
            .sign_with_key(&key)
            .map_err(|error| format!("签发 ONLYOFFICE JWT 失败：{error}"))?;
        let mut signed_config = base_config;
        if let Some(object) = signed_config.as_object_mut() {
            object.insert("token".to_string(), Value::String(token));
        }
        json!({
            "apiScriptUrl": format!("{}/web-apps/apps/api/documents/api.js", setting.server_url.as_deref().unwrap_or_default().trim_end_matches('/')),
            "editorMode": if reading_mode || !editable { "view" } else { "edit" },
            "documentUrl": document_url,
            "callbackUrl": callback_url,
            "editorConfig": signed_config,
        })
    } else {
        json!({
            "apiScriptUrl": format!("{}/web-apps/apps/api/documents/api.js", setting.server_url.as_deref().unwrap_or_default().trim_end_matches('/')),
            "editorMode": if reading_mode || !editable { "view" } else { "edit" },
            "documentUrl": document_url,
            "callbackUrl": callback_url,
            "editorConfig": base_config,
        })
    };
    Ok(editor_config)
}

fn ensure_local_onlyoffice_bridge(
    state: &tauri::State<'_, Mutex<DesktopState>>,
    _root_dir: &str,
) -> Result<String, String> {
    {
        let desktop_state = lock_desktop_state(state);
        let bridge = &desktop_state.onlyoffice_bridge;
        if bridge.started {
            if let Some(base_url) = bridge.bridge_base_url.clone() {
                return Ok(base_url);
            }
        }
    }

    let listener = TcpListener::bind(ONLYOFFICE_BRIDGE_BIND)
        .map_err(|error| format!("启动 ONLYOFFICE 本地 bridge 失败：{error}"))?;
    let server = Server::from_listener(listener, None)
        .map_err(|error| format!("创建 ONLYOFFICE bridge server 失败：{error}"))?;
    let shared_server = Arc::new(server);
    let worker_server = Arc::clone(&shared_server);
    thread::spawn(move || {
        for request in worker_server.incoming_requests() {
            handle_onlyoffice_bridge_request(request);
        }
    });

    let bridge_base_url = format!("http://{ONLYOFFICE_BRIDGE_BIND}");
    let mut desktop_state = lock_desktop_state(state);
    desktop_state.onlyoffice_bridge.bridge_base_url = Some(bridge_base_url.clone());
    desktop_state.onlyoffice_bridge.last_error = None;
    desktop_state.onlyoffice_bridge.started = true;
    Ok(bridge_base_url)
}

fn build_native_onlyoffice_preview(
    state: &tauri::State<'_, Mutex<DesktopState>>,
    request: NativeOnlyOfficePreviewRequest,
) -> Result<LocalLibraryPreview, String> {
    let binding = read_local_library_binding()?
        .ok_or_else(|| "当前未绑定文档库".to_string())?;
    let setting = read_local_onlyoffice_setting()?.ok_or_else(|| {
        "当前还没有启用 ONLYOFFICE 集成，请先在设置里完成 ONLYOFFICE 配置。".to_string()
    })?;
    if !setting.enabled {
        return Err("当前还没有启用 ONLYOFFICE 集成。".to_string());
    }
    if setting.server_url.as_deref().unwrap_or("").trim().is_empty() {
        return Err("ONLYOFFICE 服务地址未配置。".to_string());
    }

    let relative_path = normalize_document_path(&request.path);
    let absolute_path = PathBuf::from(&binding.root_dir).join(&relative_path);
    let metadata = fs::metadata(&absolute_path)
        .map_err(|error| format!("读取 Office 文件失败：{error}"))?;
    if !metadata.is_file() {
        return Err("Office 预览目标不是文件".to_string());
    }

    let extension = absolute_path
        .extension()
        .map(|value| value.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if !matches!(extension.as_str(), "docx" | "xlsx" | "pptx") {
        return Err("当前只支持 openxml Office 文件走 native onlyoffice bridge".to_string());
    }

    let updated_at = metadata.modified().ok().map(system_time_to_rfc3339);
    let version = updated_at
        .as_ref()
        .map(|value| format!("{}:{}", value, metadata.len()));
    let bridge_base_url = ensure_local_onlyoffice_bridge(state, &binding.root_dir)?;
    let preview_path = build_library_api_preview_path(
        &create_signed_preview_token(&binding.library_id)?,
        &relative_path,
    );
    let document_url = format!("{bridge_base_url}{preview_path}");
    let display_mode = normalize_onlyoffice_display_mode(request.display_mode.as_deref());
    let only_office = build_onlyoffice_preview_payload(
        &setting,
        &binding.library_id,
        &relative_path,
        version.as_deref(),
        document_url,
        display_mode,
        request.editable.unwrap_or(true),
    )?;

    println!(
        "[x-file native] onlyoffice.preview.resolve transport=native path={} callbackUrl={}",
        relative_path,
        only_office
            .get("callbackUrl")
            .and_then(Value::as_str)
            .unwrap_or("<unknown>")
    );

    Ok(LocalLibraryPreview {
        library_id: binding.library_id,
        path: relative_path,
        supported: true,
        kind: "office".to_string(),
        reason: None,
        content: None,
        version,
        size: metadata.len(),
        updated_at,
        preview_path: None,
        preview_url: only_office
            .get("documentUrl")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        only_office: Some(only_office),
        capabilities: build_local_preview_capabilities(false, true, true, false, false),
    })
}

fn handle_onlyoffice_bridge_request(mut request: tiny_http::Request) {
    let method = request.method().clone();
    let url = request.url().to_string();
    let response = match route_onlyoffice_bridge_request(&mut request, &method, &url) {
        Ok(response) => response,
        Err((status, message)) => text_response(status, &message),
    };
    let _ = request.respond(response);
}

fn route_onlyoffice_bridge_request(
    request: &mut tiny_http::Request,
    method: &Method,
    url: &str,
) -> Result<Response<std::io::Cursor<Vec<u8>>>, (StatusCode, String)> {
    if *method == Method::Get && url.starts_with("/api/library/preview-file/") {
        return handle_onlyoffice_preview_file_request(url);
    }
    if *method == Method::Post && url.starts_with("/api/office/onlyoffice/callback/") {
        return handle_onlyoffice_callback_request(request, url);
    }
    Err((StatusCode(404), format!("ONLYOFFICE bridge route not found: {url}")))
}

fn handle_onlyoffice_preview_file_request(
    url: &str,
) -> Result<Response<std::io::Cursor<Vec<u8>>>, (StatusCode, String)> {
    let path = url.split('?').next().unwrap_or(url);
    let suffix = path
        .strip_prefix("/api/library/preview-file/")
        .ok_or_else(|| (StatusCode(404), "预览链接不存在".to_string()))?;
    let (encoded_token, encoded_relative_path) = suffix
        .split_once('/')
        .ok_or_else(|| (StatusCode(401), "预览链接无效，请重新打开文件预览".to_string()))?;
    let token = urlencoding::decode(encoded_token)
        .map_err(|_| (StatusCode(401), "预览链接无效，请重新打开文件预览".to_string()))?
        .into_owned();
    let payload = verify_signed_preview_token(&token)
        .map_err(|message| (StatusCode(401), message))?;
    let relative_path = decode_relative_path(encoded_relative_path)?;
    let binding = read_local_library_binding()
        .map_err(|message| (StatusCode(500), message))?
        .ok_or_else(|| (StatusCode(400), "当前未绑定文档库".to_string()))?;
    if binding.library_id != payload.library_id {
        return Err((StatusCode(401), "预览链接无效，请重新打开文件预览".to_string()));
    }
    let absolute_path = resolve_library_file_path(&binding.root_dir, &relative_path)
        .map_err(|message| (StatusCode(400), message))?;
    let buffer = fs::read(&absolute_path)
        .map_err(|error| (StatusCode(404), format!("读取预览文件失败：{error}")))?;
    let mime_type = from_path(&absolute_path)
        .first_or_octet_stream()
        .essence_str()
        .to_string();
    println!(
        "[x-file native] onlyoffice.preview-file transport=native path={}",
        relative_path
    );
    Ok(binary_response(StatusCode(200), buffer, Some(&mime_type)))
}

fn handle_onlyoffice_callback_request(
    request: &mut tiny_http::Request,
    url: &str,
) -> Result<Response<std::io::Cursor<Vec<u8>>>, (StatusCode, String)> {
    let path = url.split('?').next().unwrap_or(url);
    let encoded_token = path
        .strip_prefix("/api/office/onlyoffice/callback/")
        .ok_or_else(|| (StatusCode(404), "ONLYOFFICE callback route not found".to_string()))?;
    let token = urlencoding::decode(encoded_token)
        .map_err(|_| (StatusCode(401), "ONLYOFFICE 回调 token 无效或已过期。".to_string()))?
        .into_owned();
    let payload = verify_onlyoffice_callback_token(&token)
        .map_err(|message| (StatusCode(401), message))?;
    let mut body = String::new();
    request
        .as_reader()
        .read_to_string(&mut body)
        .map_err(|error| (StatusCode(400), format!("读取 ONLYOFFICE 回调失败：{error}")))?;
    let callback_body: Value = if body.trim().is_empty() {
        json!({})
    } else {
        serde_json::from_str(&body)
            .map_err(|error| (StatusCode(400), format!("解析 ONLYOFFICE 回调失败：{error}")))?
    };
    let status = callback_body.get("status").and_then(Value::as_i64).unwrap_or_default();
    if status != 2 && status != 6 {
        println!(
            "[x-file native] onlyoffice.callback transport=native path={} status={} persisted=false",
            payload.file_path, status
        );
        return Ok(json_response(StatusCode(200), json!({ "error": 0 })));
    }
    let download_url = callback_body
        .get("url")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| (StatusCode(400), "ONLYOFFICE callback 缺少下载地址".to_string()))?;
    let binding = read_local_library_binding()
        .map_err(|message| (StatusCode(500), message))?
        .ok_or_else(|| (StatusCode(400), "当前未绑定文档库".to_string()))?;
    if binding.library_id != payload.library_id {
        return Err((StatusCode(401), "ONLYOFFICE 回调 token 无效或已过期。".to_string()));
    }
    let target_path = resolve_library_file_path(&binding.root_dir, &payload.file_path)
        .map_err(|message| (StatusCode(400), message))?;
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_millis(CALLBACK_DOWNLOAD_TIMEOUT_MS))
        .build()
        .map_err(|error| (StatusCode(500), format!("初始化 ONLYOFFICE callback client 失败：{error}")))?;
    let response = client
        .get(download_url)
        .send()
        .map_err(|error| (StatusCode(502), format!("下载 ONLYOFFICE 回写文件失败：{error}")))?;
    if !response.status().is_success() {
        return Err((
            StatusCode(502),
            format!("下载 ONLYOFFICE 回写文件失败：{}", response.status()),
        ));
    }
    let file_buffer = response
        .bytes()
        .map_err(|error| (StatusCode(502), format!("读取 ONLYOFFICE 回写文件失败：{error}")))?;
    fs::write(&target_path, &file_buffer)
        .map_err(|error| (StatusCode(500), format!("写回 ONLYOFFICE 文件失败：{error}")))?;
    let refresh_result = run_native_library_index_worker_detached(
        None,
        NativeLibraryRefreshRequest {
            reason: Some("onlyoffice_callback".to_string()),
            target_path: Some(payload.file_path.clone()),
            mode: None,
        },
    );
    if let Err(error) = &refresh_result {
        eprintln!("onlyoffice callback refresh failed: {error}");
    }
    println!(
        "[x-file native] onlyoffice.callback transport=native path={} status={} persisted=true",
        payload.file_path, status
    );
    Ok(json_response(StatusCode(200), json!({ "error": 0 })))
}

fn decode_relative_path(value: &str) -> Result<String, (StatusCode, String)> {
    let mut segments = Vec::new();
    for segment in value.split('/') {
        let decoded = urlencoding::decode(segment)
            .map_err(|_| (StatusCode(400), "预览文件路径无效".to_string()))?;
        segments.push(decoded.into_owned());
    }
    Ok(normalize_document_path(&segments.join("/")))
}

fn resolve_library_file_path(root_dir: &str, relative_path: &str) -> Result<PathBuf, String> {
    let root = fs::canonicalize(root_dir)
        .map_err(|error| format!("解析文档库根目录失败：{error}"))?;
    let joined = root.join(normalize_document_path(relative_path));
    let resolved = fs::canonicalize(&joined)
        .map_err(|error| format!("解析文档库文件失败：{error}"))?;
    if !resolved.starts_with(&root) {
        return Err("目标文件不在当前文档库根目录下".to_string());
    }
    if !resolved.is_file() {
        return Err("目标文件不存在".to_string());
    }
    Ok(resolved)
}

fn text_response(
    status: StatusCode,
    message: &str,
) -> Response<std::io::Cursor<Vec<u8>>> {
    binary_response(status, message.as_bytes().to_vec(), Some("text/plain; charset=utf-8"))
}

fn json_response(
    status: StatusCode,
    payload: Value,
) -> Response<std::io::Cursor<Vec<u8>>> {
    let body = serde_json::to_vec(&payload).unwrap_or_else(|_| br#"{"error":1}"#.to_vec());
    binary_response(status, body, Some("application/json; charset=utf-8"))
}

fn binary_response(
    status: StatusCode,
    body: Vec<u8>,
    content_type: Option<&str>,
) -> Response<std::io::Cursor<Vec<u8>>> {
    let mut response = Response::from_data(body).with_status_code(status);
    if let Some(content_type) = content_type {
        if let Ok(header) = Header::from_bytes(&b"Content-Type"[..], content_type.as_bytes()) {
            response = response.with_header(header);
        }
    }
    if let Ok(header) = Header::from_bytes(&b"Cache-Control"[..], &b"no-store"[..]) {
        response = response.with_header(header);
    }
    response
}

fn sha256_hex(buffer: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(buffer);
    format!("{:x}", hasher.finalize())
}

fn read_json_file<T>(path: &PathBuf) -> Result<T, String>
where
    T: for<'de> Deserialize<'de>,
{
    let raw = fs::read_to_string(path)
        .map_err(|error| format!("读取文件失败 {}: {error}", path.display()))?;
    serde_json::from_str::<T>(&raw)
        .map_err(|error| format!("解析 JSON 失败 {}: {error}", path.display()))
}

fn read_optional_json_file<T>(path: &PathBuf) -> Result<Option<T>, String>
where
    T: for<'de> Deserialize<'de>,
{
    if !path.is_file() {
        return Ok(None);
    }
    read_json_file(path).map(Some)
}

fn read_local_plugin_list(resource_dir: Option<&PathBuf>) -> Result<Value, String> {
    let candidates = resolve_bundled_plugin_root_candidates(resource_dir);
    let bundled_root_dir = candidates.iter().find(|candidate| is_usable_bundled_plugin_root_dir(candidate)).cloned();
    let mut records = read_local_plugin_registry_records()?;
    let mut record_map = HashMap::new();
    for record in records.drain(..) {
        record_map.insert(record.plugin_id.clone(), record);
    }
    let mut items: Vec<LocalPluginCatalogItem> = vec![];
    let mut seen = HashSet::new();
    if let Some(root_dir) = bundled_root_dir.as_ref() {
        for entry in fs::read_dir(root_dir).map_err(|error| format!("读取插件目录失败：{error}"))? {
            let entry = entry.map_err(|error| format!("读取插件目录失败：{error}"))?;
            let plugin_dir = entry.path();
            if !plugin_dir.is_dir() {
                continue;
            }
            let manifest_path = plugin_dir.join("manifest.json");
            if !manifest_path.is_file() {
                continue;
            }
            let manifest = read_json_file::<Value>(&manifest_path)?;
            let plugin_id = manifest.get("id").and_then(Value::as_str).unwrap_or(entry.file_name().to_string_lossy().as_ref()).to_string();
            let version = manifest.get("version").and_then(Value::as_str).unwrap_or("0.0.0").to_string();
            let record = record_map.remove(&plugin_id).unwrap_or_else(|| build_default_plugin_registry_record(&plugin_id, &version, &plugin_dir));
            seen.insert(plugin_id.clone());
            items.push(LocalPluginCatalogItem { manifest, registry: record });
        }
    }
    for (plugin_id, record) in record_map {
        if seen.contains(&plugin_id) {
            continue;
        }
        let manifest_path = PathBuf::from(&record.install_dir).join("manifest.json");
        if !manifest_path.is_file() {
            continue;
        }
        let manifest = read_json_file::<Value>(&manifest_path)?;
        items.push(LocalPluginCatalogItem { manifest, registry: record });
    }
    items.sort_by(|left, right| {
        let left_name = left.manifest.get("name").and_then(Value::as_str).unwrap_or(&left.registry.plugin_id);
        let right_name = right.manifest.get("name").and_then(Value::as_str).unwrap_or(&right.registry.plugin_id);
        left_name.cmp(right_name)
    });
    Ok(json!({
        "plugins": items.iter().map(|item| build_local_plugin_list_item(&item.manifest, &item.registry)).collect::<Vec<_>>(),
        "pluginRootDir": x_file_data_dir().join("plugins").to_string_lossy().to_string(),
        "bundledPluginRootDir": bundled_root_dir.as_ref().map(|path| path.to_string_lossy().to_string()),
        "bundledPluginScanCandidates": candidates.iter().map(|path| path.to_string_lossy().to_string()).collect::<Vec<_>>(),
    }))
}

fn set_local_plugin_enabled(
    resource_dir: Option<&PathBuf>,
    plugin_id: &str,
    enabled: bool,
) -> Result<Value, String> {
    let plugin_id = plugin_id.trim();
    if plugin_id.is_empty() {
        return Err("插件 ID 不能为空".to_string());
    }
    let candidates = resolve_bundled_plugin_root_candidates(resource_dir);
    let bundled_root_dir = candidates.iter().find(|candidate| is_usable_bundled_plugin_root_dir(candidate)).cloned();
    let mut records = read_local_plugin_registry_records()?;
    let mut catalog = vec![];
    if let Some(items) = read_local_plugin_list(resource_dir)?.get("plugins").and_then(Value::as_array) {
        catalog = items.clone();
    }
    let current = catalog.into_iter().find(|item| item.get("registry").and_then(|value| value.get("pluginId")).and_then(Value::as_str) == Some(plugin_id))
        .ok_or_else(|| format!("插件未安装：{plugin_id}"))?;
    let manifest = current.get("manifest").cloned().ok_or_else(|| "插件 manifest 缺失".to_string())?;
    let install_dir = current.get("registry").and_then(|value| value.get("installDir")).and_then(Value::as_str)
        .ok_or_else(|| "插件安装目录缺失".to_string())?;
    let version = manifest.get("version").and_then(Value::as_str).unwrap_or("0.0.0");
    let existing = records.iter().find(|item| item.plugin_id == plugin_id).cloned();
    let mut next_record = existing.unwrap_or_else(|| build_default_plugin_registry_record(plugin_id, version, &PathBuf::from(install_dir)));
    next_record.enabled = enabled;
    next_record.updated_at = iso_now();
    if enabled {
        next_record.last_error = None;
    }
    records.retain(|item| item.plugin_id != plugin_id);
    records.push(next_record.clone());
    records.sort_by(|left, right| left.plugin_id.cmp(&right.plugin_id));
    write_local_plugin_registry_records(&records)?;
    Ok(json!({
        "plugin": build_local_plugin_list_item(&manifest, &next_record),
        "pluginRootDir": x_file_data_dir().join("plugins").to_string_lossy().to_string(),
        "bundledPluginRootDir": bundled_root_dir.as_ref().map(|path| path.to_string_lossy().to_string()),
        "bundledPluginScanCandidates": candidates.iter().map(|path| path.to_string_lossy().to_string()).collect::<Vec<_>>(),
    }))
}

fn read_local_http_server_state(state: &mut DesktopState) -> Value {
    let file_path = resolve_local_http_server_state_path();
    let saved = read_optional_json_file::<Value>(&file_path).ok().flatten().unwrap_or_else(|| json!({}));
    let enabled = saved.get("enabled").and_then(Value::as_bool).unwrap_or(true);
    let host = saved.get("host").and_then(Value::as_str).unwrap_or("127.0.0.1");
    let port = saved.get("port").and_then(Value::as_u64).unwrap_or(17321);
    let backend_snapshot = state.backend.snapshot();
    let healthy_http = if enabled {
        probe_local_http_service(host, port as u16)
    } else {
        false
    };
    let backend_running = matches!(backend_snapshot.state, BackendProcessState::Running);
    let running = backend_running || healthy_http;
    let last_error = if running {
        None
    } else {
        saved.get("lastError").and_then(Value::as_str).map(ToString::to_string)
            .or_else(|| backend_snapshot.last_error.clone())
    };
    let lifecycle_state = match (enabled, running, &backend_snapshot.state, last_error.as_ref()) {
        (false, _, _, _) => "disabled",
        (true, true, _, _) => "running",
        (true, false, BackendProcessState::Starting, _) => "starting",
        (true, false, BackendProcessState::Failed, _) => "failed",
        (true, false, _, Some(_)) => "failed",
        (true, false, _, _) => "disabled",
    };
    json!({
        "enabled": enabled,
        "host": host,
        "port": port,
        "running": running,
        "persistent": state.backend_persistent,
        "actualHost": if running { Value::String(host.to_string()) } else { Value::Null },
        "actualPort": if running { json!(port) } else { Value::Null },
        "lifecycleState": lifecycle_state,
        "startedAt": if backend_running {
            backend_snapshot.started_at.map(epoch_millis_to_iso)
        } else {
            None
        },
        "lastError": last_error,
    })
}

fn save_local_http_server_state(
    state: &mut DesktopState,
    request: NativeSaveHttpServerStateRequest,
) -> Result<Value, String> {
    let current = read_local_http_server_state(state);
    let enabled = request.enabled.unwrap_or_else(|| current.get("enabled").and_then(Value::as_bool).unwrap_or(true));
    let port = request.port.unwrap_or_else(|| current.get("port").and_then(Value::as_u64).unwrap_or(17321) as u16);
    let persistent = request
        .persistent
        .unwrap_or_else(|| current.get("persistent").and_then(Value::as_bool).unwrap_or_else(default_backend_persistence));
    let payload = json!({
        "enabled": enabled,
        "host": "127.0.0.1",
        "port": port,
        "persistent": persistent,
        "lifecycleState": current.get("lifecycleState").cloned().unwrap_or_else(|| Value::String("disabled".to_string())),
        "lastError": current.get("lastError").cloned().unwrap_or(Value::Null),
    });
    write_json_file(&resolve_local_http_server_state_path(), &payload)?;
    state.backend_persistent = persistent;
    if enabled {
        if !probe_local_http_service("127.0.0.1", port) {
            let _ = state.backend.stop();
            let _ = state.backend.start();
        }
    } else {
        let _ = state.backend.stop();
    }
    Ok(read_local_http_server_state(state))
}

fn probe_local_http_service(host: &str, port: u16) -> bool {
    let url = format!("http://{}:{}/api/health", host, port);
    let client = match reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_millis(800))
        .build()
    {
        Ok(client) => client,
        Err(_) => return false,
    };
    let response = match client.get(url).send() {
        Ok(response) => response,
        Err(_) => return false,
    };
    if !response.status().is_success() {
        return false;
    }
    let payload = match response.json::<Value>() {
        Ok(payload) => payload,
        Err(_) => return false,
    };
    payload.get("app").and_then(Value::as_str) == Some("X-File")
}

fn default_local_library_binding() -> LocalLibraryBinding {
    LocalLibraryBinding {
        library_id: "default".to_string(),
        root_dir: String::new(),
        enabled: true,
        mirror_root: None,
        allowed_extensions: vec![],
        included_hidden_paths: vec![],
        folder_open_behavior: "double_click".to_string(),
        config_relative_path: ".ai-index/doc-semantic-index.config.json".to_string(),
        export_mode: "v2".to_string(),
        initialized: false,
        initialized_at: None,
        updated_at: iso_now(),
    }
}

fn binding_to_stored(binding: &LocalLibraryBinding) -> StoredLibraryBinding {
    StoredLibraryBinding {
        library_id: Some(binding.library_id.clone()),
        root_dir: Some(binding.root_dir.clone()),
        enabled: Some(binding.enabled),
        mirror_root: binding.mirror_root.clone(),
        allowed_extensions: Some(binding.allowed_extensions.clone()),
        included_hidden_paths: Some(binding.included_hidden_paths.clone()),
        folder_open_behavior: Some(binding.folder_open_behavior.clone()),
        config_relative_path: Some(binding.config_relative_path.clone()),
        export_mode: Some(binding.export_mode.clone()),
        initialized: Some(binding.initialized),
        initialized_at: binding.initialized_at.clone(),
        updated_at: Some(binding.updated_at.clone()),
    }
}

fn write_library_config_sidecar(binding: &LocalLibraryBinding) -> Result<(), String> {
    let relative_path = binding.config_relative_path.replace('\\', "/").trim_start_matches('/').to_string();
    if relative_path.is_empty() || relative_path.split('/').any(|segment| segment == "." || segment == "..") {
        return Err("文档库配置路径无效".to_string());
    }
    let config_path = PathBuf::from(&binding.root_dir).join(relative_path);
    write_json_file(&config_path, &json!({
        "libraryId": binding.library_id,
        "rootDir": binding.root_dir,
        "enabled": binding.enabled,
        "mirrorRoot": binding.mirror_root,
        "allowedExtensions": binding.allowed_extensions,
        "includedHiddenPaths": binding.included_hidden_paths,
        "folderOpenBehavior": binding.folder_open_behavior,
        "updatedAt": binding.updated_at,
    }))
}

fn default_allowed_extensions() -> Vec<String> {
    vec![
        ".md".to_string(),
        ".markdown".to_string(),
        ".txt".to_string(),
        ".csv".to_string(),
        ".pdf".to_string(),
        ".doc".to_string(),
        ".docx".to_string(),
        ".xls".to_string(),
        ".xlsx".to_string(),
        ".ppt".to_string(),
        ".pptx".to_string(),
    ]
}

fn normalize_nullable_path(value: String, fallback: Option<String>) -> Option<String> {
    let normalized = value.trim().to_string();
    if normalized.is_empty() {
        None
    } else {
        Some(normalized)
    }.or(fallback)
}

fn normalize_extensions(value: Vec<String>, fallback: Vec<String>) -> Vec<String> {
    if value.is_empty() {
        return fallback;
    }
    let mut items = Vec::new();
    let mut seen = HashSet::new();
    for raw in value {
        let normalized = raw.trim().to_lowercase();
        if normalized.is_empty() {
            continue;
        }
        let with_dot = if normalized.starts_with('.') { normalized } else { format!(".{normalized}") };
        if seen.insert(with_dot.clone()) {
            items.push(with_dot);
        }
    }
    items
}

fn normalize_string_list(value: Vec<String>, fallback: Vec<String>) -> Vec<String> {
    if value.is_empty() {
        return fallback;
    }
    let mut items = Vec::new();
    let mut seen = HashSet::new();
    for raw in value {
        let normalized = raw.trim().replace('\\', "/");
        if normalized.is_empty() {
            continue;
        }
        if seen.insert(normalized.clone()) {
            items.push(normalized);
        }
    }
    items
}

fn list_local_child_directories(current_path: &str) -> Result<Vec<LocalHostDirectoryOption>, String> {
    let mut items = fs::read_dir(current_path)
        .map_err(|error| format!("读取目录失败：{error}"))?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let path = entry.path();
            let metadata = entry.metadata().ok()?;
            if !metadata.is_dir() || metadata.file_type().is_symlink() {
                return None;
            }
            Some(LocalHostDirectoryOption {
                path: path.to_string_lossy().to_string(),
                name: entry.file_name().to_string_lossy().to_string(),
            })
        })
        .collect::<Vec<_>>();
    items.sort_by(|left, right| left.name.cmp(&right.name));
    items.truncate(200);
    Ok(items)
}

fn list_local_host_directory_roots() -> Vec<LocalHostDirectoryOption> {
    let mut roots = Vec::new();
    let home_path = dirs_home_dir();
    if is_readable_directory(&home_path) {
        roots.push(LocalHostDirectoryOption {
            path: home_path.to_string_lossy().to_string(),
            name: "主目录".to_string(),
        });
    }
    if cfg!(target_os = "windows") {
        for letter in "ABCDEFGHIJKLMNOPQRSTUVWXYZ".chars() {
            let root = PathBuf::from(format!("{letter}:\\"));
            if is_readable_directory(&root) {
                roots.push(LocalHostDirectoryOption {
                    path: root.to_string_lossy().to_string(),
                    name: root.to_string_lossy().to_string(),
                });
            }
        }
    } else {
        let root = PathBuf::from("/");
        if is_readable_directory(&root) {
            roots.push(LocalHostDirectoryOption {
                path: "/".to_string(),
                name: "/".to_string(),
            });
        }
    }
    let mut deduped = Vec::new();
    let mut seen = HashSet::new();
    for option in roots {
        if seen.insert(option.path.clone()) {
            deduped.push(option);
        }
    }
    deduped
}

fn resolve_default_local_host_browse_path(roots: &[LocalHostDirectoryOption]) -> String {
    let home = dirs_home_dir();
    if is_readable_directory(&home) {
        return home.to_string_lossy().to_string();
    }
    roots.first().map(|item| item.path.clone()).unwrap_or_else(|| default_library_root_dir())
}

fn resolve_local_host_browse_path(requested_path: Option<&str>, fallback_path: &str) -> Result<String, String> {
    let Some(requested_path) = requested_path.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(fallback_path.to_string());
    };
    let resolved = PathBuf::from(requested_path);
    if is_readable_directory(&resolved) {
        return Ok(resolved.to_string_lossy().to_string());
    }
    if resolved == PathBuf::from(default_library_root_dir()) {
        return Ok(fallback_path.to_string());
    }
    Err("路径不是可读取目录".to_string())
}

fn resolve_local_host_parent_path(current_path: &str) -> Option<String> {
    let path = PathBuf::from(current_path);
    let parent = path.parent()?;
    let parent_string = parent.to_string_lossy().to_string();
    if parent_string == current_path {
        None
    } else {
        Some(parent_string)
    }
}

fn is_readable_directory(path: &PathBuf) -> bool {
    fs::metadata(path).map(|meta| meta.is_dir()).unwrap_or(false)
}

fn x_file_data_dir() -> PathBuf {
    if let Ok(path) = env::var("X_FILE_DATA_DIR") {
        let trimmed = path.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    dirs_home_dir().join(".x-file")
}

fn resolve_local_http_server_state_path() -> PathBuf {
    if let Ok(path) = env::var("X_FILE_SERVER_STATE_PATH") {
        let trimmed = path.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    x_file_data_dir().join("http-server-state.json")
}

fn build_default_plugin_registry_record(plugin_id: &str, version: &str, install_dir: &PathBuf) -> LocalPluginRegistryRecord {
    let now = iso_now();
    LocalPluginRegistryRecord {
        plugin_id: plugin_id.to_string(),
        version: version.to_string(),
        install_dir: install_dir.to_string_lossy().to_string(),
        enabled: true,
        installed_at: now.clone(),
        updated_at: now,
        last_health_status: "unknown".to_string(),
        last_error: None,
        runtime_install_dir: None,
        granted_capabilities: vec![],
    }
}

fn read_local_plugin_registry_records() -> Result<Vec<LocalPluginRegistryRecord>, String> {
    let file_path = x_file_data_dir().join("plugin-registry.json");
    let Some(payload) = read_optional_json_file::<LocalPluginRegistryFile>(&file_path)? else {
        return Ok(vec![]);
    };
    Ok(payload.records)
}

fn write_local_plugin_registry_records(records: &[LocalPluginRegistryRecord]) -> Result<(), String> {
    write_json_file(
        &x_file_data_dir().join("plugin-registry.json"),
        &LocalPluginRegistryFile {
            records: records.to_vec(),
        },
    )
}

fn resolve_bundled_plugin_root_candidates(resource_dir: Option<&PathBuf>) -> Vec<PathBuf> {
    let mut candidates = vec![];
    if let Ok(value) = env::var("X_FILE_BUNDLED_PLUGIN_DIR") {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            candidates.push(PathBuf::from(trimmed));
        }
    }
    if let Some(resource_dir) = resource_dir {
        candidates.push(resource_dir.join("x-file-plugins"));
    }
    candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources").join("x-file-plugins"));
    candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../plugins"));
    let mut deduped = vec![];
    let mut seen = HashSet::new();
    for candidate in candidates {
        let key = candidate.to_string_lossy().to_string();
        if seen.insert(key) {
            deduped.push(candidate);
        }
    }
    deduped
}

fn is_usable_bundled_plugin_root_dir(candidate: &PathBuf) -> bool {
    if !candidate.is_dir() {
        return false;
    }
    fs::read_dir(candidate).ok().map(|entries| {
        entries.filter_map(Result::ok).any(|entry| entry.path().join("manifest.json").is_file())
    }).unwrap_or(false)
}

fn build_local_plugin_list_item(manifest: &Value, registry: &LocalPluginRegistryRecord) -> Value {
    json!({
        "manifest": manifest,
        "registry": registry,
        "health": build_local_plugin_health(manifest, registry.enabled),
    })
}

fn build_local_plugin_health(manifest: &Value, enabled: bool) -> Value {
    let plugin_id = manifest.get("id").and_then(Value::as_str).unwrap_or("unknown");
    if !enabled {
        return json!({
            "pluginId": plugin_id,
            "enabled": false,
            "status": "unknown",
            "detail": "插件已禁用",
            "commandReady": Value::Null,
            "authReady": Value::Null,
        });
    }
    let provider = manifest.get("provider");
    if provider.is_none() {
        return json!({
            "pluginId": plugin_id,
            "enabled": true,
            "status": "healthy",
            "detail": format!("{} 已启用", manifest.get("name").and_then(Value::as_str).unwrap_or(plugin_id)),
            "commandReady": Value::Null,
            "authReady": Value::Null,
        });
    }
    let provider = provider.unwrap();
    let provider_id = provider.get("providerId").and_then(Value::as_str).unwrap_or(plugin_id);
    let display_name = provider.get("displayName").and_then(Value::as_str).unwrap_or(plugin_id);
    let command = provider.get("command").and_then(Value::as_str);
    let auth = provider.get("auth");
    let auth_strategy = auth.and_then(|value| value.get("strategy")).and_then(Value::as_str).unwrap_or("file_exists");
    let auth_path = auth.and_then(|value| value.get("path")).and_then(Value::as_str);
    if auth_strategy == "custom" {
        let command_ready = detect_local_command(command);
        return json!({
            "pluginId": plugin_id,
            "enabled": true,
            "status": if command_ready { "degraded" } else { "failed" },
            "detail": format!("{} 需要插件自定义登录态探测，当前版本暂不支持自动校验", display_name),
            "commandReady": command_ready,
            "authReady": false,
        });
    }
    let command_ready = detect_local_command(command);
    if !command_ready {
        return json!({
            "pluginId": plugin_id,
            "enabled": true,
            "status": "failed",
            "detail": format!("未检测到 {} 命令，请先安装 {} CLI", command.unwrap_or(display_name), display_name),
            "commandReady": false,
            "authReady": false,
        });
    }
    let auth_ready = detect_local_auth(provider_id, auth_strategy, auth_path);
    if !auth_ready {
        return json!({
            "pluginId": plugin_id,
            "enabled": true,
            "status": "degraded",
            "detail": format!("未检测到 {} 登录态，请先在终端登录", display_name),
            "commandReady": true,
            "authReady": false,
        });
    }
    json!({
        "pluginId": plugin_id,
        "enabled": true,
        "status": "healthy",
        "detail": Value::Null,
        "commandReady": true,
        "authReady": true,
    })
}

fn detect_local_command(command: Option<&str>) -> bool {
    let Some(command) = command.map(str::trim).filter(|value| !value.is_empty()) else {
        return false;
    };
    let checker = if cfg!(target_os = "windows") { "where" } else { "which" };
    Command::new(checker)
        .arg(command)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn detect_local_auth(provider_id: &str, strategy: &str, explicit_path: Option<&str>) -> bool {
    let source_path = explicit_path
        .and_then(|value| {
            let trimmed = value.trim();
            if trimmed.is_empty() { None } else { Some(trimmed.to_string()) }
        })
        .unwrap_or_else(|| match provider_id {
            "codex" => "~/.codex/auth.json".to_string(),
            "claude-code" => "~/.claude".to_string(),
            _ => String::new(),
        });
    if source_path.is_empty() {
        return false;
    }
    let resolved = expand_home_dir(&source_path);
    match strategy {
        "directory_exists" => resolved.is_dir(),
        _ => resolved.is_file() || resolved.exists(),
    }
}

fn expand_home_dir(value: &str) -> PathBuf {
    if let Some(stripped) = value.strip_prefix("~/") {
        return dirs_home_dir().join(stripped);
    }
    PathBuf::from(value)
}

fn normalize_optional_text(value: Option<&str>) -> Option<String> {
    value.map(str::trim).filter(|value| !value.is_empty()).map(ToString::to_string)
}

fn normalize_optional_absolute_url(value: Option<&str>) -> Result<Option<String>, String> {
    let Some(value) = normalize_optional_text(value) else {
        return Ok(None);
    };
    let parsed = reqwest::Url::parse(&value).map_err(|error| format!("URL 无效：{error}"))?;
    Ok(Some(parsed.to_string().trim_end_matches('/').to_string()))
}

fn ensure_trailing_slash(value: &str) -> String {
    if value.ends_with('/') {
        value.to_string()
    } else {
        format!("{value}/")
    }
}

fn probe_text_endpoint(url: &str) -> (bool, String) {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_millis(5000))
        .build();
    let Ok(client) = client else {
        return (false, "初始化 ONLYOFFICE 探测客户端失败".to_string());
    };
    match client.get(url).send() {
        Ok(response) => {
            let status = response.status();
            if status.is_success() {
                (true, url.to_string())
            } else {
                (false, format!("{} 返回 {}", url, status))
            }
        }
        Err(error) => (false, format!("{} 不可达：{}", url, error)),
    }
}

fn detect_loopback_mismatch(server_url: &str, callback_base_url: &str) -> Option<String> {
    let server = reqwest::Url::parse(server_url).ok()?;
    let callback = reqwest::Url::parse(callback_base_url).ok()?;
    if is_loopback_url(server_url) && is_loopback_url(callback_base_url) {
        return Some("当前 ONLYOFFICE 与回调地址都指向 loopback，仅适合同机环境。".to_string());
    }
    if is_loopback_url(server_url) != is_loopback_url(callback_base_url) {
        return Some(format!(
            "ONLYOFFICE 地址 {} 与回调地址 {} 的可达域不一致，请确认是否同属可互访网络。",
            server,
            callback,
        ));
    }
    None
}

fn is_loopback_url(value: &str) -> bool {
    reqwest::Url::parse(value)
        .ok()
        .and_then(|url| url.host_str().map(|host| host == "127.0.0.1" || host == "localhost" || host == "::1"))
        .unwrap_or(false)
}

fn write_json_file<T>(path: &PathBuf, value: &T) -> Result<(), String>
where
    T: Serialize,
{
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建目录失败 {}: {error}", parent.display()))?;
    }
    let mut buffer = serde_json::to_vec_pretty(value).map_err(|error| format!("序列化 JSON 失败 {}: {error}", path.display()))?;
    buffer.push(b'\n');
    fs::write(path, buffer).map_err(|error| format!("写入文件失败 {}: {error}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_backend_extra_env_会注入状态文件路径和已保存端口() {
        let temp_dir = env::temp_dir().join(format!("x-file-backend-env-{}", epoch_millis()));
        fs::create_dir_all(&temp_dir).expect("创建临时目录失败");
        let state_path = temp_dir.join("http-server-state.json");
        write_json_file(
            &state_path,
            &json!({
                "enabled": true,
                "host": "127.0.0.1",
                "port": 17322,
                "persistent": true
            }),
        )
        .expect("写入状态文件失败");

        let envs = resolve_backend_extra_env(&temp_dir, &state_path);
        let env_map: HashMap<String, String> = envs.into_iter().collect();

        assert_eq!(
            env_map.get("X_FILE_SERVER_STATE_PATH"),
            Some(&state_path.to_string_lossy().to_string())
        );
        assert_eq!(env_map.get("X_FILE_SERVER_PORT"), Some(&"17322".to_string()));
        assert_eq!(env_map.get("X_FILE_SERVER_HOST"), Some(&"127.0.0.1".to_string()));
    }

    #[test]
    fn probe_local_http_service_对未监听端口返回_false() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("申请临时端口失败");
        let port = listener
            .local_addr()
            .expect("读取临时端口失败")
            .port();
        drop(listener);

        assert_eq!(probe_local_http_service("127.0.0.1", port), false);
    }
}

fn epoch_millis_to_iso(value: u64) -> String {
    chrono::DateTime::<chrono::Utc>::from(UNIX_EPOCH + std::time::Duration::from_millis(value)).to_rfc3339()
}

fn default_library_root_dir() -> String {
    dirs_home_dir().join("X-File").to_string_lossy().to_string()
}

fn dirs_home_dir() -> PathBuf {
    std::env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
}

fn iso_now() -> String {
    chrono::Utc::now().to_rfc3339()
}

#[cfg(target_os = "macos")]
unsafe fn configure_macos_live_resize_view(view: &NSView) {
    view.setPostsFrameChangedNotifications(true);
    view.setLayerContentsRedrawPolicy(NSViewLayerContentsRedrawPolicy::DuringViewResize);
    view.setNeedsDisplay(true);
}

#[cfg(target_os = "macos")]
fn configure_macos_window_live_resize(window: &WebviewWindow) -> Result<(), String> {
    let window_for_resize = window.clone();

    window
        .run_on_main_thread(move || unsafe {
            let Ok(ns_window_ptr) = window_for_resize.ns_window() else {
                return;
            };
            let Ok(ns_view_ptr) = window_for_resize.ns_view() else {
                return;
            };
            let ns_window: &NSWindow = &*ns_window_ptr.cast();
            let content_view: &NSView = &*ns_view_ptr.cast();

            // 透明 overlay 窗口在 live resize 期间最怕露底，
            // 这里沿用父仓库策略，强制保留上一帧内容直到 webview 补齐。
            ns_window.setPreservesContentDuringLiveResize(true);
            configure_macos_live_resize_view(content_view);

            let _ = window_for_resize.with_webview(|webview| {
                let webview_view: &NSView = &*webview.inner().cast();
                configure_macos_live_resize_view(webview_view);
            });
        })
        .map_err(|error| error.to_string())
}

#[cfg(target_os = "macos")]
fn configure_macos_window_chrome(app: &tauri::App) -> tauri::Result<()> {
    use tauri::TitleBarStyle;

    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };

    window.set_title_bar_style(TitleBarStyle::Overlay)?;
    let native_window = window.clone();
    window.run_on_main_thread(move || unsafe {
        let Ok(ns_window_ptr) = native_window.ns_window() else {
            return;
        };
        let ns_window: &NSWindow = &*ns_window_ptr.cast();
        let clear_color = NSColor::clearColor();

        // 自定义标题栏和左右玻璃侧栏都依赖透明窗口通道，
        // 把整窗打回不透明会直接把 overlay titlebar 变成假壳。
        ns_window.setBackgroundColor(Some(&clear_color));
        ns_window.setOpaque(false);
    })?;
    configure_macos_window_live_resize(&window).map_err(std::io::Error::other)?;
    Ok(())
}


#[cfg(target_os = "macos")]
fn configure_macos_native_glass_sidebars(app: &tauri::App) -> tauri::Result<()> {
    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        return Ok(());
    };
    let native_sidebar_state = app.state::<MacosNativeSidebarState>().inner().clone();
    let initial_layout = NativeSidebarLayoutPayload {
        left_width: MACOS_NATIVE_LEFT_SIDEBAR_WIDTH,
        right_width: MACOS_NATIVE_RIGHT_SIDEBAR_WIDTH,
        left_collapsed: false,
        right_collapsed: false,
        prefers_dark_appearance: false,
        is_resizing: false,
    };
    let sidebar_state = native_sidebar_state.upsert_layout(window.label(), &initial_layout);
    schedule_macos_native_sidebar_layout(
        &window,
        window.label().to_string(),
        native_sidebar_state,
        sidebar_state,
    )
    .map_err(std::io::Error::other)?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn sanitize_native_sidebar_width(width: f64) -> f64 {
    if width.is_finite() && width > 0.0 {
        width
    } else {
        0.0
    }
}

#[cfg(target_os = "macos")]
fn resolve_macos_native_sidebar_rendered_width(
    previous_rendered_width: f64,
    requested_width: f64,
    collapsed: bool,
    is_resizing: bool,
) -> f64 {
    if collapsed {
        return 0.0;
    }

    if is_resizing {
        previous_rendered_width.max(requested_width)
    } else {
        requested_width
    }
}

#[cfg(target_os = "macos")]
unsafe fn apply_macos_native_sidebar_layout(
    window: &WebviewWindow,
    window_label: &str,
    native_sidebar_state: &MacosNativeSidebarState,
    sidebar_state: &MacosNativeSidebarWindowState,
) {
    let Ok(ns_window_ptr) = window.ns_window() else {
        return;
    };
    let ns_window: &NSWindow = &*ns_window_ptr.cast();
    let Some(content_view) = ns_window.contentView() else {
        return;
    };
    let content_frame = content_view.frame();
    let content_width = content_frame.size.width.max(0.0);
    let content_height = content_frame.size.height.max(0.0);
    let sidebar_appearance =
        resolve_macos_native_sidebar_appearance(sidebar_state.layout.prefers_dark_appearance);

    let mut left_view_ptr = ensure_macos_native_sidebar_view(
        &content_view,
        sidebar_state.left_view_ptr,
        sidebar_appearance.as_deref(),
    );
    let mut right_view_ptr = ensure_macos_native_sidebar_view(
        &content_view,
        sidebar_state.right_view_ptr,
        sidebar_appearance.as_deref(),
    );

    let left_visible = !sidebar_state.layout.left_collapsed
        && sidebar_state.rendered_left_width > MACOS_NATIVE_SIDEBAR_MIN_VISIBLE_WIDTH;
    let right_visible = !sidebar_state.layout.right_collapsed
        && sidebar_state.rendered_right_width > MACOS_NATIVE_SIDEBAR_MIN_VISIBLE_WIDTH;
    let left_width = sidebar_state.rendered_left_width.min(content_width).max(0.0);
    let right_width = sidebar_state.rendered_right_width.min(content_width).max(0.0);
    let right_effect_width = if right_visible {
        (right_width + MACOS_NATIVE_RIGHT_SIDEBAR_OVERSCAN_WIDTH)
            .min(content_width)
            .max(0.0)
    } else {
        0.0
    };
    let right_origin_x = (content_width - right_effect_width).max(0.0);

    apply_macos_native_sidebar_frame(
        left_view_ptr,
        NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(left_width, content_height)),
        left_visible,
        MACOS_NATIVE_LEFT_SIDEBAR_AUTOREZING_MASK,
    );
    apply_macos_native_sidebar_frame(
        right_view_ptr,
        NSRect::new(
            NSPoint::new(right_origin_x, 0.0),
            NSSize::new(right_effect_width, content_height),
        ),
        right_visible,
        MACOS_NATIVE_RIGHT_SIDEBAR_AUTOREZING_MASK,
    );

    if left_view_ptr.is_none() {
        left_view_ptr = ensure_macos_native_sidebar_view(
            &content_view,
            None,
            sidebar_appearance.as_deref(),
        );
    }
    if right_view_ptr.is_none() {
        right_view_ptr = ensure_macos_native_sidebar_view(
            &content_view,
            None,
            sidebar_appearance.as_deref(),
        );
    }

    native_sidebar_state.update_view_pointers(window_label, left_view_ptr, right_view_ptr);
}

#[cfg(target_os = "macos")]
fn sync_macos_webview_frame(window: &WebviewWindow) -> Result<(), String> {
    let window_for_resize = window.clone();

    window
        .run_on_main_thread(move || unsafe {
            let Ok(ns_view_ptr) = window_for_resize.ns_view() else {
                return;
            };
            let content_view: &NSView = &*ns_view_ptr.cast();
            let content_bounds = content_view.bounds();

            let _ = window_for_resize.with_webview(move |webview| {
                let webview_view: &NSView = &*webview.inner().cast();
                webview_view.setFrame(content_bounds);
                webview_view.setNeedsDisplay(true);
                webview_view.displayIfNeeded();
            });
        })
        .map_err(|error| error.to_string())
}

#[cfg(target_os = "macos")]
fn schedule_macos_native_sidebar_layout(
    window: &WebviewWindow,
    window_label: String,
    native_sidebar_state: MacosNativeSidebarState,
    sidebar_state: MacosNativeSidebarWindowState,
) -> Result<(), String> {
    let sync_window = window.clone();

    window
        .run_on_main_thread(move || unsafe {
            apply_macos_native_sidebar_layout(
                &sync_window,
                &window_label,
                &native_sidebar_state,
                &sidebar_state,
            );
        })
        .map_err(|error| error.to_string())
}

#[cfg(target_os = "macos")]
fn sync_cached_macos_native_sidebar_layout(
    window: &WebviewWindow,
    native_sidebar_state: &MacosNativeSidebarState,
) -> Result<(), String> {
    let window_label = window.label().to_string();
    let Some(sidebar_state) = native_sidebar_state.get_window_state(&window_label) else {
        return Ok(());
    };

    schedule_macos_native_sidebar_layout(
        window,
        window_label,
        native_sidebar_state.clone(),
        sidebar_state,
    )
}

#[cfg(target_os = "macos")]
unsafe fn ensure_macos_native_sidebar_view(
    content_view: &NSView,
    existing_ptr: Option<usize>,
    appearance: Option<&NSAppearance>,
) -> Option<usize> {
    if let Some(ptr) = existing_ptr {
        let view = &*(ptr as *const NSVisualEffectView);
        view.setAppearance(appearance);

        if let Some(superview) = view.superview() {
            if std::ptr::eq(&*superview, content_view) {
                return Some(ptr);
            }
        }

        view.removeFromSuperviewWithoutNeedingDisplay();
    }

    let mtm = MainThreadMarker::new().expect("创建 macOS 原生侧栏必须在主线程执行");
    let effect_view = NSVisualEffectView::initWithFrame(
        mtm.alloc(),
        NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(0.0, 0.0)),
    );
    effect_view.setMaterial(NSVisualEffectMaterial::Sidebar);
    effect_view.setBlendingMode(NSVisualEffectBlendingMode::WithinWindow);
    effect_view.setState(NSVisualEffectState::FollowsWindowActiveState);
    effect_view.setAppearance(appearance);
    effect_view.setAutoresizingMask(MACOS_NATIVE_LEFT_SIDEBAR_AUTOREZING_MASK);
    effect_view.setLayerContentsRedrawPolicy(NSViewLayerContentsRedrawPolicy::DuringViewResize);
    effect_view.setHidden(true);
    content_view.addSubview_positioned_relativeTo(&effect_view, NSWindowOrderingMode::Below, None);
    Some((&*effect_view) as *const NSVisualEffectView as usize)
}

#[cfg(target_os = "macos")]
fn resolve_macos_native_sidebar_appearance(
    prefers_dark_appearance: bool,
) -> Option<objc2::rc::Retained<NSAppearance>> {
    let appearance_name = unsafe {
        if prefers_dark_appearance {
            NSAppearanceNameVibrantDark
        } else {
            NSAppearanceNameVibrantLight
        }
    };

    NSAppearance::appearanceNamed(appearance_name)
}

#[cfg(target_os = "macos")]
unsafe fn apply_macos_native_sidebar_frame(
    view_ptr: Option<usize>,
    frame: NSRect,
    visible: bool,
    autoresizing_mask: NSAutoresizingMaskOptions,
) {
    let Some(view_ptr) = view_ptr else {
        return;
    };
    let view = &*(view_ptr as *const NSVisualEffectView);
    view.setAutoresizingMask(autoresizing_mask);
    view.setFrame(frame);
    view.setNeedsDisplay(true);
    view.setHidden(!visible);
}

#[cfg(target_os = "macos")]
fn attach_macos_native_sidebar_handlers(
    window: WebviewWindow,
    native_sidebar_state: MacosNativeSidebarState,
) {
    let window_for_events = window.clone();
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::Resized(_)) {
            let _ = sync_cached_macos_native_sidebar_layout(&window_for_events, &native_sidebar_state);
            let _ = sync_macos_webview_frame(&window_for_events);
        }
    });
}

fn should_autostart_backend() -> bool {
    env::var("X_FILE_BACKEND_AUTOSTART")
        .map(|value| value != "0" && value.to_lowercase() != "false")
        .unwrap_or(false)
}

fn load_initial_backend_persistence() -> bool {
    let file_path = resolve_local_http_server_state_path();
    let saved = read_optional_json_file::<Value>(&file_path)
        .ok()
        .flatten();

    saved
        .as_ref()
        .and_then(|payload| payload.get("persistent"))
        .and_then(Value::as_bool)
        .unwrap_or_else(default_backend_persistence)
}

fn default_backend_persistence() -> bool {
    cfg!(target_os = "macos")
}

#[tauri::command]
fn sync_native_sidebar_layout(
    window: WebviewWindow,
    native_sidebar_state: State<'_, MacosNativeSidebarState>,
    layout: NativeSidebarLayoutPayload,
) -> Result<(), String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window;
        let _ = native_sidebar_state;
        let _ = layout;
        Ok(())
    }

    #[cfg(target_os = "macos")]
    {
        let window_label = window.label().to_string();
        let native_sidebar_state = native_sidebar_state.inner().clone();
        let sidebar_state = native_sidebar_state.upsert_layout(&window_label, &layout);

        schedule_macos_native_sidebar_layout(
            &window,
            window_label,
            native_sidebar_state,
            sidebar_state,
        )
    }
}

#[tauri::command]
async fn check_for_update(
    app: AppHandle,
    channel: String,
) -> Result<updater::DesktopReleaseState, String> {
    updater::check_for_update(&app, &channel).await
}

#[tauri::command]
fn get_runtime_info(app: AppHandle) -> updater::DesktopRuntimeInfo {
    updater::get_runtime_info(&app)
}

#[tauri::command]
async fn download_update(
    app: AppHandle,
    channel: String,
    state: State<'_, updater::DownloadedDesktopUpdateState>,
) -> Result<updater::UpdateDownloadResult, String> {
    Ok(updater::download_update(&app, state.inner(), &channel).await)
}

#[tauri::command]
async fn install_update(
    app: AppHandle,
    channel: String,
    state: State<'_, updater::DownloadedDesktopUpdateState>,
) -> Result<updater::UpdateInstallResult, String> {
    Ok(updater::install_update(&app, state.inner(), &channel).await)
}

#[tauri::command]
fn get_release_channel(app: AppHandle) -> String {
    updater::read_release_channel(&app)
}

#[tauri::command]
fn set_release_channel(app: AppHandle, channel: String) -> Result<(), String> {
    updater::write_release_channel(&app, &channel)
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    updater::open_external(&url)
}

pub fn run_library_worker_cli_from_args(args: &[String]) -> i32 {
    match try_run_library_worker_cli_from_args(args) {
        Ok(output) => {
            println!("{output}");
            0
        }
        Err(error) => {
            eprintln!("{error}");
            1
        }
    }
}

fn try_run_library_worker_cli_from_args(args: &[String]) -> Result<String, String> {
    let mode = args
        .get(2)
        .map(String::as_str)
        .ok_or_else(|| "library worker CLI 缺少 mode 参数".to_string())?;
    let raw_payload = args
        .get(3)
        .map(String::as_str)
        .ok_or_else(|| "library worker CLI 缺少 payload 参数".to_string())?;
    let payload: NativeLibraryWorkerCliPayload = serde_json::from_str(raw_payload)
        .map_err(|error| format!("library worker CLI payload 无法解析：{error}"))?;
    let reason = payload
        .reason
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("desktop_native_worker_cli")
        .to_string();
    let target_path = payload
        .target_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string);

    let result = match mode {
        "parse-file" => {
            let file_path = payload
                .file_path
                .clone()
                .or_else(|| payload.target_path.clone())
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| payload.root_dir.clone());
            let extension = payload
                .extension
                .clone()
                .filter(|value| !value.trim().is_empty())
                .or_else(|| {
                    payload
                        .allowed_extensions
                        .as_ref()
                        .and_then(|items| items.first().cloned())
                })
                .or_else(|| {
                    Some(file_path.as_str())
                        .and_then(|value| std::path::Path::new(value).extension().and_then(|ext| ext.to_str()))
                        .map(|ext| format!(".{ext}"))
                })
                .unwrap_or_default();
            run_native_parser(NativeParserRequest {
                file_path,
                extension,
            })
        }
        "index-only" => {
            let allowed_extensions = payload.allowed_extensions.unwrap_or_default();
            let included_hidden_paths = payload.included_hidden_paths.unwrap_or_default();
            run_native_index_worker(NativeIndexRequest {
                root_dir: payload.root_dir,
                allowed_extensions,
                included_hidden_paths,
                config_relative_path: ".ai-index/doc-semantic-index.config.json".to_string(),
                reason,
                target_path,
            })
        }
        "export-only" => {
            let dirty_scope = payload
                .dirty_scope
                .ok_or_else(|| "library worker CLI export-only 缺少 dirtyScope".to_string())?;
            run_native_export_worker(NativeExportRequest {
                root_dir: payload.root_dir,
                reason,
                target_path,
                dirty_scope,
            })
        }
        "search-only" => {
            run_native_search_worker(NativeSearchRequest {
                root_dir: payload.root_dir,
                reason,
                target_path,
                dirty_scope: payload.dirty_scope,
            })
        }
        other => Err(format!("library worker CLI 不支持的 mode：{other}")),
    }?;

    serde_json::to_string(&result)
        .map_err(|error| format!("library worker CLI 输出序列化失败：{error}"))
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Mutex::new(DesktopState::new()))
        .manage(MacosNativeSidebarState::default())
        .manage(updater::DownloadedDesktopUpdateState::default())
        .setup(|app| {
            setup_tray(app)?;
            configure_backend_process(app);
            if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
                if let Some(geometry) = read_persisted_main_window_geometry() {
                    apply_main_window_geometry(&window, geometry);
                    update_main_window_geometry_state(app.handle(), geometry);
                } else {
                    remember_main_window_geometry_from_webview(&window);
                }
            }
            #[cfg(target_os = "macos")]
            {
                configure_macos_window_chrome(app)?;
                configure_macos_native_glass_sidebars(app)?;
                if let Some(window) = app.get_webview_window("main") {
                    let native_sidebar_state = app.state::<MacosNativeSidebarState>().inner().clone();
                    attach_macos_native_sidebar_handlers(window, native_sidebar_state);
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            describe_backend_policy,
            set_backend_persistence,
            start_managed_backend,
            stop_managed_backend,
            desktop_shell_status,
            get_native_library_engine_state,
            sync_native_sidebar_layout,
            start_native_library_watcher,
            stop_native_library_watcher,
            native_request_library_refresh,
            native_get_library_binding,
            native_save_library_binding,
            native_get_library_config,
            native_save_library_config,
            native_browse_host_directories,
            native_get_library_snapshot,
            native_list_library_tag_details,
            native_get_library_tag_detail,
            native_create_library_tag,
            native_update_library_tag,
            native_delete_library_tag,
            native_get_document_tag_details,
            native_save_document_tags,
            native_get_folder_tag_details,
            native_save_folder_tags,
            native_request_library_tag_recompute,
            native_get_library_tag_recompute_task,
            native_list_library_documents,
            native_list_library_files,
            native_get_library_preview,
            native_build_onlyoffice_preview,
            native_fetch_library_health,
            native_get_onlyoffice_settings,
            native_save_onlyoffice_settings,
            native_get_onlyoffice_status,
            native_list_plugins,
            native_enable_plugin,
            native_disable_plugin,
            native_get_http_server_state,
            native_save_http_server_state,
            http_service_hint,
            open_path,
            reveal_path_in_file_manager,
            show_library_context_menu,
            get_runtime_info,
            check_for_update,
            download_update,
            install_update,
            get_release_channel,
            set_release_channel,
            open_external_url
        ])
        .on_menu_event(handle_menu_event)
        .on_window_event(|window, event| {
            if window.label() == MAIN_WINDOW_LABEL {
                match event {
                    WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
                        persist_main_window_geometry_from_window(window);
                    }
                    WindowEvent::CloseRequested { .. } => {
                        persist_main_window_geometry_from_window(window);
                    }
                    _ => {}
                }
            }

            if let WindowEvent::CloseRequested { api, .. } = event {
                let desktop_state = window.state::<Mutex<DesktopState>>();
                let Some(state) = desktop_state.try_lock().ok() else {
                    return;
                };

                if state.backend_persistent && !state.is_quitting {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("启动 X-File 桌面壳失败");
}
