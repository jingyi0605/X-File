use std::path::PathBuf;

pub const AI_INDEX_DIR: &str = ".ai-index";
pub const RUNTIME_DIR: &str = "runtime";
pub const EXPORT_DIR: &str = "exports";
pub const RUNTIME_STATUS_FILE: &str = "runtime-status.json";
pub const ACTIVE_FILE_STATE_SNAPSHOT_FILE: &str = "active-file-state-snapshot.json";
pub const INDEX_STATE_SNAPSHOT_FILE: &str = "index-state.json";
pub const EXPORT_CATALOG_SNAPSHOT_FILE: &str = "export-catalog-snapshot.json";
pub const INDEXED_DOCUMENT_JOURNAL_FILE: &str = "indexed-document-journal.jsonl";
pub const SUMMARY_BACKFILL_STATE_FILE: &str = "summary-backfill-state.json";
pub const PRIORITY_HINTS_FILE: &str = "priority-hints.json";
pub const EXPORT_MANIFEST_FILE: &str = "manifest.json";
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

pub fn summary_backfill_state_path(root_dir: &str) -> PathBuf {
    runtime_dir(root_dir).join(SUMMARY_BACKFILL_STATE_FILE)
}

pub fn priority_hints_path(root_dir: &str) -> PathBuf {
    runtime_dir(root_dir).join(PRIORITY_HINTS_FILE)
}

pub fn export_manifest_path(root_dir: &str) -> PathBuf {
    export_dir(root_dir).join(EXPORT_MANIFEST_FILE)
}

pub fn search_manifest_path(root_dir: &str) -> PathBuf {
    export_dir(root_dir).join(SEARCH_MANIFEST_RELATIVE_PATH)
}
