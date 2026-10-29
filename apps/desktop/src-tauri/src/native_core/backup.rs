use super::catalog::{read_catalog, refresh_catalog_cache, ExportCatalogSnapshot};
use super::scheduler::try_lock_root;
use super::state_store::{
    active_file_state_snapshot_path, export_catalog_snapshot_path, index_state_snapshot_path,
};
use super::tag_core::read_local_library_tags_store;
use crate::{
    iso_now, read_json_file, read_local_library_binding, x_file_data_dir,
    LocalLibraryFavoriteRecord, LocalLibraryBinding, LocalStoredLibraryTags,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::path::{Path, PathBuf};

const FORMAT: &str = "x-file-library-backup";
const VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryBackup {
    format: String,
    version: u32,
    created_at: String,
    library: LibraryFingerprint,
    tags: BackupTags,
    favorites: Vec<LocalLibraryFavoriteRecord>,
    index: BackupIndex,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LibraryFingerprint {
    root_name: String,
    directories: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupIndex {
    catalog: Option<ExportCatalogSnapshot>,
    active_file_state_snapshot: Option<Value>,
    index_state_snapshot: Option<Value>,
    runtime_status: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupTags {
    tags: Vec<crate::LocalStoredTagDefinition>,
    tag_rules: Vec<crate::LocalStoredTagRule>,
    document_tags: Vec<crate::LocalStoredDocumentTagBinding>,
    folder_tags: Vec<crate::LocalStoredFolderTagBinding>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryBackupImportResult {
    pub imported: bool,
    pub tag_count: usize,
    pub document_binding_count: usize,
    pub folder_binding_count: usize,
    pub document_count: usize,
    pub refresh_scheduled: bool,
    pub refresh_error: Option<String>,
}

pub fn export_library_backup() -> Result<Value, String> {
    let binding = read_local_library_binding()?.ok_or_else(|| "请先绑定文档库根目录".to_owned())?;
    let _root_lock = try_lock_root(&binding.root_dir)?;
    let fingerprint = read_directory_fingerprint(Path::new(&binding.root_dir))?;
    let tags = read_local_library_tags_store(&binding)?;
    let favorites = read_favorites(&binding)?;
    let root = &binding.root_dir;
    let backup = LibraryBackup {
        format: FORMAT.to_owned(),
        version: VERSION,
        created_at: iso_now(),
        library: fingerprint,
        tags: BackupTags {
            tags: tags.tags,
            tag_rules: tags.tag_rules,
            document_tags: tags.document_tags,
            folder_tags: tags.folder_tags,
        },
        favorites,
        index: BackupIndex {
            catalog: read_catalog(root)
                .map_err(|error| format!("读取索引快照失败：{error}"))?
                .map(|catalog| (*catalog).clone()),
            active_file_state_snapshot: read_optional_json(&active_file_state_snapshot_path(root))?,
            index_state_snapshot: read_optional_json(&index_state_snapshot_path(root))?,
            runtime_status: None,
        },
    };
    serde_json::to_value(backup).map_err(|error| format!("生成资料库备份失败：{error}"))
}

pub fn write_library_backup_file(path: &str, content: &str) -> Result<(), String> {
    let path = Path::new(path);
    if path.as_os_str().is_empty() {
        return Err("备份保存路径不能为空".to_owned());
    }
    fs::write(path, content.as_bytes()).map_err(|error| format!("写入资料库备份失败：{error}"))
}

pub fn import_library_backup(
    value: Value,
    app: Option<tauri::AppHandle>,
) -> Result<LibraryBackupImportResult, String> {
    let backup: LibraryBackup = serde_json::from_value(value)
        .map_err(|error| format!("备份文件无效或格式不受支持：{error}"))?;
    if backup.format != FORMAT || backup.version != VERSION {
        return Err("备份文件格式或版本不受支持".to_owned());
    }
    validate_backup(&backup)?;

    let binding = read_local_library_binding()?.ok_or_else(|| "请先绑定文档库根目录".to_owned())?;
    let root_lock = try_lock_root(&binding.root_dir)?;
    let current_fingerprint = read_directory_fingerprint(Path::new(&binding.root_dir))?;
    let differences = compare_fingerprints(&backup.library, &current_fingerprint);
    if !differences.is_empty() {
        return Err(format!("备份与当前资料库目录结构不匹配：{}", differences.join("；")));
    }

    let tag_count = backup.tags.tags.len();
    let document_binding_count = backup.tags.document_tags.len();
    let folder_binding_count = backup.tags.folder_tags.len();
    let document_count = backup.index.catalog.as_ref().map_or(0, |catalog| catalog.documents.len());

    let imported_catalog = backup.index.catalog.clone();
    let files = build_replacements(&binding, &backup)?;
    replace_files(&files)?;
    refresh_catalog_cache(&binding.root_dir, imported_catalog);
    crate::native_index::invalidate_state_cache(&binding.root_dir);
    drop(root_lock);
    let (refresh_scheduled, refresh_error) = match schedule_full_refresh("library_backup_imported", app) {
        Ok(_) => (true, None),
        Err(error) => (false, Some(error)),
    };
    Ok(LibraryBackupImportResult {
        imported: true,
        tag_count,
        document_binding_count,
        folder_binding_count,
        document_count,
        refresh_scheduled,
        refresh_error,
    })
}

pub fn schedule_full_refresh(reason: &str, app: Option<tauri::AppHandle>) -> Result<bool, String> {
    let binding = read_local_library_binding()?.ok_or_else(|| "请先绑定文档库根目录".to_owned())?;
    let payload = super::super::build_native_library_worker_payload(
        &binding,
        reason.to_owned(),
        None,
        None,
    );
    Ok(super::super::schedule_library_work("full", payload, app))
}

fn validate_backup(backup: &LibraryBackup) -> Result<(), String> {
    if backup.format != FORMAT || backup.version != VERSION {
        return Err("备份文件格式或版本不受支持".to_owned());
    }
    if backup.created_at.trim().is_empty() || backup.library.root_name.trim().is_empty()
        || backup.library.root_name.contains('/') || backup.library.root_name.contains('\\') {
        return Err("备份缺少创建时间或资料库目录信息".to_owned());
    }
    let mut seen = BTreeSet::new();
    for directory in &backup.library.directories {
        if !is_safe_relative_path(directory) || directory.split('/').count() > 2 || !seen.insert(directory) {
            return Err("备份包含无效或重复的浅层目录路径".to_owned());
        }
    }
    let tag_ids = backup.tags.tags.iter().map(|tag| tag.id.as_str()).collect::<BTreeSet<_>>();
    if tag_ids.len() != backup.tags.tags.len() {
        return Err("备份包含重复标签 ID".to_owned());
    }
    if backup.tags.tag_rules.iter().any(|rule| !tag_ids.contains(rule.tag_id.as_str())) {
        return Err("备份规则引用了不存在的标签".to_owned());
    }
    if backup.tags.tags.iter().any(|tag| {
        tag.parent_id.as_deref().is_some_and(|parent_id| !tag_ids.contains(parent_id))
            || !is_safe_tag_path(&tag.path)
    }) {
        return Err("备份标签层级或路径无效".to_owned());
    }
    if backup.tags.document_tags.iter().any(|item| {
        !is_safe_relative_path(&item.path)
            || item.manual_tag_ids.iter().any(|id| !tag_ids.contains(id.as_str()))
    }) || backup.tags.folder_tags.iter().any(|item| {
        (!item.folder_path.is_empty() && !is_safe_relative_path(&item.folder_path))
            || item.binding_tag_ids.iter().any(|id| !tag_ids.contains(id.as_str()))
    }) {
        return Err("备份包含无效的标签绑定或相对路径".to_owned());
    }
    if backup.favorites.iter().any(|favorite| {
        !matches!(favorite.kind.as_str(), "folder" | "tag" | "tag_filter")
            || (favorite.path.is_empty() && favorite.kind != "folder")
            || (!favorite.path.is_empty() && !is_safe_relative_path(&favorite.path))
            || favorite.tag_paths.as_ref().is_some_and(|paths| paths.iter().any(|item| !is_safe_relative_path(item)))
    }) {
        return Err("备份包含无效收藏路径".to_owned());
    }
    if let Some(catalog) = &backup.index.catalog {
        if catalog.documents.iter().any(|item| !is_safe_relative_path(&item.path)) {
            return Err("备份索引快照包含无效文档路径".to_owned());
        }
    }
    validate_runtime_snapshot_paths(backup.index.active_file_state_snapshot.as_ref(), "files")?;
    validate_runtime_snapshot_paths(backup.index.index_state_snapshot.as_ref(), "failedDocuments")?;
    validate_runtime_snapshot_paths(backup.index.index_state_snapshot.as_ref(), "skippedDocuments")?;
    if backup.index.index_state_snapshot.as_ref()
        .and_then(|snapshot| snapshot.get("parserSkips"))
        .and_then(Value::as_array)
        .is_some_and(|items| items.iter().any(|item| {
            item.get("samplePaths").and_then(Value::as_array).map_or(true, |paths| {
                paths.iter().any(|path| path.as_str().map_or(true, |value| !is_safe_relative_path(value)))
            })
        })) {
        return Err("备份解析状态包含无效路径".to_owned());
    }
    if backup.index.runtime_status.is_some() {
        return Err("备份运行时状态必须为空".to_owned());
    }
    Ok(())
}

fn validate_runtime_snapshot_paths(snapshot: Option<&Value>, field: &str) -> Result<(), String> {
    let Some(snapshot) = snapshot else { return Ok(()); };
    let Some(entries) = snapshot.get(field).and_then(Value::as_array) else {
        return Err(format!("备份索引状态缺少有效的 {field}"));
    };
    if entries.iter().any(|item| {
        item.get("path").and_then(Value::as_str).map_or(true, |path| !is_safe_relative_path(path))
    }) {
        return Err("备份索引状态包含无效路径".to_owned());
    }
    Ok(())
}

fn read_directory_fingerprint(root: &Path) -> Result<LibraryFingerprint, String> {
    let root_name = root.file_name().and_then(|value| value.to_str())
        .ok_or_else(|| "无法识别资料库根目录名称".to_owned())?.to_owned();
    let entries = fs::read_dir(root).map_err(|error| format!("无法读取资料库目录结构：{error}"))?;
    let mut directories = BTreeSet::new();
    for entry in entries {
        let entry = entry.map_err(|error| format!("读取资料库目录失败：{error}"))?;
        let file_type = entry.file_type().map_err(|error| format!("读取目录类型失败：{error}"))?;
        if !file_type.is_dir() || is_internal_directory(&entry.file_name().to_string_lossy()) { continue; }
        let name = entry.file_name().into_string().map_err(|_| "资料库包含非 UTF-8 目录名，无法生成备份".to_owned())?;
        directories.insert(name.clone());
        let children = fs::read_dir(entry.path()).map_err(|error| format!("无法读取浅层目录 {name}：{error}"))?;
        for child in children {
            let child = child.map_err(|error| format!("读取浅层目录失败：{error}"))?;
            if !child.file_type().map_err(|error| error.to_string())?.is_dir() { continue; }
            let child_name = child.file_name().into_string().map_err(|_| "资料库包含非 UTF-8 目录名，无法生成备份".to_owned())?;
            directories.insert(format!("{name}/{child_name}"));
        }
    }
    Ok(LibraryFingerprint { root_name, directories: directories.into_iter().collect() })
}

fn compare_fingerprints(backup: &LibraryFingerprint, current: &LibraryFingerprint) -> Vec<String> {
    let mut differences = Vec::new();
    if backup.root_name != current.root_name { differences.push("资料库根目录名称不同".to_owned()); }
    let expected = backup.directories.iter().collect::<BTreeSet<_>>();
    let actual = current.directories.iter().collect::<BTreeSet<_>>();
    let missing = expected.difference(&actual).take(5).map(|item| item.as_str()).collect::<Vec<_>>();
    let added = actual.difference(&expected).take(5).map(|item| item.as_str()).collect::<Vec<_>>();
    if !missing.is_empty() || !added.is_empty() {
        differences.push(format!("浅层目录不同（缺少：{}；新增：{}）",
            if missing.is_empty() { "无".to_owned() } else { missing.join(", ") },
            if added.is_empty() { "无".to_owned() } else { added.join(", ") }));
    }
    differences
}

fn is_safe_relative_path(value: &str) -> bool {
    if value.is_empty() || value.starts_with('/') || value.contains('\\') { return false; }
    value.split('/').all(|segment| !segment.is_empty() && segment != "." && segment != "..")
        && !value.split('/').next().is_some_and(is_internal_directory)
}

fn is_safe_tag_path(value: &str) -> bool {
    !value.trim().is_empty() && value.split('/').all(|segment| {
        let segment = segment.trim();
        !segment.is_empty() && segment != "." && segment != ".."
    })
}

fn is_internal_directory(name: &str) -> bool {
    name == ".ai-index" || name == ".x-file"
}

fn read_favorites(binding: &LocalLibraryBinding) -> Result<Vec<LocalLibraryFavoriteRecord>, String> {
    let path = x_file_data_dir().join("library-favorites.json");
    if !path.is_file() { return Ok(Vec::new()); }
    let payload: HashMap<String, Value> = read_json_file(&path)?;
    let key = format!("{}:{}", binding.library_id, binding.root_dir);
    let value = payload.get(&key).and_then(|item| item.get("favorites")).cloned().unwrap_or_else(|| json!([]));
    serde_json::from_value(value).map_err(|error| format!("解析收藏备份失败：{error}"))
}

fn build_replacements(binding: &LocalLibraryBinding, backup: &LibraryBackup) -> Result<Vec<(PathBuf, Option<Vec<u8>>)>, String> {
    let data_dir = x_file_data_dir();
    let favorites_path = data_dir.join("library-favorites.json");
    let mut favorites: HashMap<String, Value> = if favorites_path.is_file() { read_json_file(&favorites_path)? } else { HashMap::new() };
    let key = format!("{}:{}", binding.library_id, binding.root_dir);
    favorites.insert(key.clone(), json!({ "libraryId": binding.library_id, "rootDir": binding.root_dir,
        "favorites": backup.favorites, "updatedAt": iso_now() }));
    let tag_store_path = data_dir.join("library-tags.json");
    let mut tag_stores: HashMap<String, LocalStoredLibraryTags> = if tag_store_path.is_file() {
        read_json_file(&tag_store_path)?
    } else {
        HashMap::new()
    };
    let tag_store = LocalStoredLibraryTags {
        library_id: binding.library_id.clone(),
        root_dir: binding.root_dir.clone(),
        tags: backup.tags.tags.clone(),
        tag_rules: backup.tags.tag_rules.clone(),
        document_tags: backup.tags.document_tags.clone(),
        folder_tags: backup.tags.folder_tags.clone(),
        updated_at: iso_now(),
    };
    tag_stores.insert(key, tag_store);
    let runtime_files = vec![
        (active_file_state_snapshot_path(&binding.root_dir), backup.index.active_file_state_snapshot.as_ref()),
        (index_state_snapshot_path(&binding.root_dir), backup.index.index_state_snapshot.as_ref()),
        (super::state_store::runtime_status_path(&binding.root_dir), backup.index.runtime_status.as_ref()),
    ];
    let catalog_path = export_catalog_snapshot_path(&binding.root_dir);
    let mut replacements = vec![
        (favorites_path, Some(serialize_json(&favorites)?)),
        (tag_store_path, Some(serialize_json(&tag_stores)?)),
        (catalog_path, backup.index.catalog.as_ref().map(serialize_json).transpose()?),
    ];
    for (path, value) in runtime_files {
        replacements.push((path, value.map(serialize_json).transpose()?));
    }
    Ok(replacements)
}

fn replace_files(replacements: &[(PathBuf, Option<Vec<u8>>)]) -> Result<(), String> {
    let originals = replacements.iter().map(|(path, _)| {
        Ok((path.clone(), if path.is_file() { Some(fs::read(path).map_err(|error| error.to_string())?) } else { None }))
    }).collect::<Result<Vec<_>, String>>()?;
    let result = (|| {
        for (path, content) in replacements {
            match content {
                Some(content) => {
                    replace_one_file(path, content)?;
                }
                None => remove_if_exists(path)?,
            }
        }
        Ok::<(), String>(())
    })();
    if let Err(error) = result {
        restore_originals(originals);
        return Err(error);
    }
    Ok(())
}

fn restore_originals(originals: Vec<(PathBuf, Option<Vec<u8>>)>) {
    for (path, content) in originals {
        match content {
            Some(bytes) => { let _ = fs::write(path, bytes); }
            None => { let _ = remove_if_exists(&path); }
        }
    }
}

fn replace_one_file(path: &Path, content: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or_else(|| "恢复文件缺少父目录".to_owned())?;
    fs::create_dir_all(parent).map_err(|error| format!("创建恢复目录失败：{error}"))?;
    let temporary = path.with_extension(format!("tmp-{}", std::process::id()));
    let backup = path.with_extension(format!("restore-backup-{}", std::process::id()));
    fs::write(&temporary, content).map_err(|error| format!("写入恢复临时数据失败：{error}"))?;
    if path.exists() {
        fs::rename(path, &backup).map_err(|error| format!("暂存原文件失败：{error}"))?;
    }
    if let Err(error) = fs::rename(&temporary, path) {
        if backup.exists() { let _ = fs::rename(&backup, path); }
        let _ = fs::remove_file(&temporary);
        return Err(format!("替换恢复文件失败：{error}"));
    }
    let _ = fs::remove_file(backup);
    Ok(())
}

fn serialize_json(value: &impl Serialize) -> Result<Vec<u8>, String> {
    serde_json::to_vec_pretty(value).map_err(|error| format!("序列化恢复数据失败：{error}"))
}

fn read_optional_json(path: &Path) -> Result<Option<Value>, String> {
    if !path.is_file() { return Ok(None); }
    read_json_file(&path.to_path_buf()).map(Some)
}

fn remove_if_exists(path: &Path) -> Result<(), String> {
    if path.exists() { fs::remove_file(path).map_err(|error| format!("清理旧快照失败：{error}"))?; }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::os::unix::fs::symlink;

    #[test]
    fn 拒绝未知版本和越界文档路径() {
        let mut backup = valid_backup();
        backup["version"] = json!(2);
        let unsupported: LibraryBackup = serde_json::from_value(backup.clone()).unwrap();
        assert!(validate_backup(&unsupported).is_err());

        backup["version"] = json!(1);
        backup["tags"]["tags"] = json!([{
            "id": "tag-1", "path": "Topic", "name": "Topic", "rootType": "Topic",
            "parentId": null, "parentPath": null, "description": null, "status": "active",
            "createdAt": "2026-01-01T00:00:00Z", "updatedAt": "2026-01-01T00:00:00Z",
            "disabledAt": null, "childTagSelectionMode": "multiple"
        }]);
        backup["tags"]["documentTags"] = json!([{
            "documentId": "doc-1", "path": "../outside.md", "title": "outside",
            "manualTagIds": ["tag-1"], "updatedAt": "2026-01-01T00:00:00Z"
        }]);
        let parsed: LibraryBackup = serde_json::from_value(backup).unwrap();
        assert!(validate_backup(&parsed).is_err());
    }

    #[test]
    fn 替换已有文件使用可回滚的跨平台文件名交换() {
        let root = std::env::temp_dir().join(format!("x-file-backup-replace-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let target = root.join("snapshot.json");
        fs::write(&target, "old").unwrap();
        replace_one_file(&target, b"new").unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"new");
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn 写入备份文件保留导出内容() {
        let root = std::env::temp_dir().join(format!("x-file-backup-write-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let target = root.join("backup.json");
        write_library_backup_file(target.to_str().unwrap(), "{\"format\":\"x-file-library-backup\"}\n").unwrap();
        assert_eq!(
            fs::read_to_string(&target).unwrap(),
            "{\"format\":\"x-file-library-backup\"}\n"
        );
        fs::remove_dir_all(root).unwrap();
    }

    fn valid_backup() -> Value {
        json!({
            "format": FORMAT,
            "version": VERSION,
            "createdAt": "2026-10-29T00:00:00Z",
            "library": { "rootName": "Library", "directories": ["docs", "docs/contracts"] },
            "tags": { "tags": [], "tagRules": [], "documentTags": [], "folderTags": [] },
            "favorites": [],
            "index": { "catalog": null, "activeFileStateSnapshot": null,
                "indexStateSnapshot": null, "runtimeStatus": null }
        })
    }

    #[cfg(unix)]
    #[test]
    fn 浅层目录指纹只包含两层且忽略内部目录和符号链接() {
        let root = std::env::temp_dir().join(format!("x-file-backup-fingerprint-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("docs/sub/deep")).unwrap();
        fs::create_dir_all(root.join(".ai-index/runtime")).unwrap();
        fs::create_dir_all(root.join(".x-file/private")).unwrap();
        symlink(root.join("docs"), root.join("linked")).unwrap();
        let fingerprint = read_directory_fingerprint(&root).unwrap();
        assert_eq!(fingerprint.root_name, root.file_name().unwrap().to_string_lossy());
        assert_eq!(fingerprint.directories, vec!["docs", "docs/sub"]);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn 目录名或浅层目录不同会被检测文件变化不会影响指纹() {
        let root = std::env::temp_dir().join(format!("x-file-backup-compare-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("Library/docs/sub")).unwrap();
        fs::write(root.join("Library/docs/a.md"), "first").unwrap();
        let original = read_directory_fingerprint(&root.join("Library")).unwrap();
        fs::write(root.join("Library/docs/a.md"), "changed").unwrap();
        fs::write(root.join("Library/docs/b.md"), "new").unwrap();
        assert!(compare_fingerprints(&original, &read_directory_fingerprint(&root.join("Library")).unwrap()).is_empty());
        fs::create_dir(root.join("Library/other")).unwrap();
        assert!(!compare_fingerprints(&original, &read_directory_fingerprint(&root.join("Library")).unwrap()).is_empty());
        fs::remove_dir_all(root).unwrap();
    }
}
