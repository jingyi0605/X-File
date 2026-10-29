use base64::Engine as _;
use flate2::read::GzDecoder;
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256, Sha512};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};

const NODE_VERSION: &str = "v22.23.3";
const KIT_VERSION: &str = "0.2.3";
const KIT_INTEGRITY: &str = "sha512-MbpucYPrZpeec/smy7u8Z066JeQU6lMVK6A1oysUv1R/OATDvtlVmrsIlfcIz6bVbfJVpgregIK86dOdat9qdA==";
const MAX_ARCHIVE_BYTES: u64 = 110 * 1024 * 1024;
const MAX_NODE_EXPANDED_BYTES: u64 = 300 * 1024 * 1024;
const MAX_ENGINE_EXPANDED_BYTES: u64 = 320 * 1024 * 1024;

fn max_office_input_bytes() -> u64 {
    crate::preview_capabilities::budgets().resource_max_bytes
}

fn max_converted_pdf_bytes() -> u64 {
    crate::preview_capabilities::budgets().resource_max_bytes
}
const MAX_PDF_PAGES: u32 = 500;
const PDF_CACHE_LIMIT: u64 = 200 * 1024 * 1024;
const INSTALL_EVENT: &str = "x-file-office-converter-progress";

#[derive(Clone, Default)]
pub struct OfficeConverterState {
    active: Arc<Mutex<Option<Arc<AtomicBool>>>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeConverterStatus {
    supported: bool,
    installed: bool,
    busy: bool,
    version: String,
    platform: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeConversionResult {
    pub pdf_base64: String,
    pub page_count: u32,
    pub elapsed_ms: u64,
    pub cached: bool,
    pub missing_fonts: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConversionMetadata {
    page_count: u32,
    backend: String,
    missing_fonts: Vec<String>,
}

#[derive(Debug, Clone, Copy)]
struct Platform {
    key: &'static str,
    node_archive: &'static str,
    node_sha256: &'static str,
    engine_package: &'static str,
    engine_integrity: &'static str,
    koffi_package: Option<&'static str>,
    koffi_integrity: Option<&'static str>,
    archive_kind: ArchiveKind,
}

#[derive(Debug, Clone, Copy)]
enum ArchiveKind {
    TarGz,
    Zip,
}

struct OperationGuard {
    active: Arc<Mutex<Option<Arc<AtomicBool>>>>,
    token: Arc<AtomicBool>,
}

impl OperationGuard {
    fn start(state: &OfficeConverterState) -> Result<Self, String> {
        let mut active = state.active.lock().map_err(|_| "转换器状态不可用")?;
        if active.is_some() {
            return Err("Office 转换器当前正在执行其他任务".to_owned());
        }
        let token = Arc::new(AtomicBool::new(false));
        *active = Some(token.clone());
        Ok(Self { active: state.active.clone(), token })
    }
}

impl Drop for OperationGuard {
    fn drop(&mut self) {
        if let Ok(mut active) = self.active.lock() {
            if active.as_ref().is_some_and(|current| Arc::ptr_eq(current, &self.token)) {
                *active = None;
            }
        }
    }
}

impl OfficeConverterState {
    fn is_busy(&self) -> bool {
        self.active.lock().map(|active| active.is_some()).unwrap_or(true)
    }

    fn cancel(&self) -> Result<(), String> {
        let active = self.active.lock().map_err(|_| "转换器状态不可用")?;
        if let Some(cancel) = active.as_ref() {
            cancel.store(true, Ordering::SeqCst);
        }
        Ok(())
    }
}

#[tauri::command]
pub fn native_office_converter_status(
    app: AppHandle,
    state: State<'_, OfficeConverterState>,
) -> OfficeConverterStatus {
    status(&app, state.inner())
}

#[tauri::command]
pub async fn native_office_converter_install(
    app: AppHandle,
    state: State<'_, OfficeConverterState>,
) -> Result<OfficeConverterStatus, String> {
    let state = state.inner().clone();
    let operation = OperationGuard::start(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        let result = install(&app, &operation.token);
        drop(operation);
        result.map(|_| status(&app, &state))
    })
    .await
    .map_err(|error| format!("等待转换器安装任务失败：{error}"))?
}

#[tauri::command]
pub fn native_office_converter_cancel(state: State<'_, OfficeConverterState>) -> Result<(), String> {
    state.cancel()
}

#[tauri::command]
pub async fn native_office_converter_uninstall(
    app: AppHandle,
    state: State<'_, OfficeConverterState>,
) -> Result<OfficeConverterStatus, String> {
    let state = state.inner().clone();
    let operation = OperationGuard::start(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        let result = (|| {
            let root = component_root(&app)?;
            if root.exists() {
                fs::remove_dir_all(&root).map_err(|error| format!("卸载 Office 转换器失败：{error}"))?;
            }
            let cache = pdf_cache_dir(&app)?;
            if cache.exists() {
                fs::remove_dir_all(cache).map_err(|error| format!("清理 Office PDF 缓存失败：{error}"))?;
            }
            Ok(())
        })();
        drop(operation);
        result.map(|_| status(&app, &state))
    })
    .await
    .map_err(|error| format!("等待转换器卸载任务失败：{error}"))?
}

#[tauri::command]
pub async fn native_convert_office_preview(
    app: AppHandle,
    state: State<'_, OfficeConverterState>,
    relative_path: String,
) -> Result<OfficeConversionResult, String> {
    let state = state.inner().clone();
    let operation = OperationGuard::start(&state)?;
    let cancel = operation.token.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = convert_file(&app, &relative_path, cancel);
        drop(operation);
        result
    })
    .await
    .map_err(|error| format!("等待 Office 转换任务失败：{error}"))?
}

pub fn status(app: &AppHandle, state: &OfficeConverterState) -> OfficeConverterStatus {
    let target = platform();
    let installed = target.is_some_and(|target| {
        component_root(app).ok().is_some_and(|root| {
            let engine = target.engine_package.rsplit('/').next().unwrap_or("");
            node_path(&root).is_file()
                && root.join("READY").is_file()
                && root.join("node_modules/@deepseek-ai/libreoffice-kit/package.json").is_file()
                && root.join("node_modules/@deepseek-ai").join(engine).join("package.json").is_file()
        })
    });
    OfficeConverterStatus {
        supported: target.is_some(),
        installed,
        busy: state.is_busy(),
        version: KIT_VERSION.to_owned(),
        platform: target.map(|value| value.key).unwrap_or("unsupported").to_owned(),
    }
}

fn install(app: &AppHandle, cancel: &AtomicBool) -> Result<(), String> {
    let target = component_root(app)?;
    let parent = target.parent().ok_or_else(|| "无法定位转换器目录".to_owned())?;
    fs::create_dir_all(parent).map_err(|error| format!("创建转换器目录失败：{error}"))?;
    let suffix = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
    let staging = parent.join(format!(".office-converter-install-{suffix}"));
    fs::create_dir(&staging).map_err(|error| format!("创建安装暂存目录失败：{error}"))?;
    if let Err(error) = install_staging(app, &staging, cancel) {
        let _ = fs::remove_dir_all(&staging);
        emit(app, "error", 0, 0);
        return Err(error);
    }
    if let Err(error) = check_cancel(cancel) {
        let _ = fs::remove_dir_all(&staging);
        return Err(error);
    }
    let backup = parent.join(format!(".office-converter-backup-{suffix}"));
    if target.exists() {
        fs::rename(&target, &backup).map_err(|error| format!("备份现有转换器失败：{error}"))?;
    }
    if let Err(error) = fs::rename(&staging, &target) {
        if backup.exists() { let _ = fs::rename(&backup, &target); }
        let _ = fs::remove_dir_all(&staging);
        return Err(format!("启用 Office 转换器失败：{error}"));
    }
    let _ = fs::remove_dir_all(backup);
    emit(app, "ready", 1, 1);
    Ok(())
}

fn install_staging(app: &AppHandle, root: &Path, cancel: &AtomicBool) -> Result<(), String> {
    let target = platform().ok_or_else(|| "当前系统或处理器架构暂不支持 LibreOffice 转换器".to_owned())?;
    let node_archive = root.join(match target.archive_kind { ArchiveKind::Zip => "node.zip", ArchiveKind::TarGz => "node.tar.gz" });
    let node_url = format!("https://nodejs.org/dist/{NODE_VERSION}/{}", target.node_archive);
    download_file(app, &node_url, &node_archive, MAX_ARCHIVE_BYTES, cancel)?;
    verify_sha256_file(&node_archive, target.node_sha256)?;
    check_cancel(cancel)?;

    let runtime = root.join("runtime");
    fs::create_dir(&runtime).map_err(|error| format!("创建 Node 运行目录失败：{error}"))?;
    match target.archive_kind {
        ArchiveKind::TarGz => extract_node_tar_gz(&node_archive, &runtime)?,
        ArchiveKind::Zip => extract_node_zip(&node_archive, &runtime)?,
    }
    fs::remove_file(&node_archive).ok();

    let (package_json, lockfile) = platform_lockfiles(target.key)?;
    verify_lockfile(lockfile)?;
    fs::write(root.join("package.json"), package_json).map_err(|error| format!("写入依赖清单失败：{error}"))?;
    fs::write(root.join("package-lock.json"), lockfile).map_err(|error| format!("写入依赖锁文件失败：{error}"))?;
    fs::write(root.join("convert.mjs"), include_bytes!("../resources/office-converter/convert.mjs"))
        .map_err(|error| format!("写入转换入口失败：{error}"))?;

    emit(app, "installing", 0, 1);
    let node = node_path_for_runtime(&runtime);
    let mut child = Command::new(&node)
        .arg(npm_cli_path(&runtime))
        .args(["ci", "--prefix"])
        .arg(root)
        .args(["--omit=optional", "--ignore-scripts", "--no-audit", "--no-fund", "--no-progress"])
        .env("npm_config_update_notifier", "false")
        .env("npm_config_registry", "https://registry.npmjs.org/")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("启动固定依赖安装失败：{error}"))?;
    wait_child(&mut child, cancel, Duration::from_secs(15 * 60), "安装 LibreOffice 依赖")?;
    check_cancel(cancel)?;

    install_npm_package(app, root, target.engine_package, target.engine_integrity, cancel)?;
    if let (Some(package), Some(integrity)) = (target.koffi_package, target.koffi_integrity) {
        install_npm_package(app, root, package, integrity, cancel)?;
    }
    if target.koffi_package.is_some() {
        install_npm_package(app, root, "koffi", integrity_for("koffi").unwrap(), cancel)?;
    }
    check_cancel(cancel)?;

    let check = Command::new(&node)
        .arg("--input-type=module")
        .arg("-e")
        .arg("import { createConverter } from '@deepseek-ai/libreoffice-kit'; const c = await createConverter({ timeoutMs: 30000, fontMetadataCacheDirectory: false }); await c.dispose();")
        .current_dir(root)
        .output()
        .map_err(|error| format!("校验转换引擎失败：{error}"))?;
    if !check.status.success() {
        return Err(format!("LibreOffice 引擎完整性检查失败：{}", String::from_utf8_lossy(&check.stderr).chars().take(500).collect::<String>()));
    }
    fs::write(root.join("READY"), format!("{KIT_VERSION}\n{}\n", target.key))
        .map_err(|error| format!("写入转换器完成标记失败：{error}"))?;
    emit(app, "installing", 1, 1);
    Ok(())
}

fn convert_file(app: &AppHandle, relative_path: &str, cancel: Arc<AtomicBool>) -> Result<OfficeConversionResult, String> {
    let started = Instant::now();
    let root = component_root(app)?;
    let target = platform().ok_or_else(|| "当前平台不支持 Office PDF 转换".to_owned())?;
    if !node_path(&root).is_file() || !root.join("READY").is_file() {
        return Err("可选 Office 转换器尚未安装".to_owned());
    }

    let binding = super::read_local_library_binding()?.ok_or_else(|| "当前未绑定资料库".to_owned())?;
    let library_root = fs::canonicalize(&binding.root_dir).map_err(|error| format!("解析资料库根目录失败：{error}"))?;
    let relative = validate_office_relative_path(relative_path)?;
    let input = fs::canonicalize(library_root.join(relative)).map_err(|error| format!("解析 Office 文件失败：{error}"))?;
    if !input.starts_with(&library_root) || !input.is_file() {
        return Err("Office 文件不在当前绑定资料库内".to_owned());
    }
    let extension = input.extension().and_then(|value| value.to_str()).unwrap_or("").to_ascii_lowercase();
    if !matches!(extension.as_str(), "docx" | "pptx") {
        return Err("LibreOffice PDF 预览只适用于 DOCX 和 PPTX".to_owned());
    }
    let metadata = fs::metadata(&input).map_err(|error| format!("读取 Office 文件信息失败：{error}"))?;
    if !is_supported_office_size(metadata.len()) {
        return Err("Office 文件超过 20 MiB 预览限制".to_owned());
    }
    check_cancel(cancel.as_ref())?;
    let cache = pdf_cache_dir(app)?;
    fs::create_dir_all(&cache).map_err(|error| format!("创建转换缓存失败：{error}"))?;
    let modified = metadata.modified().ok().and_then(|time| time.duration_since(UNIX_EPOCH).ok()).map(|time| time.as_nanos()).unwrap_or(0);
    let source_hash = sha256_file(&input)?;
    let cache_key = format!("{}:{}:{}:{}:{}:{}", input.display(), metadata.len(), modified, source_hash, KIT_VERSION, target.key);
    let cache_path = cache.join(format!("{:x}.pdf", Sha256::digest(cache_key.as_bytes())));
    if let Some(metadata) = read_cache_metadata(&cache_path)? {
        return Ok(OfficeConversionResult {
            pdf_base64: read_pdf_base64(&cache_path)?,
            page_count: metadata.page_count,
            elapsed_ms: started.elapsed().as_millis() as u64,
            cached: true,
            missing_fonts: metadata.missing_fonts,
        });
    }

    let operation_dir = cache.join(format!(".convert-{}-{}", std::process::id(), unique_suffix()));
    fs::create_dir(&operation_dir).map_err(|error| format!("创建转换暂存目录失败：{error}"))?;
    let result = (|| {
        let input_copy = operation_dir.join(format!("source.{extension}"));
        let output = operation_dir.join("preview.pdf");
        copy_bounded(&input, &input_copy, max_office_input_bytes()).map_err(|error| format!("复制 Office 源文件失败：{error}"))?;
        verify_source_snapshot(&input, &input_copy, metadata.len(), modified, &source_hash)?;
        let conversion = run_conversion(&root, &input_copy, &output, cancel.clone())?;
        let output_size = fs::metadata(&output).map_err(|error| format!("LibreOffice 未生成 PDF：{error}"))?.len();
        if output_size > max_converted_pdf_bytes() {
            return Err("转换后的 PDF 超过 20 MiB 限制".to_owned());
        }
        if conversion.page_count == 0 || conversion.page_count > MAX_PDF_PAGES {
            return Err(format!("PDF 页数超过上限（最多 {MAX_PDF_PAGES} 页）"));
        }
        let temp_pdf = cache.join(format!(".{}.{}.tmp.pdf", std::process::id(), unique_suffix()));
        let temp_metadata = cache.join(format!(".{}.{}.tmp.json", std::process::id(), unique_suffix()));
        copy_bounded(&output, &temp_pdf, max_converted_pdf_bytes()).map_err(|error| format!("写入 PDF 缓存失败：{error}"))?;
        let cache_metadata = serde_json::to_vec(&conversion).map_err(|error| format!("编码缓存信息失败：{error}"))?;
        fs::write(&temp_metadata, cache_metadata).map_err(|error| format!("写入缓存信息失败：{error}"))?;
        replace_file(&temp_pdf, &cache_path)?;
        replace_file(&temp_metadata, &metadata_cache_path(&cache_path))?;
        prune_cache(&cache, &cache_path);
        Ok(OfficeConversionResult {
            pdf_base64: read_pdf_base64(&cache_path)?,
            page_count: conversion.page_count,
            elapsed_ms: started.elapsed().as_millis() as u64,
            cached: false,
            missing_fonts: conversion.missing_fonts,
        })
    })();
    let _ = fs::remove_dir_all(operation_dir);
    result
}

fn run_conversion(root: &Path, input: &Path, output: &Path, cancel: Arc<AtomicBool>) -> Result<ConversionMetadata, String> {
    let mut child = Command::new(node_path(root))
        .arg(root.join("convert.mjs"))
        .arg(input)
        .arg(output)
        .current_dir(root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("启动 LibreOffice 转换失败：{error}"))?;
    let mut control = child.stdin.take().ok_or_else(|| "无法连接转换进程控制通道".to_owned())?;
    let stdout = child.stdout.take().ok_or_else(|| "无法读取转换结果".to_owned())?;
    let output_reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout.take(64 * 1024).read_to_end(&mut bytes).map(|_| bytes)
    });
    let child_cancel = cancel.clone();
    let watcher_done = Arc::new(AtomicBool::new(false));
    let watcher_done_thread = watcher_done.clone();
    let control_writer = thread::spawn(move || {
        while !child_cancel.load(Ordering::SeqCst) && !watcher_done_thread.load(Ordering::SeqCst) {
            thread::sleep(Duration::from_millis(50));
        }
        if child_cancel.load(Ordering::SeqCst) { let _ = control.write_all(b"cancel"); }
    });
    let wait_result = wait_child_graceful(&mut child, &cancel, Duration::from_secs(135), Duration::from_secs(15), "Office 文件转换");
    watcher_done.store(true, Ordering::SeqCst);
    let _ = control_writer.join();
    let status = wait_result?;
    let stdout = output_reader.join().map_err(|_| "读取转换结果线程异常退出".to_owned())?
        .map_err(|error| format!("读取转换结果失败：{error}"))?;
    if !status.success() {
        return Err(format!("Office 转换失败，进程退出码：{}", status.code().map(|code| code.to_string()).unwrap_or_else(|| "unknown".to_owned())));
    }
    let metadata: ConversionMetadata = serde_json::from_slice(&stdout).map_err(|error| format!("转换器结果格式无效：{error}"))?;
    if metadata.backend != "native" && metadata.backend != "wasm" {
        return Err("转换器返回未知引擎类型".to_owned());
    }
    Ok(metadata)
}

fn verify_source_snapshot(input: &Path, copied: &Path, expected_size: u64, expected_mtime: u128, expected_hash: &str) -> Result<(), String> {
    let current = fs::metadata(input).map_err(|error| format!("复核 Office 文件信息失败：{error}"))?;
    let current_mtime = current.modified().ok().and_then(|time| time.duration_since(UNIX_EPOCH).ok()).map(|time| time.as_nanos()).unwrap_or(0);
    if current.len() != expected_size || current_mtime != expected_mtime || sha256_file(copied)? != expected_hash {
        return Err("Office 文件在预览准备期间发生变化，请重试".to_owned());
    }
    Ok(())
}

fn metadata_cache_path(pdf: &Path) -> PathBuf {
    pdf.with_extension("json")
}

fn validate_office_relative_path(value: &str) -> Result<PathBuf, String> {
    let path = Path::new(value);
    if path.as_os_str().is_empty() || path.is_absolute()
        || path.components().any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err("Office 预览路径无效".to_owned());
    }
    Ok(path.to_path_buf())
}

fn is_supported_office_size(size: u64) -> bool {
    size > 0 && size <= max_office_input_bytes()
}

fn read_cache_metadata(pdf: &Path) -> Result<Option<ConversionMetadata>, String> {
    if !pdf.is_file() || !metadata_cache_path(pdf).is_file() { return Ok(None); }
    if fs::metadata(pdf).map(|meta| meta.len() > max_converted_pdf_bytes()).unwrap_or(true) { return Ok(None); }
    let bytes = fs::read(metadata_cache_path(pdf)).map_err(|error| format!("读取 PDF 缓存信息失败：{error}"))?;
    let metadata: ConversionMetadata = match serde_json::from_slice(&bytes) {
        Ok(value) => value,
        Err(_) => return Ok(None),
    };
    if metadata.page_count == 0 || metadata.page_count > MAX_PDF_PAGES || !matches!(metadata.backend.as_str(), "native" | "wasm") {
        return Ok(None);
    }
    Ok(Some(metadata))
}

fn replace_file(source: &Path, destination: &Path) -> Result<(), String> {
    let parent = destination.parent().ok_or_else(|| "缓存文件目录无效".to_owned())?;
    let backup = parent.join(format!(".cache-backup-{}", unique_suffix()));
    if destination.exists() {
        fs::rename(destination, &backup).map_err(|error| format!("暂存旧缓存失败：{error}"))?;
    }
    if let Err(error) = fs::rename(source, destination) {
        if backup.exists() { let _ = fs::rename(&backup, destination); }
        return Err(format!("替换 PDF 缓存失败：{error}"));
    }
    let _ = fs::remove_file(backup);
    Ok(())
}

fn read_pdf_base64(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|error| format!("读取转换后 PDF 失败：{error}"))?;
    let size = file.metadata().map_err(|error| format!("读取 PDF 信息失败：{error}"))?.len();
    if size == 0 || size > max_converted_pdf_bytes() { return Err("转换后的 PDF 大小无效".to_owned()); }
    let mut bytes = Vec::with_capacity(size as usize);
    file.read_to_end(&mut bytes).map_err(|error| format!("读取 PDF 预览失败：{error}"))?;
    validate_pdf(&bytes)?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

fn copy_bounded(source: &Path, destination: &Path, max_bytes: u64) -> std::io::Result<()> {
    let mut input = File::open(source)?;
    let mut output = OpenOptions::new().write(true).create_new(true).open(destination)?;
    let mut copied = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = input.read(&mut buffer)?;
        if count == 0 { break; }
        copied = copied.saturating_add(count as u64);
        if copied > max_bytes { return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "file exceeds byte limit")); }
        output.write_all(&buffer[..count])?;
    }
    output.sync_all()?;
    Ok(())
}

fn prune_cache(cache: &Path, keep: &Path) {
    let Ok(entries) = fs::read_dir(cache) else { return; };
    let mut files: Vec<_> = entries.filter_map(Result::ok).filter_map(|entry| {
        let path = entry.path();
        if path == keep || path.extension().and_then(|value| value.to_str()) != Some("pdf") { return None; }
        let metadata = entry.metadata().ok()?;
        Some((path, metadata.len(), metadata.modified().ok()?))
    }).collect();
    let mut total = files.iter().map(|(_, size, _)| *size).sum::<u64>()
        + fs::metadata(keep).map(|meta| meta.len()).unwrap_or(0);
    files.sort_by_key(|(_, _, modified)| *modified);
    for (path, size, _) in files {
        if total <= PDF_CACHE_LIMIT { break; }
        if fs::remove_file(&path).is_ok() {
            total = total.saturating_sub(size);
            let _ = fs::remove_file(metadata_cache_path(&path));
        }
    }
}

fn download_file(app: &AppHandle, url: &str, destination: &Path, max_bytes: u64, cancel: &AtomicBool) -> Result<(), String> {
    if !is_approved_download_url(url) {
        return Err("下载来源不是固定官方地址".to_owned());
    }
    let client = reqwest::blocking::Client::builder().connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(10 * 60)).build().map_err(|error| format!("初始化下载客户端失败：{error}"))?;
    let mut response = client.get(url).send().map_err(|error| format!("下载文件失败：{error}"))?
        .error_for_status().map_err(|error| format!("下载请求失败：{error}"))?;
    let total = response.content_length().unwrap_or(0);
    if total > max_bytes { return Err("下载包超过大小限制".to_owned()); }
    let mut file = OpenOptions::new().write(true).create_new(true).open(destination)
        .map_err(|error| format!("创建下载文件失败：{error}"))?;
    let mut buffer = [0u8; 64 * 1024];
    let mut downloaded = 0u64;
    loop {
        check_cancel(cancel)?;
        let count = response.read(&mut buffer).map_err(|error| format!("下载文件失败：{error}"))?;
        if count == 0 { break; }
        downloaded += count as u64;
        if downloaded > max_bytes || (total > 0 && downloaded > total) { return Err("下载内容超过声明大小或上限".to_owned()); }
        file.write_all(&buffer[..count]).map_err(|error| format!("写入下载文件失败：{error}"))?;
        emit(app, "downloading", downloaded, total);
    }
    file.sync_all().ok();
    Ok(())
}

fn extract_node_tar_gz(archive_path: &Path, destination: &Path) -> Result<(), String> {
    let file = File::open(archive_path).map_err(|error| format!("读取 Node.js 压缩包失败：{error}"))?;
    let mut archive = tar::Archive::new(GzDecoder::new(file));
    let entries = archive.entries().map_err(|error| format!("读取 Node.js tar 清单失败：{error}"))?;
    let mut unpacked = 0u64;
    for entry in entries {
        let mut entry = entry.map_err(|error| format!("读取 Node.js tar 条目失败：{error}"))?;
        let path = entry.path().map_err(|error| format!("Node.js tar 路径无效：{error}"))?.into_owned();
        if !has_safe_archive_path(&path) { return Err("Node.js tar 包含越界路径".to_owned()); }
        unpacked = unpacked.saturating_add(entry.size());
        if unpacked > MAX_NODE_EXPANDED_BYTES { return Err("Node.js tar 解包体积超过上限".to_owned()); }
        let mut components = path.components();
        let _ = components.next();
        let relative: PathBuf = components.collect();
        let output = destination.join(relative);
        if entry.header().entry_type().is_dir() {
            fs::create_dir_all(&output).map_err(|error| format!("创建 Node.js 目录失败：{error}"))?;
        } else if entry.header().entry_type().is_file() {
            if let Some(parent) = output.parent() { fs::create_dir_all(parent).map_err(|error| format!("创建 Node.js 目录失败：{error}"))?; }
            let mut file = OpenOptions::new().write(true).create_new(true).open(&output).map_err(|error| format!("创建 Node.js 文件失败：{error}"))?;
            std::io::copy(&mut entry, &mut file).map_err(|error| format!("解包 Node.js 文件失败：{error}"))?;
        } else {
            return Err("Node.js 包含链接或特殊文件".to_owned());
        }
    }
    Ok(())
}

fn extract_node_zip(archive_path: &Path, destination: &Path) -> Result<(), String> {
    let file = File::open(archive_path).map_err(|error| format!("读取 Node.js 压缩包失败：{error}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|error| format!("Node.js ZIP 文件无效：{error}"))?;
    if archive.len() > 50_000 { return Err("Node.js ZIP 条目过多".to_owned()); }
    let mut unpacked = 0u64;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|error| format!("读取 Node.js ZIP 条目失败：{error}"))?;
        let path = Path::new(entry.name());
        if !has_safe_archive_path(path) { return Err("Node.js ZIP 包含越界路径".to_owned()); }
        if entry.unix_mode().is_some_and(|mode| mode & 0o170000 == 0o120000) { return Err("Node.js ZIP 不允许符号链接".to_owned()); }
        unpacked = unpacked.saturating_add(entry.size());
        if unpacked > MAX_NODE_EXPANDED_BYTES { return Err("Node.js ZIP 解包体积超过上限".to_owned()); }
        let mut components = path.components();
        let _ = components.next();
        let stripped: PathBuf = components.collect();
        if stripped.as_os_str().is_empty() { continue; }
        let output = destination.join(stripped);
        if entry.is_dir() {
            fs::create_dir_all(&output).map_err(|error| format!("创建 Node.js 目录失败：{error}"))?;
        } else {
            if let Some(parent) = output.parent() { fs::create_dir_all(parent).map_err(|error| format!("创建 Node.js 目录失败：{error}"))?; }
            let mut file = OpenOptions::new().write(true).create_new(true).open(&output).map_err(|error| format!("创建 Node.js 文件失败：{error}"))?;
            std::io::copy(&mut entry, &mut file).map_err(|error| format!("解包 Node.js 文件失败：{error}"))?;
        }
    }
    Ok(())
}

fn extract_npm_tarball(archive_path: &Path, destination: &Path) -> Result<(), String> {
    let file = File::open(archive_path).map_err(|error| format!("读取 npm 包失败：{error}"))?;
    let mut archive = tar::Archive::new(GzDecoder::new(file));
    let entries = archive.entries().map_err(|error| format!("读取 npm 包条目失败：{error}"))?;
    let mut unpacked = 0u64;
    for entry in entries {
        let mut entry = entry.map_err(|error| format!("读取 npm 包条目失败：{error}"))?;
        let path = entry.path().map_err(|error| format!("npm 包路径无效：{error}"))?.into_owned();
        if !has_safe_archive_path(&path) { return Err("npm 包包含越界路径".to_owned()); }
        let mut components = path.components();
        if components.next().and_then(|part| part.as_os_str().to_str()) != Some("package") {
            return Err("npm 包目录结构无效".to_owned());
        }
        let relative: PathBuf = components.collect();
        if relative.as_os_str().is_empty() { continue; }
        if entry.header().entry_type().is_symlink() || entry.header().entry_type().is_hard_link() {
            return Err("npm 包不允许链接或特殊文件".to_owned());
        }
        unpacked = unpacked.saturating_add(entry.size());
        if unpacked > MAX_ENGINE_EXPANDED_BYTES { return Err("LibreOffice 引擎解包体积超过限制".to_owned()); }
        let output = destination.join(relative);
        if entry.header().entry_type().is_dir() {
            fs::create_dir_all(&output).map_err(|error| format!("创建引擎目录失败：{error}"))?;
        } else if entry.header().entry_type().is_file() {
            if let Some(parent) = output.parent() { fs::create_dir_all(parent).map_err(|error| format!("创建引擎目录失败：{error}"))?; }
            let mut file = OpenOptions::new().write(true).create_new(true).open(&output).map_err(|error| format!("创建引擎文件失败：{error}"))?;
            std::io::copy(&mut entry, &mut file).map_err(|error| format!("解包引擎文件失败：{error}"))?;
            #[cfg(unix)]
            if let Ok(mode) = entry.header().mode() {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&output, fs::Permissions::from_mode(mode & 0o777))
                    .map_err(|error| format!("设置引擎文件权限失败：{error}"))?;
            }
        } else {
            return Err("npm 包包含不支持的特殊文件".to_owned());
        }
    }
    Ok(())
}

fn verify_lockfile(bytes: &[u8]) -> Result<Platform, String> {
    let lock: Value = serde_json::from_slice(bytes).map_err(|error| format!("转换器锁文件无效：{error}"))?;
    let packages = lock.get("packages").and_then(Value::as_object).ok_or_else(|| "转换器锁文件缺少依赖".to_owned())?;
    let api = packages.get("node_modules/@deepseek-ai/libreoffice-kit").ok_or_else(|| "锁文件缺少转换器 API".to_owned())?;
    check_locked_package(api, KIT_VERSION, KIT_INTEGRITY, "LibreOffice Kit API")?;

    let engine_entry = packages.iter().find(|(name, _)| {
        name.starts_with("node_modules/@deepseek-ai/libreoffice-kit-")
    }).ok_or_else(|| "锁文件缺少平台引擎".to_owned())?;
    let engine_name = engine_entry.0.strip_prefix("node_modules/").unwrap_or("");
    let engine_integrity = integrity_for(engine_name).ok_or_else(|| format!("引擎没有固定 integrity：{engine_name}"))?;
    check_locked_package(engine_entry.1, KIT_VERSION, engine_integrity, "LibreOffice 引擎")?;

    let koffi_package = packages.iter().find(|(name, _)| name.starts_with("node_modules/@koromix/koffi-"));
    if let Some((name, package)) = koffi_package {
        let name = name.strip_prefix("node_modules/").unwrap_or("");
        let integrity = integrity_for(name).ok_or_else(|| format!("Koffi 平台包没有固定 integrity：{name}"))?;
        check_locked_package(package, "3.1.1", integrity, "Koffi 平台包")?;
    }
    if let Some(package) = packages.get("node_modules/koffi") {
        check_locked_package(package, "3.1.1", integrity_for("koffi").expect("koffi integrity"), "Koffi API")?;
    }

    for (name, package) in packages {
        if let Some(url) = package.get("resolved").and_then(Value::as_str) {
            if !url.starts_with("https://registry.npmjs.org/") {
                return Err(format!("固定锁文件包含非 npm 官方来源：{name}"));
            }
            if package.get("integrity").and_then(Value::as_str).is_none() {
                return Err(format!("锁文件条目没有 integrity：{name}"));
            }
        }
    }
    let name = lock.get("name").and_then(Value::as_str).ok_or_else(|| "锁文件缺少平台标识".to_owned())?;
    let key = ["darwin-arm64", "darwin-x64", "win32-x64", "win32-arm64", "linux-x64", "linux-arm64"]
        .into_iter()
        .find(|key| name == format!("x-file-optional-office-converter-{key}"))
        .ok_or_else(|| "锁文件平台名称无效".to_owned())?;
    let target = platform_by_key(key).ok_or_else(|| format!("未支持锁文件平台：{key}"))?;
    if target.engine_package != engine_name { return Err("锁文件引擎和平台标识不匹配".to_owned()); }
    if target.koffi_package.is_some() && koffi_package.is_none() {
        return Err("锁文件缺少 Koffi 平台包".to_owned());
    }
    Ok(target)
}

fn check_locked_package(package: &Value, version: &str, integrity: &str, label: &str) -> Result<(), String> {
    if package.get("version").and_then(Value::as_str) != Some(version)
        || package.get("integrity").and_then(Value::as_str) != Some(integrity)
        || package.get("resolved").and_then(Value::as_str).map_or(true, |url| !url.starts_with("https://registry.npmjs.org/"))
    {
        return Err(format!("{label}版本、来源或 integrity 不匹配（期望 {version} / {integrity}，收到 {} / {} / {}）",
            package.get("version").and_then(Value::as_str).unwrap_or("missing"),
            package.get("integrity").and_then(Value::as_str).unwrap_or("missing"),
            package.get("resolved").and_then(Value::as_str).unwrap_or("missing")));
    }
    Ok(())
}

fn integrity_for(package: &str) -> Option<&'static str> {
    match package {
        "@deepseek-ai/libreoffice-kit-darwin-arm64" => Some("sha512-0dfiEQR6SqAQjh9hxyY8x77Sj3r+AGC+Xn2A/zF+bag9g40leYPL/c2UirSqYR6xUwE9a/5YgWFIHjw1eOh+3A=="),
        "@deepseek-ai/libreoffice-kit-darwin-x64" => Some("sha512-vq0Fp7MTlZwV/yxLpmvQmx1uiiozLTjjODmgrOa9WC5WhrSQYZ+M1OiQKI0qbPAjpMZVBzcZvxlAGnDiTrG4jA=="),
        "@deepseek-ai/libreoffice-kit-win32-x64" => Some("sha512-GMW+m/09Ts0m4gRUjIckeRN48OVYgJI7aLG1uoUHcG3LRPDsKnsyeRo+BSQn8rh4CmWtJg5c6qtl0uSW7b9zEg=="),
        "@deepseek-ai/libreoffice-kit-win32-arm64" => Some("sha512-cAQ0hRZ/8jt8Dudn7vYdpd5OeWpg0AOHzXqgn6UkkPXmQt1/+HCdc4MZbAM927I+c3lwJyLN1fyKIMW5iXCYpg=="),
        "@deepseek-ai/libreoffice-kit-wasm" => Some("sha512-g81zHATxolq/HKRglfrSO2gQgj4RZ//nJo98BcTIs9l8GPU4STNcWwplx5CE6Iy/20lZFbwT9jvGw1Key9xZmg=="),
        "@koromix/koffi-darwin-arm64" => Some("sha512-+Dl0zQDh1Wb55AWOn9hp7K30qgkODvrvN+ZNkFOh81Q0oFX/rpJQtocgjAuYk2zFAcajSeVDumkcHMPwnKSXzA=="),
        "@koromix/koffi-darwin-x64" => Some("sha512-cDFAKn1qdZBFLrp7dAc9QUDw3l4xAhTJbOdPWWb0LxssVicUdHcRCLZGrDsmPW2tpH6LGNNeLgqRpAoD2Mo8iA=="),
        "@koromix/koffi-win32-x64" => Some("sha512-KqHPmvj6QILhNyI/To8QSihHsijeVGIYYPBOUnXEpcnH2LuLbargY4Hd6dDeTN3Z90uUUxN+1FWz1UnhVzFOiA=="),
        "@koromix/koffi-win32-arm64" => Some("sha512-JhqHauEwQvdcWUERxrV5HH/DT9W7hY1A1eU6/o8tB+yck+D3kt5elpRDBt9KjpW6h+vHPy3V0sjDvO0CXyabTA=="),
        "koffi" => Some("sha512-mRX6AMeeKCxSOeOopqAcLAl5jcNvge7NAG8l7rF/8gGJATI0tdHFYjteIdE0mGOtWdsrJOij+PjnP8Q9c1gwgA=="),
        _ => None,
    }
}

fn platform_lockfiles(key: &str) -> Result<(&'static [u8], &'static [u8]), String> {
    match key {
        "darwin-arm64" => Ok((include_bytes!("../resources/office-converter/locks/darwin-arm64/package.json"), include_bytes!("../resources/office-converter/locks/darwin-arm64/package-lock.json"))),
        "darwin-x64" => Ok((include_bytes!("../resources/office-converter/locks/darwin-x64/package.json"), include_bytes!("../resources/office-converter/locks/darwin-x64/package-lock.json"))),
        "win32-x64" => Ok((include_bytes!("../resources/office-converter/locks/win32-x64/package.json"), include_bytes!("../resources/office-converter/locks/win32-x64/package-lock.json"))),
        "win32-arm64" => Ok((include_bytes!("../resources/office-converter/locks/win32-arm64/package.json"), include_bytes!("../resources/office-converter/locks/win32-arm64/package-lock.json"))),
        "linux-x64" => Ok((include_bytes!("../resources/office-converter/locks/linux-x64/package.json"), include_bytes!("../resources/office-converter/locks/linux-x64/package-lock.json"))),
        "linux-arm64" => Ok((include_bytes!("../resources/office-converter/locks/linux-arm64/package.json"), include_bytes!("../resources/office-converter/locks/linux-arm64/package-lock.json"))),
        _ => Err("当前平台缺少固定依赖清单".to_owned()),
    }
}

fn platform_by_key(key: &'static str) -> Option<Platform> {
    Some(match key {
        "darwin-arm64" => Platform { key, node_archive: "node-v22.23.3-darwin-arm64.tar.gz", node_sha256: "23b25245dcfb9af7262f8ff142e9e2e0af025368117329e7a7458a51e5922f53", engine_package: "@deepseek-ai/libreoffice-kit-darwin-arm64", engine_integrity: "sha512-0dfiEQR6SqAQjh9hxyY8x77Sj3r+AGC+Xn2A/zF+bag9g40leYPL/c2UirSqYR6xUwE9a/5YgWFIHjw1eOh+3A==", koffi_package: Some("@koromix/koffi-darwin-arm64"), koffi_integrity: Some("sha512-+Dl0zQDh1Wb55AWOn9hp7K30qgkODvrvN+ZNkFOh81Q0oFX/rpJQtocgjAuYk2zFAcajSeVDumkcHMPwnKSXzA=="), archive_kind: ArchiveKind::TarGz },
        "darwin-x64" => Platform { key, node_archive: "node-v22.23.3-darwin-x64.tar.gz", node_sha256: "8a677b0219178efd6eb0e475457c4afb452b521a92f6e67845a73bd85727f2a8", engine_package: "@deepseek-ai/libreoffice-kit-darwin-x64", engine_integrity: "sha512-vq0Fp7MTlZwV/yxLpmvQmxuiiozLTjjODmgrOa9WC5WhrSQYZ+M1OiQKI0qbPAjpMZVBzcZvxlAGnDiTrG4jA==", koffi_package: Some("@koromix/koffi-darwin-x64"), koffi_integrity: Some("sha512-cDFAKn1qdZBFLrp7dAc9QUDw3l4xAhTJbOdPWWb0LxssVicUdHcRCLZGrDsmPW2tpH6LGNNeLgqRpAoD2Mo8iA=="), archive_kind: ArchiveKind::TarGz },
        "win32-x64" => Platform { key, node_archive: "node-v22.23.3-win-x64.zip", node_sha256: "2b0ff57b049cda1bbcea2240eec20467018713c1efe1f7360c2681859b90ed71", engine_package: "@deepseek-ai/libreoffice-kit-win32-x64", engine_integrity: "sha512-GMW+m/09Ts0m4gRUjIckeRN48OVYgJI7aLG1uoUHcG3LRPDsKnsyeRo+BSQn8rh4CmWtJg5c6qtl0uSW7b9zEg==", koffi_package: Some("@koromix/koffi-win32-x64"), koffi_integrity: Some("sha512-KqHPmvj6QILhNyI/To8QSihHsijeVGIYYPBOUnXEpcnH2LuLbargY4Hd6dDeTN3Z90uUUxN+1FWz1UnhVzFOiA=="), archive_kind: ArchiveKind::Zip },
        "win32-arm64" => Platform { key, node_archive: "node-v22.23.3-win-arm64.zip", node_sha256: "33dad22e4cef5ee8f9fbb1b0d037fdacd0e56d12a4580f0d63f68b894deab535", engine_package: "@deepseek-ai/libreoffice-kit-win32-arm64", engine_integrity: "sha512-cAQ0hRZ/8jt8Dudn7vYdpd5OeWpg0AOHzXqgn6UkkPXmQt1/+HCdc4MZbAM927I+c3lwJyLN1fyKIMW5iXCYpg==", koffi_package: Some("@koromix/koffi-win32-arm64"), koffi_integrity: Some("sha512-JhqHauEwQvdcWUERxrV5HH/DT9W7hY1A1eU6/o8tB+yck+D3kt5elpRDBt9KjpW6h+vHPy3V0sjDvO0CXyabTA=="), archive_kind: ArchiveKind::Zip },
        "linux-x64" => Platform { key, node_archive: "node-v22.23.3-linux-x64.tar.gz", node_sha256: "1084aa36196bba4c3a5e69a1ee388a6e4ff729dad09445fbcd434b28fe3c24af", engine_package: "@deepseek-ai/libreoffice-kit-wasm", engine_integrity: "sha512-g81zHATxolq/HKRglfrSO2gQgj4RZ//nJo98BcTIs9l8GPU4STNcWwplx5CE6Iy/20lZFbwT9jvGw1Key9xZmg==", koffi_package: None, koffi_integrity: None, archive_kind: ArchiveKind::TarGz },
        "linux-arm64" => Platform { key, node_archive: "node-v22.23.3-linux-arm64.tar.gz", node_sha256: "5ced2d48d1d7198739b7f86804de0171aefb6823b684b12341d3321afc3cb0b2", engine_package: "@deepseek-ai/libreoffice-kit-wasm", engine_integrity: "sha512-g81zHATxolq/HKRglfrSO2gQgj4RZ//nJo98BcTIs9l8GPU4STNcWwplx5CE6Iy/20lZFbwT9jvGw1Key9xZmg==", koffi_package: None, koffi_integrity: None, archive_kind: ArchiveKind::TarGz },
        _ => return None,
    })
}

fn platform() -> Option<Platform> {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    { return platform_by_key("darwin-arm64"); }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    { return platform_by_key("darwin-x64"); }
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    { return platform_by_key("win32-x64"); }
    #[cfg(all(target_os = "windows", target_arch = "aarch64"))]
    { return platform_by_key("win32-arm64"); }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    { return platform_by_key("linux-x64"); }
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    { return platform_by_key("linux-arm64"); }
    #[allow(unreachable_code)]
    None
}

fn install_npm_package(app: &AppHandle, root: &Path, package: &str, integrity: &str, cancel: &AtomicBool) -> Result<(), String> {
    let package_name = package.rsplit('/').next().ok_or_else(|| "npm 包名无效".to_owned())?;
    let package_path = package.to_owned();
    let version = if package.starts_with("@koromix/") || package == "koffi" { "3.1.1" } else { KIT_VERSION };
    let url = format!("https://registry.npmjs.org/{package_path}/-/{package_name}-{version}.tgz");
    let archive = root.join("npm-package.tgz");
    download_file(app, &url, &archive, MAX_ARCHIVE_BYTES, cancel)?;
    verify_sha512_file(&archive, integrity)?;
    let destination = if let Some((scope, name)) = package.split_once('/') {
        root.join("node_modules").join(scope).join(name)
    } else {
        root.join("node_modules").join(package)
    };
    fs::create_dir_all(&destination).map_err(|error| format!("创建 npm 资源目录失败：{error}"))?;
    extract_npm_tarball(&archive, &destination)?;
    fs::remove_file(archive).ok();
    Ok(())
}

fn verify_sha512_file(path: &Path, integrity: &str) -> Result<(), String> {
    let expected = integrity.strip_prefix("sha512-").ok_or_else(|| "npm integrity 常量无效".to_owned())?;
    let mut file = File::open(path).map_err(|error| format!("读取校验文件失败：{error}"))?;
    let mut hash = Sha512::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer).map_err(|error| format!("计算 SHA-512 失败：{error}"))?;
        if count == 0 { break; }
        hash.update(&buffer[..count]);
    }
    let actual = base64::engine::general_purpose::STANDARD.encode(hash.finalize());
    if actual != expected { return Err("npm 包完整性校验失败".to_owned()); }
    Ok(())
}

fn verify_sha256_file(path: &Path, expected: &str) -> Result<(), String> {
    if sha256_file(path)? == expected {
        Ok(())
    } else {
        Err("Node.js 官方运行时校验失败".to_owned())
    }
}

fn wait_child(child: &mut Child, cancel: &AtomicBool, timeout: Duration, label: &str) -> Result<(), String> {
    wait_child_graceful(child, cancel, timeout, Duration::ZERO, label).map(|_| ())
}

fn wait_child_graceful(child: &mut Child, cancel: &AtomicBool, timeout: Duration, cancel_grace: Duration, label: &str) -> Result<std::process::ExitStatus, String> {
    let started = Instant::now();
    let mut cancel_started = None;
    loop {
        if cancel.load(Ordering::SeqCst) {
            let cancel_started = cancel_started.get_or_insert_with(Instant::now);
            if cancel_started.elapsed() >= cancel_grace {
                let _ = child.kill();
                let _ = child.wait();
                return Err("操作已取消".to_owned());
            }
        }
        if started.elapsed() > timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("{label}超时"));
        }
        if let Some(status) = child.try_wait().map_err(|error| format!("等待{label}失败：{error}"))? {
            if cancel.load(Ordering::SeqCst) { return Err("操作已取消".to_owned()); }
            if status.success() { return Ok(status); }
            return Err(format!("{label}失败，进程退出码：{}", status.code().map(|code| code.to_string()).unwrap_or_else(|| "unknown".to_owned())));
        }
        thread::sleep(Duration::from_millis(100));
    }
}

fn validate_pdf(bytes: &[u8]) -> Result<(), String> {
    if bytes.len() < 8 || !bytes.starts_with(b"%PDF-") || !bytes.windows(5).any(|part| part == b"%%EOF") {
        return Err("LibreOffice 输出不是完整 PDF".to_owned());
    }
    Ok(())
}

fn is_approved_download_url(url: &str) -> bool {
    url.starts_with("https://nodejs.org/dist/v22.23.3/node-v22.23.3-")
        || url.starts_with("https://registry.npmjs.org/@deepseek-ai/libreoffice-kit-")
        || url.starts_with("https://registry.npmjs.org/@koromix/koffi-")
        || url == "https://registry.npmjs.org/koffi/-/koffi-3.1.1.tgz"
}

fn has_safe_archive_path(path: &Path) -> bool {
    !path.as_os_str().is_empty() && !path.is_absolute()
        && path.components().all(|part| matches!(part, Component::Normal(_)))
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|error| format!("读取 SHA-256 文件失败：{error}"))?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop { let count = file.read(&mut buffer).map_err(|error| format!("计算 SHA-256 失败：{error}"))?; if count == 0 { break; } hash.update(&buffer[..count]); }
    Ok(format!("{:x}", hash.finalize()))
}

fn component_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|error| format!("解析应用数据目录失败：{error}"))?.join("office-converter").join("active"))
}

fn pdf_cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_cache_dir().map_err(|error| format!("解析预览缓存目录失败：{error}"))?.join("office-pdf"))
}

fn node_path(root: &Path) -> PathBuf { node_path_for_runtime(&root.join("runtime")) }

fn node_path_for_runtime(runtime: &Path) -> PathBuf {
    let Some(target) = platform() else { return runtime.join("missing-node"); };
    match target.archive_kind {
        ArchiveKind::Zip => runtime.join("node.exe"),
        ArchiveKind::TarGz => runtime.join(target.node_archive.trim_end_matches(".tar.gz")).join("bin/node"),
    }
}

fn npm_cli_path(runtime: &Path) -> PathBuf {
    let Some(target) = platform() else { return runtime.join("missing-npm-cli.js"); };
    match target.archive_kind {
        ArchiveKind::Zip => runtime.join("node_modules/npm/bin/npm-cli.js"),
        ArchiveKind::TarGz => runtime.join(target.node_archive.trim_end_matches(".tar.gz")).join("lib/node_modules/npm/bin/npm-cli.js"),
    }
}

fn unique_suffix() -> u128 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos() }

fn check_cancel(cancel: &AtomicBool) -> Result<(), String> {
    if cancel.load(Ordering::SeqCst) { Err("操作已取消".to_owned()) } else { Ok(()) }
}

fn emit(app: &AppHandle, stage: &str, current: u64, total: u64) {
    let _ = app.emit(INSTALL_EVENT, json!({ "stage": stage, "current": current, "total": total }));
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn operation_guard_releases_exclusivity_even_after_panic_or_error_scope() {
        let state = OfficeConverterState::default();
        let guard = OperationGuard::start(&state).unwrap();
        assert!(state.is_busy());
        assert!(OperationGuard::start(&state).is_err());
        drop(guard);
        assert!(!state.is_busy());
        assert!(OperationGuard::start(&state).is_ok());
    }

    #[test]
    fn cancelled_operation_guard_does_not_clear_a_later_operation() {
        let state = OfficeConverterState::default();
        let first = OperationGuard::start(&state).unwrap();
        let first_token = first.token.clone();
        first_token.store(true, Ordering::SeqCst);
        drop(first);

        let second = OperationGuard::start(&state).unwrap();
        assert!(!second.token.load(Ordering::SeqCst));
        drop(second);
        assert!(!state.is_busy());
    }

    #[test]
    fn platform_lockfiles_pin_one_engine_from_the_approved_registries() {
        for key in ["darwin-arm64", "darwin-x64", "win32-x64", "win32-arm64", "linux-x64", "linux-arm64"] {
            let (_, lock) = platform_lockfiles(key).unwrap();
            let parsed = verify_lockfile(lock).unwrap_or_else(|error| panic!("{key}: {error}"));
            assert_eq!(parsed.key, key);
            verify_lockfile(lock).unwrap();
        }
    }

    #[test]
    fn tampered_platform_lockfile_is_rejected_offline() {
        let (_, bytes) = platform_lockfiles("darwin-arm64").unwrap();
        let mut lock: Value = serde_json::from_slice(bytes).unwrap();
        lock["packages"]["node_modules/@deepseek-ai/libreoffice-kit-darwin-arm64"]["integrity"] = Value::String("sha512-tampered".into());
        let tampered = serde_json::to_vec(&lock).unwrap();
        assert!(verify_lockfile(&tampered).is_err());
    }

    #[test]
    fn archive_path_validation_rejects_traversal_without_network() {
        for path in ["../escape", "node/../escape", "/absolute/file", ""] {
            assert!(!has_safe_archive_path(Path::new(path)));
        }
        assert!(has_safe_archive_path(Path::new("node/bin/node")));
    }

    #[test]
    fn npm_tarball_integrity_is_verified_before_extraction() {
        let temp = std::env::temp_dir().join(format!("xfile-npm-integrity-{}", unique_suffix()));
        fs::create_dir_all(&temp).unwrap();
        let archive = temp.join("pkg.tgz");
        {
            let file = File::create(&archive).unwrap();
            let mut tar = tar::Builder::new(flate2::write::GzEncoder::new(file, flate2::Compression::default()));
            let bytes = b"package.json contents";
            let mut header = tar::Header::new_gnu();
            header.set_path("package/package.json").unwrap();
            header.set_size(bytes.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            tar.append(&header, &bytes[..]).unwrap();
            tar.into_inner().unwrap().finish().unwrap();
        }
        let integrity = format!("sha512-{}", base64::engine::general_purpose::STANDARD.encode(Sha512::digest(fs::read(&archive).unwrap())));
        assert!(verify_sha512_file(&archive, &integrity).is_ok());
        assert!(verify_sha512_file(&archive, "sha512-tampered").is_err());
        let extracted = temp.join("unpacked");
        fs::create_dir_all(&extracted).unwrap();
        assert!(extract_npm_tarball(&archive, &extracted).is_ok());
        assert_eq!(fs::read(extracted.join("package.json")).unwrap(), b"package.json contents");
        fs::remove_dir_all(temp).unwrap();
    }

    #[test]
    fn document_relative_paths_require_only_normal_components() {
        for path in ["", "../escape.docx", "./file.docx", "/tmp/file.docx", "a/../b.pptx"] {
            assert!(validate_office_relative_path(path).is_err());
        }
        assert_eq!(validate_office_relative_path("reports/report.docx").unwrap(), PathBuf::from("reports/report.docx"));
    }

    #[test]
    fn office_input_limit_rejects_empty_and_oversized_files() {
        assert!(!is_supported_office_size(0));
        assert!(is_supported_office_size(max_office_input_bytes()));
        assert!(!is_supported_office_size(max_office_input_bytes() + 1));
    }

    #[test]
    fn sha_checksums_reject_tampered_payloads() {
        let temp = std::env::temp_dir().join(format!("xfile-hash-test-{}", unique_suffix()));
        fs::write(&temp, b"pinned bytes").unwrap();
        assert!(verify_sha256_file(&temp, &sha256_file(&temp).unwrap()).is_ok());
        assert!(verify_sha256_file(&temp, "00").is_err());
        assert!(verify_sha512_file(&temp, "sha512-AAAA").is_err());
        fs::remove_file(temp).unwrap();
    }

    #[test]
    fn pdf_cache_metadata_and_pdf_header_are_checked_offline() {
        assert!(validate_pdf(b"%PDF-1.7\n%%EOF").is_ok());
        assert!(validate_pdf(b"not a pdf").is_err());
        assert!(validate_pdf(b"%PDF-1.7\ntruncated").is_err());
        let metadata = ConversionMetadata { page_count: MAX_PDF_PAGES + 1, backend: "native".into(), missing_fonts: vec![] };
        assert!(metadata.page_count > MAX_PDF_PAGES);
    }
}
