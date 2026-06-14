// X-File 桌面更新模块。
// 能力：检查 / 下载 / 安装更新，支持 stable 与 beta 双通道。
// 参考 CodingNS apps/desktop/src-tauri/src/updater.rs：
//   - 去掉窗口 chrome metrics（X-File 自有 macOS 侧栏实现，前端不依赖 updater 提供 chrome 信息）；
//   - 把 resolve_updater_endpoint 真正实现为双通道分叉（父项目此处 `let _ = channel;` 丢弃了通道参数）；
//   - 新增 read/write_release_channel：通道偏好持久化到 app_data_dir/release-channel.json（父项目用 config 系统，X-File 无）；
//   - pubkey 不显式注入，沿用 tauri.conf.json 的 plugins.updater.pubkey（X-File 已写入真实公钥）。

use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};
use tauri_plugin_updater::UpdaterExt;

const GITHUB_RELEASES_OWNER: &str = "jingyi0605";
const GITHUB_RELEASES_REPO: &str = "X-File";
const STABLE_UPDATER_MANIFEST_URL: &str =
  "https://github.com/jingyi0605/X-File/releases/latest/download/latest.json";
const BETA_UPDATER_MANIFEST_URL: &str =
  "https://github.com/jingyi0605/X-File/releases/download/beta-latest/latest.json";
const DEFAULT_CHANNEL: &str = "stable";
const CHANNEL_FILE_NAME: &str = "release-channel.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseManifest {
  pub channel: String,
  pub platform: String,
  pub version: String,
  pub tag_name: String,
  pub title: String,
  pub notes: String,
  pub html_url: String,
  pub published_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopRuntimeInfo {
  pub version: String,
  pub app_data_dir: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopReleaseState {
  pub checked_at: String,
  pub current_version: String,
  pub has_update: bool,
  pub manifest: Option<ReleaseManifest>,
  pub runtime_info: DesktopRuntimeInfo,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DesktopUpdateDownloadProgress {
  pub downloaded: u64,
  pub content_length: Option<u64>,
  pub percent: Option<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateDownloadResult {
  pub ok: bool,
  pub error_code: Option<String>,
  pub detail: Option<String>,
  pub version: Option<String>,
  pub progress: Option<DesktopUpdateDownloadProgress>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInstallResult {
  pub ok: bool,
  pub error_code: Option<String>,
  pub detail: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct DownloadedDesktopUpdateState {
  update: Arc<Mutex<Option<DownloadedDesktopUpdate>>>,
}

#[derive(Debug, Clone)]
struct DownloadedDesktopUpdate {
  channel: String,
  version: String,
  bytes: Vec<u8>,
}

impl DownloadedDesktopUpdateState {
  fn replace(&self, update: DownloadedDesktopUpdate) -> Result<(), String> {
    let mut guard = self
      .update
      .lock()
      .map_err(|_| "桌面更新缓存已被占用。".to_string())?;
    *guard = Some(update);
    Ok(())
  }

  fn take_matching(
    &self,
    channel: &str,
    version: &str,
  ) -> Result<Option<DownloadedDesktopUpdate>, String> {
    let mut guard = self
      .update
      .lock()
      .map_err(|_| "桌面更新缓存已被占用。".to_string())?;

    let matched = guard
      .as_ref()
      .map(|update| update.channel == channel && update.version == version)
      .unwrap_or(false);

    if !matched {
      return Ok(None);
    }

    Ok(guard.take())
  }
}

pub fn get_runtime_info(app: &AppHandle) -> DesktopRuntimeInfo {
  DesktopRuntimeInfo {
    version: app.package_info().version.to_string(),
    app_data_dir: app
      .path()
      .app_data_dir()
      .ok()
      .map(|path| path.to_string_lossy().to_string()),
  }
}

pub async fn check_for_update(
  app: &AppHandle,
  channel: &str,
) -> Result<DesktopReleaseState, String> {
  let runtime_info = get_runtime_info(app);
  let current_version = runtime_info.version.clone();
  let updater = build_updater(app, channel)?;
  let update = updater
    .check()
    .await
    .map_err(|error| format!("检查桌面更新失败: {error}"))?;
  let manifest = update.map(|update| map_release_manifest(channel, update));

  Ok(DesktopReleaseState {
    checked_at: Utc::now().to_rfc3339(),
    current_version,
    has_update: manifest.is_some(),
    manifest,
    runtime_info,
  })
}

pub async fn download_update(
  app: &AppHandle,
  state: &DownloadedDesktopUpdateState,
  channel: &str,
) -> UpdateDownloadResult {
  match download_update_inner(app, state, channel).await {
    Ok((version, progress)) => UpdateDownloadResult {
      ok: true,
      error_code: None,
      detail: None,
      version: Some(version),
      progress: Some(progress),
    },
    Err(detail) => UpdateDownloadResult {
      ok: false,
      error_code: Some("UPDATE_DOWNLOAD_ERROR".to_string()),
      detail: Some(detail),
      version: None,
      progress: None,
    },
  }
}

pub async fn install_update(
  app: &AppHandle,
  state: &DownloadedDesktopUpdateState,
  channel: &str,
) -> UpdateInstallResult {
  match install_update_inner(app, state, channel).await {
    Ok(()) => UpdateInstallResult {
      ok: true,
      error_code: None,
      detail: None,
    },
    Err(detail) => UpdateInstallResult {
      ok: false,
      error_code: Some("UPDATE_ERROR".to_string()),
      detail: Some(detail),
    },
  }
}

async fn download_update_inner(
  app: &AppHandle,
  state: &DownloadedDesktopUpdateState,
  channel: &str,
) -> Result<(String, DesktopUpdateDownloadProgress), String> {
  let updater = build_updater(app, channel)?;
  let Some(update) = updater
    .check()
    .await
    .map_err(|error| format!("检查桌面更新失败: {error}"))?
  else {
    return Err("当前已经是最新版本。".to_string());
  };

  let version = update.version.to_string();
  let progress = Arc::new(Mutex::new(DesktopUpdateDownloadProgress::default()));
  let progress_for_chunk = Arc::clone(&progress);
  let progress_for_finish = Arc::clone(&progress);
  let bytes = update
    .download(
      move |chunk_length, content_length| {
        if let Ok(mut current) = progress_for_chunk.lock() {
          current.downloaded = current.downloaded.saturating_add(chunk_length as u64);
          current.content_length = content_length;
          current.percent = content_length.and_then(|total| {
            if total == 0 {
              return None;
            }

            Some(((current.downloaded.saturating_mul(100) / total).min(100)) as u8)
          });
        }
      },
      move || {
        if let Ok(mut current) = progress_for_finish.lock() {
          current.percent = Some(100);
        }
      },
    )
    .await
    .map_err(|error| format!("下载桌面更新失败: {error}"))?;

  let final_progress = progress
    .lock()
    .map_err(|_| "读取桌面更新下载进度失败。".to_string())?
    .clone();

  state.replace(DownloadedDesktopUpdate {
    channel: channel.to_string(),
    version: version.clone(),
    bytes,
  })?;

  Ok((version, final_progress))
}

async fn install_update_inner(
  app: &AppHandle,
  state: &DownloadedDesktopUpdateState,
  channel: &str,
) -> Result<(), String> {
  let updater = build_updater(app, channel)?;
  let Some(update) = updater
    .check()
    .await
    .map_err(|error| format!("检查桌面更新失败: {error}"))?
  else {
    return Err("当前已经是最新版本。".to_string());
  };

  let version = update.version.to_string();

  if let Some(downloaded) = state.take_matching(channel, &version)? {
    update
      .install(downloaded.bytes)
      .map_err(|error| format!("安装桌面更新失败: {error}"))?;
    return Ok(());
  }

  update
    .download_and_install(
      |_downloaded, _content_length| {},
      || {},
    )
    .await
    .map_err(|error| format!("安装桌面更新失败: {error}"))?;

  Ok(())
}

fn build_updater(
  app: &AppHandle,
  channel: &str,
) -> Result<tauri_plugin_updater::Updater, String> {
  let endpoint = resolve_updater_endpoint(channel);
  let builder = app
    .updater_builder()
    .endpoints(vec![
      endpoint
        .parse()
        .map_err(|error| format!("解析 updater endpoint 失败: {error}"))?,
    ])
    .map_err(|error| format!("配置 updater endpoint 失败: {error}"))?;

  // pubkey 不显式注入：沿用 tauri.conf.json 的 plugins.updater.pubkey（X-File 已写入真实公钥）。
  #[cfg(target_os = "macos")]
  let builder = builder.target("macos-universal");

  builder
    .build()
    .map_err(|error| format!("初始化桌面 updater 失败: {error}"))
}

/// 双通道 endpoint 分叉。这是 X-File 相对父项目的核心增强：
/// 父项目此处 `let _ = channel;` 永远返回 stable URL，只有单通道；
/// X-File 按 channel 选 stable（GitHub 原生 latest）或 beta（beta-latest 滚动 tag）。
fn resolve_updater_endpoint(channel: &str) -> String {
  match channel {
    "beta" => BETA_UPDATER_MANIFEST_URL.to_string(),
    _ => STABLE_UPDATER_MANIFEST_URL.to_string(),
  }
}

fn map_release_manifest(channel: &str, update: tauri_plugin_updater::Update) -> ReleaseManifest {
  let version = update.version.to_string();

  ReleaseManifest {
    channel: channel.to_string(),
    platform: resolve_release_platform().to_string(),
    version: version.clone(),
    tag_name: resolve_release_tag_name(&version),
    title: format!("v{version}"),
    notes: update.body.unwrap_or_default(),
    html_url: format!(
      "https://github.com/{}/{}/releases/tag/{}",
      GITHUB_RELEASES_OWNER,
      GITHUB_RELEASES_REPO,
      resolve_release_tag_name(&version)
    ),
    published_at: update
      .date
      .map(|value| value.to_string())
      .unwrap_or_default(),
  }
}

fn resolve_release_tag_name(version: &str) -> String {
  if version.starts_with('v') {
    version.to_string()
  } else {
    format!("v{version}")
  }
}

fn resolve_release_platform() -> &'static str {
  #[cfg(target_os = "macos")]
  {
    "macos-universal"
  }

  #[cfg(target_os = "windows")]
  {
    "windows-x86_64"
  }

  #[cfg(target_os = "linux")]
  {
    "linux-x86_64"
  }
}

/// 读取持久化的更新通道；读取失败时回退到 stable。
pub fn read_release_channel(app: &AppHandle) -> String {
  let Some(path) = resolve_channel_file(app) else {
    return DEFAULT_CHANNEL.to_string();
  };

  std::fs::read_to_string(&path)
    .ok()
    .and_then(|raw| serde_json::from_str::<ChannelFile>(&raw).ok())
    .map(|file| normalize_channel(&file.channel))
    .unwrap_or_else(|| DEFAULT_CHANNEL.to_string())
}

/// 持久化更新通道到 app_data_dir/release-channel.json。
pub fn write_release_channel(app: &AppHandle, channel: &str) -> Result<(), String> {
  let normalized = normalize_channel(channel);
  let Some(path) = resolve_channel_file(app) else {
    return Err("无法定位应用数据目录，未能保存更新通道。".to_string());
  };

  if let Some(parent) = path.parent() {
    std::fs::create_dir_all(parent)
      .map_err(|error| format!("创建应用数据目录失败: {error}"))?;
  }

  let body = serde_json::to_string_pretty(&ChannelFile {
    channel: normalized,
  })
  .map_err(|error| format!("序列化更新通道失败: {error}"))?;

  std::fs::write(&path, body).map_err(|error| format!("写入更新通道失败: {error}"))?;
  Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ChannelFile {
  channel: String,
}

fn resolve_channel_file(app: &AppHandle) -> Option<PathBuf> {
  app
    .path()
    .app_data_dir()
    .ok()
    .map(|dir| dir.join(CHANNEL_FILE_NAME))
}

fn normalize_channel(channel: &str) -> String {
  match channel {
    // 兼容历史 dev 值，统一归入 beta 通道。
    "beta" | "dev" => "beta".to_string(),
    _ => "stable".to_string(),
  }
}

/// 用系统默认浏览器打开链接（前端「查看新版本详情」按钮）。
pub fn open_external(url: &str) -> Result<(), String> {
  #[cfg(target_os = "windows")]
  {
    Command::new("cmd")
      .args(["/C", "start", "", url])
      .spawn()
      .map_err(|error| format!("打开外部链接失败: {error}"))?;
  }

  #[cfg(target_os = "macos")]
  {
    Command::new("open")
      .arg(url)
      .spawn()
      .map_err(|error| format!("打开外部链接失败: {error}"))?;
  }

  #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
  {
    Command::new("xdg-open")
      .arg(url)
      .spawn()
      .map_err(|error| format!("打开外部链接失败: {error}"))?;
  }

  Ok(())
}
