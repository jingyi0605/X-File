use serde::Serialize;
use std::env;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::menu::{MenuBuilder, MenuEvent, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, WindowEvent};

const MAIN_WINDOW_LABEL: &str = "main";
const MENU_SHOW_WINDOW: &str = "show_window";
const MENU_HIDE_WINDOW: &str = "hide_window";
const MENU_ENABLE_PERSISTENCE: &str = "enable_persistence";
const MENU_DISABLE_PERSISTENCE: &str = "disable_persistence";
const MENU_START_BACKEND: &str = "start_backend";
const MENU_STOP_BACKEND: &str = "stop_backend";
const MENU_QUIT: &str = "quit";

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
}

impl DesktopState {
    fn new() -> Self {
        Self {
            backend_persistent: false,
            is_quitting: false,
            backend: BackendProcessManager::from_env(),
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
    match event.id().as_ref() {
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
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            describe_backend_policy,
            set_backend_persistence,
            start_managed_backend,
            stop_managed_backend,
            desktop_shell_status,
            http_service_hint
        ])
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
