use super::state_store::{
    export_catalog_snapshot_path, file_version, write_compact_json, FileVersion,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex, OnceLock},
};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExportCatalogSnapshot {
    #[serde(default)]
    pub version: u32,
    pub generated_at: Option<String>,
    pub tags: Vec<SnapshotTag>,
    pub documents: Vec<SnapshotDocument>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SnapshotTag {
    pub path: String,
    pub name: String,
    pub root_type: String,
    pub parent_path: Option<String>,
    pub depth: usize,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SnapshotDocument {
    pub document_id: String,
    pub path: String,
    pub title: String,
    pub summary: String,
    pub tags: Vec<String>,
    pub derived_tags: Vec<String>,
    pub mtime: String,
}

type CatalogCache = HashMap<PathBuf, (FileVersion, Arc<ExportCatalogSnapshot>)>;

fn cache() -> &'static Mutex<CatalogCache> {
    static CACHE: OnceLock<Mutex<CatalogCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(crate) fn read_catalog(root: &str) -> Result<Option<Arc<ExportCatalogSnapshot>>, String> {
    let path = export_catalog_snapshot_path(root);
    let version = file_version(&path);
    if version.is_none() {
        return Ok(None);
    }
    let mut cache = cache().lock().unwrap();
    if let Some((cached_version, snapshot)) = cache.get(&path) {
        if *cached_version == version {
            return Ok(Some(Arc::clone(snapshot)));
        }
    }
    let snapshot: ExportCatalogSnapshot = crate::read_json_file(&path)?;
    let snapshot = Arc::new(snapshot);
    cache.insert(path, (version, Arc::clone(&snapshot)));
    Ok(Some(snapshot))
}

pub(crate) fn write_catalog(root: &str, snapshot: ExportCatalogSnapshot) -> Result<(), String> {
    let path = export_catalog_snapshot_path(root);
    write_compact_json(&path, &snapshot)?;
    cache()
        .lock()
        .unwrap()
        .insert(path.clone(), (file_version(&path), Arc::new(snapshot)));
    Ok(())
}

pub(crate) fn refresh_catalog_cache(root: &str, snapshot: Option<ExportCatalogSnapshot>) {
    let path = export_catalog_snapshot_path(root);
    let mut cache = cache().lock().unwrap();
    if let Some(snapshot) = snapshot {
        cache.insert(path.clone(), (file_version(&path), Arc::new(snapshot)));
    } else {
        cache.remove(&path);
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn 兼容旧导出快照缺少版本和生成时间() {
        let snapshot: super::ExportCatalogSnapshot =
            serde_json::from_value(serde_json::json!({ "tags": [], "documents": [] })).unwrap();
        assert!(snapshot.generated_at.is_none());
    }
}
