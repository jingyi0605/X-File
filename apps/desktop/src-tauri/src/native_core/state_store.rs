use std::path::PathBuf;
use std::{
    fs,
    io::{BufWriter, Write},
    path::Path,
    time::SystemTime,
};

pub type FileVersion = Option<(SystemTime, u64)>;

pub fn file_version(path: &Path) -> FileVersion {
    fs::metadata(path).ok().and_then(|metadata| {
        metadata
            .modified()
            .ok()
            .map(|modified| (modified, metadata.len()))
    })
}

pub fn write_compact_json<T: serde::Serialize>(path: &Path, value: &T) -> Result<(), String> {
    fs::create_dir_all(path.parent().unwrap()).map_err(|error| error.to_string())?;
    let temporary = path.with_extension("json.tmp");
    let mut writer =
        BufWriter::new(fs::File::create(&temporary).map_err(|error| error.to_string())?);
    serde_json::to_writer(&mut writer, value).map_err(|error| error.to_string())?;
    writer.write_all(b"\n").map_err(|error| error.to_string())?;
    writer.flush().map_err(|error| error.to_string())?;
    drop(writer);
    fs::rename(temporary, path).map_err(|error| error.to_string())
}

pub const AI_INDEX_DIR: &str = ".ai-index";
pub const RUNTIME_DIR: &str = "runtime";
pub const EXPORT_DIR: &str = "exports";
pub const RUNTIME_STATUS_FILE: &str = "runtime-status.json";
pub const ACTIVE_FILE_STATE_SNAPSHOT_FILE: &str = "active-file-state-snapshot.json";
pub const INDEX_STATE_SNAPSHOT_FILE: &str = "index-state.json";
pub const EXPORT_CATALOG_SNAPSHOT_FILE: &str = "export-catalog-snapshot.json";
pub const INDEXED_DOCUMENT_JOURNAL_FILE: &str = "indexed-document-journal.jsonl";
pub const PRIORITY_HINTS_FILE: &str = "priority-hints.json";
pub const SEARCH_MANIFEST_RELATIVE_PATH: &str = "search/manifest.json";

pub fn runtime_dir(root_dir: &str) -> PathBuf {
    PathBuf::from(root_dir).join(AI_INDEX_DIR).join(RUNTIME_DIR)
}

pub fn export_dir(root_dir: &str) -> PathBuf {
    PathBuf::from(root_dir).join(AI_INDEX_DIR).join(EXPORT_DIR)
}

pub fn runtime_status_path(root_dir: &str) -> PathBuf {
    PathBuf::from(root_dir)
        .join(AI_INDEX_DIR)
        .join(RUNTIME_STATUS_FILE)
}

pub fn active_file_state_snapshot_path(root_dir: &str) -> PathBuf {
    runtime_dir(root_dir).join(ACTIVE_FILE_STATE_SNAPSHOT_FILE)
}

pub fn index_state_snapshot_path(root_dir: &str) -> PathBuf {
    runtime_dir(root_dir).join(INDEX_STATE_SNAPSHOT_FILE)
}

pub fn export_catalog_snapshot_path(root_dir: &str) -> PathBuf {
    runtime_dir(root_dir).join(EXPORT_CATALOG_SNAPSHOT_FILE)
}

pub fn indexed_document_journal_path(root_dir: &str) -> PathBuf {
    runtime_dir(root_dir).join(INDEXED_DOCUMENT_JOURNAL_FILE)
}

pub fn priority_hints_path(root_dir: &str) -> PathBuf {
    runtime_dir(root_dir).join(PRIORITY_HINTS_FILE)
}
