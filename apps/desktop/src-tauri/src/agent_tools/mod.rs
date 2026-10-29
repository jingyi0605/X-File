pub(crate) mod cli;
pub(crate) mod files;
mod mcp;
pub(crate) mod settings;

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::sync::Arc;
use std::sync::OnceLock;

use rmcp::model::Tool;
use serde::Serialize;
use serde_json::{json, Value};

use crate::*;

pub const SKILL: &str = include_str!("../../../../../skills/x-file/SKILL.md");
pub const SKILL_URI: &str = "xfile://skills/x-file";
pub const MAX_INPUT_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
pub struct ToolError {
    pub code: &'static str,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field: Option<String>,
}

impl ToolError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            field: None,
        }
    }

    pub fn field(mut self, field: impl Into<String>) -> Self {
        self.field = Some(field.into());
        self
    }
}

impl From<std::io::Error> for ToolError {
    fn from(error: std::io::Error) -> Self {
        let code = match error.kind() {
            std::io::ErrorKind::NotFound => "NOT_FOUND",
            std::io::ErrorKind::AlreadyExists => "ALREADY_EXISTS",
            std::io::ErrorKind::PermissionDenied => "PERMISSION_DENIED",
            _ => "IO_ERROR",
        };
        Self::new(code, error.to_string())
    }
}

impl From<serde_json::Error> for ToolError {
    fn from(error: serde_json::Error) -> Self {
        Self::new("INVALID_ARGUMENT", error.to_string())
    }
}

fn native<T>(result: Result<T, String>) -> Result<T, ToolError> {
    result.map_err(|message| ToolError::new("LIBRARY_ERROR", message))
}

fn value<T: Serialize>(result: T) -> Result<Value, ToolError> {
    serde_json::to_value(result).map_err(Into::into)
}

pub struct ToolDefinition {
    pub tool: Tool,
    validator: jsonschema::Validator,
}

pub fn catalog() -> &'static [ToolDefinition] {
    static CATALOG: OnceLock<Vec<ToolDefinition>> = OnceLock::new();
    CATALOG.get_or_init(|| {
        let tools: Vec<Tool> =
            serde_json::from_str(include_str!("catalog.json")).expect("内嵌工具目录必须有效");
        let output: Value = serde_json::from_str(include_str!("output-schema.json"))
            .expect("内嵌输出 Schema 必须有效");
        let output = Arc::new(output.as_object().unwrap().clone());
        tools
            .into_iter()
            .map(|mut tool| {
                tool.output_schema = Some(Arc::clone(&output));
                let schema = Value::Object((*tool.input_schema).clone());
                let validator = jsonschema::options()
                    .should_validate_formats(true)
                    .build(&schema)
                    .expect("内嵌工具 Schema 必须有效");
                ToolDefinition { tool, validator }
            })
            .collect()
    })
}

pub fn is_read_only(tool: &Tool) -> bool {
    tool.annotations
        .as_ref()
        .and_then(|a| a.read_only_hint)
        .unwrap_or(false)
}

pub fn list_tools(read_only: bool, access_mode: settings::AccessMode) -> Vec<Tool> {
    catalog()
        .iter()
        .filter(|item| {
            (!read_only && access_mode == settings::AccessMode::ReadWrite)
                || is_read_only(&item.tool)
        })
        .map(|item| item.tool.clone())
        .collect()
}

pub fn envelope(name: &str, result: Result<Value, ToolError>) -> Value {
    match result {
        Ok(result) => json!({"schemaVersion": 1, "ok": true, "tool": name, "result": result}),
        Err(error) => json!({"schemaVersion": 1, "ok": false, "tool": name, "error": error}),
    }
}

pub fn call(name: &str, args: Value, read_only: bool) -> Value {
    envelope(name, execute(name, args, read_only))
}

fn execute(name: &str, args: Value, read_only: bool) -> Result<Value, ToolError> {
    let definition = catalog()
        .iter()
        .find(|item| item.tool.name == name)
        .ok_or_else(|| ToolError::new("TOOL_NOT_FOUND", format!("未知工具：{name}")))?;
    if read_only && !is_read_only(&definition.tool) {
        return Err(ToolError::new("READ_ONLY", "当前客户端请求启用了只读模式"));
    }
    if let Some(error) = definition.validator.iter_errors(&args).next() {
        return Err(ToolError::new("INVALID_ARGUMENT", error.to_string())
            .field(error.instance_path().to_string()));
    }
    let access_mode = settings::authorize()?;
    if !is_read_only(&definition.tool)
        && (read_only || access_mode == settings::AccessMode::ReadOnly)
    {
        return Err(ToolError::new("ACCESS_POLICY_DENIED", "当前 Agent 策略禁止写入操作"));
    }
    if definition
        .tool
        .meta
        .as_ref()
        .and_then(|meta| meta.get("requiresBinding"))
        .and_then(Value::as_bool)
        == Some(true)
    {
        binding()?;
    }
    // 应用状态锁串行化外部工具写入；索引及标签导出继续使用原有根目录锁。
    let _lock = if is_read_only(&definition.tool) {
        None
    } else {
        Some(lock_state()?)
    };
    let access_mode = settings::authorize()?;
    if !is_read_only(&definition.tool)
        && (read_only || access_mode == settings::AccessMode::ReadOnly)
    {
        return Err(ToolError::new("ACCESS_POLICY_DENIED", "当前 Agent 策略禁止写入操作"));
    }
    dispatch(name, args)
}

fn lock_state() -> Result<File, ToolError> {
    let directory = x_file_data_dir();
    fs::create_dir_all(&directory)?;
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(directory.join("agent-tools.lock"))?;
    file.lock()?;
    Ok(file)
}

pub(super) fn binding() -> Result<LocalLibraryBinding, ToolError> {
    native(read_local_library_binding())?
        .ok_or_else(|| ToolError::new("NOT_BOUND", "请先通过 xfile_binding_set 选择资料库"))
}

fn dispatch(name: &str, mut args: Value) -> Result<Value, ToolError> {
    match name {
        "xfile_status" => Ok(json!({
            "app": "X-File", "version": env!("CARGO_PKG_VERSION"), "schemaVersion": 1,
            "transport": "native", "binding": native(read_local_library_binding())?,
            "dataDir": x_file_data_dir(), "skillUri": SKILL_URI,
            "accessMode": settings::configured_access_mode()?,
            "toolCount": list_tools(false, settings::configured_access_mode()?).len()
        })),
        "xfile_binding_get" => value(native(read_local_library_binding())?),
        "xfile_binding_set" => {
            args["completeInitialization"] = args
                .get("completeInitialization")
                .cloned()
                .unwrap_or(json!(true));
            value(native(save_local_library_binding(serde_json::from_value(
                args,
            )?))?)
        }
        "xfile_config_get" => value(native(read_local_library_config())?),
        "xfile_config_set" => {
            let current = binding()?;
            if args.get("folderOpenBehavior").is_none() {
                args["folderOpenBehavior"] = json!(current.folder_open_behavior);
            }
            value(native(save_local_library_config(serde_json::from_value(
                args,
            )?))?)
        }
        "xfile_snapshot" => value(native(read_local_library_snapshot(
            &NativeLibraryState::new().snapshot(),
        ))?),
        "xfile_documents_list" => {
            if args.get("browseMode").is_none() {
                args["browseMode"] = json!("tag");
            }
            if let Some(path) = args.get("selectedFolderPath").and_then(Value::as_str) {
                files::resolve(&binding()?, path, false, true)?;
            }
            value(native(read_local_library_documents(
                serde_json::from_value(args)?,
            ))?)
        }
        "xfile_documents_tags_batch" => batch_document_tags(&args),
        "xfile_tasks_list" => list_agent_tasks(),
        "xfile_task_get" => get_agent_task(args["taskId"].as_str().unwrap_or_default()),
        "xfile_files_list" => {
            let path = args["path"].as_str().unwrap_or(".");
            files::resolve(&binding()?, path, false, true)?;
            value(native(read_local_library_files(
                Some(path.into()),
                args["limit"].as_u64().map(|n| n as usize),
            ))?)
        }
        "xfile_file_preview" => {
            let bound = binding()?;
            let path = files::resolve(&bound, args["path"].as_str().unwrap(), false, false)?;
            if fs::metadata(path)?.len() > 512 * 1024 {
                return Err(ToolError::new(
                    "FILE_TOO_LARGE",
                    "Agent 预览上限为 512 KiB；请用 file_read 分块读取",
                ));
            }
            value(native(read_local_library_preview(serde_json::from_value(
                args,
            )?))?)
        }
        "xfile_file_read" => files::read(&binding()?, &args),
        "xfile_file_operation" => files::operate(&binding()?, &args),
        "xfile_favorites_get" => {
            Ok(json!({"items": native(read_local_library_favorites(&binding()?))?}))
        }
        "xfile_favorites_set" => save_favorites(&binding()?, args),
        "xfile_index_refresh" => refresh(&binding()?, &args),
        "xfile_index_status" => value(native(read_local_runtime_status(&binding()?.root_dir))?),
        "xfile_tags_list" => native(list_native_library_tag_details(
            args["includeDisabled"].as_bool().unwrap_or(true),
        )),
        "xfile_tags_get" => native(get_native_library_tag_detail(
            args["tagId"].as_str().unwrap(),
        )),
        "xfile_tags_create" => native(create_native_library_tag(serde_json::from_value(args)?)),
        "xfile_tags_update" => {
            let id = args["tagId"].as_str().unwrap().to_string();
            let current = native(get_native_library_tag_detail(&id))?;
            merge_fields(&mut args, &current, &["parentId", "description", "status"]);
            native(update_native_library_tag(id, serde_json::from_value(args)?))
        }
        "xfile_tags_delete" => native(delete_native_library_tag(args["tagId"].as_str().unwrap())),
        "xfile_tags_ensure" => native(native_core::tag_core::ensure_native_library_tag(
            args["path"].as_str().unwrap(),
        )),
        "xfile_document_tags_get" => document_tags(args["documentId"].as_str().unwrap()),
        "xfile_document_tags_set" => {
            validate_tag_ids(&args)?;
            native(save_native_document_tags(serde_json::from_value(args)?))
        }
        "xfile_folder_tags_get" => {
            let path = args["folderPath"].as_str().unwrap();
            files::resolve(&binding()?, path, false, true)?;
            native(get_native_folder_tag_details(path))
        }
        "xfile_folder_tags_set" => {
            files::resolve(
                &binding()?,
                args["folderPath"].as_str().unwrap(),
                false,
                true,
            )?;
            validate_tag_ids(&args)?;
            native(save_native_folder_tags(serde_json::from_value(args)?))
        }
        "xfile_tags_recompute" => {
            native(request_native_library_tag_recompute())?;
            native(get_native_library_tag_recompute_task())
        }
        "xfile_tags_recompute_status" => native(get_native_library_tag_recompute_task()),
        "xfile_host_directories" => value(native(browse_local_host_directories(
            args["path"].as_str().map(String::from),
        ))?),
        _ => Err(ToolError::new("TOOL_NOT_FOUND", "工具尚未实现")),
    }
}

#[derive(Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentBatchTask {
    task_id: String,
    request_digest: String,
    library_key: String,
    state: String,
    stage: Option<String>,
    processed_count: usize,
    total_count: Option<usize>,
    changed_count: usize,
    heartbeat_at: String,
    queued_at: String,
    completed_at: Option<String>,
    result: Option<Value>,
    error: Option<ToolErrorRecord>,
}

#[derive(Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ToolErrorRecord {
    code: String,
    message: String,
}

fn agent_tasks_path() -> std::path::PathBuf {
    x_file_data_dir().join("agent-batch-tasks.json")
}

fn read_agent_tasks() -> Result<HashMap<String, AgentBatchTask>, ToolError> {
    let path = agent_tasks_path();
    if !path.is_file() {
        return Ok(HashMap::new());
    }
    let raw = fs::read_to_string(path)?;
    let mut tasks: HashMap<String, AgentBatchTask> = serde_json::from_str(&raw)
        .map_err(|_| ToolError::new("TASK_STORE_ERROR", "Agent task history is invalid."))?;
    let stale_before = chrono::Utc::now() - chrono::Duration::minutes(10);
    for task in tasks.values_mut().filter(|task| {
        task.state == "running"
            && chrono::DateTime::parse_from_rfc3339(&task.heartbeat_at)
                .is_ok_and(|heartbeat| heartbeat.with_timezone(&chrono::Utc) < stale_before)
    }) {
        task.state = "failed".into();
        task.stage = None;
        task.completed_at = Some(iso_now());
        task.error = Some(ToolErrorRecord {
            code: "TASK_INTERRUPTED".into(),
            message: "任务超过十分钟没有进度更新，可能在进程退出时中断。确认状态后使用新的幂等键重试。".into(),
        });
        task.result = Some(json!({
            "matchedCount": task.total_count.unwrap_or(0),
            "changedCount": task.changed_count,
            "skippedCount": task.total_count.unwrap_or(0).saturating_sub(task.changed_count),
            "failedCount": 0,
            "error": task.error,
        }));
    }
    let mut completed = tasks.values().filter(|task| task.completed_at.is_some())
        .map(|task| (task.completed_at.clone().unwrap_or_default(), task.task_id.clone()))
        .collect::<Vec<_>>();
    completed.sort_by(|left, right| right.0.cmp(&left.0));
    for (_, task_id) in completed.into_iter().skip(100) {
        tasks.remove(&task_id);
    }
    Ok(tasks)
}

fn write_agent_tasks(tasks: &HashMap<String, AgentBatchTask>) -> Result<(), ToolError> {
    let path = agent_tasks_path();
    native(write_json_file(&path, tasks))
}

fn persist_batch_progress(task: &mut AgentBatchTask, stage: &str, processed: usize, total: Option<usize>) {
    static LAST_WRITE: OnceLock<std::sync::Mutex<std::time::Instant>> = OnceLock::new();
    let last_write = LAST_WRITE.get_or_init(|| std::sync::Mutex::new(std::time::Instant::now()));
    let Ok(mut last_write) = last_write.lock() else { return };
    if processed != 0 && Some(processed) != total && last_write.elapsed().as_millis() < 100 {
        return;
    }
    task.stage = Some(stage.to_owned());
    task.processed_count = processed;
    task.total_count = total;
    if stage == "save_tags" {
        task.changed_count = processed;
    }
    task.heartbeat_at = iso_now();
    if let Ok(mut tasks) = read_agent_tasks() {
        tasks.insert(task.task_id.clone(), task.clone());
        let _ = write_agent_tasks(&tasks);
    }
    *last_write = std::time::Instant::now();
}

fn list_agent_tasks() -> Result<Value, ToolError> {
    let binding = binding()?;
    let key = sha256_hex(format!("{}:{}", binding.library_id, binding.root_dir).as_bytes());
    let mut tasks = read_agent_tasks()?.into_values()
        .filter(|task| task.library_key == key)
        .map(|task| json!(task))
        .collect::<Vec<_>>();
    tasks.extend(native_core::task_center::list(&binding.root_dir).into_iter().map(|task| json!(task)));
    tasks.sort_by(|left, right| right["queuedAt"].as_str().cmp(&left["queuedAt"].as_str()));
    Ok(json!({"items": tasks}))
}

fn get_agent_task(task_id: &str) -> Result<Value, ToolError> {
    let binding = binding()?;
    let key = sha256_hex(format!("{}:{}", binding.library_id, binding.root_dir).as_bytes());
    let tasks = read_agent_tasks()?;
    if let Some(task) = tasks.get(task_id).filter(|task| task.library_key == key) {
        return value(task);
    }
    let task = native_core::task_center::list(&binding.root_dir).into_iter()
        .find(|task| task.task_id == task_id)
        .ok_or_else(|| ToolError::new("TASK_NOT_FOUND", "当前资料库中未找到此任务。"))?;
    value(task)
}

fn batch_document_tags(args: &Value) -> Result<Value, ToolError> {
    let bound = binding()?;
    let _root_lock = native(native_core::scheduler::lock_root(&bound.root_dir))?;
    let operation = args["operation"].as_str().unwrap_or_default();
    let tag_paths = args["tagPaths"].as_array().into_iter().flatten()
        .filter_map(Value::as_str).map(str::to_owned).collect::<Vec<_>>();
    let create_tag_paths = args["createTagPaths"].as_array().into_iter().flatten()
        .filter_map(Value::as_str).map(str::to_owned).collect::<Vec<_>>();
    let dry_run = args["dryRun"].as_bool().unwrap_or(true);
    let idempotency_key = args["idempotencyKey"].as_str().unwrap_or_default();
    let mut normalized_request = args.clone();
    if let Some(object) = normalized_request.as_object_mut() {
        object.remove("idempotencyKey");
    }
    let request_digest = sha256_hex(&serde_json::to_vec(&normalized_request)?);
    let library_key = sha256_hex(format!("{}:{}", bound.library_id, bound.root_dir).as_bytes());
    let task_id = format!("agent-batch:{}", sha256_hex(format!("{library_key}:{idempotency_key}").as_bytes()));

    if args.get("folderPath").is_some() || args.get("folderPaths").is_some()
        || (args["targetKind"] == "folders" && args.get("documentIds").is_some())
        || (args["targetKind"] == "folders" && args.get("query").is_some())
    {
        if dry_run {
            return batch_folder_tags(&bound, args, idempotency_key, &request_digest);
        }
        let mut tasks = read_agent_tasks()?;
        if let Some(existing) = tasks.get(&task_id) {
            if existing.request_digest != request_digest {
                return Err(ToolError::new("IDEMPOTENCY_CONFLICT", "该幂等键已用于其他请求。"));
            }
            if existing.state == "completed" {
                let mut result = existing.result.clone().unwrap_or_else(|| json!({}));
                if let Some(object) = result.as_object_mut() { object.insert("deduped".into(), json!(true)); }
                return Ok(result);
            }
            if existing.state == "running" {
                return Ok(json!({"taskId": task_id, "state": "running", "stage": existing.stage,
                    "processedCount": existing.processed_count, "totalCount": existing.total_count,
                    "changedCount": existing.changed_count, "deduped": true}));
            }
            if existing.state == "failed" {
                let (code, message) = existing.error.as_ref()
                    .map(|error| (error.code.clone(), error.message.clone()))
                    .unwrap_or_else(|| ("BATCH_TAG_FAILED".into(), "上一次批量操作失败。".into()));
                return Err(ToolError::new(
                    "BATCH_TAG_FAILED",
                    format!("{}: {message}", code),
                ));
            }
        }
        let mut task = AgentBatchTask {
            task_id: task_id.clone(), request_digest: request_digest.clone(),
            library_key, state: "running".into(), stage: Some("save_tags".into()), processed_count: 0,
            total_count: args["folderPaths"].as_array().map(Vec::len).or(Some(1)), changed_count: 0,
            heartbeat_at: iso_now(), queued_at: iso_now(), completed_at: None, result: None, error: None,
        };
        tasks.insert(task_id.clone(), task.clone());
        write_agent_tasks(&tasks)?;
        let result = batch_folder_tags(&bound, args, idempotency_key, &request_digest);
        match result {
            Ok(mut result) => {
                if result["validationErrors"].as_array().is_some_and(|errors| !errors.is_empty()) {
                    let message = result["validationErrors"][0].as_str()
                        .unwrap_or("批量目录标签校验失败。")
                        .to_owned();
                    task.state = "failed".into();
                    task.stage = None;
                    task.completed_at = Some(iso_now());
                    task.error = Some(ToolErrorRecord { code: "BATCH_VALIDATION_FAILED".into(), message });
                    task.result = Some(result);
                    tasks.insert(task_id, task);
                    write_agent_tasks(&tasks)?;
                    return Err(ToolError::new("BATCH_VALIDATION_FAILED", "批量目录标签校验失败，未应用任何修改。"));
                }
                task.changed_count = result["changedCount"].as_u64().unwrap_or(0) as usize;
                task.processed_count = result["matchedCount"].as_u64().unwrap_or(0) as usize;
                task.total_count = Some(task.processed_count);
                task.state = "completed".into(); task.stage = None; task.completed_at = Some(iso_now());
                if let Some(object) = result.as_object_mut() {
                    object.insert("taskId".into(), json!(task_id));
                    object.insert("state".into(), json!("completed"));
                    object.insert("deduped".into(), json!(false));
                }
                task.result = Some(result.clone()); tasks.insert(task_id, task); write_agent_tasks(&tasks)?;
                return Ok(result);
            }
            Err(error) => {
                task.state = "failed".into(); task.stage = None; task.completed_at = Some(iso_now());
                task.error = Some(ToolErrorRecord { code: error.code.into(), message: error.message.clone() });
                task.result = Some(json!({
                    "matchedCount": task.total_count.unwrap_or(0),
                    "changedCount": task.changed_count,
                    "skippedCount": task.total_count.unwrap_or(0).saturating_sub(task.changed_count),
                    "failedCount": 0,
                    "error": task.error,
                }));
                tasks.insert(task_id, task); write_agent_tasks(&tasks)?;
                return Err(error);
            }
        }
    }

    if !dry_run {
        let tasks = read_agent_tasks()?;
        if let Some(existing) = tasks.get(&task_id) {
            if existing.request_digest != request_digest {
                return Err(ToolError::new("IDEMPOTENCY_CONFLICT", "该幂等键已用于其他请求。"));
            }
            if existing.state == "running" {
                return Ok(json!({
                    "taskId": task_id,
                    "state": existing.state,
                    "stage": existing.stage,
                    "processedCount": existing.processed_count,
                    "totalCount": existing.total_count,
                    "matchedCount": existing.total_count.unwrap_or(0),
                    "changedCount": 0,
                    "skippedCount": 0,
                    "deduped": true,
                }));
            }
            if existing.state == "failed" {
                let (code, message) = existing.error.as_ref()
                    .map(|error| (error.code.clone(), error.message.clone()))
                    .unwrap_or_else(|| ("BATCH_TAG_FAILED".into(), "上一次批量操作失败。".into()));
                return Err(ToolError::new(
                    "BATCH_TAG_FAILED",
                    format!("{}: {message}", code),
                ));
            }
            let mut result = existing.result.clone().unwrap_or_else(|| json!({}));
            if let Some(object) = result.as_object_mut() {
                object.insert("taskId".into(), json!(task_id));
                object.insert("deduped".into(), json!(true));
                object.insert("state".into(), json!(existing.state));
            }
            return Ok(result);
        }
    }

    let document_ids = resolve_batch_document_ids(args, &bound)?;
    if dry_run {
        let mut result = native(native_core::tag_core::apply_agent_document_tag_batch(
            &bound, &document_ids, operation, &tag_paths, &create_tag_paths, true,
            |_, _, _| {},
        ))?;
        if let Some(object) = result.as_object_mut() {
            object.insert("requestDigest".into(), json!(request_digest));
        }
        return Ok(result);
    }

    let mut tasks = read_agent_tasks()?;
    if let Some(existing) = tasks.get(&task_id) {
        if existing.request_digest != request_digest {
            return Err(ToolError::new("IDEMPOTENCY_CONFLICT", "This idempotency key was already used for a different request."));
        }
        if existing.state == "running" {
            let mut result = json!({
                "taskId": task_id,
                "state": "running",
                "stage": existing.stage,
                "processedCount": existing.processed_count,
                "totalCount": existing.total_count,
                "deduped": true
            });
            if let Some(object) = result.as_object_mut() {
                object.insert("matchedCount".into(), json!(existing.total_count.unwrap_or(0)));
                object.insert("changedCount".into(), json!(0));
                object.insert("skippedCount".into(), json!(0));
            }
            return Ok(result);
        }
        let mut result = existing.result.clone().unwrap_or_else(|| json!({}));
        if let Some(object) = result.as_object_mut() {
            object.insert("taskId".into(), json!(task_id));
            object.insert("deduped".into(), json!(true));
            object.insert("state".into(), json!(existing.state));
        }
        return Ok(result);
    }

    let mut task = AgentBatchTask {
        task_id: task_id.clone(),
        request_digest,
        library_key,
        state: "running".into(),
        stage: Some("prepare".into()),
        processed_count: 0,
        total_count: Some(document_ids.len()),
        changed_count: 0,
        heartbeat_at: iso_now(),
        queued_at: iso_now(),
        completed_at: None,
        result: None,
        error: None,
    };
    tasks.insert(task_id.clone(), task.clone());
    write_agent_tasks(&tasks)?;

    let result = native_core::tag_core::apply_agent_document_tag_batch(
        &bound, &document_ids, operation, &tag_paths, &create_tag_paths, false,
        |stage, processed, total| persist_batch_progress(&mut task, stage, processed, total),
    ).map_err(|message| ToolError::new("BATCH_TAG_FAILED", message));
    match result {
        Ok(mut result) => {
            if result["validationErrors"].as_array().is_some_and(|errors| !errors.is_empty()) {
                let message = result["validationErrors"][0].as_str().unwrap_or("Batch validation failed.").to_owned();
                task.state = "failed".into();
                task.stage = None;
                task.completed_at = Some(iso_now());
                task.error = Some(ToolErrorRecord { code: "BATCH_VALIDATION_FAILED".into(), message });
                tasks.insert(task_id, task);
                write_agent_tasks(&tasks)?;
                return Err(ToolError::new("BATCH_VALIDATION_FAILED", "Batch validation failed; no changes were applied."));
            }
            task.state = "completed".into();
            task.stage = None;
            task.completed_at = Some(iso_now());
            if let Some(object) = result.as_object_mut() {
                object.insert("taskId".into(), json!(task_id));
                object.insert("deduped".into(), json!(false));
                object.insert("state".into(), json!("completed"));
            }
            task.result = Some(result.clone());
            tasks.insert(task_id, task);
            write_agent_tasks(&tasks)?;
            Ok(result)
        }
        Err(error) => {
            task.state = "failed".into();
            task.stage = None;
            task.completed_at = Some(iso_now());
            task.error = Some(ToolErrorRecord { code: error.code.into(), message: error.message.clone() });
            task.result = Some(json!({
                "matchedCount": document_ids.len(),
                "changedCount": task.changed_count,
                "skippedCount": document_ids.len().saturating_sub(task.changed_count),
                "failedCount": 0,
                "targetDocumentIds": document_ids,
                "error": task.error,
            }));
            tasks.insert(task_id, task);
            write_agent_tasks(&tasks)?;
            Err(error)
        }
    }
}

fn batch_folder_tags(
    binding: &LocalLibraryBinding,
    args: &Value,
    idempotency_key: &str,
    request_digest: &str,
) -> Result<Value, ToolError> {
    let mut folder_paths = if let Some(folders) = args["folderPaths"].as_array() {
        folders.iter().filter_map(Value::as_str).map(str::to_owned).collect::<Vec<_>>()
    } else if let Some(folder) = args["folderPath"].as_str() {
        vec![folder.to_owned()]
    } else if args["targetKind"] == "folders" && args["documentIds"].is_array() {
        resolve_document_folder_paths(binding, &args["documentIds"])?
    } else if args["targetKind"] == "folders" && args.get("query").is_some() {
        resolve_query_folder_paths(binding, &args["query"])?
    } else if args.get("folderPaths").is_none()
        && args.get("folderPath").is_none()
        && args.get("documentIds").is_none()
        && args.get("query").is_some() {
        resolve_query_folder_paths(binding, &args["query"])?
    } else {
        return Err(ToolError::new("INVALID_ARGUMENT", "A folder selection is required."));
    };
    folder_paths.sort();
    folder_paths.dedup();
    if folder_paths.is_empty() || folder_paths.len() > 10_000 {
        return Err(ToolError::new("BATCH_LIMIT_EXCEEDED", "目录目标必须为 1 到 10000 个。"));
    }
    for folder in &folder_paths {
        let path = files::resolve(binding, folder, false, true)?;
        if !path.is_dir() {
            return Err(ToolError::new("PATH_NOT_DIRECTORY", "Folder tag targets must be directories."));
        }
    }
    let operation = args["operation"].as_str().unwrap_or_default();
    let tag_paths = args["tagPaths"].as_array().into_iter().flatten()
        .filter_map(Value::as_str).map(str::to_owned).collect::<Vec<_>>();
    let create_paths = args["createTagPaths"].as_array().into_iter().flatten()
        .filter_map(Value::as_str).map(str::to_owned).collect::<Vec<_>>();
    let mut task = if args["dryRun"].as_bool().unwrap_or(true) { None } else {
        let tasks = read_agent_tasks()?;
        let key = sha256_hex(format!("{}:{}", binding.library_id, binding.root_dir).as_bytes());
        let task_id = format!("agent-batch:{}", sha256_hex(format!("{key}:{idempotency_key}").as_bytes()));
        Some(tasks.get(&task_id).filter(|task| task.request_digest == request_digest).cloned()
            .ok_or_else(|| ToolError::new("TASK_NOT_FOUND", "目录标签任务尚未登记。"))?)
    };
    let result = native(native_core::tag_core::apply_agent_folder_tag_batch(
        binding,
        &folder_paths,
        operation,
        &tag_paths,
        &create_paths,
        args["dryRun"].as_bool().unwrap_or(true),
        |stage, processed, total| {
            if let Some(task) = task.as_mut() {
                persist_batch_progress(task, stage, processed, total);
            }
        },
    ))?;
    if let Some(task) = task.as_mut() {
        task.changed_count = result["changedCount"].as_u64().unwrap_or(0) as usize;
        task.processed_count = result["matchedCount"].as_u64().unwrap_or(0) as usize;
        task.total_count = Some(task.processed_count);
        task.heartbeat_at = iso_now();
        if let Ok(mut tasks) = read_agent_tasks() {
            tasks.insert(task.task_id.clone(), task.clone());
            let _ = write_agent_tasks(&tasks);
        }
    }
    if !args["dryRun"].as_bool().unwrap_or(true)
        && result["validationErrors"].as_array().is_some_and(|errors| !errors.is_empty())
    {
        return Err(ToolError::new("BATCH_VALIDATION_FAILED", "Folder batch validation failed; no changes were applied."));
    }
    let mut result = result;
    if !args["dryRun"].as_bool().unwrap_or(true) {
        let task_id = format!("agent-batch:{}", sha256_hex(format!("{}:{idempotency_key}", sha256_hex(format!("{}:{}", binding.library_id, binding.root_dir).as_bytes())).as_bytes()));
        if let Some(object) = result.as_object_mut() {
            object.insert("taskId".into(), json!(task_id));
            object.insert("state".into(), json!("completed"));
            object.insert("deduped".into(), json!(false));
        }
    }
    Ok(result)
}

fn resolve_document_folder_paths(
    binding: &LocalLibraryBinding,
    ids: &Value,
) -> Result<Vec<String>, ToolError> {
    let snapshot = native(native_core::tag_core::read_runtime_export_catalog_snapshot_core(&binding.root_dir))?
        .ok_or_else(|| ToolError::new("INDEX_NOT_READY", "The library index snapshot is not ready."))?;
    let by_id = snapshot.documents.iter()
        .map(|document| (document.document_id.as_str(), document.path.as_str()))
        .collect::<HashMap<_, _>>();
    let mut folders = Vec::new();
    for id in ids.as_array().into_iter().flatten().filter_map(Value::as_str) {
        let path = by_id.get(id)
            .ok_or_else(|| ToolError::new("DOCUMENT_NOT_FOUND", "文档 ID 不属于当前资料库。"))?;
        folders.push(PathBuf::from(path).parent()
            .map(|parent| parent.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|| ".".into()));
    }
    folders.sort();
    folders.dedup();
    Ok(folders)
}

fn resolve_query_folder_paths(
    binding: &LocalLibraryBinding,
    input: &Value,
) -> Result<Vec<String>, ToolError> {
    if let Some(folder) = input.get("selectedFolderPath").and_then(Value::as_str) {
        files::resolve(binding, folder, false, true)?;
    }
    let mut query = input.clone();
    query["offset"] = json!(0);
    query["limit"] = json!(10_001);
    let request: NativeListDocumentsRequest = serde_json::from_value(query)
        .map_err(|_| ToolError::new("INVALID_ARGUMENT", "The folder query is invalid."))?;
    let result = native(crate::read_local_library_documents(request))?;
    if result.total > 10_000 {
        return Err(ToolError::new("BATCH_LIMIT_EXCEEDED", "目录批量最多选择 10000 个文档结果。"));
    }
    Ok(result.items.iter()
        .map(|item| PathBuf::from(&item.path).parent()
            .map(|parent| parent.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|| ".".into()))
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter().collect())
}

fn resolve_batch_document_ids(
    args: &Value,
    bound: &LocalLibraryBinding,
) -> Result<Vec<String>, ToolError> {
    if let Some(ids) = args["documentIds"].as_array() {
        let ids = ids.iter().filter_map(Value::as_str).map(str::to_owned).collect::<Vec<_>>();
        if ids.is_empty() {
            return Err(ToolError::new("INVALID_ARGUMENT", "At least one document ID is required."));
        }
        let current_snapshot = native(native_core::tag_core::read_runtime_export_catalog_snapshot_core(&bound.root_dir))?
            .ok_or_else(|| ToolError::new("INDEX_NOT_READY", "The library index snapshot is not ready."))?;
        let indexed_ids = current_snapshot.documents.iter()
            .map(|document| document.document_id.as_str())
            .collect::<std::collections::HashSet<_>>();
        if ids.iter().any(|id| !indexed_ids.contains(id.as_str())) {
            return Err(ToolError::new("DOCUMENT_NOT_FOUND", "One or more document IDs are not in the current library."));
        }
        let plan = native(native_core::tag_core::prepare_tag_assignment(
            bound,
            &native_core::tag_core::TagAssignmentScope::DocumentIds { document_ids: ids.clone() },
            false,
        ))?;
        let found = plan.target_document_ids();
        if found.len() != ids.iter().collect::<std::collections::HashSet<_>>().len() {
            return Err(ToolError::new("DOCUMENT_NOT_FOUND", "One or more document IDs are not in the current library."));
        }
        return Ok(found);
    }
    if let Some(folder) = args["folderPath"].as_str() {
        files::resolve(bound, folder, false, true)?;
        let plan = native(native_core::tag_core::prepare_tag_assignment(
            bound,
            &native_core::tag_core::TagAssignmentScope::Folder { folder_path: folder.to_owned() },
            false,
        ))?;
        return Ok(plan.target_document_ids());
    }

    let query = args.get("query").cloned().unwrap_or_else(|| json!({}));
    if let Some(folder) = query.get("selectedFolderPath").and_then(Value::as_str) {
        files::resolve(bound, folder, false, true)?;
    }
    let mut ids = Vec::new();
    let total = loop {
        let mut query = query;
        query["browseMode"] = query.get("browseMode").cloned().unwrap_or(json!("tag"));
        query["offset"] = json!(0);
        query["limit"] = json!(10_001);
        let request: NativeListDocumentsRequest = serde_json::from_value(query)
            .map_err(|_| ToolError::new("INVALID_ARGUMENT", "The batch query is invalid."))?;
        let result = native(crate::read_local_library_documents(request))?;
        if result.total > 10_000 {
            return Err(ToolError::new("BATCH_LIMIT_EXCEEDED", "A batch may target at most 10,000 documents."));
        }
        ids.extend(result.items.into_iter().map(|item| item.document_id));
        break result.total;
    };
    if ids.len() != total {
        return Err(ToolError::new("SNAPSHOT_CHANGED", "The search result changed while target IDs were being frozen; retry the dry-run."));
    }
    Ok(ids)
}

fn merge_fields(args: &mut Value, current: &Value, fields: &[&str]) {
    for &field in fields {
        if args.get(field).is_none() {
            if let Some(value) = current.get(field) {
                args[field] = value.clone();
            }
        }
    }
}

fn validate_tag_ids(args: &Value) -> Result<(), ToolError> {
    let bound = binding()?;
    let store = native(native_core::tag_core::read_local_library_tags_store(&bound))?;
    for id in args["tagIds"].as_array().unwrap() {
        if !store
            .tags
            .iter()
            .any(|tag| Some(tag.id.as_str()) == id.as_str() && tag.status == "active")
        {
            return Err(
                ToolError::new("TAG_NOT_FOUND", format!("标签不存在或未启用：{id}"))
                    .field("tagIds"),
            );
        }
    }
    Ok(())
}

pub(super) fn refresh(bound: &LocalLibraryBinding, args: &Value) -> Result<Value, ToolError> {
    let paths: Vec<String> = args["targetPaths"]
        .as_array()
        .map(|a| a.iter().map(|p| p.as_str().unwrap().to_string()).collect())
        .unwrap_or_default();
    for path in &paths {
        files::resolve(bound, path, false, true)?;
    }
    let mut payload =
        build_native_library_worker_payload(bound, "external_agent".into(), None, None);
    payload.target_paths = paths;
    let mut result = native(run_native_library_worker_mode("full", payload))?;
    let store = native(native_core::tag_core::read_local_library_tags_store(bound))?;
    if !store.tags.is_empty() {
        // 使用公开入口持有根锁，避免依赖标签内部导出函数的锁实现。
        native(request_native_library_tag_recompute())?;
        result["tagStatus"] = native(get_native_library_tag_recompute_task())?;
    }
    Ok(result)
}

fn document_tags(id: &str) -> Result<Value, ToolError> {
    let mut detail = native(get_native_document_tag_details(id))?;
    let documents = native(native_core::tag_core::read_local_tag_documents_core(
        &binding()?,
    ))?;
    if let Some(document) = documents
        .iter()
        .find(|d| Some(d.document_id.as_str()) == detail["documentId"].as_str())
    {
        detail["indexedTags"] = json!(document.direct_tags.as_deref().unwrap_or_default());
        detail["derivedTags"] = json!(document.derived_tags.as_deref().unwrap_or_default());
    }
    Ok(detail)
}

fn save_favorites(bound: &LocalLibraryBinding, args: Value) -> Result<Value, ToolError> {
    let favorites: Vec<LocalLibraryFavoriteRecord> =
        serde_json::from_value(args["favorites"].clone())?;
    for item in &favorites {
        if item.kind == "folder" {
            let folder = if item.path.is_empty() {
                "."
            } else {
                &item.path
            };
            files::resolve(bound, folder, false, true)?;
        }
    }
    let path = x_file_data_dir().join("library-favorites.json");
    let mut store =
        native(read_optional_json_file::<HashMap<String, Value>>(&path))?.unwrap_or_default();
    store.insert(
        format!("{}:{}", bound.library_id, bound.root_dir),
        json!({
            "libraryId": bound.library_id, "rootDir": bound.root_dir,
            "favorites": favorites, "updatedAt": iso_now()
        }),
    );
    native(write_json_file(&path, &store))?;
    Ok(json!({"items": favorites}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 参数校验在接触资料库前拒绝无版本写入和未知字段() {
        for args in [
            json!({"opType": "write", "srcPath": "a.md", "content": "new"}),
            json!({"opType": "delete"}),
            json!({"opType": "copy", "srcPath": "a.md"}),
            json!({"opType": "create_file", "dstPath": "a.md", "unknown": true}),
        ] {
            assert_eq!(
                call("xfile_file_operation", args, false)["error"]["code"],
                "INVALID_ARGUMENT"
            );
        }
        assert_eq!(
            call(
                "xfile_tags_create",
                json!({
                    "name": "规则",
                    "smartRules": [{"ruleType": "file_name_contains", "matcher": {"keywrod": "a"}}]
                }),
                false
            )["error"]["code"],
            "INVALID_ARGUMENT"
        );
    }

    #[test]
    fn 只读入口不能通过隐藏工具名称绕过() {
        let result = call(
            "xfile_file_operation",
            json!({"opType": "create_file", "dstPath": "a.md"}),
            true,
        );
        assert_eq!(result["error"]["code"], "READ_ONLY");
        assert!(list_tools(true, settings::AccessMode::ReadWrite)
            .iter().all(is_read_only));
        assert!(list_tools(false, settings::AccessMode::ReadOnly)
            .iter().all(is_read_only));
        assert_eq!(
            call("unknown", json!({}), false)["error"]["code"],
            "TOOL_NOT_FOUND"
        );
    }

    #[test]
    fn 成功和业务失败共用公开输出契约() {
        let schema: Value = serde_json::from_str(include_str!("output-schema.json")).unwrap();
        let validator = jsonschema::validator_for(&schema).unwrap();
        assert!(validator.is_valid(&envelope("xfile_status", Ok(json!({"value": 1})))));
        assert!(validator.is_valid(&envelope(
            "xfile_file_read",
            Err(ToolError::new("NOT_FOUND", "文件不存在"))
        )));
        assert!(!validator
            .is_valid(&json!({"schemaVersion": 1, "ok": false, "tool": "xfile_file_read"})));
        let names: std::collections::HashSet<_> =
            catalog().iter().map(|d| d.tool.name.clone()).collect();
        assert_eq!(names.len(), catalog().len());
        assert!(catalog().iter().any(|item| item.tool.name == "xfile_documents_tags_batch"));
        assert!(catalog().iter().any(|item| item.tool.name == "xfile_tasks_list"));
    }
}
