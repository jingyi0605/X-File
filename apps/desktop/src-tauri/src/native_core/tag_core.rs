use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::{
    file_name_from_path,
    iso_now,
    normalize_document_path,
    normalize_folder_path,
    normalize_optional_text,
    read_json_file,
    read_local_library_binding, read_meta_documents,
    read_optional_json_file, resolve_runtime_export_catalog_snapshot_path,
    run_native_library_export_once, run_native_library_search_once, sha256_hex,
    write_json_file, write_runtime_export_catalog_snapshot, x_file_data_dir,
    LocalLibraryBinding, LocalLibraryDocumentTagDetails, LocalLibraryFolderTagDetails,
    LocalLibraryTagDetailWithRules, LocalLibraryTagListResult, LocalLibraryTagListSummary,
    LocalLibraryTagRecommendation, LocalLibraryTagRecomputeStatus,
    LocalLibraryTagRecomputeTask, LocalLibraryTagRuleView, LocalResolvedTagSource,
    LocalRuntimeExportCatalogSnapshot, LocalRuntimeSnapshotDocument,
    LocalRuntimeSnapshotTag, LocalStoredDocumentTagBinding, LocalStoredFolderTagBinding,
    LocalStoredLibraryTags, LocalStoredTagDefinition, LocalStoredTagRule,
    ManifestFile, MetaDocument,
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

pub fn create_native_library_tag(
    request: NativeSaveLibraryTagDefinitionRequest,
) -> Result<Value, String> {
    serde_json::to_value(save_local_library_tag(None, request)?)
        .map_err(|error| format!("序列化本地 tag create 失败：{error}"))
}

pub fn update_native_library_tag(
    tag_id: String,
    request: NativeSaveLibraryTagDefinitionRequest,
) -> Result<Value, String> {
    serde_json::to_value(save_local_library_tag(Some(tag_id), request)?)
        .map_err(|error| format!("序列化本地 tag update 失败：{error}"))
}

pub fn delete_native_library_tag(tag_id: &str) -> Result<Value, String> {
    serde_json::to_value(delete_local_library_tag(tag_id)?)
        .map_err(|error| format!("序列化本地 tag delete 失败：{error}"))
}

pub fn get_native_document_tag_details(document_id: &str) -> Result<Value, String> {
    serde_json::to_value(read_local_document_tag_details(document_id)?)
        .map_err(|error| format!("序列化本地 document tag details 失败：{error}"))
}

pub fn save_native_document_tags(
    request: NativeSaveDocumentTagsRequest,
) -> Result<Value, String> {
    serde_json::to_value(save_local_document_tags(request)?)
        .map_err(|error| format!("序列化本地 document tags 失败：{error}"))
}

pub fn get_native_folder_tag_details(folder_path: &str) -> Result<Value, String> {
    serde_json::to_value(read_local_folder_tag_details(folder_path)?)
        .map_err(|error| format!("序列化本地 folder tag details 失败：{error}"))
}

pub fn save_native_folder_tags(
    request: NativeSaveFolderTagsRequest,
) -> Result<Value, String> {
    serde_json::to_value(save_local_folder_tags(request)?)
        .map_err(|error| format!("序列化本地 folder tags 失败：{error}"))
}

pub fn request_native_library_tag_recompute() -> Result<Value, String> {
    let binding = read_local_library_binding()?
        .ok_or_else(|| "当前未绑定文档库".to_string())?;
    let task = sync_local_tag_exports_core(&binding, "native_manual_tag_recompute")?;
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
    let binding = read_local_library_binding()?
        .ok_or_else(|| "当前未绑定文档库".to_string())?;
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
            total_active_tags: store.tags.iter().filter(|tag| tag.status == "active").count(),
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
        smart_rule_enabled: smart_rules.iter().any(|rule| rule.enabled),
        smart_rules,
    }
}

pub fn read_local_library_tag_detail(
    tag_id: &str,
) -> Result<LocalLibraryTagDetailWithRules, String> {
    let binding = read_local_library_binding()?
        .ok_or_else(|| "当前未绑定文档库".to_string())?;
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
    override_tag_id: Option<String>,
    request: NativeSaveLibraryTagDefinitionRequest,
) -> Result<LocalLibraryTagDetailWithRules, String> {
    let binding = read_local_library_binding()?
        .ok_or_else(|| "当前未绑定文档库".to_string())?;
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

pub fn delete_local_library_tag(tag_id: &str) -> Result<Value, String> {
    let binding = read_local_library_binding()?
        .ok_or_else(|| "当前未绑定文档库".to_string())?;
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
    let binding = read_local_library_binding()?
        .ok_or_else(|| "当前未绑定文档库".to_string())?;
    let store = read_local_library_tags_store(&binding)?;
    let documents = read_local_tag_documents_core(&binding)?;
    let target = documents
        .into_iter()
        .find(|item| {
            item.document_id == document_id.trim()
                || normalize_document_path(&item.path)
                    == normalize_document_path(document_id)
        })
        .ok_or_else(|| "文档不存在".to_string())?;
    let normalized_path = normalize_document_path(&target.path);
    let manual_binding = store
        .document_tags
        .iter()
        .find(|item| item.document_id == target.document_id || item.path == normalized_path);
    let folder_bindings = collect_effective_folder_bindings(&store, &normalized_path);
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
        recommended_tags: build_local_tag_recommendations(
            &store,
            &normalized_path,
            manual_binding
                .map(|item| item.manual_tag_ids.clone())
                .unwrap_or_default(),
        ),
    })
}

pub fn save_local_document_tags(
    request: NativeSaveDocumentTagsRequest,
) -> Result<LocalLibraryDocumentTagDetails, String> {
    let binding = read_local_library_binding()?
        .ok_or_else(|| "当前未绑定文档库".to_string())?;
    let mut store = read_local_library_tags_store(&binding)?;
    let documents = read_local_tag_documents_core(&binding)?;
    let target = documents
        .iter()
        .find(|item| {
            item.document_id == request.document_id.trim()
                || normalize_document_path(&item.path)
                    == normalize_document_path(&request.document_id)
        })
        .ok_or_else(|| "文档不存在".to_string())?;
    let mut tag_ids = normalize_tag_ids(&store, request.tag_ids.unwrap_or_default());
    for tag_path in request.create_tag_paths.unwrap_or_default() {
        let created_id = ensure_local_tag_path(&mut store, &tag_path)?;
        if !tag_ids.iter().any(|item| item == &created_id) {
            tag_ids.push(created_id);
        }
    }
    let normalized_path = normalize_document_path(&target.path);
    let title = target
        .title
        .clone()
        .unwrap_or_else(|| file_name_from_path(&normalized_path));
    store
        .document_tags
        .retain(|item| item.document_id != target.document_id);
    store.document_tags.push(LocalStoredDocumentTagBinding {
        document_id: target.document_id.clone(),
        path: normalized_path.clone(),
        title,
        manual_tag_ids: tag_ids,
        updated_at: iso_now(),
    });
    store.updated_at = iso_now();
    write_local_library_tags_store(&binding, &store)?;
    let _ = sync_local_tag_exports_core(&binding, "native_document_tags_saved")?;
    read_local_document_tag_details(&target.document_id)
}

pub fn read_local_folder_tag_details(
    folder_path: &str,
) -> Result<LocalLibraryFolderTagDetails, String> {
    let binding = read_local_library_binding()?
        .ok_or_else(|| "当前未绑定文档库".to_string())?;
    let store = read_local_library_tags_store(&binding)?;
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
    Ok(LocalLibraryFolderTagDetails {
        folder_path: normalized_folder.clone(),
        exists: true,
        binding_tag_ids: binding_tag_ids.clone(),
        bindings,
        recommended_tags: build_local_tag_recommendations(
            &store,
            &normalized_folder,
            binding_tag_ids,
        ),
    })
}

pub fn save_local_folder_tags(
    request: NativeSaveFolderTagsRequest,
) -> Result<LocalLibraryFolderTagDetails, String> {
    let binding = read_local_library_binding()?
        .ok_or_else(|| "当前未绑定文档库".to_string())?;
    let mut store = read_local_library_tags_store(&binding)?;
    let normalized_folder = normalize_folder_path(request.folder_path.as_deref().unwrap_or("."));
    let mut tag_ids = normalize_tag_ids(&store, request.tag_ids.unwrap_or_default());
    for tag_path in request.create_tag_paths.unwrap_or_default() {
        let created_id = ensure_local_tag_path(&mut store, &tag_path)?;
        if !tag_ids.iter().any(|item| item == &created_id) {
            tag_ids.push(created_id);
        }
    }
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
    let _ = sync_local_tag_exports_core(&binding, "native_folder_tags_saved")?;
    read_local_folder_tag_details(&normalized_folder)
}

fn normalize_tag_segment(value: &str) -> String {
    value.trim().replace('\\', "/").trim_matches('/').to_string()
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

fn build_local_tag_recommendations(
    store: &LocalStoredLibraryTags,
    target_path: &str,
    excluded_tag_ids: Vec<String>,
) -> Vec<LocalLibraryTagRecommendation> {
    let excluded: HashSet<String> = excluded_tag_ids.into_iter().collect();
    store
        .tags
        .iter()
        .filter(|tag| tag.status == "active" && !excluded.contains(&tag.id))
        .filter(|tag| {
            let tag_path = tag.path.to_lowercase();
            let target = target_path.to_lowercase();
            tag_path.contains(&target) || target.contains(&tag_path)
        })
        .map(|tag| LocalLibraryTagRecommendation {
            tag_id: tag.id.clone(),
            path: tag.path.clone(),
            name: tag.name.clone(),
            score: 1.0,
            reason: "name_match".to_string(),
            evidence: "native local tag bridge".to_string(),
        })
        .collect()
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

    let store = read_local_library_tags_store(binding)?;
    let snapshot = build_local_tag_snapshot_core(binding, &store)?;
    write_runtime_export_catalog_snapshot(&binding.root_dir, &snapshot)?;

    let dirty_scope = serde_json::json!({
        "trigger": "full",
        "changedPaths": [],
        "deletedPaths": [],
        "dirtyDirectories": [],
        "dirtyTagPaths": [],
        "dirtyMetaShards": [],
        "dirtyDetailShards": [],
        "dirtyPostingBuckets": [],
        "dirtyRelations": [],
    });

    task.running_stage = Some("export_snapshot".to_string());
    write_local_tag_recompute_task_core(binding, &task)?;
    if let Err(error) = run_native_library_export_once(binding, reason, None, dirty_scope.clone()) {
        task.state = "failed".to_string();
        task.failed_at = Some(iso_now());
        task.error_summary = Some(error.clone());
        task.running_stage = None;
        write_local_tag_recompute_task_core(binding, &task)?;
        return Err(error);
    }
    task.running_stage = Some("search_index".to_string());
    write_local_tag_recompute_task_core(binding, &task)?;
    if let Err(error) = run_native_library_search_once(binding, reason, None, Some(dirty_scope)) {
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
    let export_dir = PathBuf::from(&binding.root_dir).join(".ai-index").join("exports");
    let manifest_path = export_dir.join("manifest.json");
    if !manifest_path.is_file() {
        return Ok(Vec::new());
    }
    let manifest: ManifestFile = read_json_file(&manifest_path)?;
    read_meta_documents(&export_dir, &manifest)
}

pub fn read_runtime_export_catalog_snapshot_core(
    root_dir: &str,
) -> Result<Option<LocalRuntimeExportCatalogSnapshot>, String> {
    read_optional_json_file(&resolve_runtime_export_catalog_snapshot_path(root_dir))
}

pub fn build_local_tag_snapshot_core(
    binding: &LocalLibraryBinding,
    store: &LocalStoredLibraryTags,
) -> Result<LocalRuntimeExportCatalogSnapshot, String> {
    let previous_snapshot = read_runtime_export_catalog_snapshot_core(&binding.root_dir)?;
    let previous_documents = previous_snapshot
        .as_ref()
        .map(|snapshot| {
            snapshot
                .documents
                .iter()
                .cloned()
                .map(|document| (document.path.clone(), document))
                .collect::<BTreeMap<_, _>>()
        })
        .unwrap_or_default();
    let documents = read_local_tag_documents_core(binding)?;
    let mut snapshot_documents = BTreeMap::<String, LocalRuntimeSnapshotDocument>::new();
    for document in documents {
        let normalized_path = normalize_document_path(&document.path);
        let previous_document = previous_documents.get(&normalized_path);
        let manual_tag_paths =
            resolve_manual_tag_paths_core(store, &normalized_path, Some(&document.document_id));
        let folder_tag_paths = resolve_folder_tag_paths_core(store, &normalized_path);
        let mut direct_tags = BTreeSet::new();
        for tag_path in manual_tag_paths.into_iter().chain(folder_tag_paths.into_iter()) {
            direct_tags.insert(tag_path);
        }
        let derived_tags = sort_unique_tag_paths_core(
            document
                .derived_tags
                .unwrap_or_else(|| {
                    previous_document
                        .map(|item| item.derived_tags.clone())
                        .unwrap_or_default()
                }),
        );
        snapshot_documents.insert(
            normalized_path.clone(),
            LocalRuntimeSnapshotDocument {
                document_id: document.document_id,
                path: normalized_path.clone(),
                title: document
                    .title
                    .filter(|value| !value.trim().is_empty())
                    .or_else(|| previous_document.map(|item| item.title.clone()))
                    .unwrap_or_else(|| file_name_from_path(&normalized_path)),
                summary: document
                    .summary
                    .filter(|value| !value.trim().is_empty())
                    .or_else(|| previous_document.map(|item| item.summary.clone()))
                    .unwrap_or_default(),
                tags: direct_tags.into_iter().collect(),
                derived_tags,
                mtime: document
                    .mtime
                    .or_else(|| previous_document.map(|item| item.mtime.clone()))
                    .unwrap_or_else(iso_now),
            },
        );
    }

    if snapshot_documents.is_empty() {
        for previous_document in previous_documents.into_values() {
            let manual_tag_paths = resolve_manual_tag_paths_core(
                store,
                &previous_document.path,
                Some(&previous_document.document_id),
            );
            let folder_tag_paths = resolve_folder_tag_paths_core(store, &previous_document.path);
            let mut direct_tags = BTreeSet::new();
            for tag_path in manual_tag_paths.into_iter().chain(folder_tag_paths.into_iter()) {
                direct_tags.insert(tag_path);
            }
            snapshot_documents.insert(
                previous_document.path.clone(),
                LocalRuntimeSnapshotDocument {
                    document_id: previous_document.document_id,
                    path: previous_document.path,
                    title: previous_document.title,
                    summary: previous_document.summary,
                    tags: direct_tags.into_iter().collect(),
                    derived_tags: sort_unique_tag_paths_core(previous_document.derived_tags),
                    mtime: previous_document.mtime,
                },
            );
        }
    }

    let snapshot_documents = snapshot_documents.into_values().collect::<Vec<_>>();
    let mut snapshot_tags = BTreeMap::<String, LocalRuntimeSnapshotTag>::new();
    for tag in &store.tags {
        if tag.status != "active" {
            continue;
        }
        register_snapshot_tag_path_core(&mut snapshot_tags, &tag.path);
    }
    for document in &snapshot_documents {
        for tag_path in document.tags.iter().chain(document.derived_tags.iter()) {
            register_snapshot_tag_path_core(&mut snapshot_tags, tag_path);
        }
    }

    Ok(LocalRuntimeExportCatalogSnapshot {
        version: 1,
        generated_at: Some(iso_now()),
        generated_at_legacy: None,
        tags: snapshot_tags.into_values().collect(),
        documents: snapshot_documents,
    })
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
            || document_id.map(|value| value == item.document_id).unwrap_or(false)
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

pub fn sort_unique_tag_paths_core(values: Vec<String>) -> Vec<String> {
    values
        .into_iter()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .collect::<BTreeSet<_>>()
        .into_iter()
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
