pub(crate) mod cli;
mod files;
mod mcp;
pub(crate) mod settings;

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

#[derive(Debug, Serialize)]
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

pub fn list_tools(read_only: bool) -> Vec<Tool> {
    catalog()
        .iter()
        .filter(|item| !read_only || is_read_only(&item.tool))
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
        return Err(ToolError::new("READ_ONLY", "当前进程启用了只读模式"));
    }
    if let Some(error) = definition.validator.iter_errors(&args).next() {
        return Err(ToolError::new("INVALID_ARGUMENT", error.to_string())
            .field(error.instance_path().to_string()));
    }
    settings::authorize()?;
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
    settings::authorize()?;
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
            "toolCount": catalog().len()
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
        assert!(list_tools(true).iter().all(is_read_only));
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
    }
}
