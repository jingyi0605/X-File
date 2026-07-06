use crate::native_core::state_store::{
    active_file_state_snapshot_path, export_catalog_snapshot_path, index_state_snapshot_path,
    indexed_document_journal_path, priority_hints_path, runtime_status_path,
    summary_backfill_state_path,
};
use crate::read_optional_json_file;
use chrono::Datelike;
use flate2::read::{DeflateDecoder, ZlibDecoder};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashSet, VecDeque};
use std::fs;
use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::Arc;
use std::thread;
use zip::ZipArchive;

const INDEX_COOLDOWN_MS: i64 = 1500;
const INDEX_PROGRESS_FLUSH_INTERVAL_MS: i64 = 500;
const INDEX_PROGRESS_FLUSH_EVERY_FILES: usize = 16;
const INDEX_PARTIAL_SNAPSHOT_FLUSH_INTERVAL_MS: i64 = 5000;
const INDEX_PARTIAL_SNAPSHOT_FLUSH_EVERY_DOCUMENTS: usize = 256;
const NATIVE_INDEX_WORKER_MAX: usize = 8;
const SUMMARY_TEXT_MAX_BYTES: usize = 256 * 1024;
const SUMMARY_ARCHIVE_ENTRY_MAX_BYTES: usize = 512 * 1024;
const SUMMARY_ARCHIVE_MAX_ENTRIES: usize = 16;
const SUMMARY_PDF_MAX_BYTES: usize = 2 * 1024 * 1024;
const SUMMARY_PDF_MAX_PAGES: usize = 3;
const SUMMARY_PPTX_MAX_SLIDES: usize = 6;
const SUMMARY_XLSX_MAX_SHEETS: usize = 3;
const SUMMARY_XLSX_MAX_ROWS_PER_SHEET: usize = 20;
const PDF_INFLATE_MAX_BYTES: u64 = 512 * 1024;
const SUMMARY_BACKFILL_FLUSH_EVERY_DOCUMENTS: usize = 16;
const SUMMARY_BACKFILL_RUNNING_STAGE: &str = "summary_backfill";

const NATIVE_LIGHTWEIGHT_INDEX_EXTENSIONS: &[&str] = &[
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
    ".csv",
];

const NATIVE_OPENXML_TARGET_EXTENSIONS: &[&str] = &[".docx", ".xlsx", ".pptx"];
const NATIVE_OPENDOCUMENT_TARGET_EXTENSIONS: &[&str] = &[".odt", ".ods", ".odp"];
const NATIVE_PDF_SUMMARY_EXTENSIONS: &[&str] = &[".pdf"];
const NATIVE_SKIP_ONLY_EXTENSIONS: &[&str] =
    &[".doc", ".wps", ".xls", ".et", ".numbers", ".ppt", ".key"];

#[derive(Debug, Clone)]
pub struct NativeIndexRequest {
    pub root_dir: String,
    pub allowed_extensions: Vec<String>,
    pub included_hidden_paths: Vec<String>,
    pub config_relative_path: String,
    pub reason: String,
    pub target_path: Option<String>,
}

#[derive(Debug, Clone)]
pub struct NativeParserRequest {
    pub file_path: String,
    pub extension: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportCatalogSnapshot {
    version: u32,
    #[serde(rename = "generatedAt")]
    generated_at: String,
    tags: Vec<SnapshotTag>,
    documents: Vec<SnapshotDocument>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotTag {
    path: String,
    name: String,
    root_type: String,
    parent_path: Option<String>,
    depth: usize,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotDocument {
    document_id: String,
    path: String,
    title: String,
    summary: String,
    tags: Vec<String>,
    derived_tags: Vec<String>,
    mtime: String,
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

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeConfigFile {
    #[serde(default)]
    max_file_size_bytes: Option<u64>,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeSummaryBackfillStateSnapshot {
    version: u32,
    generated_at: String,
    files: Vec<RuntimeIndexedDocumentState>,
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
    max_concurrency: usize,
    pending_index_task_count: usize,
}

#[derive(Debug, Clone)]
struct PartialSnapshotFlushState {
    last_flushed_at: i64,
    completed_since_flush: usize,
}

#[derive(Debug, Clone, Default)]
struct CountProgressStats {
    visited_count: usize,
    total_count: usize,
}

#[derive(Debug, Clone, Default)]
struct SummaryBackfillProgressStats {
    total_count: usize,
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
    Exact(String),
    Prefix(String),
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
        let options = NativeIndexOptions::from_request(&request);
        let target_scope = resolve_target_scope(&root_dir, request.target_path.as_deref())?;
        let total_count =
            count_indexable_files(&root_dir, &options, &target_scope, |count_progress| {
                write_runtime_status(
                    &root_dir,
                    PersistedRuntimeStatus {
                        state: "running".to_string(),
                        last_requested_at: Some(last_requested_at.clone()),
                        last_started_at: Some(last_started_at.clone()),
                        last_completed_at: None,
                        last_failed_at: None,
                        next_allowed_at: None,
                        progress_updated_at: Some(iso_now()),
                        running_stage: Some("count_files".to_string()),
                        error_summary: None,
                        progress: Some(build_counting_index_progress(&count_progress)),
                    },
                )
            })?;
        write_runtime_status(
            &root_dir,
            PersistedRuntimeStatus {
                state: "running".to_string(),
                last_requested_at: Some(last_requested_at.clone()),
                last_started_at: Some(last_started_at.clone()),
                last_completed_at: None,
                last_failed_at: None,
                next_allowed_at: None,
                progress_updated_at: Some(iso_now()),
                running_stage: Some("index_text".to_string()),
                error_summary: None,
                progress: Some(build_running_index_progress(&ScanProgressStats {
                    total_count: Some(total_count),
                    ..ScanProgressStats::default()
                })),
            },
        )?;
        let scanned = scan_documents(
            &root_dir,
            &options,
            &target_scope,
            Some(total_count),
            |progress| {
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
        let snapshot_path = write_export_snapshot(&root_dir, &scanned.documents, &target_scope)?;
        write_runtime_mirror_snapshots(&root_dir, &scanned, &target_scope)?;
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
            max_concurrency: Some(resolve_native_index_worker_count()),
            active_task_count: 0,
            pending_task_count: 0,
            completed_task_count: scanned.total_scanned,
        };
        let dirty_scope =
            build_dirty_scope(&scanned.documents, &scanned.deleted_paths, &target_scope);
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

pub fn run_native_summary_backfill_worker(request: NativeIndexRequest) -> Result<Value, String> {
    let root_dir = request.root_dir.trim().to_string();
    if root_dir.is_empty() {
        return Err("native summary backfill 缺少 rootDir".to_string());
    }
    let root = PathBuf::from(&root_dir);
    if !root.is_dir() {
        return Err("文档库根目录不存在".to_string());
    }
    let target_scope = resolve_target_scope(&root_dir, request.target_path.as_deref())?;
    let Some(mut snapshot) = read_existing_snapshot(&root_dir)? else {
        return Ok(json!({
            "accepted": true,
            "mode": "summary-backfill",
            "processedCount": 0,
            "updatedCount": 0,
            "skippedCount": 0,
        }));
    };
    let active_snapshot = read_optional_json_file::<RuntimeActiveFileStateSnapshot>(
        &active_file_state_snapshot_path(&root_dir),
    )?
    .unwrap_or(RuntimeActiveFileStateSnapshot {
        version: 1,
        generated_at: iso_now(),
        files: Vec::new(),
    });
    let active_files = active_snapshot
        .files
        .into_iter()
        .map(|item| (item.path.clone(), item))
        .collect::<BTreeMap<_, _>>();
    let mut completed = load_summary_backfill_state(&root_dir);
    let last_requested_at = iso_now();
    let last_started_at = iso_now();
    let total_count = snapshot
        .documents
        .iter()
        .filter(|document| {
            if !target_scope_matches_path(&target_scope, &document.path) {
                return false;
            }
            let Some(active) = active_files.get(&document.path) else {
                return false;
            };
            if active.index_status != "indexed" {
                return false;
            }
            !completed
                .get(&document.path)
                .is_some_and(|state| runtime_indexed_state_matches(state, active))
        })
        .count();
    let initial_progress = SummaryBackfillProgressStats {
        total_count,
        ..SummaryBackfillProgressStats::default()
    };
    write_summary_backfill_runtime_status(
        &root_dir,
        &last_requested_at,
        &last_started_at,
        "running",
        Some(SUMMARY_BACKFILL_RUNNING_STAGE.to_string()),
        None,
        Some(build_summary_backfill_progress(&initial_progress)),
        None,
        None,
        None,
    )?;

    let result = (|| -> Result<(usize, usize, usize, Vec<String>, SummaryBackfillProgressStats), String> {
        let mut processed_count = 0usize;
        let mut updated_count = 0usize;
        let mut skipped_count = 0usize;
        let mut completed_since_flush = 0usize;
        let mut progress_steps_since_emit = 0usize;
        let mut last_progress_emit_at = chrono::Utc::now().timestamp_millis();
        let mut changed_paths = Vec::<String>::new();
        let mut progress_stats = initial_progress.clone();

        for index in 0..snapshot.documents.len() {
            let document_path = snapshot.documents[index].path.clone();
            if !target_scope_matches_path(&target_scope, &document_path) {
                continue;
            }
            let Some(active) = active_files.get(&document_path) else {
                skipped_count += 1;
                continue;
            };
            if active.index_status != "indexed" {
                skipped_count += 1;
                continue;
            }
            if completed
                .get(&document_path)
                .is_some_and(|state| runtime_indexed_state_matches(state, active))
            {
                skipped_count += 1;
                continue;
            }

            let document = &mut snapshot.documents[index];
            progress_stats.scanned_count += 1;

            if !document.summary.trim().is_empty() {
                completed.insert(document_path, active.clone());
                progress_stats.unchanged_count += 1;
                completed_since_flush += 1;
                progress_steps_since_emit += 1;
                maybe_report_summary_backfill_progress(
                    &root_dir,
                    &last_requested_at,
                    &last_started_at,
                    &mut last_progress_emit_at,
                    &mut progress_steps_since_emit,
                    &progress_stats,
                )?;
                continue;
            }

            let file_path = root.join(&document_path);
            if !file_path.is_file() {
                skipped_count += 1;
                progress_stats.skipped_count += 1;
                progress_steps_since_emit += 1;
                maybe_report_summary_backfill_progress(
                    &root_dir,
                    &last_requested_at,
                    &last_started_at,
                    &mut last_progress_emit_at,
                    &mut progress_steps_since_emit,
                    &progress_stats,
                )?;
                continue;
            }
            let file = ScannedFile {
                relative_path: document_path.clone(),
                full_path: file_path,
                extension: active.extension.clone(),
                size: active.size,
                mtime: active.mtime.clone(),
            };
            document.summary = read_summary(&file);
            completed.insert(document_path, active.clone());
            processed_count += 1;
            updated_count += 1;
            progress_stats.indexed_count += 1;
            completed_since_flush += 1;
            progress_steps_since_emit += 1;
            changed_paths.push(document.path.clone());
            maybe_report_summary_backfill_progress(
                &root_dir,
                &last_requested_at,
                &last_started_at,
                &mut last_progress_emit_at,
                &mut progress_steps_since_emit,
                &progress_stats,
            )?;
            if completed_since_flush >= SUMMARY_BACKFILL_FLUSH_EVERY_DOCUMENTS {
                write_existing_snapshot(&root_dir, &snapshot)?;
                write_summary_backfill_state(&root_dir, &completed)?;
                completed_since_flush = 0;
            }
        }

        write_existing_snapshot(&root_dir, &snapshot)?;
        write_summary_backfill_state(&root_dir, &completed)?;
        Ok((
            processed_count,
            updated_count,
            skipped_count,
            changed_paths,
            progress_stats,
        ))
    })();

    match result {
        Ok((processed_count, updated_count, skipped_count, changed_paths, progress_stats)) => {
            let completed_at = iso_now();
            let next_allowed_at =
                iso_after_ms(INDEX_COOLDOWN_MS).unwrap_or_else(|| completed_at.clone());
            write_summary_backfill_runtime_status(
                &root_dir,
                &last_requested_at,
                &last_started_at,
                "cooldown",
                None,
                None,
                Some(build_summary_backfill_progress(&progress_stats)),
                Some(completed_at.clone()),
                None,
                Some(next_allowed_at.clone()),
            )?;
            Ok(json!({
                "accepted": true,
                "mode": "summary-backfill",
                "processedCount": processed_count,
                "updatedCount": updated_count,
                "skippedCount": skipped_count,
                "totalCount": progress_stats.total_count,
                "changedPaths": changed_paths,
            }))
        }
        Err(error) => {
            write_summary_backfill_runtime_status(
                &root_dir,
                &last_requested_at,
                &last_started_at,
                "failed",
                Some(SUMMARY_BACKFILL_RUNNING_STAGE.to_string()),
                Some(error.clone()),
                Some(build_summary_backfill_progress(&initial_progress)),
                None,
                Some(iso_now()),
                None,
            )?;
            Err(error)
        }
    }
}

pub fn run_native_parser(request: NativeParserRequest) -> Result<Value, String> {
    let path = PathBuf::from(request.file_path.trim());
    if request.file_path.trim().is_empty() {
        return Err("native parser 缺少 filePath".to_string());
    }
    if !path.is_file() {
        return Err(format!("native parser 目标文件不存在：{}", path.display()));
    }
    let extension = normalize_parser_extension(&request.extension);
    match extension.as_str() {
        ".docx" => build_docx_parse_payload(&path, &extension),
        ".xlsx" => build_xlsx_parse_payload(&path, &extension),
        ".pptx" => build_pptx_parse_payload(&path, &extension),
        ".pdf" => build_pdf_parse_payload(&path, &extension),
        other => Err(format!("native parser 不支持的扩展名：{other}")),
    }
}

// 这里保留旧 helper 名字，是为了不改宿主现有调用点；
// 实际语义已经收口为“桌面默认原生主链可承接的扩展集合”。
pub fn can_native_index_lightweight_set(allowed_extensions: &[String]) -> bool {
    if allowed_extensions.is_empty() {
        return true;
    }
    can_native_index_extension_set(allowed_extensions, is_native_default_route_extension)
}

fn can_native_index_extension_set(
    allowed_extensions: &[String],
    predicate: fn(&str) -> bool,
) -> bool {
    let Some(normalized) = normalize_allowed_extensions(allowed_extensions) else {
        return false;
    };
    if normalized.is_empty() {
        return false;
    }
    normalized.iter().all(|extension| predicate(extension))
}

pub fn is_native_lightweight_extension(extension: &str) -> bool {
    let normalized = extension.trim().to_lowercase();
    let normalized = if normalized.starts_with('.') {
        normalized
    } else {
        format!(".{normalized}")
    };
    NATIVE_LIGHTWEIGHT_INDEX_EXTENSIONS.contains(&normalized.as_str())
}

pub fn is_native_openxml_target_extension(extension: &str) -> bool {
    let normalized = extension.trim().to_lowercase();
    let normalized = if normalized.starts_with('.') {
        normalized
    } else {
        format!(".{normalized}")
    };
    NATIVE_OPENXML_TARGET_EXTENSIONS.contains(&normalized.as_str())
}

pub fn is_native_pdf_summary_extension(extension: &str) -> bool {
    let normalized = extension.trim().to_lowercase();
    let normalized = if normalized.starts_with('.') {
        normalized
    } else {
        format!(".{normalized}")
    };
    NATIVE_PDF_SUMMARY_EXTENSIONS.contains(&normalized.as_str())
}

pub fn is_native_opendocument_target_extension(extension: &str) -> bool {
    let normalized = extension.trim().to_lowercase();
    let normalized = if normalized.starts_with('.') {
        normalized
    } else {
        format!(".{normalized}")
    };
    NATIVE_OPENDOCUMENT_TARGET_EXTENSIONS.contains(&normalized.as_str())
}

pub fn is_native_summary_extension(extension: &str) -> bool {
    is_native_lightweight_extension(extension)
        || is_native_openxml_target_extension(extension)
        || is_native_opendocument_target_extension(extension)
        || is_native_pdf_summary_extension(extension)
}

pub fn is_native_default_route_extension(extension: &str) -> bool {
    is_native_summary_extension(extension) || is_native_skip_only_extension(extension)
}

pub fn is_native_skip_only_extension(extension: &str) -> bool {
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
    max_file_size_bytes: Option<u64>,
}

impl NativeIndexOptions {
    fn from_request(request: &NativeIndexRequest) -> Self {
        let allowed_extensions = normalize_allowed_extensions(&request.allowed_extensions);
        let included_hidden_paths = normalize_included_hidden_paths(&request.included_hidden_paths);
        let max_file_size_bytes =
            read_max_file_size_bytes(&request.root_dir, &request.config_relative_path);
        Self {
            allowed_extensions,
            included_hidden_paths,
            max_file_size_bytes,
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

enum NativeIndexTask {
    Index(ScannedFile),
    Stop,
}

enum NativeIndexTaskResult {
    Indexed(ScannedDocument),
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
    let direct_assigned_count = scanned
        .documents
        .iter()
        .map(|document| document.tags.len())
        .sum::<usize>();
    let derived_assigned_count = scanned
        .documents
        .iter()
        .map(|document| document.derived_tags.len())
        .sum::<usize>();
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
        "timingsMs": {
            "scanFs": 0.0,
            "parse": 0.0,
            "tagInference": 0.0,
            "skipCatalog": 0.0,
            "writeIndexed": 0.0,
            "writeSkipped": 0.0,
            "scanAndParse": 0.0,
            "writeSuccess": 0.0,
            "writeFailure": 0.0,
            "scanLoop": 0.0,
            "cleanup": 0.0,
            "reconcile": 0.0,
            "dirtyScope": 0.0,
            "total": total_duration_ms,
        },
        "batchStats": {
            "writeBatchSize": 1,
            "successBatchCount": indexed_count + scanned.skipped_documents.len(),
            "failureBatchCount": 0,
        },
        "tagStats": {
            "directAssignedCount": direct_assigned_count,
            "derivedAssignedCount": derived_assigned_count,
            "avgDirectPerIndexedDocument": if indexed_count > 0 {
                direct_assigned_count as f64 / indexed_count as f64
            } else {
                0.0
            },
            "avgDerivedPerIndexedDocument": if indexed_count > 0 {
                derived_assigned_count as f64 / indexed_count as f64
            } else {
                0.0
            },
        },
        "skipStats": {
            "skippedCount": scanned.skipped_documents.len(),
            "skippedByExtension": skipped_by_extension,
            "skipCatalogRecords": scanned.parser_skips.len(),
        },
    })
}

#[derive(Debug, Clone)]
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
    estimated_total_count: Option<usize>,
    mut progress_reporter: impl FnMut(IndexProgress) -> Result<(), String>,
) -> Result<ScanDocumentsResult, String> {
    let root = PathBuf::from(root_dir);
    if !root.is_dir() {
        return Err("文档库根目录不存在".to_string());
    }
    let scan_base = resolve_scan_base(&root, target_scope);
    let mut queue = VecDeque::from([scan_base.clone()]);
    let mut queued_directory_paths =
        HashSet::<String>::from([directory_queue_key(&root, &scan_base)]);
    let mut visited_directory_paths = HashSet::<String>::new();
    let mut documents = Vec::new();
    let mut skipped_documents = Vec::new();
    let mut parser_skips = BTreeMap::<String, RuntimeParserSkipState>::new();
    let worker_count = resolve_native_index_worker_count();
    let mut progress_stats = ScanProgressStats {
        total_count: estimated_total_count,
        max_concurrency: worker_count,
        ..ScanProgressStats::default()
    };
    let previous_state = load_previous_native_index_state(root_dir);
    // 保持 worker 满载，但不要提前塞满每个 worker 的私有队列。
    // 这样用户访问目录写入 priority hint 后，只需要等待当前正在处理的任务完成，
    // 不会再被几十个已预取任务挡在后面。
    let max_pending_index_tasks = worker_count.saturating_add(1).max(2);
    let mut worker_pool = NativeIndexWorkerPool::start(worker_count, previous_state.clone());
    let mut pending_index_tasks = 0usize;
    let mut seen_paths = HashSet::<String>::new();
    let mut last_progress_emit_at = chrono::Utc::now().timestamp_millis();
    let mut files_since_last_progress_emit = 0usize;
    let mut partial_snapshot_flush = PartialSnapshotFlushState {
        last_flushed_at: chrono::Utc::now().timestamp_millis(),
        completed_since_flush: 0,
    };
    let mut last_priority_hint_check_at = 0i64;

    while let Some(current) = queue.pop_front() {
        queued_directory_paths.remove(&directory_queue_key(&root, &current));
        maybe_apply_priority_hints(
            root_dir,
            &root,
            options,
            target_scope,
            &mut queue,
            &mut queued_directory_paths,
            &visited_directory_paths,
            &mut last_priority_hint_check_at,
        )?;
        drain_finished_index_tasks(
            &mut worker_pool,
            &mut documents,
            &mut progress_stats,
            &mut pending_index_tasks,
            root_dir,
            target_scope,
            &mut partial_snapshot_flush,
        )?;
        if !current.exists() {
            continue;
        }
        let current_metadata = match fs::metadata(&current) {
            Ok(value) => value,
            Err(_) => continue,
        };
        if current_metadata.is_file() {
            files_since_last_progress_emit += 1;
            let scanned_file = match scan_file(&root, &current, &current_metadata, options) {
                ScanFileOutcome::Indexed(value) => {
                    progress_stats.scanned_count += 1;
                    value
                }
                ScanFileOutcome::Skipped(skip) => {
                    seen_paths.insert(skip.path.clone());
                    progress_stats.scanned_count += 1;
                    progress_stats.skipped_count += 1;
                    register_runtime_skip(&mut skipped_documents, &mut parser_skips, skip);
                    maybe_report_running_progress(
                        &mut progress_reporter,
                        &mut last_progress_emit_at,
                        &mut files_since_last_progress_emit,
                        &progress_stats,
                    )?;
                    continue;
                }
                ScanFileOutcome::Ignored => {
                    maybe_report_running_progress(
                        &mut progress_reporter,
                        &mut last_progress_emit_at,
                        &mut files_since_last_progress_emit,
                        &progress_stats,
                    )?;
                    continue;
                }
            };
            seen_paths.insert(scanned_file.relative_path.clone());
            if let Some(document) =
                resolve_reusable_previous_document(&scanned_file, previous_state.as_ref())
            {
                progress_stats.unchanged_count += 1;
                documents.push(document);
                maybe_flush_partial_export_snapshot(
                    root_dir,
                    &documents,
                    target_scope,
                    &mut partial_snapshot_flush,
                )?;
            } else {
                worker_pool.send(scanned_file)?;
                pending_index_tasks += 1;
                progress_stats.pending_index_task_count = pending_index_tasks;
                drain_index_tasks_until_below_limit(
                    &mut worker_pool,
                    &mut documents,
                    &mut progress_stats,
                    &mut pending_index_tasks,
                    max_pending_index_tasks,
                    root_dir,
                    target_scope,
                    &mut partial_snapshot_flush,
                )?;
            }
            maybe_report_running_progress(
                &mut progress_reporter,
                &mut last_progress_emit_at,
                &mut files_since_last_progress_emit,
                &progress_stats,
            )?;
            continue;
        }
        if !current_metadata.is_dir() {
            continue;
        }
        visited_directory_paths.insert(directory_queue_key(&root, &current));
        let entries = fs::read_dir(&current)
            .map_err(|error| format!("读取目录失败 {}: {error}", current.display()))?;
        let mut collected = entries.filter_map(Result::ok).collect::<Vec<_>>();
        collected.sort_by(|left, right| left.file_name().cmp(&right.file_name()));
        for entry in collected.into_iter().rev() {
            drain_finished_index_tasks(
                &mut worker_pool,
                &mut documents,
                &mut progress_stats,
                &mut pending_index_tasks,
                root_dir,
                target_scope,
                &mut partial_snapshot_flush,
            )?;
            let entry_path = entry.path();
            let metadata = match entry.metadata() {
                Ok(value) => value,
                Err(_) => continue,
            };
            let relative_path = normalize_relative_path(
                entry_path
                    .strip_prefix(&root)
                    .unwrap_or(entry_path.as_path()),
            );
            if metadata.is_dir() {
                if should_skip_directory(
                    &entry.file_name().to_string_lossy(),
                    &relative_path,
                    options,
                ) {
                    continue;
                }
                let queue_key = directory_queue_key(&root, &entry_path);
                if !visited_directory_paths.contains(&queue_key)
                    && queued_directory_paths.insert(queue_key)
                {
                    queue.push_back(entry_path);
                }
                continue;
            }
            if !metadata.is_file() {
                continue;
            }
            files_since_last_progress_emit += 1;
            let scanned_file = match scan_file(&root, &entry_path, &metadata, options) {
                ScanFileOutcome::Indexed(value) => {
                    progress_stats.scanned_count += 1;
                    value
                }
                ScanFileOutcome::Skipped(skip) => {
                    seen_paths.insert(skip.path.clone());
                    progress_stats.scanned_count += 1;
                    progress_stats.skipped_count += 1;
                    register_runtime_skip(&mut skipped_documents, &mut parser_skips, skip);
                    maybe_report_running_progress(
                        &mut progress_reporter,
                        &mut last_progress_emit_at,
                        &mut files_since_last_progress_emit,
                        &progress_stats,
                    )?;
                    continue;
                }
                ScanFileOutcome::Ignored => {
                    maybe_report_running_progress(
                        &mut progress_reporter,
                        &mut last_progress_emit_at,
                        &mut files_since_last_progress_emit,
                        &progress_stats,
                    )?;
                    continue;
                }
            };
            seen_paths.insert(scanned_file.relative_path.clone());
            if let Some(document) =
                resolve_reusable_previous_document(&scanned_file, previous_state.as_ref())
            {
                progress_stats.unchanged_count += 1;
                documents.push(document);
                maybe_flush_partial_export_snapshot(
                    root_dir,
                    &documents,
                    target_scope,
                    &mut partial_snapshot_flush,
                )?;
            } else {
                worker_pool.send(scanned_file)?;
                pending_index_tasks += 1;
                progress_stats.pending_index_task_count = pending_index_tasks;
                drain_index_tasks_until_below_limit(
                    &mut worker_pool,
                    &mut documents,
                    &mut progress_stats,
                    &mut pending_index_tasks,
                    max_pending_index_tasks,
                    root_dir,
                    target_scope,
                    &mut partial_snapshot_flush,
                )?;
            }
            maybe_report_running_progress(
                &mut progress_reporter,
                &mut last_progress_emit_at,
                &mut files_since_last_progress_emit,
                &progress_stats,
            )?;
        }
    }

    while pending_index_tasks > 0 {
        wait_for_one_index_task(
            &mut worker_pool,
            &mut documents,
            &mut progress_stats,
            &mut pending_index_tasks,
            root_dir,
            target_scope,
            &mut partial_snapshot_flush,
        )?;
        maybe_report_running_progress(
            &mut progress_reporter,
            &mut last_progress_emit_at,
            &mut files_since_last_progress_emit,
            &progress_stats,
        )?;
    }
    flush_partial_export_snapshot(
        root_dir,
        &documents,
        target_scope,
        true,
        &mut partial_snapshot_flush,
    )?;
    progress_stats.total_count = Some(progress_stats.scanned_count);
    progress_reporter(build_running_index_progress(&progress_stats))?;
    worker_pool.stop();
    documents.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    let deleted_paths = collect_deleted_paths(root_dir, target_scope, &seen_paths);
    Ok(ScanDocumentsResult {
        documents,
        skipped_documents,
        parser_skips: parser_skips.into_values().collect(),
        total_scanned: progress_stats.scanned_count,
        unchanged_count: progress_stats.unchanged_count,
        skipped_count: progress_stats.skipped_count,
        deleted_paths,
    })
}

fn maybe_report_running_progress(
    progress_reporter: &mut impl FnMut(IndexProgress) -> Result<(), String>,
    last_progress_emit_at: &mut i64,
    files_since_last_progress_emit: &mut usize,
    progress_stats: &ScanProgressStats,
) -> Result<(), String> {
    let now_ms = chrono::Utc::now().timestamp_millis();
    let reached_file_threshold =
        *files_since_last_progress_emit >= INDEX_PROGRESS_FLUSH_EVERY_FILES;
    let reached_time_threshold =
        now_ms.saturating_sub(*last_progress_emit_at) >= INDEX_PROGRESS_FLUSH_INTERVAL_MS;
    if !reached_file_threshold && !reached_time_threshold {
        return Ok(());
    }
    progress_reporter(build_running_index_progress(progress_stats))?;
    *last_progress_emit_at = now_ms;
    *files_since_last_progress_emit = 0;
    Ok(())
}

fn build_running_index_progress(progress_stats: &ScanProgressStats) -> IndexProgress {
    let completed_task_count = progress_stats.indexed_count
        + progress_stats.unchanged_count
        + progress_stats.skipped_count;
    let active_task_count = progress_stats
        .pending_index_task_count
        .min(progress_stats.max_concurrency);
    let pending_task_count = progress_stats
        .pending_index_task_count
        .saturating_sub(active_task_count);
    IndexProgress {
        scanned_count: progress_stats.scanned_count,
        indexed_count: progress_stats.indexed_count,
        skipped_count: progress_stats.skipped_count,
        failed_count: 0,
        unchanged_count: progress_stats.unchanged_count,
        total_count: progress_stats.total_count,
        max_concurrency: Some(progress_stats.max_concurrency),
        active_task_count,
        pending_task_count,
        completed_task_count,
    }
}

fn count_indexable_files(
    root_dir: &str,
    options: &NativeIndexOptions,
    target_scope: &TargetScope,
    mut progress_reporter: impl FnMut(CountProgressStats) -> Result<(), String>,
) -> Result<usize, String> {
    let root = PathBuf::from(root_dir);
    if !root.is_dir() {
        return Err("文档库根目录不存在".to_string());
    }
    let mut queue = VecDeque::from([resolve_scan_base(&root, target_scope)]);
    let mut progress_stats = CountProgressStats::default();
    let mut last_progress_emit_at = chrono::Utc::now().timestamp_millis();
    let mut files_since_last_progress_emit = 0usize;

    while let Some(current) = queue.pop_front() {
        if !current.exists() {
            continue;
        }
        let metadata = match fs::metadata(&current) {
            Ok(value) => value,
            Err(_) => continue,
        };
        if metadata.is_file() {
            progress_stats.visited_count += 1;
            files_since_last_progress_emit += 1;
            if matches!(
                scan_file(&root, &current, &metadata, options),
                ScanFileOutcome::Indexed(_) | ScanFileOutcome::Skipped(_)
            ) {
                progress_stats.total_count += 1;
            }
            maybe_report_count_progress(
                &mut progress_reporter,
                &mut last_progress_emit_at,
                &mut files_since_last_progress_emit,
                &progress_stats,
            )?;
            continue;
        }
        if !metadata.is_dir() {
            continue;
        }
        let entries = fs::read_dir(&current)
            .map_err(|error| format!("读取目录失败 {}: {error}", current.display()))?;
        let mut collected = entries.filter_map(Result::ok).collect::<Vec<_>>();
        collected.sort_by(|left, right| left.file_name().cmp(&right.file_name()));
        for entry in collected.into_iter().rev() {
            let entry_path = entry.path();
            let entry_metadata = match entry.metadata() {
                Ok(value) => value,
                Err(_) => continue,
            };
            let relative_path = normalize_relative_path(
                entry_path
                    .strip_prefix(&root)
                    .unwrap_or(entry_path.as_path()),
            );
            if entry_metadata.is_dir() {
                if should_skip_directory(
                    &entry.file_name().to_string_lossy(),
                    &relative_path,
                    options,
                ) {
                    continue;
                }
                queue.push_back(entry_path);
                continue;
            }
            if !entry_metadata.is_file() {
                continue;
            }
            progress_stats.visited_count += 1;
            files_since_last_progress_emit += 1;
            if matches!(
                scan_file(&root, &entry_path, &entry_metadata, options),
                ScanFileOutcome::Indexed(_) | ScanFileOutcome::Skipped(_)
            ) {
                progress_stats.total_count += 1;
            }
            maybe_report_count_progress(
                &mut progress_reporter,
                &mut last_progress_emit_at,
                &mut files_since_last_progress_emit,
                &progress_stats,
            )?;
        }
    }

    progress_reporter(progress_stats.clone())?;
    Ok(progress_stats.total_count)
}

fn maybe_report_count_progress(
    progress_reporter: &mut impl FnMut(CountProgressStats) -> Result<(), String>,
    last_progress_emit_at: &mut i64,
    files_since_last_progress_emit: &mut usize,
    progress_stats: &CountProgressStats,
) -> Result<(), String> {
    let now_ms = chrono::Utc::now().timestamp_millis();
    let reached_file_threshold =
        *files_since_last_progress_emit >= INDEX_PROGRESS_FLUSH_EVERY_FILES;
    let reached_time_threshold =
        now_ms.saturating_sub(*last_progress_emit_at) >= INDEX_PROGRESS_FLUSH_INTERVAL_MS;
    if !reached_file_threshold && !reached_time_threshold {
        return Ok(());
    }
    progress_reporter(progress_stats.clone())?;
    *last_progress_emit_at = now_ms;
    *files_since_last_progress_emit = 0;
    Ok(())
}

fn build_counting_index_progress(progress_stats: &CountProgressStats) -> IndexProgress {
    IndexProgress {
        scanned_count: progress_stats.visited_count,
        indexed_count: 0,
        skipped_count: 0,
        failed_count: 0,
        unchanged_count: 0,
        total_count: Some(progress_stats.total_count),
        max_concurrency: Some(resolve_native_index_worker_count()),
        active_task_count: 1,
        pending_task_count: 0,
        completed_task_count: progress_stats.visited_count,
    }
}

fn build_summary_backfill_progress(progress_stats: &SummaryBackfillProgressStats) -> IndexProgress {
    let completed_task_count = progress_stats.indexed_count
        + progress_stats.unchanged_count
        + progress_stats.skipped_count;
    IndexProgress {
        scanned_count: progress_stats.scanned_count,
        indexed_count: progress_stats.indexed_count,
        skipped_count: progress_stats.skipped_count,
        failed_count: 0,
        unchanged_count: progress_stats.unchanged_count,
        total_count: Some(progress_stats.total_count),
        max_concurrency: Some(1),
        active_task_count: usize::from(completed_task_count < progress_stats.total_count),
        pending_task_count: progress_stats.total_count.saturating_sub(completed_task_count),
        completed_task_count,
    }
}

fn maybe_report_summary_backfill_progress(
    root_dir: &str,
    last_requested_at: &str,
    last_started_at: &str,
    last_progress_emit_at: &mut i64,
    steps_since_last_progress_emit: &mut usize,
    progress_stats: &SummaryBackfillProgressStats,
) -> Result<(), String> {
    let now_ms = chrono::Utc::now().timestamp_millis();
    let reached_file_threshold =
        *steps_since_last_progress_emit >= INDEX_PROGRESS_FLUSH_EVERY_FILES;
    let reached_time_threshold =
        now_ms.saturating_sub(*last_progress_emit_at) >= INDEX_PROGRESS_FLUSH_INTERVAL_MS;
    if !reached_file_threshold && !reached_time_threshold {
        return Ok(());
    }
    write_summary_backfill_runtime_status(
        root_dir,
        last_requested_at,
        last_started_at,
        "running",
        Some(SUMMARY_BACKFILL_RUNNING_STAGE.to_string()),
        None,
        Some(build_summary_backfill_progress(progress_stats)),
        None,
        None,
        None,
    )?;
    *last_progress_emit_at = now_ms;
    *steps_since_last_progress_emit = 0;
    Ok(())
}

fn write_summary_backfill_runtime_status(
    root_dir: &str,
    last_requested_at: &str,
    last_started_at: &str,
    state: &str,
    running_stage: Option<String>,
    error_summary: Option<String>,
    progress: Option<IndexProgress>,
    last_completed_at: Option<String>,
    last_failed_at: Option<String>,
    next_allowed_at: Option<String>,
) -> Result<(), String> {
    write_runtime_status(
        root_dir,
        PersistedRuntimeStatus {
            state: state.to_string(),
            last_requested_at: Some(last_requested_at.to_string()),
            last_started_at: Some(last_started_at.to_string()),
            last_completed_at,
            last_failed_at,
            next_allowed_at,
            progress_updated_at: Some(iso_now()),
            running_stage,
            error_summary,
            progress,
        },
    )
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
        if !target_scope_matches_path(target_scope, &normalized)
            && !priority_hint_contains_target_scope(&normalized, target_scope)
        {
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

fn priority_hint_contains_target_scope(hint_path: &str, target_scope: &TargetScope) -> bool {
    match target_scope {
        TargetScope::All => true,
        TargetScope::Exact(value) | TargetScope::Prefix(value) => {
            value == hint_path || value.starts_with(&format!("{hint_path}/"))
        }
    }
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

struct NativeIndexWorkerPool {
    senders: Vec<Sender<NativeIndexTask>>,
    result_receiver: Receiver<NativeIndexTaskResult>,
    handles: Vec<thread::JoinHandle<()>>,
    next_worker_index: usize,
}

impl NativeIndexWorkerPool {
    fn start(worker_count: usize, previous_state: Option<PreviousNativeIndexState>) -> Self {
        let worker_count = worker_count.max(1);
        let (result_sender, result_receiver) = mpsc::channel::<NativeIndexTaskResult>();
        let previous_state = Arc::new(previous_state);
        let mut senders = Vec::with_capacity(worker_count);
        let mut handles = Vec::with_capacity(worker_count);

        for _ in 0..worker_count {
            let (task_sender, task_receiver) = mpsc::channel::<NativeIndexTask>();
            let worker_result_sender = result_sender.clone();
            let worker_previous_state = Arc::clone(&previous_state);
            let handle = thread::spawn(move || {
                while let Ok(task) = task_receiver.recv() {
                    match task {
                        NativeIndexTask::Index(file) => {
                            let document =
                                index_document(file, worker_previous_state.as_ref().as_ref());
                            let _ =
                                worker_result_sender.send(NativeIndexTaskResult::Indexed(document));
                        }
                        NativeIndexTask::Stop => break,
                    }
                }
            });
            senders.push(task_sender);
            handles.push(handle);
        }

        Self {
            senders,
            result_receiver,
            handles,
            next_worker_index: 0,
        }
    }

    fn send(&mut self, file: ScannedFile) -> Result<(), String> {
        if self.senders.is_empty() {
            return Err("native index worker 池未初始化".to_string());
        }
        let worker_index = self.next_worker_index % self.senders.len();
        self.next_worker_index = self.next_worker_index.wrapping_add(1);
        self.senders[worker_index]
            .send(NativeIndexTask::Index(file))
            .map_err(|error| format!("native index worker 发送任务失败: {error}"))
    }

    fn try_recv(&self) -> Result<Option<NativeIndexTaskResult>, String> {
        match self.result_receiver.try_recv() {
            Ok(result) => Ok(Some(result)),
            Err(mpsc::TryRecvError::Empty) => Ok(None),
            Err(mpsc::TryRecvError::Disconnected) => {
                Err("native index worker 结果通道已断开".to_string())
            }
        }
    }

    fn recv(&self) -> Result<NativeIndexTaskResult, String> {
        self.result_receiver
            .recv()
            .map_err(|error| format!("native index worker 接收结果失败: {error}"))
    }

    fn stop(&mut self) {
        for sender in &self.senders {
            let _ = sender.send(NativeIndexTask::Stop);
        }
        while let Some(handle) = self.handles.pop() {
            let _ = handle.join();
        }
    }
}

impl Drop for NativeIndexWorkerPool {
    fn drop(&mut self) {
        self.stop();
    }
}

fn drain_finished_index_tasks(
    worker_pool: &mut NativeIndexWorkerPool,
    documents: &mut Vec<ScannedDocument>,
    progress_stats: &mut ScanProgressStats,
    pending_index_tasks: &mut usize,
    root_dir: &str,
    target_scope: &TargetScope,
    partial_snapshot_flush: &mut PartialSnapshotFlushState,
) -> Result<(), String> {
    while let Some(result) = worker_pool.try_recv()? {
        apply_index_task_result(
            result,
            documents,
            progress_stats,
            pending_index_tasks,
            root_dir,
        )?;
        progress_stats.pending_index_task_count = *pending_index_tasks;
        maybe_flush_partial_export_snapshot(
            root_dir,
            documents,
            target_scope,
            partial_snapshot_flush,
        )?;
    }
    Ok(())
}

fn drain_index_tasks_until_below_limit(
    worker_pool: &mut NativeIndexWorkerPool,
    documents: &mut Vec<ScannedDocument>,
    progress_stats: &mut ScanProgressStats,
    pending_index_tasks: &mut usize,
    max_pending_index_tasks: usize,
    root_dir: &str,
    target_scope: &TargetScope,
    partial_snapshot_flush: &mut PartialSnapshotFlushState,
) -> Result<(), String> {
    while *pending_index_tasks >= max_pending_index_tasks {
        wait_for_one_index_task(
            worker_pool,
            documents,
            progress_stats,
            pending_index_tasks,
            root_dir,
            target_scope,
            partial_snapshot_flush,
        )?;
    }
    Ok(())
}

fn wait_for_one_index_task(
    worker_pool: &mut NativeIndexWorkerPool,
    documents: &mut Vec<ScannedDocument>,
    progress_stats: &mut ScanProgressStats,
    pending_index_tasks: &mut usize,
    root_dir: &str,
    target_scope: &TargetScope,
    partial_snapshot_flush: &mut PartialSnapshotFlushState,
) -> Result<(), String> {
    let result = worker_pool.recv()?;
    apply_index_task_result(
        result,
        documents,
        progress_stats,
        pending_index_tasks,
        root_dir,
    )?;
    progress_stats.pending_index_task_count = *pending_index_tasks;
    maybe_flush_partial_export_snapshot(root_dir, documents, target_scope, partial_snapshot_flush)?;
    Ok(())
}

fn apply_index_task_result(
    result: NativeIndexTaskResult,
    documents: &mut Vec<ScannedDocument>,
    progress_stats: &mut ScanProgressStats,
    pending_index_tasks: &mut usize,
    root_dir: &str,
) -> Result<(), String> {
    match result {
        NativeIndexTaskResult::Indexed(document) => {
            append_indexed_document_journal(root_dir, &document)?;
            progress_stats.indexed_count += 1;
            documents.push(document);
            progress_stats.indexed_count = documents
                .iter()
                .filter(|item| !item.reused_previous)
                .count();
            *pending_index_tasks = pending_index_tasks.saturating_sub(1);
        }
    }
    Ok(())
}

fn resolve_native_index_worker_count() -> usize {
    thread::available_parallelism()
        .map(|value| value.get())
        .unwrap_or(4)
        .clamp(1, NATIVE_INDEX_WORKER_MAX)
}

fn resolve_scan_base(root: &PathBuf, target_scope: &TargetScope) -> PathBuf {
    match target_scope {
        TargetScope::All => root.clone(),
        TargetScope::Exact(value) => root.join(value),
        TargetScope::Prefix(value) => root.join(value),
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
    if has_hidden_segment(&relative_path)
        && !is_included_hidden_path(&relative_path, &options.included_hidden_paths)
    {
        return ScanFileOutcome::Ignored;
    }
    let size = metadata.len();
    if let Some(max_file_size_bytes) = options.max_file_size_bytes {
        if max_file_size_bytes > 0 && size > max_file_size_bytes {
            return ScanFileOutcome::Ignored;
        }
    }
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
    let tags = previous_state
        .and_then(|state| state.documents.get(&file.relative_path))
        .map(|document| document.tags.clone())
        .unwrap_or_default();
    ScannedDocument {
        relative_path: file.relative_path,
        extension: file.extension,
        size: file.size,
        title,
        summary: String::new(),
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

fn append_indexed_document_journal(
    root_dir: &str,
    document: &ScannedDocument,
) -> Result<(), String> {
    if document.reused_previous {
        return Ok(());
    }
    let journal_path = indexed_document_journal_path(root_dir);
    if let Some(parent) = journal_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("创建索引恢复日志目录失败 {}: {error}", parent.display()))?;
    }
    let entry = RuntimeIndexedDocumentJournalEntry {
        active: runtime_active_state_from_document(document),
        document: snapshot_document_from_scanned(document),
    };
    let line = serde_json::to_string(&entry)
        .map_err(|error| format!("序列化索引恢复日志失败：{error}"))?;
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&journal_path)
        .map_err(|error| format!("打开索引恢复日志失败 {}: {error}", journal_path.display()))?;
    writeln!(file, "{line}")
        .map_err(|error| format!("写入索引恢复日志失败 {}: {error}", journal_path.display()))
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
) -> Result<String, String> {
    let generated_at = iso_now();
    let native_documents = documents
        .iter()
        .map(snapshot_document_from_scanned)
        .collect::<Vec<_>>();
    let previous_snapshot = read_existing_snapshot(root_dir).ok().flatten();
    let snapshot_documents =
        merge_snapshot_documents(native_documents, previous_snapshot, target_scope);
    let mut snapshot_tags = BTreeMap::<String, SnapshotTag>::new();
    for document in &snapshot_documents {
        for tag_path in document.tags.iter().chain(document.derived_tags.iter()) {
            register_tag_path(&mut snapshot_tags, tag_path);
        }
    }
    let snapshot = ExportCatalogSnapshot {
        version: 1,
        generated_at,
        tags: snapshot_tags.into_values().collect(),
        documents: snapshot_documents,
    };
    let snapshot_path = export_catalog_snapshot_path(root_dir);
    write_json_file(&snapshot_path, &snapshot)?;
    Ok(snapshot_path.to_string_lossy().to_string())
}

fn maybe_flush_partial_export_snapshot(
    root_dir: &str,
    documents: &[ScannedDocument],
    target_scope: &TargetScope,
    state: &mut PartialSnapshotFlushState,
) -> Result<(), String> {
    state.completed_since_flush = state.completed_since_flush.saturating_add(1);
    let now_ms = chrono::Utc::now().timestamp_millis();
    let reached_document_threshold =
        state.completed_since_flush >= INDEX_PARTIAL_SNAPSHOT_FLUSH_EVERY_DOCUMENTS;
    let reached_time_threshold =
        now_ms.saturating_sub(state.last_flushed_at) >= INDEX_PARTIAL_SNAPSHOT_FLUSH_INTERVAL_MS;
    if !reached_document_threshold && !reached_time_threshold {
        return Ok(());
    }
    flush_partial_export_snapshot(root_dir, documents, target_scope, false, state)
}

fn flush_partial_export_snapshot(
    root_dir: &str,
    documents: &[ScannedDocument],
    target_scope: &TargetScope,
    force: bool,
    state: &mut PartialSnapshotFlushState,
) -> Result<(), String> {
    if documents.is_empty() && !force {
        return Ok(());
    }
    write_partial_export_snapshot(root_dir, documents, target_scope)?;
    state.last_flushed_at = chrono::Utc::now().timestamp_millis();
    state.completed_since_flush = 0;
    Ok(())
}

fn write_partial_export_snapshot(
    root_dir: &str,
    documents: &[ScannedDocument],
    _target_scope: &TargetScope,
) -> Result<String, String> {
    let native_documents = documents
        .iter()
        .map(snapshot_document_from_scanned)
        .collect::<Vec<_>>();
    let previous_snapshot = read_existing_snapshot(root_dir).ok().flatten();
    let snapshot_documents = merge_partial_snapshot_documents(native_documents, previous_snapshot);
    let mut snapshot_tags = BTreeMap::<String, SnapshotTag>::new();
    for document in &snapshot_documents {
        for tag_path in document.tags.iter().chain(document.derived_tags.iter()) {
            register_tag_path(&mut snapshot_tags, tag_path);
        }
    }
    let snapshot = ExportCatalogSnapshot {
        version: 1,
        generated_at: iso_now(),
        tags: snapshot_tags.into_values().collect(),
        documents: snapshot_documents,
    };
    let snapshot_path = export_catalog_snapshot_path(root_dir);
    write_json_file(&snapshot_path, &snapshot)?;
    Ok(snapshot_path.to_string_lossy().to_string())
}

fn read_existing_snapshot(root_dir: &str) -> Result<Option<ExportCatalogSnapshot>, String> {
    let snapshot_path = export_catalog_snapshot_path(root_dir);
    if !snapshot_path.is_file() {
        return Ok(None);
    }
    read_json_file(&snapshot_path).map(Some)
}

fn write_existing_snapshot(root_dir: &str, snapshot: &ExportCatalogSnapshot) -> Result<(), String> {
    write_json_file(&export_catalog_snapshot_path(root_dir), snapshot)
}

fn load_summary_backfill_state(root_dir: &str) -> BTreeMap<String, RuntimeIndexedDocumentState> {
    read_optional_json_file::<RuntimeSummaryBackfillStateSnapshot>(&summary_backfill_state_path(
        root_dir,
    ))
    .ok()
    .flatten()
    .map(|snapshot| {
        snapshot
            .files
            .into_iter()
            .map(|item| (item.path.clone(), item))
            .collect::<BTreeMap<_, _>>()
    })
    .unwrap_or_default()
}

fn write_summary_backfill_state(
    root_dir: &str,
    completed: &BTreeMap<String, RuntimeIndexedDocumentState>,
) -> Result<(), String> {
    let snapshot = RuntimeSummaryBackfillStateSnapshot {
        version: 1,
        generated_at: iso_now(),
        files: completed.values().cloned().collect(),
    };
    write_json_file(&summary_backfill_state_path(root_dir), &snapshot)
}

fn runtime_indexed_state_matches(
    left: &RuntimeIndexedDocumentState,
    right: &RuntimeIndexedDocumentState,
) -> bool {
    left.path == right.path
        && left.extension == right.extension
        && left.size == right.size
        && left.mtime == right.mtime
        && left.index_status == right.index_status
}

fn merge_snapshot_documents(
    native_documents: Vec<SnapshotDocument>,
    previous_snapshot: Option<ExportCatalogSnapshot>,
    target_scope: &TargetScope,
) -> Vec<SnapshotDocument> {
    let mut merged = BTreeMap::<String, SnapshotDocument>::new();
    if let Some(previous_snapshot) = previous_snapshot {
        for document in previous_snapshot.documents {
            let extension = document_extension(&document.path);
            if is_native_summary_extension(&extension)
                && target_scope_matches_path(target_scope, &document.path)
            {
                continue;
            }
            merged.insert(document.path.clone(), document);
        }
    }
    for document in native_documents {
        merged.insert(document.path.clone(), document);
    }
    merged.into_values().collect()
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

fn write_runtime_mirror_snapshots(
    root_dir: &str,
    scanned: &ScanDocumentsResult,
    target_scope: &TargetScope,
) -> Result<(), String> {
    let active_file_path = active_file_state_snapshot_path(root_dir);
    let index_state_path = index_state_snapshot_path(root_dir);
    let previous_active = read_optional_json_file::<RuntimeActiveFileStateSnapshot>(
        &active_file_path,
    )?
    .unwrap_or(RuntimeActiveFileStateSnapshot {
        version: 1,
        generated_at: iso_now(),
        files: Vec::new(),
    });
    let previous_index = read_optional_json_file::<RuntimeIndexStateSnapshot>(&index_state_path)?
        .unwrap_or(RuntimeIndexStateSnapshot {
            version: 1,
            generated_at: iso_now(),
            failed_documents: Vec::new(),
            skipped_documents: Vec::new(),
            parser_skips: Vec::new(),
        });
    let mut active_files = BTreeMap::<String, RuntimeIndexedDocumentState>::new();
    for item in previous_active.files {
        active_files.insert(item.path.clone(), item);
    }
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

fn load_previous_native_index_state(root_dir: &str) -> Option<PreviousNativeIndexState> {
    let active_snapshot = read_optional_json_file::<RuntimeActiveFileStateSnapshot>(
        &active_file_state_snapshot_path(root_dir),
    )
    .ok()
    .flatten();
    let export_snapshot = read_existing_snapshot(root_dir).ok().flatten();
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
                .into_iter()
                .map(|item| (item.path.clone(), item))
                .collect::<BTreeMap<_, _>>()
        })
        .unwrap_or_default();
    merge_indexed_document_journal(root_dir, &mut active_files, &mut documents);
    hydrate_missing_active_files_from_documents(root_dir, &documents, &mut active_files);
    if active_files.is_empty() || documents.is_empty() {
        return None;
    }
    Some(PreviousNativeIndexState {
        active_files,
        documents,
    })
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
        ".pdf" => read_pdf_summary(&file.full_path),
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
        ".md" | ".markdown" | ".mdx" | ".txt" | ".rtf" | ".html" | ".htm" | ".xml" | ".json"
        | ".yaml" | ".yml" | ".tsv" => read_text_summary(&file.full_path),
        _ => String::new(),
    }
}

fn read_text_summary(path: &PathBuf) -> String {
    let Ok(raw) = read_text_prefix(path, SUMMARY_TEXT_MAX_BYTES) else {
        return String::new();
    };
    short_summary(&raw, 180)
}

fn normalize_parser_extension(extension: &str) -> String {
    let normalized = extension.trim().to_lowercase();
    if normalized.starts_with('.') {
        normalized
    } else {
        format!(".{normalized}")
    }
}

fn default_parser_title(path: &PathBuf, extension: &str) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.trim_end_matches(extension).to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "untitled".to_string())
}

fn build_docx_parse_payload(path: &PathBuf, extension: &str) -> Result<Value, String> {
    let entries = read_zip_text_entries(path, &["word/document.xml"])
        .map_err(|error| format!("DOCX 解析失败 {}: {error}", path.display()))?;
    let document_xml = entries
        .get("word/document.xml")
        .ok_or_else(|| format!("DOCX 缺少 word/document.xml: {}", path.display()))?;
    let core_xml = entries.get("docProps/core.xml").cloned();
    let mut blocks = Vec::new();
    let mut heading_count = 0usize;
    for paragraph in parse_docx_paragraph_blocks(document_xml) {
        if paragraph.kind == "heading" {
            heading_count += 1;
        }
        blocks.push(json!({
            "kind": paragraph.kind,
            "text": paragraph.text,
            "metadata": paragraph.metadata,
        }));
    }
    if blocks.is_empty() {
        return Err(format!("DOCX 中没有可读取内容：{}", path.display()));
    }
    let text = blocks
        .iter()
        .filter_map(|block| block.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n\n")
        .trim()
        .to_string();
    if text.is_empty() {
        return Err(format!("DOCX 文本内容为空：{}", path.display()));
    }
    let title = parse_docx_core_title(core_xml.as_deref())
        .or_else(|| {
            blocks
                .iter()
                .find(|block| block.get("kind").and_then(Value::as_str) == Some("heading"))
                .and_then(|block| block.get("text").and_then(Value::as_str))
                .map(ToString::to_string)
        })
        .unwrap_or_else(|| default_parser_title(path, extension));
    Ok(json!({
        "title": title,
        "text": text,
        "summary": short_summary(&text, 180),
        "parser": "docx",
        "metadata": {
            "adapter": "native_complex_parser",
            "paragraphCount": blocks.len(),
            "headingCount": heading_count,
        },
        "structured": {
            "blocks": blocks,
            "stats": {
                "paragraphCount": blocks.len(),
                "headingCount": heading_count,
            }
        }
    }))
}

fn build_pptx_parse_payload(path: &PathBuf, extension: &str) -> Result<Value, String> {
    let entries = read_zip_text_entries(path, &[])
        .map_err(|error| format!("PPTX 解析失败 {}: {error}", path.display()))?;
    let presentation_xml = entries
        .get("ppt/presentation.xml")
        .ok_or_else(|| format!("PPTX 缺少 presentation.xml: {}", path.display()))?;
    let relationship_xml = entries
        .get("ppt/_rels/presentation.xml.rels")
        .ok_or_else(|| format!("PPTX 缺少 presentation.xml.rels: {}", path.display()))?;
    let slide_paths = parse_pptx_slide_paths(presentation_xml, relationship_xml);
    if slide_paths.is_empty() {
        return Err(format!("PPTX 中未发现 slide：{}", path.display()));
    }
    let mut blocks = Vec::new();
    for (index, slide_path) in slide_paths.iter().enumerate() {
        let Some(slide_xml) = entries.get(slide_path) else {
            continue;
        };
        let text = extract_xml_texts(slide_xml, "a:t")
            .join("\n")
            .trim()
            .to_string();
        if text.is_empty() {
            continue;
        }
        blocks.push(json!({
            "kind": "slide",
            "slideIndex": index + 1,
            "text": text,
            "metadata": {
                "slideIndex": index + 1,
            }
        }));
    }
    if blocks.is_empty() {
        return Err(format!("PPTX 中没有可读取 slide 文本：{}", path.display()));
    }
    let text = blocks
        .iter()
        .map(|block| {
            let slide_index = block
                .get("slideIndex")
                .and_then(Value::as_u64)
                .unwrap_or_default();
            let slide_text = block
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or_default();
            format!("Slide {slide_index}\n{slide_text}")
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    Ok(json!({
        "title": default_parser_title(path, extension),
        "text": text,
        "summary": short_summary(&text, 180),
        "parser": "pptx",
        "metadata": {
            "adapter": "native_complex_parser",
            "slideCount": slide_paths.len(),
            "extractedSlideCount": blocks.len(),
        },
        "structured": {
            "blocks": blocks,
            "stats": {
                "slideCount": slide_paths.len(),
                "extractedSlideCount": blocks.len(),
            }
        }
    }))
}

fn build_xlsx_parse_payload(path: &PathBuf, extension: &str) -> Result<Value, String> {
    let entries = read_zip_text_entries(path, &[])
        .map_err(|error| format!("XLSX 解析失败 {}: {error}", path.display()))?;
    let workbook_xml = entries
        .get("xl/workbook.xml")
        .ok_or_else(|| format!("XLSX 缺少 workbook.xml: {}", path.display()))?;
    let relationship_xml = entries
        .get("xl/_rels/workbook.xml.rels")
        .ok_or_else(|| format!("XLSX 缺少 workbook.xml.rels: {}", path.display()))?;
    let shared_strings = entries
        .get("xl/sharedStrings.xml")
        .map(|xml| parse_xlsx_shared_strings(xml))
        .unwrap_or_default();
    let workbook_sheets = parse_xlsx_workbook_sheets(workbook_xml, relationship_xml);
    if workbook_sheets.is_empty() {
        return Err(format!("XLSX 中未发现 sheet：{}", path.display()));
    }
    let mut blocks = Vec::new();
    let mut total_rows = 0usize;
    let mut max_column_count = 0usize;
    let mut text_chunks = Vec::new();
    let mut parsed_sheet_count = 0usize;
    for (sheet_name, target) in workbook_sheets {
        let Some(worksheet_xml) = entries.get(&target) else {
            continue;
        };
        let rows = parse_xlsx_rows(worksheet_xml, &shared_strings);
        if rows.is_empty() {
            continue;
        }
        parsed_sheet_count += 1;
        let row_count = rows.len();
        let column_count = rows.iter().map(|row| row.len()).max().unwrap_or(0);
        total_rows += row_count;
        max_column_count = max_column_count.max(column_count);
        let sheet_text = rows
            .iter()
            .map(|row| {
                row.iter()
                    .filter(|cell| !cell.is_empty())
                    .cloned()
                    .collect::<Vec<_>>()
                    .join(" ")
            })
            .filter(|line| !line.is_empty())
            .collect::<Vec<_>>()
            .join("\n");
        if !sheet_text.is_empty() {
            text_chunks.push(format!("{sheet_name}\n{sheet_text}"));
        }
        blocks.push(json!({
            "kind": "sheet",
            "sheetName": sheet_name,
            "text": sheet_text,
            "metadata": {
                "rowCount": row_count,
                "columnCount": column_count,
            }
        }));
        blocks.push(json!({
            "kind": "table",
            "sheetName": sheet_name,
            "cells": rows,
            "metadata": {
                "rowCount": row_count,
                "columnCount": column_count,
            }
        }));
    }
    if text_chunks.is_empty() {
        return Err(format!("XLSX 中没有可读取 sheet 内容：{}", path.display()));
    }
    let text = text_chunks.join("\n\n");
    Ok(json!({
        "title": default_parser_title(path, extension),
        "text": text,
        "summary": short_summary(&text, 180),
        "parser": "xlsx",
        "metadata": {
            "adapter": "native_complex_parser",
            "sheetCount": parsed_sheet_count,
            "rowCount": total_rows,
            "columnCount": max_column_count,
        },
        "structured": {
            "blocks": blocks,
            "stats": {
                "sheetCount": parsed_sheet_count,
                "rowCount": total_rows,
                "columnCount": max_column_count,
            }
        }
    }))
}

fn build_pdf_parse_payload(path: &PathBuf, extension: &str) -> Result<Value, String> {
    let raw =
        fs::read(path).map_err(|error| format!("PDF 文件读取失败 {}: {error}", path.display()))?;
    let pdf_text = raw.iter().map(|byte| *byte as char).collect::<String>();
    if !pdf_text.starts_with("%PDF-") {
        return Err(format!("PDF 文件头非法：{}", path.display()));
    }
    let objects = extract_pdf_objects(&pdf_text);
    if objects.is_empty() {
        return Err(format!("PDF 中未发现可读取对象：{}", path.display()));
    }
    let pages = parse_pdf_page_records(&objects);
    if pages.is_empty() {
        return Err(format!("PDF 中未发现页面对象：{}", path.display()));
    }
    let mut blocks = Vec::new();
    for (page_index, page) in pages.iter().enumerate() {
        let page_text = extract_pdf_page_text(page, &objects);
        if page_text.is_empty() {
            continue;
        }
        blocks.push(json!({
            "kind": "page",
            "page": page_index + 1,
            "text": page_text,
            "metadata": {
                "pageNumber": page_index + 1,
            }
        }));
    }
    if blocks.is_empty() {
        return Err(format!("PDF 中没有可提取文本：{}", path.display()));
    }
    let text = blocks
        .iter()
        .filter_map(|block| block.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n\n");
    Ok(json!({
        "title": default_parser_title(path, extension),
        "text": text,
        "summary": short_summary(&text, 180),
        "parser": "pdf",
        "metadata": {
            "adapter": "native_complex_parser",
            "pageCount": pages.len(),
            "extractedPageCount": blocks.len(),
        },
        "structured": {
            "blocks": blocks,
            "stats": {
                "pageCount": pages.len(),
                "extractedPageCount": blocks.len(),
            }
        }
    }))
}

#[derive(Debug, Clone)]
struct NativeDocxParagraphBlock {
    kind: String,
    text: String,
    metadata: Option<Value>,
}

fn parse_docx_paragraph_blocks(document_xml: &str) -> Vec<NativeDocxParagraphBlock> {
    let paragraph_pattern = Regex::new(r"(?s)<w:p\b[^>]*>.*?</w:p>").unwrap();
    let text_pattern = Regex::new(r"(?s)<w:t\b[^>]*>(.*?)</w:t>").unwrap();
    let tab_pattern = Regex::new(r"<w:tab\b[^>]*/>").unwrap();
    let break_pattern = Regex::new(r"<w:br\b[^>]*/>").unwrap();
    let style_pattern = Regex::new(r#"<w:pStyle\b([^>]*)/>"#).unwrap();
    let mut blocks = Vec::new();
    for paragraph_match in paragraph_pattern.find_iter(document_xml) {
        let paragraph_xml = paragraph_match.as_str();
        let mut parts = Vec::new();
        for capture in text_pattern.captures_iter(paragraph_xml) {
            let text = capture.get(1).map(|item| item.as_str()).unwrap_or_default();
            parts.push(decode_xml_entities(text.to_string()));
        }
        for _ in tab_pattern.find_iter(paragraph_xml) {
            parts.push("\t".to_string());
        }
        for _ in break_pattern.find_iter(paragraph_xml) {
            parts.push("\n".to_string());
        }
        let text = parts
            .join("")
            .replace(" \n", "\n")
            .replace("\n ", "\n")
            .trim()
            .to_string();
        if text.is_empty() {
            continue;
        }
        let style = style_pattern
            .captures(paragraph_xml)
            .and_then(|captures| captures.get(1))
            .and_then(|matched| extract_xml_attr(matched.as_str(), "w:val"));
        let is_heading = style
            .as_deref()
            .map(|value| value.to_lowercase().starts_with("heading"))
            .unwrap_or(false);
        blocks.push(NativeDocxParagraphBlock {
            kind: if is_heading { "heading" } else { "paragraph" }.to_string(),
            text,
            metadata: style.map(|style_value| json!({ "style": style_value })),
        });
    }
    blocks
}

fn parse_docx_core_title(core_xml: Option<&str>) -> Option<String> {
    let xml = core_xml?;
    let title_pattern = Regex::new(r"(?s)<dc:title\b[^>]*>(.*?)</dc:title>").unwrap();
    let matched = title_pattern.captures(xml)?.get(1)?.as_str();
    let value = decode_xml_entities(strip_xml_tags(matched).to_string())
        .trim()
        .to_string();
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

fn parse_pptx_slide_paths(presentation_xml: &str, relationship_xml: &str) -> Vec<String> {
    let relationship_pattern = Regex::new(r#"<Relationship\b([^>]*)/>"#).unwrap();
    let slide_pattern = Regex::new(r#"<p:sldId\b([^>]*)/>"#).unwrap();
    let mut relations = BTreeMap::new();
    for captures in relationship_pattern.captures_iter(relationship_xml) {
        let attributes = captures
            .get(1)
            .map(|value| value.as_str())
            .unwrap_or_default();
        let relation_id = extract_xml_attr(attributes, "Id");
        let target = extract_xml_attr(attributes, "Target");
        if let (Some(relation_id), Some(target)) = (relation_id, target) {
            let normalized = Path::new("ppt")
                .join(target)
                .to_string_lossy()
                .replace('\\', "/");
            relations.insert(relation_id, normalized);
        }
    }
    let mut slide_paths = Vec::new();
    for captures in slide_pattern.captures_iter(presentation_xml) {
        let attributes = captures
            .get(1)
            .map(|value| value.as_str())
            .unwrap_or_default();
        let Some(relation_id) = extract_xml_attr(attributes, "r:id") else {
            continue;
        };
        if let Some(target) = relations.get(&relation_id) {
            slide_paths.push(target.clone());
        }
    }
    slide_paths
}

fn parse_xlsx_workbook_sheets(workbook_xml: &str, relationship_xml: &str) -> Vec<(String, String)> {
    let relationship_pattern = Regex::new(r#"<Relationship\b([^>]*)/>"#).unwrap();
    let sheet_pattern = Regex::new(r#"<sheet\b([^>]*)/>"#).unwrap();
    let mut relations = BTreeMap::new();
    for captures in relationship_pattern.captures_iter(relationship_xml) {
        let attributes = captures
            .get(1)
            .map(|value| value.as_str())
            .unwrap_or_default();
        let relation_id = extract_xml_attr(attributes, "Id");
        let target = extract_xml_attr(attributes, "Target");
        if let (Some(relation_id), Some(target)) = (relation_id, target) {
            let normalized = Path::new("xl")
                .join(target)
                .to_string_lossy()
                .replace('\\', "/");
            relations.insert(relation_id, normalized);
        }
    }
    let mut sheets = Vec::new();
    for captures in sheet_pattern.captures_iter(workbook_xml) {
        let attributes = captures
            .get(1)
            .map(|value| value.as_str())
            .unwrap_or_default();
        let relation_id = extract_xml_attr(attributes, "r:id");
        let sheet_name = extract_xml_attr(attributes, "name");
        if let (Some(relation_id), Some(sheet_name)) = (relation_id, sheet_name) {
            if let Some(target) = relations.get(&relation_id) {
                sheets.push((sheet_name, target.clone()));
            }
        }
    }
    sheets
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
    short_summary(&lines.join("\n"), 180)
}

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
    let Ok(entries) = read_zip_text_entries_for_summary(path, &["word/document.xml"], |name| {
        name == "word/document.xml"
    }) else {
        return String::new();
    };
    let Some(document_xml) = entries.get("word/document.xml") else {
        return String::new();
    };
    let texts = extract_xml_texts(document_xml, "w:t");
    short_summary(&texts.join("\n"), 180)
}

fn read_pptx_summary(path: &PathBuf) -> String {
    let Ok(entries) = read_zip_text_entries_for_summary(path, &[], |name| {
        name.starts_with("ppt/slides/slide") && name.ends_with(".xml")
    }) else {
        return String::new();
    };
    let mut slide_names = entries
        .keys()
        .filter(|name| name.starts_with("ppt/slides/slide") && name.ends_with(".xml"))
        .cloned()
        .collect::<Vec<_>>();
    slide_names.sort();
    let mut chunks = Vec::new();
    for slide_name in slide_names.into_iter().take(SUMMARY_PPTX_MAX_SLIDES) {
        if let Some(slide_xml) = entries.get(&slide_name) {
            let texts = extract_xml_texts(slide_xml, "a:t");
            if !texts.is_empty() {
                chunks.push(texts.join("\n"));
            }
        }
    }
    short_summary(&chunks.join("\n\n"), 180)
}

fn read_odf_summary(path: &PathBuf, content_entry: &str, text_tags: &[&str]) -> String {
    let Ok(entries) =
        read_zip_text_entries_for_summary(path, &[content_entry], |name| name == content_entry)
    else {
        return String::new();
    };
    let Some(content_xml) = entries.get(content_entry) else {
        return String::new();
    };
    let mut chunks = Vec::new();
    for tag in text_tags {
        chunks.extend(extract_xml_texts(content_xml, tag));
    }
    short_summary(&chunks.join("\n"), 180)
}

fn read_xlsx_summary(path: &PathBuf) -> String {
    let Ok(entries) = read_zip_text_entries_for_summary(path, &[], |name| {
        name == "xl/sharedStrings.xml"
            || (name.starts_with("xl/worksheets/sheet") && name.ends_with(".xml"))
    }) else {
        return String::new();
    };
    let shared_strings = entries
        .get("xl/sharedStrings.xml")
        .map(|xml| parse_xlsx_shared_strings(xml.as_str()))
        .unwrap_or_default();
    let mut worksheet_names = entries
        .keys()
        .filter(|name| name.starts_with("xl/worksheets/sheet") && name.ends_with(".xml"))
        .cloned()
        .collect::<Vec<_>>();
    worksheet_names.sort();
    let mut chunks = Vec::new();
    for worksheet_name in worksheet_names.into_iter().take(SUMMARY_XLSX_MAX_SHEETS) {
        if let Some(worksheet_xml) = entries.get(&worksheet_name) {
            let rows = parse_xlsx_rows(worksheet_xml, &shared_strings);
            for row in rows.into_iter().take(SUMMARY_XLSX_MAX_ROWS_PER_SHEET) {
                let normalized = row
                    .into_iter()
                    .filter(|cell| !cell.is_empty())
                    .collect::<Vec<_>>()
                    .join(" ");
                if !normalized.is_empty() {
                    chunks.push(normalized);
                }
            }
        }
    }
    short_summary(&chunks.join("\n"), 180)
}

fn read_text_prefix(path: &PathBuf, max_bytes: usize) -> Result<String, String> {
    let raw = read_binary_prefix(path, max_bytes)?;
    Ok(String::from_utf8_lossy(&raw).replace('\u{feff}', ""))
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
    required_entries: &[&str],
    should_include: impl Fn(&str) -> bool,
) -> Result<BTreeMap<String, String>, String> {
    let file = fs::File::open(path)
        .map_err(|error| format!("读取 zip 文件失败 {}: {error}", path.display()))?;
    let mut archive = ZipArchive::new(file)
        .map_err(|error| format!("解析 zip 容器失败 {}: {error}", path.display()))?;
    let mut entries = BTreeMap::new();
    for index in 0..archive.len() {
        if entries.len() >= SUMMARY_ARCHIVE_MAX_ENTRIES {
            break;
        }
        let mut file = archive
            .by_index(index)
            .map_err(|error| format!("读取 zip 条目失败 {}: {error}", path.display()))?;
        let name = file.name().to_string();
        if !should_include(&name) {
            continue;
        }
        let mut content = String::new();
        if file
            .by_ref()
            .take(SUMMARY_ARCHIVE_ENTRY_MAX_BYTES as u64)
            .read_to_string(&mut content)
            .is_ok()
        {
            entries.insert(name, content);
        }
    }
    if required_entries
        .iter()
        .any(|entry| !entries.contains_key(*entry))
    {
        return Err(format!("zip 缺少必需 xml 条目 {}", path.display()));
    }
    Ok(entries)
}

fn read_zip_text_entries(
    path: &PathBuf,
    required_entries: &[&str],
) -> Result<BTreeMap<String, String>, String> {
    let file = fs::File::open(path)
        .map_err(|error| format!("读取 zip 文件失败 {}: {error}", path.display()))?;
    let mut archive = ZipArchive::new(file)
        .map_err(|error| format!("解析 zip 容器失败 {}: {error}", path.display()))?;
    let mut entries = BTreeMap::new();
    for index in 0..archive.len() {
        let mut file = archive
            .by_index(index)
            .map_err(|error| format!("读取 zip 条目失败 {}: {error}", path.display()))?;
        if !(file.name().ends_with(".xml") || file.name().ends_with(".xml.rels")) {
            continue;
        }
        let mut content = String::new();
        if file.read_to_string(&mut content).is_ok() {
            entries.insert(file.name().to_string(), content);
        }
    }
    if required_entries
        .iter()
        .any(|entry| !entries.contains_key(*entry))
    {
        return Err(format!("zip 缺少必需 xml 条目 {}", path.display()));
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
        let Some(end_rel) = xml[content_start..].find(&close_tag) else {
            break;
        };
        let end_index = content_start + end_rel;
        let content = decode_xml_entities(strip_xml_tags(&xml[content_start..end_index]));
        let normalized = content.trim();
        if !normalized.is_empty() {
            result.push(normalized.to_string());
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
    let normalized = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.len() <= limit {
        normalized
    } else {
        format!(
            "{}…",
            normalized
                .chars()
                .take(limit.saturating_sub(1))
                .collect::<String>()
        )
    }
}

fn read_max_file_size_bytes(root_dir: &str, config_relative_path: &str) -> Option<u64> {
    let trimmed = config_relative_path.trim().trim_start_matches('/');
    if trimmed.is_empty() || trimmed.contains("..") {
        return None;
    }
    let config_path = PathBuf::from(root_dir).join(trimmed);
    let raw = fs::read_to_string(config_path).ok()?;
    let config = serde_json::from_str::<NativeConfigFile>(&raw).ok()?;
    config.max_file_size_bytes
}

fn should_skip_directory(name: &str, relative_path: &str, options: &NativeIndexOptions) -> bool {
    if ignored_directory_names().contains(name) {
        return true;
    }
    if !name.starts_with('.') {
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
        if normalized.is_empty() || normalized.contains("..") || !has_hidden_segment(&normalized) {
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

fn normalize_relative_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn resolve_target_scope(root_dir: &str, target_path: Option<&str>) -> Result<TargetScope, String> {
    let Some(raw_target_path) = target_path.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(TargetScope::All);
    };
    let raw_target = Path::new(raw_target_path);
    if raw_target.is_absolute()
        || raw_target
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err("targetPath 超出文档库根目录，原生索引已拒绝执行".to_string());
    }
    let root = PathBuf::from(root_dir)
        .canonicalize()
        .map_err(|error| format!("解析文档库根目录失败 {}: {error}", root_dir))?;
    let candidate = root.join(raw_target_path);
    let normalized_target = normalize_relative_path(Path::new(raw_target_path))
        .trim_end_matches('/')
        .to_string();
    if candidate.exists() {
        let canonical = candidate
            .canonicalize()
            .map_err(|error| format!("解析目标路径失败 {}: {error}", candidate.display()))?;
        if !canonical.starts_with(&root) {
            return Err("targetPath 超出文档库根目录，原生索引已拒绝执行".to_string());
        }
        let relative = normalize_relative_path(
            canonical
                .strip_prefix(&root)
                .map_err(|_| "targetPath 超出文档库根目录，原生索引已拒绝执行".to_string())?,
        );
        if relative.is_empty() || relative == "." {
            return Ok(TargetScope::All);
        }
        if canonical.is_file() {
            return Ok(TargetScope::Exact(relative));
        }
        return Ok(TargetScope::Prefix(relative));
    }
    if normalized_target.is_empty() || normalized_target == "." {
        return Ok(TargetScope::All);
    }
    if Path::new(&normalized_target).extension().is_some() {
        return Ok(TargetScope::Exact(normalized_target));
    }
    Ok(TargetScope::Prefix(normalized_target))
}

fn target_scope_matches_path(target_scope: &TargetScope, document_path: &str) -> bool {
    match target_scope {
        TargetScope::All => true,
        TargetScope::Exact(value) => document_path == value,
        TargetScope::Prefix(value) => {
            document_path == value || document_path.starts_with(&format!("{value}/"))
        }
    }
}

fn collect_deleted_paths(
    root_dir: &str,
    target_scope: &TargetScope,
    seen_paths: &HashSet<String>,
) -> Vec<String> {
    let Some(previous_snapshot) = read_existing_snapshot(root_dir).ok().flatten() else {
        return vec![];
    };
    previous_snapshot
        .documents
        .into_iter()
        .filter(|document| {
            is_native_summary_extension(&document_extension(&document.path))
                && target_scope_matches_path(target_scope, &document.path)
                && !seen_paths.contains(&document.path)
        })
        .map(|document| document.path)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn build_dirty_scope(
    documents: &[ScannedDocument],
    deleted_paths: &[String],
    target_scope: &TargetScope,
) -> DirtyScope {
    if matches!(target_scope, TargetScope::All) {
        return DirtyScope {
            trigger: "full".to_string(),
            changed_paths: vec![],
            deleted_paths: vec![],
            dirty_directories: vec![],
            dirty_tag_paths: vec![],
            dirty_meta_shards: vec![],
            dirty_detail_shards: vec![],
            dirty_posting_buckets: vec![],
            dirty_relations: vec![],
        };
    }
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
            ".ai-index",
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

fn write_json_file<T>(path: &PathBuf, value: &T) -> Result<(), String>
where
    T: Serialize,
{
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("创建目录失败 {}: {error}", parent.display()))?;
    }
    let mut buffer = serde_json::to_vec_pretty(value)
        .map_err(|error| format!("序列化 JSON 失败 {}: {error}", path.display()))?;
    buffer.push(b'\n');
    fs::write(path, buffer).map_err(|error| format!("写入文件失败 {}: {error}", path.display()))
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
        append_indexed_document_journal, can_native_index_lightweight_set,
        is_native_default_route_extension, is_native_skip_only_extension,
        is_native_summary_extension, load_previous_native_index_state,
        merge_partial_snapshot_documents, promote_directory_to_queue_front, read_text_summary,
        read_xlsx_summary, resolve_reusable_previous_document, run_native_index_worker,
        run_native_parser, run_native_summary_backfill_worker, write_runtime_mirror_snapshots,
        ExportCatalogSnapshot, NativeIndexRequest, NativeParserRequest, ScanDocumentsResult,
        ScannedDocument, ScannedFile, SnapshotDocument, TargetScope, SUMMARY_TEXT_MAX_BYTES,
        SUMMARY_XLSX_MAX_SHEETS,
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
    fn default_desktop_extensions_can_stay_on_native_route() {
        let extensions = vec![
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
        ];

        assert!(can_native_index_lightweight_set(&extensions));
    }

    #[test]
    fn empty_allowed_extensions_means_default_supported_set_can_stay_on_native_route() {
        assert!(can_native_index_lightweight_set(&[]));
    }

    #[test]
    fn legacy_binary_office_extensions_are_skip_only_not_summary() {
        for extension in [".doc", ".wps", ".xls", ".et", ".numbers", ".ppt", ".key"] {
            assert!(is_native_default_route_extension(extension));
            assert!(is_native_skip_only_extension(extension));
            assert!(!is_native_summary_extension(extension));
        }
    }

    #[test]
    fn opendocument_extensions_are_native_summary_extensions() {
        for extension in [".odt", ".ods", ".odp"] {
            assert!(is_native_default_route_extension(extension));
            assert!(is_native_summary_extension(extension));
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
            config_relative_path: ".ai-index/doc-semantic-index.config.json".to_string(),
            reason: "native_test".to_string(),
            target_path: None,
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
            config_relative_path: ".ai-index/doc-semantic-index.config.json".to_string(),
            reason: "native_test".to_string(),
            target_path: None,
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
    fn index_only_只写入文件属性不读取正文摘要() {
        let root_dir = make_temp_dir("x-file-native-index-metadata-only");
        fs::create_dir_all(root_dir.join(".ai-index")).unwrap();
        fs::write(root_dir.join("a.md"), "# A\n\n正文摘要不应在首轮出现").unwrap();

        run_native_index_worker(NativeIndexRequest {
            root_dir: root_dir.to_string_lossy().to_string(),
            allowed_extensions: vec![".md".to_string()],
            included_hidden_paths: vec![],
            config_relative_path: ".ai-index/doc-semantic-index.config.json".to_string(),
            reason: "native_test".to_string(),
            target_path: None,
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
        assert_eq!(document.get("summary").and_then(Value::as_str), Some(""));
    }

    #[test]
    fn summary_backfill_后台补齐摘要并记录断点状态() {
        let root_dir = make_temp_dir("x-file-native-summary-backfill");
        fs::create_dir_all(root_dir.join(".ai-index")).unwrap();
        fs::write(root_dir.join("a.md"), "# A\n\n后台摘要内容").unwrap();

        run_native_index_worker(NativeIndexRequest {
            root_dir: root_dir.to_string_lossy().to_string(),
            allowed_extensions: vec![".md".to_string()],
            included_hidden_paths: vec![],
            config_relative_path: ".ai-index/doc-semantic-index.config.json".to_string(),
            reason: "native_test".to_string(),
            target_path: None,
        })
        .unwrap();
        let result = run_native_summary_backfill_worker(NativeIndexRequest {
            root_dir: root_dir.to_string_lossy().to_string(),
            allowed_extensions: vec![".md".to_string()],
            included_hidden_paths: vec![],
            config_relative_path: ".ai-index/doc-semantic-index.config.json".to_string(),
            reason: "native_test".to_string(),
            target_path: None,
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
        let state_path = root_dir.join(".ai-index/runtime/summary-backfill-state.json");
        let state: Value = serde_json::from_str(&fs::read_to_string(state_path).unwrap()).unwrap();
        fs::remove_dir_all(&root_dir).ok();

        assert!(document
            .get("summary")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .contains("后台摘要内容"));
        assert_eq!(
            state.get("files").and_then(Value::as_array).map(Vec::len),
            Some(1)
        );
        assert_eq!(
            result
                .get("changedPaths")
                .and_then(Value::as_array)
                .map(Vec::len),
            Some(1)
        );
    }

    #[test]
    fn summary_backfill_完成后会写入可见进度状态() {
        let root_dir = make_temp_dir("x-file-native-summary-backfill-status");
        fs::create_dir_all(root_dir.join(".ai-index")).unwrap();
        fs::write(root_dir.join("a.md"), "# A\n\n后台摘要内容").unwrap();
        fs::write(root_dir.join("b.md"), "# B\n\n已有摘要").unwrap();

        run_native_index_worker(NativeIndexRequest {
            root_dir: root_dir.to_string_lossy().to_string(),
            allowed_extensions: vec![".md".to_string()],
            included_hidden_paths: vec![],
            config_relative_path: ".ai-index/doc-semantic-index.config.json".to_string(),
            reason: "native_test".to_string(),
            target_path: None,
        })
        .unwrap();

        let snapshot_path = root_dir.join(".ai-index/runtime/export-catalog-snapshot.json");
        let mut snapshot: Value =
            serde_json::from_str(&fs::read_to_string(&snapshot_path).unwrap()).unwrap();
        snapshot["documents"][1]["summary"] = Value::String("已有摘要".to_string());
        fs::write(
            &snapshot_path,
            format!("{}\n", serde_json::to_string_pretty(&snapshot).unwrap()),
        )
        .unwrap();

        run_native_summary_backfill_worker(NativeIndexRequest {
            root_dir: root_dir.to_string_lossy().to_string(),
            allowed_extensions: vec![".md".to_string()],
            included_hidden_paths: vec![],
            config_relative_path: ".ai-index/doc-semantic-index.config.json".to_string(),
            reason: "native_test".to_string(),
            target_path: None,
        })
        .unwrap();

        let status_path = root_dir.join(".ai-index").join("runtime-status.json");
        let status: Value =
            serde_json::from_str(&fs::read_to_string(status_path).unwrap()).unwrap();
        let progress = status.get("progress").and_then(Value::as_object).unwrap();
        fs::remove_dir_all(&root_dir).ok();

        assert_eq!(status.get("state").and_then(Value::as_str), Some("cooldown"));
        assert!(status.get("lastCompletedAt").and_then(Value::as_str).is_some());
        assert_eq!(progress.get("totalCount").and_then(Value::as_u64), Some(2));
        assert_eq!(progress.get("indexedCount").and_then(Value::as_u64), Some(1));
        assert_eq!(progress.get("unchangedCount").and_then(Value::as_u64), Some(1));
        assert_eq!(progress.get("completedTaskCount").and_then(Value::as_u64), Some(2));
    }

    #[test]
    fn partial_snapshot_merge_preserves_previous_unprocessed_documents() {
        let previous = ExportCatalogSnapshot {
            version: 1,
            generated_at: "2026-06-30T00:00:00Z".to_string(),
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
                generated_at: "2026-06-30T10:00:00Z".to_string(),
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
    fn xlsx_summary_限制读取工作表数量() {
        let root_dir = make_temp_dir("x-file-native-summary-xlsx-budget");
        let file_path = root_dir.join("budget.xlsx");
        let mut entries = vec![(
            "xl/sharedStrings.xml",
            r#"<?xml version="1.0" encoding="UTF-8"?>
            <sst><si><t>共享文本</t></si></sst>"#,
        )];
        let mut sheet_payloads = Vec::new();
        for index in 1..=SUMMARY_XLSX_MAX_SHEETS + 2 {
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
        assert!(summary.contains(&format!("sheet-{SUMMARY_XLSX_MAX_SHEETS}")));
        assert!(!summary.contains(&format!("sheet-{}", SUMMARY_XLSX_MAX_SHEETS + 1)));
    }

    #[test]
    fn native_docx_parser_payload_matches_default_contract() {
        let root_dir = make_temp_dir("x-file-native-parser-docx");
        let file_path = root_dir.join("sample.docx");
        write_zip_file(
            &file_path,
            &[
                (
                    "word/document.xml",
                    r#"<?xml version="1.0" encoding="UTF-8"?>
                <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
                  <w:body>
                    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>文档标题</w:t></w:r></w:p>
                    <w:p><w:r><w:t>第一段正文</w:t></w:r></w:p>
                    <w:p><w:r><w:t>第二段正文</w:t></w:r></w:p>
                  </w:body>
                </w:document>"#,
                ),
                (
                    "docProps/core.xml",
                    r#"<?xml version="1.0" encoding="UTF-8"?>
                <cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
                  xmlns:dc="http://purl.org/dc/elements/1.1/">
                  <dc:title>文档核心标题</dc:title>
                </cp:coreProperties>"#,
                ),
            ],
        );

        let parsed = run_native_parser(NativeParserRequest {
            file_path: file_path.to_string_lossy().to_string(),
            extension: ".docx".to_string(),
        })
        .unwrap();

        assert_eq!(parsed.get("parser").and_then(Value::as_str), Some("docx"));
        assert_eq!(
            parsed.get("title").and_then(Value::as_str),
            Some("文档核心标题")
        );
        assert!(parsed
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .contains("第一段正文"));
        assert_eq!(
            parsed
                .get("structured")
                .and_then(|value| value.get("stats"))
                .and_then(|value| value.get("headingCount"))
                .and_then(Value::as_u64),
            Some(1),
        );
    }

    #[test]
    fn native_xlsx_parser_payload_matches_default_contract() {
        let root_dir = make_temp_dir("x-file-native-parser-xlsx");
        let file_path = root_dir.join("sheet.xlsx");
        write_zip_file(
            &file_path,
            &[
                (
                    "xl/workbook.xml",
                    r#"<?xml version="1.0" encoding="UTF-8"?>
                <workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
                  <sheets>
                    <sheet name="Sheet1" r:id="rId1"/>
                  </sheets>
                </workbook>"#,
                ),
                (
                    "xl/_rels/workbook.xml.rels",
                    r#"<?xml version="1.0" encoding="UTF-8"?>
                <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
                  <Relationship Id="rId1" Target="worksheets/sheet1.xml"/>
                </Relationships>"#,
                ),
                (
                    "xl/worksheets/sheet1.xml",
                    r#"<?xml version="1.0" encoding="UTF-8"?>
                <worksheet>
                  <sheetData>
                    <row r="1">
                      <c r="A1" t="inlineStr"><is><t>姓名</t></is></c>
                      <c r="B1" t="inlineStr"><is><t>分数</t></is></c>
                    </row>
                    <row r="2">
                      <c r="A2" t="inlineStr"><is><t>张三</t></is></c>
                      <c r="B2"><v>95</v></c>
                    </row>
                  </sheetData>
                </worksheet>"#,
                ),
            ],
        );

        let parsed = run_native_parser(NativeParserRequest {
            file_path: file_path.to_string_lossy().to_string(),
            extension: ".xlsx".to_string(),
        })
        .unwrap();

        assert_eq!(parsed.get("parser").and_then(Value::as_str), Some("xlsx"));
        assert!(parsed
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .contains("Sheet1"));
        assert_eq!(
            parsed
                .get("structured")
                .and_then(|value| value.get("stats"))
                .and_then(|value| value.get("sheetCount"))
                .and_then(Value::as_u64),
            Some(1),
        );
    }

    #[test]
    fn native_pptx_parser_payload_matches_default_contract() {
        let root_dir = make_temp_dir("x-file-native-parser-pptx");
        let file_path = root_dir.join("slides.pptx");
        write_zip_file(
            &file_path,
            &[
                (
                    "ppt/presentation.xml",
                    r#"<?xml version="1.0" encoding="UTF-8"?>
                <p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
                  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
                  <p:sldIdLst>
                    <p:sldId id="256" r:id="rId1"/>
                  </p:sldIdLst>
                </p:presentation>"#,
                ),
                (
                    "ppt/_rels/presentation.xml.rels",
                    r#"<?xml version="1.0" encoding="UTF-8"?>
                <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
                  <Relationship Id="rId1" Target="slides/slide1.xml"/>
                </Relationships>"#,
                ),
                (
                    "ppt/slides/slide1.xml",
                    r#"<?xml version="1.0" encoding="UTF-8"?>
                <p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
                  xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
                  <p:cSld>
                    <p:spTree>
                      <p:sp><p:txBody><a:p><a:r><a:t>第一页标题</a:t></a:r></a:p></p:txBody></p:sp>
                    </p:spTree>
                  </p:cSld>
                </p:sld>"#,
                ),
            ],
        );

        let parsed = run_native_parser(NativeParserRequest {
            file_path: file_path.to_string_lossy().to_string(),
            extension: ".pptx".to_string(),
        })
        .unwrap();

        assert_eq!(parsed.get("parser").and_then(Value::as_str), Some("pptx"));
        assert!(parsed
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .contains("Slide 1"));
        assert_eq!(
            parsed
                .get("structured")
                .and_then(|value| value.get("stats"))
                .and_then(|value| value.get("slideCount"))
                .and_then(Value::as_u64),
            Some(1),
        );
    }

    #[test]
    fn native_pdf_parser_payload_matches_default_contract() {
        let root_dir = make_temp_dir("x-file-native-parser-pdf");
        let file_path = root_dir.join("pages.pdf");
        fs::write(
            &file_path,
            r#"%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>
endobj
4 0 obj
<< /Length 40 >>
stream
BT
/F1 12 Tf
72 720 Td
(Hello PDF Page) Tj
ET
endstream
endobj
trailer
<< /Root 1 0 R >>
%%EOF"#,
        )
        .unwrap();

        let parsed = run_native_parser(NativeParserRequest {
            file_path: file_path.to_string_lossy().to_string(),
            extension: ".pdf".to_string(),
        })
        .unwrap();

        assert_eq!(parsed.get("parser").and_then(Value::as_str), Some("pdf"));
        assert!(parsed
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .contains("Hello PDF Page"));
        assert_eq!(
            parsed
                .get("structured")
                .and_then(|value| value.get("stats"))
                .and_then(|value| value.get("pageCount"))
                .and_then(Value::as_u64),
            Some(1),
        );
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
