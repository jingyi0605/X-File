use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::PathBuf;

use super::{scheduler::lock_root, task_center};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::{
    file_name_from_path, iso_now, normalize_document_path, normalize_folder_path,
    normalize_optional_text, read_json_file, read_local_library_binding, read_optional_json_file,
    resolve_runtime_export_catalog_snapshot_path, sha256_hex,
    write_json_file, write_runtime_export_catalog_snapshot, x_file_data_dir, LocalLibraryBinding,
    LocalLibraryDocumentTagDetails, LocalLibraryFolderTagDetails, LocalLibraryTagDetailWithRules,
    LocalLibraryTagListResult, LocalLibraryTagListSummary, LocalLibraryTagRecommendation,
    LocalLibraryTagRecomputeStatus, LocalLibraryTagRecomputeTask, LocalLibraryTagRuleView,
    LocalResolvedTagSource, LocalRuntimeExportCatalogSnapshot, LocalRuntimeSnapshotDocument,
    LocalRuntimeSnapshotTag, LocalSuppressedTagSource, LocalStoredDocumentTagBinding, LocalStoredFolderTagBinding,
    LocalStoredLibraryTags, LocalStoredTagDefinition, LocalStoredTagRule, MetaDocument,
};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeSaveDocumentTagsRequest {
    pub document_id: String,
    pub tag_ids: Option<Vec<String>>,
    pub create_tag_paths: Option<Vec<String>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeFolderTagDetailsRequest {
    pub folder_path: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeSaveFolderTagsRequest {
    pub folder_path: Option<String>,
    pub tag_ids: Option<Vec<String>>,
    pub create_tag_paths: Option<Vec<String>>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum TagAssignmentScope {
    #[default]
    Full,
    Document {
        #[serde(rename = "documentId")]
        document_id: String,
    },
    Folder {
        #[serde(rename = "folderPath")]
        folder_path: String,
    },
}

impl TagAssignmentScope {
    fn contains(&self, document: &LocalRuntimeSnapshotDocument) -> bool {
        let path = normalize_document_path(&document.path);
        match self {
            Self::Full => true,
            Self::Document { document_id } => document.document_id == document_id.trim()
                || path == normalize_document_path(document_id),
            Self::Folder { folder_path } => {
                let folder = normalize_folder_path(folder_path);
                folder == "." || path.starts_with(&format!("{folder}/"))
            }
        }
    }
}

pub struct TagAssignmentPlan {
    snapshot: LocalRuntimeExportCatalogSnapshot,
    targets: Vec<usize>,
    emit_progress: bool,
}

fn report_tag_progress(stage: &str, processed: usize, total: Option<usize>, emit: bool) {
    task_center::stage(stage);
    task_center::progress(processed, total);
    if emit {
        eprintln!("[x-file-tag-progress] {}", json!({
            "stage": stage, "processedCount": processed, "totalCount": total,
        }));
    }
}

pub fn prepare_tag_assignment(
    binding: &LocalLibraryBinding,
    scope: &TagAssignmentScope,
    emit_progress: bool,
) -> Result<TagAssignmentPlan, String> {
    report_tag_progress("count_tag_files", 0, None, emit_progress);
    let snapshot = match read_runtime_export_catalog_snapshot_core(&binding.root_dir)? {
        Some(snapshot) => snapshot,
        None => {
            let documents = read_local_tag_documents_core(binding)?.into_iter().map(|document| {
                LocalRuntimeSnapshotDocument {
                    title: document.title.unwrap_or_else(|| file_name_from_path(&document.path)),
                    document_id: document.document_id,
                    path: document.path,
                    summary: document.summary.unwrap_or_default(),
                    tags: document.direct_tags.unwrap_or_default(),
                    derived_tags: document.derived_tags.unwrap_or_default(),
                    mtime: document.mtime.unwrap_or_default(),
                }
            }).collect();
            LocalRuntimeExportCatalogSnapshot {
                version: 1, generated_at: None, generated_at_legacy: None,
                tags: Vec::new(), documents,
            }
        }
    };
    let targets = snapshot.documents.iter().enumerate()
        .filter_map(|(index, document)| scope.contains(document).then_some(index))
        .collect::<Vec<_>>();
    report_tag_progress("apply_tags", 0, Some(targets.len()), emit_progress);
    Ok(TagAssignmentPlan { snapshot, targets, emit_progress })
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeLibraryTagIdRequest {
    pub tag_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalStoredTagRuleDraft {
    pub id: Option<String>,
    pub relation: Option<String>,
    pub rule_type: Option<String>,
    pub matcher: Option<Value>,
    pub enabled: Option<bool>,
    pub priority: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeSaveLibraryTagDefinitionRequest {
    pub tag_id: Option<String>,
    pub name: Option<String>,
    pub parent_id: Option<String>,
    pub description: Option<String>,
    pub status: Option<String>,
    pub child_tag_selection_mode: Option<String>,
    pub smart_rules: Option<Vec<LocalStoredTagRuleDraft>>,
}

pub fn expand_local_tag_ancestor_paths(tag_path: &str) -> Vec<String> {
    let segments: Vec<&str> = tag_path
        .split('/')
        .map(str::trim)
        .filter(|segment| !segment.is_empty())
        .collect();
    let mut paths = Vec::new();
    for index in 1..=segments.len() {
        paths.push(segments[..index].join("/"));
    }
    paths
}

pub fn list_native_library_tag_details(include_disabled: bool) -> Result<Value, String> {
    serde_json::to_value(read_local_library_tag_list_result(include_disabled)?)
        .map_err(|error| format!("序列化本地 tag list 失败：{error}"))
}

pub fn get_native_library_tag_detail(tag_id: &str) -> Result<Value, String> {
    serde_json::to_value(read_local_library_tag_detail(tag_id)?)
        .map_err(|error| format!("序列化本地 tag detail 失败：{error}"))
}

fn run_tag_mutation<T>(
    source: &str,
    target: Option<String>,
    work: impl FnOnce(&LocalLibraryBinding) -> Result<T, String>,
) -> Result<T, String> {
    let binding = read_local_library_binding()?.ok_or_else(|| "当前未绑定文档库".to_string())?;
    run_tag_mutation_for_binding(&binding, source, target, work)
}

fn run_tag_mutation_for_binding<T>(
    binding: &LocalLibraryBinding,
    source: &str,
    target: Option<String>,
    work: impl FnOnce(&LocalLibraryBinding) -> Result<T, String>,
) -> Result<T, String> {
    task_center::run_new(&binding.root_dir, "library.tag_assignment", source, target, || {
        task_center::stage("waiting_for_lock");
        let _root_lock = lock_root(&binding.root_dir)?;
        task_center::stage("save_tags");
        work(&binding)
    })
}

pub fn ensure_native_library_tag(path: &str) -> Result<Value, String> {
    run_tag_mutation("external_agent_tag_ensured", None, |binding| {
    let mut store = read_local_library_tags_store(&binding)?;
    let count = store.tags.len();
    let id = ensure_local_tag_path(&mut store, path)?;
    if store.tags.len() != count {
        store.updated_at = iso_now();
        write_local_library_tags_store(&binding, &store)?;
        sync_local_tag_exports_core(&binding, "external_agent_tag_ensured")?;
    }
    get_native_library_tag_detail(&id)
    })
}

pub fn create_native_library_tag(
    request: NativeSaveLibraryTagDefinitionRequest,
) -> Result<Value, String> {
    serde_json::to_value(run_tag_mutation("native_tag_saved", None, |binding| save_local_library_tag(binding, None, request))?)
        .map_err(|error| format!("序列化本地 tag create 失败：{error}"))
}

pub fn update_native_library_tag(
    tag_id: String,
    request: NativeSaveLibraryTagDefinitionRequest,
) -> Result<Value, String> {
    serde_json::to_value(run_tag_mutation("native_tag_saved", None, |binding| save_local_library_tag(binding, Some(tag_id), request))?)
        .map_err(|error| format!("序列化本地 tag update 失败：{error}"))
}

pub fn delete_native_library_tag(tag_id: &str) -> Result<Value, String> {
    serde_json::to_value(run_tag_mutation("native_tag_deleted", None, |binding| delete_local_library_tag(binding, tag_id))?)
        .map_err(|error| format!("序列化本地 tag delete 失败：{error}"))
}

pub fn get_native_document_tag_details(document_id: &str) -> Result<Value, String> {
    serde_json::to_value(read_local_document_tag_details(document_id)?)
        .map_err(|error| format!("序列化本地 document tag details 失败：{error}"))
}

pub fn save_native_document_tags(request: NativeSaveDocumentTagsRequest) -> Result<Value, String> {
    serde_json::to_value(run_tag_mutation("native_document_tags_saved", Some(request.document_id.clone()), |binding| save_local_document_tags(binding, request))?)
        .map_err(|error| format!("序列化本地 document tags 失败：{error}"))
}

pub fn get_native_folder_tag_details(folder_path: &str) -> Result<Value, String> {
    serde_json::to_value(read_local_folder_tag_details(folder_path)?)
        .map_err(|error| format!("序列化本地 folder tag details 失败：{error}"))
}

pub fn save_native_folder_tags(request: NativeSaveFolderTagsRequest) -> Result<Value, String> {
    serde_json::to_value(run_tag_mutation("native_folder_tags_saved", request.folder_path.clone(), |binding| save_local_folder_tags(binding, request))?)
        .map_err(|error| format!("序列化本地 folder tags 失败：{error}"))
}

pub fn request_native_library_tag_recompute() -> Result<Value, String> {
    let task = run_tag_mutation("native_manual_tag_recompute", None, |binding| sync_local_tag_exports_core(binding, "native_manual_tag_recompute"))?;
    Ok(json!({
        "taskId": task.task_id,
        "deduped": false,
        "status": "queued"
    }))
}

pub fn get_native_library_tag_recompute_task() -> Result<Value, String> {
    let binding = match read_local_library_binding()? {
        Some(value) => value,
        None => return Ok(Value::Null),
    };
    serde_json::to_value(read_local_tag_recompute_task_core(&binding)?)
        .map_err(|error| format!("序列化本地 tag recompute task 失败：{error}"))
}

pub fn read_local_tag_recompute_task_core(
    binding: &LocalLibraryBinding,
) -> Result<Option<LocalLibraryTagRecomputeTask>, String> {
    let file_path = x_file_data_dir().join("library-tag-recompute-task.json");
    if !file_path.is_file() {
        return Ok(None);
    }
    let payload: HashMap<String, LocalLibraryTagRecomputeTask> = read_json_file(&file_path)?;
    Ok(payload.get(&local_library_tags_store_key(binding)).cloned())
}

pub fn write_local_tag_recompute_task_core(
    binding: &LocalLibraryBinding,
    task: &LocalLibraryTagRecomputeTask,
) -> Result<(), String> {
    let file_path = x_file_data_dir().join("library-tag-recompute-task.json");
    let mut payload = if file_path.is_file() {
        read_json_file::<HashMap<String, LocalLibraryTagRecomputeTask>>(&file_path)?
    } else {
        HashMap::new()
    };
    payload.insert(local_library_tags_store_key(binding), task.clone());
    write_json_file(&file_path, &payload)
}

pub fn read_local_library_tags_store(
    binding: &LocalLibraryBinding,
) -> Result<LocalStoredLibraryTags, String> {
    let file_path = x_file_data_dir().join("library-tags.json");
    if !file_path.is_file() {
        return Ok(empty_local_library_tags_store(binding));
    }
    let payload: HashMap<String, LocalStoredLibraryTags> = read_json_file(&file_path)?;
    Ok(payload
        .get(&local_library_tags_store_key(binding))
        .cloned()
        .unwrap_or_else(|| empty_local_library_tags_store(binding)))
}

pub fn write_local_library_tags_store(
    binding: &LocalLibraryBinding,
    store: &LocalStoredLibraryTags,
) -> Result<(), String> {
    let file_path = x_file_data_dir().join("library-tags.json");
    let mut payload = if file_path.is_file() {
        read_json_file::<HashMap<String, LocalStoredLibraryTags>>(&file_path)?
    } else {
        HashMap::new()
    };
    payload.insert(local_library_tags_store_key(binding), store.clone());
    write_json_file(&file_path, &payload)
}

pub fn local_library_tags_store_key(binding: &LocalLibraryBinding) -> String {
    format!("{}:{}", binding.library_id, binding.root_dir)
}

pub fn empty_local_library_tags_store(binding: &LocalLibraryBinding) -> LocalStoredLibraryTags {
    LocalStoredLibraryTags {
        library_id: binding.library_id.clone(),
        root_dir: binding.root_dir.clone(),
        tags: Vec::new(),
        tag_rules: Vec::new(),
        document_tags: Vec::new(),
        folder_tags: Vec::new(),
        updated_at: iso_now(),
    }
}

pub fn read_local_library_tag_list_result(
    include_disabled: bool,
) -> Result<LocalLibraryTagListResult, String> {
    let binding = read_local_library_binding()?.ok_or_else(|| "当前未绑定文档库".to_string())?;
    let store = read_local_library_tags_store(&binding)?;
    let documents = read_local_tag_documents_core(&binding).unwrap_or_default();
    let tag_counts = count_local_tags(&documents);
    let items = store
        .tags
        .iter()
        .filter(|tag| include_disabled || tag.status == "active")
        .map(|tag| map_local_tag_detail(tag, &store, &tag_counts))
        .collect::<Vec<_>>();
    let recompute_task = read_local_tag_recompute_task_core(&binding)?;
    let recompute_status = LocalLibraryTagRecomputeStatus {
        recompute_state: recompute_task
            .as_ref()
            .map(|task| task.state.clone())
            .unwrap_or_else(|| "idle".to_string()),
        last_recomputed_at: recompute_task
            .as_ref()
            .and_then(|task| task.completed_at.clone()),
        last_error: recompute_task.and_then(|task| task.error_summary),
    };
    Ok(LocalLibraryTagListResult {
        items,
        summary: LocalLibraryTagListSummary {
            total_active_tags: store
                .tags
                .iter()
                .filter(|tag| tag.status == "active")
                .count(),
            total_disabled_tags: store
                .tags
                .iter()
                .filter(|tag| tag.status == "disabled")
                .count(),
            total_rule_enabled_tags: store
                .tag_rules
                .iter()
                .filter(|rule| rule.enabled)
                .map(|rule| rule.tag_id.clone())
                .collect::<HashSet<_>>()
                .len(),
            total_bound_documents: store
                .document_tags
                .iter()
                .filter(|binding| !binding.manual_tag_ids.is_empty())
                .count(),
        },
        status: recompute_status,
    })
}

fn map_local_tag_detail(
    tag: &LocalStoredTagDefinition,
    store: &LocalStoredLibraryTags,
    tag_counts: &HashMap<String, usize>,
) -> LocalLibraryTagDetailWithRules {
    let smart_rules = store
        .tag_rules
        .iter()
        .filter(|rule| rule.tag_id == tag.id)
        .map(|rule| LocalLibraryTagRuleView {
            id: rule.id.clone(),
            relation: rule.relation.clone(),
            rule_type: rule.rule_type.clone(),
            matcher: rule.matcher.clone(),
            enabled: rule.enabled,
            priority: rule.priority,
        })
        .collect::<Vec<_>>();
    LocalLibraryTagDetailWithRules {
        id: tag.id.clone(),
        path: tag.path.clone(),
        name: tag.name.clone(),
        root_type: tag.root_type.clone(),
        parent_id: tag.parent_id.clone(),
        parent_path: tag.parent_path.clone(),
        description: tag.description.clone(),
        status: tag.status.clone(),
        document_count: *tag_counts.get(&tag.path).unwrap_or(&0),
        created_at: tag.created_at.clone(),
        updated_at: tag.updated_at.clone(),
        disabled_at: tag.disabled_at.clone(),
        child_tag_selection_mode: normalize_child_tag_selection_mode(
            tag.child_tag_selection_mode.as_deref(),
        )
        .unwrap_or("multiple")
        .to_string(),
        smart_rule_enabled: smart_rules.iter().any(|rule| rule.enabled),
        smart_rules,
    }
}

pub fn read_local_library_tag_detail(
    tag_id: &str,
) -> Result<LocalLibraryTagDetailWithRules, String> {
    let binding = read_local_library_binding()?.ok_or_else(|| "当前未绑定文档库".to_string())?;
    let store = read_local_library_tags_store(&binding)?;
    let documents = read_local_tag_documents_core(&binding).unwrap_or_default();
    let tag_counts = count_local_tags(&documents);
    let tag = store
        .tags
        .iter()
        .find(|item| item.id == tag_id.trim())
        .ok_or_else(|| "标签不存在".to_string())?;
    Ok(map_local_tag_detail(tag, &store, &tag_counts))
}

pub fn save_local_library_tag(
    binding: &LocalLibraryBinding,
    override_tag_id: Option<String>,
    request: NativeSaveLibraryTagDefinitionRequest,
) -> Result<LocalLibraryTagDetailWithRules, String> {
    let mut store = read_local_library_tags_store(&binding)?;
    let now = iso_now();
    let tag_id = override_tag_id.clone().or(request.tag_id.clone());
    let name = normalize_tag_segment(request.name.as_deref().unwrap_or(""));
    if name.is_empty() {
        return Err("标签名称不能为空".to_string());
    }
    let parent_id = request
        .parent_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string);
    let parent = parent_id
        .as_ref()
        .and_then(|id| store.tags.iter().find(|item| &item.id == id))
        .cloned();
    let path_value = parent
        .as_ref()
        .map(|item| format!("{}/{}", item.path, name))
        .unwrap_or_else(|| name.clone());
    let description = normalize_optional_text(request.description.as_deref());
    let status = normalize_tag_status(request.status.as_deref());
    let child_tag_selection_mode = request
        .child_tag_selection_mode
        .as_deref()
        .map(|value| normalize_child_tag_selection_mode(Some(value)))
        .transpose()?;
    let smart_rules = request.smart_rules.clone();

    if let Some(existing_id) = tag_id {
        let updated_tag_id;
        {
            let tag = store
                .tags
                .iter_mut()
                .find(|item| item.id == existing_id)
                .ok_or_else(|| "标签不存在".to_string())?;
            tag.name = name;
            tag.path = path_value.clone();
            tag.root_type = path_value.split('/').next().unwrap_or("").to_string();
            tag.parent_id = parent.as_ref().map(|item| item.id.clone());
            tag.parent_path = parent.as_ref().map(|item| item.path.clone());
            tag.description = description.clone();
            tag.status = status.clone();
            tag.disabled_at = if tag.status == "disabled" {
                Some(now.clone())
            } else {
                None
            };
            tag.updated_at = now.clone();
            if let Some(mode) = child_tag_selection_mode {
                tag.child_tag_selection_mode = Some(mode.to_string());
            }
            updated_tag_id = tag.id.clone();
        }
        replace_local_tag_rules(&mut store, &updated_tag_id, smart_rules);
    } else {
        let created_id = format!(
            "tag_{}",
            sha256_hex(format!("{}:{}", path_value, now).as_bytes())
        );
        store.tags.push(LocalStoredTagDefinition {
            id: created_id.clone(),
            path: path_value.clone(),
            name,
            root_type: path_value.split('/').next().unwrap_or("").to_string(),
            parent_id: parent.as_ref().map(|item| item.id.clone()),
            parent_path: parent.as_ref().map(|item| item.path.clone()),
            description,
            status: status.clone(),
            created_at: now.clone(),
            updated_at: now.clone(),
            disabled_at: if status == "disabled" {
                Some(now.clone())
            } else {
                None
            },
            child_tag_selection_mode: Some(
                child_tag_selection_mode.unwrap_or("multiple").to_string(),
            ),
        });
        replace_local_tag_rules(&mut store, &created_id, smart_rules);
    }
    store.updated_at = now;
    write_local_library_tags_store(&binding, &store)?;
    let _ = sync_local_tag_exports_core(&binding, "native_tag_saved")?;
    let target_id = request
        .tag_id
        .or(override_tag_id)
        .or_else(|| {
            store
                .tags
                .iter()
                .find(|item| item.path == path_value)
                .map(|item| item.id.clone())
        })
        .ok_or_else(|| "标签保存后无法定位".to_string())?;
    read_local_library_tag_detail(&target_id)
}

fn replace_local_tag_rules(
    store: &mut LocalStoredLibraryTags,
    tag_id: &str,
    drafts: Option<Vec<LocalStoredTagRuleDraft>>,
) {
    let Some(drafts) = drafts else {
        return;
    };
    store.tag_rules.retain(|rule| rule.tag_id != tag_id);
    for (index, draft) in drafts.into_iter().enumerate() {
        store.tag_rules.push(LocalStoredTagRule {
            id: draft
                .id
                .unwrap_or_else(|| format!("rule_{}_{}", tag_id, index)),
            tag_id: tag_id.to_string(),
            relation: normalize_rule_relation(draft.relation.as_deref()),
            rule_type: draft
                .rule_type
                .unwrap_or_else(|| "file_name_contains".to_string()),
            matcher: draft.matcher.unwrap_or_else(|| json!({})),
            enabled: draft.enabled.unwrap_or(true),
            priority: draft.priority.unwrap_or(index as i64),
        });
    }
}

pub fn delete_local_library_tag(binding: &LocalLibraryBinding, tag_id: &str) -> Result<Value, String> {
    let mut store = read_local_library_tags_store(&binding)?;
    let normalized = tag_id.trim();
    let mut deleted_ids = store
        .tags
        .iter()
        .filter(|tag| {
            tag.id == normalized || is_local_descendant_tag(&store.tags, normalized, &tag.id)
        })
        .map(|tag| tag.id.clone())
        .collect::<Vec<_>>();
    deleted_ids.sort();
    deleted_ids.dedup();
    store
        .tags
        .retain(|tag| !deleted_ids.iter().any(|id| id == &tag.id));
    store
        .tag_rules
        .retain(|rule| !deleted_ids.iter().any(|id| id == &rule.tag_id));
    for binding_record in &mut store.document_tags {
        binding_record
            .manual_tag_ids
            .retain(|id| !deleted_ids.iter().any(|item| item == id));
    }
    for folder_binding in &mut store.folder_tags {
        folder_binding
            .binding_tag_ids
            .retain(|id| !deleted_ids.iter().any(|item| item == id));
    }
    write_local_library_tags_store(&binding, &store)?;
    let _ = sync_local_tag_exports_core(&binding, "native_tag_deleted")?;
    Ok(json!({ "deletedTagIds": deleted_ids }))
}

pub fn read_local_document_tag_details(
    document_id: &str,
) -> Result<LocalLibraryDocumentTagDetails, String> {
    let binding = read_local_library_binding()?.ok_or_else(|| "当前未绑定文档库".to_string())?;
    let store = read_local_library_tags_store(&binding)?;
    let documents = read_local_tag_documents_core(&binding)?;
    let count_by_path = count_local_tags(&documents);
    let target = documents
        .into_iter()
        .find(|item| {
            item.document_id == document_id.trim()
                || normalize_document_path(&item.path) == normalize_document_path(document_id)
        })
        .ok_or_else(|| "文档不存在".to_string())?;
    let normalized_path = normalize_document_path(&target.path);
    let target_title = target
        .title
        .clone()
        .unwrap_or_else(|| file_name_from_path(&normalized_path));
    let manual_binding = store
        .document_tags
        .iter()
        .find(|item| item.document_id == target.document_id || item.path == normalized_path);
    let folder_bindings = collect_effective_folder_bindings(&store, &normalized_path);
    let mut excluded_tag_ids = manual_binding
        .map(|item| item.manual_tag_ids.clone())
        .unwrap_or_default();
    excluded_tag_ids.extend(folder_bindings.iter().filter_map(|binding| {
        binding
            .get("tagId")
            .and_then(Value::as_str)
            .map(ToString::to_string)
    }));
    let excluded_tag_paths = target
        .direct_tags
        .clone()
        .unwrap_or_default()
        .into_iter()
        .chain(target.derived_tags.clone().unwrap_or_default())
        .chain(folder_bindings.iter().filter_map(|binding| {
            binding
                .get("tagPath")
                .and_then(Value::as_str)
                .map(ToString::to_string)
        }))
        .collect::<HashSet<_>>();
    let mut resolved_tags = Vec::new();
    for tag_id in manual_binding
        .map(|item| item.manual_tag_ids.clone())
        .unwrap_or_default()
    {
        if let Some(tag) = store.tags.iter().find(|item| item.id == tag_id) {
            resolved_tags.push(LocalResolvedTagSource {
                path: tag.path.clone(),
                source_type: "manual_document".to_string(),
                source_ref: Some(target.document_id.clone()),
                evidence: Some("manual document binding".to_string()),
                confidence: 1.0,
                priority: 100,
            });
        }
    }
    for binding_value in &folder_bindings {
        resolved_tags.push(LocalResolvedTagSource {
            path: binding_value
                .get("tagPath")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            source_type: "folder_binding".to_string(),
            source_ref: binding_value
                .get("id")
                .and_then(Value::as_str)
                .map(ToString::to_string),
            evidence: Some("folder binding".to_string()),
            confidence: 1.0,
            priority: 80,
        });
    }
    let runtime_document = LocalRuntimeSnapshotDocument {
        document_id: target.document_id.clone(),
        title: target.title.clone().unwrap_or_else(|| target_title.clone()),
        path: normalized_path.clone(),
        summary: target.summary.clone().unwrap_or_default(),
        tags: target.direct_tags.clone().unwrap_or_default(),
        derived_tags: target.derived_tags.clone().unwrap_or_default(),
        mtime: target.mtime.clone().unwrap_or_default(),
    };
    for tag in store.tags.iter().filter(|tag| tag.status == "active") {
        let rules = store.tag_rules.iter()
            .filter(|rule| rule.enabled && rule.tag_id == tag.id)
            .collect::<Vec<_>>();
        if let Some(rule) = resolve_local_tag_rule(
            &runtime_document,
            LocalTagRecommendationTargetKind::Document,
            &rules,
        ) {
            resolved_tags.push(LocalResolvedTagSource {
                path: tag.path.clone(),
                source_type: "smart_rule".into(),
                source_ref: Some(rule.id.clone()),
                evidence: Some(local_tag_rule_evidence(rule)),
                confidence: 1.0,
                priority: 60,
            });
        }
    }
    for tag_path in &runtime_document.tags {
        if resolved_tags.iter().any(|source| source.path == *tag_path) {
            continue;
        }
        let Some(tag) = store.tags.iter().find(|tag| tag.path == *tag_path) else {
            continue;
        };
        let rules = store.tag_rules.iter()
            .filter(|rule| rule.enabled && rule.tag_id == tag.id)
            .collect::<Vec<_>>();
        let rule = resolve_local_tag_rule(
            &runtime_document,
            LocalTagRecommendationTargetKind::Document,
            &rules,
        );
        resolved_tags.push(LocalResolvedTagSource {
            path: tag.path.clone(),
            source_type: if rule.is_some() { "smart_rule" } else { "system_derived" }.into(),
            source_ref: rule.map(|rule| rule.id.clone()),
            evidence: rule.map(local_tag_rule_evidence),
            confidence: 1.0,
            priority: if rule.is_some() { 60 } else { 40 },
        });
    }
    for tag_path in &runtime_document.derived_tags {
        if resolved_tags.iter().any(|source| source.path == *tag_path) {
            continue;
        }
        resolved_tags.push(LocalResolvedTagSource {
            path: tag_path.clone(),
            source_type: "system_derived".into(),
            source_ref: None,
            evidence: Some("system-derived tag".into()),
            confidence: 1.0,
            priority: 40,
        });
    }
    let (resolved_tags, suppressed_tags) =
        resolve_local_tag_sources(&store, resolved_tags, &folder_bindings);
    Ok(LocalLibraryDocumentTagDetails {
        document_id: target.document_id,
        path: normalized_path.clone(),
        title: target
            .title
            .unwrap_or_else(|| file_name_from_path(&normalized_path)),
        manual_tag_ids: manual_binding
            .map(|item| item.manual_tag_ids.clone())
            .unwrap_or_default(),
        effective_folder_bindings: folder_bindings,
        resolved_tags,
        suppressed_tags,
        recommended_tags: build_local_tag_recommendations(
            &store,
            &LocalTagRecommendationTarget {
                kind: LocalTagRecommendationTargetKind::Document,
                path: &normalized_path,
                title: &target_title,
                summary: target.summary.as_deref().unwrap_or_default(),
                mtime: target.mtime.as_deref(),
            },
            excluded_tag_ids,
            excluded_tag_paths,
            &count_by_path,
        ),
    })
}

pub fn save_local_document_tags(
    binding: &LocalLibraryBinding,
    request: NativeSaveDocumentTagsRequest,
) -> Result<LocalLibraryDocumentTagDetails, String> {
    let plan = prepare_tag_assignment(binding, &TagAssignmentScope::Document {
        document_id: request.document_id.clone(),
    }, false)?;
    let mut store = read_local_library_tags_store(&binding)?;
    let target = plan.targets.first().map(|index| &plan.snapshot.documents[*index])
        .ok_or_else(|| "文档不存在".to_string())?;
    let document_id = target.document_id.clone();
    let normalized_path = normalize_document_path(&target.path);
    let title = target.title.clone();
    let mut tag_ids = normalize_tag_ids(&store, request.tag_ids.unwrap_or_default());
    for tag_path in request.create_tag_paths.unwrap_or_default() {
        let created_id = ensure_local_tag_path(&mut store, &tag_path)?;
        if !tag_ids.iter().any(|item| item == &created_id) {
            tag_ids.push(created_id);
        }
    }
    validate_single_child_tag_ids(&store, &tag_ids)?;
    set_task_tag_category(&store, &tag_ids);
    store
        .document_tags
        .retain(|item| item.document_id != document_id);
    store.document_tags.push(LocalStoredDocumentTagBinding {
        document_id: document_id.clone(),
        path: normalized_path.clone(),
        title,
        manual_tag_ids: tag_ids,
        updated_at: iso_now(),
    });
    store.updated_at = iso_now();
    write_local_library_tags_store(&binding, &store)?;
    let _ = sync_local_tag_exports_plan_core(binding, "native_document_tags_saved", &store, plan)?;
    read_local_document_tag_details(&document_id)
}

pub fn read_local_folder_tag_details(
    folder_path: &str,
) -> Result<LocalLibraryFolderTagDetails, String> {
    let binding = read_local_library_binding()?.ok_or_else(|| "当前未绑定文档库".to_string())?;
    let store = read_local_library_tags_store(&binding)?;
    let documents = read_local_tag_documents_core(&binding).unwrap_or_default();
    let count_by_path = count_local_tags(&documents);
    let normalized_folder = normalize_folder_path(folder_path);
    let folder_binding = store
        .folder_tags
        .iter()
        .find(|item| normalize_folder_path(&item.folder_path) == normalized_folder);
    let binding_tag_ids = folder_binding
        .map(|item| item.binding_tag_ids.clone())
        .unwrap_or_default();
    let bindings = binding_tag_ids
        .iter()
        .filter_map(|tag_id| store.tags.iter().find(|tag| &tag.id == tag_id))
        .map(|tag| {
            json!({
                "id": format!("folder:{}:{}", normalized_folder, tag.id),
                "tagId": tag.id,
                "tagPath": tag.path,
                "applyMode": "recursive"
            })
        })
        .collect::<Vec<_>>();
    let excluded_tag_paths = bindings
        .iter()
        .filter_map(|binding| {
            binding
                .get("tagPath")
                .and_then(Value::as_str)
                .map(ToString::to_string)
        })
        .collect::<HashSet<_>>();
    let folder_title = file_name_from_path(&normalized_folder);
    Ok(LocalLibraryFolderTagDetails {
        folder_path: normalized_folder.clone(),
        exists: true,
        binding_tag_ids: binding_tag_ids.clone(),
        bindings,
        recommended_tags: build_local_tag_recommendations(
            &store,
            &LocalTagRecommendationTarget {
                kind: LocalTagRecommendationTargetKind::Folder,
                path: &normalized_folder,
                title: &folder_title,
                summary: "",
                mtime: None,
            },
            binding_tag_ids,
            excluded_tag_paths,
            &count_by_path,
        ),
    })
}

pub fn save_local_folder_tags(
    binding: &LocalLibraryBinding,
    request: NativeSaveFolderTagsRequest,
) -> Result<LocalLibraryFolderTagDetails, String> {
    let plan = prepare_tag_assignment(binding, &TagAssignmentScope::Folder {
        folder_path: request.folder_path.clone().unwrap_or_else(|| ".".to_string()),
    }, false)?;
    let mut store = read_local_library_tags_store(&binding)?;
    let normalized_folder = normalize_folder_path(request.folder_path.as_deref().unwrap_or("."));
    let mut tag_ids = normalize_tag_ids(&store, request.tag_ids.unwrap_or_default());
    for tag_path in request.create_tag_paths.unwrap_or_default() {
        let created_id = ensure_local_tag_path(&mut store, &tag_path)?;
        if !tag_ids.iter().any(|item| item == &created_id) {
            tag_ids.push(created_id);
        }
    }
    validate_single_child_tag_ids(&store, &tag_ids)?;
    set_task_tag_category(&store, &tag_ids);
    store
        .folder_tags
        .retain(|item| normalize_folder_path(&item.folder_path) != normalized_folder);
    store.folder_tags.push(LocalStoredFolderTagBinding {
        folder_path: normalized_folder.clone(),
        binding_tag_ids: tag_ids,
        updated_at: iso_now(),
    });
    store.updated_at = iso_now();
    write_local_library_tags_store(&binding, &store)?;
    let _ = sync_local_tag_exports_plan_core(binding, "native_folder_tags_saved", &store, plan)?;
    read_local_folder_tag_details(&normalized_folder)
}

fn set_task_tag_category(store: &LocalStoredLibraryTags, tag_ids: &[String]) {
    let titles = tag_ids.iter()
        .filter_map(|id| store.tags.iter().find(|tag| &tag.id == id))
        .map(|tag| tag.path.as_str())
        .collect::<Vec<_>>();
    task_center::category_title(titles.join("、"));
}

fn normalize_tag_segment(value: &str) -> String {
    value
        .trim()
        .replace('\\', "/")
        .trim_matches('/')
        .to_string()
}

fn normalize_tag_status(value: Option<&str>) -> String {
    match value.unwrap_or("active").trim() {
        "disabled" => "disabled".to_string(),
        _ => "active".to_string(),
    }
}

fn normalize_rule_relation(value: Option<&str>) -> String {
    match value.unwrap_or("and").trim() {
        "or" => "or".to_string(),
        "not" => "not".to_string(),
        _ => "and".to_string(),
    }
}

fn normalize_tag_ids(store: &LocalStoredLibraryTags, input: Vec<String>) -> Vec<String> {
    input
        .into_iter()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .filter(|value| store.tags.iter().any(|tag| &tag.id == value))
        .collect()
}

fn normalize_child_tag_selection_mode(value: Option<&str>) -> Result<&'static str, String> {
    match value.unwrap_or("multiple") {
        "multiple" => Ok("multiple"),
        "single" => Ok("single"),
        _ => Err("子标签选择模式无效".to_string()),
    }
}

fn validate_single_child_tag_ids(
    store: &LocalStoredLibraryTags,
    tag_ids: &[String],
) -> Result<(), String> {
    let mut selected_by_parent = HashMap::<&str, Vec<&str>>::new();
    for tag_id in tag_ids {
        let Some(tag) = store.tags.iter().find(|tag| tag.id == *tag_id) else {
            continue;
        };
        if tag.status != "active" {
            continue;
        }
        let Some(parent_id) = tag.parent_id.as_deref() else {
            continue;
        };
        let parent_is_single = store.tags.iter().any(|parent| {
            parent.id == parent_id
                && matches!(normalize_child_tag_selection_mode(
                    parent.child_tag_selection_mode.as_deref(),
                ), Ok("single"))
        });
        if parent_is_single {
            selected_by_parent.entry(parent_id).or_default().push(&tag.path);
        }
    }
    if let Some(conflict) = selected_by_parent.values().find(|paths| paths.len() > 1) {
        return Err(format!(
            "LIBRARY_TAG_EXCLUSIVE_CHILD_CONFLICT: 这些标签属于同一单选组，不能同时分配：{}",
            conflict.join("、")
        ));
    }
    Ok(())
}

fn ensure_local_tag_path(
    store: &mut LocalStoredLibraryTags,
    tag_path: &str,
) -> Result<String, String> {
    let normalized = normalize_tag_segment(tag_path);
    if normalized.is_empty() {
        return Err("标签路径不能为空".to_string());
    }
    let mut current_path = String::new();
    let mut parent_id: Option<String> = None;
    let mut parent_path: Option<String> = None;
    let mut last_id = String::new();
    let now = iso_now();
    for segment in normalized.split('/') {
        current_path = if current_path.is_empty() {
            segment.to_string()
        } else {
            format!("{current_path}/{segment}")
        };
        if let Some(existing) = store.tags.iter_mut().find(|tag| tag.path == current_path) {
            parent_id = Some(existing.id.clone());
            parent_path = Some(existing.path.clone());
            last_id = existing.id.clone();
            continue;
        }
        let id = format!("tag_{}", sha256_hex(current_path.as_bytes()));
        let tag = LocalStoredTagDefinition {
            id: id.clone(),
            path: current_path.clone(),
            name: segment.to_string(),
            root_type: normalized.split('/').next().unwrap_or(segment).to_string(),
            parent_id: parent_id.clone(),
            parent_path: parent_path.clone(),
            description: None,
            status: "active".to_string(),
            created_at: now.clone(),
            updated_at: now.clone(),
            disabled_at: None,
            child_tag_selection_mode: None,
        };
        store.tags.push(tag);
        parent_id = Some(id.clone());
        parent_path = Some(current_path.clone());
        last_id = id;
    }
    Ok(last_id)
}

fn collect_effective_folder_bindings(
    store: &LocalStoredLibraryTags,
    document_path: &str,
) -> Vec<Value> {
    let folder_path = normalize_folder_path(
        &PathBuf::from(document_path)
            .parent()
            .map(|value| value.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|| ".".to_string()),
    );
    let mut bindings = Vec::new();
    for binding in &store.folder_tags {
        let normalized_folder = normalize_folder_path(&binding.folder_path);
        if normalized_folder != "."
            && folder_path != normalized_folder
            && !folder_path.starts_with(&format!("{normalized_folder}/"))
        {
            continue;
        }
        for tag_id in &binding.binding_tag_ids {
            if let Some(tag) = store.tags.iter().find(|item| &item.id == tag_id) {
                bindings.push(json!({
                    "id": format!("folder:{}:{}", normalized_folder, tag.id),
                    "folderPath": normalized_folder,
                    "tagId": tag.id,
                    "tagPath": tag.path,
                }));
            }
        }
    }
    bindings
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LocalTagRecommendationTargetKind {
    Document,
    Folder,
}

struct LocalTagRecommendationTarget<'a> {
    kind: LocalTagRecommendationTargetKind,
    path: &'a str,
    title: &'a str,
    summary: &'a str,
    mtime: Option<&'a str>,
}

fn set_local_tag_recommendation(
    candidates: &mut BTreeMap<String, LocalLibraryTagRecommendation>,
    tag: &LocalStoredTagDefinition,
    score: f64,
    reason: &str,
    evidence: String,
) {
    let candidate = LocalLibraryTagRecommendation {
        tag_id: tag.id.clone(),
        path: tag.path.clone(),
        name: tag.name.clone(),
        score,
        reason: reason.to_string(),
        evidence,
    };
    let should_replace = candidates
        .get(&tag.id)
        .map(|current| current.score <= candidate.score)
        .unwrap_or(true);
    if should_replace {
        candidates.insert(tag.id.clone(), candidate);
    }
}

const GENERIC_RECOMMENDATION_TOKENS: &[&str] = &[
    "文档", "文件", "资料", "附件", "其他", "相关", "临时", "新建", "默认", "document",
    "documents", "file", "files", "other", "misc", "temp", "有限公司", "有限责任公司",
    "股份有限公司", "集团有限公司", "公司", "集团",
];

const MEANINGLESS_RECOMMENDATION_WORDS: &[&str] = &[
    "集团有限公司", "股份有限公司", "有限责任公司", "有限公司", "集团公司", "总公司", "分公司",
    "公司", "集团", "co.,ltd", "coltd", "ltd", "inc", "llc", "corp", "corporation",
    "company", "采购", "服务", "管理", "建设",
];

fn normalize_local_recommendation_text(value: &str) -> String {
    let mut normalized = String::new();
    let mut previous_space = true;
    for character in value.trim().to_lowercase().chars() {
        if matches!(character, '\\' | '/' | '_' | '-' | '–' | '—' | '.' | '(' | ')' | '[' | ']' | '{' | '}' | '【' | '】' | '（' | '）')
        {
            if !previous_space {
                normalized.push(' ');
                previous_space = true;
            }
        } else if character.is_whitespace() {
            if !previous_space {
                normalized.push(' ');
                previous_space = true;
            }
        } else {
            normalized.push(character);
            previous_space = false;
        }
    }
    normalized.trim().to_string()
}

fn compact_local_recommendation_text(value: &str) -> String {
    normalize_local_recommendation_text(value)
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect()
}

fn strip_local_recommendation_noise(value: &str) -> String {
    let mut result = value.to_string();
    for _ in 0..MEANINGLESS_RECOMMENDATION_WORDS.len() {
        let previous = result.clone();
        for word in MEANINGLESS_RECOMMENDATION_WORDS {
            result = result.replace(word, "");
        }
        if result == previous {
            break;
        }
    }
    result
}

fn is_generic_recommendation_token(value: &str) -> bool {
    GENERIC_RECOMMENDATION_TOKENS.contains(&value)
}

fn is_useful_recommendation_token(value: &str) -> bool {
    value.chars().count() >= 2 && !is_generic_recommendation_token(value)
}

fn is_useful_tag_match_text(value: &str) -> bool {
    value.chars().count() >= 3
        && !is_generic_recommendation_token(value)
        && !MEANINGLESS_RECOMMENDATION_WORDS.contains(&value)
}

fn build_local_recommendation_target_text(target_path: &str, title: &str) -> String {
    let basename = target_path.rsplit('/').next().unwrap_or(target_path);
    let split_path = target_path
        .chars()
        .map(|character| {
            if matches!(character, '/' | '.' | '_' | '-' | ' ' | '\\' | '–' | '—') {
                ' '
            } else {
                character
            }
        })
        .collect::<String>();
    let mut values = Vec::new();
    for part in [target_path, basename, title, &split_path] {
        let normalized = normalize_local_recommendation_text(part);
        let compact = compact_local_recommendation_text(part);
        let stripped = strip_local_recommendation_noise(&compact);
        for value in [normalized, compact, stripped] {
            if !value.is_empty() && !values.contains(&value) {
                values.push(value);
            }
        }
    }
    values.join(" ")
}

fn recommendation_tokens(value: &str) -> Vec<String> {
    value
        .split_whitespace()
        .map(ToString::to_string)
        .collect()
}

fn longest_common_recommendation_text(left: &str, right: &str) -> usize {
    let left = compact_local_recommendation_text(left)
        .chars()
        .collect::<Vec<_>>();
    let right = compact_local_recommendation_text(right)
        .chars()
        .collect::<Vec<_>>();
    let mut longest = 0;
    for length in (3..=left.len().min(right.len())).rev() {
        for start in 0..=left.len() - length {
            let fragment = left[start..start + length].iter().collect::<String>();
            if is_useful_tag_match_text(&fragment)
                && right.windows(length).any(|window| window == &left[start..start + length])
            {
                longest = length;
                break;
            }
        }
        if longest > 0 {
            break;
        }
    }
    longest
}

fn score_recommendation_overlap(overlap: usize, tag_text_length: usize) -> f64 {
    let coverage = overlap as f64 / tag_text_length.max(1) as f64;
    if overlap >= 6 || coverage >= 0.72 {
        92.0
    } else if overlap >= 4 || coverage >= 0.56 {
        86.0
    } else {
        80.0
    }
}

fn levenshtein_distance(left: &[char], right: &[char]) -> usize {
    let mut previous = (0..=right.len()).collect::<Vec<_>>();
    let mut current = vec![0; right.len() + 1];
    for (left_index, left_character) in left.iter().enumerate() {
        current[0] = left_index + 1;
        for (right_index, right_character) in right.iter().enumerate() {
            current[right_index + 1] = (current[right_index] + 1)
                .min(previous[right_index + 1] + 1)
                .min(previous[right_index] + usize::from(left_character != right_character));
        }
        previous.copy_from_slice(&current);
    }
    previous[right.len()]
}

fn similarity_ratio(left: &str, right: &str) -> f64 {
    if left.is_empty() || right.is_empty() {
        return 0.0;
    }
    if left == right {
        return 1.0;
    }
    let left = left.chars().collect::<Vec<_>>();
    let right = right.chars().collect::<Vec<_>>();
    let max_length = left.len().max(right.len());
    (max_length - levenshtein_distance(&left, &right)) as f64 / max_length as f64
}

fn build_local_tag_match_texts(tag: &LocalStoredTagDefinition) -> Vec<String> {
    let mut values = BTreeSet::new();
    for raw_name in [tag.name.as_str(), tag.path.rsplit('/').next().unwrap_or(&tag.path)] {
        let compact = compact_local_recommendation_text(raw_name);
        let stripped = strip_local_recommendation_noise(&compact);
        for candidate in [compact, stripped] {
            if is_useful_tag_match_text(&candidate) {
                values.insert(candidate);
            }
        }
    }
    let mut values = values.into_iter().collect::<Vec<_>>();
    values.sort_by_key(|value| std::cmp::Reverse(value.chars().count()));
    values
}

fn local_recommendation_name_score(tag: &LocalStoredTagDefinition, target_text: &str) -> f64 {
    let tokens = recommendation_tokens(target_text);
    let segments = tag
        .path
        .split('/')
        .map(normalize_local_recommendation_text)
        .filter(|segment| is_useful_recommendation_token(segment));
    let tag_name = normalize_local_recommendation_text(&tag.name);
    let tag_path = normalize_local_recommendation_text(&tag.path);
    let tag_name_tokens = recommendation_tokens(&tag_name)
        .into_iter()
        .filter(|token| is_useful_recommendation_token(token));
    let match_texts = build_local_tag_match_texts(tag);
    let mut score: f64 = 0.0;

    if is_useful_recommendation_token(&tag_name) && tokens.iter().any(|token| token == &tag_name) {
        score = score.max(90.0);
    }
    if is_useful_recommendation_token(&tag_name)
        && tokens
            .iter()
            .any(|token| token.chars().count() > tag_name.chars().count() && token.contains(&tag_name))
    {
        score = score.max(86.0);
    }
    if !tag_path.is_empty() && target_text.contains(&tag_path) {
        score = score.max(94.0);
    }

    for tag_text in match_texts {
        let overlap = longest_common_recommendation_text(&tag_text, target_text);
        if overlap >= 3 {
            score = score.max(score_recommendation_overlap(
                overlap,
                tag_text.chars().count(),
            ));
            continue;
        }
        let best_similarity = tokens
            .iter()
            .map(|token| {
                similarity_ratio(&tag_text, &strip_local_recommendation_noise(token))
            })
            .fold(0.0, f64::max);
        if tag_text.chars().count() >= 4 && best_similarity >= 0.88 {
            score = score.max(76.0 + ((best_similarity - 0.88) * 70.0).round());
        }
    }

    let segments = segments.collect::<Vec<_>>();
    let matched_segments = segments
        .iter()
        .filter(|segment| tokens.iter().any(|token| token == *segment))
        .count();
    if matched_segments >= 2 {
        score = score.max(84.0 + (matched_segments * 3) as f64);
    }
    let tag_name_tokens = tag_name_tokens.collect::<Vec<_>>();
    let matched_name_tokens = tag_name_tokens
        .iter()
        .filter(|name_token| tokens.iter().any(|token| token == *name_token))
        .count();
    if tag_name_tokens.len() >= 2 && matched_name_tokens == tag_name_tokens.len() {
        score = score.max(88.0);
    }

    if score == 0.0 && tag_name.chars().count() >= 3 {
        let best_similarity = tokens
            .iter()
            .map(|token| similarity_ratio(&tag_name, token))
            .fold(0.0, f64::max);
        if best_similarity >= 0.86 {
            score = score.max(78.0 + ((best_similarity - 0.86) * 60.0).round());
        }
    }
    score.min(94.0)
}

fn score_local_folder_context(
    target_kind: LocalTagRecommendationTargetKind,
    target_path: &str,
    binding_folder_path: &str,
) -> f64 {
    let target_folder = if target_kind == LocalTagRecommendationTargetKind::Document {
        PathBuf::from(target_path)
            .parent()
            .map(|value| normalize_folder_path(&value.to_string_lossy().replace('\\', "/")))
            .unwrap_or_else(|| ".".into())
    } else {
        normalize_folder_path(target_path)
    };
    let binding_folder = normalize_folder_path(binding_folder_path);
    if binding_folder == "." {
        return 0.0;
    }
    if binding_folder == target_folder {
        return 86.0;
    }
    if target_folder.starts_with(&format!("{binding_folder}/")) {
        return 80.0;
    }
    let parent_folder = PathBuf::from(&target_folder)
        .parent()
        .map(|value| normalize_folder_path(&value.to_string_lossy().replace('\\', "/")))
        .unwrap_or_else(|| ".".into());
    if binding_folder == parent_folder {
        return 76.0;
    }
    if parent_folder != "."
        && PathBuf::from(&binding_folder)
            .parent()
            .map(|value| normalize_folder_path(&value.to_string_lossy().replace('\\', "/")))
            .unwrap_or_else(|| ".".into())
            == parent_folder
        && are_local_sibling_folder_names_related(&target_folder, &binding_folder)
    {
        return 72.0;
    }
    0.0
}

fn are_local_sibling_folder_names_related(left_path: &str, right_path: &str) -> bool {
    let left_name = normalize_local_recommendation_text(
        left_path.rsplit('/').next().unwrap_or(left_path),
    );
    let right_name = normalize_local_recommendation_text(
        right_path.rsplit('/').next().unwrap_or(right_path),
    );
    if left_name.is_empty() || right_name.is_empty() {
        return false;
    }
    let left_tokens = recommendation_tokens(&left_name)
        .into_iter()
        .filter(|token| is_useful_recommendation_token(token))
        .collect::<Vec<_>>();
    let right_tokens = recommendation_tokens(&right_name)
        .into_iter()
        .filter(|token| is_useful_recommendation_token(token))
        .collect::<Vec<_>>();
    if left_tokens
        .iter()
        .any(|token| right_tokens.iter().any(|other| token == other))
    {
        return true;
    }
    similarity_ratio(&left_name, &right_name) >= 0.82
}

fn score_local_recent_modified_at(modified_at: &str) -> f64 {
    let Ok(modified_at) = chrono::DateTime::parse_from_rfc3339(modified_at) else {
        return 0.0;
    };
    let day_distance = (chrono::Utc::now() - modified_at.with_timezone(&chrono::Utc)).num_seconds() / 86_400;
    if day_distance <= 7 {
        54.0
    } else if day_distance <= 30 {
        44.0
    } else {
        0.0
    }
}

fn is_local_time_like_tag(tag: &LocalStoredTagDefinition) -> bool {
    let text = format!("{}/{}", tag.path, tag.name).to_lowercase();
    [
        "最近", "近期", "本周", "本月", "待处理", "跟进", "urgent", "recent", "week", "month",
        "todo", "follow",
    ]
    .iter()
    .any(|keyword| text.contains(keyword))
}

fn build_local_tag_recommendations(
    store: &LocalStoredLibraryTags,
    target: &LocalTagRecommendationTarget,
    excluded_tag_ids: Vec<String>,
    excluded_tag_paths: HashSet<String>,
    count_by_path: &HashMap<String, usize>,
) -> Vec<LocalLibraryTagRecommendation> {
    let excluded: HashSet<String> = excluded_tag_ids.into_iter().collect();
    let mut candidates = BTreeMap::new();
    let target_text = build_local_recommendation_target_text(target.path, target.title);
    let target_document = LocalRuntimeSnapshotDocument {
        document_id: String::new(),
        title: target.title.to_string(),
        path: target.path.to_string(),
        summary: target.summary.to_string(),
        tags: Vec::new(),
        derived_tags: Vec::new(),
        mtime: target.mtime.unwrap_or_default().to_string(),
    };

    for tag in store
        .tags
        .iter()
        .filter(|tag| {
            tag.status == "active"
                && !excluded.contains(&tag.id)
                && !excluded_tag_paths.contains(&tag.path)
        })
    {
        let name_score = local_recommendation_name_score(tag, &target_text);
        if name_score > 0.0 {
            set_local_tag_recommendation(
                &mut candidates,
                tag,
                name_score,
                "name_match",
                "文件夹或文件名称里出现了这个标签的关键词".to_string(),
            );
        }

    }

    for binding in &store.folder_tags {
        let binding_folder = normalize_folder_path(&binding.folder_path);
        let relation_score =
            score_local_folder_context(target.kind, target.path, &binding_folder);
        if relation_score <= 0.0 {
            continue;
        }
        for tag_id in &binding.binding_tag_ids {
            let Some(tag) = store.tags.iter().find(|tag| {
                tag.id == *tag_id
                    && tag.status == "active"
                    && !excluded.contains(&tag.id)
                    && !excluded_tag_paths.contains(&tag.path)
            }) else {
                continue;
            };
            set_local_tag_recommendation(
                &mut candidates,
                tag,
                relation_score,
                "folder_context",
                if binding_folder == "." {
                    "根目录已经配置过这个标签".to_string()
                } else {
                    format!("相关文件夹“{binding_folder}”已经配置过这个标签")
                },
            );
        }
    }

    for tag in store.tags.iter().filter(|tag| {
        tag.status == "active"
            && !excluded.contains(&tag.id)
            && !excluded_tag_paths.contains(&tag.path)
    }) {
        let rules = store
            .tag_rules
            .iter()
            .filter(|rule| rule.enabled && rule.tag_id == tag.id)
            .collect::<Vec<_>>();
        if let Some(rule) = resolve_local_tag_rule(&target_document, target.kind, &rules) {
            set_local_tag_recommendation(
                &mut candidates,
                tag,
                82.0,
                "smart_rule",
                local_tag_rule_evidence(rule),
            );
        }
    }

    if target.kind == LocalTagRecommendationTargetKind::Document {
        if let Some(modified_at) = target.mtime {
            let time_score = score_local_recent_modified_at(modified_at);
            if time_score > 0.0 {
                for tag in store.tags.iter().filter(|tag| {
                    tag.status == "active"
                        && !excluded.contains(&tag.id)
                        && !excluded_tag_paths.contains(&tag.path)
                        && is_local_time_like_tag(tag)
                }) {
                    set_local_tag_recommendation(
                        &mut candidates,
                        tag,
                        time_score,
                        "time_pattern",
                        "最近修改时间和这个标签有关".to_string(),
                    );
                }
            }
        }
    }

    let mut recommendations = candidates.into_values().collect::<Vec<_>>();
    for recommendation in &mut recommendations {
        let count = count_by_path.get(&recommendation.path).copied().unwrap_or(0);
        let count_bonus = ((count + 1) as f64).log2() * 1.5;
        recommendation.score = (recommendation.score + count_bonus.min(8.0)).min(100.0);
        recommendation.score = (recommendation.score * 100.0).round() / 100.0;
    }
    recommendations.sort_by(|left, right| {
        right
            .score
            .partial_cmp(&left.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| left.path.cmp(&right.path))
    });
    recommendations.truncate(8);
    recommendations
}

fn is_local_descendant_tag(
    tags: &[LocalStoredTagDefinition],
    ancestor_id: &str,
    candidate_id: &str,
) -> bool {
    let ancestor = tags.iter().find(|tag| tag.id == ancestor_id);
    let candidate = tags.iter().find(|tag| tag.id == candidate_id);
    match (ancestor, candidate) {
        (Some(ancestor), Some(candidate)) => {
            candidate.path == ancestor.path
                || candidate.path.starts_with(&format!("{}/", ancestor.path))
        }
        _ => false,
    }
}

pub fn sync_local_tag_exports_core(
    binding: &LocalLibraryBinding,
    reason: &str,
) -> Result<LocalLibraryTagRecomputeTask, String> {
    let plan = prepare_tag_assignment(binding, &TagAssignmentScope::Full, false)?;
    let store = read_local_library_tags_store(binding)?;
    sync_local_tag_exports_plan_core(binding, reason, &store, plan)
}

fn sync_local_tag_exports_plan_core(
    binding: &LocalLibraryBinding,
    reason: &str,
    store: &LocalStoredLibraryTags,
    plan: TagAssignmentPlan,
) -> Result<LocalLibraryTagRecomputeTask, String> {
    let task_id = format!(
        "library.tag_recompute:{}",
        sha256_hex(format!("{}:{}:{}", binding.library_id, binding.root_dir, iso_now()).as_bytes())
    );
    let mut task = LocalLibraryTagRecomputeTask {
        task_id: task_id.clone(),
        task_type: "library.tag_recompute".to_string(),
        key: binding.root_dir.clone(),
        state: "queued".to_string(),
        source: reason.to_string(),
        queued_at: iso_now(),
        started_at: None,
        completed_at: None,
        failed_at: None,
        error_summary: None,
        running_stage: None,
        deduped: Some(false),
    };
    write_local_tag_recompute_task_core(binding, &task)?;
    task.state = "running".to_string();
    task.started_at = Some(iso_now());
    task.running_stage = Some("write_snapshot".to_string());
    write_local_tag_recompute_task_core(binding, &task)?;

    let result = run_tag_assignment_core(binding, store, plan, reason);
    if let Err(error) = result {
        task.state = "failed".to_string();
        task.failed_at = Some(iso_now());
        task.error_summary = Some(error.clone());
        task.running_stage = None;
        write_local_tag_recompute_task_core(binding, &task)?;
        return Err(error);
    }
    task.state = "fresh".to_string();
    task.completed_at = Some(iso_now());
    task.running_stage = None;
    task.error_summary = None;
    write_local_tag_recompute_task_core(binding, &task)?;
    Ok(task)
}

pub fn read_local_tag_documents_core(
    binding: &LocalLibraryBinding,
) -> Result<Vec<MetaDocument>, String> {
    Ok(crate::read_local_library_export_payload(&binding.root_dir)?
        .map(|payload| payload.documents.clone())
        .unwrap_or_default())
}

pub fn read_runtime_export_catalog_snapshot_core(
    root_dir: &str,
) -> Result<Option<LocalRuntimeExportCatalogSnapshot>, String> {
    read_optional_json_file(&resolve_runtime_export_catalog_snapshot_path(root_dir))
}

fn apply_tag_assignment(
    plan: &mut TagAssignmentPlan,
    store: &LocalStoredLibraryTags,
    mut on_progress: impl FnMut(usize, usize),
) {
    let snapshot = &mut plan.snapshot;
    let active = store.tags.iter().filter(|tag| tag.status == "active").collect::<Vec<_>>();
    let total = plan.targets.len();
    on_progress(0, total);
    for (index, document_index) in plan.targets.iter().enumerate() {
        let document = &mut snapshot.documents[*document_index];
        let mut candidates = Vec::new();
        for tag_path in resolve_manual_tag_paths_core(
            store,
            &document.path,
            Some(&document.document_id),
        ) {
            if let Some(tag) = active.iter().find(|tag| tag.path == tag_path) {
                candidates.push(LocalTagCandidate::new(tag, "manual_document", 100, 0, i64::MAX));
            }
        }

        let document_folder = normalize_folder_path(
            &PathBuf::from(&document.path)
                .parent()
                .map(|value| value.to_string_lossy().replace('\\', "/"))
                .unwrap_or_else(|| ".".into()),
        );
        let effective_folder_tag_paths =
            resolve_folder_tag_paths_core(store, &document.path).into_iter().collect::<HashSet<_>>();
        for binding in &store.folder_tags {
            let folder_path = normalize_folder_path(&binding.folder_path);
            if folder_path != "."
                && document_folder != folder_path
                && !document_folder.starts_with(&format!("{folder_path}/"))
            {
                continue;
            }
            for tag_id in &binding.binding_tag_ids {
                if let Some(tag) = active.iter().find(|tag| tag.id == *tag_id) {
                    if !effective_folder_tag_paths.contains(&tag.path) {
                        continue;
                    }
                    candidates.push(LocalTagCandidate::new(
                        tag,
                        "folder_binding",
                        80,
                        folder_path.len(),
                        i64::MAX,
                    ));
                }
            }
        }

        for tag in &active {
            let mut rules = store.tag_rules.iter()
                .filter(|rule| rule.enabled && rule.tag_id == tag.id).collect::<Vec<_>>();
            rules.sort_by_key(|rule| rule.priority);
            let mut has_positive = false;
            let mut matches = true;
            let mut or_matches = None;
            let mut matched_priority = None;
            for rule in rules {
                let matched = matches_tag_rule(document, rule);
                match rule.relation.as_str() {
                    "not" => {
                        matches &= !matched;
                    }
                    "or" => {
                        has_positive = true;
                        or_matches = Some(or_matches.unwrap_or(false) || matched);
                        if matched {
                            matched_priority = Some(matched_priority.map_or(rule.priority, |current: i64| current.min(rule.priority)));
                        }
                    }
                    _ => {
                        has_positive = true;
                        matches &= matched;
                        if matched {
                            matched_priority = Some(matched_priority.map_or(rule.priority, |current: i64| current.min(rule.priority)));
                        }
                    }
                }
            }
            if has_positive && matches && or_matches.unwrap_or(true) {
                candidates.push(LocalTagCandidate::new(
                    tag,
                    "smart_rule",
                    60,
                    0,
                    matched_priority.unwrap_or(i64::MAX),
                ));
            }
        }

        for tag_path in document.derived_tags.clone() {
            if let Some(tag) = active.iter().find(|tag| tag.path == tag_path) {
                candidates.push(LocalTagCandidate::new(tag, "system_derived", 40, 0, i64::MAX));
            } else {
                candidates.push(LocalTagCandidate::unknown_derived(tag_path));
            }
        }
        let resolved = resolve_exclusive_tag_candidates(store, candidates);
        document.tags = resolved
            .iter()
            .filter(|candidate| candidate.source_type != "system_derived")
            .map(|candidate| candidate.path.clone())
            .collect();
        document.derived_tags = resolved
            .iter()
            .filter(|candidate| candidate.source_type == "system_derived")
            .map(|candidate| candidate.path.clone())
            .collect();
        on_progress(index + 1, total);
    }
    let mut tags = BTreeMap::new();
    for tag in active {
        register_snapshot_tag_path_core(&mut tags, &tag.path);
    }
    for document in &snapshot.documents {
        for tag in document.tags.iter().chain(&document.derived_tags) {
            register_snapshot_tag_path_core(&mut tags, tag);
        }
    }
    snapshot.tags = tags.into_values().collect();
    snapshot.generated_at = Some(iso_now());
}

#[derive(Clone)]
struct LocalTagCandidate {
    tag_id: String,
    parent_id: Option<String>,
    path: String,
    source_type: &'static str,
    priority: i64,
    folder_specificity: usize,
    rule_priority: i64,
}

impl LocalTagCandidate {
    fn unknown_derived(path: String) -> Self {
        Self {
            tag_id: path.clone(),
            parent_id: None,
            path,
            source_type: "system_derived",
            priority: 40,
            folder_specificity: 0,
            rule_priority: i64::MAX,
        }
    }

    fn new(
        tag: &LocalStoredTagDefinition,
        source_type: &'static str,
        priority: i64,
        folder_specificity: usize,
        rule_priority: i64,
    ) -> Self {
        Self {
            tag_id: tag.id.clone(),
            parent_id: tag.parent_id.clone(),
            path: tag.path.clone(),
            source_type,
            priority,
            folder_specificity,
            rule_priority,
        }
    }
}

fn candidate_precedes(left: &LocalTagCandidate, right: &LocalTagCandidate) -> bool {
    left.priority > right.priority
        || (left.priority == right.priority
            && left.source_type == "folder_binding"
            && right.source_type == "folder_binding"
            && left.folder_specificity > right.folder_specificity)
        || (left.priority == right.priority
            && left.source_type == "smart_rule"
            && right.source_type == "smart_rule"
            && left.rule_priority < right.rule_priority)
        || (left.priority == right.priority
            && left.folder_specificity == right.folder_specificity
            && left.rule_priority == right.rule_priority
            && left.tag_id < right.tag_id)
}

fn resolve_exclusive_tag_candidates(
    store: &LocalStoredLibraryTags,
    candidates: Vec<LocalTagCandidate>,
) -> Vec<LocalTagCandidate> {
    let mut winners = BTreeMap::<String, LocalTagCandidate>::new();
    let mut exclusive = HashMap::<String, LocalTagCandidate>::new();
    for candidate in candidates {
        let parent = candidate.parent_id.as_deref().and_then(|parent_id| {
            store.tags.iter().find(|tag| tag.id == parent_id)
        });
        if parent.is_some_and(|tag| tag.child_tag_selection_mode.as_deref() == Some("single")) {
            let key = candidate.parent_id.clone().unwrap_or_default();
            let replace = exclusive.get(&key)
                .map(|current| candidate_precedes(&candidate, current))
                .unwrap_or(true);
            if replace {
                exclusive.insert(key, candidate);
            }
            continue;
        }
        let replace = winners.get(&candidate.path)
            .map(|current| candidate_precedes(&candidate, current))
            .unwrap_or(true);
        if replace {
            winners.insert(candidate.path.clone(), candidate);
        }
    }
    for candidate in exclusive.into_values() {
        let replace = winners.get(&candidate.path)
            .map(|current| candidate_precedes(&candidate, current))
            .unwrap_or(true);
        if replace {
            winners.insert(candidate.path.clone(), candidate);
        }
    }
    winners.into_values().collect()
}

pub fn run_tag_assignment_core(
    binding: &LocalLibraryBinding,
    store: &LocalStoredLibraryTags,
    mut plan: TagAssignmentPlan,
    reason: &str,
) -> Result<Value, String> {
    let emit = plan.emit_progress;
    let mut last_progress = std::time::Instant::now();
    apply_tag_assignment(&mut plan, store, |processed, total| {
        if processed == 0 || processed == total || last_progress.elapsed().as_millis() >= 100 {
            report_tag_progress("apply_tags", processed, Some(total), emit);
            last_progress = std::time::Instant::now();
        }
    });
    let count = plan.targets.len();
    report_tag_progress("save_tag_results", count, Some(count), emit);
    write_runtime_export_catalog_snapshot(&binding.root_dir, &plan.snapshot)?;
    let changed_paths = plan.targets.iter()
        .map(|index| normalize_document_path(&plan.snapshot.documents[*index].path))
        .collect::<BTreeSet<_>>();
    let dirty_directories = changed_paths.iter()
        .map(|value| value.rsplit_once('/').map_or_else(|| ".".to_string(), |(directory, _)| directory.to_string()))
        .collect::<BTreeSet<_>>();
    let dirty_tag_paths = plan.snapshot.tags.iter()
        .map(|tag| tag.path.clone())
        .collect::<BTreeSet<_>>();
    let mut last_export_progress = std::time::Instant::now();
    let mut last_stage = String::new();
    let export = crate::native_export::run_tag_export_worker(crate::native_export::NativeExportRequest {
        root_dir: binding.root_dir.clone(), reason: reason.to_string(), target_path: None,
        dirty_scope: serde_json::json!({
        "trigger": "tag_assignment",
        "changedPaths": changed_paths, "deletedPaths": [],
        "dirtyDirectories": dirty_directories, "dirtyTagPaths": dirty_tag_paths, "dirtyMetaShards": [],
        "dirtyDetailShards": [], "dirtyPostingBuckets": [], "dirtyRelations": []
        }),
    }, &mut |stage, processed, total| {
        if last_stage != stage || Some(processed) == total || last_export_progress.elapsed().as_millis() >= 100 {
            task_center::stage_progress(stage, processed, total);
            if emit {
                eprintln!("[x-file-tag-progress] {}", json!({
                    "stage": stage, "processedCount": count, "totalCount": count,
                    "stageProgress": { "processedCount": processed, "totalCount": total },
                }));
            }
            last_stage = stage.to_string();
            last_export_progress = std::time::Instant::now();
        }
    })?;
    Ok(json!({
        "scannedCount": count, "updatedCount": count,
        "directAssignedCount": plan.snapshot.documents.iter().map(|doc| doc.tags.len()).sum::<usize>(),
        "derivedAssignedCount": plan.snapshot.documents.iter().map(|doc| doc.derived_tags.len()).sum::<usize>(),
        "exportedAt": export["exportedAt"],
    }))
}

fn matches_tag_rule(document: &LocalRuntimeSnapshotDocument, rule: &LocalStoredTagRule) -> bool {
    matches_tag_rule_for_target(
        document,
        LocalTagRecommendationTargetKind::Document,
        rule,
    )
}

fn matches_tag_rule_for_target(
    document: &LocalRuntimeSnapshotDocument,
    target_kind: LocalTagRecommendationTargetKind,
    rule: &LocalStoredTagRule,
) -> bool {
    let keyword = rule.matcher["keyword"]
        .as_str()
        .unwrap_or("")
        .to_lowercase();
    match rule.rule_type.as_str() {
        "file_name_contains" => {
            !keyword.is_empty()
                && file_name_from_path(&document.path)
                    .to_lowercase()
                    .contains(&keyword)
        }
        "file_content_contains" => {
            !keyword.is_empty()
                && format!(
                    "{}\n{}\n{}",
                    document.title, document.path, document.summary
                )
                .to_lowercase()
                .contains(&keyword)
        }
        "file_extension_in" => rule.matcher["extensions"]
            .as_array()
            .is_some_and(|extensions| target_kind == LocalTagRecommendationTargetKind::Document && {
                let extension = PathBuf::from(&document.path)
                    .extension()
                    .map(|ext| format!(".{}", ext.to_string_lossy().to_lowercase()))
                    .unwrap_or_default();
                extensions.iter().filter_map(Value::as_str).any(|value| {
                    format!(".{}", value.trim_start_matches('.').to_lowercase()) == extension
                })
            }),
        "document_path_in_folder" => {
            let folder = normalize_folder_path(rule.matcher["folderPath"].as_str().unwrap_or("."));
            folder == "."
                || (target_kind == LocalTagRecommendationTargetKind::Folder
                    && document.path == folder)
                || document.path.starts_with(&format!("{folder}/"))
        }
        "modified_time_between" => {
            if target_kind != LocalTagRecommendationTargetKind::Document {
                return false;
            }
            let parse = |value: &str| chrono::DateTime::parse_from_rfc3339(value).ok();
            let Some(time) = parse(&document.mtime) else {
                return false;
            };
            let start = rule.matcher["start"].as_str().and_then(parse);
            let end = rule.matcher["end"].as_str().and_then(parse);
            (start.is_some() || end.is_some())
                && start.map_or(true, |start| time >= start)
                && end.map_or(true, |end| time <= end)
        }
        _ => false,
    }
}

fn resolve_local_tag_rule<'a>(
    document: &LocalRuntimeSnapshotDocument,
    target_kind: LocalTagRecommendationTargetKind,
    rules: &[&'a LocalStoredTagRule],
) -> Option<&'a LocalStoredTagRule> {
    let mut sorted_rules = rules.to_vec();
    sorted_rules.sort_by_key(|rule| rule.priority);
    let mut matched_and = None;
    let mut matched_or = None;
    let mut has_or = false;

    for rule in sorted_rules {
        let matched = matches_tag_rule_for_target(document, target_kind, rule);
        match rule.relation.as_str() {
            "not" if matched => return None,
            "not" => {}
            "or" => {
                has_or = true;
                if matched && matched_or.is_none() {
                    matched_or = Some(rule);
                }
            }
            _ if !matched => return None,
            _ if matched_and.is_none() => matched_and = Some(rule),
            _ => {}
        }
    }

    if has_or && matched_or.is_none() {
        return None;
    }
    matched_and.or(matched_or)
}

fn local_tag_rule_evidence(rule: &LocalStoredTagRule) -> String {
    match rule.rule_type.as_str() {
        "file_name_contains" => format!(
            "智能规则：文件名包含“{}”",
            rule.matcher["keyword"].as_str().unwrap_or("").trim()
        ),
        "file_content_contains" => format!(
            "智能规则：标题、路径或摘要包含“{}”",
            rule.matcher["keyword"].as_str().unwrap_or("").trim()
        ),
        "file_extension_in" => {
            let extensions = rule.matcher["extensions"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>();
            format!("智能规则：文件类型命中 {}", extensions.join("、"))
        }
        "modified_time_between" => "智能规则：修改时间命中".to_string(),
        "document_path_in_folder" => {
            let folder = normalize_folder_path(
                rule.matcher["folderPath"].as_str().unwrap_or("."),
            );
            if folder == "." {
                "智能规则：位于根目录下".to_string()
            } else {
                format!("智能规则：位于“{folder}”下")
            }
        }
        _ => "智能规则命中".to_string(),
    }
}

fn resolve_local_tag_sources(
    store: &LocalStoredLibraryTags,
    sources: Vec<LocalResolvedTagSource>,
    folder_bindings: &[Value],
) -> (Vec<LocalResolvedTagSource>, Vec<LocalSuppressedTagSource>) {
    let mut by_path = BTreeMap::<String, LocalResolvedTagSource>::new();
    for source in sources {
        let replace = by_path.get(&source.path)
            .map(|current| source.priority > current.priority)
            .unwrap_or(true);
        if replace {
            by_path.insert(source.path.clone(), source);
        }
    }

    let mut resolved = Vec::new();
    let mut by_parent = HashMap::<String, Vec<LocalResolvedTagSource>>::new();
    for source in by_path.into_values() {
        let tag = store.tags.iter().find(|tag| tag.path == source.path);
        let parent = tag.and_then(|tag| tag.parent_id.as_deref())
            .and_then(|parent_id| store.tags.iter().find(|tag| tag.id == parent_id));
        if parent.is_some_and(|tag| tag.child_tag_selection_mode.as_deref() == Some("single")) {
            if let Some(parent_id) = tag.and_then(|tag| tag.parent_id.as_ref()) {
                by_parent.entry(parent_id.clone()).or_default().push(source);
            }
        } else {
            resolved.push(source);
        }
    }

    let mut suppressed = Vec::new();
    for group in by_parent.values_mut() {
        group.sort_by(|left, right| {
            let priority = right.priority.cmp(&left.priority);
            if priority != std::cmp::Ordering::Equal {
                return priority;
            }
            if left.source_type == "folder_binding" && right.source_type == "folder_binding" {
                let folder_depth = |source: &LocalResolvedTagSource| {
                    folder_bindings.iter().find(|binding| {
                        binding.get("id").and_then(Value::as_str) == source.source_ref.as_deref()
                    }).and_then(|binding| binding.get("folderPath").and_then(Value::as_str))
                        .map(str::len).unwrap_or_default()
                };
                let specificity = folder_depth(right).cmp(&folder_depth(left));
                if specificity != std::cmp::Ordering::Equal {
                    return specificity;
                }
            }
            if left.source_type == "smart_rule" && right.source_type == "smart_rule" {
                let rule_priority = |source: &LocalResolvedTagSource| {
                    store.tag_rules.iter().find(|rule| Some(rule.id.as_str()) == source.source_ref.as_deref())
                        .map(|rule| rule.priority).unwrap_or(i64::MAX)
                };
                let priority = rule_priority(left).cmp(&rule_priority(right));
                if priority != std::cmp::Ordering::Equal {
                    return priority;
                }
            }
            let tag_id = |source: &LocalResolvedTagSource| {
                store.tags.iter().find(|tag| tag.path == source.path)
                    .map(|tag| tag.id.clone()).unwrap_or_else(|| source.path.clone())
            };
            tag_id(left).cmp(&tag_id(right))
        });
        if let Some(winner) = group.first() {
            for source in group.iter().skip(1) {
                suppressed.push(LocalSuppressedTagSource {
                    path: source.path.clone(),
                    source_type: source.source_type.clone(),
                    source_ref: source.source_ref.clone(),
                    evidence: source.evidence.clone(),
                    confidence: source.confidence,
                    priority: source.priority,
                    suppressed_by_path: winner.path.clone(),
                });
            }
            resolved.push(winner.clone());
        }
    }
    resolved.sort_by(|left, right| {
        right.priority.cmp(&left.priority).then_with(|| left.path.cmp(&right.path))
    });
    (resolved, suppressed)
}

pub fn register_snapshot_tag_path_core(
    target: &mut BTreeMap<String, LocalRuntimeSnapshotTag>,
    tag_path: &str,
) {
    let segments = tag_path
        .split('/')
        .map(str::trim)
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();
    for index in 0..segments.len() {
        let current_path = segments[..=index].join("/");
        target
            .entry(current_path.clone())
            .or_insert_with(|| LocalRuntimeSnapshotTag {
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

pub fn resolve_manual_tag_paths_core(
    store: &LocalStoredLibraryTags,
    document_path: &str,
    document_id: Option<&str>,
) -> Vec<String> {
    let active_tags = collect_active_tag_paths_by_id_core(store);
    let mut values = BTreeSet::new();
    for binding in store.document_tags.iter().filter(|item| {
        item.path == document_path
            || document_id
                .map(|value| value == item.document_id)
                .unwrap_or(false)
    }) {
        for tag_id in &binding.manual_tag_ids {
            if let Some(tag_path) = active_tags.get(tag_id) {
                values.insert(tag_path.clone());
            }
        }
    }
    values.into_iter().collect()
}

pub fn resolve_folder_tag_paths_core(
    store: &LocalStoredLibraryTags,
    document_path: &str,
) -> Vec<String> {
    let active_tags = collect_active_tag_paths_by_id_core(store);
    let folder_path = normalize_folder_path(
        &PathBuf::from(document_path)
            .parent()
            .map(|value| value.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|| ".".to_string()),
    );
    let mut values = BTreeSet::new();
    for binding in &store.folder_tags {
        let normalized_folder = normalize_folder_path(&binding.folder_path);
        if normalized_folder != "."
            && folder_path != normalized_folder
            && !folder_path.starts_with(&format!("{normalized_folder}/"))
        {
            continue;
        }
        for tag_id in &binding.binding_tag_ids {
            if let Some(tag_path) = active_tags.get(tag_id) {
                values.insert(tag_path.clone());
            }
        }
    }
    values.into_iter().collect()
}

pub fn collect_active_tag_paths_by_id_core(
    store: &LocalStoredLibraryTags,
) -> HashMap<String, String> {
    store
        .tags
        .iter()
        .filter(|tag| tag.status == "active")
        .map(|tag| (tag.id.clone(), tag.path.clone()))
        .collect()
}

pub fn count_local_tags(documents: &[MetaDocument]) -> HashMap<String, usize> {
    let mut counts = HashMap::new();
    for document in documents {
        let mut expanded_paths = HashSet::new();
        let direct = document.direct_tags.clone().unwrap_or_default();
        let derived = document.derived_tags.clone().unwrap_or_default();
        for tag_path in direct.into_iter().chain(derived.into_iter()) {
            for ancestor_path in expand_local_tag_ancestor_paths(&tag_path) {
                expanded_paths.insert(ancestor_path);
            }
        }
        for path in expanded_paths {
            *counts.entry(path).or_insert(0) += 1;
        }
    }
    counts
}

#[cfg(test)]
mod task_tests {
    use super::*;

    fn scope_fixture(name: &str, paths: Vec<String>) -> (LocalLibraryBinding, LocalStoredLibraryTags) {
        let root = std::env::temp_dir().join(format!("x-file-tag-scope-{name}-{}", crate::epoch_millis()));
        let mut binding = crate::default_local_library_binding();
        binding.root_dir = root.to_string_lossy().to_string();
        let snapshot = LocalRuntimeExportCatalogSnapshot {
            version: 1, generated_at: Some(iso_now()), generated_at_legacy: None, tags: vec![],
            documents: paths.into_iter().enumerate().map(|(index, path)| LocalRuntimeSnapshotDocument {
                document_id: format!("doc-{index}"), title: file_name_from_path(&path), path,
                summary: String::new(), tags: vec!["原有/标签".to_string()],
                derived_tags: vec!["类型/Markdown".to_string()], mtime: iso_now(),
            }).collect(),
        };
        write_runtime_export_catalog_snapshot(&binding.root_dir, &snapshot).unwrap();
        let mut store = empty_local_library_tags_store(&binding);
        let tag_id = ensure_local_tag_path(&mut store, "客户/目标客户").unwrap();
        store.folder_tags.push(LocalStoredFolderTagBinding {
            folder_path: "目标".to_string(), binding_tag_ids: vec![tag_id], updated_at: iso_now(),
        });
        (binding, store)
    }

    #[test]
    fn 单选子标签写入拒绝同组冲突且来源裁决优先保留手工标签() {
        let (binding, mut store) = scope_fixture("exclusive-tags", vec![]);
        let parent_id = ensure_local_tag_path(&mut store, "项目状态").unwrap();
        let first_id = ensure_local_tag_path(&mut store, "项目状态/方案沟通").unwrap();
        let second_id = ensure_local_tag_path(&mut store, "项目状态/项目投标").unwrap();
        let other_id = ensure_local_tag_path(&mut store, "部门/工程").unwrap();
        store.tags.iter_mut().find(|tag| tag.id == parent_id).unwrap().child_tag_selection_mode = Some("single".into());

        assert!(validate_single_child_tag_ids(
            &store,
            &[first_id.clone(), second_id.clone()],
        ).is_err());
        assert!(validate_single_child_tag_ids(&store, &[second_id.clone(), other_id]).is_ok());

        let first = store.tags.iter().find(|tag| tag.id == first_id).unwrap().clone();
        let second = store.tags.iter().find(|tag| tag.id == second_id).unwrap().clone();
        let resolved = resolve_exclusive_tag_candidates(&store, vec![
            LocalTagCandidate::new(&first, "folder_binding", 80, 100, i64::MAX),
            LocalTagCandidate::new(&second, "manual_document", 100, 0, i64::MAX),
        ]);
        assert_eq!(resolved.len(), 1);
        assert_eq!(resolved[0].tag_id, second_id);

        let resolved = resolve_exclusive_tag_candidates(&store, vec![
            LocalTagCandidate::new(&first, "folder_binding", 80, 4, i64::MAX),
            LocalTagCandidate::new(&second, "folder_binding", 80, 12, i64::MAX),
        ]);
        assert_eq!(resolved[0].tag_id, second_id);
        let resolved = resolve_exclusive_tag_candidates(&store, vec![
            LocalTagCandidate::new(&first, "smart_rule", 60, 0, 4),
            LocalTagCandidate::new(&second, "smart_rule", 60, 0, 1),
        ]);
        assert_eq!(resolved[0].tag_id, second_id);

        store.tags.iter_mut().find(|tag| tag.id == parent_id).unwrap().child_tag_selection_mode = Some("multiple".into());
        let resolved = resolve_exclusive_tag_candidates(&store, vec![
            LocalTagCandidate::new(&first, "manual_document", 100, 0, i64::MAX),
            LocalTagCandidate::new(&second, "manual_document", 100, 0, i64::MAX),
        ]);
        assert_eq!(resolved.len(), 2);
        std::fs::remove_dir_all(&binding.root_dir).unwrap();
    }

    #[test]
    fn 旧标签定义缺少子标签选择模式时保持兼容() {
        let tag: LocalStoredTagDefinition = serde_json::from_value(json!({
            "id": "tag-root",
            "path": "项目状态",
            "name": "项目状态",
            "rootType": "项目状态",
            "parentId": null,
            "parentPath": null,
            "description": null,
            "status": "active",
            "createdAt": "2026-10-27T00:00:00Z",
            "updatedAt": "2026-10-27T00:00:00Z",
            "disabledAt": null
        })).unwrap();
        assert_eq!(tag.child_tag_selection_mode, None);
        assert_eq!(normalize_child_tag_selection_mode(tag.child_tag_selection_mode.as_deref()), Ok("multiple"));
    }

    #[test]
    fn 原生标签详情会按智能规则推荐并遵守规则关系() {
        let (binding, mut store) = scope_fixture(
            "recommendations",
            vec!["商务/采购合同.xlsx".into(), "商务/草稿报价.xlsx".into()],
        );
        let contract_id = ensure_local_tag_path(&mut store, "业务/法务资料").unwrap();
        let quote_id = ensure_local_tag_path(&mut store, "业务/报价单").unwrap();
        store.tag_rules = vec![
            LocalStoredTagRule {
                id: "rule-contract-name".into(),
                tag_id: contract_id.clone(),
                relation: "and".into(),
                rule_type: "file_name_contains".into(),
                matcher: json!({ "keyword": "合同" }),
                enabled: true,
                priority: 0,
            },
            LocalStoredTagRule {
                id: "rule-quote-extension".into(),
                tag_id: quote_id.clone(),
                relation: "and".into(),
                rule_type: "file_extension_in".into(),
                matcher: json!({ "extensions": ["xlsx"] }),
                enabled: true,
                priority: 0,
            },
            LocalStoredTagRule {
                id: "rule-quote-not-draft".into(),
                tag_id: quote_id.clone(),
                relation: "not".into(),
                rule_type: "file_name_contains".into(),
                matcher: json!({ "keyword": "草稿" }),
                enabled: true,
                priority: 1,
            },
        ];

        let document_target = LocalTagRecommendationTarget {
            kind: LocalTagRecommendationTargetKind::Document,
            path: "商务/采购合同.xlsx",
            title: "采购合同.xlsx",
            summary: "付款条款",
            mtime: Some("2026-10-26T00:00:00Z"),
        };
        let contract_recommendations = build_local_tag_recommendations(
            &store,
            &document_target,
            Vec::new(),
            HashSet::new(),
            &HashMap::new(),
        );
        assert!(contract_recommendations.iter().any(|item| {
            item.tag_id == contract_id
                && item.reason == "smart_rule"
                && item.evidence.contains("合同")
        }));
        assert!(contract_recommendations
            .iter()
            .any(|item| item.tag_id == quote_id));

        let draft_target = LocalTagRecommendationTarget {
            path: "商务/草稿报价.xlsx",
            title: "草稿报价.xlsx",
            ..document_target
        };
        assert!(!build_local_tag_recommendations(
            &store,
            &draft_target,
            Vec::new(),
            HashSet::new(),
            &HashMap::new(),
        )
        .iter()
        .any(|item| item.tag_id == quote_id && item.reason == "smart_rule"));

        let folder_target = LocalTagRecommendationTarget {
            kind: LocalTagRecommendationTargetKind::Folder,
            path: "商务/采购",
            title: "采购",
            summary: "",
            mtime: None,
        };
        assert!(!build_local_tag_recommendations(
            &store,
            &folder_target,
            Vec::new(),
            HashSet::new(),
            &HashMap::new(),
        )
        .iter()
        .any(|item| item.tag_id == quote_id && item.reason == "smart_rule"));
        std::fs::remove_dir_all(&binding.root_dir).unwrap();
    }

    #[test]
    fn 文件夹名称包含客户关键词时推荐对应客户标签() {
        let (binding, mut store) = scope_fixture("customer-recommendation", vec![]);
        let tag_id = ensure_local_tag_path(
            &mut store,
            "客户/山东雄鹰轮胎集团有限公司",
        )
        .unwrap();
        let target = LocalTagRecommendationTarget {
            kind: LocalTagRecommendationTargetKind::Folder,
            path: "项目文档/GIXM0636-雄鹰轮胎机房建设项目",
            title: "GIXM0636-雄鹰轮胎机房建设项目",
            summary: "",
            mtime: None,
        };

        let recommendations = build_local_tag_recommendations(
            &store,
            &target,
            Vec::new(),
            HashSet::new(),
            &HashMap::new(),
        );
        let recommendation = recommendations
            .iter()
            .find(|item| item.tag_id == tag_id)
            .expect("匹配到‘雄鹰轮胎’的客户标签应被推荐");
        assert_eq!(recommendation.path, "客户/山东雄鹰轮胎集团有限公司");
        assert_eq!(recommendation.reason, "name_match");
        assert!(recommendation.score >= 86.0);
        std::fs::remove_dir_all(&binding.root_dir).unwrap();
    }

    #[test]
    fn 推荐结果覆盖目录上下文近期标签和文档数量加权() {
        let (binding, store) = scope_fixture("recommendation-sources", vec![]);
        let folder_target = LocalTagRecommendationTarget {
            kind: LocalTagRecommendationTargetKind::Folder,
            path: "目标/子目录",
            title: "子目录",
            summary: "",
            mtime: None,
        };
        let folder_recommendations = build_local_tag_recommendations(
            &store,
            &folder_target,
            Vec::new(),
            HashSet::new(),
            &HashMap::from([("客户/目标客户".to_string(), 4)]),
        );
        let folder_recommendation = folder_recommendations
            .iter()
            .find(|item| item.path == "客户/目标客户")
            .unwrap();
        assert_eq!(folder_recommendation.reason, "folder_context");
        assert!((folder_recommendation.score - 83.48).abs() < 0.01);

        let mut store = store;
        let recent_id = ensure_local_tag_path(&mut store, "时间/最近7天").unwrap();
        let recent_time = iso_now();
        let document_target = LocalTagRecommendationTarget {
            kind: LocalTagRecommendationTargetKind::Document,
            path: "目标/新文件.md",
            title: "新文件.md",
            summary: "",
            mtime: Some(&recent_time),
        };
        let recommendations = build_local_tag_recommendations(
            &store,
            &document_target,
            Vec::new(),
            HashSet::new(),
            &HashMap::new(),
        );
        assert!(recommendations
            .iter()
            .any(|item| item.tag_id == recent_id && item.reason == "time_pattern"));
        std::fs::remove_dir_all(&binding.root_dir).unwrap();
    }

    #[test]
    fn 先统计目标目录四百四十五个文档再逐文件推进且不修改范围外文档() {
        let mut paths = (0..445).map(|index| format!("目标/子目录/{index}.md")).collect::<Vec<_>>();
        paths.extend(["目标同名/a.md".to_string(), "其他/b.md".to_string(), "根文件.md".to_string()]);
        let (binding, store) = scope_fixture("folder", paths);
        task_center::run_new(&binding.root_dir, "library.tag_assignment", "test", None, || {
            let mut plan = prepare_tag_assignment(&binding, &TagAssignmentScope::Folder {
                folder_path: "/目标/".to_string(),
            }, false)?;
            let before = task_center::list(&binding.root_dir);
            assert_eq!(before[0].total_count, Some(445));
            assert_eq!(before[0].processed_count, 0);
            assert!(plan.snapshot.documents.iter().all(|document| document.tags == ["原有/标签"]));
            let mut ticks = Vec::new();
            apply_tag_assignment(&mut plan, &store, |processed, total| {
                ticks.push((processed, total));
                task_center::progress(processed, Some(total));
            });
            assert_eq!(ticks, (0..=445).map(|count| (count, 445)).collect::<Vec<_>>());
            assert!(plan.snapshot.documents[..445].iter().all(|document| document.tags == ["客户/目标客户"]));
            assert!(plan.snapshot.documents[445..].iter().all(|document| document.tags == ["原有/标签"]));
            assert!(plan.snapshot.documents.iter().all(|document| document.derived_tags == ["类型/Markdown"]));
            Ok(())
        }).unwrap();
        let task = &task_center::list(&binding.root_dir)[0];
        assert_eq!(task.total_count, Some(445));
        assert_eq!(task.processed_count, 445);
        std::fs::remove_dir_all(&binding.root_dir).unwrap();
    }

    #[test]
    fn 单文档按标识或路径都只处理一个文件() {
        let (binding, mut store) = scope_fixture("document", vec!["目标/a.md".into(), "其他/b.md".into()]);
        let tag_id = store.tags.last().unwrap().id.clone();
        store.document_tags.push(LocalStoredDocumentTagBinding {
            document_id: "doc-0".into(), path: "目标/a.md".into(), title: "a.md".into(),
            manual_tag_ids: vec![tag_id], updated_at: iso_now(),
        });
        for document_id in ["doc-0", "目标\\a.md"] {
            let mut plan = prepare_tag_assignment(&binding, &TagAssignmentScope::Document {
                document_id: document_id.into(),
            }, false).unwrap();
            let mut ticks = Vec::new();
            apply_tag_assignment(&mut plan, &store, |done, total| ticks.push((done, total)));
            assert_eq!(ticks, vec![(0, 1), (1, 1)]);
            assert_eq!(plan.snapshot.documents[1].tags, ["原有/标签"]);
        }
        std::fs::remove_dir_all(&binding.root_dir).unwrap();
    }

    #[test]
    fn 空目录为零且根目录和全量重算仍覆盖全部文档() {
        let (binding, store) = scope_fixture("empty-and-full", vec!["目标/a.md".into(), "其他/b.md".into()]);
        let mut empty = prepare_tag_assignment(&binding, &TagAssignmentScope::Folder {
            folder_path: "不存在".into(),
        }, false).unwrap();
        let mut ticks = Vec::new();
        apply_tag_assignment(&mut empty, &store, |done, total| ticks.push((done, total)));
        assert_eq!(ticks, [(0, 0)]);
        assert!(empty.snapshot.documents.iter().all(|document| document.tags == ["原有/标签"]));
        for scope in [TagAssignmentScope::Full, TagAssignmentScope::Folder { folder_path: ".".into() }] {
            let plan = prepare_tag_assignment(&binding, &scope, false).unwrap();
            assert_eq!(plan.targets.len(), 2);
        }
        std::fs::remove_dir_all(&binding.root_dir).unwrap();
    }

    #[test]
    fn 文件处理后写入失败必须报告失败并保留准确的范围计数() {
        let (binding, store) = scope_fixture("failure", vec!["目标/a.md".into(), "其他/b.md".into()]);
        let plan = prepare_tag_assignment(&binding, &TagAssignmentScope::Folder { folder_path: "目标".into() }, false).unwrap();
        let snapshot_path = resolve_runtime_export_catalog_snapshot_path(&binding.root_dir);
        std::fs::remove_file(&snapshot_path).unwrap();
        std::fs::create_dir(&snapshot_path).unwrap();
        let result = task_center::run_new(&binding.root_dir, "library.tag_assignment", "test", None, || {
            run_tag_assignment_core(&binding, &store, plan, "test")
        });
        assert!(result.is_err());
        let tasks = task_center::list(&binding.root_dir);
        assert_eq!(tasks[0].state, "failed");
        assert_eq!(tasks[0].processed_count, 1);
        assert_eq!(tasks[0].total_count, Some(1));
        assert!(tasks[0].error_summary.is_some());
        std::fs::remove_dir_all(&binding.root_dir).unwrap();
    }

    #[test]
    fn 标签保存导出按真实文件推进且不覆盖索引任务完成时间() {
        let (binding, store) = scope_fixture("export-progress", vec!["目标/a.md".into(), "其他/b.md".into()]);
        let plan = prepare_tag_assignment(&binding, &TagAssignmentScope::Folder { folder_path: "目标".into() }, false).unwrap();
        let status_path = super::super::state_store::runtime_status_path(&binding.root_dir);
        let status = json!({ "state": "fresh", "lastCompletedAt": "2026-10-26T12:00:00Z" });
        write_json_file(&status_path, &status).unwrap();
        let result = task_center::run_new(&binding.root_dir, "library.tag_assignment", "test", None, || {
            run_tag_assignment_core(&binding, &store, plan, "test")
        }).unwrap();
        assert_eq!(result["scannedCount"], 1);
        assert_eq!(read_json_file::<Value>(&status_path).unwrap(), status);
        let task = &task_center::list(&binding.root_dir)[0];
        assert_eq!(task.state, "completed");
        assert_eq!(task.total_count, Some(1));
        assert!(task.stage_progress.is_none());

        let request = crate::native_export::NativeExportRequest {
            root_dir: binding.root_dir.clone(), reason: "test".into(), target_path: None,
            dirty_scope: json!({
                "trigger": "full", "changedPaths": [], "deletedPaths": [], "dirtyDirectories": [],
                "dirtyTagPaths": [], "dirtyMetaShards": [], "dirtyDetailShards": [],
                "dirtyPostingBuckets": [], "dirtyRelations": [],
            }),
        };
        let mut ticks = Vec::new();
        crate::native_export::run_tag_export_worker(request, &mut |stage, count, total| {
            ticks.push((stage.to_string(), count, total));
        }).unwrap();
        let details = ticks.iter().filter(|(stage, _, _)| stage == "export_details")
            .map(|(_, count, total)| (*count, *total)).collect::<Vec<_>>();
        assert_eq!(details, vec![(0, Some(2)), (1, Some(2)), (2, Some(2))]);
        assert!(ticks.iter().any(|(stage, _, _)| stage == "export_search"));
        assert_eq!(ticks.last().unwrap().0, "publish_tag_results");
        assert_eq!(read_json_file::<Value>(&status_path).unwrap(), status);
        std::fs::remove_dir_all(&binding.root_dir).unwrap();
    }

    #[test]
    fn 标签任务保存真实分类标题与数量供列表直接预览() {
        let binding = crate::default_local_library_binding();
        let mut store = empty_local_library_tags_store(&binding);
        let tag_id = ensure_local_tag_path(&mut store, "客户/麦迪格").unwrap();
        let root = "tag-category-preview";
        task_center::run_new(root, "library.tag_assignment", "test", None, || {
            set_task_tag_category(&store, &[tag_id]);
            task_center::progress(445, Some(445));
            Ok(())
        }).unwrap();
        let tasks = task_center::list(root);
        let task = &tasks[0];
        assert_eq!(task.category_title.as_deref(), Some("客户/麦迪格"));
        assert_eq!(task.processed_count, 445);
        assert_eq!(task.total_count, Some(445));
        assert_eq!(serde_json::to_value(task).unwrap()["categoryTitle"], "客户/麦迪格");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn 等待根锁的后台标签任务不阻塞异步线程且写入串行() {
        let root = std::env::temp_dir().join(format!("x-file-tag-task-{}", crate::epoch_millis()));
        let mut binding = crate::default_local_library_binding();
        binding.root_dir = root.to_string_lossy().to_string();
        let held = lock_root(&binding.root_dir).unwrap();
        let (started, received) = std::sync::mpsc::channel();
        let workers = (0..2).map(|_| {
            let binding = binding.clone();
            let started = started.clone();
            tokio::task::spawn_blocking(move || {
                started.send(()).unwrap();
                run_tag_mutation_for_binding(&binding, "test", None, |binding| {
                    let path = PathBuf::from(&binding.root_dir).join("counter.json");
                    let count: usize = read_optional_json_file(&path)?.unwrap_or(0);
                    write_json_file(&path, &(count + 1))
                })
            })
        }).collect::<Vec<_>>();
        for _ in 0..2 {
            received.recv_timeout(std::time::Duration::from_secs(2)).unwrap();
        }
        assert!(tokio::spawn(async { true }).await.unwrap());
        assert!(!workers.iter().any(|worker| worker.is_finished()));
        drop(held);
        for worker in workers {
            worker.await.unwrap().unwrap();
        }
        assert_eq!(read_json_file::<usize>(&root.join("counter.json")).unwrap(), 2);
        assert!(task_center::list(&binding.root_dir).iter().all(|task| task.state == "completed"));
        std::fs::remove_dir_all(root).unwrap();
    }
}
