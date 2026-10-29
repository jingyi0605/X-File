use crate::native_core::task_center;
use crate::native_core::catalog::{
    read_catalog, write_catalog, ExportCatalogSnapshot, SnapshotDocument, SnapshotTag,
};
use crate::native_core::state_store::{
    active_file_state_snapshot_path, export_catalog_snapshot_path, index_state_snapshot_path,
    indexed_document_journal_path, priority_hints_path, runtime_status_path,
};
use crate::native_core::state_store::{file_version, write_compact_json, FileVersion};
use crate::read_optional_json_file;
use chrono::Datelike;
use flate2::read::{DeflateDecoder, ZlibDecoder};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashSet, VecDeque};
use std::fs;
use std::io::{BufWriter, Cursor, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use zip::ZipArchive;

const INDEX_COOLDOWN_MS: i64 = 1500;
const INDEX_PROGRESS_FLUSH_INTERVAL_MS: i64 = 500;
const INDEX_PARTIAL_SNAPSHOT_FLUSH_INTERVAL_MS: i64 = 5000;
const SUMMARY_TEXT_MAX_BYTES: usize = 2 * 1024;
const SUMMARY_MAX_CHARS: usize = 1000;
// XML 标签也占空间；只给正文前缀少量余量，不为摘要遍历整份办公文档。
const SUMMARY_ARCHIVE_ENTRY_MAX_BYTES: usize = 8 * 1024;
const SUMMARY_PDF_MAX_BYTES: usize = 2 * 1024 * 1024;
const SUMMARY_PDF_MAX_PAGES: usize = 3;
const SUMMARY_XLSX_MAX_ROWS_PER_SHEET: usize = 20;
const PDF_INFLATE_MAX_BYTES: u64 = 512 * 1024;

const NATIVE_SKIP_ONLY_EXTENSIONS: &[&str] =
    &[".doc", ".wps", ".xls", ".et", ".numbers", ".ppt", ".key"];

#[derive(Debug, Clone)]
pub struct NativeIndexRequest {
    pub root_dir: String,
    pub allowed_extensions: Vec<String>,
    pub included_hidden_paths: Vec<String>,
    pub hide_dot_files: bool,
    pub hide_system_folders: bool,
    pub reason: String,
    pub target_path: Option<String>,
    pub target_paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
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
    progress: Option<IndexProgress>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct IndexProgress {
    scanned_count: usize,
    indexed_count: usize,
    skipped_count: usize,
    failed_count: usize,
    unchanged_count: usize,
    total_count: Option<usize>,
    max_concurrency: Option<usize>,
    active_task_count: usize,
    pending_task_count: usize,
    completed_task_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DirtyScope {
    trigger: String,
    changed_paths: Vec<String>,
    deleted_paths: Vec<String>,
    dirty_directories: Vec<String>,
    dirty_tag_paths: Vec<String>,
    dirty_meta_shards: Vec<String>,
    dirty_detail_shards: Vec<String>,
    dirty_posting_buckets: Vec<String>,
    dirty_relations: Vec<String>,
}

#[derive(Debug, Clone)]
struct ScannedDocument {
    relative_path: String,
    extension: String,
    size: u64,
    title: String,
    summary: String,
    tags: Vec<String>,
    mtime: String,
    derived_tags: Vec<String>,
    reused_previous: bool,
}

#[derive(Debug, Clone)]
struct ScannedFile {
    relative_path: String,
    full_path: PathBuf,
    extension: String,
    size: u64,
    mtime: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeIndexedDocumentState {
    path: String,
    extension: String,
    size: u64,
    mtime: String,
    index_status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeParserSkipState {
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
struct RuntimeActiveFileStateSnapshot {
    version: u32,
    generated_at: String,
    files: Vec<RuntimeIndexedDocumentState>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeIndexStateSnapshot {
    version: u32,
    generated_at: String,
    failed_documents: Vec<RuntimeIndexedDocumentState>,
    skipped_documents: Vec<RuntimeIndexedDocumentState>,
    parser_skips: Vec<RuntimeParserSkipState>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeIndexedDocumentJournalEntry {
    active: RuntimeIndexedDocumentState,
    document: SnapshotDocument,
}

#[derive(Debug, Clone)]
struct RuntimeSkipRecordInput {
    path: String,
    extension: String,
    size: u64,
    mtime: String,
    adapter: String,
    reason_code: String,
    message: String,
}

#[derive(Debug, Clone, Default)]
struct ScanProgressStats {
    total_count: Option<usize>,
    scanned_count: usize,
    indexed_count: usize,
    skipped_count: usize,
    unchanged_count: usize,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimePriorityHints {
    updated_at: Option<String>,
    paths: Vec<String>,
}

#[derive(Debug, Clone)]
enum TargetScope {
    All,
    Paths {
        files: BTreeSet<String>,
        directories: BTreeSet<String>,
    },
}

pub fn run_native_index_worker(request: NativeIndexRequest) -> Result<Value, String> {
    let root_dir = request.root_dir.trim().to_string();
    if root_dir.is_empty() {
        return Err("native index worker 缺少 rootDir".to_string());
    }
    let started_at_instant = std::time::Instant::now();
    let last_requested_at = iso_now();
    let last_started_at = iso_now();
    write_runtime_status(
        &root_dir,
        PersistedRuntimeStatus {
            state: "running".to_string(),
            last_requested_at: Some(last_requested_at.clone()),
            last_started_at: Some(last_started_at.clone()),
            last_completed_at: None,
            last_failed_at: None,
            next_allowed_at: None,
            progress_updated_at: Some(last_started_at.clone()),
            running_stage: Some("index_text".to_string()),
            error_summary: None,
            progress: Some(build_running_index_progress(&ScanProgressStats::default())),
        },
    )?;

    let result = (|| -> Result<(String, DirtyScope, IndexProgress, Value), String> {
        let recovery_pending = fs::metadata(indexed_document_journal_path(&root_dir))
            .is_ok_and(|metadata| metadata.len() > 0);
        let options = NativeIndexOptions::from_request(&request);
        let target_scope = if request.target_paths.is_empty() {
            resolve_target_scope(&root_dir, request.target_path.as_deref())
        } else {
            resolve_target_paths(&root_dir, &request.target_paths)
        };
        let previous_state = load_previous_native_index_state(&root_dir);
        let scanned = scan_documents(
            &root_dir,
            &options,
            &target_scope,
            previous_state.as_deref(),
            |progress| {
                task_center::progress(progress.scanned_count, progress.total_count);
                let progress_updated_at = iso_now();
                write_runtime_status(
                    &root_dir,
                    PersistedRuntimeStatus {
                        state: "running".to_string(),
                        last_requested_at: Some(last_requested_at.clone()),
                        last_started_at: Some(last_started_at.clone()),
                        last_completed_at: None,
                        last_failed_at: None,
                        next_allowed_at: None,
                        progress_updated_at: Some(progress_updated_at),
                        running_stage: Some("index_text".to_string()),
                        error_summary: None,
                        progress: Some(progress),
                    },
                )
            },
        )?;
        let snapshot_path = if scanned
            .documents
            .iter()
            .any(|document| !document.reused_previous)
            || recovery_pending
            || !scanned.deleted_paths.is_empty()
            || !export_catalog_snapshot_path(&root_dir).exists()
        {
            write_export_snapshot(
                &root_dir,
                &scanned.documents,
                &target_scope,
                previous_state.as_deref(),
            )?
        } else {
            export_catalog_snapshot_path(&root_dir)
                .to_string_lossy()
                .to_string()
        };
        let state_changed = recovery_pending
            || !scanned.deleted_paths.is_empty()
            || scanned
                .documents
                .iter()
                .any(|document| !document.reused_previous)
            || scanned.skipped_documents.iter().any(|skip| {
                previous_state
                    .as_ref()
                    .and_then(|state| state.active_files.get(&skip.path))
                    != Some(skip)
            });
        if state_changed || !active_file_state_snapshot_path(&root_dir).is_file() {
            write_runtime_mirror_snapshots_with_state(
                &root_dir,
                &scanned,
                &target_scope,
                previous_state.as_deref(),
            )?;
        } else {
            clear_indexed_document_journal(&root_dir)?;
        }
        drop(previous_state);
        if state_changed {
            commit_cached_state(&root_dir, &scanned);
        }
        let progress = IndexProgress {
            scanned_count: scanned.total_scanned,
            indexed_count: scanned
                .documents
                .iter()
                .filter(|document| !document.reused_previous)
                .count(),
            skipped_count: scanned.skipped_count,
            failed_count: 0,
            unchanged_count: scanned.unchanged_count,
            total_count: Some(scanned.total_scanned),
            max_concurrency: Some(1),
            active_task_count: 0,
            pending_task_count: 0,
            completed_task_count: scanned.total_scanned,
        };
        let dirty_scope = build_dirty_scope(&scanned.documents, &scanned.deleted_paths);
        let index_result = build_native_text_index_result(
            &scanned,
            &dirty_scope,
            started_at_instant.elapsed().as_secs_f64() * 1000.0,
        );
        Ok((snapshot_path, dirty_scope, progress, index_result))
    })();

    match result {
        Ok((snapshot_path, dirty_scope, progress, index_result)) => {
            let completed_at = iso_now();
            let next_allowed_at =
                iso_after_ms(INDEX_COOLDOWN_MS).unwrap_or_else(|| completed_at.clone());
            write_runtime_status(
                &root_dir,
                PersistedRuntimeStatus {
                    state: "cooldown".to_string(),
                    last_requested_at: Some(last_requested_at.clone()),
                    last_started_at: Some(last_started_at.clone()),
                    last_completed_at: Some(completed_at.clone()),
                    last_failed_at: None,
                    next_allowed_at: Some(next_allowed_at.clone()),
                    progress_updated_at: Some(completed_at.clone()),
                    running_stage: None,
                    error_summary: None,
                    progress: Some(progress.clone()),
                },
            )?;
            Ok(json!({
                "accepted": true,
                "mode": "index-only",
                "reason": request.reason,
                "targetPath": request.target_path,
                "taskId": Value::Null,
                "deduped": false,
                "status": {
                    "state": "cooldown",
                    "lastRequestedAt": last_requested_at,
                    "lastStartedAt": last_started_at,
                    "lastCompletedAt": completed_at,
                    "nextAllowedAt": next_allowed_at,
                    "runningStage": Value::Null,
                    "errorSummary": Value::Null,
                    "progress": progress,
                },
                "dirtyScope": dirty_scope,
                "dirtyScopeSummary": {
                    "trigger": dirty_scope.trigger,
                    "changedPathCount": dirty_scope.changed_paths.len(),
                    "deletedPathCount": dirty_scope.deleted_paths.len(),
                    "dirtyDirectoryCount": dirty_scope.dirty_directories.len(),
                },
                "index": index_result,
                "exportCatalogSnapshotPath": snapshot_path,
                "worker": "native-rust",
            }))
        }
        Err(error) => {
            write_runtime_status(
                &root_dir,
                PersistedRuntimeStatus {
                    state: "failed".to_string(),
                    last_requested_at: Some(last_requested_at),
                    last_started_at: Some(last_started_at),
                    last_completed_at: None,
                    last_failed_at: Some(iso_now()),
                    next_allowed_at: None,
                    progress_updated_at: Some(iso_now()),
                    running_stage: Some("index_text".to_string()),
                    error_summary: Some(error.clone()),
                    progress: None,
                },
            )?;
            Err(error)
        }
    }
}

fn is_native_skip_only_extension(extension: &str) -> bool {
    let normalized = extension.trim().to_lowercase();
    let normalized = if normalized.starts_with('.') {
        normalized
    } else {
        format!(".{normalized}")
    };
    NATIVE_SKIP_ONLY_EXTENSIONS.contains(&normalized.as_str())
}

#[derive(Debug, Clone)]
struct NativeIndexOptions {
    allowed_extensions: Option<HashSet<String>>,
    included_hidden_paths: Vec<String>,
    hide_dot_files: bool,
    hide_system_folders: bool,
}

impl NativeIndexOptions {
    fn from_request(request: &NativeIndexRequest) -> Self {
        let allowed_extensions = normalize_allowed_extensions(&request.allowed_extensions);
        let included_hidden_paths = normalize_included_hidden_paths(&request.included_hidden_paths);
        Self {
            allowed_extensions,
            included_hidden_paths,
            hide_dot_files: request.hide_dot_files,
            hide_system_folders: request.hide_system_folders,
        }
    }
}

struct ScanDocumentsResult {
    documents: Vec<ScannedDocument>,
    skipped_documents: Vec<RuntimeIndexedDocumentState>,
    parser_skips: Vec<RuntimeParserSkipState>,
    total_scanned: usize,
    unchanged_count: usize,
    skipped_count: usize,
    deleted_paths: Vec<String>,
}

fn build_native_text_index_result(
    scanned: &ScanDocumentsResult,
    dirty_scope: &DirtyScope,
    total_duration_ms: f64,
) -> Value {
    let indexed_paths = scanned
        .documents
        .iter()
        .filter(|document| !document.reused_previous)
        .map(|document| document.relative_path.clone())
        .collect::<Vec<_>>();
    let skipped_paths = scanned
        .skipped_documents
        .iter()
        .map(|document| document.path.clone())
        .collect::<Vec<_>>();
    let skipped_by_extension = scanned.skipped_documents.iter().fold(
        BTreeMap::<String, usize>::new(),
        |mut acc, document| {
            *acc.entry(document.extension.clone()).or_insert(0) += 1;
            acc
        },
    );
    let indexed_count = indexed_paths.len();

    json!({
        "scannedCount": scanned.total_scanned,
        "indexedCount": indexed_count,
        "unchangedCount": scanned.unchanged_count,
        "indexedPaths": indexed_paths,
        "skippedPaths": skipped_paths,
        "failedPaths": [],
        "failedCount": 0,
        "failures": [],
        "failureOverflowCount": 0,
        "deletedCount": scanned.deleted_paths.len(),
        "deletedPaths": scanned.deleted_paths,
        "dirtyScope": dirty_scope,
        "timingsMs": { "total": total_duration_ms },
        "skipStats": {
            "skippedCount": scanned.skipped_documents.len(),
            "skippedByExtension": skipped_by_extension,
            "skipCatalogRecords": scanned.parser_skips.len(),
        },
    })
}

#[derive(Debug, Clone, Default)]
struct PreviousNativeIndexState {
    active_files: BTreeMap<String, RuntimeIndexedDocumentState>,
    documents: BTreeMap<String, SnapshotDocument>,
}

enum ScanFileOutcome {
    Indexed(ScannedFile),
    Skipped(RuntimeSkipRecordInput),
    Ignored,
}

fn scan_documents(
    root_dir: &str,
    options: &NativeIndexOptions,
    target_scope: &TargetScope,
    previous_state: Option<&PreviousNativeIndexState>,
    mut progress_reporter: impl FnMut(IndexProgress) -> Result<(), String>,
) -> Result<ScanDocumentsResult, String> {
    let root = PathBuf::from(root_dir);
    task_center::stage("scan_files");
    let files = task_center::run_new(root_dir, "library.file_scan", "index_discovery", None, || {
        discover_scannable_files(root_dir, &root, options, target_scope)
    })?;
    task_center::stage("index_text");
    let mut progress = ScanProgressStats {
        total_count: Some(files.len()),
        ..ScanProgressStats::default()
    };
    progress_reporter(build_running_index_progress(&progress))?;

    let mut documents = Vec::new();
    let mut skipped_documents = Vec::new();
    let mut parser_skips = BTreeMap::new();
    let mut seen_paths = HashSet::new();
    let mut last_progress = chrono::Utc::now().timestamp_millis();
    let mut last_snapshot = last_progress;
    let journal_path = indexed_document_journal_path(root_dir);
    fs::create_dir_all(journal_path.parent().unwrap()).map_err(|error| error.to_string())?;
    let mut journal = BufWriter::new(
        fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&journal_path)
            .map_err(|error| error.to_string())?,
    );

    for file_path in files {
        let metadata = fs::metadata(&file_path).map_err(|error| error.to_string())?;
        match scan_file(&root, &file_path, &metadata, options) {
            ScanFileOutcome::Indexed(file) => {
                seen_paths.insert(file.relative_path.clone());
                progress.scanned_count += 1;
                let document = index_document(file, previous_state);
                if document.reused_previous {
                    progress.unchanged_count += 1;
                } else {
                    progress.indexed_count += 1;
                    write_document_journal_entry(&mut journal, &document)?;
                }
                documents.push(document);
            }
            ScanFileOutcome::Skipped(skip) => {
                seen_paths.insert(skip.path.clone());
                progress.scanned_count += 1;
                progress.skipped_count += 1;
                register_runtime_skip(&mut skipped_documents, &mut parser_skips, skip);
            }
            ScanFileOutcome::Ignored => continue,
        }
        let now = chrono::Utc::now().timestamp_millis();
        if now - last_progress >= INDEX_PROGRESS_FLUSH_INTERVAL_MS {
            journal.flush().map_err(|error| error.to_string())?;
            progress_reporter(build_running_index_progress(&progress))?;
            last_progress = now;
        }
        if now - last_snapshot >= INDEX_PARTIAL_SNAPSHOT_FLUSH_INTERVAL_MS {
            write_partial_export_snapshot(root_dir, &documents, previous_state)?;
            last_snapshot = now;
        }
    }
    journal.flush().map_err(|error| error.to_string())?;
    progress.total_count = Some(progress.total_count.unwrap_or(0).max(progress.scanned_count));
    progress_reporter(build_running_index_progress(&progress))?;
    documents.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    let deleted_paths = previous_state
        .as_ref()
        .map(|state| {
            state
                .active_files
                .keys()
                .chain(state.documents.keys())
                .filter(|path| {
                    target_scope_matches_path(target_scope, path) && !seen_paths.contains(*path)
                })
                .cloned()
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect()
        })
        .unwrap_or_default();
    Ok(ScanDocumentsResult {
        documents,
        skipped_documents,
        parser_skips: parser_skips.into_values().collect(),
        total_scanned: progress.scanned_count,
        unchanged_count: progress.unchanged_count,
        skipped_count: progress.skipped_count,
        deleted_paths,
    })
}

fn discover_scannable_files(
    root_dir: &str,
    root: &Path,
    options: &NativeIndexOptions,
    target_scope: &TargetScope,
) -> Result<Vec<PathBuf>, String> {
    let mut queue = VecDeque::from(resolve_scan_bases(root, target_scope));
    let mut queued = queue
        .iter()
        .map(|path| directory_queue_key(root, path))
        .collect::<HashSet<_>>();
    let mut visited = HashSet::new();
    let mut discovered_files = Vec::new();
    let mut last_hint = 0;
    let mut last_progress = std::time::Instant::now();

    while let Some(current) = queue.pop_front() {
        let current_key = directory_queue_key(root, &current);
        queued.remove(&current_key);
        if !visited.insert(current_key) {
            continue;
        }
        maybe_apply_priority_hints(
            root_dir,
            root,
            options,
            target_scope,
            &mut queue,
            &mut queued,
            &visited,
            &mut last_hint,
        )?;

        let metadata = match fs::symlink_metadata(&current) {
            Ok(value) => value,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(format!("读取文件属性失败 {}: {error}", current.display())),
        };
        let mut candidates = Vec::new();
        if metadata.is_dir() {
            for entry in fs::read_dir(&current).map_err(|error| error.to_string())? {
                let entry = entry.map_err(|error| error.to_string())?;
                let entry_path = entry.path();
                let kind = entry.file_type().map_err(|error| error.to_string())?;
                let relative = directory_queue_key(root, &entry_path);
                if kind.is_dir() {
                    if !should_skip_directory(
                        &entry.file_name().to_string_lossy(),
                        &relative,
                        options,
                    ) && !visited.contains(&relative)
                        && queued.insert(relative)
                    {
                        queue.push_back(entry_path);
                    }
                } else if kind.is_file() && is_supported_file(&entry_path, options) {
                    candidates.push(entry_path);
                }
            }
        } else if metadata.is_file() {
            candidates.push(current);
        }

        for file_path in candidates {
            let metadata = fs::metadata(&file_path).map_err(|error| error.to_string())?;
            if !matches!(
                scan_file(root, &file_path, &metadata, options),
                ScanFileOutcome::Ignored
            ) {
                discovered_files.push(file_path);
                if last_progress.elapsed().as_millis() >= 100 {
                    task_center::progress(discovered_files.len(), None);
                    last_progress = std::time::Instant::now();
                }
            }
        }
    }

    task_center::progress(discovered_files.len(), Some(discovered_files.len()));
    Ok(discovered_files)
}

fn is_supported_file(path: &Path, options: &NativeIndexOptions) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .is_some_and(|extension| {
            let extension = format!(".{}", extension.to_lowercase());
            supported_extensions().contains(extension.as_str())
                && options
                    .allowed_extensions
                    .as_ref()
                    .map_or(true, |allowed| allowed.contains(&extension))
        })
}

fn build_running_index_progress(progress_stats: &ScanProgressStats) -> IndexProgress {
    let completed_task_count = progress_stats.indexed_count
        + progress_stats.unchanged_count
        + progress_stats.skipped_count;
    IndexProgress {
        scanned_count: progress_stats.scanned_count,
        indexed_count: progress_stats.indexed_count,
        skipped_count: progress_stats.skipped_count,
        failed_count: 0,
        unchanged_count: progress_stats.unchanged_count,
        total_count: progress_stats.total_count,
        max_concurrency: Some(1),
        active_task_count: 0,
        pending_task_count: 0,
        completed_task_count,
    }
}

fn maybe_apply_priority_hints(
    root_dir: &str,
    root: &Path,
    options: &NativeIndexOptions,
    target_scope: &TargetScope,
    queue: &mut VecDeque<PathBuf>,
    queued_directory_paths: &mut HashSet<String>,
    visited_directory_paths: &HashSet<String>,
    last_priority_hint_check_at: &mut i64,
) -> Result<(), String> {
    let now_ms = chrono::Utc::now().timestamp_millis();
    if now_ms.saturating_sub(*last_priority_hint_check_at) < 1000 {
        return Ok(());
    }
    *last_priority_hint_check_at = now_ms;

    let Some(hints) =
        read_optional_json_file::<RuntimePriorityHints>(&priority_hints_path(root_dir))?
    else {
        return Ok(());
    };
    let _updated_at = hints.updated_at;
    for path in hints.paths.into_iter().rev() {
        let normalized = normalize_priority_hint_path(&path);
        if normalized == "." || normalized.is_empty() {
            continue;
        }
        if !target_scope_matches_path(target_scope, &normalized) {
            continue;
        }
        let target_dir = root.join(&normalized);
        if !target_dir.is_dir() {
            continue;
        }
        let queue_key = directory_queue_key(root, &target_dir);
        if visited_directory_paths.contains(&queue_key) {
            continue;
        }
        if should_skip_directory(
            target_dir
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or_default(),
            &normalized,
            options,
        ) {
            continue;
        }
        promote_directory_to_queue_front(queue, queued_directory_paths, root, target_dir);
    }
    Ok(())
}

fn promote_directory_to_queue_front(
    queue: &mut VecDeque<PathBuf>,
    queued_directory_paths: &mut HashSet<String>,
    root: &Path,
    target_dir: PathBuf,
) {
    let queue_key = directory_queue_key(root, &target_dir);
    if queued_directory_paths.contains(&queue_key) {
        if let Some(index) = queue
            .iter()
            .position(|path| directory_queue_key(root, path) == queue_key)
        {
            queue.remove(index);
        }
    } else {
        queued_directory_paths.insert(queue_key);
    }
    queue.push_front(target_dir);
}

fn normalize_priority_hint_path(value: &str) -> String {
    let trimmed = value.trim().replace('\\', "/");
    let normalized = trimmed
        .split('/')
        .filter(|segment| !segment.is_empty() && *segment != ".")
        .collect::<Vec<_>>()
        .join("/");
    if normalized.is_empty() {
        ".".to_string()
    } else {
        normalized
    }
}

fn directory_queue_key(root: &Path, path: &Path) -> String {
    normalize_relative_path(path.strip_prefix(root).unwrap_or(path))
}

fn resolve_scan_bases(root: &Path, target_scope: &TargetScope) -> Vec<PathBuf> {
    match target_scope {
        TargetScope::All => vec![root.to_path_buf()],
        TargetScope::Paths { files, directories } => files
            .iter()
            .chain(directories)
            .map(|path| root.join(path))
            .collect(),
    }
}

fn scan_file(
    root: &Path,
    file_path: &Path,
    metadata: &fs::Metadata,
    options: &NativeIndexOptions,
) -> ScanFileOutcome {
    let extension = file_path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| format!(".{}", value.to_lowercase()));
    let Some(extension) = extension else {
        return ScanFileOutcome::Ignored;
    };
    if !supported_extensions().contains(extension.as_str()) {
        return ScanFileOutcome::Ignored;
    }
    if let Some(allowed) = &options.allowed_extensions {
        if !allowed.contains(&extension) {
            return ScanFileOutcome::Ignored;
        }
    }
    let relative_path = match file_path.strip_prefix(root) {
        Ok(value) => normalize_relative_path(value),
        Err(_) => return ScanFileOutcome::Ignored,
    };
    if has_directory_segment(&relative_path, ".ai-index") {
        return ScanFileOutcome::Ignored;
    }
    if options.hide_system_folders
        && ignored_directory_names()
            .iter()
            .any(|name| has_directory_segment(&relative_path, name))
    {
        return ScanFileOutcome::Ignored;
    }
    if options.hide_dot_files
        && has_hidden_segment(&relative_path)
        && !is_included_hidden_path(&relative_path, &options.included_hidden_paths)
    {
        return ScanFileOutcome::Ignored;
    }
    let size = metadata.len();
    let mtime = metadata
        .modified()
        .ok()
        .map(|value| chrono::DateTime::<chrono::Utc>::from(value).to_rfc3339())
        .unwrap_or_else(iso_now);
    if is_native_skip_only_extension(&extension) {
        return ScanFileOutcome::Skipped(RuntimeSkipRecordInput {
            path: relative_path,
            extension,
            size,
            mtime,
            adapter: "native_skip_only".to_string(),
            reason_code: "PARSER_COMPLEX_SKIPPED".to_string(),
            message: "legacy binary office extension is skip-only on native route".to_string(),
        });
    }
    ScanFileOutcome::Indexed(ScannedFile {
        relative_path,
        full_path: file_path.to_path_buf(),
        extension,
        size,
        mtime,
    })
}

fn index_document(
    file: ScannedFile,
    previous_state: Option<&PreviousNativeIndexState>,
) -> ScannedDocument {
    if let Some(previous_document) = resolve_reusable_previous_document(&file, previous_state) {
        return previous_document;
    }
    let title = file
        .full_path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_string();
    let derived_tags = infer_derived_tags(&file);
    let summary = read_summary(&file);
    let tags = previous_state
        .and_then(|state| state.documents.get(&file.relative_path))
        .map(|document| document.tags.clone())
        .unwrap_or_default();
    ScannedDocument {
        relative_path: file.relative_path,
        extension: file.extension,
        size: file.size,
        title,
        summary,
        tags,
        mtime: file.mtime,
        derived_tags,
        reused_previous: false,
    }
}

fn resolve_reusable_previous_document(
    file: &ScannedFile,
    previous_state: Option<&PreviousNativeIndexState>,
) -> Option<ScannedDocument> {
    let state = previous_state?;
    let previous_active = state.active_files.get(&file.relative_path)?;
    let previous_document = state.documents.get(&file.relative_path)?;
    if previous_active.index_status != "indexed"
        || previous_active.extension != file.extension
        || previous_active.size != file.size
        || previous_active.mtime != file.mtime
    {
        return None;
    }
    Some(ScannedDocument {
        relative_path: file.relative_path.clone(),
        extension: file.extension.clone(),
        size: file.size,
        title: previous_document.title.clone(),
        summary: previous_document.summary.clone(),
        tags: previous_document.tags.clone(),
        mtime: previous_document.mtime.clone(),
        derived_tags: previous_document.derived_tags.clone(),
        reused_previous: true,
    })
}

fn runtime_active_state_from_document(document: &ScannedDocument) -> RuntimeIndexedDocumentState {
    RuntimeIndexedDocumentState {
        path: document.relative_path.clone(),
        extension: document.extension.clone(),
        size: document.size,
        mtime: document.mtime.clone(),
        index_status: "indexed".to_string(),
    }
}

fn snapshot_document_from_scanned(document: &ScannedDocument) -> SnapshotDocument {
    SnapshotDocument {
        document_id: stable_document_id(&document.relative_path),
        path: document.relative_path.clone(),
        title: document.title.clone(),
        summary: document.summary.clone(),
        tags: document.tags.clone(),
        derived_tags: document.derived_tags.clone(),
        mtime: document.mtime.clone(),
    }
}

fn write_document_journal_entry(
    writer: &mut impl Write,
    document: &ScannedDocument,
) -> Result<(), String> {
    let entry = RuntimeIndexedDocumentJournalEntry {
        active: runtime_active_state_from_document(document),
        document: snapshot_document_from_scanned(document),
    };
    serde_json::to_writer(&mut *writer, &entry).map_err(|error| error.to_string())?;
    writer.write_all(b"\n").map_err(|error| error.to_string())
}

#[cfg(test)]
fn append_indexed_document_journal(
    root_dir: &str,
    document: &ScannedDocument,
) -> Result<(), String> {
    let path = indexed_document_journal_path(root_dir);
    fs::create_dir_all(path.parent().unwrap()).map_err(|error| error.to_string())?;
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| error.to_string())?;
    write_document_journal_entry(&mut file, document)
}

fn clear_indexed_document_journal(root_dir: &str) -> Result<(), String> {
    let journal_path = indexed_document_journal_path(root_dir);
    if !journal_path.is_file() {
        return Ok(());
    }
    fs::remove_file(&journal_path)
        .map_err(|error| format!("清理索引恢复日志失败 {}: {error}", journal_path.display()))
}

fn write_export_snapshot(
    root_dir: &str,
    documents: &[ScannedDocument],
    target_scope: &TargetScope,
    previous_state: Option<&PreviousNativeIndexState>,
) -> Result<String, String> {
    let generated_at = iso_now();
    let mut snapshot_documents = previous_state
        .into_iter()
        .flat_map(|state| state.documents.values())
        .filter(|document| !target_scope_matches_path(target_scope, &document.path))
        .cloned()
        .collect::<Vec<_>>();
    snapshot_documents.extend(documents.iter().map(snapshot_document_from_scanned));
    snapshot_documents.sort_by(|left, right| left.path.cmp(&right.path));
    let mut snapshot_tags = BTreeMap::<String, SnapshotTag>::new();
    for document in &snapshot_documents {
        for tag_path in document.tags.iter().chain(document.derived_tags.iter()) {
            register_tag_path(&mut snapshot_tags, tag_path);
        }
    }
    let snapshot = ExportCatalogSnapshot {
        version: 1,
        generated_at: Some(generated_at),
        tags: snapshot_tags.into_values().collect(),
        documents: snapshot_documents,
    };
    let snapshot_path = export_catalog_snapshot_path(root_dir);
    write_catalog(root_dir, snapshot)?;
    Ok(snapshot_path.to_string_lossy().to_string())
}

fn write_partial_export_snapshot(
    root_dir: &str,
    documents: &[ScannedDocument],
    previous_state: Option<&PreviousNativeIndexState>,
) -> Result<String, String> {
    let native_documents = documents
        .iter()
        .map(snapshot_document_from_scanned)
        .collect::<Vec<_>>();
    let previous_snapshot = previous_state.map(|state| ExportCatalogSnapshot {
        version: 1,
        generated_at: Some(iso_now()),
        tags: Vec::new(),
        documents: state.documents.values().cloned().collect(),
    });
    let snapshot_documents = merge_partial_snapshot_documents(native_documents, previous_snapshot);
    let mut snapshot_tags = BTreeMap::<String, SnapshotTag>::new();
    for document in &snapshot_documents {
        for tag_path in document.tags.iter().chain(document.derived_tags.iter()) {
            register_tag_path(&mut snapshot_tags, tag_path);
        }
    }
    let snapshot = ExportCatalogSnapshot {
        version: 1,
        generated_at: Some(iso_now()),
        tags: snapshot_tags.into_values().collect(),
        documents: snapshot_documents,
    };
    let snapshot_path = export_catalog_snapshot_path(root_dir);
    write_catalog(root_dir, snapshot)?;
    Ok(snapshot_path.to_string_lossy().to_string())
}

#[cfg(test)]
fn read_existing_snapshot(root_dir: &str) -> Result<Option<ExportCatalogSnapshot>, String> {
    let snapshot_path = export_catalog_snapshot_path(root_dir);
    if !snapshot_path.is_file() {
        return Ok(None);
    }
    read_json_file(&snapshot_path).map(Some)
}

fn merge_partial_snapshot_documents(
    native_documents: Vec<SnapshotDocument>,
    previous_snapshot: Option<ExportCatalogSnapshot>,
) -> Vec<SnapshotDocument> {
    let mut merged = BTreeMap::<String, SnapshotDocument>::new();
    if let Some(previous_snapshot) = previous_snapshot {
        for document in previous_snapshot.documents {
            merged.insert(document.path.clone(), document);
        }
    }
    for document in native_documents {
        merged.insert(document.path.clone(), document);
    }
    merged.into_values().collect()
}

#[cfg(test)]
fn write_runtime_mirror_snapshots(
    root_dir: &str,
    scanned: &ScanDocumentsResult,
    target_scope: &TargetScope,
) -> Result<(), String> {
    let previous = load_previous_native_index_state(root_dir);
    write_runtime_mirror_snapshots_with_state(root_dir, scanned, target_scope, previous.as_deref())
}

fn write_runtime_mirror_snapshots_with_state(
    root_dir: &str,
    scanned: &ScanDocumentsResult,
    target_scope: &TargetScope,
    previous_state: Option<&PreviousNativeIndexState>,
) -> Result<(), String> {
    let active_file_path = active_file_state_snapshot_path(root_dir);
    let index_state_path = index_state_snapshot_path(root_dir);
    let previous_index = read_optional_json_file::<RuntimeIndexStateSnapshot>(&index_state_path)?
        .unwrap_or(RuntimeIndexStateSnapshot {
            version: 1,
            generated_at: iso_now(),
            failed_documents: Vec::new(),
            skipped_documents: Vec::new(),
            parser_skips: Vec::new(),
        });
    let mut active_files = previous_state
        .map(|state| state.active_files.clone())
        .unwrap_or_default();
    let mut skipped_documents = BTreeMap::<String, RuntimeIndexedDocumentState>::new();
    for item in previous_index.skipped_documents.iter().cloned() {
        skipped_documents.insert(item.path.clone(), item);
    }
    let mut parser_skips = BTreeMap::<String, RuntimeParserSkipState>::new();
    for item in previous_index.parser_skips.iter().cloned() {
        parser_skips.insert(item.skip_key.clone(), item);
    }

    for document in &scanned.documents {
        if !target_scope_matches_path(target_scope, &document.relative_path) {
            continue;
        }
        let runtime_state = runtime_active_state_from_document(document);
        active_files.insert(runtime_state.path.clone(), runtime_state);
        skipped_documents.remove(&document.relative_path);
    }

    for skipped in &scanned.skipped_documents {
        if !target_scope_matches_path(target_scope, &skipped.path) {
            continue;
        }
        active_files.insert(skipped.path.clone(), skipped.clone());
        skipped_documents.insert(skipped.path.clone(), skipped.clone());
    }

    for parser_skip in &scanned.parser_skips {
        parser_skips.insert(parser_skip.skip_key.clone(), parser_skip.clone());
    }

    for deleted_path in &scanned.deleted_paths {
        active_files.remove(deleted_path);
        skipped_documents.remove(deleted_path);
    }

    let active_snapshot = RuntimeActiveFileStateSnapshot {
        version: 1,
        generated_at: iso_now(),
        files: active_files.into_values().collect(),
    };
    let index_snapshot = RuntimeIndexStateSnapshot {
        version: 1,
        generated_at: iso_now(),
        failed_documents: previous_index.failed_documents,
        skipped_documents: skipped_documents.into_values().collect(),
        parser_skips: parser_skips.into_values().collect(),
    };
    write_json_file(&active_file_path, &active_snapshot)?;
    write_json_file(&index_state_path, &index_snapshot)?;
    clear_indexed_document_journal(root_dir)?;
    Ok(())
}

fn register_runtime_skip(
    skipped_documents: &mut Vec<RuntimeIndexedDocumentState>,
    parser_skips: &mut BTreeMap<String, RuntimeParserSkipState>,
    input: RuntimeSkipRecordInput,
) {
    skipped_documents.push(RuntimeIndexedDocumentState {
        path: input.path.clone(),
        extension: input.extension.clone(),
        size: input.size,
        mtime: input.mtime.clone(),
        index_status: "skipped".to_string(),
    });
    let skip_key = stable_skip_key(&input.adapter, &input.reason_code, &input.extension);
    let now = iso_now();
    let entry = parser_skips
        .entry(skip_key.clone())
        .or_insert_with(|| RuntimeParserSkipState {
            skip_key: skip_key.clone(),
            adapter: input.adapter.clone(),
            reason_code: input.reason_code.clone(),
            extension: input.extension.clone(),
            sample_paths: Vec::new(),
            sample_count: 0,
            total_count: 0,
            last_message: None,
            first_seen_at: now.clone(),
            last_seen_at: now.clone(),
            last_run_at: now.clone(),
        });
    if !entry.sample_paths.iter().any(|item| item == &input.path) && entry.sample_paths.len() < 20 {
        entry.sample_paths.push(input.path);
    }
    entry.sample_count = entry.sample_paths.len();
    entry.total_count += 1;
    entry.last_message = Some(input.message);
    entry.last_seen_at = now.clone();
    entry.last_run_at = now;
}

fn stable_skip_key(adapter: &str, reason_code: &str, extension: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(format!("{adapter}:{reason_code}:{extension}").as_bytes());
    let digest = format!("{:x}", hasher.finalize());
    format!("skip_{}", &digest[..16])
}

fn document_extension(path: &str) -> String {
    Path::new(path)
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| format!(".{}", value.to_lowercase()))
        .unwrap_or_default()
}

fn register_tag_path(target: &mut BTreeMap<String, SnapshotTag>, tag_path: &str) {
    let segments = tag_path
        .split('/')
        .map(str::trim)
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();
    for index in 0..segments.len() {
        let current_path = segments[..=index].join("/");
        target
            .entry(current_path.clone())
            .or_insert_with(|| SnapshotTag {
                path: current_path.clone(),
                name: segments[index].to_string(),
                root_type: segments[0].to_string(),
                parent_path: if index == 0 {
                    None
                } else {
                    Some(segments[..index].join("/"))
                },
                depth: index,
            });
    }
}

fn infer_derived_tags(file: &ScannedFile) -> Vec<String> {
    let mut tags = BTreeSet::new();
    if let Some(tag) = extension_type_tag(&file.extension) {
        tags.insert(tag.to_string());
    }
    if let Ok(modified_at) = chrono::DateTime::parse_from_rfc3339(&file.mtime) {
        let local = modified_at.with_timezone(&chrono::Local);
        tags.insert(format!("时间/{}/{:02}", local.year(), local.month()));
        let now = chrono::Local::now().date_naive();
        let modified_date = local.date_naive();
        let delta_days = (now - modified_date).num_days().max(0);
        if delta_days <= 29 {
            tags.insert("时间/最近30天".to_string());
        }
        if delta_days <= 6 {
            tags.insert("时间/最近7天".to_string());
        }
        if delta_days <= 2 {
            tags.insert("时间/最近3天".to_string());
        }
    }
    tags.into_iter().collect()
}

type StateCache = BTreeMap<String, (Vec<FileVersion>, Arc<PreviousNativeIndexState>)>;

fn state_cache() -> &'static Mutex<StateCache> {
    static CACHE: OnceLock<Mutex<StateCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(BTreeMap::new()))
}

fn state_versions(root: &str) -> Vec<FileVersion> {
    [
        active_file_state_snapshot_path(root),
        export_catalog_snapshot_path(root),
        indexed_document_journal_path(root),
    ]
    .iter()
    .map(|path| file_version(path))
    .collect()
}

pub(crate) fn invalidate_state_cache(root: &str) {
    state_cache().lock().unwrap().remove(root);
}

fn commit_cached_state(root: &str, scanned: &ScanDocumentsResult) {
    let mut cache = state_cache().lock().unwrap();
    let entry = cache
        .entry(root.to_string())
        .or_insert_with(|| (vec![], Arc::new(PreviousNativeIndexState::default())));
    let state = Arc::make_mut(&mut entry.1);
    for document in &scanned.documents {
        if !document.reused_previous {
            state.active_files.insert(
                document.relative_path.clone(),
                runtime_active_state_from_document(document),
            );
            state.documents.insert(
                document.relative_path.clone(),
                snapshot_document_from_scanned(document),
            );
        }
    }
    for skip in &scanned.skipped_documents {
        state.active_files.insert(skip.path.clone(), skip.clone());
        state.documents.remove(&skip.path);
    }
    for path in &scanned.deleted_paths {
        state.active_files.remove(path);
        state.documents.remove(path);
    }
    entry.0 = state_versions(root);
}

fn load_previous_native_index_state(root_dir: &str) -> Option<Arc<PreviousNativeIndexState>> {
    let versions = state_versions(root_dir);
    let mut cache = state_cache().lock().unwrap();
    if let Some((cached_versions, state)) = cache.get(root_dir) {
        if *cached_versions == versions {
            return Some(Arc::clone(state));
        }
    }
    let active_snapshot = read_optional_json_file::<RuntimeActiveFileStateSnapshot>(
        &active_file_state_snapshot_path(root_dir),
    )
    .ok()
    .flatten();
    let export_snapshot = read_catalog(root_dir).ok().flatten();
    let mut active_files = active_snapshot
        .map(|snapshot| {
            snapshot
                .files
                .into_iter()
                .map(|item| (item.path.clone(), item))
                .collect::<BTreeMap<_, _>>()
        })
        .unwrap_or_default();
    let mut documents = export_snapshot
        .map(|snapshot| {
            snapshot
                .documents
                .iter()
                .cloned()
                .map(|item| (item.path.clone(), item))
                .collect::<BTreeMap<_, _>>()
        })
        .unwrap_or_default();
    merge_indexed_document_journal(root_dir, &mut active_files, &mut documents);
    hydrate_missing_active_files_from_documents(root_dir, &documents, &mut active_files);
    if active_files.is_empty() && documents.is_empty() {
        return None;
    }
    let state = Arc::new(PreviousNativeIndexState {
        active_files,
        documents,
    });
    cache.insert(root_dir.to_string(), (versions, Arc::clone(&state)));
    Some(state)
}

fn hydrate_missing_active_files_from_documents(
    root_dir: &str,
    documents: &BTreeMap<String, SnapshotDocument>,
    active_files: &mut BTreeMap<String, RuntimeIndexedDocumentState>,
) {
    let root = PathBuf::from(root_dir);
    for (path, document) in documents {
        if active_files.contains_key(path) {
            continue;
        }
        let file_path = root.join(path);
        let Ok(metadata) = fs::metadata(&file_path) else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        let mtime = metadata
            .modified()
            .ok()
            .map(|value| chrono::DateTime::<chrono::Utc>::from(value).to_rfc3339())
            .unwrap_or_else(iso_now);
        if mtime != document.mtime {
            continue;
        }
        active_files.insert(
            path.clone(),
            RuntimeIndexedDocumentState {
                path: path.clone(),
                extension: document_extension(path),
                size: metadata.len(),
                mtime,
                index_status: "indexed".to_string(),
            },
        );
    }
}

fn merge_indexed_document_journal(
    root_dir: &str,
    active_files: &mut BTreeMap<String, RuntimeIndexedDocumentState>,
    documents: &mut BTreeMap<String, SnapshotDocument>,
) {
    let journal_path = indexed_document_journal_path(root_dir);
    let Ok(raw) = fs::read_to_string(&journal_path) else {
        return;
    };
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(entry) = serde_json::from_str::<RuntimeIndexedDocumentJournalEntry>(trimmed) else {
            continue;
        };
        active_files.insert(entry.active.path.clone(), entry.active);
        documents.insert(entry.document.path.clone(), entry.document);
    }
}

fn extension_type_tag(extension: &str) -> Option<&'static str> {
    match extension {
        ".md" | ".markdown" | ".mdx" => Some("类型/文本/Markdown"),
        ".txt" => Some("类型/文本/纯文本"),
        ".rtf" => Some("类型/文本/RTF"),
        ".html" | ".htm" => Some("类型/文本/HTML"),
        ".pdf" => Some("类型/办公/PDF"),
        ".doc" | ".docx" | ".odt" | ".wps" => Some("类型/办公/Word"),
        ".ppt" | ".pptx" | ".odp" | ".key" => Some("类型/办公/PPT"),
        ".xls" | ".xlsx" | ".ods" | ".et" | ".numbers" => Some("类型/办公/Excel"),
        ".csv" => Some("类型/表格/CSV"),
        _ => None,
    }
}

fn read_summary(file: &ScannedFile) -> String {
    match file.extension.as_str() {
        ".csv" => read_csv_summary(&file.full_path),
        // PDF 对象扫描成本较高，索引不再提取其摘要。
        ".pdf" => String::new(),
        ".docx" => read_docx_summary(&file.full_path),
        ".odt" => read_odf_summary(&file.full_path, "content.xml", &["text:h", "text:p"]),
        ".xlsx" => read_xlsx_summary(&file.full_path),
        ".ods" => read_odf_summary(
            &file.full_path,
            "content.xml",
            &["text:h", "text:p", "text:span", "table:table-cell"],
        ),
        ".pptx" => read_pptx_summary(&file.full_path),
        ".odp" => read_odf_summary(&file.full_path, "content.xml", &["text:h", "text:p"]),
        ".html" | ".htm" | ".xml" => {
            let raw = read_text_prefix(&file.full_path, SUMMARY_TEXT_MAX_BYTES).unwrap_or_default();
            short_summary(&decode_xml_entities(strip_xml_tags(&raw)), SUMMARY_MAX_CHARS)
        }
        ".md" | ".markdown" | ".mdx" | ".txt" | ".rtf" | ".json" | ".yaml" | ".yml"
        | ".tsv" => read_text_summary(&file.full_path),
        _ => String::new(),
    }
}

fn read_text_summary(path: &PathBuf) -> String {
    let Ok(raw) = read_text_prefix(path, SUMMARY_TEXT_MAX_BYTES) else {
        return String::new();
    };
    short_summary(&raw, SUMMARY_MAX_CHARS)
}

fn read_csv_summary(path: &PathBuf) -> String {
    let Ok(raw) = read_text_prefix(path, SUMMARY_TEXT_MAX_BYTES) else {
        return String::new();
    };
    let lines = raw
        .replace("\u{feff}", "")
        .lines()
        .map(|line| line.trim())
        .filter(|line| !line.is_empty())
        .take(20)
        .map(split_csv_line)
        .map(|row| row.join(" "))
        .collect::<Vec<_>>();
    if lines.is_empty() {
        return String::new();
    }
    short_summary(&lines.join("\n"), SUMMARY_MAX_CHARS)
}

// 保留旧解析器实现，方便后续评估；当前索引路径不再调用。
#[allow(dead_code)]
fn read_pdf_summary(path: &PathBuf) -> String {
    let Ok(raw) = read_binary_prefix(path, SUMMARY_PDF_MAX_BYTES) else {
        return String::new();
    };
    let latin1 = raw.iter().map(|byte| *byte as char).collect::<String>();
    read_pdf_summary_from_text(&latin1)
}

fn read_pdf_summary_from_text(pdf_text: &str) -> String {
    if !pdf_text.starts_with("%PDF-") {
        return String::new();
    }
    let objects = extract_pdf_objects(pdf_text);
    if objects.is_empty() {
        return String::new();
    }
    let pages = parse_pdf_page_records(&objects);
    if pages.is_empty() {
        return String::new();
    }
    let mut chunks = Vec::new();
    for page in pages.into_iter().take(SUMMARY_PDF_MAX_PAGES) {
        let page_text = extract_pdf_page_text(&page, &objects);
        if !page_text.is_empty() {
            chunks.push(page_text);
        }
    }
    if chunks.is_empty() {
        return String::new();
    }
    short_summary(&chunks.join("\n\n"), 180)
}

fn read_docx_summary(path: &PathBuf) -> String {
    let Ok(entries) = read_zip_text_entries_for_summary(path, &["word/document.xml"]) else {
        return String::new();
    };
    let Some(document_xml) = entries.get("word/document.xml") else {
        return String::new();
    };
    let texts = extract_xml_texts(document_xml, "w:t");
    short_summary(&texts.join("\n"), SUMMARY_MAX_CHARS)
}

fn read_pptx_summary(path: &PathBuf) -> String {
    let Ok(entries) = read_zip_text_entries_for_summary(path, &["ppt/slides/slide1.xml"]) else {
        return String::new();
    };
    let Some(slide_xml) = entries.get("ppt/slides/slide1.xml") else {
        return String::new();
    };
    short_summary(&extract_xml_texts(slide_xml, "a:t").join("\n"), SUMMARY_MAX_CHARS)
}

fn read_odf_summary(path: &PathBuf, content_entry: &str, text_tags: &[&str]) -> String {
    let Ok(entries) = read_zip_text_entries_for_summary(path, &[content_entry]) else {
        return String::new();
    };
    let Some(content_xml) = entries.get(content_entry) else {
        return String::new();
    };
    let mut chunks = Vec::new();
    for tag in text_tags {
        chunks.extend(extract_xml_texts(content_xml, tag));
    }
    short_summary(&chunks.join("\n"), SUMMARY_MAX_CHARS)
}

fn read_xlsx_summary(path: &PathBuf) -> String {
    let Ok(entries) = read_zip_text_entries_for_summary(
        path,
        &["xl/sharedStrings.xml", "xl/worksheets/sheet1.xml"],
    ) else {
        return String::new();
    };
    let shared_strings = entries
        .get("xl/sharedStrings.xml")
        .map(|xml| parse_xlsx_shared_strings(xml.as_str()))
        .unwrap_or_default();
    let Some(worksheet_xml) = entries.get("xl/worksheets/sheet1.xml") else {
        return String::new();
    };
    let chunks = parse_xlsx_rows(worksheet_xml, &shared_strings)
        .into_iter()
        .take(SUMMARY_XLSX_MAX_ROWS_PER_SHEET)
        .map(|row| row.join(" "))
        .collect::<Vec<_>>();
    short_summary(&chunks.join("\n"), SUMMARY_MAX_CHARS)
}

fn read_text_prefix(path: &PathBuf, max_bytes: usize) -> Result<String, String> {
    let raw = read_binary_prefix(path, max_bytes)?;
    Ok(decode_text_prefix(&raw).replace('\u{feff}', ""))
}

fn decode_text_prefix(raw: &[u8]) -> String {
    // 前缀可能截断 UTF-8 字符，舍弃末尾残片而不是写入替换字符。
    let end = match std::str::from_utf8(raw) {
        Err(error) if error.error_len().is_none() => error.valid_up_to(),
        _ => raw.len(),
    };
    String::from_utf8_lossy(&raw[..end]).into_owned()
}

fn read_binary_prefix(path: &PathBuf, max_bytes: usize) -> Result<Vec<u8>, String> {
    let mut file = fs::File::open(path)
        .map_err(|error| format!("读取文件失败 {}: {error}", path.display()))?;
    let mut buffer = Vec::new();
    std::io::Read::by_ref(&mut file)
        .take(max_bytes as u64)
        .read_to_end(&mut buffer)
        .map_err(|error| format!("读取文件前缀失败 {}: {error}", path.display()))?;
    Ok(buffer)
}

fn read_zip_text_entries_for_summary(
    path: &PathBuf,
    entry_names: &[&str],
) -> Result<BTreeMap<String, String>, String> {
    let file = fs::File::open(path)
        .map_err(|error| format!("读取 zip 文件失败 {}: {error}", path.display()))?;
    let mut archive = ZipArchive::new(file)
        .map_err(|error| format!("解析 zip 容器失败 {}: {error}", path.display()))?;
    let mut entries = BTreeMap::new();
    for name in entry_names {
        let Ok(mut file) = archive.by_name(name) else {
            continue;
        };
        let mut content = Vec::new();
        if file
            .by_ref()
            .take(SUMMARY_ARCHIVE_ENTRY_MAX_BYTES as u64)
            .read_to_end(&mut content)
            .is_ok()
        {
            entries.insert((*name).to_string(), decode_text_prefix(&content));
        }
    }
    Ok(entries)
}

fn extract_xml_texts(xml: &str, tag_name: &str) -> Vec<String> {
    let open_tag = format!("<{tag_name}");
    let close_tag = format!("</{tag_name}>");
    let mut result = Vec::new();
    let mut cursor = 0usize;
    while let Some(start) = xml[cursor..].find(&open_tag) {
        let start_index = cursor + start;
        let Some(content_start_rel) = xml[start_index..].find('>') else {
            break;
        };
        let content_start = start_index + content_start_rel + 1;
        let end_rel = xml[content_start..]
            .find(&close_tag)
            .unwrap_or(xml.len() - content_start);
        let end_index = content_start + end_rel;
        let content = decode_xml_entities(strip_xml_tags(&xml[content_start..end_index]));
        let normalized = content.trim();
        if !normalized.is_empty() {
            result.push(normalized.to_string());
        }
        if end_index == xml.len() {
            break;
        }
        cursor = end_index + close_tag.len();
    }
    result
}

fn strip_xml_tags(raw: &str) -> String {
    let mut output = String::new();
    let mut in_tag = false;
    for ch in raw.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => output.push(ch),
            _ => {}
        }
    }
    output
}

fn decode_xml_entities(raw: String) -> String {
    raw.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

fn parse_xlsx_shared_strings(xml: &str) -> Vec<String> {
    extract_xml_texts(xml, "t")
}

fn parse_xlsx_rows(xml: &str, shared_strings: &[String]) -> Vec<Vec<String>> {
    let mut rows = Vec::new();
    let mut cursor = 0usize;
    while let Some(row_start_rel) = xml[cursor..].find("<row") {
        let row_start = cursor + row_start_rel;
        let Some(row_content_start_rel) = xml[row_start..].find('>') else {
            break;
        };
        let row_content_start = row_start + row_content_start_rel + 1;
        let Some(row_end_rel) = xml[row_content_start..].find("</row>") else {
            break;
        };
        let row_end = row_content_start + row_end_rel;
        let row_xml = &xml[row_content_start..row_end];
        let mut row = Vec::new();
        let mut cell_cursor = 0usize;
        while let Some(cell_start_rel) = row_xml[cell_cursor..].find("<c") {
            let cell_start = cell_cursor + cell_start_rel;
            let Some(cell_tag_end_rel) = row_xml[cell_start..].find('>') else {
                break;
            };
            let cell_tag_end = cell_start + cell_tag_end_rel;
            let cell_tag = &row_xml[cell_start..=cell_tag_end];
            let cell_type = extract_xml_attr(cell_tag, "t");
            let Some(cell_end_rel) = row_xml[cell_tag_end + 1..].find("</c>") else {
                break;
            };
            let cell_end = cell_tag_end + 1 + cell_end_rel;
            let cell_inner = &row_xml[cell_tag_end + 1..cell_end];
            let raw_value = extract_first_xml_text(cell_inner, "v")
                .or_else(|| extract_first_xml_text(cell_inner, "t"))
                .unwrap_or_default();
            let value = if cell_type.as_deref() == Some("s") {
                raw_value
                    .parse::<usize>()
                    .ok()
                    .and_then(|index| shared_strings.get(index).cloned())
                    .unwrap_or_default()
            } else {
                raw_value
            };
            row.push(value.trim().to_string());
            cell_cursor = cell_end + 4;
        }
        if row.iter().any(|cell| !cell.is_empty()) {
            rows.push(row);
        }
        cursor = row_end + 6;
    }
    rows
}

fn extract_xml_attr(tag: &str, attr_name: &str) -> Option<String> {
    let pattern = format!("{attr_name}=\"");
    let start = tag.find(&pattern)? + pattern.len();
    let tail = &tag[start..];
    let end = tail.find('"')?;
    Some(decode_xml_entities(tail[..end].to_string()))
}

fn extract_first_xml_text(xml: &str, tag_name: &str) -> Option<String> {
    extract_xml_texts(xml, tag_name).into_iter().next()
}

fn split_csv_line(line: &str) -> Vec<String> {
    let mut cells = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    let chars = line.chars().collect::<Vec<_>>();
    let mut index = 0usize;
    while index < chars.len() {
        let ch = chars[index];
        let next = chars.get(index + 1).copied();
        if ch == '"' {
            if in_quotes && next == Some('"') {
                current.push('"');
                index += 2;
                continue;
            }
            in_quotes = !in_quotes;
            index += 1;
            continue;
        }
        if ch == ',' && !in_quotes {
            cells.push(current.trim().to_string());
            current.clear();
            index += 1;
            continue;
        }
        current.push(ch);
        index += 1;
    }
    cells.push(current.trim().to_string());
    cells
}

fn short_summary(raw: &str, limit: usize) -> String {
    let mut output = String::new();
    let mut count = 0;
    let mut pending_space = false;
    for ch in raw.chars() {
        if ch.is_whitespace() {
            pending_space = !output.is_empty();
            continue;
        }
        if ch.is_control() || ch == '\u{fffd}' || ch == '\u{feff}' {
            continue;
        }
        let space = usize::from(pending_space);
        if count + space + 1 > limit
            || output.len() + space + ch.len_utf8() > SUMMARY_TEXT_MAX_BYTES
        {
            break;
        }
        if pending_space {
            output.push(' ');
        }
        output.push(ch);
        count += space + 1;
        pending_space = false;
    }
    output
}

fn should_skip_directory(name: &str, relative_path: &str, options: &NativeIndexOptions) -> bool {
    if name == ".ai-index" {
        return true;
    }
    if options.hide_system_folders && ignored_directory_names().contains(name) {
        return true;
    }
    if !options.hide_dot_files || !name.starts_with('.') {
        return false;
    }
    !is_included_hidden_path(relative_path, &options.included_hidden_paths)
}

fn normalize_allowed_extensions(values: &[String]) -> Option<HashSet<String>> {
    let items = values
        .iter()
        .map(|value| value.trim().to_lowercase())
        .filter(|value| !value.is_empty())
        .map(|value| {
            if value.starts_with('.') {
                value
            } else {
                format!(".{value}")
            }
        })
        .collect::<HashSet<_>>();
    if items.is_empty() {
        None
    } else {
        Some(items)
    }
}

fn normalize_included_hidden_paths(values: &[String]) -> Vec<String> {
    let mut items = BTreeSet::new();
    for value in values {
        let normalized = value
            .trim()
            .replace('\\', "/")
            .trim_start_matches('/')
            .to_string();
        if normalized.is_empty() || !has_hidden_segment(&normalized) {
            continue;
        }
        if normalized == ".ai-index" || normalized.starts_with(".ai-index/") {
            continue;
        }
        items.insert(normalized.trim_end_matches('/').to_string());
    }
    items.into_iter().collect()
}

fn is_included_hidden_path(relative_path: &str, included_hidden_paths: &[String]) -> bool {
    included_hidden_paths.iter().any(|included| {
        relative_path == included || relative_path.starts_with(&format!("{included}/"))
    })
}

fn has_hidden_segment(relative_path: &str) -> bool {
    relative_path
        .split('/')
        .any(|segment| !segment.is_empty() && segment.starts_with('.'))
}

fn has_directory_segment(relative_path: &str, expected: &str) -> bool {
    let mut segments = relative_path.split('/').peekable();
    while let Some(segment) = segments.next() {
        if segments.peek().is_some() && segment == expected {
            return true;
        }
    }
    false
}

pub fn is_native_library_path_visible(
    relative_path: &str,
    is_directory: bool,
    included_hidden_paths: &[String],
    hide_dot_files: bool,
    hide_system_folders: bool,
) -> bool {
    let normalized = relative_path.replace('\\', "/");
    let segments = normalized
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();
    let directory_segments = if is_directory {
        segments.as_slice()
    } else {
        &segments[..segments.len().saturating_sub(1)]
    };
    if directory_segments.contains(&".ai-index") {
        return false;
    }
    if hide_system_folders
        && directory_segments
            .iter()
            .any(|segment| ignored_directory_names().contains(*segment))
    {
        return false;
    }
    if !hide_dot_files || !has_hidden_segment(&normalized) {
        return true;
    }
    is_included_hidden_path(
        &normalized,
        &normalize_included_hidden_paths(included_hidden_paths),
    )
}

fn normalize_relative_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn resolve_target_scope(root_dir: &str, target_path: Option<&str>) -> TargetScope {
    let Some(target) = target_path
        .map(str::trim)
        .filter(|path| !path.is_empty() && *path != ".")
    else {
        return TargetScope::All;
    };
    let relative = normalize_relative_path(Path::new(target))
        .trim_end_matches('/')
        .to_string();
    let path = Path::new(root_dir).join(target);
    if path.is_file() || (!path.exists() && path.extension().is_some()) {
        TargetScope::Paths {
            files: BTreeSet::from([relative]),
            directories: BTreeSet::new(),
        }
    } else {
        TargetScope::Paths {
            files: BTreeSet::new(),
            directories: BTreeSet::from([relative]),
        }
    }
}

fn resolve_target_paths(root: &str, paths: &[String]) -> TargetScope {
    let mut files = BTreeSet::new();
    let mut directories = BTreeSet::new();
    for path in paths {
        match resolve_target_scope(root, Some(path)) {
            TargetScope::All => return TargetScope::All,
            TargetScope::Paths {
                files: next_files,
                directories: next_dirs,
            } => {
                files.extend(next_files);
                directories.extend(next_dirs);
            }
        }
    }
    let parents = directories.clone();
    directories.retain(|path| {
        !path
            .rmatch_indices('/')
            .any(|(index, _)| parents.contains(&path[..index]))
    });
    files.retain(|path| {
        !directories.contains(path)
            && !path
                .rmatch_indices('/')
                .any(|(index, _)| directories.contains(&path[..index]))
    });
    TargetScope::Paths { files, directories }
}

fn target_scope_matches_path(target_scope: &TargetScope, document_path: &str) -> bool {
    match target_scope {
        TargetScope::All => true,
        TargetScope::Paths { files, directories } => {
            files.contains(document_path)
                || directories.contains(document_path)
                || document_path
                    .rmatch_indices('/')
                    .any(|(index, _)| directories.contains(&document_path[..index]))
        }
    }
}

fn build_dirty_scope(documents: &[ScannedDocument], deleted_paths: &[String]) -> DirtyScope {
    let changed_documents = documents
        .iter()
        .filter(|document| !document.reused_previous)
        .map(|document| SnapshotDocument {
            document_id: stable_document_id(&document.relative_path),
            path: document.relative_path.clone(),
            title: document.title.clone(),
            summary: document.summary.clone(),
            tags: document.tags.clone(),
            derived_tags: document.derived_tags.clone(),
            mtime: document.mtime.clone(),
        })
        .collect::<Vec<_>>();
    let indexed_paths = changed_documents
        .iter()
        .map(|document| document.path.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let deleted_paths = deleted_paths
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let changed_paths = indexed_paths
        .iter()
        .chain(deleted_paths.iter())
        .cloned()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let dirty_directories = changed_paths
        .iter()
        .map(|path| directory_of(path))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let dirty_tag_paths = collect_dirty_tag_paths(&changed_documents);
    let dirty_relations = changed_documents
        .iter()
        .map(|document| document.document_id.clone())
        .chain(deleted_paths.iter().map(|path| stable_document_id(path)))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    DirtyScope {
        trigger: "incremental".to_string(),
        changed_paths: changed_paths.clone(),
        deleted_paths,
        dirty_meta_shards: dirty_directories
            .iter()
            .map(|directory| stable_scope_shard_id("meta", directory))
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect(),
        dirty_detail_shards: changed_paths
            .iter()
            .map(|path| stable_scope_shard_id("detail", path))
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect(),
        dirty_posting_buckets: collect_dirty_posting_buckets(&dirty_tag_paths),
        dirty_directories,
        dirty_tag_paths,
        dirty_relations,
    }
}

fn directory_of(file_path: &str) -> String {
    let value = Path::new(file_path)
        .parent()
        .map(normalize_relative_path)
        .unwrap_or_else(|| ".".to_string());
    if value.is_empty() {
        ".".to_string()
    } else {
        value
    }
}

fn collect_dirty_tag_paths(documents: &[SnapshotDocument]) -> Vec<String> {
    let mut values = BTreeSet::new();
    for document in documents {
        for tag_path in document.tags.iter().chain(document.derived_tags.iter()) {
            let segments = tag_path
                .split('/')
                .map(str::trim)
                .filter(|segment| !segment.is_empty())
                .collect::<Vec<_>>();
            for index in 0..segments.len() {
                values.insert(segments[..=index].join("/"));
            }
        }
    }
    values.into_iter().collect()
}

fn collect_dirty_posting_buckets(tag_paths: &[String]) -> Vec<String> {
    tag_paths
        .iter()
        .filter_map(|tag_path| tag_path.split('/').next())
        .map(|root_type| stable_scope_shard_id("posting", root_type))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn stable_scope_shard_id(prefix: &str, value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    let digest = format!("{:x}", hasher.finalize());
    format!("{prefix}_{}", &digest[..12])
}

fn stable_document_id(value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    let hex = format!("{:x}", digest);
    format!("doc_{}", &hex[..16])
}

fn supported_extensions() -> &'static HashSet<&'static str> {
    use std::sync::OnceLock;
    static SUPPORTED: OnceLock<HashSet<&'static str>> = OnceLock::new();
    SUPPORTED.get_or_init(|| {
        [
            ".md",
            ".markdown",
            ".mdx",
            ".txt",
            ".rtf",
            ".html",
            ".htm",
            ".xml",
            ".json",
            ".yaml",
            ".yml",
            ".tsv",
            ".pdf",
            ".doc",
            ".docx",
            ".odt",
            ".wps",
            ".ppt",
            ".pptx",
            ".odp",
            ".key",
            ".xlsx",
            ".xls",
            ".ods",
            ".et",
            ".numbers",
            ".csv",
        ]
        .into_iter()
        .collect()
    })
}

#[derive(Debug, Clone)]
struct PdfObjectRecord {
    body: String,
}

#[derive(Debug, Clone)]
struct PdfPageRecord {
    content_refs: Vec<String>,
}

fn extract_pdf_objects(pdf_text: &str) -> BTreeMap<String, PdfObjectRecord> {
    let mut objects = BTreeMap::new();
    let object_pattern = Regex::new(r"(?s)(\d+)\s+(\d+)\s+obj\b(.*?)endobj").ok();
    let Some(object_pattern) = object_pattern else {
        return objects;
    };
    for captures in object_pattern.captures_iter(pdf_text) {
        let Some(object_num) = captures.get(1) else {
            continue;
        };
        let Some(generation_num) = captures.get(2) else {
            continue;
        };
        let Some(body) = captures.get(3) else {
            continue;
        };
        let object_id = format!("{} {}", object_num.as_str(), generation_num.as_str());
        objects.insert(
            object_id,
            PdfObjectRecord {
                body: body.as_str().trim().to_string(),
            },
        );
    }
    objects
}

fn parse_pdf_page_records(objects: &BTreeMap<String, PdfObjectRecord>) -> Vec<PdfPageRecord> {
    let mut pages = Vec::<(u32, PdfPageRecord)>::new();
    let ref_pattern = Regex::new(r"(\d+)\s+(\d+)\s+R").ok();
    for (object_id, record) in objects {
        if !record.body.contains("/Type /Page") || record.body.contains("/Type /Pages") {
            continue;
        }
        let mut content_refs = Vec::new();
        if let Some(contents_index) = record.body.find("/Contents") {
            let tail = &record.body[contents_index + "/Contents".len()..];
            if let Some(array_start) = tail.find('[') {
                if let Some(array_end) = tail[array_start + 1..].find(']') {
                    let array_body = &tail[array_start + 1..array_start + 1 + array_end];
                    if let Some(pattern) = &ref_pattern {
                        for captures in pattern.captures_iter(array_body) {
                            let Some(left) = captures.get(1) else {
                                continue;
                            };
                            let Some(right) = captures.get(2) else {
                                continue;
                            };
                            content_refs.push(format!("{} {}", left.as_str(), right.as_str()));
                        }
                    }
                }
            } else if let Some(pattern) = &ref_pattern {
                if let Some(captures) = pattern.captures(tail) {
                    let Some(left) = captures.get(1) else {
                        continue;
                    };
                    let Some(right) = captures.get(2) else {
                        continue;
                    };
                    content_refs.push(format!("{} {}", left.as_str(), right.as_str()));
                }
            }
        }
        let object_number = object_id
            .split(' ')
            .next()
            .and_then(|value| value.parse::<u32>().ok())
            .unwrap_or(0);
        pages.push((object_number, PdfPageRecord { content_refs }));
    }
    pages.sort_by_key(|item| item.0);
    pages.into_iter().map(|item| item.1).collect()
}

fn extract_pdf_page_text(
    page: &PdfPageRecord,
    objects: &BTreeMap<String, PdfObjectRecord>,
) -> String {
    let mut fragments = Vec::new();
    for content_ref in &page.content_refs {
        let Some(object_record) = objects.get(content_ref) else {
            continue;
        };
        let Some(stream_bytes) = decode_pdf_stream(&object_record.body) else {
            continue;
        };
        let text = extract_text_from_pdf_operators(&stream_bytes);
        if !text.is_empty() {
            fragments.push(text);
        }
    }
    normalize_pdf_text(&fragments.join("\n\n"))
}

fn decode_pdf_stream(object_body: &str) -> Option<Vec<u8>> {
    let raw_stream = extract_pdf_stream_bytes(object_body)?;
    let filters = parse_pdf_filters(object_body);
    let mut buffer = raw_stream;
    for filter in filters {
        match filter.as_str() {
            "FlateDecode" => {
                buffer = inflate_pdf_stream(&buffer)?;
            }
            _ => return None,
        }
    }
    Some(buffer)
}

fn extract_pdf_stream_bytes(object_body: &str) -> Option<Vec<u8>> {
    let stream_start = object_body.find("stream")?;
    let mut data_start = stream_start + "stream".len();
    let bytes = object_body.as_bytes();
    if bytes.get(data_start) == Some(&b'\r') && bytes.get(data_start + 1) == Some(&b'\n') {
        data_start += 2;
    } else if matches!(bytes.get(data_start), Some(b'\n') | Some(b'\r')) {
        data_start += 1;
    }
    let stream_end = object_body.rfind("endstream")?;
    if stream_end <= data_start {
        return None;
    }
    let mut raw = object_body.as_bytes()[data_start..stream_end].to_vec();
    while matches!(raw.last(), Some(b'\r') | Some(b'\n')) {
        raw.pop();
    }
    Some(raw)
}

fn parse_pdf_filters(object_body: &str) -> Vec<String> {
    let mut filters = Vec::new();
    if let Some(filter_index) = object_body.find("/Filter") {
        let tail = &object_body[filter_index + "/Filter".len()..];
        if let Some(array_start) = tail.find('[') {
            if let Some(array_end) = tail[array_start + 1..].find(']') {
                let array_body = &tail[array_start + 1..array_start + 1 + array_end];
                let bytes = array_body.as_bytes();
                let mut index = 0usize;
                while index < bytes.len() {
                    if bytes[index] == b'/' {
                        let start = index + 1;
                        let mut end = start;
                        while end < bytes.len()
                            && bytes[end] != b'/'
                            && bytes[end] != b']'
                            && !bytes[end].is_ascii_whitespace()
                        {
                            end += 1;
                        }
                        if end > start {
                            filters.push(decode_pdf_name_token(&array_body.as_bytes()[start..end]));
                        }
                        index = end;
                        continue;
                    }
                    index += 1;
                }
                return filters;
            }
        }
        if let Some(name_index) = tail.find('/') {
            let start = name_index + 1;
            let bytes = tail.as_bytes();
            let mut end = start;
            while end < bytes.len()
                && bytes[end] != b'/'
                && !bytes[end].is_ascii_whitespace()
                && bytes[end] != b'>'
            {
                end += 1;
            }
            if end > start {
                filters.push(decode_pdf_name_token(&tail.as_bytes()[start..end]));
            }
        }
    }
    filters
}

fn decode_pdf_name_token(token: &[u8]) -> String {
    let bytes = token;
    let mut result = String::new();
    let mut index = 0usize;
    while index < bytes.len() {
        if bytes[index] == b'#' && index + 2 < bytes.len() {
            if let Ok(value) = u8::from_str_radix(
                std::str::from_utf8(&bytes[index + 1..index + 3]).unwrap_or(""),
                16,
            ) {
                result.push(value as char);
                index += 3;
                continue;
            }
        }
        result.push(bytes[index] as char);
        index += 1;
    }
    result
}

fn inflate_pdf_stream(raw: &[u8]) -> Option<Vec<u8>> {
    let mut zlib_output = Vec::new();
    if ZlibDecoder::new(Cursor::new(raw))
        .take(PDF_INFLATE_MAX_BYTES)
        .read_to_end(&mut zlib_output)
        .is_ok()
    {
        return Some(zlib_output);
    }
    let mut deflate_output = Vec::new();
    if DeflateDecoder::new(Cursor::new(raw))
        .take(PDF_INFLATE_MAX_BYTES)
        .read_to_end(&mut deflate_output)
        .is_ok()
    {
        return Some(deflate_output);
    }
    None
}

fn extract_text_from_pdf_operators(content: &[u8]) -> String {
    let mut parts = Vec::new();
    let bytes = content;
    let mut index = 0usize;
    while index < bytes.len() {
        match bytes[index] {
            b'(' => {
                if let Some((literal, end_index)) = extract_balanced_parentheses(content, index) {
                    let operator_segment = &bytes[end_index + 1..bytes.len().min(end_index + 6)];
                    if operator_segment.windows(2).any(|window| window == b"Tj")
                        || operator_segment
                            .iter()
                            .copied()
                            .find(|byte| !byte.is_ascii_whitespace())
                            .is_some_and(|byte| byte == b'\'' || byte == b'"')
                    {
                        parts.push(decode_pdf_literal_string(&literal));
                    }
                    index = end_index + 1;
                    continue;
                }
            }
            b'<' if bytes.get(index + 1) != Some(&b'<') => {
                if let Some(end_rel) = bytes[index + 1..].iter().position(|byte| *byte == b'>') {
                    let end_index = index + 1 + end_rel;
                    let operator_segment = &bytes[end_index + 1..bytes.len().min(end_index + 6)];
                    if operator_segment.windows(2).any(|window| window == b"Tj") {
                        parts.push(decode_pdf_hex_string(&bytes[index + 1..end_index]));
                    }
                    index = end_index + 1;
                    continue;
                }
            }
            b'[' => {
                if let Some(end_rel) = bytes[index + 1..].iter().position(|byte| *byte == b']') {
                    let end_index = index + 1 + end_rel;
                    let operator_segment = &bytes[end_index + 1..bytes.len().min(end_index + 6)];
                    if operator_segment.windows(2).any(|window| window == b"TJ") {
                        let tokens = read_pdf_array_tokens(&bytes[index + 1..end_index]);
                        if !tokens.is_empty() {
                            parts.push(tokens.join(""));
                        }
                    }
                    index = end_index + 1;
                    continue;
                }
            }
            _ => {}
        }
        index += 1;
    }
    normalize_pdf_text(&parts.join("\n"))
}

fn read_pdf_array_tokens(raw: &[u8]) -> Vec<String> {
    let bytes = raw;
    let mut tokens = Vec::new();
    let mut index = 0usize;
    while index < bytes.len() {
        if bytes[index].is_ascii_whitespace() {
            index += 1;
            continue;
        }
        if bytes[index] == b'(' {
            if let Some((literal, end_index)) = extract_balanced_parentheses(raw, index) {
                tokens.push(decode_pdf_literal_string(&literal));
                index = end_index + 1;
                continue;
            }
            break;
        }
        if bytes[index] == b'<' {
            if let Some(end_rel) = bytes[index + 1..].iter().position(|byte| *byte == b'>') {
                let end_index = index + 1 + end_rel;
                tokens.push(decode_pdf_hex_string(&bytes[index + 1..end_index]));
                index = end_index + 1;
                continue;
            }
            break;
        }
        while index < bytes.len() && !bytes[index].is_ascii_whitespace() {
            index += 1;
        }
    }
    tokens
}

fn extract_balanced_parentheses(text: &[u8], start_index: usize) -> Option<(Vec<u8>, usize)> {
    let bytes = text;
    let mut depth = 1usize;
    let mut current = Vec::new();
    let mut index = start_index + 1;
    while index < bytes.len() {
        let byte = bytes[index];
        if byte == b'\\' {
            current.push(b'\\');
            if let Some(next) = bytes.get(index + 1) {
                current.push(*next);
                index += 2;
                continue;
            }
            break;
        }
        if byte == b'(' {
            depth += 1;
            current.push(b'(');
            index += 1;
            continue;
        }
        if byte == b')' {
            depth -= 1;
            if depth == 0 {
                return Some((current, index));
            }
            current.push(b')');
            index += 1;
            continue;
        }
        current.push(byte);
        index += 1;
    }
    None
}

fn decode_pdf_literal_string(input: &[u8]) -> String {
    let bytes = input;
    let mut result = String::new();
    let mut index = 0usize;
    while index < bytes.len() {
        if bytes[index] != b'\\' {
            result.push(bytes[index] as char);
            index += 1;
            continue;
        }
        let Some(next) = bytes.get(index + 1) else {
            break;
        };
        if (b'0'..=b'7').contains(next) {
            let mut octal = String::from(*next as char);
            let mut consumed = 1usize;
            while consumed < 3 {
                let Some(candidate) = bytes.get(index + 1 + consumed) else {
                    break;
                };
                if !(b'0'..=b'7').contains(candidate) {
                    break;
                }
                octal.push(*candidate as char);
                consumed += 1;
            }
            if let Ok(value) = u8::from_str_radix(&octal, 8) {
                result.push(value as char);
            }
            index += 1 + consumed;
            continue;
        }
        result.push(match *next as char {
            'n' => '\n',
            'r' => '\r',
            't' => '\t',
            'b' => '\u{0008}',
            'f' => '\u{000c}',
            '(' | ')' | '\\' => *next as char,
            other => other,
        });
        index += 2;
    }
    result
}

fn decode_pdf_hex_string(input: &[u8]) -> String {
    let mut normalized = input
        .iter()
        .copied()
        .filter(|byte| !byte.is_ascii_whitespace())
        .collect::<Vec<u8>>();
    if normalized.len() % 2 != 0 {
        normalized.push(b'0');
    }
    let mut result = String::new();
    let mut index = 0usize;
    while index + 1 < normalized.len() {
        if let Ok(value) = u8::from_str_radix(
            std::str::from_utf8(&normalized[index..index + 2]).unwrap_or(""),
            16,
        ) {
            result.push(value as char);
        }
        index += 2;
    }
    result
}

fn normalize_pdf_text(text: &str) -> String {
    let mut normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    let mut collapsed = Vec::new();
    let mut previous_blank = false;
    for line in normalized.lines() {
        let trimmed = line.split_whitespace().collect::<Vec<_>>().join(" ");
        if trimmed.is_empty() {
            if !previous_blank {
                collapsed.push(String::new());
            }
            previous_blank = true;
            continue;
        }
        collapsed.push(trimmed);
        previous_blank = false;
    }
    normalized = collapsed.join("\n").trim().to_string();
    normalized
}

fn ignored_directory_names() -> &'static HashSet<&'static str> {
    use std::sync::OnceLock;
    static IGNORED: OnceLock<HashSet<&'static str>> = OnceLock::new();
    IGNORED.get_or_init(|| {
        [
            "node_modules",
            "dist",
            "build",
            "coverage",
            ".git",
            ".svn",
            ".hg",
            ".next",
            ".nuxt",
            ".vite",
            ".cache",
            "__pycache__",
            "venv",
            ".venv",
        ]
        .into_iter()
        .collect()
    })
}

fn write_runtime_status(root_dir: &str, payload: PersistedRuntimeStatus) -> Result<(), String> {
    let path = runtime_status_path(root_dir);
    write_json_file(&path, &payload)
}

fn write_json_file<T: Serialize>(path: &PathBuf, value: &T) -> Result<(), String> {
    write_compact_json(path, value)
}

#[cfg(test)]
fn read_json_file<T>(path: &PathBuf) -> Result<T, String>
where
    T: for<'de> Deserialize<'de>,
{
    let raw = fs::read_to_string(path)
        .map_err(|error| format!("读取文件失败 {}: {error}", path.display()))?;
    serde_json::from_str::<T>(&raw)
        .map_err(|error| format!("解析 JSON 失败 {}: {error}", path.display()))
}

fn iso_now() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn iso_after_ms(ms: i64) -> Option<String> {
    chrono::Utc::now()
        .checked_add_signed(chrono::Duration::milliseconds(ms))
        .map(|value| value.to_rfc3339())
}

#[cfg(test)]
mod tests {
    use crate::write_json_file;

    use super::{
        append_indexed_document_journal, is_native_skip_only_extension,
        load_previous_native_index_state, merge_partial_snapshot_documents,
        promote_directory_to_queue_front, read_text_summary, read_xlsx_summary,
        resolve_reusable_previous_document, run_native_index_worker,
        write_runtime_mirror_snapshots, ExportCatalogSnapshot, NativeIndexRequest,
        ScanDocumentsResult, ScannedDocument, ScannedFile, SnapshotDocument, TargetScope,
        SUMMARY_TEXT_MAX_BYTES,
    };
    use serde_json::Value;
    use std::collections::{BTreeMap, HashSet, VecDeque};
    use std::fs;
    use std::io::Write;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};
    use zip::write::SimpleFileOptions;
    use zip::ZipWriter;

    #[test]
    fn legacy_binary_office_extensions_are_skip_only() {
        for extension in [".doc", ".wps", ".xls", ".et", ".numbers", ".ppt", ".key"] {
            assert!(is_native_skip_only_extension(extension));
        }
    }

    #[test]
    fn opendocument_extensions_are_not_skip_only() {
        for extension in [".odt", ".ods", ".odp"] {
            assert!(!is_native_skip_only_extension(extension));
        }
    }

    #[test]
    fn priority_hint_会把已排队目录移动到队头() {
        let root_dir = make_temp_dir("x-file-native-priority-queue");
        let slow_dir = root_dir.join("slow");
        let target_dir = root_dir.join("target");
        fs::create_dir_all(&slow_dir).unwrap();
        fs::create_dir_all(&target_dir).unwrap();

        let mut queue = VecDeque::from([slow_dir.clone(), target_dir.clone()]);
        let mut queued_directory_paths = HashSet::from([
            super::directory_queue_key(&root_dir, &slow_dir),
            super::directory_queue_key(&root_dir, &target_dir),
        ]);

        promote_directory_to_queue_front(
            &mut queue,
            &mut queued_directory_paths,
            &root_dir,
            target_dir.clone(),
        );
        fs::remove_dir_all(&root_dir).ok();

        assert_eq!(queue.pop_front(), Some(target_dir));
        assert_eq!(queue.pop_front(), Some(slow_dir));
        assert!(queue.is_empty());
        assert_eq!(queued_directory_paths.len(), 2);
    }

    #[test]
    fn default_route_mix_of_markdown_and_legacy_office_stays_on_native_index_worker() {
        let root_dir = make_temp_dir("x-file-native-index-default-route");
        fs::create_dir_all(root_dir.join(".ai-index")).unwrap();
        fs::write(root_dir.join("a.md"), "# Hello\n\nRust native route").unwrap();
        fs::write(root_dir.join("b.doc"), "legacy office binary placeholder").unwrap();

        let result = run_native_index_worker(NativeIndexRequest {
            root_dir: root_dir.to_string_lossy().to_string(),
            allowed_extensions: vec![".md".to_string(), ".doc".to_string()],
            included_hidden_paths: vec![],
            hide_dot_files: true,
            hide_system_folders: true,

            reason: "native_test".to_string(),
            target_path: None,
            target_paths: Vec::new(),
        })
        .unwrap();

        let index = result.get("index").and_then(Value::as_object).unwrap();
        assert_eq!(index.get("indexedCount").and_then(Value::as_u64), Some(1));
        assert_eq!(index.get("failedCount").and_then(Value::as_u64), Some(0));
        assert_eq!(
            index
                .get("skipStats")
                .and_then(Value::as_object)
                .and_then(|value| value.get("skippedCount"))
                .and_then(Value::as_u64),
            Some(1),
        );

        let snapshot_path = root_dir.join(".ai-index/runtime/export-catalog-snapshot.json");
        let active_state_path = root_dir.join(".ai-index/runtime/active-file-state-snapshot.json");
        let index_state_path = root_dir.join(".ai-index/runtime/index-state.json");
        assert!(snapshot_path.is_file());
        assert!(active_state_path.is_file());
        assert!(index_state_path.is_file());

        let snapshot: Value =
            serde_json::from_str(&fs::read_to_string(snapshot_path).unwrap()).unwrap();
        let documents = snapshot.get("documents").and_then(Value::as_array).unwrap();
        assert_eq!(documents.len(), 1);
        assert_eq!(
            documents[0].get("path").and_then(Value::as_str),
            Some("a.md")
        );

        let active_state: Value =
            serde_json::from_str(&fs::read_to_string(active_state_path).unwrap()).unwrap();
        let files = active_state.get("files").and_then(Value::as_array).unwrap();
        assert_eq!(files.len(), 2);

        let index_state: Value =
            serde_json::from_str(&fs::read_to_string(index_state_path).unwrap()).unwrap();
        let skipped_documents = index_state
            .get("skippedDocuments")
            .and_then(Value::as_array)
            .unwrap();
        assert_eq!(skipped_documents.len(), 1);
        assert_eq!(
            skipped_documents[0].get("path").and_then(Value::as_str),
            Some("b.doc")
        );
    }

    #[test]
    fn hidden_filters_can_be_disabled_but_ai_index_is_always_excluded() {
        let root_dir = make_temp_dir("x-file-native-hidden-filters");
        fs::create_dir_all(root_dir.join(".secret")).unwrap();
        fs::create_dir_all(root_dir.join("node_modules")).unwrap();
        fs::create_dir_all(root_dir.join(".ai-index")).unwrap();
        fs::write(root_dir.join(".secret/hidden.md"), "# hidden").unwrap();
        fs::write(root_dir.join("node_modules/package.md"), "# package").unwrap();
        fs::write(root_dir.join(".ai-index/leak.md"), "# leak").unwrap();

        let result = run_native_index_worker(NativeIndexRequest {
            root_dir: root_dir.to_string_lossy().to_string(),
            allowed_extensions: vec![".md".to_string()],
            included_hidden_paths: vec![],
            hide_dot_files: false,
            hide_system_folders: false,

            reason: "native_test".to_string(),
            target_path: None,
            target_paths: Vec::new(),
        })
        .unwrap();

        let index = result.get("index").and_then(Value::as_object).unwrap();
        assert_eq!(index.get("indexedCount").and_then(Value::as_u64), Some(2));

        let snapshot_path = root_dir.join(".ai-index/runtime/export-catalog-snapshot.json");
        let snapshot: Value =
            serde_json::from_str(&fs::read_to_string(snapshot_path).unwrap()).unwrap();
        let paths = snapshot
            .get("documents")
            .and_then(Value::as_array)
            .unwrap()
            .iter()
            .filter_map(|document| document.get("path").and_then(Value::as_str))
            .collect::<Vec<_>>();
        assert!(paths.contains(&".secret/hidden.md"));
        assert!(paths.contains(&"node_modules/package.md"));
        assert!(!paths.contains(&".ai-index/leak.md"));
        assert!(super::is_native_library_path_visible(
            ".secret",
            true,
            &[],
            false,
            false,
        ));
        assert!(super::is_native_library_path_visible(
            "node_modules",
            true,
            &[],
            false,
            false,
        ));
        assert!(!super::is_native_library_path_visible(
            ".ai-index",
            true,
            &[],
            false,
            false,
        ));
    }

    #[test]
    fn runtime_status_progress_contains_total_count_during_native_index() {
        let root_dir = make_temp_dir("x-file-native-index-progress-total");
        fs::create_dir_all(root_dir.join(".ai-index")).unwrap();
        fs::write(root_dir.join("a.md"), "# A").unwrap();
        fs::write(root_dir.join("b.md"), "# B").unwrap();
        fs::write(root_dir.join("c.doc"), "legacy office binary placeholder").unwrap();

        run_native_index_worker(NativeIndexRequest {
            root_dir: root_dir.to_string_lossy().to_string(),
            allowed_extensions: vec![".md".to_string(), ".doc".to_string()],
            included_hidden_paths: vec![],
            hide_dot_files: true,
            hide_system_folders: true,

            reason: "native_test".to_string(),
            target_path: None,
            target_paths: Vec::new(),
        })
        .unwrap();

        let status_path = root_dir.join(".ai-index").join("runtime-status.json");
        let status: Value =
            serde_json::from_str(&fs::read_to_string(status_path).unwrap()).unwrap();
        let progress = status.get("progress").and_then(Value::as_object).unwrap();

        assert_eq!(progress.get("totalCount").and_then(Value::as_u64), Some(3));
        assert!(
            progress
                .get("maxConcurrency")
                .and_then(Value::as_u64)
                .unwrap_or(0)
                >= 1
        );
        assert_eq!(
            progress.get("activeTaskCount").and_then(Value::as_u64),
            Some(0)
        );
        assert_eq!(
            progress.get("pendingTaskCount").and_then(Value::as_u64),
            Some(0)
        );
        assert_eq!(
            progress.get("completedTaskCount").and_then(Value::as_u64),
            Some(3)
        );
        assert!(status
            .get("progressUpdatedAt")
            .and_then(Value::as_str)
            .is_some());
    }

    #[test]
    fn discovery_publishes_total_before_any_file_is_indexed() {
        let root_dir = make_temp_dir("x-file-native-index-discovery-total");
        fs::create_dir_all(root_dir.join("nested")).unwrap();
        fs::create_dir_all(root_dir.join(".hidden")).unwrap();
        fs::create_dir_all(root_dir.join(".ai-index")).unwrap();
        fs::write(root_dir.join("a.md"), "# A").unwrap();
        fs::write(root_dir.join("nested/b.md"), "# B").unwrap();
        fs::write(root_dir.join("c.doc"), "legacy office binary placeholder").unwrap();
        fs::write(root_dir.join(".hidden/hidden.md"), "# hidden").unwrap();
        fs::write(root_dir.join(".ai-index/leak.md"), "# leak").unwrap();

        let request = NativeIndexRequest {
            root_dir: root_dir.to_string_lossy().to_string(),
            allowed_extensions: vec![".md".to_string(), ".doc".to_string()],
            included_hidden_paths: vec![],
            hide_dot_files: true,
            hide_system_folders: true,
            reason: "native_test".to_string(),
            target_path: None,
            target_paths: Vec::new(),
        };
        let options = super::NativeIndexOptions::from_request(&request);
        let mut updates = Vec::new();
        let result = super::scan_documents(
            &request.root_dir,
            &options,
            &TargetScope::All,
            None,
            |progress| {
                updates.push(progress);
                Ok(())
            },
        )
        .unwrap();
        fs::remove_dir_all(&root_dir).unwrap();

        assert_eq!(updates[0].scanned_count, 0);
        assert_eq!(updates[0].total_count, Some(3));
        assert_eq!(result.total_scanned, 3);
        assert_eq!(result.skipped_count, 1);
    }

    #[test]
    fn pdf_summary_is_skipped_during_indexing() {
        let file = ScannedFile {
            relative_path: "report.pdf".to_string(),
            full_path: PathBuf::from("missing-report.pdf"),
            extension: ".pdf".to_string(),
            size: 0,
            mtime: String::new(),
        };

        assert!(super::read_summary(&file).is_empty());
    }

    #[test]
    fn index_only_一次写入文件属性和正文摘要() {
        let root_dir = make_temp_dir("x-file-native-index-metadata-only");
        fs::create_dir_all(root_dir.join(".ai-index")).unwrap();
        fs::write(root_dir.join("a.md"), "# A\n\n正文摘要在首轮可用").unwrap();

        run_native_index_worker(NativeIndexRequest {
            root_dir: root_dir.to_string_lossy().to_string(),
            allowed_extensions: vec![".md".to_string()],
            included_hidden_paths: vec![],
            hide_dot_files: true,
            hide_system_folders: true,

            reason: "native_test".to_string(),
            target_path: None,
            target_paths: Vec::new(),
        })
        .unwrap();

        let snapshot_path = root_dir.join(".ai-index/runtime/export-catalog-snapshot.json");
        let snapshot: Value =
            serde_json::from_str(&fs::read_to_string(snapshot_path).unwrap()).unwrap();
        let document = snapshot
            .get("documents")
            .and_then(Value::as_array)
            .and_then(|items| items.first())
            .unwrap();
        fs::remove_dir_all(&root_dir).ok();

        assert_eq!(document.get("title").and_then(Value::as_str), Some("a"));
        assert!(document["summary"]
            .as_str()
            .unwrap()
            .contains("正文摘要在首轮可用"));
    }

    #[test]
    fn partial_snapshot_merge_preserves_previous_unprocessed_documents() {
        let previous = ExportCatalogSnapshot {
            version: 1,
            generated_at: Some("2026-06-30T00:00:00Z".to_string()),
            tags: vec![],
            documents: vec![
                SnapshotDocument {
                    document_id: "doc_old".to_string(),
                    path: "deep/old.md".to_string(),
                    title: "旧文档".to_string(),
                    summary: "old".to_string(),
                    tags: vec![],
                    derived_tags: vec![],
                    mtime: "2026-06-29T00:00:00Z".to_string(),
                },
                SnapshotDocument {
                    document_id: "doc_current".to_string(),
                    path: "a.md".to_string(),
                    title: "旧 A".to_string(),
                    summary: "old a".to_string(),
                    tags: vec![],
                    derived_tags: vec![],
                    mtime: "2026-06-29T00:00:00Z".to_string(),
                },
            ],
        };
        let partial = vec![SnapshotDocument {
            document_id: "doc_current".to_string(),
            path: "a.md".to_string(),
            title: "新 A".to_string(),
            summary: "new a".to_string(),
            tags: vec![],
            derived_tags: vec![],
            mtime: "2026-06-30T00:00:00Z".to_string(),
        }];

        let merged = merge_partial_snapshot_documents(partial, Some(previous));
        let titles = merged
            .into_iter()
            .map(|document| (document.path, document.title))
            .collect::<BTreeMap<_, _>>();

        assert_eq!(titles.get("a.md").map(String::as_str), Some("新 A"));
        assert_eq!(
            titles.get("deep/old.md").map(String::as_str),
            Some("旧文档")
        );
    }

    #[test]
    fn indexed_document_journal_让失败前完成的文件可被下轮复用() {
        let root_dir = make_temp_dir("x-file-native-index-journal-reuse");
        let document = ScannedDocument {
            relative_path: "a.md".to_string(),
            extension: ".md".to_string(),
            size: 12,
            title: "A".to_string(),
            summary: "alpha".to_string(),
            tags: vec!["主题/恢复".to_string()],
            mtime: "2026-06-30T10:00:00Z".to_string(),
            derived_tags: vec!["类型/文本/Markdown".to_string()],
            reused_previous: false,
        };
        append_indexed_document_journal(&root_dir.to_string_lossy(), &document)
            .expect("写入索引恢复日志失败");

        let previous_state = load_previous_native_index_state(&root_dir.to_string_lossy())
            .expect("恢复日志应能独立构造 previous state");
        let file = ScannedFile {
            relative_path: "a.md".to_string(),
            full_path: root_dir.join("a.md"),
            extension: ".md".to_string(),
            size: 12,
            mtime: "2026-06-30T10:00:00Z".to_string(),
        };
        let reused = resolve_reusable_previous_document(&file, Some(&previous_state))
            .expect("未变化文件应该直接复用恢复日志中的索引结果");
        fs::remove_dir_all(&root_dir).ok();

        assert!(reused.reused_previous);
        assert_eq!(reused.summary, "alpha");
        assert_eq!(reused.tags, vec!["主题/恢复".to_string()]);
    }

    #[test]
    fn partial_export_snapshot_缺少_active_state_时可从文件系统补齐复用条件() {
        let root_dir = make_temp_dir("x-file-native-index-snapshot-hydrate");
        let file_path = root_dir.join("a.md");
        fs::write(&file_path, "# A").unwrap();
        let metadata = fs::metadata(&file_path).unwrap();
        let mtime = metadata
            .modified()
            .ok()
            .map(|value| chrono::DateTime::<chrono::Utc>::from(value).to_rfc3339())
            .unwrap();
        let snapshot_path = root_dir
            .join(".ai-index")
            .join("runtime")
            .join("export-catalog-snapshot.json");
        write_json_file(
            &snapshot_path,
            &ExportCatalogSnapshot {
                version: 1,
                generated_at: Some("2026-06-30T10:00:00Z".to_string()),
                tags: vec![],
                documents: vec![SnapshotDocument {
                    document_id: "doc_a".to_string(),
                    path: "a.md".to_string(),
                    title: "A".to_string(),
                    summary: "alpha".to_string(),
                    tags: vec![],
                    derived_tags: vec![],
                    mtime: mtime.clone(),
                }],
            },
        )
        .expect("写入 partial export snapshot 失败");

        let previous_state = load_previous_native_index_state(&root_dir.to_string_lossy())
            .expect("partial export snapshot 应能补齐 active state");
        let file = ScannedFile {
            relative_path: "a.md".to_string(),
            full_path: file_path,
            extension: ".md".to_string(),
            size: metadata.len(),
            mtime,
        };
        let reused = resolve_reusable_previous_document(&file, Some(&previous_state))
            .expect("文件未变化时应复用 partial export snapshot");
        fs::remove_dir_all(&root_dir).ok();

        assert!(reused.reused_previous);
        assert_eq!(reused.summary, "alpha");
    }

    #[test]
    fn runtime_snapshot_成功写入后会清理索引恢复日志() {
        let root_dir = make_temp_dir("x-file-native-index-journal-clear");
        let document = ScannedDocument {
            relative_path: "a.md".to_string(),
            extension: ".md".to_string(),
            size: 12,
            title: "A".to_string(),
            summary: "alpha".to_string(),
            tags: vec![],
            mtime: "2026-06-30T10:00:00Z".to_string(),
            derived_tags: vec![],
            reused_previous: false,
        };
        append_indexed_document_journal(&root_dir.to_string_lossy(), &document)
            .expect("写入索引恢复日志失败");
        let journal_path = root_dir
            .join(".ai-index")
            .join("runtime")
            .join("indexed-document-journal.jsonl");
        assert!(journal_path.is_file());

        write_runtime_mirror_snapshots(
            &root_dir.to_string_lossy(),
            &ScanDocumentsResult {
                documents: vec![document],
                skipped_documents: vec![],
                parser_skips: vec![],
                total_scanned: 1,
                unchanged_count: 0,
                skipped_count: 0,
                deleted_paths: vec![],
            },
            &TargetScope::All,
        )
        .expect("写入正式 runtime snapshot 失败");
        let journal_exists = journal_path.exists();
        fs::remove_dir_all(&root_dir).ok();

        assert!(!journal_exists);
    }

    #[test]
    fn text_summary_只读取前缀避免大文本拖慢索引() {
        let root_dir = make_temp_dir("x-file-native-summary-text-budget");
        let file_path = root_dir.join("large.txt");
        let content = format!("{}tail-marker", "a".repeat(SUMMARY_TEXT_MAX_BYTES + 64));
        fs::write(&file_path, content).unwrap();

        let summary = read_text_summary(&file_path);
        fs::remove_dir_all(&root_dir).ok();

        assert!(!summary.contains("tail-marker"));
    }

    #[test]
    fn 摘要同时遵守字符和字节上限并保持有效文本() {
        let ascii = super::short_summary(&"a".repeat(5000), super::SUMMARY_MAX_CHARS);
        assert_eq!(ascii.len(), 1000);
        let chinese = super::short_summary(&"中".repeat(5000), super::SUMMARY_MAX_CHARS);
        assert_eq!(chinese.chars().count(), SUMMARY_TEXT_MAX_BYTES / 3);
        assert!(chinese.len() <= SUMMARY_TEXT_MAX_BYTES);
        assert_eq!(
            super::short_summary(" \n alpha\t beta\u{0}\u{fffd}  ", super::SUMMARY_MAX_CHARS),
            "alpha beta"
        );
    }

    #[test]
    fn 文本前缀截断中文时不生成替换字符() {
        let root = make_temp_dir("x-file-summary-utf8-prefix");
        let path = root.join("a.txt");
        fs::write(&path, "中".repeat(1000)).unwrap();
        let raw = super::read_text_prefix(&path, SUMMARY_TEXT_MAX_BYTES).unwrap();
        fs::remove_dir_all(root).unwrap();
        assert_eq!(raw, "中".repeat(SUMMARY_TEXT_MAX_BYTES / 3));
    }

    #[test]
    fn 办公摘要只解压指定条目前缀并允许截断的正文节点() {
        let root = make_temp_dir("x-file-summary-office-prefix");
        let docx = root.join("a.docx");
        let payload = format!(
            "<w:document><w:p><w:r><w:t>{}tail-marker</w:t></w:r></w:p></w:document>",
            "中".repeat(10000)
        );
        write_zip_file(&docx, &[("word/document.xml", &payload), ("other.xml", "ignored")]);
        let entries = super::read_zip_text_entries_for_summary(&docx, &["word/document.xml"]).unwrap();
        assert_eq!(entries.len(), 1);
        assert!(entries["word/document.xml"].len() <= super::SUMMARY_ARCHIVE_ENTRY_MAX_BYTES);
        let summary = super::read_docx_summary(&docx);
        fs::remove_dir_all(root).unwrap();
        assert!(!summary.is_empty());
        assert!(summary.len() <= SUMMARY_TEXT_MAX_BYTES);
        assert!(summary.chars().count() <= super::SUMMARY_MAX_CHARS);
        assert!(!summary.contains("tail-marker"));
        assert!(!summary.contains('\u{fffd}'));
    }

    #[test]
    fn 演示文稿摘要不读取后续幻灯片() {
        let root = make_temp_dir("x-file-summary-first-slide");
        let path = root.join("a.pptx");
        write_zip_file(
            &path,
            &[
                ("ppt/slides/slide1.xml", "<p:sld><a:t>第一页</a:t></p:sld>"),
                ("ppt/slides/slide2.xml", "<p:sld><a:t>第二页</a:t></p:sld>"),
            ],
        );
        assert_eq!(super::read_pptx_summary(&path), "第一页");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn xlsx_summary_限制读取工作表数量() {
        let root_dir = make_temp_dir("x-file-native-summary-xlsx-budget");
        let file_path = root_dir.join("budget.xlsx");
        let mut entries = vec![(
            "xl/sharedStrings.xml",
            r#"<?xml version="1.0" encoding="UTF-8"?>
            <sst><si><t>共享文本</t></si></sst>"#,
        )];
        let mut sheet_payloads = Vec::new();
        for index in 1..=3 {
            sheet_payloads.push((
                format!("xl/worksheets/sheet{index}.xml"),
                format!(
                    r#"<?xml version="1.0" encoding="UTF-8"?>
                    <worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>sheet-{index}</t></is></c></row></sheetData></worksheet>"#
                ),
            ));
        }
        for (name, payload) in &sheet_payloads {
            entries.push((name.as_str(), payload.as_str()));
        }
        write_zip_file(&file_path, &entries);

        let summary = read_xlsx_summary(&file_path);
        fs::remove_dir_all(&root_dir).ok();

        assert!(summary.contains("sheet-1"));
        assert!(!summary.contains("sheet-2"));
        assert!(!summary.contains("sheet-3"));
    }

    #[test]
    fn 恢复日志中的完整文档会提交到正式快照() {
        let root = make_temp_dir("x-file-journal-resume");
        let request = NativeIndexRequest {
            root_dir: root.to_string_lossy().to_string(),
            allowed_extensions: vec![],
            included_hidden_paths: vec![],
            hide_dot_files: true,
            hide_system_folders: true,
            reason: "test".to_string(),
            target_path: None,
            target_paths: Vec::new(),
        };
        fs::write(root.join("a.md"), "alpha").unwrap();
        run_native_index_worker(request.clone()).unwrap();
        let file_path = root.join("b.md");
        fs::write(&file_path, "bravo").unwrap();
        let metadata = fs::metadata(&file_path).unwrap();
        let file = ScannedFile {
            relative_path: "b.md".to_string(),
            full_path: file_path,
            extension: ".md".to_string(),
            size: metadata.len(),
            mtime: chrono::DateTime::<chrono::Utc>::from(metadata.modified().unwrap()).to_rfc3339(),
        };
        let document = super::index_document(file, None);
        append_indexed_document_journal(&request.root_dir, &document).unwrap();
        let result = run_native_index_worker(request.clone()).unwrap();
        assert_eq!(result["index"]["indexedCount"], 0);
        assert_eq!(result["index"]["unchangedCount"], 2);
        let snapshot = super::read_existing_snapshot(&request.root_dir)
            .unwrap()
            .unwrap();
        assert_eq!(snapshot.documents.len(), 2);
        assert_eq!(
            snapshot
                .documents
                .iter()
                .find(|document| document.path == "b.md")
                .unwrap()
                .summary,
            "bravo"
        );
        assert!(!super::indexed_document_journal_path(&request.root_dir).exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn 办公文档摘要仍使用原生提取() {
        let root = make_temp_dir("x-file-office-summaries");
        let docx = root.join("a.docx");
        write_zip_file(
            &docx,
            &[(
                "word/document.xml",
                "<w:document><w:p><w:r><w:t>Word 正文</w:t></w:r></w:p></w:document>",
            )],
        );
        assert!(super::read_docx_summary(&docx).contains("Word 正文"));
        let pptx = root.join("a.pptx");
        write_zip_file(
            &pptx,
            &[(
                "ppt/slides/slide1.xml",
                "<p:sld><a:r><a:t>PPT 正文</a:t></a:r></p:sld>",
            )],
        );
        assert!(super::read_pptx_summary(&pptx).contains("PPT 正文"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn 无变化刷新保留活动快照和目录快照版本() {
        let root = make_temp_dir("x-file-no-change-versions");
        fs::write(root.join("a.md"), "alpha").unwrap();
        fs::write(root.join("old.doc"), "legacy").unwrap();
        let request = NativeIndexRequest {
            root_dir: root.to_string_lossy().to_string(),
            allowed_extensions: vec![],
            included_hidden_paths: vec![],
            hide_dot_files: true,
            hide_system_folders: true,
            reason: "test".to_string(),
            target_path: None,
            target_paths: vec![],
        };
        run_native_index_worker(request.clone()).unwrap();
        let paths = [
            super::active_file_state_snapshot_path(&request.root_dir),
            super::export_catalog_snapshot_path(&request.root_dir),
            super::index_state_snapshot_path(&request.root_dir),
        ];
        let before = paths
            .iter()
            .map(|path| super::file_version(path))
            .collect::<Vec<_>>();
        let result = run_native_index_worker(request).unwrap();
        assert_eq!(result["index"]["indexedCount"], 0);
        assert_eq!(
            before,
            paths
                .iter()
                .map(|path| super::file_version(path))
                .collect::<Vec<_>>()
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn 多路径扫描只处理指定文件并保留范围外记录() {
        let root = make_temp_dir("x-file-target-paths");
        for dir in ["a", "b", "c"] {
            fs::create_dir(root.join(dir)).unwrap();
            fs::write(root.join(dir).join("file.md"), dir).unwrap();
        }
        let mut request = NativeIndexRequest {
            root_dir: root.to_string_lossy().to_string(),
            allowed_extensions: vec![],
            included_hidden_paths: vec![],
            hide_dot_files: true,
            hide_system_folders: true,
            reason: "test".to_string(),
            target_path: None,
            target_paths: vec![],
        };
        run_native_index_worker(request.clone()).unwrap();
        fs::write(root.join("a/file.md"), "updated alpha").unwrap();
        fs::write(root.join("b/file.md"), "updated beta").unwrap();
        request.target_paths = vec!["a/file.md".to_string(), "b/file.md".to_string()];
        let result = run_native_index_worker(request.clone()).unwrap();
        assert_eq!(result["index"]["scannedCount"], 2);
        assert_eq!(result["index"]["indexedCount"], 2);
        assert_eq!(
            super::read_catalog(&request.root_dir)
                .unwrap()
                .unwrap()
                .documents
                .len(),
            3
        );
        fs::remove_file(root.join("a/file.md")).unwrap();
        let result = run_native_index_worker(request.clone()).unwrap();
        assert_eq!(
            result["index"]["deletedPaths"],
            serde_json::json!(["a/file.md"])
        );
        assert_eq!(
            super::read_catalog(&request.root_dir)
                .unwrap()
                .unwrap()
                .documents
                .len(),
            2
        );
        request.target_paths = vec!["b".to_string(), "b/file.md".to_string()];
        let result = run_native_index_worker(request).unwrap();
        assert_eq!(result["index"]["scannedCount"], 1);
        fs::remove_dir_all(root).unwrap();
    }

    fn make_temp_dir(prefix: &str) -> PathBuf {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("{prefix}-{timestamp}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_zip_file(path: &PathBuf, entries: &[(&str, &str)]) {
        let file = fs::File::create(path).unwrap();
        let mut zip = ZipWriter::new(file);
        let options = SimpleFileOptions::default();
        for (name, content) in entries {
            zip.start_file(name, options).unwrap();
            zip.write_all(content.as_bytes()).unwrap();
        }
        zip.finish().unwrap();
    }
}
