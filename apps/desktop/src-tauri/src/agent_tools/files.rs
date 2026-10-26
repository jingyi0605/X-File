use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};

use super::{native, refresh, ToolError};
use crate::{is_native_library_path_visible, lock_root, sha256_hex, LocalLibraryBinding};

const MAX_FILE_BYTES: u64 = 20 * 1024 * 1024;
const MAX_TEXT_BYTES: usize = 512 * 1024;
static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub fn resolve(
    bound: &LocalLibraryBinding,
    input: &str,
    writing: bool,
    allow_root: bool,
) -> Result<PathBuf, ToolError> {
    let relative = normalize(input, allow_root)?;
    let root = fs::canonicalize(&bound.root_dir)?;
    let mut current = root.clone();
    for part in Path::new(&relative).components() {
        if part == Component::CurDir {
            continue;
        }
        current.push(part.as_os_str());
        match fs::symlink_metadata(&current) {
            Ok(meta) => {
                if writing && meta.file_type().is_symlink() {
                    return Err(ToolError::new("PATH_SYMLINK", "写操作不能经过符号链接"));
                }
                let canonical = fs::canonicalize(&current)?;
                if !canonical.starts_with(&root) {
                    return Err(ToolError::new(
                        "PATH_OUTSIDE_LIBRARY",
                        "符号链接指向资料库以外",
                    ));
                }
                let actual = canonical
                    .strip_prefix(&root)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/");
                if !actual.is_empty() {
                    normalize(&actual, true)?;
                    if !is_native_library_path_visible(
                        &actual,
                        fs::metadata(&canonical)?.is_dir(),
                        &bound.included_hidden_paths,
                        bound.hide_dot_files,
                        bound.hide_system_folders,
                    ) {
                        return Err(ToolError::new(
                            "PATH_HIDDEN",
                            "真实路径被资料库可见性配置排除",
                        ));
                    }
                }
                current = canonical;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    let is_dir = fs::metadata(&current).map(|m| m.is_dir()).unwrap_or(true);
    if relative != "."
        && !is_native_library_path_visible(
            &relative,
            is_dir,
            &bound.included_hidden_paths,
            bound.hide_dot_files,
            bound.hide_system_folders,
        )
    {
        return Err(ToolError::new("PATH_HIDDEN", "路径被资料库可见性配置排除"));
    }
    Ok(current)
}

fn normalize(input: &str, allow_root: bool) -> Result<String, ToolError> {
    let input = input.replace('\\', "/");
    if input.is_empty() || input.contains('\0') || input.contains(':') || input.starts_with('/') {
        return Err(ToolError::new("PATH_INVALID", "必须提供资料库内的相对路径"));
    }
    let parts: Vec<&str> = input
        .split('/')
        .filter(|p| !p.is_empty() && *p != ".")
        .collect();
    if parts.iter().any(|p| *p == "..") {
        return Err(ToolError::new(
            "PATH_OUTSIDE_LIBRARY",
            "路径不能包含上级目录",
        ));
    }
    if parts
        .first()
        .is_some_and(|p| p.eq_ignore_ascii_case(".ai-index") || p.eq_ignore_ascii_case(".x-file"))
    {
        return Err(ToolError::new(
            "PATH_RESERVED",
            "不能直接访问资料库内部状态目录",
        ));
    }
    if parts.is_empty() {
        return if allow_root {
            Ok(".".into())
        } else {
            Err(ToolError::new("PATH_INVALID", "不能操作资料库根目录"))
        };
    }
    // Windows 会忽略末尾空格和句点，拒绝这些跨平台含义不一致的路径。
    if parts.iter().any(|p| p.ends_with([' ', '.'])) {
        return Err(ToolError::new("PATH_INVALID", "路径段不能以空格或句点结尾"));
    }
    Ok(parts.join("/"))
}

pub fn read(bound: &LocalLibraryBinding, args: &Value) -> Result<Value, ToolError> {
    let path = resolve(bound, args["path"].as_str().unwrap(), false, false)?;
    let meta = fs::metadata(&path)?;
    if !meta.is_file() {
        return Err(ToolError::new("NOT_A_FILE", "指定路径不是文件"));
    }
    if meta.len() > MAX_FILE_BYTES {
        return Err(ToolError::new("FILE_TOO_LARGE", "文件读取上限为 20 MiB"));
    }
    let mut bytes = Vec::new();
    fs::File::open(path)?
        .take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err(ToolError::new("FILE_TOO_LARGE", "文件读取期间超过 20 MiB"));
    }
    let offset = args["offset"].as_u64().unwrap_or(0) as usize;
    let limit = args["limitBytes"].as_u64().unwrap_or(128 * 1024) as usize;
    if offset > bytes.len() {
        return Err(ToolError::new("INVALID_ARGUMENT", "offset 超过文件长度").field("offset"));
    }
    let encoding = args["encoding"].as_str().unwrap_or("utf8");
    let mut end = (offset + limit).min(bytes.len());
    let content = if encoding == "base64" {
        STANDARD.encode(&bytes[offset..end])
    } else {
        let text = std::str::from_utf8(&bytes).map_err(|_| {
            ToolError::new("UNSUPPORTED_ENCODING", "文件不是 UTF-8 文本，请使用 base64")
        })?;
        if !text.is_char_boundary(offset) {
            return Err(
                ToolError::new("INVALID_ARGUMENT", "offset 必须位于 UTF-8 字符边界")
                    .field("offset"),
            );
        }
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        text[offset..end].to_string()
    };
    Ok(json!({
        "path": args["path"], "encoding": encoding, "content": content,
        "size": bytes.len(), "version": sha256_hex(&bytes), "offset": offset,
        "nextOffset": end, "truncated": end < bytes.len()
    }))
}

pub fn operate(bound: &LocalLibraryBinding, args: &Value) -> Result<Value, ToolError> {
    let operation = args["opType"].as_str().unwrap();
    let source_name = args["srcPath"].as_str();
    let target_name = args["dstPath"].as_str();
    let source = source_name
        .map(|p| resolve(bound, p, true, false))
        .transpose()?;
    let target = target_name
        .map(|p| resolve(bound, p, true, false))
        .transpose()?;
    let paths: Vec<&str> = source_name.into_iter().chain(target_name).collect();
    {
        let _lock = native(lock_root(&bound.root_dir))?;
        match operation {
            "create_directory" => {
                let target = target.as_ref().unwrap();
                ensure_new_target(target)?;
                fs::create_dir_all(target.parent().unwrap())?;
                fs::create_dir(target)?;
            }
            "create_file" => write_new(
                target.as_ref().unwrap(),
                args["content"].as_str().unwrap_or("").as_bytes(),
            )?,
            "write" => overwrite(source.as_ref().unwrap(), args)?,
            "delete" => remove(
                source.as_ref().unwrap(),
                args["recursive"].as_bool().unwrap_or(false),
            )?,
            "move" | "copy" => {
                let source = source.as_ref().unwrap();
                let target = target.as_ref().unwrap();
                ensure_new_target(target)?;
                if target.starts_with(source) {
                    return Err(ToolError::new("PATH_INVALID", "目标不能是源路径或其子目录"));
                }
                fs::create_dir_all(target.parent().unwrap())?;
                if operation == "move" {
                    fs::rename(source, target)?;
                } else {
                    let mut budget = 10_000;
                    copy_tree(source, target, &mut budget)?;
                }
            }
            _ => return Err(ToolError::new("INVALID_ARGUMENT", "不支持的文件操作")),
        }
    }
    // 文件变更已经生效；索引失败只能作为后续状态报告，不能伪装成文件操作未执行。
    let index = refresh(bound, &json!({"targetPaths": paths}));
    let version_path = target.as_ref().or(source.as_ref());
    let version = if matches!(operation, "write" | "create_file") {
        version_path
            .and_then(|p| fs::read(p).ok())
            .map(|b| sha256_hex(&b))
    } else {
        None
    };
    Ok(json!({
        "success": true, "opType": operation, "sourcePath": source_name.or(target_name),
        "targetPath": if operation == "delete" { None } else { target_name.or(source_name) },
        "version": version, "indexUpdated": index.is_ok(),
        "indexError": index.err()
    }))
}

fn ensure_new_target(path: &Path) -> Result<(), ToolError> {
    if fs::symlink_metadata(path).is_ok() {
        return Err(ToolError::new("ALREADY_EXISTS", "目标路径已存在"));
    }
    Ok(())
}

fn write_new(path: &Path, bytes: &[u8]) -> Result<(), ToolError> {
    if bytes.len() > MAX_TEXT_BYTES {
        return Err(ToolError::new("FILE_TOO_LARGE", "写入上限为 512 KiB"));
    }
    fs::create_dir_all(path.parent().unwrap())?;
    let mut file = new_file(path)?;
    if let Err(error) = file.write_all(bytes).and_then(|_| file.sync_all()) {
        drop(file);
        let _ = fs::remove_file(path);
        return Err(error.into());
    }
    Ok(())
}

fn overwrite(path: &Path, args: &Value) -> Result<(), ToolError> {
    let meta = fs::metadata(path)?;
    if !meta.is_file() {
        return Err(ToolError::new("NOT_A_FILE", "写入目标不是文件"));
    }
    if meta.len() > MAX_TEXT_BYTES as u64 {
        return Err(ToolError::new("FILE_TOO_LARGE", "覆盖写入上限为 512 KiB"));
    }
    let mut old = Vec::new();
    fs::File::open(path)?
        .take(MAX_TEXT_BYTES as u64 + 1)
        .read_to_end(&mut old)?;
    if old.len() > MAX_TEXT_BYTES {
        return Err(ToolError::new(
            "FILE_TOO_LARGE",
            "读取期间文件超过覆盖写入上限",
        ));
    }
    if std::str::from_utf8(&old).is_err() || old.contains(&0) {
        return Err(ToolError::new(
            "UNSUPPORTED_ENCODING",
            "只支持覆盖 UTF-8 文本",
        ));
    }
    if sha256_hex(&old) != args["expectedVersion"].as_str().unwrap() {
        return Err(
            ToolError::new("VERSION_CONFLICT", "文件已变化，请重新读取并合并修改")
                .field("expectedVersion"),
        );
    }
    let bytes = args["content"].as_str().unwrap().as_bytes();
    if bytes.len() > MAX_TEXT_BYTES {
        return Err(ToolError::new("FILE_TOO_LARGE", "写入上限为 512 KiB"));
    }
    let temp = path.parent().unwrap().join(format!(
        ".x-file-agent-{}-{}.tmp",
        std::process::id(),
        TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        write_new(&temp, bytes)?;
        fs::set_permissions(&temp, meta.permissions())?;
        fs::rename(&temp, path)?;
        Ok(())
    })();
    let _ = fs::remove_file(temp);
    result
}

fn remove(path: &Path, recursive: bool) -> Result<(), ToolError> {
    if fs::metadata(path)?.is_dir() {
        if recursive {
            fs::remove_dir_all(path)?;
        } else {
            fs::remove_dir(path)?;
        }
    } else {
        fs::remove_file(path)?;
    }
    Ok(())
}

fn copy_tree(source: &Path, target: &Path, budget: &mut usize) -> Result<(), ToolError> {
    if *budget == 0 {
        return Err(ToolError::new(
            "OPERATION_TOO_LARGE",
            "单次复制最多处理 10000 个目录项",
        ));
    }
    *budget -= 1;
    let meta = fs::symlink_metadata(source)?;
    if meta.file_type().is_symlink() {
        return Err(ToolError::new("PATH_SYMLINK", "复制不跟随符号链接"));
    }
    if meta.is_dir() {
        fs::create_dir(target)?;
        let result: Result<(), ToolError> = (|| {
            for entry in fs::read_dir(source)? {
                let entry = entry?;
                copy_tree(&entry.path(), &target.join(entry.file_name()), budget)?;
            }
            Ok(())
        })();
        if result.is_err() {
            // 只有 create_dir 成功后才拥有目标；不能清理其他进程已创建的路径。
            let _ = fs::remove_dir_all(target);
        }
        result?;
    } else if meta.is_file() {
        let mut input = fs::File::open(source)?;
        let mut output = new_file(target)?;
        let copied = std::io::copy(&mut input, &mut output)
            .and_then(|_| output.set_permissions(meta.permissions()))
            .and_then(|_| output.sync_all());
        if let Err(error) = copied {
            drop(output);
            let _ = fs::remove_file(target);
            return Err(error.into());
        }
    } else {
        return Err(ToolError::new("UNSUPPORTED_FILE", "只支持普通文件和目录"));
    }
    Ok(())
}

fn new_file(path: &Path) -> Result<fs::File, ToolError> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    Ok(options.open(path)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 跨平台路径校验拒绝逃逸和内部目录() {
        for path in [
            "../a",
            "a/../../b",
            "/etc/passwd",
            "C:\\data",
            "\\\\host\\file",
            ".ai-index/a",
            ".X-FILE/a",
            "a/.. ",
        ] {
            assert!(normalize(path, false).is_err(), "{path}");
        }
        assert!(normalize(".", false).is_err());
        assert_eq!(normalize(".", true).unwrap(), ".");
        assert_eq!(normalize("docs\\a.md", false).unwrap(), "docs/a.md");
    }
}
