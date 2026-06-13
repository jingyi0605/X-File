use serde::{Deserialize, Serialize};
use std::env;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::menu::{
    Menu, MenuBuilder, MenuEvent, MenuItemBuilder, SubmenuBuilder,
};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WindowEvent};

#[cfg(target_os = "macos")]
use {
    objc2::MainThreadMarker,
    objc2_app_kit::{
        NSAppearance, NSAppearanceCustomization, NSAppearanceNameVibrantLight, NSAutoresizingMaskOptions,
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
const MACOS_NATIVE_LEFT_SIDEBAR_AUTOREZING_MASK: NSAutoresizingMaskOptions =
    NSAutoresizingMaskOptions::ViewMaxXMargin.union(NSAutoresizingMaskOptions::ViewHeightSizable);

#[cfg(target_os = "macos")]
const MACOS_NATIVE_RIGHT_SIDEBAR_AUTOREZING_MASK: NSAutoresizingMaskOptions =
    NSAutoresizingMaskOptions::ViewMinXMargin.union(NSAutoresizingMaskOptions::ViewHeightSizable);

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
    args_overridden: bool,
}

impl BackendProcessManager {
    fn from_env() -> Self {
        let command =
            env::var("X_FILE_BACKEND_COMMAND").unwrap_or_else(|_| default_backend_command());
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
            args_overridden,
        }
    }

    fn prefer_resource_entry(&mut self, resource_dir: PathBuf) {
        if self.args_overridden {
            return;
        }

        if let Some(node) = bundled_node_candidates(&resource_dir)
            .into_iter()
            .find(|path| path.is_file())
        {
            self.command = node.to_string_lossy().to_string();
        }

        let candidates = [
            resource_dir
                .join("x-file-server")
                .join("dist")
                .join("main.js"),
            resource_dir.join("server").join("dist").join("main.js"),
            resource_dir.join("x-file-server").join("main.js"),
            resource_dir.join("server").join("main.js"),
        ];

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

        match Command::new(&self.command)
            .args(&self.args)
            .current_dir(&self.cwd)
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
            note: "桌面壳已经具备生产托管入口；发布包会优先使用随包携带的 Node 运行时和生产后端资源，不依赖用户手工开 dev server。",
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

fn bundled_node_candidates(resource_dir: &std::path::Path) -> Vec<PathBuf> {
    vec![
        resource_dir
            .join("x-file-runtime")
            .join("node")
            .join("bin")
            .join("node"),
        resource_dir
            .join("x-file-runtime")
            .join("node_modules")
            .join("node")
            .join("bin")
            .join("node"),
        resource_dir
            .join("x-file-runtime")
            .join("package")
            .join("node_modules")
            .join("node")
            .join("bin")
            .join("node"),
        resource_dir
            .join("x-file-runtime")
            .join("package")
            .join("bin")
            .join("node"),
        resource_dir
            .join("x-file-runtime")
            .join("package")
            .join("node_modules")
            .join("node-darwin-arm64")
            .join("bin")
            .join("node"),
        resource_dir
            .join("x-file-runtime")
            .join("package")
            .join("node_modules")
            .join("node-darwin-x64")
            .join("bin")
            .join("node"),
        resource_dir
            .join("x-file-runtime")
            .join("package")
            .join("node_modules")
            .join("node-win-x64")
            .join("bin")
            .join("node.exe"),
    ]
}

struct DesktopState {
    backend_persistent: bool,
    is_quitting: bool,
    backend: BackendProcessManager,
    native_context_menu_selection: Option<String>,
}

impl DesktopState {
    fn new() -> Self {
        Self {
            backend_persistent: false,
            is_quitting: false,
            backend: BackendProcessManager::from_env(),
            native_context_menu_selection: None,
        }
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
fn http_service_hint() -> BackendArchitecture {
    BackendArchitecture {
        mode: "tauri_shell_plus_node_fastify",
        host: "127.0.0.1",
        port: 17321,
        frontend_dev_url: "http://127.0.0.1:17320",
        api_base_url: "http://127.0.0.1:17321",
        desktop_shell_owns_process: true,
        tray_implemented: true,
        note: "桌面壳已实现托盘菜单、关闭窗口隐藏和后端子进程托管入口；发布包会优先使用随包携带的 Node 运行时和生产后端资源。",
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
            note: "关闭窗口时隐藏主窗口并保留后端；用户可以从托盘恢复窗口或退出应用。",
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
    env::var("NODE").unwrap_or_else(|_| "node".to_string())
}

fn default_backend_args() -> Vec<String> {
    let dev_server_entry = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../server/dist/main.js")
        .components()
        .collect::<PathBuf>();
    vec![dev_server_entry.to_string_lossy().to_string()]
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

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
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

    TrayIconBuilder::with_id("main-tray")
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
        })
        .build(app)?;

    Ok(())
}

fn configure_backend_process(app: &tauri::App) {
    let resource_dir = app.path().resource_dir().ok();

    let state = app.state::<Mutex<DesktopState>>();
    let mut state = state.lock().expect("桌面状态锁已损坏");

    if let Some(resource_dir) = resource_dir {
        state.backend.prefer_resource_entry(resource_dir);
    }

    if should_autostart_backend() {
        state.backend.start();
    }
}


#[cfg(target_os = "macos")]
fn configure_macos_native_glass_sidebars(app: &tauri::App) -> tauri::Result<()> {
    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        return Ok(());
    };

    let window_for_glass = window.clone();

    window
        .run_on_main_thread(move || unsafe {
            let Ok(ns_window_ptr) = window_for_glass.ns_window() else {
                return;
            };
            let ns_window: &NSWindow = &*ns_window_ptr.cast();
            let Some(content_view) = ns_window.contentView() else {
                return;
            };
            let content_frame = content_view.frame();
            let content_width = content_frame.size.width.max(0.0);
            let content_height = content_frame.size.height.max(0.0);
            let appearance = NSAppearance::appearanceNamed(NSAppearanceNameVibrantLight);

            let left_frame = NSRect::new(
                NSPoint::new(0.0, 0.0),
                NSSize::new(MACOS_NATIVE_LEFT_SIDEBAR_WIDTH.min(content_width), content_height),
            );
            let right_width = MACOS_NATIVE_RIGHT_SIDEBAR_WIDTH.min(content_width);
            let right_frame = NSRect::new(
                NSPoint::new((content_width - right_width).max(0.0), 0.0),
                NSSize::new(right_width, content_height),
            );

            add_macos_native_sidebar_view(
                &content_view,
                left_frame,
                MACOS_NATIVE_LEFT_SIDEBAR_AUTOREZING_MASK,
                appearance.as_deref(),
            );
            add_macos_native_sidebar_view(
                &content_view,
                right_frame,
                MACOS_NATIVE_RIGHT_SIDEBAR_AUTOREZING_MASK,
                appearance.as_deref(),
            );
        })
        .map_err(|error| tauri::Error::Anyhow(error.into()))
}

#[cfg(target_os = "macos")]
unsafe fn add_macos_native_sidebar_view(
    content_view: &objc2_app_kit::NSView,
    frame: NSRect,
    autoresizing_mask: NSAutoresizingMaskOptions,
    appearance: Option<&NSAppearance>,
) {
    let mtm = MainThreadMarker::new().expect("创建 macOS 原生侧栏必须在主线程执行");
    let effect_view = NSVisualEffectView::initWithFrame(mtm.alloc(), frame);
    effect_view.setMaterial(NSVisualEffectMaterial::Sidebar);
    effect_view.setBlendingMode(NSVisualEffectBlendingMode::WithinWindow);
    effect_view.setState(NSVisualEffectState::FollowsWindowActiveState);
    effect_view.setAppearance(appearance);
    effect_view.setAutoresizingMask(autoresizing_mask);
    effect_view.setLayerContentsRedrawPolicy(NSViewLayerContentsRedrawPolicy::DuringViewResize);
    content_view.addSubview_positioned_relativeTo(&effect_view, NSWindowOrderingMode::Below, None);
}

fn should_autostart_backend() -> bool {
    env::var("X_FILE_BACKEND_AUTOSTART")
        .map(|value| value != "0" && value.to_lowercase() != "false")
        .unwrap_or(true)
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Mutex::new(DesktopState::new()))
        .setup(|app| {
            setup_tray(app)?;
            configure_backend_process(app);
            #[cfg(target_os = "macos")]
            configure_macos_native_glass_sidebars(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            describe_backend_policy,
            set_backend_persistence,
            start_managed_backend,
            stop_managed_backend,
            desktop_shell_status,
            http_service_hint,
            open_path,
            reveal_path_in_file_manager,
            show_library_context_menu
        ])
        .on_menu_event(handle_menu_event)
        .on_window_event(|window, event| {
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
