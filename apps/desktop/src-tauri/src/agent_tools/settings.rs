use std::fs::{self, File, OpenOptions};
use std::io::Write;
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
    updated_at: Option<String>,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SettingsInput {
    enabled: Option<bool>,
    api_key: Option<String>,
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
    updated_at: Option<String>,
    executable_path: String,
    data_dir: String,
    platform: &'static str,
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
    Ok(SettingsView {
        enabled: record.enabled,
        api_key_configured: record.api_key_digest.is_some(),
        updated_at: record.updated_at,
        executable_path: std::env::current_exe()?.to_string_lossy().into_owned(),
        data_dir: std::path::absolute(directory)?.to_string_lossy().into_owned(),
        platform: std::env::consts::OS,
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
    }
    if let Some(enabled) = input.enabled {
        record.enabled = enabled;
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

pub(super) fn authorize() -> Result<(), ToolError> {
    let record = read_record(&crate::x_file_data_dir())?;
    let key = std::env::var("X_FILE_AGENT_API_KEY").ok();
    verify(&record, key.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;

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
