use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::Path;

use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

use super::ToolError;

const SETTINGS_FILE: &str = "agent-integration.json";
const DIGEST_CONTEXT: &[u8] = b"X-File agent credential v1";

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SettingsRecord {
    enabled: bool,
    api_key_digest: Option<Vec<u8>>,
    access_mode: Option<AccessMode>,
    updated_at: Option<String>,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AccessMode {
    #[default]
    ReadOnly,
    ReadWrite,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SettingsInput {
    enabled: Option<bool>,
    api_key: Option<String>,
    access_mode: Option<AccessMode>,
    #[serde(default)]
    generate_api_key: bool,
    #[serde(default)]
    clear_api_key: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SettingsView {
    enabled: bool,
    api_key_configured: bool,
    access_mode: AccessMode,
    updated_at: Option<String>,
    executable_path: String,
    data_dir: String,
    platform: &'static str,
    capabilities: Vec<AgentCapability>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentCapability {
    name: String,
    description: String,
    available: bool,
    read_only: bool,
    destructive: bool,
    requires_binding: bool,
    parameters: Vec<AgentCapabilityParameter>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentCapabilityParameter {
    name: String,
    value_type: String,
    required: bool,
    description: Option<String>,
    allowed_values: Vec<String>,
}

fn capability_parameters(schema: &serde_json::Value) -> Vec<AgentCapabilityParameter> {
    let properties = match schema.get("properties").and_then(serde_json::Value::as_object) {
        Some(properties) => properties,
        None => return Vec::new(),
    };
    let required = schema.get("required")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(serde_json::Value::as_str)
        .collect::<std::collections::HashSet<_>>();
    properties.iter().map(|(name, property)| {
        let value_type = property.get("type").map(|value| match value {
            serde_json::Value::String(value) => value.clone(),
            serde_json::Value::Array(values) => values.iter()
                .filter_map(serde_json::Value::as_str)
                .collect::<Vec<_>>()
                .join(" | "),
            _ => "object".to_owned(),
        }).unwrap_or_else(|| "object".to_owned());
        AgentCapabilityParameter {
            name: name.clone(),
            value_type,
            required: required.contains(name.as_str()),
            description: property.get("description")
                .and_then(serde_json::Value::as_str).map(str::to_owned),
            allowed_values: property.get("enum")
                .and_then(serde_json::Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|value| match value {
                    serde_json::Value::String(value) => Some(value.clone()),
                    serde_json::Value::Null => Some("null".to_owned()),
                    other => Some(other.to_string()),
                })
                .collect(),
        }
    }).collect()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SettingsSaved {
    settings: SettingsView,
    #[serde(skip_serializing_if = "Option::is_none")]
    api_key: Option<String>,
}

fn read_record(directory: &Path) -> Result<SettingsRecord, ToolError> {
    match fs::read(directory.join(SETTINGS_FILE)) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|_| ToolError::new("SETTINGS_ERROR", "外部 Agent 配置损坏，请在设置中检查")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(SettingsRecord::default()),
        Err(error) => Err(error.into()),
    }
}

fn view(directory: &Path, record: SettingsRecord) -> Result<SettingsView, ToolError> {
    let access_mode = effective_access_mode(&record);
    Ok(SettingsView {
        enabled: record.enabled,
        api_key_configured: record.api_key_digest.is_some(),
        access_mode,
        updated_at: record.updated_at,
        executable_path: std::env::current_exe()?.to_string_lossy().into_owned(),
        data_dir: std::path::absolute(directory)?.to_string_lossy().into_owned(),
        platform: std::env::consts::OS,
        capabilities: super::catalog()
            .iter()
            .map(|definition| AgentCapability {
                name: definition.tool.name.to_string(),
                description: definition.tool.description.as_deref().unwrap_or("").to_owned(),
                available: access_mode == AccessMode::ReadWrite
                    || super::is_read_only(&definition.tool),
                read_only: super::is_read_only(&definition.tool),
                destructive: definition.tool.annotations.as_ref()
                    .and_then(|annotations| annotations.destructive_hint)
                    .unwrap_or(false),
                requires_binding: definition.tool.meta.as_ref()
                    .and_then(|meta| meta.get("requiresBinding"))
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false),
                parameters: capability_parameters(
                    &serde_json::Value::Object(definition.tool.input_schema.as_ref().clone()),
                ),
            })
            .collect(),
    })
}

pub(crate) fn get_settings() -> Result<SettingsView, String> {
    let directory = crate::x_file_data_dir();
    read_record(&directory)
        .and_then(|record| view(&directory, record))
        .map_err(|error| error.message)
}

pub(crate) fn save_settings(input: SettingsInput) -> Result<SettingsSaved, String> {
    save_in(&crate::x_file_data_dir(), input).map_err(|error| error.message)
}

pub(crate) fn configured_access_mode() -> Result<AccessMode, ToolError> {
    Ok(effective_access_mode(&read_record(&crate::x_file_data_dir())?))
}

fn effective_access_mode(record: &SettingsRecord) -> AccessMode {
    record.access_mode.unwrap_or(if record.api_key_digest.is_some() {
        AccessMode::ReadWrite
    } else {
        AccessMode::ReadOnly
    })
}

#[derive(Deserialize)]
#[serde(tag = "operation", rename_all = "camelCase", deny_unknown_fields)]
enum WorkerRequest {
    Get {},
    Save { input: SettingsInput },
}

// 管理入口仅供主机 HTTP 服务调用，复用桌面端的锁、摘要和原子写入。
pub(crate) fn run_worker() -> Result<String, String> {
    let mut raw = String::new();
    std::io::stdin()
        .take(8193)
        .read_to_string(&mut raw)
        .map_err(|_| "无法读取 Agent 设置请求".to_string())?;
    Ok(worker_response(&crate::x_file_data_dir(), &raw).to_string())
}

fn worker_response(directory: &Path, raw: &str) -> serde_json::Value {
    let result = (|| -> Result<serde_json::Value, ToolError> {
        if raw.len() > 8192 {
            return Err(ToolError::new("INVALID_ARGUMENT", "Agent 设置请求过大"));
        }
        // 解析错误不回显输入，避免密钥出现在响应或日志中。
        let request: WorkerRequest = serde_json::from_str(raw)
            .map_err(|_| ToolError::new("INVALID_ARGUMENT", "Agent 设置请求格式无效"))?;
        match request {
            WorkerRequest::Get {} => {
                serde_json::to_value(view(directory, read_record(directory)?)?).map_err(Into::into)
            }
            WorkerRequest::Save { input } => {
                serde_json::to_value(save_in(directory, input)?).map_err(Into::into)
            }
        }
    })();
    match result {
        Ok(result) => serde_json::json!({ "ok": true, "result": result }),
        Err(error) => serde_json::json!({ "ok": false, "error": error }),
    }
}

fn save_in(directory: &Path, input: SettingsInput) -> Result<SettingsSaved, ToolError> {
    fs::create_dir_all(directory)?;
    let lock = private_options()
        .create(true)
        .open(directory.join("agent-integration.lock"))?;
    lock.lock()?;
    let mut record = read_record(directory)?;
    let key_actions = usize::from(input.api_key.is_some())
        + usize::from(input.generate_api_key)
        + usize::from(input.clear_api_key);
    if key_actions > 1 {
        return Err(ToolError::new(
            "INVALID_ARGUMENT",
            "设置、生成和撤销密钥不能同时执行",
        ));
    }
    let generated = if input.generate_api_key {
        let mut bytes = [0u8; 32];
        getrandom::fill(&mut bytes)
            .map_err(|_| ToolError::new("SETTINGS_ERROR", "系统随机数生成失败"))?;
        Some(format!(
            "xf_{}",
            bytes.iter().map(|b| format!("{b:02x}")).collect::<String>()
        ))
    } else {
        None
    };
    if let Some(key) = generated.as_ref().or(input.api_key.as_ref()) {
        if !(32..=512).contains(&key.len()) || !key.bytes().all(|b| b.is_ascii_graphic()) {
            return Err(ToolError::new(
                "INVALID_ARGUMENT",
                "API Key 必须为 32 至 512 位无空白 ASCII 字符",
            ));
        }
        record.api_key_digest = Some(digest(key).finalize().into_bytes().to_vec());
        if record.access_mode.is_none() {
            record.access_mode = Some(AccessMode::ReadOnly);
        }
    }
    if let Some(enabled) = input.enabled {
        record.enabled = enabled;
    }
    if let Some(access_mode) = input.access_mode {
        record.access_mode = Some(access_mode);
    }
    if input.clear_api_key {
        record.api_key_digest = None;
        record.enabled = false;
    }
    if record.enabled && record.api_key_digest.is_none() {
        return Err(ToolError::new(
            "API_KEY_REQUIRED",
            "请先配置 API Key，再启用外部 Agent 接入",
        ));
    }
    record.updated_at = Some(chrono::Utc::now().to_rfc3339());
    write_record(directory, &record)?;
    Ok(SettingsSaved {
        settings: view(directory, record)?,
        api_key: generated,
    })
}

fn private_options() -> OpenOptions {
    let mut options = OpenOptions::new();
    options.read(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
}

fn write_record(directory: &Path, record: &SettingsRecord) -> Result<(), ToolError> {
    let temporary = directory.join(format!(".agent-integration-{}.tmp", std::process::id()));
    let result = (|| {
        let mut file: File = private_options().create_new(true).open(&temporary)?;
        file.write_all(&serde_json::to_vec_pretty(record)?)?;
        file.sync_all()?;
        fs::rename(&temporary, directory.join(SETTINGS_FILE))?;
        Ok(())
    })();
    let _ = fs::remove_file(temporary);
    result
}

fn digest(key: &str) -> Hmac<Sha256> {
    let mut mac = Hmac::<Sha256>::new_from_slice(DIGEST_CONTEXT).expect("固定摘要上下文有效");
    mac.update(key.as_bytes());
    mac
}

fn verify(record: &SettingsRecord, key: Option<&str>) -> Result<(), ToolError> {
    if !record.enabled {
        return Err(ToolError::new(
            "AGENT_DISABLED",
            "外部 Agent 接入未启用，请在 X-File 设置中启用",
        ));
    }
    let valid = key
        .zip(record.api_key_digest.as_ref())
        .is_some_and(|(key, expected)| {
            key.len() <= 512 && digest(key).verify_slice(expected).is_ok()
        });
    if !valid {
        return Err(ToolError::new(
            "UNAUTHORIZED",
            "API Key 缺失或无效，请设置 X_FILE_AGENT_API_KEY",
        ));
    }
    Ok(())
}

pub(super) fn authorize() -> Result<AccessMode, ToolError> {
    let record = read_record(&crate::x_file_data_dir())?;
    let key = std::env::var("X_FILE_AGENT_API_KEY").ok();
    verify(&record, key.as_deref())
        .map(|()| effective_access_mode(&record))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn worker_reuses_settings_and_never_echoes_invalid_secrets() {
        let directory = std::env::temp_dir().join(format!("x-file-settings-worker-{}", std::process::id()));
        let result = (|| -> Result<(), ToolError> {
            let initial = worker_response(&directory, r#"{"operation":"get"}"#);
            assert_eq!(initial["result"]["enabled"], false);
            let initial_capabilities = initial["result"]["capabilities"].as_array().unwrap();
            assert_eq!(initial_capabilities.len(), super::super::catalog().len());
            let status = initial_capabilities.iter().find(|tool| tool["name"] == "xfile_status").unwrap();
            assert_eq!(status["readOnly"], true);
            assert_eq!(status["requiresBinding"], false);
            let file_operation = initial_capabilities.iter().find(|tool| tool["name"] == "xfile_file_operation").unwrap();
            assert_eq!(file_operation["destructive"], true);
            assert_eq!(file_operation["requiresBinding"], true);
            let saved = worker_response(&directory,
                r#"{"operation":"save","input":{"generateApiKey":true,"enabled":true}}"#);
            assert_eq!(saved["ok"], true);
            let key = saved["result"]["apiKey"].as_str().unwrap();
            verify(&read_record(&directory)?, Some(key))?;
            let public = worker_response(&directory, r#"{"operation":"get"}"#);
            assert_eq!(public["result"]["apiKeyConfigured"], true);
            assert!(!public.to_string().contains(key));
            for raw in [
                "sensitive-invalid-json".to_owned(),
                serde_json::json!({"operation": "save", "input": {"enabled": key}}).to_string(),
                serde_json::json!({"operation": "get", "dataDir": key}).to_string(),
                "s".repeat(8193),
            ] {
                let rejected = worker_response(&directory, &raw);
                assert_eq!(rejected["error"]["code"], "INVALID_ARGUMENT");
                assert!(!rejected.to_string().contains(key));
                assert!(!rejected.to_string().contains("sensitive-invalid-json"));
                verify(&read_record(&directory)?, Some(key))?;
            }
            Ok(())
        })();
        let _ = fs::remove_dir_all(directory);
        result.unwrap();
    }

    #[test]
    fn credentials_require_enabled_and_match_without_exposing_secrets() {
        let key = "test-key-with-at-least-thirty-two-characters";
        let mut record = SettingsRecord::default();
        assert_eq!(
            verify(&record, Some(key)).unwrap_err().code,
            "AGENT_DISABLED"
        );
        record.enabled = true;
        record.api_key_digest = Some(digest(key).finalize().into_bytes().to_vec());
        for supplied in [None, Some("wrong")] {
            assert_eq!(verify(&record, supplied).unwrap_err().code, "UNAUTHORIZED");
        }
        verify(&record, Some(key)).unwrap();
        assert!(!serde_json::to_string(&record).unwrap().contains(key));
    }

    #[test]
    fn settings_generation_rotation_and_revocation() {
        let directory =
            std::env::temp_dir().join(format!("x-file-settings-{}", std::process::id()));
        fs::create_dir_all(&directory).unwrap();
        let result = (|| -> Result<(), ToolError> {
            assert!(!read_record(&directory)?.enabled);
            assert!(save_in(
                &directory,
                SettingsInput {
                    enabled: Some(true),
                    ..Default::default()
                }
            )
            .is_err());
            let saved = save_in(
                &directory,
                SettingsInput {
                    generate_api_key: true,
                    enabled: Some(true),
                    ..Default::default()
                },
            )?;
            let key = saved.api_key.unwrap();
            assert_eq!(saved.settings.access_mode, AccessMode::ReadOnly);
            assert_eq!(key.len(), 67);
            assert!(!fs::read_to_string(directory.join(SETTINGS_FILE))?.contains(&key));
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                assert_eq!(
                    fs::metadata(directory.join(SETTINGS_FILE))?
                        .permissions()
                        .mode()
                        & 0o777,
                    0o600
                );
            }
            assert!(!serde_json::to_string(&saved.settings)?.contains(&key));
            verify(&read_record(&directory)?, Some(&key))?;
            for invalid in ["short".to_owned(), " ".repeat(32), "a".repeat(513)] {
                assert!(save_in(
                    &directory,
                    SettingsInput {
                        api_key: Some(invalid),
                        ..Default::default()
                    }
                )
                .is_err());
                verify(&read_record(&directory)?, Some(&key))?;
            }
            let rotated = save_in(
                &directory,
                SettingsInput {
                    generate_api_key: true,
                    ..Default::default()
                },
            )?;
            assert_eq!(
                verify(&read_record(&directory)?, Some(&key))
                    .unwrap_err()
                    .code,
                "UNAUTHORIZED"
            );
            verify(&read_record(&directory)?, rotated.api_key.as_deref())?;
            save_in(
                &directory,
                SettingsInput {
                    clear_api_key: true,
                    ..Default::default()
                },
            )?;
            let record = read_record(&directory)?;
            assert!(!record.enabled);
            assert!(record.api_key_digest.is_none());
            Ok(())
        })();
        let _ = fs::remove_dir_all(directory);
        result.unwrap();
    }
}
