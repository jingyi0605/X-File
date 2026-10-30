mod native_core;
mod agent_tools;
mod native_export;
mod native_index;
mod office_converter;
mod preview_capabilities;
mod updater;

pub use agent_tools::cli::run_agent_cli_from_args;

use base64::Engine as _;
use native_core::scheduler::{lock_root, RootScheduler};
use native_core::task_center;
use native_core::state_store::priority_hints_path;
use native_core::tag_core::{
    count_local_tags, create_native_library_tag, delete_native_library_tag,
    expand_local_tag_ancestor_paths, get_native_document_tag_details,
    get_native_folder_tag_details, get_native_library_tag_detail,
    get_native_library_tag_recompute_task, list_native_library_tag_details,
    read_local_library_tags_store, request_native_library_tag_recompute,
    save_native_document_tags, save_native_folder_tags,
    update_native_library_tag, NativeFolderTagDetailsRequest, NativeLibraryTagIdRequest,
    NativeSaveDocumentTagsRequest, NativeSaveFolderTagsRequest,
    NativeSaveLibraryTagDefinitionRequest,
    TagAssignmentScope,
};
use native_export::{run_native_export_worker, NativeExportRequest};
use native_index::{is_native_library_path_visible, run_native_index_worker, NativeIndexRequest};
use notify::{Config as NotifyConfig, Event, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::env;
use std::fs;
use std::net::Ipv4Addr;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::menu::{Menu, MenuBuilder, MenuEvent, MenuItemBuilder, SubmenuBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow, Window, WindowEvent};

#[cfg(target_os = "macos")]
use {
    objc2::MainThreadMarker,
    objc2_app_kit::{
        NSAppearance, NSAppearanceCustomization, NSAppearanceNameVibrantDark,
        NSAppearanceNameVibrantLight, NSAutoresizingMaskOptions, NSColor, NSView,
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

#[cfg(target_os = "macos")]
const MACOS_NATIVE_LEFT_SIDEBAR_WIDTH: f64 = 272.0;

#[cfg(target_os = "macos")]
const MACOS_NATIVE_RIGHT_SIDEBAR_WIDTH: f64 = 340.0;

#[cfg(target_os = "macos")]
const MACOS_NATIVE_SIDEBAR_MIN_VISIBLE_WIDTH: f64 = 1.0;

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
    initialized: bool,
    handlers_attached: bool,
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

    fn mark_initialized(&self, window_label: &str) {
        let mut guard = self.windows.lock().expect("macOS 原生侧栏状态锁被污染");
        let entry = guard.entry(window_label.to_string()).or_default();
        entry.initialized = true;
    }

    fn mark_handlers_attached(&self, window_label: &str) {
        let mut guard = self.windows.lock().expect("macOS 原生侧栏状态锁被污染");
        let entry = guard.entry(window_label.to_string()).or_default();
        entry.handlers_attached = true;
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
        let args = raw_args
            .map(parse_command_args)
            .unwrap_or_else(default_backend_args);

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
            .envs(resolve_backend_extra_env(&self.server_state_path))
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

fn resolve_backend_extra_env(server_state_path: &PathBuf) -> Vec<(String, String)> {
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
    initialization_window_restore_geometry: Option<MainWindowGeometry>,
    initialization_window_restore_maximized: bool,
    initialization_window_active: bool,
    backend: BackendProcessManager,
    native_context_menu_selection: Option<String>,
    native_library: NativeLibraryState,
}

impl DesktopState {
    fn new() -> Self {
        let backend_persistent = load_initial_backend_persistence();
        Self {
            backend_persistent,
            is_quitting: false,
            main_window_geometry: None,
            initialization_window_restore_geometry: None,
            initialization_window_restore_maximized: false,
            initialization_window_active: false,
            backend: BackendProcessManager::from_env(),
            native_context_menu_selection: None,
            native_library: NativeLibraryState::new(),
        }
    }
}

const MAIN_WINDOW_GEOMETRY_FILE_NAME: &str = "main-window-geometry.json";
const INITIALIZATION_WINDOW_WIDTH: f64 = 1088.0;
const INITIALIZATION_WINDOW_HEIGHT: f64 = 760.0;
const INITIALIZATION_WINDOW_MIN_WIDTH: f64 = 1088.0;
const INITIALIZATION_WINDOW_MIN_HEIGHT: f64 = 720.0;
const WORKBENCH_WINDOW_MIN_WIDTH: f64 = 1100.0;
const WORKBENCH_WINDOW_MIN_HEIGHT: f64 = 720.0;
const POST_INITIALIZATION_WORKBENCH_SCALE: f64 = 1.5;
const POST_INITIALIZATION_RESIZE_ANIMATION_STEPS: u32 = 12;
const POST_INITIALIZATION_RESIZE_ANIMATION_FRAME_MS: u64 = 16;
const WINDOW_GEOMETRY_SIZE_TOLERANCE_PX: i32 = 24;

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MainWindowGeometry {
    position_x: i32,
    position_y: i32,
    width: u32,
    height: u32,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ResourceBoundaryManifest {
    resources: Option<HashMap<String, ResourceBoundaryResource>>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ResourceBoundaryResource {
    required_in_main_bundle: Option<bool>,
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
    #[serde(default)]
    target_paths: Vec<String>,
    reason: Option<String>,
    target_path: Option<String>,
    mode: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeLibraryWorkerCliPayload {
    root_dir: String,
    target_path: Option<String>,
    #[serde(default)]
    target_paths: Vec<String>,
    allowed_extensions: Option<Vec<String>>,
    included_hidden_paths: Option<Vec<String>>,
    hide_dot_files: Option<bool>,
    hide_system_folders: Option<bool>,
    reason: Option<String>,
    dirty_scope: Option<Value>,
    tag_store: Option<LocalStoredLibraryTags>,
    tag_scope: Option<TagAssignmentScope>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeSaveHttpServerStateRequest {
    enabled: Option<bool>,
    host: Option<String>,
    persistent: Option<bool>,
    port: Option<u16>,
    auth_enabled: Option<bool>,
    auth_username: Option<String>,
    auth_password: Option<String>,
    clear_auth: Option<bool>,
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
    hide_dot_files: Option<bool>,
    hide_system_folders: Option<bool>,
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
    search_scope: Option<String>,
    search_mode: Option<String>,
    updated_at_order: Option<String>,
    offset: Option<usize>,
    limit: Option<usize>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativePreviewRequest {
    path: String,
    display_mode: Option<String>,
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
    tag_directories: Vec<LocalLibraryTagDirectory>,
    tag_facet_counts: HashMap<String, usize>,
    directory_status: Option<LocalLibraryDirectoryStatus>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalLibraryTagDirectory {
    path: String,
    document_count: usize,
    updated_at: Option<String>,
    matched_tag_paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalRuntimePriorityHints {
    updated_at: String,
    paths: Vec<String>,
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
    hide_dot_files: Option<bool>,
    hide_system_folders: Option<bool>,
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
    hide_dot_files: bool,
    hide_system_folders: bool,
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
    progress_updated_at: Option<String>,
    running_stage: Option<String>,
    error_summary: Option<String>,
    progress: Option<LocalLibraryIndexProgress>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyPersistedRuntimeStatus {
    status: Option<String>,
    stage: Option<String>,
    command: Option<String>,
    updated_at: Option<String>,
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
    #[serde(default)]
    active_task_count: usize,
    #[serde(default)]
    pending_task_count: usize,
    #[serde(default)]
    completed_task_count: usize,
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeResetApplicationDataResult {
    data_dir: String,
    app_data_dir: Option<String>,
    cleared_library_index_dir: Option<String>,
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
    #[serde(default)]
    child_tag_selection_mode: Option<String>,
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
    child_tag_selection_mode: String,
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
struct LocalSuppressedTagSource {
    path: String,
    source_type: String,
    source_ref: Option<String>,
    evidence: Option<String>,
    confidence: f64,
    priority: i64,
    suppressed_by_path: String,
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
    suppressed_tags: Vec<LocalSuppressedTagSource>,
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
    hide_dot_files: bool,
    hide_system_folders: bool,
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
}

impl NativeWatcherRuntime {
    fn new() -> Self {
        Self {
            last_event_at: None,
            last_refresh_requested_at: None,
            last_refresh_reason: None,
            last_error: None,
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

#[derive(Clone)]
struct LibraryWork {
    app: Option<AppHandle>,
    mode: String,
    payload: NativeLibraryWorkerCliPayload,
    task_ids: Vec<String>,
}

fn library_scheduler() -> &'static RootScheduler<LibraryWork> {
    static SCHEDULER: OnceLock<RootScheduler<LibraryWork>> = OnceLock::new();
    SCHEDULER.get_or_init(RootScheduler::new)
}

fn merge_library_work(pending: &mut LibraryWork, next: LibraryWork) {
    pending.task_ids.extend(next.task_ids);
    if pending.mode != next.mode {
        pending.mode = "full".to_string();
    }
    let paths = |payload: &NativeLibraryWorkerCliPayload| {
        if payload.target_paths.is_empty() {
            payload.target_path.iter().cloned().collect::<Vec<_>>()
        } else {
            payload.target_paths.clone()
        }
    };
    let left = paths(&pending.payload);
    let right = paths(&next.payload);
    let mut targets = if left.is_empty() || right.is_empty() {
        Vec::new()
    } else {
        left.into_iter().chain(right).collect::<Vec<_>>()
    };
    targets.sort();
    targets.dedup();
    let mut minimal = Vec::new();
    let mut accepted = HashSet::new();
    for target in targets {
        if !target
            .rmatch_indices('/')
            .any(|(index, _)| accepted.contains(&target[..index]))
        {
            accepted.insert(target.clone());
            minimal.push(target);
        }
    }
    pending.payload.target_path = if minimal.len() == 1 {
        minimal.pop()
    } else {
        None
    };
    pending.payload.target_paths = minimal;
    pending.app = next.app.or_else(|| pending.app.clone());
    pending.payload.reason = next.payload.reason;
    pending.payload.allowed_extensions = next.payload.allowed_extensions;
    pending.payload.included_hidden_paths = next.payload.included_hidden_paths;
    pending.payload.hide_dot_files = next.payload.hide_dot_files;
    pending.payload.hide_system_folders = next.payload.hide_system_folders;
}

fn schedule_library_work(
    mode: &str,
    payload: NativeLibraryWorkerCliPayload,
    app: Option<AppHandle>,
) -> bool {
    let root = payload.root_dir.clone();
    let task_id = task_center::register(
        &root, "library.index", payload.reason.as_deref().unwrap_or("refresh"),
        payload.target_path.clone(),
    );
    let start = library_scheduler().submit(
        &root,
        LibraryWork {
            app,
            mode: mode.to_string(),
            payload,
            task_ids: vec![task_id],
        },
        merge_library_work,
    );
    if start {
        thread::spawn(move || loop {
            let Some(work) = library_scheduler().next(&root) else {
                break;
            };
            let started = std::time::Instant::now();
            let started_at_ms = epoch_millis();
            let target = work.payload.target_path.clone();
            let target_count = work.payload.target_paths.len();
            let reason = work.payload.reason.clone();
            let result = task_center::run(work.task_ids, || {
                run_native_library_worker_mode(&work.mode, work.payload)
            });
            let metrics = match &result {
                Ok(value) => json!({ "rootDir": root, "mode": work.mode, "reason": reason,
                    "startedAtMs": started_at_ms, "completedAtMs": epoch_millis(),
                    "targetPath": target, "targetPathCount": target_count,
                    "durationMs": started.elapsed().as_secs_f64() * 1000.0,
                    "index": { "scannedCount": value["index"]["scannedCount"],
                        "indexedCount": value["index"]["indexedCount"],
                        "unchangedCount": value["index"]["unchangedCount"],
                        "deletedCount": value["index"]["deletedCount"],
                        "timingsMs": value["index"]["timingsMs"] },
                    "filesWrittenCount": value["exportResult"]["filesWritten"].as_array().map_or(0, Vec::len) }),
                Err(error) => json!({ "rootDir": root, "error": error }),
            };
            println!("[x-file native] task.complete {}", metrics);
            if let Some(app) = work.app {
                let _ = app.emit("x-file-library-updated", json!({ "rootDir": root }));
            }
        });
    }
    !start
}

fn normalize_library_worker_reason(reason: Option<&str>, fallback: &str) -> String {
    reason
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(fallback)
        .to_string()
}

fn normalize_library_worker_target_path(target_path: Option<&str>) -> Option<String> {
    target_path
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn build_native_library_worker_payload(
    binding: &LocalLibraryBinding,
    reason: String,
    target_path: Option<String>,
    dirty_scope: Option<Value>,
) -> NativeLibraryWorkerCliPayload {
    NativeLibraryWorkerCliPayload {
        root_dir: binding.root_dir.clone(),
        target_path,
        target_paths: Vec::new(),
        allowed_extensions: Some(binding.allowed_extensions.clone()),
        included_hidden_paths: Some(binding.included_hidden_paths.clone()),
        hide_dot_files: Some(binding.hide_dot_files),
        hide_system_folders: Some(binding.hide_system_folders),
        reason: Some(reason),
        dirty_scope,
        tag_store: None,
        tag_scope: None,
    }
}

fn run_native_library_worker_mode(
    mode: &str,
    payload: NativeLibraryWorkerCliPayload,
) -> Result<Value, String> {
    task_center::stage("waiting_for_lock");
    let _root_lock = lock_root(&payload.root_dir)?;
    task_center::stage("index_text");
    let reason =
        normalize_library_worker_reason(payload.reason.as_deref(), "desktop_native_worker_cli");
    let target_path = normalize_library_worker_target_path(payload.target_path.as_deref());

    match mode {
        "tags-only" => {
            let mut binding = default_local_library_binding();
            binding.root_dir = payload.root_dir;
            let store = payload
                .tag_store
                .ok_or_else(|| "标签任务缺少 tagStore".to_string())?;
            let plan = native_core::tag_core::prepare_tag_assignment(
                &binding, &payload.tag_scope.unwrap_or_default(), true,
            )?;
            native_core::tag_core::run_tag_assignment_core(&binding, &store, plan, &reason)
        }
        "index-only" => {
            let allowed_extensions = payload.allowed_extensions.unwrap_or_default();
            let included_hidden_paths = payload.included_hidden_paths.unwrap_or_default();
            let hide_dot_files = payload.hide_dot_files.unwrap_or(true);
            let hide_system_folders = payload.hide_system_folders.unwrap_or(true);
            run_native_index_worker(NativeIndexRequest {
                root_dir: payload.root_dir,
                allowed_extensions,
                included_hidden_paths,
                hide_dot_files,
                hide_system_folders,
                reason,
                target_path,
                target_paths: payload.target_paths,
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
        "full" => {
            let allowed_extensions = payload.allowed_extensions.unwrap_or_default();
            let included_hidden_paths = payload.included_hidden_paths.unwrap_or_default();
            let hide_dot_files = payload.hide_dot_files.unwrap_or(true);
            let hide_system_folders = payload.hide_system_folders.unwrap_or(true);
            let index_request = NativeIndexRequest {
                root_dir: payload.root_dir.clone(),
                allowed_extensions,
                included_hidden_paths,
                hide_dot_files,
                hide_system_folders,
                reason: reason.clone(),
                target_path: target_path.clone(),
                target_paths: payload.target_paths,
            };
            let index_result = run_native_index_worker(index_request.clone())?;
            if reason == "library_backup_imported" {
                let binding = read_local_library_binding()?
                    .ok_or_else(|| "文档库绑定不存在，无法重算恢复的标签".to_owned())?;
                let tag_store = native_core::tag_core::read_local_library_tags_store(&binding)?;
                let plan = native_core::tag_core::prepare_tag_assignment(
                    &binding,
                    &native_core::tag_core::TagAssignmentScope::Full,
                    false,
                )?;
                native_core::tag_core::run_tag_assignment_core(
                    &binding,
                    &tag_store,
                    plan,
                    "library_backup_imported",
                )?;
            }
            task_center::stage("export_snapshot");
            let dirty_scope = index_result["dirtyScope"].clone();
            let export_result = run_native_export_worker(NativeExportRequest {
                root_dir: payload.root_dir.clone(),
                reason: reason.clone(),
                target_path: target_path.clone(),
                dirty_scope: dirty_scope.clone(),
            })?;
            Ok(
                json!({ "index": index_result["index"], "exportResult": export_result,
                "status": read_local_runtime_status(&index_request.root_dir)? }),
            )
        }
        other => Err(format!("library worker CLI 不支持的 mode：{other}")),
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
    app: AppHandle,
    state: tauri::State<'_, Mutex<DesktopState>>,
    request: NativeLibraryWatcherRequest,
) -> Result<NativeLibraryWatcherStatus, String> {
    let root_dir = request.root_dir.trim();
    if root_dir.is_empty() {
        return Err("rootDir 不能为空".to_string());
    }

    let canonical_root =
        fs::canonicalize(root_dir).map_err(|error| format!("无法解析 watcher 根目录：{error}"))?;
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
    let runtime = Arc::new(Mutex::new(NativeWatcherRuntime::new()));
    let runtime_for_callback = Arc::clone(&runtime);
    let canonical_root_for_callback = canonical_root.clone();
    let (events, receiver) = std::sync::mpsc::channel::<Vec<String>>();
    thread::spawn(move || {
        while let Ok(first) = receiver.recv() {
            let mut paths = first.into_iter().collect::<std::collections::BTreeSet<_>>();
            let started = std::time::Instant::now();
            while let Some(remaining) = Duration::from_millis(150).checked_sub(started.elapsed()) {
                match receiver.recv_timeout(remaining) {
                    Ok(next) => paths.extend(next),
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => break,
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return,
                }
            }
            let _ = schedule_native_library_refresh(
                NativeLibraryRefreshRequest {
                    reason: Some("native_watcher_change".to_string()),
                    target_path: None,
                    target_paths: paths.into_iter().collect(),
                    mode: None,
                },
                Some(app.clone()),
            );
        }
    });
    let mut watcher = RecommendedWatcher::new(
        move |result: Result<Event, notify::Error>| match result {
            Ok(event) => {
                if !should_handle_native_watcher_event(&canonical_root_for_callback, &event) {
                    return;
                }
                if let Ok(mut runtime) = runtime_for_callback.lock() {
                    runtime.last_event_at = Some(iso_now());
                    runtime.last_refresh_requested_at = Some(iso_now());
                    runtime.last_refresh_reason = Some("native_watcher_change".to_string());
                    runtime.last_error = None;
                }
                let _ = events.send(native_watcher_targets(&canonical_root_for_callback, &event));
            }
            Err(error) => {
                if let Ok(mut runtime) = runtime_for_callback.lock() {
                    runtime.last_error = Some(error.to_string());
                }
                eprintln!("native watcher error: {error}");
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
    (event.need_rescan()
        || event.kind.is_modify()
        || event.kind.is_create()
        || event.kind.is_remove())
        && ((event.need_rescan() && event.paths.is_empty())
            || event
                .paths
                .iter()
                .any(|path| !is_native_runtime_artifact_path(root_dir, path)))
}

fn native_watcher_targets(root: &Path, event: &Event) -> Vec<String> {
    event
        .paths
        .iter()
        .filter(|path| !is_native_runtime_artifact_path(root, path))
        .filter_map(|path| path.strip_prefix(root).ok())
        .map(|path| path.to_string_lossy().replace('\\', "/"))
        .collect()
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
    app: AppHandle,
    state: tauri::State<'_, Mutex<DesktopState>>,
    request: NativeLibraryRefreshRequest,
) -> Result<NativeLibraryRefreshResponse, String> {
    let reason = request
        .reason
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("native_manual_refresh")
        .to_string();
    let target_path_for_log = request
        .target_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string);
    println!(
        "[x-file native] refresh.request transport=native reason={} targetPath={}",
        reason,
        target_path_for_log.as_deref().unwrap_or("<root>")
    );
    let binding = read_local_library_binding()?
        .ok_or_else(|| "文档库绑定不存在，无法执行索引 worker".to_string())?;
    {
        let mut state = lock_desktop_state(&state);
        state.native_library.last_refresh_requested_at = Some(iso_now());
        state.native_library.last_refresh_reason = Some(reason.clone());
        state.native_library.last_error = None;
    }

    let deduped = schedule_native_library_refresh(request.clone(), Some(app))?;

    let watcher = {
        let state = lock_desktop_state(&state);
        state.native_library.snapshot()
    };
    let mut status = read_local_runtime_status(&binding.root_dir)?
        .unwrap_or_else(|| empty_local_status("queued", None));
    status.state = "queued".to_string();
    status.last_requested_at = Some(iso_now());
    status.next_allowed_at = None;
    status.error_summary = None;
    status.dirty_reasons = vec![reason.clone()];
    Ok(NativeLibraryRefreshResponse {
        watcher,
        backend_response: json!({
            "accepted": true,
            "deduped": deduped,
            "scheduled": true,
            "reason": reason,
            "targetPath": request.target_path,
            "taskId": Value::Null,
            "status": status,
            "directoryStatus": Value::Null,
        }),
    })
}

#[tauri::command]
fn native_get_library_binding() -> Result<Value, String> {
    serde_json::to_value(read_local_library_binding()?)
        .map_err(|error| format!("序列化本地 binding 失败：{error}"))
}

#[tauri::command]
fn native_save_library_binding(request: NativeSaveLibraryBindingRequest) -> Result<Value, String> {
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
    app: AppHandle,
    request: NativeSaveLibraryConfigRequest,
) -> Result<Value, String> {
    let previous_binding = read_local_library_binding()?;
    let config = save_local_library_config(request)?;
    let should_refresh = previous_binding.as_ref().is_some_and(|previous| {
        config.binding.as_ref().is_some_and(|current| {
            previous.allowed_extensions != current.allowed_extensions
                || previous.included_hidden_paths != current.included_hidden_paths
                || previous.hide_dot_files != current.hide_dot_files
                || previous.hide_system_folders != current.hide_system_folders
        })
    });
    let mut value =
        serde_json::to_value(config).map_err(|error| format!("序列化本地 config 失败：{error}"))?;
    if should_refresh {
        let refresh = schedule_native_library_refresh(
            NativeLibraryRefreshRequest {
                target_paths: Vec::new(),
                reason: Some("library_config_changed".to_string()),
                target_path: None,
                mode: Some("full".to_string()),
            },
            Some(app),
        )?;
        value["applyConfigTaskId"] = Value::Null;
        value["applyConfigStatus"] = read_local_runtime_status(
            value["binding"]["rootDir"].as_str().unwrap_or_default(),
        )?
        .map(|status| json!(status))
        .unwrap_or_else(|| json!({
            "state": if refresh { "queued" } else { "cooldown" },
            "dirtyReasons": ["library_config_changed"],
        }));
    }
    Ok(value)
}

#[tauri::command]
async fn native_export_library_backup() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(native_core::backup::export_library_backup)
        .await
        .map_err(|error| format!("备份导出任务异常：{error}"))?
}

#[tauri::command]
fn native_write_library_backup(path: String, content: String) -> Result<Value, String> {
    native_core::backup::write_library_backup_file(&path, &content)?;
    Ok(Value::Bool(true))
}

#[tauri::command]
async fn native_import_library_backup(app: AppHandle, backup: Value) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let result = native_core::backup::import_library_backup(backup, Some(app))?;
        serde_json::to_value(result).map_err(|error| format!("序列化备份恢复结果失败：{error}"))
    })
    .await
    .map_err(|error| format!("备份导入任务异常：{error}"))?
}

#[tauri::command]
fn native_browse_host_directories(path: Option<String>) -> Result<Value, String> {
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
async fn native_list_library_tasks() -> Result<Vec<task_center::LibraryTask>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        Ok(read_local_library_binding()?.map(|binding| task_center::list(&binding.root_dir)).unwrap_or_default())
    }).await.map_err(|error| format!("读取任务中心失败：{error}"))?
}

#[tauri::command]
async fn native_list_library_tag_details(
    request: NativeListLibraryTagDetailsRequest,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
    list_native_library_tag_details(request.include_disabled.unwrap_or(true))
    }).await.map_err(|error| format!("后台标签任务异常：{error}"))?
}

#[tauri::command]
async fn native_get_library_tag_detail(request: NativeLibraryTagIdRequest) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
    get_native_library_tag_detail(&request.tag_id)
    }).await.map_err(|error| format!("后台标签任务异常：{error}"))?
}

#[tauri::command]
async fn native_create_library_tag(
    request: NativeSaveLibraryTagDefinitionRequest,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
    create_native_library_tag(request)
    }).await.map_err(|error| format!("后台标签任务异常：{error}"))?
}

#[tauri::command]
async fn native_update_library_tag(
    request: NativeSaveLibraryTagDefinitionRequest,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
    let tag_id = request
        .tag_id
        .clone()
        .ok_or_else(|| "tagId 不能为空".to_string())?;
    update_native_library_tag(tag_id, request)
    }).await.map_err(|error| format!("后台标签任务异常：{error}"))?
}

#[tauri::command]
async fn native_delete_library_tag(request: NativeLibraryTagIdRequest) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
    delete_native_library_tag(&request.tag_id)
    }).await.map_err(|error| format!("后台标签任务异常：{error}"))?
}

#[tauri::command]
async fn native_get_document_tag_details(
    request: NativeDocumentTagDetailsRequest,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
    get_native_document_tag_details(&request.document_id)
    }).await.map_err(|error| format!("后台标签任务异常：{error}"))?
}

#[tauri::command]
async fn native_save_document_tags(request: NativeSaveDocumentTagsRequest) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
    save_native_document_tags(request)
    }).await.map_err(|error| format!("后台标签任务异常：{error}"))?
}

#[tauri::command]
async fn native_get_folder_tag_details(request: NativeFolderTagDetailsRequest) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
    get_native_folder_tag_details(&request.folder_path)
    }).await.map_err(|error| format!("后台标签任务异常：{error}"))?
}

#[tauri::command]
async fn native_save_folder_tags(request: NativeSaveFolderTagsRequest) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
    save_native_folder_tags(request)
    }).await.map_err(|error| format!("后台标签任务异常：{error}"))?
}

#[tauri::command]
async fn native_request_library_tag_recompute() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
    request_native_library_tag_recompute()
    }).await.map_err(|error| format!("后台标签任务异常：{error}"))?
}

#[tauri::command]
async fn native_get_library_tag_recompute_task() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
    get_native_library_tag_recompute_task()
    }).await.map_err(|error| format!("后台标签任务异常：{error}"))?
}

#[tauri::command]
fn native_list_library_documents(request: NativeListDocumentsRequest) -> Result<Value, String> {
    serde_json::to_value(read_local_library_documents(request)?)
        .map_err(|error| format!("序列化本地 documents 失败：{error}"))
}

#[tauri::command]
fn native_list_library_files(path: Option<String>, limit: Option<usize>) -> Result<Value, String> {
    serde_json::to_value(read_local_library_files(path, limit)?)
        .map_err(|error| format!("序列化本地 files 失败：{error}"))
}

#[tauri::command]
async fn native_get_library_preview(request: NativePreviewRequest) -> Result<Value, String> {
    println!(
        "[x-file native] preview.request transport=native path={} displayMode={}",
        request.path,
        request.display_mode.as_deref().unwrap_or("default")
    );
    tauri::async_runtime::spawn_blocking(move || {
        serde_json::to_value(read_local_library_preview(request)?)
            .map_err(|error| format!("序列化本地 preview 失败：{error}"))
    })
    .await
    .map_err(|error| format!("等待本地 preview 读取失败：{error}"))?
}

#[tauri::command]
fn native_read_preview_resource(path: String) -> Result<String, String> {
    let binding = read_local_library_binding()?.ok_or_else(|| "当前未绑定文档库".to_string())?;
    let relative_path = normalize_document_path(&path);
    let root = fs::canonicalize(&binding.root_dir)
        .map_err(|error| format!("解析文档库根目录失败：{error}"))?;
    let absolute_path = fs::canonicalize(root.join(&relative_path))
        .map_err(|error| format!("解析预览文件路径失败：{error}"))?;
    if !absolute_path.starts_with(&root) || !absolute_path.is_file() {
        return Err("预览文件不在当前文档库内".to_string());
    }
    let extension = absolute_path
        .extension()
        .map(|value| value.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    let allow_native_bytes = preview_capabilities::format_for_extension(&extension)
        .is_some_and(|format| format.native_bytes == Some(true));
    if !allow_native_bytes {
        return Err("该文件类型不允许通过原生资源接口读取".to_string());
    }
    let metadata = fs::metadata(&absolute_path)
        .map_err(|error| format!("读取预览文件失败：{error}"))?;
    if metadata.len() > preview_capabilities::budgets().resource_max_bytes {
        return Err("预览文件超过 20 MiB 限制".to_string());
    }
    let bytes = fs::read(&absolute_path)
        .map_err(|error| format!("读取预览文件失败：{error}"))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
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
fn native_get_agent_integration_settings() -> Result<agent_tools::settings::SettingsView, String> {
    agent_tools::settings::get_settings()
}

#[tauri::command]
fn native_save_agent_integration_settings(
    input: agent_tools::settings::SettingsInput,
) -> Result<agent_tools::settings::SettingsSaved, String> {
    agent_tools::settings::save_settings(input)
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
        if item
            .items
            .as_ref()
            .is_some_and(|children| !children.is_empty())
        {
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
        if child
            .items
            .as_ref()
            .is_some_and(|children| !children.is_empty())
        {
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
            note:
                "关闭窗口时隐藏主窗口并保留后台服务；用户可以从顶部菜单栏图标恢复窗口或退出应用。",
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
    let _ = window.set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(
        geometry.position_x,
        geometry.position_y,
    )));
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

fn initialization_window_size() -> tauri::Size {
    tauri::Size::Logical(tauri::LogicalSize::new(
        INITIALIZATION_WINDOW_WIDTH,
        INITIALIZATION_WINDOW_HEIGHT,
    ))
}

fn initialization_window_min_size() -> tauri::Size {
    tauri::Size::Logical(tauri::LogicalSize::new(
        INITIALIZATION_WINDOW_MIN_WIDTH,
        INITIALIZATION_WINDOW_MIN_HEIGHT,
    ))
}

fn workbench_window_min_size() -> tauri::Size {
    tauri::Size::Logical(tauri::LogicalSize::new(
        WORKBENCH_WINDOW_MIN_WIDTH,
        WORKBENCH_WINDOW_MIN_HEIGHT,
    ))
}

fn geometry_has_similar_size(left: MainWindowGeometry, right: MainWindowGeometry) -> bool {
    let width_delta = left.width as i64 - right.width as i64;
    let height_delta = left.height as i64 - right.height as i64;
    width_delta.abs() <= i64::from(WINDOW_GEOMETRY_SIZE_TOLERANCE_PX)
        && height_delta.abs() <= i64::from(WINDOW_GEOMETRY_SIZE_TOLERANCE_PX)
}

fn scale_main_window_geometry_from_center(
    geometry: MainWindowGeometry,
    scale: f64,
) -> MainWindowGeometry {
    let center_x = geometry.position_x as f64 + geometry.width as f64 / 2.0;
    let center_y = geometry.position_y as f64 + geometry.height as f64 / 2.0;
    let scaled_width = ((geometry.width as f64) * scale).round().max(1.0) as u32;
    let scaled_height = ((geometry.height as f64) * scale).round().max(1.0) as u32;

    MainWindowGeometry {
        position_x: (center_x - scaled_width as f64 / 2.0).round() as i32,
        position_y: (center_y - scaled_height as f64 / 2.0).round() as i32,
        width: scaled_width,
        height: scaled_height,
    }
}

fn resolve_post_initialization_workbench_geometry(
    current_geometry: Option<MainWindowGeometry>,
    restore_geometry: Option<MainWindowGeometry>,
) -> Option<MainWindowGeometry> {
    if let Some(restore) = restore_geometry {
        if let Some(current) = current_geometry {
            if !geometry_has_similar_size(restore, current) {
                return Some(restore);
            }
        } else {
            return Some(restore);
        }
    }

    current_geometry.or(restore_geometry).map(|geometry| {
        scale_main_window_geometry_from_center(geometry, POST_INITIALIZATION_WORKBENCH_SCALE)
    })
}

fn resolve_monitor_for_geometry(
    window: &WebviewWindow,
    geometry: MainWindowGeometry,
) -> Option<tauri::Monitor> {
    let center_x = geometry.position_x as i64 + geometry.width as i64 / 2;
    let center_y = geometry.position_y as i64 + geometry.height as i64 / 2;
    window
        .monitor_from_point(center_x as f64, center_y as f64)
        .ok()
        .flatten()
        .or_else(|| window.current_monitor().ok().flatten())
}

fn clamp_main_window_geometry_to_monitor(
    window: &WebviewWindow,
    geometry: MainWindowGeometry,
) -> MainWindowGeometry {
    let Some(monitor) = resolve_monitor_for_geometry(window, geometry) else {
        return geometry;
    };

    let work_area = monitor.work_area();
    let work_left = work_area.position.x as i64;
    let work_top = work_area.position.y as i64;
    let work_width = work_area.size.width as i64;
    let work_height = work_area.size.height as i64;
    if work_width <= 0 || work_height <= 0 {
        return geometry;
    }

    let width = (geometry.width as i64).min(work_width).max(1);
    let height = (geometry.height as i64).min(work_height).max(1);
    let center_x = geometry.position_x as i64 + geometry.width as i64 / 2;
    let center_y = geometry.position_y as i64 + geometry.height as i64 / 2;
    let max_x = work_left + work_width - width;
    let max_y = work_top + work_height - height;
    let position_x = (center_x - width / 2).clamp(work_left, max_x);
    let position_y = (center_y - height / 2).clamp(work_top, max_y);

    MainWindowGeometry {
        position_x: position_x as i32,
        position_y: position_y as i32,
        width: width as u32,
        height: height as u32,
    }
}

fn interpolate_main_window_geometry(
    from: MainWindowGeometry,
    to: MainWindowGeometry,
    progress: f64,
) -> MainWindowGeometry {
    let interpolate_i32 = |start: i32, end: i32| -> i32 {
        (start as f64 + (end - start) as f64 * progress).round() as i32
    };
    let interpolate_u32 = |start: u32, end: u32| -> u32 {
        (start as f64 + (end as f64 - start as f64) * progress)
            .round()
            .max(1.0) as u32
    };

    MainWindowGeometry {
        position_x: interpolate_i32(from.position_x, to.position_x),
        position_y: interpolate_i32(from.position_y, to.position_y),
        width: interpolate_u32(from.width, to.width),
        height: interpolate_u32(from.height, to.height),
    }
}

fn animate_main_window_geometry_transition(
    window: WebviewWindow,
    from: MainWindowGeometry,
    to: MainWindowGeometry,
) {
    if from.position_x == to.position_x
        && from.position_y == to.position_y
        && from.width == to.width
        && from.height == to.height
    {
        apply_main_window_geometry(&window, to);
        return;
    }

    thread::spawn(move || {
        for step in 1..=POST_INITIALIZATION_RESIZE_ANIMATION_STEPS {
            let linear_progress = step as f64 / POST_INITIALIZATION_RESIZE_ANIMATION_STEPS as f64;
            let eased_progress = 1.0 - (1.0 - linear_progress).powi(3);
            let frame_geometry = interpolate_main_window_geometry(from, to, eased_progress);
            apply_main_window_geometry(&window, frame_geometry);
            thread::sleep(Duration::from_millis(
                POST_INITIALIZATION_RESIZE_ANIMATION_FRAME_MS,
            ));
        }
    });
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
    {
        let desktop_state = window.state::<Mutex<DesktopState>>();
        let Some(state) = desktop_state.try_lock().ok() else {
            return;
        };
        if state.initialization_window_active {
            return;
        }
    }
    let Some(geometry) = capture_main_window_geometry_from_window(window) else {
        return;
    };
    remember_main_window_geometry(window);
    if let Err(error) = persist_main_window_geometry(geometry) {
        eprintln!("持久化主窗口尺寸失败: {error}");
    }
}

fn set_main_window_initialization_mode(
    window: &WebviewWindow,
    active: bool,
    state: &tauri::State<'_, Mutex<DesktopState>>,
) -> Result<(), String> {
    let mut desktop_state = lock_desktop_state(state);

    if active {
        if desktop_state.initialization_window_active {
            return Ok(());
        }

        let restore_geometry = capture_main_window_geometry_from_webview(window)
            .or(desktop_state.main_window_geometry);
        let restore_maximized = window.is_maximized().unwrap_or(false);
        desktop_state.initialization_window_restore_geometry = restore_geometry;
        desktop_state.initialization_window_restore_maximized = restore_maximized;
        // 先标记为初始化态，避免下面的原生缩放事件把初始化尺寸错误持久化。
        desktop_state.initialization_window_active = true;
        drop(desktop_state);

        if restore_maximized {
            let _ = window.unmaximize();
        }

        let activation_result = (|| -> Result<(), String> {
            #[cfg(target_os = "macos")]
            set_macos_window_background_mode(window, false)?;

            window
                .set_maximizable(false)
                .map_err(|error| format!("禁用初始化窗口最大化失败：{error}"))?;
            window
                .set_resizable(false)
                .map_err(|error| format!("禁用初始化窗口缩放失败：{error}"))?;
            window
                .set_min_size(Some(initialization_window_min_size()))
                .map_err(|error| format!("设置初始化窗口最小尺寸失败：{error}"))?;
            window
                .set_max_size(Some(initialization_window_size()))
                .map_err(|error| format!("设置初始化窗口最大尺寸失败：{error}"))?;
            window
                .set_size(initialization_window_size())
                .map_err(|error| format!("设置初始化窗口尺寸失败：{error}"))?;
            window
                .center()
                .map_err(|error| format!("初始化窗口居中失败：{error}"))?;
            Ok(())
        })();

        if let Err(error) = activation_result {
            let mut rollback_state = lock_desktop_state(state);
            rollback_state.initialization_window_restore_geometry = None;
            rollback_state.initialization_window_restore_maximized = false;
            rollback_state.initialization_window_active = false;
            return Err(error);
        }

        return Ok(());
    }

    if !desktop_state.initialization_window_active {
        return Ok(());
    }

    let restore_geometry = desktop_state.initialization_window_restore_geometry;
    let restore_maximized = desktop_state.initialization_window_restore_maximized;
    desktop_state.initialization_window_restore_geometry = None;
    desktop_state.initialization_window_restore_maximized = false;
    desktop_state.initialization_window_active = false;
    drop(desktop_state);

    #[cfg(target_os = "macos")]
    set_macos_window_background_mode(window, true)?;

    window
        .set_max_size(None::<tauri::Size>)
        .map_err(|error| format!("清除初始化窗口最大尺寸失败：{error}"))?;
    window
        .set_min_size(Some(workbench_window_min_size()))
        .map_err(|error| format!("恢复工作台最小尺寸失败：{error}"))?;
    window
        .set_resizable(true)
        .map_err(|error| format!("恢复工作台缩放失败：{error}"))?;
    window
        .set_maximizable(true)
        .map_err(|error| format!("恢复工作台最大化失败：{error}"))?;

    if restore_maximized {
        window
            .maximize()
            .map_err(|error| format!("恢复工作台最大化状态失败：{error}"))?;
    } else {
        let current_geometry = capture_main_window_geometry_from_webview(window);
        let target_geometry =
            resolve_post_initialization_workbench_geometry(current_geometry, restore_geometry)
                .map(|geometry| clamp_main_window_geometry_to_monitor(window, geometry));

        if let Some(geometry) = target_geometry {
            if let Some(current) = current_geometry {
                animate_main_window_geometry_transition(window.clone(), current, geometry);
            } else {
                apply_main_window_geometry(window, geometry);
            }
            update_main_window_geometry_state(&window.app_handle(), geometry);
            if let Err(error) = persist_main_window_geometry(geometry) {
                eprintln!("恢复工作台尺寸后持久化失败: {error}");
            }
        } else {
            let scaled_size = tauri::Size::Logical(tauri::LogicalSize::new(
                INITIALIZATION_WINDOW_WIDTH * POST_INITIALIZATION_WORKBENCH_SCALE,
                INITIALIZATION_WINDOW_HEIGHT * POST_INITIALIZATION_WORKBENCH_SCALE,
            ));
            window
                .set_size(scaled_size)
                .map_err(|error| format!("设置工作台默认尺寸失败：{error}"))?;
            window
                .center()
                .map_err(|error| format!("工作台默认居中失败：{error}"))?;
        }
    }

    Ok(())
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
    let start_backend = MenuItemBuilder::with_id(MENU_START_BACKEND, "启动内置后端").build(app)?;
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


    if let Some(resource_dir) = resource_dir {
        state
            .backend
            .prefer_resource_entry(resource_dir, resource_boundary.as_ref());
    }

    if should_autostart_backend() {
        state.backend.start();
    }
}

fn schedule_native_library_refresh(
    request: NativeLibraryRefreshRequest,
    app: Option<AppHandle>,
) -> Result<bool, String> {
    let binding = read_local_library_binding()?
        .ok_or_else(|| "文档库绑定不存在，无法执行索引 worker".to_string())?;
    let reason =
        normalize_library_worker_reason(request.reason.as_deref(), "native_manual_refresh");
    let target_path = normalize_library_worker_target_path(request.target_path.as_deref());
    let mode = request
        .mode
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("full")
        .to_string();
    let mut payload = build_native_library_worker_payload(&binding, reason, target_path, None);
    payload.target_paths = request.target_paths;
    Ok(schedule_library_work(&mode, payload, app))
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

    let runtime_status = read_local_runtime_status(&binding.root_dir)?;
    let export_payload = read_local_library_export_payload(&binding.root_dir)?;
    let Some(export_payload) = export_payload else {
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
    };
    let document_count = export_payload
        .document_count
        .unwrap_or(export_payload.documents.len());
    let status = merge_runtime_status(
        runtime_status,
        export_payload.generated_at.clone(),
        export_payload.exported_at.clone(),
        document_count,
        watcher,
    );

    Ok(LocalLibrarySnapshot {
        binding: Some(binding),
        default_root_dir,
        requires_initialization: false,
        initialization_redirect_path: "/init".to_string(),
        status: status.clone(),
        tags: export_payload.tags.clone(),
        favorites,
        folders: export_payload.folders.clone(),
        document_count,
        last_error: status.error_summary,
    })
}

fn read_local_library_documents(
    request: NativeListDocumentsRequest,
) -> Result<LocalLibraryDocumentList, String> {
    let binding = read_local_library_binding()?.ok_or_else(|| "当前未绑定文档库".to_string())?;
    for path in request.selected_folder_path.iter().filter(|path| !path.trim().is_empty()) {
        crate::agent_tools::files::resolve(&binding, path, false, true)
            .map_err(|error| error.message)?;
    }
    let runtime_status = read_local_runtime_status(&binding.root_dir)?;
    let favorites = read_local_library_favorites(&binding)?;
    record_native_directory_priority_hint(
        &binding.root_dir,
        request.selected_folder_path.as_deref(),
    )?;
    let export_payload = match read_local_library_export_payload(&binding.root_dir)? {
        Some(value) => value,
        None => {
            if runtime_status
                .as_ref()
                .is_some_and(|status| matches!(status.state.as_str(), "queued" | "running"))
            {
                return Ok(empty_local_library_documents_for_running_index(
                    &request,
                    runtime_status,
                ));
            }
            return Err("文档库读取失败：索引快照尚未生成，请先等待本地索引完成".to_string());
        }
    };
    let search_scope = match request.search_scope.as_deref() {
        Some("all") | Some("current_directory") | Some("current_results") => {
            request.search_scope.as_deref().unwrap_or("current_results")
        }
        Some(_) => return Err("searchScope 参数无效".into()),
        None => "current_results",
    };
    let documents = if search_scope == "all" {
        export_payload.documents.iter().collect::<Vec<_>>()
    } else if request.browse_mode == "folder" {
        let directory =
            normalize_folder_path(request.selected_folder_path.as_deref().unwrap_or("."));
        export_payload
            .by_directory
            .get(&directory)
            .into_iter()
            .flatten()
            .map(|index| &export_payload.documents[*index])
            .collect::<Vec<_>>()
    } else {
        export_payload.documents.iter().collect::<Vec<_>>()
    };
    let keyword = request.keyword.unwrap_or_default().trim().to_lowercase();
    let search_mode = match request.search_mode.as_deref() {
        Some("all") | Some("name") | Some("content") => request.search_mode.as_deref().unwrap_or("all"),
        Some(_) => return Err("searchMode 参数无效".into()),
        None => "all",
    };
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

        if search_scope != "all"
            && (search_scope == "current_directory" || request.browse_mode != "tag")
        {
            let selected_folder =
                normalize_folder_path(request.selected_folder_path.as_deref().unwrap_or("."));
            if document_dir != selected_folder {
                continue;
            }
        }

        if search_scope == "current_results" && !selected_tags.is_empty() {
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

        if search_scope == "current_results" {
            if let Some(selected_favorite_id) = request.selected_favorite_id.as_deref() {
                let Some(favorite) = favorites
                    .iter()
                    .find(|item| item.path == selected_favorite_id)
                else {
                    continue;
                };
                if !document_matches_favorite(&tags, &derived_tags, &document_dir, favorite) {
                    continue;
                }
            }
        }

        if !keyword.is_empty() {
            let haystack = match search_mode {
                "name" => format!(
                    "{}\n{}",
                    title.to_lowercase(),
                    Path::new(&normalized_path)
                        .file_name()
                        .and_then(|value| value.to_str())
                        .unwrap_or("")
                        .to_lowercase(),
                ),
                "content" => summary.to_lowercase(),
                _ => format!(
                    "{}\n{}\n{}",
                    title.to_lowercase(),
                    normalized_path.to_lowercase(),
                    summary.to_lowercase()
                ),
            };
            if !keyword
                .split_whitespace()
                .all(|token| haystack.contains(token))
            {
                continue;
            }
        }

        let is_favorite = favorites.iter().any(|favorite| {
            favorite.kind != "folder"
                && document_matches_favorite(&tags, &derived_tags, &document_dir, favorite)
        });

        items.push(LocalLibraryDocumentRecord {
            document_id: document.document_id.clone(),
            path: normalized_path,
            title,
            summary,
            updated_at: document
                .mtime
                .clone()
                .or_else(|| export_payload.generated_at.clone())
                .unwrap_or_else(|| chrono::Utc::now().to_rfc3339()),
            created_at: None,
            size_bytes: None,
            tags,
            derived_tags,
            is_favorite,
        });
    }

    match request.updated_at_order.as_deref() {
        Some(order @ ("asc" | "desc")) => {
            // 按实际时间排序后再分页，缓存时间戳以避免比较时重复解析。
            items.sort_by_cached_key(|item| {
                let time = chrono::DateTime::parse_from_rfc3339(&item.updated_at)
                    .map(|value| value.timestamp_millis())
                    .unwrap_or(0);
                (if order == "desc" { -time } else { time }, item.path.clone())
            });
        }
        _ => items.sort_by(|left, right| left.path.cmp(&right.path)),
    }
    let total = items.len();
    // 标签树统计完整筛选结果，避免计数和可见节点随分页变化。
    let tag_facet_counts = count_document_tag_facets(&items);
    let tag_directories = if request.browse_mode == "tag" && !selected_tags.is_empty() {
        let store = read_local_library_tags_store(&binding)?;
        build_local_library_tag_directories(&store, &selected_tags, &items)
    } else {
        Vec::new()
    };
    let mut paged_items = items
        .into_iter()
        .skip(offset)
        .take(limit)
        .collect::<Vec<_>>();
    for item in &mut paged_items {
        if let Ok(metadata) = fs::metadata(Path::new(&binding.root_dir).join(&item.path)) {
            item.created_at = metadata.created().ok().map(system_time_to_rfc3339);
            item.size_bytes = Some(metadata.len());
        }
    }
    Ok(LocalLibraryDocumentList {
        total,
        visible_entry_total: total,
        offset,
        limit,
        items: paged_items,
        tag_directories,
        tag_facet_counts,
        directory_status: Some(LocalLibraryDirectoryStatus {
            path: normalize_folder_path(request.selected_folder_path.as_deref().unwrap_or(".")),
            state: "fresh".to_string(),
            source: "snapshot".to_string(),
            last_requested_at: None,
            last_completed_at: export_payload
                .exported_at
                .clone()
                .or(export_payload.generated_at.clone()),
            last_failed_at: None,
            running_task_id: None,
            error_summary: None,
            generated_at: export_payload.generated_at.clone(),
            filesystem_observed_at: None,
            stale_reason: None,
        }),
    })
}

fn record_native_directory_priority_hint(
    root_dir: &str,
    selected_folder_path: Option<&str>,
) -> Result<(), String> {
    let normalized = normalize_folder_path(selected_folder_path.unwrap_or("."));
    if normalized == "." {
        return Ok(());
    }
    let Some(runtime_status) = read_local_runtime_status(root_dir)? else {
        return Ok(());
    };
    if !matches!(runtime_status.state.as_str(), "queued" | "running") {
        return Ok(());
    }
    let hint_path = priority_hints_path(root_dir);
    let current_paths = read_optional_json_file::<LocalRuntimePriorityHints>(&hint_path)?
        .map(|payload| payload.paths)
        .unwrap_or_default();
    if current_paths
        .first()
        .is_some_and(|path| path == &normalized)
    {
        return Ok(());
    }
    let mut paths = current_paths
        .into_iter()
        .filter(|path| path != &normalized)
        .collect::<Vec<_>>();
    paths.insert(0, normalized);
    paths.truncate(16);
    write_json_file(
        &hint_path,
        &LocalRuntimePriorityHints {
            updated_at: iso_now(),
            paths,
        },
    )
}

fn empty_local_library_documents_for_running_index(
    request: &NativeListDocumentsRequest,
    runtime_status: Option<LocalLibraryIndexStatus>,
) -> LocalLibraryDocumentList {
    LocalLibraryDocumentList {
        total: 0,
        visible_entry_total: 0,
        offset: request.offset.unwrap_or(0),
        limit: request.limit.unwrap_or(50),
        items: vec![],
        tag_directories: vec![],
        tag_facet_counts: HashMap::new(),
        directory_status: Some(LocalLibraryDirectoryStatus {
            path: normalize_folder_path(request.selected_folder_path.as_deref().unwrap_or(".")),
            state: "running".to_string(),
            source: "stale_fallback".to_string(),
            last_requested_at: runtime_status
                .as_ref()
                .and_then(|status| status.last_requested_at.clone()),
            last_completed_at: None,
            last_failed_at: None,
            running_task_id: None,
            error_summary: None,
            generated_at: None,
            filesystem_observed_at: None,
            stale_reason: Some("索引快照尚未生成，当前正在等待本地索引完成".to_string()),
        }),
    }
}

#[derive(Debug, Clone)]
struct LocalLibraryExportPayload {
    generated_at: Option<String>,
    exported_at: Option<String>,
    document_count: Option<usize>,
    documents: Vec<MetaDocument>,
    tags: Vec<LocalLibraryTagNode>,
    folders: Vec<LocalLibraryFolderNode>,
    by_directory: HashMap<String, Vec<usize>>,
}

type ExportReadCache =
    HashMap<PathBuf, ((Option<SystemTime>, u64, chrono::NaiveDate), Arc<LocalLibraryExportPayload>)>;

fn read_local_library_export_payload(
    root_dir: &str,
) -> Result<Option<Arc<LocalLibraryExportPayload>>, String> {
    read_local_library_export_payload_on_date(root_dir, chrono::Local::now().date_naive())
}

fn read_local_library_export_payload_on_date(
    root_dir: &str,
    today: chrono::NaiveDate,
) -> Result<Option<Arc<LocalLibraryExportPayload>>, String> {
    static CACHE: OnceLock<Mutex<ExportReadCache>> = OnceLock::new();
    let snapshot = resolve_runtime_export_catalog_snapshot_path(root_dir);
    let path = if snapshot.is_file() {
        snapshot
    } else {
        PathBuf::from(root_dir).join(".ai-index/exports/manifest.json")
    };
    let metadata = match fs::metadata(&path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    let stamp = (metadata.modified().ok(), metadata.len(), today);
    let mut cache = CACHE
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap();
    if let Some((cached_stamp, payload)) = cache.get(&path) {
        if cached_stamp == &stamp {
            return Ok(Some(Arc::clone(payload)));
        }
    }
    let Some(mut payload) = load_local_library_export_payload(root_dir)? else {
        return Ok(None);
    };
    refresh_local_recent_time_tags(&mut payload, today);
    for (index, document) in payload.documents.iter().enumerate() {
        let directory = Path::new(&document.path)
            .parent()
            .map(|value| value.to_string_lossy().replace('\\', "/"))
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| ".".to_string());
        payload
            .by_directory
            .entry(directory)
            .or_default()
            .push(index);
    }
    let payload = Arc::new(payload);
    cache.insert(path, (stamp, Arc::clone(&payload)));
    Ok(Some(payload))
}

const RECENT_TIME_TAGS: [(&str, i64); 3] = [
    ("时间/最近3天", 3),
    ("时间/最近7天", 7),
    ("时间/最近30天", 30),
];

fn refresh_local_recent_time_tags(
    payload: &mut LocalLibraryExportPayload,
    today: chrono::NaiveDate,
) {
    let is_recent = |tag: &String| RECENT_TIME_TAGS.iter().any(|(path, _)| tag == path);
    for document in &mut payload.documents {
        if let Some(tags) = document.direct_tags.as_mut() {
            tags.retain(|tag| !is_recent(tag));
        }
        let tags = document.derived_tags.get_or_insert_with(Vec::new);
        tags.retain(|tag| !is_recent(tag));
        let modified_date = document.mtime.as_deref()
            .and_then(|time| chrono::DateTime::parse_from_rfc3339(time).ok())
            .map(|time| time.with_timezone(&chrono::Local).date_naive());
        if let Some(modified_date) = modified_date {
            let age = (today - modified_date).num_days();
            tags.extend(RECENT_TIME_TAGS.iter()
                .filter(|(_, days)| age >= 0 && age < *days)
                .map(|(path, _)| path.to_string()));
        }
    }
    let counts = count_local_tags(&payload.documents);
    for tag in &mut payload.tags {
        tag.document_count = *counts.get(&tag.path).unwrap_or(&0);
    }
    for path in std::iter::once("时间").chain(RECENT_TIME_TAGS.iter().map(|(path, _)| *path)) {
        if counts.get(path).copied().unwrap_or(0) > 0
            && !payload.tags.iter().any(|tag| tag.path == path)
        {
            payload.tags.push(LocalLibraryTagNode {
                path: path.to_string(),
                name: path.rsplit('/').next().unwrap().to_string(),
                root_type: "时间".to_string(),
                parent_path: (path != "时间").then(|| "时间".to_string()),
                depth: usize::from(path != "时间"),
                document_count: *counts.get(path).unwrap_or(&0),
            });
        }
    }
}

fn load_local_library_export_payload(
    root_dir: &str,
) -> Result<Option<LocalLibraryExportPayload>, String> {
    if let Some(payload) = read_local_library_runtime_snapshot_payload(root_dir)? {
        return Ok(Some(payload));
    }

    let export_dir = PathBuf::from(root_dir).join(".ai-index").join("exports");
    let manifest_path = export_dir.join("manifest.json");
    if manifest_path.is_file() {
        return read_local_library_export_manifest_payload(&export_dir, &manifest_path).map(Some);
    }
    read_local_library_runtime_snapshot_payload(root_dir)
}

fn read_local_library_export_manifest_payload(
    export_dir: &PathBuf,
    manifest_path: &PathBuf,
) -> Result<LocalLibraryExportPayload, String> {
    let manifest: ManifestFile = read_json_file(manifest_path)?;
    let documents = read_meta_documents(export_dir, &manifest)?;
    let status_file: Option<StatusFile> = read_optional_json_file(
        &export_dir.join(
            manifest
                .entries
                .as_ref()
                .and_then(|entries| entries.status.clone())
                .unwrap_or_else(|| "status.json".to_string()),
        ),
    )?;
    let tag_counts = count_local_tags(&documents);
    let tags = read_local_tags(export_dir, &manifest, &tag_counts)?;
    let folders = read_local_folders(export_dir, &manifest)?;
    Ok(LocalLibraryExportPayload {
        generated_at: manifest.generated_at.clone(),
        exported_at: status_file
            .as_ref()
            .and_then(|item| item.exported_at.clone()),
        document_count: status_file.and_then(|item| item.document_count),
        documents,
        tags,
        folders,
        by_directory: HashMap::new(),
    })
}

fn read_local_library_runtime_snapshot_payload(
    root_dir: &str,
) -> Result<Option<LocalLibraryExportPayload>, String> {
    let snapshot_path = resolve_runtime_export_catalog_snapshot_path(root_dir);
    let Some(snapshot) =
        read_optional_json_file::<LocalRuntimeExportCatalogSnapshot>(&snapshot_path)?
    else {
        return Ok(None);
    };
    let documents = snapshot
        .documents
        .iter()
        .map(|document| MetaDocument {
            document_id: document.document_id.clone(),
            path: document.path.clone(),
            title: Some(document.title.clone()),
            summary: Some(document.summary.clone()),
            mtime: Some(document.mtime.clone()),
            direct_tags: Some(document.tags.clone()),
            derived_tags: Some(document.derived_tags.clone()),
        })
        .collect::<Vec<_>>();
    let tags = build_local_tags_from_runtime_snapshot(&snapshot.tags, &documents);
    let folders = build_local_folders_from_runtime_snapshot(&documents);
    Ok(Some(LocalLibraryExportPayload {
        generated_at: snapshot
            .generated_at
            .clone()
            .or(snapshot.generated_at_legacy.clone()),
        exported_at: None,
        document_count: Some(documents.len()),
        documents,
        tags,
        folders,
        by_directory: HashMap::new(),
    }))
}

fn build_local_tags_from_runtime_snapshot(
    snapshot_tags: &[LocalRuntimeSnapshotTag],
    documents: &[MetaDocument],
) -> Vec<LocalLibraryTagNode> {
    let tag_counts = count_local_tags(documents);
    snapshot_tags
        .iter()
        .map(|tag| LocalLibraryTagNode {
            path: tag.path.clone(),
            name: tag.name.clone(),
            root_type: tag.root_type.clone(),
            parent_path: tag.parent_path.clone(),
            depth: tag.depth,
            document_count: *tag_counts.get(&tag.path).unwrap_or(&0),
        })
        .collect()
}

fn build_local_folders_from_runtime_snapshot(
    documents: &[MetaDocument],
) -> Vec<LocalLibraryFolderNode> {
    let mut direct_counts = HashMap::<String, usize>::new();
    let mut total_counts = HashMap::<String, usize>::new();
    let mut parent_paths = HashMap::<String, Option<String>>::new();

    for document in documents {
        let normalized_path = normalize_document_path(&document.path);
        let document_dir = normalize_folder_path(
            &PathBuf::from(&normalized_path)
                .parent()
                .map(|value| value.to_string_lossy().replace('\\', "/"))
                .unwrap_or_else(|| ".".to_string()),
        );
        *direct_counts.entry(document_dir.clone()).or_insert(0) += 1;
        for ancestor in expand_folder_ancestor_paths(&document_dir) {
            *total_counts.entry(ancestor.clone()).or_insert(0) += 1;
            parent_paths
                .entry(ancestor.clone())
                .or_insert_with(|| parent_folder_path(&ancestor));
        }
    }

    let mut folders = total_counts
        .into_iter()
        .map(|(path, document_count)| LocalLibraryFolderNode {
            name: file_name_from_path(&path),
            parent_path: parent_paths
                .get(&path)
                .cloned()
                .unwrap_or_else(|| parent_folder_path(&path)),
            direct_document_count: *direct_counts.get(&path).unwrap_or(&0),
            document_count,
            created_at: None,
            updated_at: None,
            path,
        })
        .collect::<Vec<_>>();
    folders.sort_by(|left, right| left.path.cmp(&right.path));
    folders
}

fn expand_folder_ancestor_paths(path: &str) -> Vec<String> {
    let normalized = normalize_folder_path(path);
    if normalized == "." {
        return vec![".".to_string()];
    }
    let parts = normalized.split('/').collect::<Vec<_>>();
    let mut ancestors = vec![".".to_string()];
    for index in 0..parts.len() {
        ancestors.push(parts[..=index].join("/"));
    }
    ancestors
}

fn parent_folder_path(path: &str) -> Option<String> {
    let normalized = normalize_folder_path(path);
    if normalized == "." {
        return None;
    }
    PathBuf::from(&normalized)
        .parent()
        .map(|value| normalize_folder_path(&value.to_string_lossy()))
}

fn read_local_library_files(
    path: Option<String>,
    limit: Option<usize>,
) -> Result<LocalLibraryFileList, String> {
    let binding = read_local_library_binding()?.ok_or_else(|| "当前未绑定文档库".to_string())?;
    let normalized_path = normalize_folder_path(path.as_deref().unwrap_or("."));
    let absolute_path = if normalized_path == "." {
        PathBuf::from(&binding.root_dir)
    } else {
        PathBuf::from(&binding.root_dir).join(&normalized_path)
    };
    let limit = limit.unwrap_or(200);

    if normalized_path != "."
        && !is_native_library_path_visible(
            &normalized_path,
            true,
            &binding.included_hidden_paths,
            binding.hide_dot_files,
            binding.hide_system_folders,
        )
    {
        return Ok(LocalLibraryFileList {
            items: vec![],
            path: normalized_path,
            total: 0,
            limit,
        });
    }

    if !absolute_path.exists() {
        return Ok(LocalLibraryFileList {
            items: vec![],
            path: normalized_path,
            total: 0,
            limit,
        });
    }

    let metadata =
        fs::metadata(&absolute_path).map_err(|error| format!("读取目录信息失败：{error}"))?;
    if !metadata.is_dir() {
        return Err("指定路径不是目录".to_string());
    }

    let mut items = Vec::new();
    for entry in fs::read_dir(&absolute_path).map_err(|error| format!("读取目录失败：{error}"))?
    {
        let entry = entry.map_err(|error| format!("读取目录项失败：{error}"))?;
        let name = entry.file_name().to_string_lossy().to_string();
        let entry_path = if normalized_path == "." {
            name.clone()
        } else {
            format!("{normalized_path}/{name}")
        };
        let entry_metadata = entry.metadata().ok();
        let is_dir = entry_metadata.as_ref().is_some_and(|meta| meta.is_dir());
        if !is_native_library_path_visible(
            &entry_path,
            is_dir,
            &binding.included_hidden_paths,
            binding.hide_dot_files,
            binding.hide_system_folders,
        ) {
            continue;
        }
        items.push(LocalLibraryFileNode {
            path: entry_path,
            name,
            kind: if is_dir { "directory" } else { "file" }.to_string(),
            size: entry_metadata.as_ref().and_then(|meta| {
                if meta.is_dir() {
                    None
                } else {
                    Some(meta.len())
                }
            }),
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
    let binding = read_local_library_binding()?.ok_or_else(|| "当前未绑定文档库".to_string())?;
    let relative_path = normalize_document_path(&request.path);
    let absolute_path = PathBuf::from(&binding.root_dir).join(&relative_path);
    let metadata =
        fs::metadata(&absolute_path).map_err(|error| format!("读取预览文件失败：{error}"))?;
    if !metadata.is_file() {
        return Err("预览目标不是文件".to_string());
    }

    let extension = absolute_path
        .extension()
        .map(|value| value.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let size = metadata.len();
    let updated_at = metadata.modified().ok().map(system_time_to_rfc3339);
    let format = preview_capabilities::format_for_extension(&extension);
    let kind = format
        .as_ref()
        .map(|definition| definition.preview_kind.clone())
        .unwrap_or_else(|| "text".to_string());
    let is_resource = format
        .as_ref()
        .is_some_and(|definition| definition.resource_class == "resource");

    if format.as_ref().is_some_and(|definition| !definition.previewable) {
        return Ok(unsupported_preview(
            &binding.library_id,
            &relative_path,
            size,
            updated_at,
            "当前文件类型已识别，但没有启用内置预览器",
        ));
    }

    if is_resource && size > preview_capabilities::budgets().resource_max_bytes {
        return Ok(unsupported_preview(
            &binding.library_id,
            &relative_path,
            size,
            updated_at,
            "文件过大，当前内置资源预览暂不处理这么大的文件",
        ));
    }
    if !is_resource && size > preview_capabilities::budgets().text_max_bytes {
        return Ok(unsupported_preview(
            &binding.library_id,
            &relative_path,
            size,
            updated_at,
            "文件过大，本轮只提供轻量预览",
        ));
    }

    if kind == "office" {
        eprintln!(
            "[x-file native] preview.resolve kind=office transport=native-fallback path={}",
            relative_path
        );
        return Ok(LocalLibraryPreview {
            library_id: binding.library_id,
            path: relative_path,
            supported: true,
            kind,
            reason: Some("Office 文件由本地轻量预览器读取；也可以使用系统应用打开原文件。".to_string()),
            content: None,
            version: None,
            size,
            updated_at,
            preview_path: None,
            preview_url: None,
            capabilities: build_local_preview_capabilities(false, true, true, false, false),
        });
    }

    eprintln!(
        "[x-file native] preview.resolve kind={} family={} transport=native path={}",
        kind,
        format.as_ref().map(|definition| definition.adapter_family.as_str()).unwrap_or("text-code"),
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
            capabilities: build_local_preview_capabilities(false, true, true, true, is_pdf),
        });
    }

    let buffer =
        fs::read(&absolute_path).map_err(|error| format!("读取预览文件内容失败：{error}"))?;
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
            capabilities: build_local_preview_capabilities(false, false, false, false, false),
        });
    }

    let content =
        String::from_utf8(buffer.clone()).map_err(|error| format!("读取文本预览失败：{error}"))?;
    let can_edit = format.as_ref().is_some_and(|definition| definition.editable)
        && size <= preview_capabilities::budgets().edit_max_bytes;
    let version = if can_edit {
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
        capabilities: build_local_preview_capabilities(
            can_edit,
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
    let canonical_root =
        fs::canonicalize(root_dir).map_err(|error| format!("无法解析文档库根目录：{error}"))?;
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
        hide_dot_files: existing.hide_dot_files,
        hide_system_folders: existing.hide_system_folders,
        folder_open_behavior: existing.folder_open_behavior,
        config_relative_path: existing.config_relative_path,
        export_mode: existing.export_mode,
        initialized,
        initialized_at: if initialized {
            Some(updated_at.clone())
        } else {
            existing.initialized_at
        },
        updated_at,
    };
    write_json_file(
        &x_file_data_dir().join("library-binding.json"),
        &binding_to_stored(&next),
    )?;
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
        hide_dot_files: stored.hide_dot_files.unwrap_or(true),
        hide_system_folders: stored.hide_system_folders.unwrap_or(true),
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
        allowed_extensions: binding
            .as_ref()
            .map(|item| {
                if item.allowed_extensions.is_empty() {
                    default_extensions.clone()
                } else {
                    item.allowed_extensions.clone()
                }
            })
            .unwrap_or_else(|| default_extensions.clone()),
        included_hidden_paths: binding
            .as_ref()
            .map(|item| item.included_hidden_paths.clone())
            .unwrap_or_default(),
        hide_dot_files: binding
            .as_ref()
            .map(|item| item.hide_dot_files)
            .unwrap_or(true),
        hide_system_folders: binding
            .as_ref()
            .map(|item| item.hide_system_folders)
            .unwrap_or(true),
        folder_open_behavior: binding
            .as_ref()
            .map(|item| item.folder_open_behavior.clone())
            .unwrap_or_else(|| "double_click".to_string()),
        config_relative_path: binding
            .as_ref()
            .map(|item| item.config_relative_path.clone())
            .unwrap_or_else(|| ".ai-index/doc-semantic-index.config.json".to_string()),
        can_write: binding.is_some(),
    })
}

fn save_local_library_config(
    request: NativeSaveLibraryConfigRequest,
) -> Result<LocalLibraryConfig, String> {
    let mut binding =
        read_local_library_binding()?.ok_or_else(|| "请先绑定文档库根目录".to_string())?;
    binding.enabled = request.enabled.unwrap_or(binding.enabled);
    if let Some(mirror_root) = request.mirror_root {
        binding.mirror_root = normalize_nullable_path(mirror_root, binding.mirror_root);
    }
    if let Some(allowed_extensions) = request.allowed_extensions {
        binding.allowed_extensions =
            normalize_extensions(allowed_extensions, binding.allowed_extensions);
    }
    if let Some(included_hidden_paths) = request.included_hidden_paths {
        binding.included_hidden_paths =
            normalize_string_list(included_hidden_paths, binding.included_hidden_paths);
    }
    binding.hide_dot_files = request.hide_dot_files.unwrap_or(binding.hide_dot_files);
    binding.hide_system_folders = request
        .hide_system_folders
        .unwrap_or(binding.hide_system_folders);
    binding.folder_open_behavior =
        if request.folder_open_behavior.as_deref() == Some("single_click") {
            "single_click".to_string()
        } else {
            "double_click".to_string()
        };
    binding.updated_at = iso_now();
    write_json_file(
        &x_file_data_dir().join("library-binding.json"),
        &binding_to_stored(&binding),
    )?;
    write_library_config_sidecar(&binding)?;
    read_local_library_config()
}

fn browse_local_host_directories(
    requested_path: Option<String>,
) -> Result<LocalHostDirectoryBrowseResult, String> {
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
    let Some(payload) = read_optional_runtime_status_file(&file_path)? else {
        return Ok(None);
    };
    let stale_reference_at = payload
        .progress_updated_at
        .as_deref()
        .or(payload.last_completed_at.as_deref())
        .or(payload.last_started_at.as_deref());
    let stale_timeout_ms = resolve_runtime_status_stale_timeout_ms(
        payload.state.as_str(),
        payload.running_stage.as_deref(),
    );
    let stale_running = matches!(payload.state.as_str(), "running" | "queued")
        && stale_reference_at
            .and_then(parse_rfc3339_to_unix_ms)
            .is_some_and(|heartbeat_at| {
                chrono::Utc::now()
                    .timestamp_millis()
                    .saturating_sub(heartbeat_at)
                    > stale_timeout_ms
            });
    Ok(Some(LocalLibraryIndexStatus {
        state: if stale_running {
            "failed".to_string()
        } else {
            payload.state
        },
        dirty_reasons: vec![],
        last_requested_at: payload.last_requested_at,
        last_started_at: payload.last_started_at,
        last_completed_at: payload.last_completed_at,
        last_failed_at: if stale_running {
            Some(iso_now())
        } else {
            payload.last_failed_at
        },
        next_allowed_at: payload.next_allowed_at,
        running_task_id: None,
        running_stage: if stale_running {
            None
        } else {
            payload.running_stage
        },
        error_summary: if stale_running {
            Some("本地索引状态长时间没有新进度心跳，上一轮刷新很可能已经中断。请重新触发刷新并观察扫描数量是否继续推进。".to_string())
        } else {
            payload.error_summary
        },
        worker_health: None,
        progress: payload.progress,
        runtime_index_state: read_local_runtime_index_state(root_dir)?,
    }))
}

fn read_optional_runtime_status_file(
    path: &PathBuf,
) -> Result<Option<PersistedRuntimeStatus>, String> {
    if !path.is_file() {
        return Ok(None);
    }
    let raw = fs::read_to_string(path)
        .map_err(|error| format!("读取文件失败 {}: {error}", path.display()))?;
    let value = serde_json::from_str::<Value>(&raw)
        .map_err(|error| format!("解析 JSON 失败 {}: {error}", path.display()))?;
    Ok(normalize_runtime_status_payload(value))
}

fn normalize_runtime_status_payload(value: Value) -> Option<PersistedRuntimeStatus> {
    if let Ok(payload) = serde_json::from_value::<PersistedRuntimeStatus>(value.clone()) {
        return Some(payload);
    }
    let legacy = serde_json::from_value::<LegacyPersistedRuntimeStatus>(value).ok()?;
    let state = map_legacy_runtime_status_state(
        legacy.status.as_deref(),
        legacy.stage.as_deref(),
        legacy.command.as_deref(),
    )?;
    let updated_at = legacy
        .updated_at
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string);
    let last_completed_at = if state == "fresh" {
        updated_at.clone()
    } else {
        None
    };
    let last_failed_at = if state == "failed" {
        updated_at.clone()
    } else {
        None
    };
    let running_stage = legacy
        .stage
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != "finished")
        .map(ToString::to_string);
    Some(PersistedRuntimeStatus {
        state,
        last_requested_at: None,
        last_started_at: updated_at.clone(),
        last_completed_at,
        last_failed_at,
        next_allowed_at: None,
        progress_updated_at: updated_at,
        running_stage,
        error_summary: legacy.error_summary,
        progress: legacy.progress,
    })
}

fn map_legacy_runtime_status_state(
    status: Option<&str>,
    stage: Option<&str>,
    command: Option<&str>,
) -> Option<String> {
    let normalized_status = status.map(str::trim).filter(|value| !value.is_empty());
    match normalized_status {
        Some(
            "fresh" | "stale" | "queued" | "running" | "queue_timeout" | "cooldown" | "failed",
        ) => {
            return normalized_status.map(ToString::to_string);
        }
        Some("finished" | "success") => return Some("fresh".to_string()),
        Some("error") => return Some("failed".to_string()),
        Some("pending") => return Some("queued".to_string()),
        Some(_) => {}
        None => {}
    }
    let normalized_stage = stage.map(str::trim).filter(|value| !value.is_empty());
    if matches!(normalized_stage, Some("finished")) {
        return Some("fresh".to_string());
    }
    if matches!(normalized_stage, Some("failed" | "error")) {
        return Some("failed".to_string());
    }
    if matches!(command.map(str::trim), Some("index" | "export" | "search")) {
        return Some("running".to_string());
    }
    None
}

fn resolve_runtime_status_stale_timeout_ms(state: &str, running_stage: Option<&str>) -> i64 {
    if state == "queued" {
        return 2 * 60_000;
    }
    match running_stage.unwrap_or_default() {
        "export_snapshot" | "search_index" | "export_search" => 15 * 60_000,
        "count_files" | "index" | "index_text" | "init_catalog" => 5 * 60_000,
        _ => 5 * 60_000,
    }
}

fn read_local_runtime_index_state(
    root_dir: &str,
) -> Result<Option<LocalRuntimeIndexState>, String> {
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
        let shard_file: Option<MetaShardFile> =
            read_optional_json_file(&export_dir.join(&shard.path))?;
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
    let mut status = runtime_status
        .unwrap_or_else(|| empty_local_status("fresh", fallback_completed_at.clone()));
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
            active_task_count: 0,
            pending_task_count: 0,
            completed_task_count: document_count,
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

fn count_document_tag_facets(documents: &[LocalLibraryDocumentRecord]) -> HashMap<String, usize> {
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
        return folder_path == "."
            || document_dir == folder_path
            || document_dir.starts_with(&format!("{folder_path}/"));
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

fn build_local_library_tag_directories(
    store: &LocalStoredLibraryTags,
    selected_tag_paths: &[String],
    documents: &[LocalLibraryDocumentRecord],
) -> Vec<LocalLibraryTagDirectory> {
    let active_tag_paths: HashMap<&str, &str> = store
        .tags
        .iter()
        .filter(|tag| tag.status == "active")
        .map(|tag| (tag.id.as_str(), tag.path.as_str()))
        .collect();
    let mut counts_by_directory = HashMap::<String, (usize, Option<String>)>::new();

    for document in documents {
        let mut directory = String::from(".");
        let root = counts_by_directory.entry(directory.clone()).or_default();
        root.0 += 1;
        if root
            .1
            .as_deref()
            .map_or(true, |date| document.updated_at.as_str() > date)
        {
            root.1 = Some(document.updated_at.clone());
        }
        let segments = document
            .path
            .split('/')
            .filter(|segment| !segment.is_empty())
            .collect::<Vec<_>>();
        for segment in segments.iter().take(segments.len().saturating_sub(1)) {
            directory = if directory == "." {
                (*segment).to_owned()
            } else {
                format!("{directory}/{segment}")
            };
            let entry = counts_by_directory.entry(directory.clone()).or_default();
            entry.0 += 1;
            if entry
                .1
                .as_deref()
                .map_or(true, |date| document.updated_at.as_str() > date)
            {
                entry.1 = Some(document.updated_at.clone());
            }
        }
    }

    store
        .folder_tags
        .iter()
        .filter_map(|binding| {
            let path = normalize_folder_path(&binding.folder_path);
            let mut seen_tag_paths = HashSet::new();
            let matched_tag_paths = binding
                .binding_tag_ids
                .iter()
                .filter_map(|tag_id| active_tag_paths.get(tag_id.as_str()).copied())
                .filter(|tag_path| {
                    selected_tag_paths.iter().any(|selected| {
                        *tag_path == selected.as_str()
                            || tag_path.starts_with(&format!("{selected}/"))
                    }) && seen_tag_paths.insert(*tag_path)
                })
                .map(str::to_string)
                .collect::<Vec<_>>();
            if matched_tag_paths.is_empty() {
                return None;
            }
            let (document_count, updated_at) = counts_by_directory
                .get(&path)
                .cloned()
                .unwrap_or_default();
            Some(LocalLibraryTagDirectory {
                path,
                document_count,
                updated_at,
                matched_tag_paths,
            })
        })
        .collect()
}

fn normalize_document_path(value: &str) -> String {
    value
        .trim()
        .replace('\\', "/")
        .trim_start_matches('/')
        .to_string()
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

fn parse_rfc3339_to_unix_ms(value: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|item| item.timestamp_millis())
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
        capabilities: build_local_preview_capabilities(false, false, false, false, false),
    }
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

fn local_http_host_options() -> Vec<Value> {
    let mut options = vec![
        json!({
            "value": "0.0.0.0",
            "interfaceName": Value::Null,
        }),
        json!({
            "value": "127.0.0.1",
            "interfaceName": Value::Null,
        }),
    ];

    for (interface_name, value) in local_ipv4_interfaces() {
        if value == "127.0.0.1"
            || options
                .iter()
                .any(|option| option.get("value").and_then(Value::as_str) == Some(value.as_str()))
        {
            continue;
        }
        options.push(json!({
            "value": value,
            "interfaceName": interface_name,
        }));
    }

    options
}

fn local_ipv4_interfaces() -> Vec<(Option<String>, String)> {
    let output = if cfg!(target_os = "windows") {
        Command::new("ipconfig").output()
    } else if cfg!(target_os = "macos") {
        Command::new("ifconfig").output()
    } else {
        Command::new("ip")
            .args(["-o", "-4", "addr", "show"])
            .output()
    };
    let Ok(output) = output else {
        return Vec::new();
    };
    let text = String::from_utf8_lossy(&output.stdout);

    if cfg!(target_os = "windows") {
        return text
            .lines()
            .filter(|line| line.to_ascii_lowercase().contains("ipv4"))
            .flat_map(|line| {
                line.split_whitespace().filter_map(|token| {
                    let value = token
                        .trim_matches(|character: char| !character.is_ascii_digit() && character != '.');
                    if value.parse::<Ipv4Addr>().is_ok() {
                        Some((None, value.to_string()))
                    } else {
                        None
                    }
                })
            })
            .collect();
    }

    if cfg!(target_os = "macos") {
        let mut current_interface = None;
        let mut interfaces = Vec::new();
        for line in text.lines() {
            if !line.starts_with(' ') && !line.starts_with('\t') {
                current_interface = line.split(':').next().map(str::to_string);
                continue;
            }
            let mut fields = line.split_whitespace();
            if fields.next() != Some("inet") {
                continue;
            }
            if let Some(value) = fields.next().filter(|value| value.parse::<Ipv4Addr>().is_ok()) {
                interfaces.push((current_interface.clone(), value.to_string()));
            }
        }
        return interfaces;
    }

    text.lines()
        .filter_map(|line| {
            let fields = line.split_whitespace().collect::<Vec<_>>();
            let interface_name = fields.get(1)?.to_string();
            let address_index = fields.iter().position(|field| *field == "inet")? + 1;
            let value = fields.get(address_index)?.split('/').next()?;
            if value.parse::<Ipv4Addr>().is_ok() {
                Some((Some(interface_name), value.to_string()))
            } else {
                None
            }
        })
        .collect()
}

fn local_http_access_urls(host: &str, port: u16) -> Vec<String> {
    let hosts = if host == "0.0.0.0" {
        local_http_host_options()
            .into_iter()
            .filter_map(|option| option.get("value").and_then(Value::as_str).map(ToString::to_string))
            .filter(|value| value != "0.0.0.0" && value != "127.0.0.1")
            .collect::<Vec<_>>()
    } else {
        vec![host.to_string()]
    };
    let hosts = if hosts.is_empty() {
        vec!["127.0.0.1".to_string()]
    } else {
        hosts
    };

    let mut seen = HashSet::new();
    hosts
        .into_iter()
        .filter(|value| seen.insert(value.clone()))
        .map(|value| format!("http://{value}:{port}/"))
        .collect()
}

fn normalize_local_http_host(value: &str) -> Result<String, String> {
    let host = value.trim();
    if host == "0.0.0.0" || host.parse::<Ipv4Addr>().is_ok() {
        return Ok(host.to_string());
    }
    Err("HTTP 服务监听地址必须是 IPv4 地址，例如 127.0.0.1、0.0.0.0 或本机网卡地址".to_string())
}

const HTTP_PASSWORD_HASH_ITERATIONS: u32 = 120_000;

fn derive_http_password_hash(password: &str, salt: &str) -> String {
    use sha2::{Digest, Sha256};

    let mut value = format!("{salt}:{password}").into_bytes();
    for _ in 0..HTTP_PASSWORD_HASH_ITERATIONS {
        let mut hasher = Sha256::new();
        hasher.update(&value);
        hasher.update(password.as_bytes());
        hasher.update(salt.as_bytes());
        value = hasher.finalize().to_vec();
    }
    hex_encode(&value)
}

fn hex_encode(value: &[u8]) -> String {
    value.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn create_http_auth_config(username: &str, password: &str) -> Result<Value, String> {
    if username.is_empty() {
        return Err("配置 HTTP 服务认证时必须填写用户名".to_string());
    }
    if username.chars().count() > 128 {
        return Err("HTTP 服务认证用户名不能超过 128 个字符".to_string());
    }
    if password.chars().count() < 8 {
        return Err("HTTP 服务认证密码至少需要 8 个字符".to_string());
    }

    let mut salt_bytes = [0_u8; 16];
    getrandom::fill(&mut salt_bytes).map_err(|error| format!("生成 HTTP 服务认证盐失败：{error}"))?;
    let salt = hex_encode(&salt_bytes);
    Ok(json!({
        "username": username,
        "salt": salt,
        "passwordHash": derive_http_password_hash(password, &salt),
    }))
}

fn resolve_local_http_auth(
    current: &Value,
    request: &NativeSaveHttpServerStateRequest,
) -> Result<Value, String> {
    if request.clear_auth == Some(true) {
        return Ok(Value::Null);
    }

    let username = request
        .auth_username
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let password = request
        .auth_password
        .as_deref()
        .filter(|value| !value.is_empty());
    if username.is_none() && password.is_none() {
        return Ok(current.get("auth").cloned().unwrap_or(Value::Null));
    }

    let current_auth = current.get("auth").filter(|value| value.is_object());
    let effective_username = username.or_else(|| {
        current_auth
            .and_then(|value| value.get("username"))
            .and_then(Value::as_str)
    });
    let Some(effective_username) = effective_username else {
        return Err(String::from("配置 HTTP 服务认证时必须填写用户名"));
    };

    if let Some(password) = password {
        return create_http_auth_config(effective_username, password);
    }

    let Some(current_auth) = current_auth else {
        return Err(String::from("首次配置 HTTP 服务认证时必须填写密码"));
    };
    let mut updated = current_auth.clone();
    updated["username"] = Value::String(String::from(effective_username));
    Ok(updated)
}

fn read_local_http_server_state(state: &mut DesktopState) -> Value {
    let saved = read_local_http_server_saved_config();
    let enabled = saved
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let host = saved
        .get("host")
        .and_then(Value::as_str)
        .unwrap_or("127.0.0.1");
    let port = saved.get("port").and_then(Value::as_u64).unwrap_or(17321);
    let auth_enabled = if host == "127.0.0.1" {
        false
    } else {
        saved
            .get("authEnabled")
            .and_then(Value::as_bool)
            .unwrap_or(true)
    };
    let auth = saved.get("auth").filter(|value| {
        value
            .get("username")
            .and_then(Value::as_str)
            .is_some()
            && value.get("salt").and_then(Value::as_str).is_some()
            && value.get("passwordHash").and_then(Value::as_str).is_some()
    });
    let backend_snapshot = state.backend.snapshot();
    let healthy_http = if enabled {
        let probe_host = if host == "0.0.0.0" {
            "127.0.0.1"
        } else {
            host
        };
        probe_local_http_service(probe_host, port as u16)
    } else {
        false
    };
    let backend_running = matches!(backend_snapshot.state, BackendProcessState::Running);
    let running = backend_running || healthy_http;
    let last_error = if running {
        None
    } else {
        saved
            .get("lastError")
            .and_then(Value::as_str)
            .map(ToString::to_string)
            .or_else(|| backend_snapshot.last_error.clone())
    };
    let lifecycle_state = match (
        enabled,
        running,
        &backend_snapshot.state,
        last_error.as_ref(),
    ) {
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
        "authEnabled": auth_enabled,
        "actualHost": if running { Value::String(host.to_string()) } else { Value::Null },
        "actualPort": if running { json!(port) } else { Value::Null },
        "lifecycleState": lifecycle_state,
        "startedAt": if backend_running {
            backend_snapshot.started_at.map(epoch_millis_to_iso)
        } else {
            None
        },
        "lastError": last_error,
        "authConfigured": auth.is_some(),
        "authUsername": auth.and_then(|value| value.get("username").and_then(Value::as_str)),
        "hostOptions": local_http_host_options(),
        "accessUrls": if running {
            local_http_access_urls(host, port as u16)
        } else {
            Vec::<String>::new()
        },
    })
}

fn read_local_http_server_saved_config() -> Value {
    read_optional_json_file::<Value>(&resolve_local_http_server_state_path())
        .ok()
        .flatten()
        .unwrap_or_else(|| json!({}))
}

fn save_local_http_server_state(
    state: &mut DesktopState,
    request: NativeSaveHttpServerStateRequest,
) -> Result<Value, String> {
    let current = read_local_http_server_state(state);
    let saved_config = read_local_http_server_saved_config();
    let enabled = request.enabled.unwrap_or_else(|| {
        current
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(true)
    });
    let host = normalize_local_http_host(request.host.as_deref().unwrap_or_else(|| {
        current
            .get("host")
            .and_then(Value::as_str)
            .unwrap_or("127.0.0.1")
    }))?;
    if host == "127.0.0.1" && request.auth_enabled == Some(true) {
        return Err(String::from("HTTP 服务仅绑定 127.0.0.1 时不能启用局域网访问认证"));
    }
    if host != "127.0.0.1" && request.auth_enabled == Some(false) {
        return Err(String::from("HTTP 服务绑定非 127.0.0.1 网卡时必须启用局域网访问认证"));
    }
    let auth_enabled = host != "127.0.0.1";
    let port = request
        .port
        .unwrap_or_else(|| current.get("port").and_then(Value::as_u64).unwrap_or(17321) as u16);
    let persistent = request.persistent.unwrap_or_else(|| {
        current
            .get("persistent")
            .and_then(Value::as_bool)
            .unwrap_or_else(default_backend_persistence)
    });
    let auth = resolve_local_http_auth(&saved_config, &request)?;
    if auth_enabled && !auth.is_object() {
        return Err(String::from(
            "请先配置并保存局域网访问用户名和密码，再选择非 127.0.0.1 监听地址",
        ));
    }
    let payload = json!({
        "enabled": enabled,
        "host": host,
        "port": port,
        "persistent": persistent,
        "authEnabled": auth_enabled,
        "lifecycleState": current.get("lifecycleState").cloned().unwrap_or_else(|| Value::String(String::from("disabled"))),
        "lastError": current.get("lastError").cloned().unwrap_or(Value::Null),
        "auth": auth,
    });
    write_json_file(&resolve_local_http_server_state_path(), &payload)?;
    state.backend_persistent = persistent;
    let previous_port = current
        .get("port")
        .and_then(Value::as_u64)
        .unwrap_or(17321) as u16;
    let external_sidecar_updated = state.backend.child.is_none()
        && probe_local_http_service("127.0.0.1", previous_port)
        && sync_external_http_server_config(
            previous_port,
            enabled,
            &host,
            port,
            persistent,
            auth_enabled,
        )?;
    if enabled {
        let current_host = current
            .get("host")
            .and_then(Value::as_str)
            .unwrap_or("127.0.0.1");
        let current_port = current
            .get("port")
            .and_then(Value::as_u64)
            .unwrap_or(17321) as u16;
        let probe_host = if host == "0.0.0.0" {
            "127.0.0.1"
        } else {
            host.as_str()
        };
        if !external_sidecar_updated && (current_host != host
            || current_port != port
            || !probe_local_http_service(probe_host, port))
        {
            let _ = state.backend.stop();
            let _ = state.backend.start();
        }
    } else if !external_sidecar_updated {
        let _ = state.backend.stop();
    }
    Ok(read_local_http_server_state(state))
}

fn sync_external_http_server_config(
    current_port: u16,
    enabled: bool,
    host: &str,
    port: u16,
    persistent: bool,
    auth_enabled: bool,
) -> Result<bool, String> {
    let client = reqwest::blocking::Client::builder()
        .no_proxy()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|error| format!("初始化 HTTP 服务配置同步失败：{error}"))?;
    let response = match client
        .put(format!("http://127.0.0.1:{current_port}/api/server/state"))
        .json(&json!({
            "enabled": enabled,
            "host": host,
            "port": port,
            "persistent": persistent,
            "authEnabled": auth_enabled,
        }))
        .send()
    {
        Ok(response) => response,
        Err(error) if error.is_connect() => return Ok(false),
        Err(error) => return Err(format!("同步 HTTP 服务监听配置失败：{error}")),
    };
    if !response.status().is_success() {
        return Err(format!(
            "HTTP 服务拒绝新的监听配置：{}",
            response.status()
        ));
    }
    if !enabled {
        return Ok(true);
    }

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while std::time::Instant::now() < deadline {
        if let Ok(status) = client
            .get(format!("http://127.0.0.1:{port}/api/server/state"))
            .send()
            .and_then(|response| response.error_for_status())
            .and_then(|response| response.json::<Value>())
        {
            if status.get("running").and_then(Value::as_bool) == Some(true)
                && status.get("actualHost").and_then(Value::as_str) == Some(host)
                && status.get("actualPort").and_then(Value::as_u64) == Some(port as u64)
            {
                return Ok(true);
            }
            if status.get("lifecycleState").and_then(Value::as_str) == Some("failed") {
                let detail = status.get("lastError").and_then(Value::as_str).unwrap_or("未知错误");
                return Err(format!("HTTP 服务未能应用新监听地址：{detail}"));
            }
        }
        thread::sleep(std::time::Duration::from_millis(50));
    }
    Err("等待 HTTP 服务应用新监听地址超时".into())
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
        hide_dot_files: true,
        hide_system_folders: true,
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
        hide_dot_files: Some(binding.hide_dot_files),
        hide_system_folders: Some(binding.hide_system_folders),
        folder_open_behavior: Some(binding.folder_open_behavior.clone()),
        config_relative_path: Some(binding.config_relative_path.clone()),
        export_mode: Some(binding.export_mode.clone()),
        initialized: Some(binding.initialized),
        initialized_at: binding.initialized_at.clone(),
        updated_at: Some(binding.updated_at.clone()),
    }
}

fn write_library_config_sidecar(binding: &LocalLibraryBinding) -> Result<(), String> {
    let relative_path = binding
        .config_relative_path
        .replace('\\', "/")
        .trim_start_matches('/')
        .to_string();
    if relative_path.is_empty()
        || relative_path
            .split('/')
            .any(|segment| segment == "." || segment == "..")
    {
        return Err("文档库配置路径无效".to_string());
    }
    let config_path = PathBuf::from(&binding.root_dir).join(relative_path);
    write_json_file(
        &config_path,
        &json!({
            "libraryId": binding.library_id,
            "rootDir": binding.root_dir,
            "enabled": binding.enabled,
            "mirrorRoot": binding.mirror_root,
            "allowedExtensions": binding.allowed_extensions,
            "includedHiddenPaths": binding.included_hidden_paths,
            "hideDotFiles": binding.hide_dot_files,
            "hideSystemFolders": binding.hide_system_folders,
            "folderOpenBehavior": binding.folder_open_behavior,
            "updatedAt": binding.updated_at,
        }),
    )
}

fn default_allowed_extensions() -> Vec<String> {
    vec![
        ".md".to_string(),
        ".markdown".to_string(),
        ".mdx".to_string(),
        ".txt".to_string(),
        ".text".to_string(),
        ".log".to_string(),
        ".rtf".to_string(),
        ".html".to_string(),
        ".htm".to_string(),
        ".xml".to_string(),
        ".json".to_string(),
        ".map".to_string(),
        ".yaml".to_string(),
        ".yml".to_string(),
        ".css".to_string(),
        ".scss".to_string(),
        ".less".to_string(),
        ".js".to_string(),
        ".jsx".to_string(),
        ".mjs".to_string(),
        ".cjs".to_string(),
        ".ts".to_string(),
        ".tsx".to_string(),
        ".py".to_string(),
        ".go".to_string(),
        ".rs".to_string(),
        ".java".to_string(),
        ".c".to_string(),
        ".h".to_string(),
        ".cpp".to_string(),
        ".cc".to_string(),
        ".hpp".to_string(),
        ".sh".to_string(),
        ".bash".to_string(),
        ".zsh".to_string(),
        ".sql".to_string(),
        ".toml".to_string(),
        ".ini".to_string(),
        ".conf".to_string(),
        ".properties".to_string(),
        ".env".to_string(),
        ".dockerfile".to_string(),
        ".gitignore".to_string(),
        ".editorconfig".to_string(),
        ".csv".to_string(),
        ".tsv".to_string(),
        ".pdf".to_string(),
        ".doc".to_string(),
        ".docx".to_string(),
        ".odt".to_string(),
        ".wps".to_string(),
        ".xls".to_string(),
        ".xlsx".to_string(),
        ".ods".to_string(),
        ".et".to_string(),
        ".numbers".to_string(),
        ".ppt".to_string(),
        ".pptx".to_string(),
        ".odp".to_string(),
        ".key".to_string(),
        ".png".to_string(),
        ".jpg".to_string(),
        ".jpeg".to_string(),
        ".gif".to_string(),
        ".webp".to_string(),
        ".svg".to_string(),
        ".bmp".to_string(),
        ".ico".to_string(),
        ".tif".to_string(),
        ".tiff".to_string(),
        ".heic".to_string(),
        ".heif".to_string(),
        ".avif".to_string(),
        ".mp3".to_string(),
        ".wav".to_string(),
        ".flac".to_string(),
        ".m4a".to_string(),
        ".aac".to_string(),
        ".ogg".to_string(),
        ".opus".to_string(),
        ".aiff".to_string(),
        ".aif".to_string(),
        ".mp4".to_string(),
        ".mov".to_string(),
        ".mkv".to_string(),
        ".webm".to_string(),
        ".avi".to_string(),
        ".wmv".to_string(),
        ".m4v".to_string(),
        ".mpeg".to_string(),
        ".mpg".to_string(),
        ".3gp".to_string(),
    ]
}

fn normalize_nullable_path(value: String, fallback: Option<String>) -> Option<String> {
    let normalized = value.trim().to_string();
    if normalized.is_empty() {
        None
    } else {
        Some(normalized)
    }
    .or(fallback)
}

fn normalize_extensions(value: Vec<String>, _fallback: Vec<String>) -> Vec<String> {
    let mut items = Vec::new();
    let mut seen = HashSet::new();
    for raw in value {
        let normalized = raw.trim().to_lowercase();
        if normalized.is_empty() {
            continue;
        }
        let with_dot = if normalized.starts_with('.') {
            normalized
        } else {
            format!(".{normalized}")
        };
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

fn list_local_child_directories(
    current_path: &str,
) -> Result<Vec<LocalHostDirectoryOption>, String> {
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
    roots
        .first()
        .map(|item| item.path.clone())
        .unwrap_or_else(|| default_library_root_dir())
}

fn resolve_local_host_browse_path(
    requested_path: Option<&str>,
    fallback_path: &str,
) -> Result<String, String> {
    let Some(requested_path) = requested_path
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
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
    fs::metadata(path)
        .map(|meta| meta.is_dir())
        .unwrap_or(false)
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

fn remove_path_if_exists(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    let metadata = fs::metadata(path)
        .map_err(|error| format!("读取待删除路径失败 {}: {error}", path.display()))?;
    if metadata.is_dir() {
        fs::remove_dir_all(path)
            .map_err(|error| format!("删除目录失败 {}: {error}", path.display()))?;
    } else {
        fs::remove_file(path)
            .map_err(|error| format!("删除文件失败 {}: {error}", path.display()))?;
    }
    Ok(())
}

fn clear_native_application_data(
    app: &AppHandle,
) -> Result<NativeResetApplicationDataResult, String> {
    let binding = read_local_library_binding()?;
    let cleared_library_index_dir = binding.as_ref().and_then(|item| {
        let candidate = PathBuf::from(&item.root_dir).join(".ai-index");
        if candidate.exists() {
            Some(candidate)
        } else {
            None
        }
    });
    if let Some(index_dir) = cleared_library_index_dir.as_ref() {
        remove_path_if_exists(index_dir)?;
    }

    let data_dir = x_file_data_dir();
    let app_data_dir = app.path().app_data_dir().ok();
    let office_converter_dir = app_data_dir.as_ref().map(|path| path.join("office-converter"));
    let office_converter_backup = app_data_dir.as_ref().map(|path| {
        path.with_file_name(format!("office-converter-preserved-{}", std::process::id()))
    });
    let server_state_path = resolve_local_http_server_state_path();

    remove_path_if_exists(&data_dir)?;
    if server_state_path != data_dir.join("http-server-state.json") {
        remove_path_if_exists(&server_state_path)?;
    }
    if let (Some(source), Some(backup)) = (office_converter_dir.as_ref(), office_converter_backup.as_ref()) {
        if source.exists() {
            fs::rename(source, backup)
                .map_err(|error| format!("暂存可选 Office 转换器目录失败：{error}"))?;
        }
    }
    if let Some(path) = app_data_dir.as_ref() {
        let result = remove_path_if_exists(path);
        if let (Some(source), Some(backup)) = (office_converter_dir.as_ref(), office_converter_backup.as_ref()) {
            if backup.exists() {
                fs::create_dir_all(source.parent().ok_or_else(|| "应用数据目录无效".to_owned())?)
                    .map_err(|error| format!("恢复可选 Office 转换器目录失败：{error}"))?;
                fs::rename(backup, source)
                    .map_err(|error| format!("恢复可选 Office 转换器目录失败：{error}"))?;
            }
        }
        result?;
    }

    Ok(NativeResetApplicationDataResult {
        data_dir: data_dir.to_string_lossy().to_string(),
        app_data_dir: app_data_dir.map(|path| path.to_string_lossy().to_string()),
        cleared_library_index_dir: cleared_library_index_dir
            .map(|path| path.to_string_lossy().to_string()),
    })
}

fn normalize_optional_text(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn write_json_file<T>(path: &PathBuf, value: &T) -> Result<(), String>
where
    T: Serialize,
{
    let parent = path
        .parent()
        .ok_or_else(|| format!("目标路径缺少父目录：{}", path.display()))?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("创建目录失败 {}: {error}", parent.display()))?;
    let mut buffer = serde_json::to_vec_pretty(value)
        .map_err(|error| format!("序列化 JSON 失败 {}: {error}", path.display()))?;
    buffer.push(b'\n');
    let temp_path = parent.join(format!(
        ".{}.tmp-{}-{}",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("runtime-json"),
        std::process::id(),
        epoch_millis()
    ));
    fs::write(&temp_path, buffer)
        .map_err(|error| format!("写入临时文件失败 {}: {error}", temp_path.display()))?;
    fs::rename(&temp_path, path).map_err(|error| {
        let _ = fs::remove_file(&temp_path);
        format!(
            "原子替换 JSON 文件失败 {} -> {}: {error}",
            temp_path.display(),
            path.display()
        )
    })
}

#[cfg(test)]
mod tests {
    use std::net::TcpListener;
    use super::*;
    use std::sync::{Mutex, OnceLock};

    fn test_env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

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

        let envs = resolve_backend_extra_env(&state_path);
        let env_map: HashMap<String, String> = envs.into_iter().collect();

        assert_eq!(
            env_map.get("X_FILE_SERVER_STATE_PATH"),
            Some(&state_path.to_string_lossy().to_string())
        );
        assert_eq!(
            env_map.get("X_FILE_SERVER_PORT"),
            Some(&"17322".to_string())
        );
        assert_eq!(
            env_map.get("X_FILE_SERVER_HOST"),
            Some(&"127.0.0.1".to_string())
        );
    }

    #[test]
    fn native_http_server_saving_host_preserves_saved_authentication() {
        let _guard = test_env_lock().lock().expect("测试环境锁被污染");
        let temp_dir = env::temp_dir().join(format!("x-file-http-auth-{}", epoch_millis()));
        fs::create_dir_all(&temp_dir).expect("创建临时目录失败");
        let state_path = temp_dir.join("http-server-state.json");
        let saved_auth = json!({
            "username": "lan-user",
            "salt": "saved-salt",
            "passwordHash": "saved-hash"
        });
        write_json_file(
            &state_path,
            &json!({
                "host": "127.0.0.1",
                "port": 17321,
                "auth": saved_auth
            }),
        )
        .expect("写入 HTTP 服务状态失败");

        let previous_path = env::var("X_FILE_SERVER_STATE_PATH").ok();
        unsafe {
            env::set_var("X_FILE_SERVER_STATE_PATH", state_path.to_string_lossy().to_string());
        }

        let saved_config = read_local_http_server_saved_config();
        let resolved_auth = resolve_local_http_auth(
            &saved_config,
            &NativeSaveHttpServerStateRequest {
                enabled: None,
                host: None,
                persistent: None,
                port: None,
                auth_enabled: None,
                auth_username: None,
                auth_password: None,
                clear_auth: None,
            },
        )
        .expect("保存监听地址时应保留已保存的认证凭据");

        match previous_path {
            Some(value) => unsafe { env::set_var("X_FILE_SERVER_STATE_PATH", value) },
            None => unsafe { env::remove_var("X_FILE_SERVER_STATE_PATH") },
        }
        fs::remove_dir_all(&temp_dir).ok();

        assert_eq!(resolved_auth, saved_auth);
    }

    #[test]
    fn probe_local_http_service_对未监听端口返回_false() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("申请临时端口失败");
        let port = listener.local_addr().expect("读取临时端口失败").port();
        drop(listener);

        assert_eq!(probe_local_http_service("127.0.0.1", port), false);
    }

    #[test]
    fn native_文档列表在_manifest_缺失时回退_runtime_snapshot() {
        let _guard = test_env_lock().lock().expect("测试环境锁被污染");
        let nonce = epoch_millis();
        let temp_root = env::temp_dir().join(format!("x-file-native-runtime-fallback-{nonce}"));
        let data_dir = temp_root.join(".x-file-data");
        let library_root = temp_root.join("library-root");
        let runtime_dir = library_root.join(".ai-index").join("runtime");

        fs::create_dir_all(&runtime_dir).expect("创建 runtime 目录失败");
        fs::create_dir_all(&data_dir).expect("创建数据目录失败");

        write_json_file(
            &data_dir.join("library-binding.json"),
            &json!({
                "libraryId": "default",
                "rootDir": library_root.to_string_lossy(),
                "enabled": true,
                "allowedExtensions": [".md"],
                "includedHiddenPaths": [],
                "folderOpenBehavior": "double_click",
                "configRelativePath": ".ai-index/doc-semantic-index.config.json",
                "exportMode": "v2",
                "initialized": true,
                "initializedAt": "2026-06-30T10:00:00Z",
                "updatedAt": "2026-06-30T10:00:00Z"
            }),
        )
        .expect("写入 binding 失败");

        write_json_file(
            &runtime_dir.join("export-catalog-snapshot.json"),
            &json!({
                "version": 1,
                "generatedAt": "2026-06-30T10:01:00Z",
                "tags": [
                    {
                        "path": "主题/示例",
                        "name": "示例",
                        "rootType": "主题",
                        "parentPath": null,
                        "depth": 0
                    }
                ],
                "documents": [
                    {
                        "documentId": "doc_1",
                        "path": "docs/a.md",
                        "title": "A",
                        "summary": "alpha",
                        "tags": ["主题/示例"],
                        "derivedTags": [],
                        "mtime": "2026-06-30T10:01:00Z"
                    }
                ]
            }),
        )
        .expect("写入 runtime snapshot 失败");

        let previous_data_dir = env::var("X_FILE_DATA_DIR").ok();
        unsafe {
            env::set_var("X_FILE_DATA_DIR", data_dir.to_string_lossy().to_string());
        }

        let result = read_local_library_documents(NativeListDocumentsRequest {
            browse_mode: "folder".to_string(),
            selected_folder_path: Some("docs".to_string()),
            selected_tag_path: None,
            selected_tag_paths: None,
            selected_favorite_id: None,
            keyword: None,
            search_scope: None,
            search_mode: None,
            updated_at_order: None,
            offset: Some(0),
            limit: Some(20),
        })
        .expect("读取本地文档列表失败");

        match previous_data_dir {
            Some(value) => unsafe {
                env::set_var("X_FILE_DATA_DIR", value);
            },
            None => unsafe {
                env::remove_var("X_FILE_DATA_DIR");
            },
        }
        fs::remove_dir_all(&temp_root).ok();

        assert_eq!(result.total, 1);
        assert_eq!(result.items.len(), 1);
        assert_eq!(result.items[0].path, "docs/a.md");
        assert_eq!(result.items[0].title, "A");
        assert_eq!(
            result
                .directory_status
                .as_ref()
                .and_then(|status| status.generated_at.clone()),
            Some("2026-06-30T10:01:00Z".to_string())
        );
    }

    #[test]
    fn native_近期标签读取时纠正旧索引并在跨天后更新缓存() {
        let temp_root = env::temp_dir().join(format!("x-file-recent-tags-{}", epoch_millis()));
        let today = chrono::NaiveDate::from_ymd_opt(2026, 10, 26).unwrap();
        let stale_tags = RECENT_TIME_TAGS.iter().map(|(path, _)| *path).collect::<Vec<_>>();
        let mut documents = vec![];
        for days in [0, 2, 3, 6, 7, 29, 30, -1] {
            let local_time = (today - chrono::Duration::days(days)).and_hms_opt(0, 30, 0).unwrap();
            let time = chrono::TimeZone::from_local_datetime(&chrono::Local, &local_time)
                .single().unwrap().to_rfc3339();
            documents.push(json!({
                "documentId": format!("day-{days}"), "path": format!("day-{days}.md"),
                "title": "测试", "summary": "", "mtime": time,
                "tags": ["主题/保留", "时间/最近3天"],
                "derivedTags": ["类型/文本/Markdown", "时间/2026/10", "时间/最近7天", "时间/最近30天"]
            }));
        }
        documents[0]["tags"] = json!(["主题/保留"]);
        documents[0]["derivedTags"] = json!(["类型/文本/Markdown", "时间/2026/10"]);
        for (id, time) in [("july", "2026-07-21T14:30:00Z"), ("invalid", "invalid")] {
            documents.push(json!({
                "documentId": id, "path": format!("{id}.md"), "title": "测试", "summary": "",
                "mtime": time, "tags": stale_tags, "derivedTags": stale_tags
            }));
        }
        for use_runtime in [true, false] {
            let root = temp_root.join(if use_runtime { "runtime-source" } else { "export-source" });
            let source = if use_runtime {
                let source = root.join(".ai-index/runtime/export-catalog-snapshot.json");
                write_json_file(&source, &json!({
                    "version": 1, "generatedAt": "2026-07-21T00:00:00Z",
                    "tags": [], "documents": documents
                })).unwrap();
                source
            } else {
                let export_dir = root.join(".ai-index/exports");
                let legacy = documents.iter().map(|item| json!({
                    "document_id": item["documentId"], "path": item["path"],
                    "mtime": item["mtime"], "direct_tags": item["tags"],
                    "derived_tags": item["derivedTags"]
                })).collect::<Vec<_>>();
                write_json_file(&export_dir.join("meta.json"), &json!({ "documents": legacy })).unwrap();
                let source = export_dir.join("manifest.json");
                write_json_file(&source, &json!({
                    "generated_at": "2026-07-21T00:00:00Z", "meta_shards": [{ "path": "meta.json" }]
                })).unwrap();
                source
            };
            let before = fs::read(&source).unwrap();
            let payload = read_local_library_export_payload_on_date(root.to_str().unwrap(), today)
                .unwrap().unwrap();
            let recent_paths = |payload: &LocalLibraryExportPayload, tag: &str| {
                payload.documents.iter().filter(|document| {
                    document.derived_tags.as_ref().is_some_and(|tags| tags.iter().any(|path| path == tag))
                }).map(|document| document.path.as_str().to_string()).collect::<Vec<_>>()
            };
            for ((tag, _), expected) in RECENT_TIME_TAGS.iter().zip([2, 4, 6]) {
                assert_eq!(recent_paths(&payload, tag).len(), expected);
                assert_eq!(payload.tags.iter().find(|node| node.path == *tag).unwrap().document_count, expected);
            }
            assert_eq!(recent_paths(&payload, "时间/最近3天"), vec!["day-0.md", "day-2.md"]);
            assert!(payload.documents[0].direct_tags.as_ref().unwrap().contains(&"主题/保留".to_string()));
            assert!(payload.documents[0].derived_tags.as_ref().unwrap().contains(&"时间/2026/10".to_string()));
            let cached = read_local_library_export_payload_on_date(root.to_str().unwrap(), today).unwrap().unwrap();
            assert!(Arc::ptr_eq(&payload, &cached));
            let tomorrow = read_local_library_export_payload_on_date(
                root.to_str().unwrap(), today.succ_opt().unwrap(),
            ).unwrap().unwrap();
            assert!(!Arc::ptr_eq(&payload, &tomorrow));
            assert_eq!(recent_paths(&tomorrow, "时间/最近3天"), vec!["day-0.md", "day--1.md"]);
            assert_eq!(fs::read(&source).unwrap(), before);
        }
        fs::remove_dir_all(temp_root).ok();
    }

    #[test]
    fn native_修改时间先全局排序再分页() {
        let _guard = test_env_lock().lock().expect("测试环境锁被污染");
        let temp_root = env::temp_dir().join(format!("x-file-time-sort-{}", epoch_millis()));
        let data_dir = temp_root.join("data");
        let library_root = temp_root.join("library");
        let runtime_dir = library_root.join(".ai-index/runtime");
        fs::create_dir_all(&runtime_dir).expect("创建测试目录失败");
        fs::create_dir_all(&data_dir).expect("创建数据目录失败");
        write_json_file(
            &data_dir.join("library-binding.json"),
            &json!({
                "libraryId": "default", "rootDir": library_root.to_string_lossy(),
                "enabled": true, "allowedExtensions": [".md"], "includedHiddenPaths": [],
                "folderOpenBehavior": "double_click",
                "configRelativePath": ".ai-index/doc-semantic-index.config.json",
                "exportMode": "v2", "initialized": true,
                "initializedAt": "2026-10-26T00:00:00Z", "updatedAt": "2026-10-26T00:00:00Z"
            }),
        ).expect("写入测试绑定失败");
        let documents = [
            ("a.md", "2026-10-26T10:00:00+08:00"),
            ("b.md", "2026-10-26T03:00:00Z"),
            ("c.md", "2026-10-26T02:00:00Z"),
            ("d.md", "2025-01-01T00:00:00Z"),
            ("invalid.md", "invalid"),
        ];
        write_json_file(
            &runtime_dir.join("export-catalog-snapshot.json"),
            &json!({
                "version": 1, "generatedAt": "2026-10-26T00:00:00Z", "tags": [],
                "documents": documents.iter().map(|(path, mtime)| json!({
                    "documentId": path, "path": path, "title": path, "summary": "",
                    "tags": [], "derivedTags": [], "mtime": mtime
                })).collect::<Vec<_>>()
            }),
        ).expect("写入测试快照失败");
        let previous_data_dir = env::var("X_FILE_DATA_DIR").ok();
        unsafe { env::set_var("X_FILE_DATA_DIR", &data_dir); }
        let mut results = Vec::new();
        for mode in ["folder", "tag"] {
            for order in [Some("asc"), Some("desc"), None] {
                let mut pages = Vec::new();
                for offset in (0..documents.len()).step_by(2) {
                    let request = serde_json::from_value(json!({
                        "browseMode": mode, "updatedAtOrder": order, "offset": offset, "limit": 2
                    })).expect("解析测试请求失败");
                    pages.push(read_local_library_documents(request));
                }
                results.push((order, pages));
            }
        }
        match previous_data_dir {
            Some(value) => unsafe { env::set_var("X_FILE_DATA_DIR", value); },
            None => unsafe { env::remove_var("X_FILE_DATA_DIR"); },
        }
        fs::remove_dir_all(&temp_root).ok();
        for (order, pages) in results {
            let expected = match order {
                Some("asc") => vec!["invalid.md", "d.md", "a.md", "c.md", "b.md"],
                Some("desc") => vec!["b.md", "a.md", "c.md", "d.md", "invalid.md"],
                _ => vec!["a.md", "b.md", "c.md", "d.md", "invalid.md"],
            };
            let mut paths = Vec::new();
            for page in pages {
                let page = page.expect("读取测试分页失败");
                assert_eq!(page.total, documents.len());
                paths.extend(page.items.into_iter().map(|item| item.path));
            }
            assert_eq!(paths, expected);
        }
    }

    #[test]
    fn native_标签交叉计数覆盖完整交集且不随分页变化() {
        let _guard = test_env_lock().lock().expect("测试环境锁被污染");
        let temp_root = env::temp_dir().join(format!("x-file-tag-facets-{}", epoch_millis()));
        let data_dir = temp_root.join("data");
        let library_root = temp_root.join("library");
        fs::create_dir_all(&data_dir).expect("创建测试数据目录失败");
        write_json_file(
            &data_dir.join("library-binding.json"),
            &json!({
                "libraryId": "default", "rootDir": library_root.to_string_lossy(),
                "enabled": true, "allowedExtensions": [".md"], "includedHiddenPaths": [],
                "folderOpenBehavior": "double_click",
                "configRelativePath": ".ai-index/doc-semantic-index.config.json",
                "exportMode": "v2", "initialized": true,
                "initializedAt": "2026-10-26T00:00:00Z", "updatedAt": "2026-10-26T00:00:00Z"
            }),
        ).expect("写入测试绑定失败");
        let work = "工作/售前";
        let maidige = "客户/麦迪格";
        let dongyue = "客户/东岳";
        let documents = (0..654).map(|index| {
            let presales = index < 60 || index >= 501;
            let mut tags = Vec::new();
            let mut derived_tags = vec!["类型/文本/Markdown"];
            if presales {
                tags.push(work);
                derived_tags.push(work);
            }
            if (56..501).contains(&index) {
                tags.push(maidige);
            } else if index >= 501 {
                tags.push(dongyue);
            }
            json!({
                "documentId": format!("doc-{index:04}"), "path": format!("{index:04}.md"),
                "title": "测试", "summary": "", "mtime": "2026-10-26T00:00:00Z",
                "tags": tags, "derivedTags": derived_tags
            })
        }).collect::<Vec<_>>();
        write_json_file(
            &library_root.join(".ai-index/runtime/export-catalog-snapshot.json"),
            &json!({
                "version": 1, "generatedAt": "2026-10-26T00:00:00Z",
                "tags": [], "documents": documents
            }),
        ).expect("写入测试快照失败");

        let previous_data_dir = env::var("X_FILE_DATA_DIR").ok();
        unsafe { env::set_var("X_FILE_DATA_DIR", &data_dir); }
        let mut results = Vec::new();
        for (selected, total, maidige_count, dongyue_count, work_count) in [
            (vec![], 654, 445, 153, 213),
            (vec![work], 213, 4, 153, 213),
            (vec![work, maidige], 4, 4, 0, 4),
            (vec![dongyue], 153, 0, 153, 153),
            (vec![work, dongyue], 153, 0, 153, 153),
        ] {
            for limit in [17, 60] {
                let mut pages = Vec::new();
                for offset in (0..total + limit).step_by(limit) {
                    let request = serde_json::from_value(json!({
                        "browseMode": "tag", "selectedTagPaths": selected,
                        "offset": offset, "limit": limit
                    })).expect("解析测试请求失败");
                    pages.push(read_local_library_documents(request));
                }
                results.push((selected.clone(), total, maidige_count, dongyue_count, work_count, pages));
            }
        }
        match previous_data_dir {
            Some(value) => unsafe { env::set_var("X_FILE_DATA_DIR", value); },
            None => unsafe { env::remove_var("X_FILE_DATA_DIR"); },
        }
        fs::remove_dir_all(&temp_root).ok();

        for (selected, total, maidige_count, dongyue_count, work_count, pages) in results {
            let mut first_counts = None;
            let mut ids = HashSet::new();
            for page in pages {
                let page = page.expect("读取测试分页失败");
                assert_eq!(page.total, total);
                assert!(page.items.len() <= page.limit);
                for (path, expected) in [
                    (maidige, maidige_count), (dongyue, dongyue_count), (work, work_count),
                    ("客户", maidige_count + dongyue_count), ("工作", work_count),
                    ("类型", total), ("类型/文本", total),
                ] {
                    assert_eq!(page.tag_facet_counts.get(path).copied().unwrap_or(0), expected, "{selected:?}: {path}");
                }
                if let Some(counts) = &first_counts {
                    assert_eq!(&page.tag_facet_counts, counts);
                } else {
                    first_counts = Some(page.tag_facet_counts.clone());
                }
                for document in page.items {
                    assert!(selected.iter().all(|path| {
                        document.tags.iter().chain(document.derived_tags.iter()).any(|tag| tag == path)
                    }));
                    assert!(ids.insert(document.document_id));
                }
            }
            assert_eq!(ids.len(), total);
        }
    }

    #[test]
    fn native_runtime_status_有新进度心跳时不误判卡死() {
        let _guard = test_env_lock().lock().expect("测试环境锁被污染");
        let nonce = epoch_millis();
        let root_dir = env::temp_dir().join(format!("x-file-native-runtime-status-{nonce}"));
        let ai_index_dir = root_dir.join(".ai-index");
        fs::create_dir_all(&ai_index_dir).expect("创建 .ai-index 目录失败");
        write_json_file(
            &ai_index_dir.join("runtime-status.json"),
            &json!({
                "state": "running",
                "lastRequestedAt": "2026-06-30T10:00:00Z",
                "lastStartedAt": "2026-06-30T10:00:00Z",
                "progressUpdatedAt": chrono::Utc::now().to_rfc3339(),
                "runningStage": "index_text",
                "errorSummary": null,
                "progress": {
                    "scannedCount": 321,
                    "indexedCount": 128,
                    "skippedCount": 7,
                    "failedCount": 0,
                    "unchangedCount": 186,
                    "totalCount": 1000,
                    "maxConcurrency": 1
                }
            }),
        )
        .expect("写入 runtime-status 失败");

        let status = read_local_runtime_status(&root_dir.to_string_lossy())
            .expect("读取 runtime status 失败")
            .expect("runtime status 不应为空");
        fs::remove_dir_all(&root_dir).ok();

        assert_eq!(status.state, "running");
        assert_eq!(status.running_stage.as_deref(), Some("index_text"));
        assert_eq!(
            status
                .progress
                .as_ref()
                .and_then(|progress| progress.total_count),
            Some(1000)
        );
        assert!(status.error_summary.is_none());
    }

    #[test]
    fn native_runtime_status_导出阶段短暂无进度时不误判卡死() {
        let _guard = test_env_lock().lock().expect("测试环境锁被污染");
        let nonce = epoch_millis();
        let root_dir = env::temp_dir().join(format!("x-file-native-export-runtime-status-{nonce}"));
        let ai_index_dir = root_dir.join(".ai-index");
        fs::create_dir_all(&ai_index_dir).expect("创建 .ai-index 目录失败");
        let stale_at = (chrono::Utc::now() - chrono::Duration::seconds(61)).to_rfc3339();
        write_json_file(
            &ai_index_dir.join("runtime-status.json"),
            &json!({
                "state": "running",
                "lastRequestedAt": "2026-06-30T10:00:00Z",
                "lastStartedAt": "2026-06-30T10:00:00Z",
                "progressUpdatedAt": stale_at,
                "runningStage": "export_snapshot",
                "errorSummary": null,
                "progress": {
                    "scannedCount": 2310,
                    "indexedCount": 2264,
                    "skippedCount": 0,
                    "failedCount": 0,
                    "unchangedCount": 46,
                    "totalCount": 19529,
                    "maxConcurrency": 1
                }
            }),
        )
        .expect("写入 runtime-status 失败");

        let status = read_local_runtime_status(&root_dir.to_string_lossy())
            .expect("读取 runtime status 失败")
            .expect("runtime status 不应为空");
        fs::remove_dir_all(&root_dir).ok();

        assert_eq!(status.state, "running");
        assert_eq!(status.running_stage.as_deref(), Some("export_snapshot"));
        assert!(status.error_summary.is_none());
    }

    #[test]
    fn 退出初始化时若恢复尺寸与初始化一致则放大到一倍半() {
        let initialization_geometry = MainWindowGeometry {
            position_x: 100,
            position_y: 120,
            width: INITIALIZATION_WINDOW_WIDTH as u32,
            height: INITIALIZATION_WINDOW_HEIGHT as u32,
        };

        let next_geometry = resolve_post_initialization_workbench_geometry(
            Some(initialization_geometry),
            Some(initialization_geometry),
        )
        .expect("应生成工作台尺寸");

        assert_eq!(
            next_geometry.width,
            (INITIALIZATION_WINDOW_WIDTH * POST_INITIALIZATION_WORKBENCH_SCALE).round() as u32
        );
        assert_eq!(
            next_geometry.height,
            (INITIALIZATION_WINDOW_HEIGHT * POST_INITIALIZATION_WORKBENCH_SCALE).round() as u32
        );
    }

    #[test]
    fn 退出初始化时已有自定义主窗口尺寸则优先恢复() {
        let initialization_geometry = MainWindowGeometry {
            position_x: 100,
            position_y: 120,
            width: INITIALIZATION_WINDOW_WIDTH as u32,
            height: INITIALIZATION_WINDOW_HEIGHT as u32,
        };
        let customized_workbench_geometry = MainWindowGeometry {
            position_x: 32,
            position_y: 48,
            width: 1720,
            height: 1180,
        };

        let next_geometry = resolve_post_initialization_workbench_geometry(
            Some(initialization_geometry),
            Some(customized_workbench_geometry),
        )
        .expect("应恢复自定义工作台尺寸");

        assert_eq!(
            next_geometry.position_x,
            customized_workbench_geometry.position_x
        );
        assert_eq!(
            next_geometry.position_y,
            customized_workbench_geometry.position_y
        );
        assert_eq!(next_geometry.width, customized_workbench_geometry.width);
        assert_eq!(next_geometry.height, customized_workbench_geometry.height);
    }

    #[test]
    fn native_runtime_status_兼容旧版_finished_payload() {
        let _guard = test_env_lock().lock().expect("测试环境锁被污染");
        let nonce = epoch_millis();
        let root_dir = env::temp_dir().join(format!("x-file-native-legacy-runtime-status-{nonce}"));
        let ai_index_dir = root_dir.join(".ai-index");
        fs::create_dir_all(&ai_index_dir).expect("创建 .ai-index 目录失败");
        write_json_file(
            &ai_index_dir.join("runtime-status.json"),
            &json!({
                "version": 1,
                "command": "index",
                "status": "finished",
                "stage": "finished",
                "updatedAt": "2026-07-06T09:56:22.640Z",
                "taskId": "c563e4c4-afdd-4b75-a30e-b5af74ef4acd",
                "taskType": "affairs.library_index",
                "errorSummary": null,
                "progress": {
                    "scannedCount": 17320,
                    "indexedCount": 0,
                    "skippedCount": 0,
                    "failedCount": 0,
                    "unchangedCount": 17320,
                    "totalCount": 17320,
                    "maxConcurrency": 1
                }
            }),
        )
        .expect("写入旧版 runtime-status 失败");

        let status = read_local_runtime_status(&root_dir.to_string_lossy())
            .expect("读取旧版 runtime status 失败")
            .expect("旧版 runtime status 不应为空");
        fs::remove_dir_all(&root_dir).ok();

        assert_eq!(status.state, "fresh");
        assert_eq!(
            status.last_completed_at.as_deref(),
            Some("2026-07-06T09:56:22.640Z")
        );
        assert_eq!(status.running_stage, None);
        assert_eq!(
            status
                .progress
                .as_ref()
                .and_then(|progress| progress.total_count),
            Some(17320)
        );
    }

    #[test]
    fn native_目录访问会写入索引优先级提示并保持最近访问优先() {
        let _guard = test_env_lock().lock().expect("测试环境锁被污染");
        let nonce = epoch_millis();
        let root_dir = env::temp_dir().join(format!("x-file-native-priority-hint-{nonce}"));
        fs::create_dir_all(root_dir.join(".ai-index").join("runtime"))
            .expect("创建 runtime 目录失败");
        write_json_file(
            &root_dir.join(".ai-index").join("runtime-status.json"),
            &json!({
                "state": "running",
                "lastRequestedAt": "2026-06-30T10:00:00Z",
                "lastStartedAt": "2026-06-30T10:00:00Z",
                "progressUpdatedAt": chrono::Utc::now().to_rfc3339(),
                "runningStage": "index_text",
                "errorSummary": null
            }),
        )
        .expect("写入 runtime status 失败");

        record_native_directory_priority_hint(&root_dir.to_string_lossy(), Some("深层/目录"))
            .expect("写入第一个 priority hint 失败");
        record_native_directory_priority_hint(&root_dir.to_string_lossy(), Some("浅层"))
            .expect("写入第二个 priority hint 失败");
        record_native_directory_priority_hint(&root_dir.to_string_lossy(), Some("深层/目录"))
            .expect("重复写入 priority hint 失败");

        let hints: LocalRuntimePriorityHints =
            read_json_file(&priority_hints_path(&root_dir.to_string_lossy()))
                .expect("读取 priority hint 失败");
        fs::remove_dir_all(&root_dir).ok();

        assert_eq!(
            hints.paths,
            vec!["深层/目录".to_string(), "浅层".to_string()]
        );
    }

    #[test]
    fn native_索引运行中无快照时文档列表返回空结果而不是失败() {
        let _guard = test_env_lock().lock().expect("测试环境锁被污染");
        let nonce = epoch_millis();
        let temp_root = env::temp_dir().join(format!("x-file-native-running-no-snapshot-{nonce}"));
        let data_dir = temp_root.join(".x-file-data");
        let library_root = temp_root.join("library-root");
        let ai_index_dir = library_root.join(".ai-index");

        fs::create_dir_all(&ai_index_dir).expect("创建 .ai-index 目录失败");
        fs::create_dir_all(&data_dir).expect("创建数据目录失败");

        write_json_file(
            &data_dir.join("library-binding.json"),
            &json!({
                "libraryId": "default",
                "rootDir": library_root.to_string_lossy(),
                "enabled": true,
                "allowedExtensions": [".md"],
                "includedHiddenPaths": [],
                "folderOpenBehavior": "double_click",
                "configRelativePath": ".ai-index/doc-semantic-index.config.json",
                "exportMode": "v2",
                "initialized": true,
                "initializedAt": "2026-06-30T10:00:00Z",
                "updatedAt": "2026-06-30T10:00:00Z"
            }),
        )
        .expect("写入 binding 失败");
        write_json_file(
            &ai_index_dir.join("runtime-status.json"),
            &json!({
                "state": "running",
                "lastRequestedAt": "2026-06-30T10:00:00Z",
                "lastStartedAt": "2026-06-30T10:00:00Z",
                "progressUpdatedAt": chrono::Utc::now().to_rfc3339(),
                "runningStage": "count_files",
                "errorSummary": null,
                "progress": {
                    "scannedCount": 10,
                    "indexedCount": 0,
                    "skippedCount": 0,
                    "failedCount": 0,
                    "unchangedCount": 0,
                    "totalCount": 7,
                    "maxConcurrency": 1
                }
            }),
        )
        .expect("写入 runtime-status 失败");

        let previous_data_dir = env::var("X_FILE_DATA_DIR").ok();
        unsafe {
            env::set_var("X_FILE_DATA_DIR", data_dir.to_string_lossy().to_string());
        }

        let result = read_local_library_documents(NativeListDocumentsRequest {
            browse_mode: "folder".to_string(),
            selected_folder_path: Some(".".to_string()),
            selected_tag_path: None,
            selected_tag_paths: None,
            selected_favorite_id: None,
            keyword: None,
            search_scope: None,
            search_mode: None,
            updated_at_order: None,
            offset: Some(0),
            limit: Some(20),
        })
        .expect("索引运行中无快照不应导致文档列表失败");

        match previous_data_dir {
            Some(value) => unsafe {
                env::set_var("X_FILE_DATA_DIR", value);
            },
            None => unsafe {
                env::remove_var("X_FILE_DATA_DIR");
            },
        }
        fs::remove_dir_all(&temp_root).ok();

        assert_eq!(result.total, 0);
        assert_eq!(result.items.len(), 0);
        assert_eq!(
            result
                .directory_status
                .as_ref()
                .map(|status| status.state.as_str()),
            Some("running")
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_原生视图相同_frame_不应触发重绘() {
        let current = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(272.0, 900.0));
        let requested = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(272.0, 900.0));

        assert!(macos_native_frame_matches(current, requested));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_原生视图_frame_变化时必须触发重绘() {
        let current = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(272.0, 900.0));
        let requested = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(280.0, 900.0));

        assert!(!macos_native_frame_matches(current, requested));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_原生侧栏必须使用_sidebar_材质() {
        assert_eq!(
            macos_native_sidebar_material(),
            NSVisualEffectMaterial::Sidebar
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_原生侧栏必须模糊窗口后的桌面() {
        assert_eq!(
            macos_native_sidebar_blending_mode(),
            NSVisualEffectBlendingMode::BehindWindow
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_原生侧栏必须常驻激活状态() {
        assert_eq!(macos_native_sidebar_state(), NSVisualEffectState::Active);
    }
}

fn epoch_millis_to_iso(value: u64) -> String {
    chrono::DateTime::<chrono::Utc>::from(UNIX_EPOCH + std::time::Duration::from_millis(value))
        .to_rfc3339()
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
fn set_macos_window_background_mode(
    window: &WebviewWindow,
    transparent: bool,
) -> Result<(), String> {
    let native_window = window.clone();
    window
        .run_on_main_thread(move || unsafe {
            let Ok(ns_window_ptr) = native_window.ns_window() else {
                return;
            };
            let ns_window: &NSWindow = &*ns_window_ptr.cast();
            let background_color = if transparent {
                NSColor::clearColor()
            } else {
                NSColor::colorWithSRGBRed_green_blue_alpha(0.176, 0.196, 0.239, 1.0)
            };
            ns_window.setBackgroundColor(Some(&background_color));
            ns_window.setOpaque(!transparent);
        })
        .map_err(|error| error.to_string())
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
fn configure_macos_native_glass_sidebars(app: &AppHandle) -> tauri::Result<()> {
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
    native_sidebar_state.mark_initialized(window.label());
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
    let left_width = sidebar_state
        .rendered_left_width
        .min(content_width)
        .max(0.0);
    let right_width = sidebar_state
        .rendered_right_width
        .min(content_width)
        .max(0.0);
    let right_effect_width = if right_visible {
        right_width
    } else {
        0.0
    };
    let right_origin_x = (content_width - right_effect_width).max(0.0);

    apply_macos_native_sidebar_frame(
        left_view_ptr,
        NSRect::new(
            NSPoint::new(0.0, 0.0),
            NSSize::new(left_width, content_height),
        ),
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
        left_view_ptr =
            ensure_macos_native_sidebar_view(&content_view, None, sidebar_appearance.as_deref());
    }
    if right_view_ptr.is_none() {
        right_view_ptr =
            ensure_macos_native_sidebar_view(&content_view, None, sidebar_appearance.as_deref());
    }

    native_sidebar_state.update_view_pointers(window_label, left_view_ptr, right_view_ptr);
}

#[cfg(target_os = "macos")]
fn macos_native_frame_matches(current: NSRect, requested: NSRect) -> bool {
    const FRAME_EPSILON: f64 = 0.01;

    (current.origin.x - requested.origin.x).abs() <= FRAME_EPSILON
        && (current.origin.y - requested.origin.y).abs() <= FRAME_EPSILON
        && (current.size.width - requested.size.width).abs() <= FRAME_EPSILON
        && (current.size.height - requested.size.height).abs() <= FRAME_EPSILON
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
                let frame_changed =
                    !macos_native_frame_matches(webview_view.frame(), content_bounds);

                if frame_changed {
                    webview_view.setFrame(content_bounds);
                    webview_view.setNeedsDisplay(true);
                    webview_view.displayIfNeeded();
                }
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
        apply_macos_native_sidebar_appearance(view, appearance);

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
    effect_view.setMaterial(macos_native_sidebar_material());
    // 侧边栏属于窗口内部语义，在窗口内混合模糊，不模糊桌面。
    effect_view.setBlendingMode(macos_native_sidebar_blending_mode());
    effect_view.setState(macos_native_sidebar_state());
    apply_macos_native_sidebar_appearance(&effect_view, appearance);
    effect_view.setAutoresizingMask(MACOS_NATIVE_LEFT_SIDEBAR_AUTOREZING_MASK);
    // 注意：不要给 NSVisualEffectView 设 layerContentsRedrawPolicy（会缓存成不透的静态层，
    // 导致 behindWindow 的桌面磨砂失效）。保持默认由系统管理其 layer。
    effect_view.setHidden(true);
    content_view.addSubview_positioned_relativeTo(&effect_view, NSWindowOrderingMode::Below, None);
    Some((&*effect_view) as *const NSVisualEffectView as usize)
}

#[cfg(target_os = "macos")]
fn macos_native_sidebar_blending_mode() -> NSVisualEffectBlendingMode {
    // 模糊窗口“之后”的桌面，才能得到父仓库那种能看见桌面色彩的磨砂效果。
    NSVisualEffectBlendingMode::BehindWindow
}

#[cfg(target_os = "macos")]
fn macos_native_sidebar_material() -> NSVisualEffectMaterial {
    NSVisualEffectMaterial::Sidebar
}

#[cfg(target_os = "macos")]
fn macos_native_sidebar_state() -> NSVisualEffectState {
    // 对齐 DeepSeek Harness 的 visualEffectState: "active"——材质常驻激活，
    // 前后台切换不退化，磨砂稳定。
    NSVisualEffectState::Active
}

#[cfg(target_os = "macos")]
fn apply_macos_native_sidebar_appearance(
    view: &NSVisualEffectView,
    appearance: Option<&NSAppearance>,
) {
    let appearance_changed = match (view.appearance(), appearance) {
        (Some(current), Some(requested)) => current.name() != requested.name(),
        (None, None) => false,
        _ => true,
    };

    if appearance_changed {
        view.setAppearance(appearance);
    }
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
    let frame_changed = !macos_native_frame_matches(view.frame(), frame);
    let hidden_changed = view.isHidden() == visible;

    // React 拖拽与 macOS 窗口缩放可能在同一帧重复提交相同布局。
    // 仅在原生视图状态真正变化时重绘，避免 NSVisualEffectView 反复失效合成缓存。
    if frame_changed {
        view.setFrame(frame);
    }
    if hidden_changed {
        view.setHidden(!visible);
    }
    if frame_changed || hidden_changed {
        view.setNeedsDisplay(true);
    }
}

#[cfg(target_os = "macos")]
fn attach_macos_native_sidebar_handlers(
    window: WebviewWindow,
    native_sidebar_state: MacosNativeSidebarState,
) {
    native_sidebar_state.mark_handlers_attached(window.label());
    let window_for_events = window.clone();
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::Resized(_)) {
            let _ =
                sync_cached_macos_native_sidebar_layout(&window_for_events, &native_sidebar_state);
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
    let saved = read_optional_json_file::<Value>(&file_path).ok().flatten();

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
fn window_ready_for_native_sidebar(
    window: WebviewWindow,
    native_sidebar_state: State<'_, MacosNativeSidebarState>,
) -> Result<bool, String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window;
        let _ = native_sidebar_state;
        Ok(false)
    }

    #[cfg(target_os = "macos")]
    {
        let window_label = window.label().to_string();
        let native_sidebar_state = native_sidebar_state.inner().clone();
        let window_state = native_sidebar_state.get_window_state(&window_label);

        if !window_state.as_ref().is_some_and(|state| state.initialized) {
            let app = window.app_handle();
            configure_macos_native_glass_sidebars(&app).map_err(|error| error.to_string())?;
        }

        if !window_state
            .as_ref()
            .is_some_and(|state| state.handlers_attached)
        {
            attach_macos_native_sidebar_handlers(window, native_sidebar_state);
        }

        Ok(true)
    }
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
fn set_initialization_window_mode(
    window: WebviewWindow,
    active: bool,
    state: tauri::State<'_, Mutex<DesktopState>>,
) -> Result<(), String> {
    set_main_window_initialization_mode(&window, active, &state)
}

#[tauri::command]
fn native_clear_application_data(
    app: AppHandle,
) -> Result<NativeResetApplicationDataResult, String> {
    clear_native_application_data(&app)
}

#[tauri::command]
fn request_native_app_restart(app: AppHandle) -> Result<bool, String> {
    app.request_restart();
    Ok(true)
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
    if mode == "agent-settings" {
        return agent_tools::settings::run_worker();
    }
    let raw_payload = match args.get(3) {
        Some(payload) => payload.clone(),
        None => {
            let mut payload = String::new();
            std::io::Read::read_to_string(&mut std::io::stdin(), &mut payload)
                .map_err(|error| error.to_string())?;
            payload
        }
    };
    let payload: NativeLibraryWorkerCliPayload = serde_json::from_str(&raw_payload)
        .map_err(|error| format!("library worker CLI payload 无法解析：{error}"))?;
    let result = run_native_library_worker_mode(mode, payload)?;

    serde_json::to_string(&result)
        .map_err(|error| format!("library worker CLI 输出序列化失败：{error}"))
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Mutex::new(DesktopState::new()))
        .manage(MacosNativeSidebarState::default())
        .manage(updater::DownloadedDesktopUpdateState::default())
        .manage(office_converter::OfficeConverterState::default())
        .setup(|app| {
            let task_app = app.handle().clone();
            task_center::set_event_handler(move |task| {
                let _ = task_app.emit("x-file-library-task-updated", task);
            });
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
            window_ready_for_native_sidebar,
            sync_native_sidebar_layout,
            start_native_library_watcher,
            stop_native_library_watcher,
            native_request_library_refresh,
            native_get_library_binding,
            native_save_library_binding,
            native_get_library_config,
            native_save_library_config,
            native_export_library_backup,
            native_write_library_backup,
            native_import_library_backup,
            native_browse_host_directories,
            native_get_library_snapshot,
            native_list_library_tag_details,
            native_list_library_tasks,
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
            native_read_preview_resource,
            office_converter::native_office_converter_status,
            office_converter::native_office_converter_install,
            office_converter::native_office_converter_cancel,
            office_converter::native_office_converter_uninstall,
            office_converter::native_convert_office_preview,
            native_fetch_library_health,
            native_get_agent_integration_settings,
            native_save_agent_integration_settings,
            native_get_http_server_state,
            native_save_http_server_state,
            http_service_hint,
            open_path,
            reveal_path_in_file_manager,
            show_library_context_menu,
            get_runtime_info,
            set_initialization_window_mode,
            native_clear_application_data,
            request_native_app_restart,
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

#[cfg(test)]
mod library_read_cache_tests {
    use super::*;

    #[test]
    fn 同版本复用读取视图且快照替换后失效() {
        let root = env::temp_dir().join(format!("x-file-read-cache-{}", epoch_millis()));
        let path = resolve_runtime_export_catalog_snapshot_path(root.to_str().unwrap());
        let mut snapshot = json!({ "version": 1, "generatedAt": iso_now(), "tags": [], "documents": [{
            "documentId": "a", "path": "docs/a.md", "title": "a", "summary": "first",
            "tags": [], "derivedTags": [], "mtime": iso_now()
        }] });
        write_json_file(&path, &snapshot).unwrap();
        let first = read_local_library_export_payload(root.to_str().unwrap())
            .unwrap()
            .unwrap();
        let second = read_local_library_export_payload(root.to_str().unwrap())
            .unwrap()
            .unwrap();
        assert!(Arc::ptr_eq(&first, &second));
        assert_eq!(first.by_directory["docs"], vec![0]);
        snapshot["documents"][0]["summary"] = json!("updated summary");
        write_json_file(&path, &snapshot).unwrap();
        let updated = read_local_library_export_payload(root.to_str().unwrap())
            .unwrap()
            .unwrap();
        assert!(!Arc::ptr_eq(&first, &updated));
        assert_eq!(
            updated.documents[0].summary.as_deref(),
            Some("updated summary")
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn 文件系统重扫通知会进入调度且运行产物仍被忽略() {
        let root = PathBuf::from("/tmp/library");
        let event = Event::new(notify::EventKind::Other)
            .set_flag(notify::event::Flag::Rescan)
            .add_path(root.clone());
        assert!(should_handle_native_watcher_event(&root, &event));
        let overflow = Event::new(notify::EventKind::Other).set_flag(notify::event::Flag::Rescan);
        assert!(should_handle_native_watcher_event(&root, &overflow));
        assert_eq!(native_watcher_targets(&root, &event), vec![""]);
        let internal = Event::new(notify::EventKind::Other)
            .set_flag(notify::event::Flag::Rescan)
            .add_path(root.join(".ai-index/exports"));
        assert!(!should_handle_native_watcher_event(&root, &internal));
    }

    #[test]
    fn 同根目录请求合并范围() {
        let binding = default_local_library_binding();
        let work = |mode: &str, target: Option<&str>| LibraryWork {
            task_ids: Vec::new(),
            app: None,
            mode: mode.to_string(),
            payload: build_native_library_worker_payload(
                &binding,
                "test".to_string(),
                target.map(str::to_string),
                None,
            ),
        };
        let mut pending = work("full", Some("docs/a.md"));
        merge_library_work(&mut pending, work("full", Some("docs/b.md")));
        assert_eq!(pending.payload.target_path, None);
        assert_eq!(pending.payload.target_paths, vec!["docs/a.md", "docs/b.md"]);
        merge_library_work(&mut pending, work("full", None));
        assert_eq!(pending.payload.target_path, None);
        assert!(pending.payload.target_paths.is_empty());
    }
}
