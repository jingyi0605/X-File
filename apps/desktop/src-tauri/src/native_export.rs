use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use crate::native_core::state_store::{
    export_catalog_snapshot_path, export_dir as native_export_dir, runtime_status_path,
    SEARCH_MANIFEST_RELATIVE_PATH,
};

const INDEX_COOLDOWN_MS: i64 = 1500;
const META_SHARD_TARGET_DOCUMENTS: usize = 64;
const RELATION_MAX_POSTING: usize = 128;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeExportRequest {
    pub root_dir: String,
    pub reason: String,
    pub target_path: Option<String>,
    pub dirty_scope: Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeSearchRequest {
    pub root_dir: String,
    pub reason: String,
    pub target_path: Option<String>,
    pub dirty_scope: Option<Value>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct DirtyScope {
    trigger: String,
    changed_paths: Vec<String>,
    #[serde(default)]
    deleted_paths: Vec<String>,
    dirty_directories: Vec<String>,
    dirty_tag_paths: Vec<String>,
    dirty_meta_shards: Vec<String>,
    dirty_detail_shards: Vec<String>,
    dirty_posting_buckets: Vec<String>,
    dirty_relations: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportCatalogSnapshot {
    version: u32,
    generated_at: Option<String>,
    generated_at_legacy: Option<String>,
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

#[derive(Debug, Clone, Deserialize)]
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
    running_stage: Option<String>,
    error_summary: Option<String>,
    progress: Option<Value>,
}

#[derive(Debug, Clone, Serialize)]
struct ExportBuildResult {
    manifest_path: String,
    output_dir: String,
    exported_at: String,
    meta_shard_count: usize,
    detail_shard_count: usize,
    tag_shard_count: usize,
    relation_group_count: usize,
    search_bucket_count: usize,
    files_written: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
struct MetaShardManifestEntry {
    id: String,
    directory: String,
    directories: Vec<String>,
    path: String,
    document_count: usize,
}

#[derive(Debug, Clone, Serialize)]
struct DetailShardManifestEntry {
    id: String,
    document_id: String,
    document_path: String,
    path: String,
}

#[derive(Debug, Clone, Serialize)]
struct TagShardManifestEntry {
    id: String,
    root_type: String,
    path: String,
    node_count: usize,
    posting_path: String,
}

#[derive(Debug, Clone, Serialize)]
struct RelationShardManifestEntry {
    id: String,
    path: String,
    document_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SearchBucketManifestEntry {
    bucket: String,
    path: String,
    term_count: usize,
}

#[derive(Debug, Clone, Serialize)]
struct FolderBootstrapNode {
    path: String,
    name: String,
    parent_path: Option<String>,
    direct_document_count: usize,
    document_count: usize,
}

#[derive(Debug, Clone, Serialize)]
struct RelationPair {
    document_id: String,
    related_document_id: String,
    relation_type: String,
    score: f64,
    shared_tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
struct SearchDocumentEntry {
    document_id: String,
    path: String,
    title: String,
    summary: String,
    mtime: String,
    tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
struct SearchTermEntry {
    term: String,
    document_count: usize,
    document_ids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct SearchManifestFile {
    version: u32,
    format: String,
    generated_at: String,
    buckets: Vec<SearchBucketManifestEntry>,
}

#[derive(Debug, Clone)]
struct IncrementalSearchPlan {
    previous_manifest: SearchManifestFile,
    target_buckets: BTreeSet<String>,
}

pub fn run_native_export_worker(request: NativeExportRequest) -> Result<Value, String> {
    let root_dir = request.root_dir.trim().to_string();
    if root_dir.is_empty() {
        return Err("export worker 缺少 rootDir".to_string());
    }

    let dirty_scope: DirtyScope = serde_json::from_value(request.dirty_scope.clone())
        .map_err(|error| format!("export worker dirtyScope 无效：{error}"))?;
    let snapshot_path = resolve_export_catalog_snapshot_path(&root_dir);
    if !snapshot_path.is_file() {
        return Err(format!(
            "export worker 缺少 snapshot 主路径输入：{}；请先执行 index-only，或仅在调试/应急场景下显式改用 sqlite",
            snapshot_path.display()
        ));
    }

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
            running_stage: Some("export_snapshot".to_string()),
            error_summary: None,
            progress: None,
        },
    )?;

    let result = (|| -> Result<ExportBuildResult, String> {
        let snapshot = read_snapshot(&snapshot_path)?;
        build_native_export(&root_dir, &snapshot, &dirty_scope)
    })();

    match result {
        Ok(export_result) => {
            let completed_at = iso_now();
            let next_allowed_at =
                iso_after_ms(INDEX_COOLDOWN_MS).unwrap_or_else(|| completed_at.clone());
            write_runtime_status(
                &root_dir,
                PersistedRuntimeStatus {
                    state: "cooldown".to_string(),
                    last_requested_at: Some(last_requested_at.clone()),
                    last_started_at: Some(last_started_at.clone()),
                    last_completed_at: Some(completed_at),
                    last_failed_at: None,
                    next_allowed_at: Some(next_allowed_at),
                    running_stage: None,
                    error_summary: None,
                    progress: None,
                },
            )?;
            Ok(json!({
                "accepted": true,
                "mode": "export-only",
                "reason": request.reason,
                "targetPath": request.target_path,
                "taskId": Value::Null,
                "deduped": false,
                "status": {
                    "state": "cooldown",
                    "lastRequestedAt": last_requested_at,
                    "lastStartedAt": last_started_at,
                    "lastCompletedAt": export_result.exported_at,
                    "nextAllowedAt": iso_after_ms(INDEX_COOLDOWN_MS),
                    "runningStage": Value::Null,
                    "errorSummary": Value::Null,
                    "progress": Value::Null
                },
                "dirtyScope": dirty_scope,
                "dirtyScopeSummary": {
                    "trigger": json_summary_trigger(&request.dirty_scope),
                    "changedPathCount": json_summary_len(&request.dirty_scope, "changedPaths"),
                    "deletedPathCount": json_summary_len(&request.dirty_scope, "deletedPaths"),
                    "dirtyDirectoryCount": json_summary_len(&request.dirty_scope, "dirtyDirectories"),
                },
                "exportDataSourceMode": "snapshot",
                "exportDataSourceModeRequested": "snapshot",
                "exportCatalogSnapshotPath": snapshot_path.to_string_lossy().to_string(),
                "exportCatalogSnapshotRequired": true,
                "exportFallbackToSqlite": false,
                "worker": "native-rust",
                "manifestPath": export_result.manifest_path,
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
                    running_stage: Some("export_snapshot".to_string()),
                    error_summary: Some(error.clone()),
                    progress: None,
                },
            )?;
            Err(error)
        }
    }
}

pub fn run_native_search_worker(request: NativeSearchRequest) -> Result<Value, String> {
    let root_dir = request.root_dir.trim().to_string();
    if root_dir.is_empty() {
        return Err("search worker 缺少 rootDir".to_string());
    }

    let dirty_scope = match request.dirty_scope.clone() {
        Some(value) => Some(
            serde_json::from_value::<DirtyScope>(value)
                .map_err(|error| format!("search worker dirtyScope 无效：{error}"))?,
        ),
        None => None,
    };
    let snapshot_path = resolve_export_catalog_snapshot_path(&root_dir);
    if !snapshot_path.is_file() {
        return Err(format!(
            "search worker 缺少 snapshot 主路径输入：{}；请先执行 index-only / export-only",
            snapshot_path.display()
        ));
    }

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
            running_stage: Some("search_index".to_string()),
            error_summary: None,
            progress: None,
        },
    )?;

    let result = (|| -> Result<ExportBuildResult, String> {
        let snapshot = read_snapshot(&snapshot_path)?;
        let export_dir = PathBuf::from(&root_dir).join(".ai-index").join("exports");
        let (search_buckets, files_written) =
            build_search_index(&export_dir, &iso_now(), &snapshot.documents, dirty_scope.as_ref())?;
        Ok(ExportBuildResult {
            manifest_path: export_dir.join("search").join("manifest.json").to_string_lossy().to_string(),
            output_dir: export_dir.to_string_lossy().to_string(),
            exported_at: iso_now(),
            meta_shard_count: 0,
            detail_shard_count: 0,
            tag_shard_count: 0,
            relation_group_count: 0,
            search_bucket_count: search_buckets.len(),
            files_written,
        })
    })();

    match result {
        Ok(search_result) => {
            let completed_at = iso_now();
            let next_allowed_at =
                iso_after_ms(INDEX_COOLDOWN_MS).unwrap_or_else(|| completed_at.clone());
            write_runtime_status(
                &root_dir,
                PersistedRuntimeStatus {
                    state: "cooldown".to_string(),
                    last_requested_at: Some(last_requested_at.clone()),
                    last_started_at: Some(last_started_at.clone()),
                    last_completed_at: Some(completed_at),
                    last_failed_at: None,
                    next_allowed_at: Some(next_allowed_at),
                    running_stage: None,
                    error_summary: None,
                    progress: None,
                },
            )?;
            Ok(json!({
                "accepted": true,
                "mode": "search-only",
                "reason": request.reason,
                "targetPath": request.target_path,
                "taskId": Value::Null,
                "deduped": false,
                "status": {
                    "state": "cooldown",
                    "lastRequestedAt": last_requested_at,
                    "lastStartedAt": last_started_at,
                    "lastCompletedAt": search_result.exported_at,
                    "nextAllowedAt": iso_after_ms(INDEX_COOLDOWN_MS),
                    "runningStage": Value::Null,
                    "errorSummary": Value::Null,
                    "progress": Value::Null
                },
                "dirtyScope": dirty_scope,
                "dirtyScopeSummary": {
                    "trigger": json_summary_optional_trigger(request.dirty_scope.as_ref()),
                    "changedPathCount": json_summary_optional_len(request.dirty_scope.as_ref(), "changedPaths"),
                    "deletedPathCount": json_summary_optional_len(request.dirty_scope.as_ref(), "deletedPaths"),
                    "dirtyDirectoryCount": json_summary_optional_len(request.dirty_scope.as_ref(), "dirtyDirectories"),
                },
                "searchBucketCount": search_result.search_bucket_count,
                "searchManifestPath": search_result.manifest_path,
                "filesWritten": search_result.files_written,
                "exportedAt": search_result.exported_at,
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
                    running_stage: Some("search_index".to_string()),
                    error_summary: Some(error.clone()),
                    progress: None,
                },
            )?;
            Err(error)
        }
    }
}

fn build_native_export(
    root_dir: &str,
    snapshot: &ExportCatalogSnapshot,
    dirty_scope: &DirtyScope,
) -> Result<ExportBuildResult, String> {
    let export_dir = native_export_dir(root_dir);
    fs::remove_dir_all(&export_dir).ok();
    fs::create_dir_all(&export_dir)
        .map_err(|error| format!("创建导出目录失败 {}: {error}", export_dir.display()))?;

    let exported_at = iso_now();
    let mut files_written = Vec::new();
    let mut documents = snapshot.documents.clone();
    documents.sort_by(|left, right| left.path.cmp(&right.path));
    let mut tags = snapshot.tags.clone();
    tags.sort_by(|left, right| left.path.cmp(&right.path));

    let mut folder_map = BTreeMap::<String, FolderBootstrapNode>::new();
    let mut meta_shards = Vec::new();
    let mut detail_shards = Vec::new();
    let mut current_meta_root: Option<String> = None;
    let mut current_meta_documents = Vec::<Value>::new();
    let mut current_meta_directories = Vec::<String>::new();
    let mut current_meta_dir_set = HashSet::<String>::new();
    let mut meta_root_counters = HashMap::<String, usize>::new();

    for document in &documents {
        let directory = normalize_directory(&document.path);
        bump_folder_counts(&mut folder_map, &directory);
        let meta_root = top_level_directory(&directory);
        let should_flush_root = current_meta_root
            .as_ref()
            .map(|value| value != &meta_root)
            .unwrap_or(false);
        let should_flush_size =
            current_meta_documents.len() >= META_SHARD_TARGET_DOCUMENTS
                && !current_meta_dir_set.contains(&directory);
        if should_flush_root || should_flush_size {
            flush_meta_shard(
                &export_dir,
                &exported_at,
                &mut meta_shards,
                &mut files_written,
                &mut current_meta_root,
                &mut current_meta_documents,
                &mut current_meta_directories,
                &mut current_meta_dir_set,
                &mut meta_root_counters,
            )?;
        }
        if current_meta_root.is_none() {
            current_meta_root = Some(meta_root.clone());
        }
        if current_meta_dir_set.insert(directory.clone()) {
            current_meta_directories.push(directory.clone());
        }
        current_meta_documents.push(json!({
            "document_id": document.document_id,
            "path": document.path,
            "title": document.title,
            "summary": document.summary,
            "mtime": document.mtime,
            "direct_tags": document.tags,
            "derived_tags": document.derived_tags,
            "detail_ref": format!("detail/{}.json", document.document_id),
        }));

        let detail_relative_path = format!("detail/{}.json", document.document_id);
        detail_shards.push(DetailShardManifestEntry {
            id: stable_id("detail", &document.path),
            document_id: document.document_id.clone(),
            document_path: document.path.clone(),
            path: detail_relative_path.clone(),
        });
        let detail_path = export_dir.join(&detail_relative_path);
        write_json_file(
            &detail_path,
            &json!({
                "version": 2,
                "shard_type": "detail",
                "exported_at": exported_at,
                "document": {
                    "document_id": document.document_id,
                    "path": document.path,
                    "title": document.title,
                    "summary": document.summary,
                    "direct_tags": document.tags,
                    "derived_tags": document.derived_tags,
                    "mtime": document.mtime,
                    "directory": directory,
                }
            }),
        )?;
        files_written.push(detail_path.to_string_lossy().to_string());
    }

    flush_meta_shard(
        &export_dir,
        &exported_at,
        &mut meta_shards,
        &mut files_written,
        &mut current_meta_root,
        &mut current_meta_documents,
        &mut current_meta_directories,
        &mut current_meta_dir_set,
        &mut meta_root_counters,
    )?;

    let taxonomy = build_taxonomy(&tags);
    let (tag_shards, tag_files) = build_tag_shards(&export_dir, &exported_at, &documents, &tags)?;
    files_written.extend(tag_files);
    let (relation_shards, relation_files) =
        build_relation_shards(&export_dir, &exported_at, &documents)?;
    files_written.extend(relation_files);
    let (search_buckets, search_files) = build_search_index(&export_dir, &exported_at, &documents, Some(dirty_scope))?;
    files_written.extend(search_files);

    let status_path = export_dir.join("status.json");
    write_json_file(
        &status_path,
        &json!({
            "version": 2,
            "format": "static-v2",
            "exported_at": exported_at,
            "document_count": detail_shards.len(),
            "meta_shard_count": meta_shards.len(),
            "detail_shard_count": detail_shards.len(),
            "tag_shard_count": tag_shards.len(),
            "relation_group_count": relation_shards.len(),
            "search_bucket_count": search_buckets.len(),
            "dirty_scope": dirty_scope,
        }),
    )?;
    files_written.push(status_path.to_string_lossy().to_string());

    let taxonomy_path = export_dir.join("taxonomy.json");
    write_json_file(
        &taxonomy_path,
        &json!({
            "version": 2,
            "format": "static-v2",
            "exported_at": exported_at,
            "root_types": taxonomy.0,
            "nodes": taxonomy.1,
            "tree": taxonomy.2,
        }),
    )?;
    files_written.push(taxonomy_path.to_string_lossy().to_string());

    let relations_path = export_dir.join("relations.json");
    write_json_file(
        &relations_path,
        &json!({
            "version": 2,
            "format": "static-v2",
            "exported_at": exported_at,
            "groups": relation_shards,
        }),
    )?;
    files_written.push(relations_path.to_string_lossy().to_string());

    let bootstrap_path = export_dir.join("bootstrap.json");
    let folders: Vec<FolderBootstrapNode> = folder_map.into_values().collect();
    write_json_file(
        &bootstrap_path,
        &json!({
            "version": 2,
            "format": "static-v2-bootstrap",
            "exported_at": exported_at,
            "folders": folders,
        }),
    )?;
    files_written.push(bootstrap_path.to_string_lossy().to_string());

    let manifest_path = export_dir.join("manifest.json");
    write_json_file(
        &manifest_path,
        &json!({
            "version": 2,
            "format": "static-v2",
            "generated_at": exported_at,
            "entries": {
                "status": "status.json",
                "taxonomy": "taxonomy.json",
                "relations": "relations.json",
                "bootstrap": "bootstrap.json",
                "search_manifest": SEARCH_MANIFEST_RELATIVE_PATH,
            },
            "meta_shards": meta_shards,
            "detail_shards": detail_shards,
            "tag_shards": tag_shards,
            "relation_shards": relation_shards,
            "search_buckets": search_buckets,
        }),
    )?;
    files_written.push(manifest_path.to_string_lossy().to_string());

    Ok(ExportBuildResult {
        manifest_path: manifest_path.to_string_lossy().to_string(),
        output_dir: export_dir.to_string_lossy().to_string(),
        exported_at,
        meta_shard_count: meta_shards.len(),
        detail_shard_count: detail_shards.len(),
        tag_shard_count: tag_shards.len(),
        relation_group_count: relation_shards.len(),
        search_bucket_count: search_buckets.len(),
        files_written: unique_sorted(files_written),
    })
}

fn build_taxonomy(tags: &[SnapshotTag]) -> (Vec<String>, Vec<Value>, Vec<Value>) {
    let mut root_types = BTreeSet::new();
    let mut nodes = Vec::new();
    let mut by_path = BTreeMap::<String, Value>::new();
    let mut children = HashMap::<String, Vec<Value>>::new();
    for tag in tags {
        root_types.insert(tag.root_type.clone());
        let node = json!({
            "path": tag.path,
            "name": tag.name,
            "root_type": tag.root_type,
            "parent_path": tag.parent_path,
            "depth": tag.depth,
        });
        by_path.insert(tag.path.clone(), node.clone());
        nodes.push(node.clone());
        if let Some(parent) = &tag.parent_path {
            children.entry(parent.clone()).or_default().push(node);
        }
    }
    let mut tree = Vec::new();
    for tag in tags {
        if tag.parent_path.is_some() {
            continue;
        }
        tree.push(build_tree_node(&tag.path, &by_path, &children));
    }
    (
        root_types.into_iter().collect(),
        nodes,
        tree,
    )
}

fn build_tree_node(
    path: &str,
    by_path: &BTreeMap<String, Value>,
    children: &HashMap<String, Vec<Value>>,
) -> Value {
    let mut node = by_path.get(path).cloned().unwrap_or_else(|| json!({ "path": path }));
    let child_values = children
        .get(path)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|child| {
            let child_path = child
                .get("path")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            build_tree_node(&child_path, by_path, children)
        })
        .collect::<Vec<_>>();
    if let Some(object) = node.as_object_mut() {
        object.insert("children".to_string(), Value::Array(child_values));
    }
    node
}

fn build_tag_shards(
    export_dir: &Path,
    exported_at: &str,
    documents: &[SnapshotDocument],
    tags: &[SnapshotTag],
) -> Result<(Vec<TagShardManifestEntry>, Vec<String>), String> {
    let tag_map: HashMap<String, SnapshotTag> =
        tags.iter().cloned().map(|tag| (tag.path.clone(), tag)).collect();
    let mut tags_by_root = BTreeMap::<String, Vec<SnapshotTag>>::new();
    for tag in tags {
        tags_by_root
            .entry(tag.root_type.clone())
            .or_default()
            .push(tag.clone());
    }

    let mut postings_by_root =
        BTreeMap::<String, BTreeMap<String, Vec<Value>>>::new();
    for document in documents {
        for (tag_path, derived) in document
            .tags
            .iter()
            .map(|tag| (tag.clone(), false))
            .chain(document.derived_tags.iter().map(|tag| (tag.clone(), true)))
        {
            let root_type = tag_map
                .get(&tag_path)
                .map(|tag| tag.root_type.clone())
                .unwrap_or_else(|| infer_root_type(&tag_path));
            postings_by_root
                .entry(root_type)
                .or_default()
                .entry(tag_path)
                .or_default()
                .push(json!({
                    "document_id": document.document_id,
                    "path": document.path,
                    "title": document.title,
                    "derived": derived,
                }));
        }
    }

    let mut manifest = Vec::new();
    let mut files_written = Vec::new();
    for (root_type, root_tags) in tags_by_root {
        let shard_id = stable_id("tag", &root_type);
        let tag_relative_path = format!("tags/{shard_id}.json");
        let posting_relative_path = format!("tags/{shard_id}.posting.json");
        let tag_path = export_dir.join(&tag_relative_path);
        let posting_path = export_dir.join(&posting_relative_path);
        write_json_file(
            &tag_path,
            &json!({
                "version": 2,
                "shard_type": "tag",
                "root_type": root_type,
                "exported_at": exported_at,
                "nodes": root_tags,
            }),
        )?;
        let postings = postings_by_root
            .get(&root_type)
            .map(|map| {
                map.iter()
                    .map(|(tag_path, docs)| {
                        json!({
                            "tag_path": tag_path,
                            "document_count": docs.len(),
                            "documents": docs,
                        })
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        write_json_file(
            &posting_path,
            &json!({
                "version": 2,
                "shard_type": "tag_posting",
                "root_type": root_type,
                "exported_at": exported_at,
                "postings": postings,
            }),
        )?;
        manifest.push(TagShardManifestEntry {
            id: shard_id,
            root_type,
            path: tag_relative_path,
            node_count: root_tags.len(),
            posting_path: posting_relative_path,
        });
        files_written.push(tag_path.to_string_lossy().to_string());
        files_written.push(posting_path.to_string_lossy().to_string());
    }

    Ok((manifest, files_written))
}

fn build_relation_shards(
    export_dir: &Path,
    exported_at: &str,
    documents: &[SnapshotDocument],
) -> Result<(Vec<RelationShardManifestEntry>, Vec<String>), String> {
    let mut by_direct_tag = BTreeMap::<String, Vec<&SnapshotDocument>>::new();
    for document in documents {
        for tag_path in &document.tags {
            if !is_relation_eligible_tag(tag_path) {
                continue;
            }
            by_direct_tag.entry(tag_path.clone()).or_default().push(document);
        }
    }

    let mut relation_map = BTreeMap::<String, HashMap<String, RelationPair>>::new();
    for (tag_path, tagged_docs) in by_direct_tag {
        if tagged_docs.len() < 2 || tagged_docs.len() > RELATION_MAX_POSTING {
            continue;
        }
        for index in 0..tagged_docs.len() {
            for other_index in (index + 1)..tagged_docs.len() {
                let left = tagged_docs[index];
                let right = tagged_docs[other_index];
                merge_relation_pair(&mut relation_map, left, right, &tag_path);
                merge_relation_pair(&mut relation_map, right, left, &tag_path);
            }
        }
    }

    let mut manifest = Vec::new();
    let mut files_written = Vec::new();
    for (document_id, pairs) in relation_map {
        let mut relations = pairs.into_values().collect::<Vec<_>>();
        relations.sort_by(|left, right| left.related_document_id.cmp(&right.related_document_id));
        let relative_path = format!("relations/{document_id}.json");
        let absolute_path = export_dir.join(&relative_path);
        write_json_file(
            &absolute_path,
            &json!({
                "version": 2,
                "shard_type": "relation",
                "exported_at": exported_at,
                "document_id": document_id,
                "relations": relations,
            }),
        )?;
        manifest.push(RelationShardManifestEntry {
            id: stable_id("relation", &document_id),
            path: relative_path,
            document_count: relations.len(),
        });
        files_written.push(absolute_path.to_string_lossy().to_string());
    }

    Ok((manifest, files_written))
}

fn merge_relation_pair(
    relation_map: &mut BTreeMap<String, HashMap<String, RelationPair>>,
    source: &SnapshotDocument,
    target: &SnapshotDocument,
    tag_path: &str,
) {
    let entry = relation_map
        .entry(source.document_id.clone())
        .or_default()
        .entry(target.document_id.clone())
        .or_insert_with(|| RelationPair {
            document_id: source.document_id.clone(),
            related_document_id: target.document_id.clone(),
            relation_type: "shared_tag".to_string(),
            score: 1.0,
            shared_tags: Vec::new(),
        });
    if !entry.shared_tags.iter().any(|tag| tag == tag_path) {
        entry.shared_tags.push(tag_path.to_string());
        entry.shared_tags.sort();
    }
}

fn build_search_index(
    export_dir: &Path,
    exported_at: &str,
    documents: &[SnapshotDocument],
    dirty_scope: Option<&DirtyScope>,
) -> Result<(Vec<SearchBucketManifestEntry>, Vec<String>), String> {
    let search_dir = export_dir.join("search");
    fs::create_dir_all(&search_dir)
        .map_err(|error| format!("创建搜索导出目录失败 {}: {error}", search_dir.display()))?;
    let incremental_plan = build_incremental_search_plan(export_dir, documents, dirty_scope);
    let mut bucket_documents =
        BTreeMap::<String, BTreeMap<String, SearchDocumentEntry>>::new();
    let mut bucket_terms =
        BTreeMap::<String, BTreeMap<String, Vec<String>>>::new();

    for document in documents {
        let entry = SearchDocumentEntry {
            document_id: document.document_id.clone(),
            path: document.path.clone(),
            title: document.title.clone(),
            summary: document.summary.clone(),
            mtime: document.mtime.clone(),
            tags: document
                .tags
                .iter()
                .chain(document.derived_tags.iter())
                .cloned()
                .collect(),
        };
        let mut bucket_term_map = BTreeMap::<String, Vec<String>>::new();
        for term in tokenize_document(document) {
            let bucket = build_bucket_name(&term);
            bucket_term_map.entry(bucket).or_default().push(term);
        }
        for (bucket, terms) in bucket_term_map {
            if incremental_plan
                .as_ref()
                .map(|plan| !plan.target_buckets.contains(&bucket))
                .unwrap_or(false)
            {
                continue;
            }
            bucket_documents
                .entry(bucket.clone())
                .or_default()
                .insert(entry.document_id.clone(), entry.clone());
            let term_map = bucket_terms.entry(bucket).or_default();
            for term in terms.into_iter().collect::<HashSet<_>>() {
                let posting = term_map.entry(term).or_default();
                if posting.last() != Some(&entry.document_id) {
                    posting.push(entry.document_id.clone());
                }
            }
        }
    }

    let mut manifest = Vec::new();
    let mut files_written = Vec::new();
    for (bucket, documents_by_id) in bucket_documents {
        let file_path = search_dir.join(format!("{bucket}.json"));
        let terms = bucket_terms.get(&bucket).cloned().unwrap_or_default();
        let mut docs = documents_by_id.into_values().collect::<Vec<_>>();
        docs.sort_by(|left, right| left.path.cmp(&right.path));
        let mut term_entries = terms
            .into_iter()
            .map(|(term, document_ids)| SearchTermEntry {
                document_count: document_ids.len(),
                term,
                document_ids,
            })
            .collect::<Vec<_>>();
        term_entries.sort_by(|left, right| left.term.cmp(&right.term));
        write_json_file(
            &file_path,
            &json!({
                "version": 1,
                "format": "search-bucket-v1",
                "generated_at": exported_at,
                "bucket": bucket,
                "documents": docs,
                "terms": term_entries,
            }),
        )?;
        manifest.push(SearchBucketManifestEntry {
            bucket: bucket.clone(),
            path: format!("search/{bucket}.json"),
            term_count: term_entries.len(),
        });
        files_written.push(file_path.to_string_lossy().to_string());
    }

    if let Some(plan) = incremental_plan {
        let rebuilt_by_bucket = manifest
            .iter()
            .cloned()
            .map(|bucket| (bucket.bucket.clone(), bucket))
            .collect::<BTreeMap<_, _>>();
        let mut merged_manifest = Vec::new();
        for previous_bucket in plan.previous_manifest.buckets {
            if !plan.target_buckets.contains(&previous_bucket.bucket) {
                merged_manifest.push(previous_bucket);
                continue;
            }
            if let Some(rebuilt) = rebuilt_by_bucket.get(&previous_bucket.bucket) {
                merged_manifest.push(rebuilt.clone());
                continue;
            }
            let stale_bucket_path = export_dir.join(&previous_bucket.path);
            fs::remove_file(&stale_bucket_path).ok();
        }
        for bucket in manifest {
            if !merged_manifest.iter().any(|item| item.bucket == bucket.bucket) {
                merged_manifest.push(bucket);
            }
        }
        manifest = merged_manifest;
        manifest.sort_by(|left, right| left.bucket.cmp(&right.bucket));
    }

    let manifest_path = search_dir.join("manifest.json");
    write_json_file(
        &manifest_path,
        &json!({
            "version": 1,
            "format": "search-v1",
            "generated_at": exported_at,
            "buckets": manifest,
        }),
    )?;
    files_written.push(manifest_path.to_string_lossy().to_string());

    Ok((manifest, files_written))
}

fn build_incremental_search_plan(
    export_dir: &Path,
    documents: &[SnapshotDocument],
    dirty_scope: Option<&DirtyScope>,
) -> Option<IncrementalSearchPlan> {
    let dirty_scope = dirty_scope?;
    if dirty_scope.trigger == "full" {
        return None;
    }
    let changed_paths = dirty_scope
        .changed_paths
        .iter()
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
        .collect::<BTreeSet<_>>();
    if changed_paths.is_empty() {
        return None;
    }
    let manifest_path = export_dir.join("search").join("manifest.json");
    let previous_manifest = read_json_file::<SearchManifestFile>(&manifest_path).ok()?;
    if previous_manifest.buckets.is_empty() {
        return None;
    }

    let mut target_buckets = BTreeSet::new();
    for document in documents {
        if !changed_paths.contains(&document.path) {
            continue;
        }
        for term in tokenize_document(document) {
            target_buckets.insert(build_bucket_name(&term));
        }
    }

    for previous_bucket in &previous_manifest.buckets {
        if target_buckets.contains(&previous_bucket.bucket) {
            continue;
        }
        let bucket_path = export_dir.join(&previous_bucket.path);
        if bucket_contains_any_path(&bucket_path, &changed_paths) {
            target_buckets.insert(previous_bucket.bucket.clone());
        }
    }

    Some(IncrementalSearchPlan {
        previous_manifest,
        target_buckets,
    })
}

fn bucket_contains_any_path(path: &PathBuf, changed_paths: &BTreeSet<String>) -> bool {
    if !path.is_file() || changed_paths.is_empty() {
        return false;
    }
    let Ok(raw) = fs::read_to_string(path) else {
        return false;
    };
    changed_paths.iter().any(|changed_path| {
        raw.contains(&format!("\"path\": \"{}\"", changed_path))
    })
}

fn tokenize_document(document: &SnapshotDocument) -> HashSet<String> {
    let source = [
        document.path.as_str(),
        document.title.as_str(),
        document.summary.as_str(),
        &document.tags.join("\n"),
        &document.derived_tags.join("\n"),
    ]
    .join("\n")
    .to_lowercase();
    let mut terms = HashSet::new();
    let mut word = String::new();
    for ch in source.chars() {
        if ch.is_ascii_alphanumeric() || ch == '.' || ch == '_' || ch == '-' {
            word.push(ch);
            continue;
        }
        if word.len() >= 2 {
            terms.insert(word.clone());
        }
        word.clear();
    }
    if word.len() >= 2 {
        terms.insert(word);
    }

    let compact = source.chars().filter(|ch| !ch.is_whitespace()).collect::<String>();
    let han_chars = compact
        .chars()
        .map(|ch| if is_han(ch) { ch } else { ' ' })
        .collect::<String>();
    for block in han_chars.split_whitespace() {
        let chars = block.chars().collect::<Vec<_>>();
        if chars.len() < 2 {
            continue;
        }
        if chars.len() <= 4 {
            terms.insert(block.to_string());
            continue;
        }
        for size in 2..=4 {
            for index in 0..=(chars.len() - size) {
                terms.insert(chars[index..index + size].iter().collect::<String>());
            }
        }
    }
    terms
}

fn build_bucket_name(term: &str) -> String {
    let first = term.chars().next().unwrap_or('_');
    if first.is_ascii_alphanumeric() {
        first.to_string()
    } else {
        "han".to_string()
    }
}

fn is_han(ch: char) -> bool {
    ('\u{4e00}'..='\u{9fff}').contains(&ch)
}

fn flush_meta_shard(
    export_dir: &Path,
    exported_at: &str,
    meta_shards: &mut Vec<MetaShardManifestEntry>,
    files_written: &mut Vec<String>,
    current_meta_root: &mut Option<String>,
    current_meta_documents: &mut Vec<Value>,
    current_meta_directories: &mut Vec<String>,
    current_meta_dir_set: &mut HashSet<String>,
    meta_root_counters: &mut HashMap<String, usize>,
) -> Result<(), String> {
    let Some(meta_root) = current_meta_root.clone() else {
        return Ok(());
    };
    if current_meta_documents.is_empty() {
        *current_meta_root = None;
        current_meta_directories.clear();
        current_meta_dir_set.clear();
        return Ok(());
    }
    let counter = meta_root_counters.entry(meta_root.clone()).or_insert(0);
    let shard_index = *counter;
    *counter += 1;
    let directories = unique_sorted(current_meta_directories.clone());
    let shard_directory = common_directory(&directories);
    let shard_id = stable_id("meta", &format!("{meta_root}::{shard_index}"));
    let relative_path = format!("meta/{shard_id}.json");
    let absolute_path = export_dir.join(&relative_path);
    write_json_file(
        &absolute_path,
        &json!({
            "version": 2,
            "shard_type": "meta",
            "directory": shard_directory,
            "directories": directories,
            "exported_at": exported_at,
            "documents": current_meta_documents,
        }),
    )?;
    meta_shards.push(MetaShardManifestEntry {
        id: shard_id,
        directory: shard_directory,
        directories,
        path: relative_path,
        document_count: current_meta_documents.len(),
    });
    files_written.push(absolute_path.to_string_lossy().to_string());
    *current_meta_root = None;
    current_meta_documents.clear();
    current_meta_directories.clear();
    current_meta_dir_set.clear();
    Ok(())
}

fn bump_folder_counts(folder_map: &mut BTreeMap<String, FolderBootstrapNode>, directory: &str) {
    let normalized = if directory.is_empty() { "." } else { directory };
    {
        let node = folder_map
            .entry(normalized.to_string())
            .or_insert_with(|| FolderBootstrapNode {
                path: normalized.to_string(),
                name: directory_name(normalized),
                parent_path: parent_directory(normalized),
                direct_document_count: 0,
                document_count: 0,
            });
        node.direct_document_count += 1;
    }

    let mut current = Some(normalized.to_string());
    while let Some(path) = current {
        let node = folder_map
            .entry(path.clone())
            .or_insert_with(|| FolderBootstrapNode {
                path: path.clone(),
                name: directory_name(&path),
                parent_path: parent_directory(&path),
                direct_document_count: 0,
                document_count: 0,
            });
        node.document_count += 1;
        current = parent_directory(&path);
    }
}

fn resolve_export_catalog_snapshot_path(root_dir: &str) -> PathBuf {
    export_catalog_snapshot_path(root_dir)
}

fn read_snapshot(path: &PathBuf) -> Result<ExportCatalogSnapshot, String> {
    let snapshot = read_json_file::<ExportCatalogSnapshot>(path)?;
    if snapshot.version != 1 {
        return Err(format!(
            "export catalog snapshot 版本不支持：{}",
            snapshot.version
        ));
    }
    Ok(snapshot)
}

fn write_runtime_status(root_dir: &str, payload: PersistedRuntimeStatus) -> Result<(), String> {
    let path = runtime_status_path(root_dir);
    write_json_file(&path, &payload)
}

fn infer_root_type(tag_path: &str) -> String {
    tag_path.split('/').next().unwrap_or_default().to_string()
}

fn is_relation_eligible_tag(tag_path: &str) -> bool {
    !(tag_path.starts_with("来源/")
        || tag_path.starts_with("类型/")
        || tag_path.starts_with("时间/")
        || tag_path.starts_with("状态/"))
}

fn normalize_directory(file_path: &str) -> String {
    let trimmed = file_path.trim().replace('\\', "/");
    if let Some(index) = trimmed.rfind('/') {
        let value = trimmed[..index].trim_matches('/').to_string();
        if value.is_empty() {
            ".".to_string()
        } else {
            value
        }
    } else {
        ".".to_string()
    }
}

fn top_level_directory(directory: &str) -> String {
    if directory == "." || directory.is_empty() {
        ".".to_string()
    } else {
        directory.split('/').next().unwrap_or(".").to_string()
    }
}

fn directory_name(directory: &str) -> String {
    if directory == "." || directory.is_empty() {
        "资料库".to_string()
    } else {
        directory
            .split('/')
            .filter(|segment| !segment.is_empty())
            .last()
            .unwrap_or("资料库")
            .to_string()
    }
}

fn parent_directory(directory: &str) -> Option<String> {
    if directory == "." || directory.is_empty() {
        return None;
    }
    let trimmed = directory.trim_matches('/');
    if let Some(index) = trimmed.rfind('/') {
        let parent = trimmed[..index].to_string();
        if parent.is_empty() {
            Some(".".to_string())
        } else {
            Some(parent)
        }
    } else {
        Some(".".to_string())
    }
}

fn common_directory(directories: &[String]) -> String {
    if directories.is_empty() {
        return ".".to_string();
    }
    let parts_list = directories
        .iter()
        .map(|item| {
            if item == "." {
                Vec::<String>::new()
            } else {
                item.split('/').filter(|part| !part.is_empty()).map(ToString::to_string).collect()
            }
        })
        .collect::<Vec<_>>();
    let min_len = parts_list.iter().map(Vec::len).min().unwrap_or(0);
    let mut shared = Vec::<String>::new();
    for index in 0..min_len {
        let Some(current) = parts_list[0].get(index) else {
            break;
        };
        if parts_list.iter().all(|parts| parts.get(index) == Some(current)) {
            shared.push(current.clone());
        } else {
            break;
        }
    }
    if shared.is_empty() {
        ".".to_string()
    } else {
        shared.join("/")
    }
}

fn unique_sorted(values: Vec<String>) -> Vec<String> {
    let mut set = BTreeSet::new();
    for value in values {
        if !value.trim().is_empty() {
            set.insert(value);
        }
    }
    set.into_iter().collect()
}

fn stable_id(prefix: &str, value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    let hex = format!("{:x}", digest);
    format!("{}_{}", prefix, &hex[..16])
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
    fs::write(path, buffer)
        .map_err(|error| format!("写入文件失败 {}: {error}", path.display()))
}

fn iso_now() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn iso_after_ms(ms: i64) -> Option<String> {
    chrono::Utc::now()
        .checked_add_signed(chrono::Duration::milliseconds(ms))
        .map(|value| value.to_rfc3339())
}

fn json_summary_trigger(value: &Value) -> Option<String> {
    value
        .get("trigger")
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

fn json_summary_len(value: &Value, key: &str) -> usize {
    value.get(key).and_then(Value::as_array).map(Vec::len).unwrap_or(0)
}

fn json_summary_optional_trigger(value: Option<&Value>) -> Option<String> {
    value.and_then(json_summary_trigger)
}

fn json_summary_optional_len(value: Option<&Value>, key: &str) -> usize {
    value.map(|item| json_summary_len(item, key)).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::{
        build_native_export, build_search_index, read_json_file, write_runtime_status, DirtyScope,
        ExportCatalogSnapshot, PersistedRuntimeStatus, SearchManifestFile, SnapshotDocument, SnapshotTag,
    };
    use crate::native_core::state_store::{
        export_manifest_path, search_manifest_path, runtime_status_path, SEARCH_MANIFEST_RELATIVE_PATH,
    };
    use serde_json::Value;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn incremental_search_only_reuses_unchanged_buckets_and_rebuilds_dirty_bucket() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time before unix epoch")
            .as_nanos();
        let temp_root = std::env::temp_dir().join(format!(
            "x-file-native-search-incremental-{nonce}"
        ));
        if temp_root.exists() {
            fs::remove_dir_all(&temp_root).ok();
        }
        let export_dir = temp_root.join(".ai-index").join("exports");
        fs::create_dir_all(&export_dir).expect("create export dir");

        let initial_documents = vec![
            SnapshotDocument {
                document_id: "doc_a".to_string(),
                path: "docs/a.md".to_string(),
                title: "Alpha".to_string(),
                summary: "apple alpha".to_string(),
                tags: Vec::new(),
                derived_tags: Vec::new(),
                mtime: "2026-06-17T00:00:00Z".to_string(),
            },
            SnapshotDocument {
                document_id: "doc_b".to_string(),
                path: "docs/b.md".to_string(),
                title: "Beta".to_string(),
                summary: "banana beta".to_string(),
                tags: Vec::new(),
                derived_tags: Vec::new(),
                mtime: "2026-06-17T00:00:00Z".to_string(),
            },
        ];
        build_search_index(
            &export_dir,
            "2026-06-17T00:00:00Z",
            &initial_documents,
            None,
        )
        .expect("build initial search index");

        let banana_bucket_path = export_dir.join("search").join("b.json");
        let before_banana_bucket = fs::read_to_string(&banana_bucket_path)
            .expect("read unchanged bucket before incremental rebuild");
        assert!(before_banana_bucket.contains("\"doc_b\""));

        let updated_documents = vec![
            SnapshotDocument {
                document_id: "doc_a".to_string(),
                path: "docs/a.md".to_string(),
                title: "Alpha".to_string(),
                summary: "cherry alpha".to_string(),
                tags: Vec::new(),
                derived_tags: Vec::new(),
                mtime: "2026-06-17T00:01:00Z".to_string(),
            },
            SnapshotDocument {
                document_id: "doc_b".to_string(),
                path: "docs/b.md".to_string(),
                title: "Beta".to_string(),
                summary: "banana beta".to_string(),
                tags: Vec::new(),
                derived_tags: Vec::new(),
                mtime: "2026-06-17T00:00:00Z".to_string(),
            },
        ];
        let dirty_scope = DirtyScope {
            trigger: "incremental".to_string(),
            changed_paths: vec!["docs/a.md".to_string()],
            deleted_paths: Vec::new(),
            dirty_directories: vec!["docs".to_string()],
            dirty_tag_paths: Vec::new(),
            dirty_meta_shards: Vec::new(),
            dirty_detail_shards: Vec::new(),
            dirty_posting_buckets: Vec::new(),
            dirty_relations: Vec::new(),
        };
        build_search_index(
            &export_dir,
            "2026-06-17T00:01:00Z",
            &updated_documents,
            Some(&dirty_scope),
        )
        .expect("build incremental search index");

        let manifest_path = export_dir.join("search").join("manifest.json");
        let manifest = read_json_file::<SearchManifestFile>(&PathBuf::from(&manifest_path))
            .expect("read merged manifest");
        let buckets = manifest
            .buckets
            .iter()
            .map(|entry| entry.bucket.clone())
            .collect::<Vec<_>>();
        assert!(buckets.contains(&"b".to_string()));
        assert!(buckets.contains(&"c".to_string()));

        let after_banana_bucket = fs::read_to_string(&banana_bucket_path)
            .expect("read unchanged bucket after incremental rebuild");
        assert_eq!(after_banana_bucket, before_banana_bucket);

        let cherry_bucket_path = export_dir.join("search").join("c.json");
        let cherry_bucket = fs::read_to_string(&cherry_bucket_path)
            .expect("read rebuilt dirty bucket");
        assert!(cherry_bucket.contains("\"doc_a\""));

        let rebuilt_alpha_bucket_path = export_dir.join("search").join("a.json");
        let rebuilt_alpha_bucket = fs::read_to_string(&rebuilt_alpha_bucket_path)
            .expect("read rebuilt alpha bucket");
        assert!(rebuilt_alpha_bucket.contains("\"doc_a\""));
        assert_eq!(rebuilt_alpha_bucket.contains("apple"), false);

        fs::remove_dir_all(&temp_root).ok();
    }

    #[test]
    fn native_export_manifest_matches_default_contract() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time before unix epoch")
            .as_nanos();
        let root_dir = std::env::temp_dir().join(format!("x-file-native-export-contract-{nonce}"));
        fs::create_dir_all(root_dir.join(".ai-index").join("runtime")).expect("create runtime dir");

        let snapshot = ExportCatalogSnapshot {
            version: 1,
            generated_at: Some("2026-06-18T10:00:00Z".to_string()),
            generated_at_legacy: None,
            tags: vec![SnapshotTag {
                path: "主题/示例".to_string(),
                name: "示例".to_string(),
                root_type: "主题".to_string(),
                parent_path: None,
                depth: 0,
            }],
            documents: vec![SnapshotDocument {
                document_id: "doc_1".to_string(),
                path: "docs/a.md".to_string(),
                title: "A".to_string(),
                summary: "alpha beta".to_string(),
                tags: vec!["主题/示例".to_string()],
                derived_tags: Vec::new(),
                mtime: "2026-06-18T10:00:00Z".to_string(),
            }],
        };
        let dirty_scope = DirtyScope {
            trigger: "full".to_string(),
            changed_paths: Vec::new(),
            deleted_paths: Vec::new(),
            dirty_directories: Vec::new(),
            dirty_tag_paths: Vec::new(),
            dirty_meta_shards: Vec::new(),
            dirty_detail_shards: Vec::new(),
            dirty_posting_buckets: Vec::new(),
            dirty_relations: Vec::new(),
        };

        let result = build_native_export(&root_dir.to_string_lossy(), &snapshot, &dirty_scope)
            .expect("build export");
        let manifest_path = export_manifest_path(&root_dir.to_string_lossy());
        assert!(
            result
                .files_written
                .iter()
                .any(|item| item == &manifest_path.to_string_lossy().to_string())
        );

        let manifest = read_json_file::<Value>(&manifest_path).expect("read manifest");
        assert_eq!(manifest.get("version").and_then(Value::as_u64), Some(2));
        assert_eq!(manifest.get("format").and_then(Value::as_str), Some("static-v2"));
        assert_eq!(
            manifest
                .get("entries")
                .and_then(Value::as_object)
                .and_then(|entries| entries.get("search_manifest"))
                .and_then(Value::as_str),
            Some(SEARCH_MANIFEST_RELATIVE_PATH),
        );
        assert_eq!(
            manifest
                .get("meta_shards")
                .and_then(Value::as_array)
                .map(Vec::len),
            Some(1),
        );
        assert_eq!(
            manifest
                .get("detail_shards")
                .and_then(Value::as_array)
                .map(Vec::len),
            Some(1),
        );
        assert!(search_manifest_path(&root_dir.to_string_lossy()).is_file());
    }

    #[test]
    fn native_export_runtime_status_matches_default_contract() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time before unix epoch")
            .as_nanos();
        let root_dir = std::env::temp_dir().join(format!("x-file-native-export-status-{nonce}"));
        fs::create_dir_all(root_dir.join(".ai-index")).expect("create ai-index");

        write_runtime_status(
            &root_dir.to_string_lossy(),
            PersistedRuntimeStatus {
                state: "cooldown".to_string(),
                last_requested_at: Some("2026-06-18T10:00:00Z".to_string()),
                last_started_at: Some("2026-06-18T10:00:01Z".to_string()),
                last_completed_at: Some("2026-06-18T10:00:02Z".to_string()),
                last_failed_at: None,
                next_allowed_at: Some("2026-06-18T10:00:03Z".to_string()),
                running_stage: None,
                error_summary: None,
                progress: None,
            },
        )
        .expect("write runtime status");

        let status = read_json_file::<Value>(&runtime_status_path(&root_dir.to_string_lossy()))
            .expect("read runtime status");
        assert_eq!(status.get("state").and_then(Value::as_str), Some("cooldown"));
        assert_eq!(
            status.get("lastRequestedAt").and_then(Value::as_str),
            Some("2026-06-18T10:00:00Z"),
        );
        assert!(status.get("progress").is_some());
    }
}
