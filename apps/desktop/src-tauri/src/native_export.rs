use crate::native_core::catalog::{
    read_catalog, ExportCatalogSnapshot, SnapshotDocument, SnapshotTag,
};
use crate::native_core::state_store::write_compact_json;
use crate::native_core::state_store::{
    export_catalog_snapshot_path, export_dir as native_export_dir, runtime_status_path,
    SEARCH_MANIFEST_RELATIVE_PATH,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

const INDEX_COOLDOWN_MS: i64 = 1500;
const RELATION_MAX_POSTING: usize = 128;
const SEARCH_PARTITION_COUNT: u8 = 16;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeExportRequest {
    pub root_dir: String,
    pub reason: String,
    pub target_path: Option<String>,
    pub dirty_scope: Value,
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
    progress: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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

#[derive(Debug, Clone, Serialize, Deserialize)]
struct MetaShardManifestEntry {
    id: String,
    directory: String,
    directories: Vec<String>,
    path: String,
    document_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DetailShardManifestEntry {
    id: String,
    document_id: String,
    document_path: String,
    path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TagShardManifestEntry {
    id: String,
    root_type: String,
    path: String,
    node_count: usize,
    posting_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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

#[derive(Debug, Clone, Serialize, Deserialize)]
struct FolderBootstrapNode {
    path: String,
    name: String,
    parent_path: Option<String>,
    direct_document_count: usize,
    document_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RelationPair {
    document_id: String,
    related_document_id: String,
    relation_type: String,
    score: f64,
    shared_tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SearchDocumentEntry {
    document_id: String,
    path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SearchTermEntry {
    term: String,
    document_count: usize,
    document_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DocumentSearchState {
    document_id: String,
    buckets: Vec<String>,
    terms_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SearchManifestFile {
    #[serde(default)]
    partition_count: u8,
    #[serde(default)]
    document_index: BTreeMap<String, DocumentSearchState>,
    version: u32,
    format: String,
    generated_at: String,
    buckets: Vec<SearchBucketManifestEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ExportManifest {
    #[serde(default)]
    layout: String,
    generated_at: String,
    entries: Value,
    meta_shards: Vec<MetaShardManifestEntry>,
    detail_shards: Vec<DetailShardManifestEntry>,
    tag_shards: Vec<TagShardManifestEntry>,
    relation_shards: Vec<RelationShardManifestEntry>,
    search_buckets: Vec<SearchBucketManifestEntry>,
}

pub fn run_native_export_worker(request: NativeExportRequest) -> Result<Value, String> {
    let root_dir = request.root_dir.trim().to_string();
    if root_dir.is_empty() {
        return Err("export worker 缺少 rootDir".to_string());
    }

    let dirty_scope: DirtyScope = serde_json::from_value(request.dirty_scope.clone())
        .map_err(|error| format!("export worker dirtyScope 无效：{error}"))?;
    let snapshot_path = export_catalog_snapshot_path(&root_dir);
    let inherited_progress = read_existing_runtime_progress(&root_dir)?;
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
            running_stage: Some("export_snapshot".to_string()),
            error_summary: None,
            progress: inherited_progress.clone(),
        },
    )?;

    let result = (|| -> Result<ExportBuildResult, String> {
        let snapshot = read_catalog(&root_dir)?.ok_or_else(|| "文档目录快照不存在".to_string())?;
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
                    progress_updated_at: Some(iso_now()),
                    running_stage: None,
                    error_summary: None,
                    progress: inherited_progress.clone(),
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
                    "progress": inherited_progress
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
                "filesWritten": export_result.files_written,
                "exportedAt": export_result.exported_at,
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
                    running_stage: Some("export_snapshot".to_string()),
                    error_summary: Some(error.clone()),
                    progress: inherited_progress.clone(),
                },
            )?;
            Err(error)
        }
    }
}

// 标签导出属于标签任务，不得覆盖文档索引任务的完成时间和运行状态。
pub fn run_tag_export_worker(
    request: NativeExportRequest,
    progress: &mut dyn FnMut(&str, usize, Option<usize>),
) -> Result<Value, String> {
    let scope: DirtyScope = serde_json::from_value(request.dirty_scope)
        .map_err(|error| format!("标签导出 dirtyScope 无效：{error}"))?;
    let snapshot = read_catalog(&request.root_dir)?.ok_or_else(|| "文档目录快照不存在".to_string())?;
    let result = build_native_export_with_progress(&request.root_dir, &snapshot, &scope, progress)?;
    Ok(json!({
        "exportedAt": result.exported_at,
        "manifestPath": result.manifest_path,
        "filesWritten": result.files_written,
    }))
}

fn build_native_export(
    root_dir: &str,
    snapshot: &ExportCatalogSnapshot,
    dirty_scope: &DirtyScope,
) -> Result<ExportBuildResult, String> {
    build_native_export_with_progress(root_dir, snapshot, dirty_scope, &mut |_, _, _| {})
}

fn build_native_export_with_progress(
    root_dir: &str,
    snapshot: &ExportCatalogSnapshot,
    dirty_scope: &DirtyScope,
    progress: &mut dyn FnMut(&str, usize, Option<usize>),
) -> Result<ExportBuildResult, String> {
    let export_dir = native_export_dir(root_dir);
    fs::create_dir_all(&export_dir).map_err(|error| error.to_string())?;
    let manifest_path = export_dir.join("manifest.json");
    let previous = read_optional_json_file::<ExportManifest>(&manifest_path)?;
    let full = dirty_scope.trigger == "full"
        || previous
            .as_ref()
            .map_or(true, |m| m.layout != "directory-v2");
    let changed = dirty_scope
        .changed_paths
        .iter()
        .chain(&dirty_scope.deleted_paths)
        .cloned()
        .collect::<BTreeSet<_>>();
    if !full && changed.is_empty() {
        let manifest = previous.unwrap();
        return Ok(ExportBuildResult {
            manifest_path: manifest_path.to_string_lossy().to_string(),
            output_dir: export_dir.to_string_lossy().to_string(),
            exported_at: manifest.generated_at,
            meta_shard_count: manifest.meta_shards.len(),
            detail_shard_count: manifest.detail_shards.len(),
            tag_shard_count: manifest.tag_shards.len(),
            relation_group_count: manifest.relation_shards.len(),
            search_bucket_count: manifest.search_buckets.len(),
            files_written: Vec::new(),
        });
    }
    let exported_at = iso_now();
    let mut files_written = Vec::new();
    let dirty_directories = changed
        .iter()
        .map(|path| normalize_directory(path))
        .collect::<BTreeSet<_>>();
    let mut dirty_tags = BTreeSet::new();
    let mut dirty_relation_tags = BTreeSet::new();
    let mut relation_targets = BTreeSet::new();
    let mut stale_paths = BTreeSet::new();
    let current_by_path = snapshot
        .documents
        .iter()
        .map(|document| (document.path.as_str(), document))
        .collect::<HashMap<_, _>>();
    let previous_by_path = previous
        .as_ref()
        .into_iter()
        .flat_map(|manifest| &manifest.detail_shards)
        .map(|detail| (detail.document_path.as_str(), detail))
        .collect::<HashMap<_, _>>();
    let mut structure_changed = full;
    if !full {
        for path in &changed {
            let old_ref = previous_by_path.get(path.as_str());
            let new = current_by_path.get(path.as_str());
            structure_changed |= old_ref.is_none() != new.is_none();
            let old = match old_ref {
                Some(detail) => read_optional_json_file::<Value>(&export_dir.join(&detail.path))?,
                None => None,
            };
            let old_document = old.as_ref().map(|payload| &payload["document"]);
            let tags_changed = match (old_document, new) {
                (Some(old), Some(new)) => {
                    old["direct_tags"] != json!(new.tags)
                        || old["derived_tags"] != json!(new.derived_tags)
                        || old["title"] != json!(new.title)
                }
                _ => true,
            };
            let relations_changed = match (old_document, new) {
                (Some(old), Some(new)) => old["direct_tags"] != json!(new.tags),
                _ => true,
            };
            if let Some(old) = old_document {
                if tags_changed {
                    dirty_tags.extend(
                        old["direct_tags"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .chain(old["derived_tags"].as_array().into_iter().flatten())
                            .filter_map(Value::as_str)
                            .map(str::to_string),
                    );
                }
                if relations_changed {
                    dirty_relation_tags.extend(
                        old["direct_tags"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .filter_map(Value::as_str)
                            .map(str::to_string),
                    );
                    relation_targets.insert(old["document_id"].as_str().unwrap().to_string());
                }
            }
            if let Some(new) = new {
                if tags_changed {
                    dirty_tags.extend(new.tags.iter().chain(&new.derived_tags).cloned());
                }
                if relations_changed {
                    dirty_relation_tags.extend(new.tags.iter().cloned());
                    relation_targets.insert(new.document_id.clone());
                }
            }
        }
    }
    for detail in previous
        .as_ref()
        .into_iter()
        .flat_map(|manifest| &manifest.detail_shards)
    {
        if full || changed.contains(&detail.document_path) {
            stale_paths.insert(detail.path.clone());
        }
    }
    for document in &snapshot.documents {
        if document
            .tags
            .iter()
            .any(|tag| dirty_relation_tags.contains(tag))
        {
            relation_targets.insert(document.document_id.clone());
        }
    }
    let dirty_roots = dirty_tags
        .iter()
        .map(|tag| infer_root_type(tag))
        .collect::<BTreeSet<_>>();
    let mut meta_shards = Vec::new();
    let mut detail_shards = Vec::new();
    let mut tag_shards = Vec::new();
    let mut relation_shards = Vec::new();
    if let Some(previous) = &previous {
        for meta in &previous.meta_shards {
            if full || dirty_directories.contains(&meta.directory) {
                stale_paths.insert(meta.path.clone());
            } else {
                meta_shards.push(meta.clone());
            }
        }
        detail_shards.extend(
            previous
                .detail_shards
                .iter()
                .filter(|d| !full && !changed.contains(&d.document_path))
                .cloned(),
        );
        for tag in &previous.tag_shards {
            if full || dirty_roots.contains(&tag.root_type) {
                stale_paths.insert(tag.path.clone());
                stale_paths.insert(tag.posting_path.clone());
            } else {
                tag_shards.push(tag.clone());
            }
        }
        for relation in &previous.relation_shards {
            let document_id = relation
                .path
                .trim_start_matches("relations/")
                .trim_end_matches(".json");
            if full || relation_targets.contains(document_id) {
                stale_paths.insert(relation.path.clone());
            } else {
                relation_shards.push(relation.clone());
            }
        }
    }
    let mut folders = BTreeMap::new();
    let mut by_directory = BTreeMap::<String, Vec<&SnapshotDocument>>::new();
    let detail_count = snapshot.documents.iter().filter(|document| full || changed.contains(&document.path)).count();
    progress("export_details", 0, Some(detail_count));
    for document in &snapshot.documents {
        let directory = normalize_directory(&document.path);
        bump_folder_counts(&mut folders, &directory);
        if full || dirty_directories.contains(&directory) {
            by_directory
                .entry(directory.clone())
                .or_default()
                .push(document);
        }
        if !full && !changed.contains(&document.path) {
            continue;
        }
        let relative = format!("detail/{}.json", document.document_id);
        let path = export_dir.join(&relative);
        write_json_file(
            &path,
            &json!({
                "version": 2, "shard_type": "detail", "exported_at": exported_at,
                "document": { "document_id": document.document_id, "path": document.path,
                    "title": document.title, "summary": document.summary, "mtime": document.mtime,
                    "direct_tags": document.tags, "derived_tags": document.derived_tags, "directory": directory }
            }),
        )?;
        files_written.push(path.to_string_lossy().to_string());
        stale_paths.remove(&relative);
        detail_shards.push(DetailShardManifestEntry {
            id: stable_id("detail", &document.path),
            document_id: document.document_id.clone(),
            document_path: document.path.clone(),
            path: relative,
        });
        progress("export_details", files_written.len(), Some(detail_count));
    }
    let directory_count = by_directory.len();
    progress("export_metadata", 0, Some(directory_count));
    for (index, (directory, mut documents)) in by_directory.into_iter().enumerate() {
        documents.sort_by(|a, b| a.path.cmp(&b.path));
        let id = stable_id("meta", &directory);
        let relative = format!("meta/{id}.json");
        let path = export_dir.join(&relative);
        let payload = documents.iter().map(|document| json!({
            "document_id": document.document_id, "path": document.path, "title": document.title,
            "summary": document.summary, "mtime": document.mtime, "direct_tags": document.tags,
            "derived_tags": document.derived_tags, "detail_ref": format!("detail/{}.json", document.document_id)
        })).collect::<Vec<_>>();
        write_json_file(
            &path,
            &json!({ "version": 2, "shard_type": "meta", "exported_at": exported_at,
            "directory": directory, "directories": [&directory], "documents": payload }),
        )?;
        files_written.push(path.to_string_lossy().to_string());
        stale_paths.remove(&relative);
        meta_shards.push(MetaShardManifestEntry {
            id,
            directory: directory.clone(),
            directories: vec![directory],
            path: relative,
            document_count: documents.len(),
        });
        progress("export_metadata", index + 1, Some(directory_count));
    }
    progress("export_tags", 0, None);
    let (new_tags, tag_files) = build_tag_shards(
        &export_dir,
        &exported_at,
        &snapshot.documents,
        &snapshot.tags,
        if full { None } else { Some(&dirty_roots) },
    )?;
    for tag in &new_tags {
        stale_paths.remove(&tag.path);
        stale_paths.remove(&tag.posting_path);
    }
    tag_shards.extend(new_tags);
    files_written.extend(tag_files);
    progress("export_relations", 0, None);
    let (new_relations, relation_files) = build_relation_shards(
        &export_dir,
        &exported_at,
        &snapshot.documents,
        if full { None } else { Some(&relation_targets) },
    )?;
    for relation in &new_relations {
        stale_paths.remove(&relation.path);
    }
    relation_shards.extend(new_relations);
    files_written.extend(relation_files);
    progress("export_search", 0, None);
    let (search_buckets, search_files) = build_search_index(
        &export_dir,
        &exported_at,
        &snapshot.documents,
        if full { None } else { Some(dirty_scope) },
    )?;
    files_written.extend(search_files);
    meta_shards.sort_by(|a, b| a.path.cmp(&b.path));
    detail_shards.sort_by(|a, b| a.document_path.cmp(&b.document_path));
    tag_shards.sort_by(|a, b| a.root_type.cmp(&b.root_type));
    relation_shards.sort_by(|a, b| a.path.cmp(&b.path));
    progress("publish_tag_results", 0, None);
    let taxonomy = build_taxonomy(&snapshot.tags);
    for (name, payload) in [
        (
            "status.json",
            json!({ "version": 2, "format": "static-v2", "exported_at": exported_at,
            "document_count": detail_shards.len(), "meta_shard_count": meta_shards.len(),
            "detail_shard_count": detail_shards.len(), "tag_shard_count": tag_shards.len(),
            "relation_group_count": relation_shards.len(), "search_bucket_count": search_buckets.len(), "dirty_scope": dirty_scope }),
        ),
        (
            "taxonomy.json",
            json!({ "version": 2, "format": "static-v2", "exported_at": exported_at,
            "root_types": taxonomy.0, "nodes": taxonomy.1, "tree": taxonomy.2 }),
        ),
        (
            "relations.json",
            json!({ "version": 2, "format": "static-v2", "exported_at": exported_at, "groups": relation_shards }),
        ),
        (
            "bootstrap.json",
            json!({ "version": 2, "format": "static-v2-bootstrap", "exported_at": exported_at,
            "folders": folders.into_values().collect::<Vec<_>>() }),
        ),
    ] {
        if !full
            && ((name == "bootstrap.json" && !structure_changed)
                || (name == "taxonomy.json" && dirty_roots.is_empty())
                || (name == "relations.json" && relation_targets.is_empty()))
        {
            continue;
        }
        let path = export_dir.join(name);
        write_json_file(&path, &payload)?;
        files_written.push(path.to_string_lossy().to_string());
    }
    let manifest = ExportManifest {
        layout: "directory-v2".to_string(),
        generated_at: exported_at.clone(),
        entries: json!({ "status": "status.json", "taxonomy": "taxonomy.json", "relations": "relations.json",
            "bootstrap": "bootstrap.json", "search_manifest": SEARCH_MANIFEST_RELATIVE_PATH }),
        meta_shards,
        detail_shards,
        tag_shards,
        relation_shards,
        search_buckets,
    };
    let mut manifest_json = serde_json::to_value(&manifest).map_err(|error| error.to_string())?;
    manifest_json["version"] = json!(2);
    manifest_json["format"] = json!("static-v2");
    write_json_file(&manifest_path, &manifest_json)?;
    files_written.push(manifest_path.to_string_lossy().to_string());
    for relative in stale_paths {
        let path = export_dir.join(relative);
        if path.is_file() {
            fs::remove_file(path).map_err(|error| error.to_string())?;
        }
    }
    Ok(ExportBuildResult {
        manifest_path: manifest_path.to_string_lossy().to_string(),
        output_dir: export_dir.to_string_lossy().to_string(),
        exported_at,
        meta_shard_count: manifest.meta_shards.len(),
        detail_shard_count: manifest.detail_shards.len(),
        tag_shard_count: manifest.tag_shards.len(),
        relation_group_count: manifest.relation_shards.len(),
        search_bucket_count: manifest.search_buckets.len(),
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
    (root_types.into_iter().collect(), nodes, tree)
}

fn build_tree_node(
    path: &str,
    by_path: &BTreeMap<String, Value>,
    children: &HashMap<String, Vec<Value>>,
) -> Value {
    let mut node = by_path
        .get(path)
        .cloned()
        .unwrap_or_else(|| json!({ "path": path }));
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
    target_roots: Option<&BTreeSet<String>>,
) -> Result<(Vec<TagShardManifestEntry>, Vec<String>), String> {
    if target_roots.is_some_and(BTreeSet::is_empty) {
        return Ok((Vec::new(), Vec::new()));
    }
    let tag_map: HashMap<String, SnapshotTag> = tags
        .iter()
        .cloned()
        .map(|tag| (tag.path.clone(), tag))
        .collect();
    let mut tags_by_root = BTreeMap::<String, Vec<SnapshotTag>>::new();
    for tag in tags {
        if target_roots.is_some_and(|roots| !roots.contains(&tag.root_type)) {
            continue;
        }
        tags_by_root
            .entry(tag.root_type.clone())
            .or_default()
            .push(tag.clone());
    }

    let mut postings_by_root = BTreeMap::<String, BTreeMap<String, Vec<Value>>>::new();
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
            if target_roots.is_some_and(|roots| !roots.contains(&root_type)) {
                continue;
            }
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
    target_documents: Option<&BTreeSet<String>>,
) -> Result<(Vec<RelationShardManifestEntry>, Vec<String>), String> {
    if target_documents.is_some_and(BTreeSet::is_empty) {
        return Ok((Vec::new(), Vec::new()));
    }
    let mut by_direct_tag = BTreeMap::<String, Vec<&SnapshotDocument>>::new();
    for document in documents {
        for tag_path in &document.tags {
            if !is_relation_eligible_tag(tag_path) {
                continue;
            }
            by_direct_tag
                .entry(tag_path.clone())
                .or_default()
                .push(document);
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
                if target_documents.map_or(true, |ids| ids.contains(&left.document_id)) {
                    merge_relation_pair(&mut relation_map, left, right, &tag_path);
                }
                if target_documents.map_or(true, |ids| ids.contains(&right.document_id)) {
                    merge_relation_pair(&mut relation_map, right, left, &tag_path);
                }
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
    let mut heartbeat: Option<&mut dyn FnMut() -> Result<(), String>> = None;
    build_search_index_with_progress(
        export_dir,
        exported_at,
        documents,
        dirty_scope,
        &mut heartbeat,
    )
}

fn build_search_index_with_progress(
    export_dir: &Path,
    exported_at: &str,
    documents: &[SnapshotDocument],
    dirty_scope: Option<&DirtyScope>,
    heartbeat: &mut Option<&mut dyn FnMut() -> Result<(), String>>,
) -> Result<(Vec<SearchBucketManifestEntry>, Vec<String>), String> {
    let search_dir = export_dir.join("search");
    fs::create_dir_all(&search_dir).map_err(|error| error.to_string())?;
    let previous =
        read_optional_json_file::<SearchManifestFile>(&search_dir.join("manifest.json"))?;
    let incremental = dirty_scope.is_some_and(|scope| scope.trigger != "full")
        && previous.as_ref().is_some_and(|manifest| {
            manifest.format == "search-v2" && manifest.partition_count == SEARCH_PARTITION_COUNT
        });
    let changed = dirty_scope
        .map(|scope| {
            scope
                .changed_paths
                .iter()
                .chain(&scope.deleted_paths)
                .cloned()
                .collect::<BTreeSet<_>>()
        })
        .unwrap_or_default();
    if incremental && changed.is_empty() {
        return Ok((previous.unwrap().buckets, Vec::new()));
    }
    let mut document_index = if incremental {
        previous.as_ref().unwrap().document_index.clone()
    } else {
        BTreeMap::new()
    };
    let mut target_buckets = BTreeSet::new();
    let mut replaced_paths = BTreeSet::new();
    let mut present_paths = BTreeSet::new();
    let mut additions = BTreeMap::<String, Vec<(SearchDocumentEntry, Vec<String>)>>::new();
    for (index, document) in documents.iter().enumerate() {
        if incremental && !changed.contains(&document.path) {
            continue;
        }
        present_paths.insert(document.path.clone());
        let mut tokens = tokenize_document(document).into_iter().collect::<Vec<_>>();
        tokens.sort();
        let terms_hash = format!("{:x}", Sha256::digest(tokens.join("\0").as_bytes()));
        if incremental
            && document_index.get(&document.path).is_some_and(|old| {
                old.document_id == document.document_id && old.terms_hash == terms_hash
            })
        {
            continue;
        }
        replaced_paths.insert(document.path.clone());
        if let Some(old) = document_index.remove(&document.path) {
            target_buckets.extend(old.buckets);
        }
        let partition = Sha256::digest(document.document_id.as_bytes())[0] % SEARCH_PARTITION_COUNT;
        let mut by_bucket = BTreeMap::<String, Vec<String>>::new();
        for term in tokens {
            by_bucket
                .entry(format!("{}-{partition:02x}", build_bucket_name(&term)))
                .or_default()
                .push(term);
        }
        document_index.insert(
            document.path.clone(),
            DocumentSearchState {
                document_id: document.document_id.clone(),
                buckets: by_bucket.keys().cloned().collect(),
                terms_hash,
            },
        );
        let entry = SearchDocumentEntry {
            document_id: document.document_id.clone(),
            path: document.path.clone(),
        };
        for (bucket, terms) in by_bucket {
            target_buckets.insert(bucket.clone());
            additions
                .entry(bucket)
                .or_default()
                .push((entry.clone(), terms));
        }
        if index % 128 == 0 {
            if let Some(callback) = heartbeat.as_deref_mut() {
                callback()?;
            }
        }
    }
    if incremental {
        for path in changed.difference(&present_paths) {
            if let Some(old) = document_index.remove(path) {
                target_buckets.extend(old.buckets);
                replaced_paths.insert(path.clone());
            }
        }
        if replaced_paths.is_empty() {
            return Ok((previous.unwrap().buckets, Vec::new()));
        }
    }
    let mut manifest = if incremental {
        previous
            .as_ref()
            .unwrap()
            .buckets
            .iter()
            .cloned()
            .map(|bucket| (bucket.bucket.clone(), bucket))
            .collect::<BTreeMap<_, _>>()
    } else {
        BTreeMap::new()
    };
    let mut files_written = Vec::new();
    for bucket in target_buckets {
        let path = search_dir.join(format!("{bucket}.json"));
        let old = if incremental {
            read_optional_json_file::<SearchBucketFile>(&path)?
        } else {
            None
        };
        let mut docs = BTreeMap::new();
        let mut terms = BTreeMap::<String, BTreeSet<String>>::new();
        if let Some(old) = old {
            let removed = old
                .documents
                .iter()
                .filter(|doc| replaced_paths.contains(&doc.path))
                .map(|doc| doc.document_id.clone())
                .collect::<BTreeSet<_>>();
            for document in old.documents {
                if !removed.contains(&document.document_id) {
                    docs.insert(document.document_id.clone(), document);
                }
            }
            for term in old.terms {
                let posting = term
                    .document_ids
                    .into_iter()
                    .filter(|id| !removed.contains(id))
                    .collect::<BTreeSet<_>>();
                if !posting.is_empty() {
                    terms.insert(term.term, posting);
                }
            }
        }
        for (document, tokens) in additions.remove(&bucket).unwrap_or_default() {
            for token in tokens {
                terms
                    .entry(token)
                    .or_default()
                    .insert(document.document_id.clone());
            }
            docs.insert(document.document_id.clone(), document);
        }
        if docs.is_empty() {
            manifest.remove(&bucket);
            if path.is_file() {
                fs::remove_file(&path).map_err(|error| error.to_string())?;
            }
            continue;
        }
        let mut docs = docs.into_values().collect::<Vec<_>>();
        docs.sort_by(|a, b| a.path.cmp(&b.path));
        let terms = terms
            .into_iter()
            .map(|(term, posting)| SearchTermEntry {
                term,
                document_count: posting.len(),
                document_ids: posting.into_iter().collect(),
            })
            .collect::<Vec<_>>();
        write_search_bucket_file(&path, exported_at, &bucket, &docs, &terms, heartbeat)?;
        manifest.insert(
            bucket.clone(),
            SearchBucketManifestEntry {
                bucket: bucket.clone(),
                path: format!("search/{bucket}.json"),
                term_count: terms.len(),
            },
        );
        files_written.push(path.to_string_lossy().to_string());
    }
    if !incremental {
        if let Some(previous) = previous {
            for old in previous.buckets {
                if !manifest.contains_key(&old.bucket) {
                    let path = export_dir.join(old.path);
                    if path.is_file() {
                        fs::remove_file(path).map_err(|error| error.to_string())?;
                    }
                }
            }
        }
    }
    let buckets = manifest.into_values().collect::<Vec<_>>();
    let manifest_path = search_dir.join("manifest.json");
    write_json_file(
        &manifest_path,
        &SearchManifestFile {
            partition_count: SEARCH_PARTITION_COUNT,
            version: 2,
            format: "search-v2".to_string(),
            generated_at: exported_at.to_string(),
            buckets: buckets.clone(),
            document_index,
        },
    )?;
    files_written.push(manifest_path.to_string_lossy().to_string());
    Ok((buckets, files_written))
}

#[derive(Deserialize)]
struct SearchBucketFile {
    documents: Vec<SearchDocumentEntry>,
    terms: Vec<SearchTermEntry>,
}

fn write_search_bucket_file(
    path: &Path,
    exported_at: &str,
    bucket: &str,
    documents: &[SearchDocumentEntry],
    terms: &[SearchTermEntry],
    heartbeat: &mut Option<&mut dyn FnMut() -> Result<(), String>>,
) -> Result<(), String> {
    #[derive(Serialize)]
    struct Bucket<'a> {
        version: u32,
        format: &'a str,
        generated_at: &'a str,
        bucket: &'a str,
        documents: &'a [SearchDocumentEntry],
        terms: &'a [SearchTermEntry],
    }
    if let Some(callback) = heartbeat.as_deref_mut() {
        callback()?;
    }
    write_compact_json(
        path,
        &Bucket {
            version: 2,
            format: "search-bucket-v2",
            generated_at: exported_at,
            bucket,
            documents,
            terms,
        },
    )
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

    let compact = source
        .chars()
        .filter(|ch| !ch.is_whitespace())
        .collect::<String>();
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

fn bump_folder_counts(folder_map: &mut BTreeMap<String, FolderBootstrapNode>, directory: &str) {
    let normalized = if directory.is_empty() { "." } else { directory };
    {
        let node =
            folder_map
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

fn write_runtime_status(root_dir: &str, payload: PersistedRuntimeStatus) -> Result<(), String> {
    let path = runtime_status_path(root_dir);
    write_json_file(&path, &payload)
}

fn read_existing_runtime_progress(root_dir: &str) -> Result<Option<Value>, String> {
    let path = runtime_status_path(root_dir);
    let Some(payload) = read_optional_json_file::<Value>(&path)? else {
        return Ok(None);
    };
    Ok(payload.get("progress").cloned())
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

fn read_optional_json_file<T>(path: &PathBuf) -> Result<Option<T>, String>
where
    T: for<'de> Deserialize<'de>,
{
    if !path.is_file() {
        return Ok(None);
    }
    read_json_file(path).map(Some)
}

fn write_json_file<T: Serialize>(path: &PathBuf, value: &T) -> Result<(), String> {
    write_compact_json(path, value)
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
    value
        .get(key)
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::{
        build_native_export, build_search_index, build_search_index_with_progress, read_json_file,
        write_runtime_status, DirtyScope, ExportCatalogSnapshot, PersistedRuntimeStatus,
        SearchManifestFile, SnapshotDocument, SnapshotTag,
    };
    use crate::native_core::state_store::{runtime_status_path, SEARCH_MANIFEST_RELATIVE_PATH};
    use serde_json::Value;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn bucket_path(export: &std::path::Path, prefix: &str, document_id: &str) -> PathBuf {
        use sha2::{Digest, Sha256};
        export.join(format!(
            "search/{prefix}-{:02x}.json",
            Sha256::digest(document_id.as_bytes())[0] % 16
        ))
    }

    #[test]
    fn streaming_search_bucket_keeps_contract_and_reports_heartbeat() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time before unix epoch")
            .as_nanos();
        let temp_root =
            std::env::temp_dir().join(format!("x-file-native-search-streaming-{nonce}"));
        let export_dir = temp_root.join(".ai-index").join("exports");
        fs::create_dir_all(&export_dir).expect("create export dir");
        let documents = (0..260)
            .map(|index| SnapshotDocument {
                document_id: format!("doc_{index}"),
                path: format!("docs/{index}.md"),
                title: format!("中文标题{index}"),
                summary: "中文搜索内容".to_string(),
                tags: Vec::new(),
                derived_tags: Vec::new(),
                mtime: "2026-07-22T00:00:00Z".to_string(),
            })
            .collect::<Vec<_>>();
        let mut heartbeat_count = 0usize;
        {
            let mut heartbeat = || {
                heartbeat_count += 1;
                Ok(())
            };
            let mut heartbeat_callback: Option<&mut dyn FnMut() -> Result<(), String>> =
                Some(&mut heartbeat);
            build_search_index_with_progress(
                &export_dir,
                "2026-07-22T00:00:00Z",
                &documents,
                None,
                &mut heartbeat_callback,
            )
            .expect("build streaming search index");
        }

        let manifest: SearchManifestFile =
            read_json_file(&export_dir.join("search/manifest.json")).unwrap();
        let mut count = 0;
        for entry in manifest
            .buckets
            .iter()
            .filter(|entry| entry.bucket.starts_with("han-"))
        {
            let bucket: Value = read_json_file(&export_dir.join(&entry.path)).unwrap();
            assert_eq!(bucket["format"], "search-bucket-v2");
            count += bucket["documents"].as_array().unwrap().len();
            assert!(!bucket["terms"].as_array().unwrap().is_empty());
        }
        assert_eq!(count, 260);
        assert!(heartbeat_count >= 6);
        fs::remove_dir_all(&temp_root).ok();
    }

    #[test]
    fn incremental_search_only_reuses_unchanged_buckets_and_rebuilds_dirty_bucket() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time before unix epoch")
            .as_nanos();
        let temp_root =
            std::env::temp_dir().join(format!("x-file-native-search-incremental-{nonce}"));
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

        let banana_bucket_path = bucket_path(&export_dir, "b", "doc_b");
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
        assert!(buckets.iter().any(|bucket| bucket.starts_with("b-")));
        assert!(buckets.iter().any(|bucket| bucket.starts_with("c-")));

        let after_banana_bucket = fs::read_to_string(&banana_bucket_path)
            .expect("read unchanged bucket after incremental rebuild");
        assert_eq!(after_banana_bucket, before_banana_bucket);

        let cherry_bucket_path = bucket_path(&export_dir, "c", "doc_a");
        let cherry_bucket =
            fs::read_to_string(&cherry_bucket_path).expect("read rebuilt dirty bucket");
        assert!(cherry_bucket.contains("\"doc_a\""));

        let rebuilt_alpha_bucket_path = bucket_path(&export_dir, "a", "doc_a");
        let rebuilt_alpha_bucket =
            fs::read_to_string(&rebuilt_alpha_bucket_path).expect("read rebuilt alpha bucket");
        assert!(rebuilt_alpha_bucket.contains("\"doc_a\""));
        assert_eq!(rebuilt_alpha_bucket.contains("apple"), false);

        fs::remove_dir_all(&temp_root).ok();
    }

    #[test]
    fn incremental_search_rebuilds_summary_terms_after_document_change() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time before unix epoch")
            .as_nanos();
        let temp_root =
            std::env::temp_dir().join(format!("x-file-native-search-document-change-{nonce}"));
        if temp_root.exists() {
            fs::remove_dir_all(&temp_root).ok();
        }
        let export_dir = temp_root.join(".ai-index").join("exports");
        fs::create_dir_all(&export_dir).expect("create export dir");

        let initial_documents = vec![SnapshotDocument {
            document_id: "doc_a".to_string(),
            path: "docs/a.md".to_string(),
            title: "Alpha".to_string(),
            summary: "".to_string(),
            tags: Vec::new(),
            derived_tags: Vec::new(),
            mtime: "2026-06-17T00:00:00Z".to_string(),
        }];
        build_search_index(
            &export_dir,
            "2026-06-17T00:00:00Z",
            &initial_documents,
            None,
        )
        .expect("build initial search index");

        let updated_documents = vec![SnapshotDocument {
            document_id: "doc_a".to_string(),
            path: "docs/a.md".to_string(),
            title: "Alpha".to_string(),
            summary: "gamma delta".to_string(),
            tags: Vec::new(),
            derived_tags: Vec::new(),
            mtime: "2026-06-17T00:00:00Z".to_string(),
        }];
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

        let gamma_bucket_path = bucket_path(&export_dir, "g", "doc_a");
        let gamma_bucket = fs::read_to_string(&gamma_bucket_path)
            .expect("read rebuilt gamma bucket after document change");
        fs::remove_dir_all(&temp_root).ok();

        assert!(gamma_bucket.contains("\"gamma\""));
        assert!(gamma_bucket.contains("\"doc_a\""));
    }

    #[test]
    fn 旧前缀搜索桶迁移为文档分片且删除旧文件() {
        let root =
            std::env::temp_dir().join(format!("x-file-search-migrate-{}", crate::epoch_millis()));
        let export = root.join(".ai-index/exports");
        fs::create_dir_all(export.join("search")).unwrap();
        crate::write_json_file(&export.join("search/manifest.json"), &serde_json::json!({
            "version": 2, "format": "search-v2", "generated_at": "old",
            "document_index": {}, "buckets": [{"bucket":"a", "path":"search/a.json", "term_count":1}]
        })).unwrap();
        fs::write(export.join("search/a.json"), "{}").unwrap();
        let document = SnapshotDocument {
            document_id: "doc_a".to_string(),
            path: "a.md".to_string(),
            title: "alpha".to_string(),
            summary: "newterm".to_string(),
            tags: vec![],
            derived_tags: vec![],
            mtime: "now".to_string(),
        };
        let dirty = DirtyScope {
            trigger: "incremental".to_string(),
            changed_paths: vec!["a.md".to_string()],
            deleted_paths: vec![],
            dirty_directories: vec![],
            dirty_tag_paths: vec![],
            dirty_meta_shards: vec![],
            dirty_detail_shards: vec![],
            dirty_posting_buckets: vec![],
            dirty_relations: vec![],
        };
        build_search_index(&export, "now", &[document], Some(&dirty)).unwrap();
        let manifest: SearchManifestFile =
            read_json_file(&export.join("search/manifest.json")).unwrap();
        assert_eq!(manifest.partition_count, 16);
        assert!(!export.join("search/a.json").exists());
        assert!(fs::read_to_string(bucket_path(&export, "n", "doc_a"))
            .unwrap()
            .contains("newterm"));
        fs::remove_dir_all(root).unwrap();
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
            generated_at: Some("2026-10-26T00:00:00Z".to_string()),
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
        let manifest_path = root_dir.join(".ai-index/exports/manifest.json");
        assert!(result
            .files_written
            .iter()
            .any(|item| item == &manifest_path.to_string_lossy().to_string()));

        let manifest = read_json_file::<Value>(&manifest_path).expect("read manifest");
        assert_eq!(manifest.get("version").and_then(Value::as_u64), Some(2));
        assert_eq!(
            manifest.get("format").and_then(Value::as_str),
            Some("static-v2")
        );
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
        assert!(root_dir
            .join(".ai-index/exports/search/manifest.json")
            .is_file());
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
                progress_updated_at: Some("2026-06-18T10:00:02Z".to_string()),
                running_stage: None,
                error_summary: None,
                progress: None,
            },
        )
        .expect("write runtime status");

        let status = read_json_file::<Value>(&runtime_status_path(&root_dir.to_string_lossy()))
            .expect("read runtime status");
        assert_eq!(
            status.get("state").and_then(Value::as_str),
            Some("cooldown")
        );
        assert_eq!(
            status.get("lastRequestedAt").and_then(Value::as_str),
            Some("2026-06-18T10:00:00Z"),
        );
        assert!(status.get("progress").is_some());
    }
}

#[cfg(test)]
mod incremental_export_tests {
    use super::*;

    #[test]
    fn 局部删除清理关系且保留未受影响的分片() {
        let root =
            std::env::temp_dir().join(format!("x-file-export-delta-{}", crate::epoch_millis()));
        let make_document = |id: &str, path: &str, tags: Vec<String>| SnapshotDocument {
            document_id: id.to_string(),
            path: path.to_string(),
            title: id.to_string(),
            summary: "alpha".to_string(),
            tags,
            derived_tags: Vec::new(),
            mtime: iso_now(),
        };
        let tag = SnapshotTag {
            path: "项目/测试".to_string(),
            name: "测试".to_string(),
            root_type: "项目".to_string(),
            parent_path: Some("项目".to_string()),
            depth: 1,
        };
        let mut snapshot = ExportCatalogSnapshot {
            version: 1,
            generated_at: Some("2026-10-26T00:00:00Z".to_string()),
            tags: vec![tag],
            documents: vec![
                make_document("a", "docs/a.md", vec!["项目/测试".to_string()]),
                make_document("b", "docs/b.md", vec!["项目/测试".to_string()]),
                make_document("c", "other/c.md", Vec::new()),
            ],
        };
        let mut scope = DirtyScope {
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
        let initial = build_native_export(root.to_str().unwrap(), &snapshot, &scope).unwrap();
        let directory = native_export_dir(root.to_str().unwrap());
        let manifest: ExportManifest =
            read_json_file(&PathBuf::from(initial.manifest_path)).unwrap();
        let untouched = directory.join(
            &manifest
                .meta_shards
                .iter()
                .find(|shard| shard.directory == "other")
                .unwrap()
                .path,
        );
        let before = fs::read(&untouched).unwrap();
        assert!(directory.join("relations/a.json").exists());
        assert!(directory.join("relations/b.json").exists());
        snapshot.documents.remove(0);
        scope.trigger = "incremental".to_string();
        scope.deleted_paths = vec!["docs/a.md".to_string()];
        let result = build_native_export(root.to_str().unwrap(), &snapshot, &scope).unwrap();
        assert_eq!(fs::read(&untouched).unwrap(), before);
        assert!(!result
            .files_written
            .contains(&untouched.to_string_lossy().to_string()));
        assert!(!directory.join("detail/a.json").exists());
        assert!(!directory.join("relations/a.json").exists());
        assert!(!directory.join("relations/b.json").exists());
        let search: SearchManifestFile =
            read_json_file(&directory.join("search/manifest.json")).unwrap();
        assert!(!search.document_index.contains_key("docs/a.md"));
        for bucket in search.buckets {
            let payload: SearchBucketFile = read_json_file(&directory.join(bucket.path)).unwrap();
            assert!(payload
                .documents
                .iter()
                .all(|document| document.document_id != "a"));
            assert!(payload
                .terms
                .iter()
                .all(|term| !term.document_ids.iter().any(|id| id == "a")));
        }
        fs::remove_dir_all(root).unwrap();
    }
}
