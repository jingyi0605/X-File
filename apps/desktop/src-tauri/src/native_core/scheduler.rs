use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::sync::Mutex;

use super::state_store::runtime_dir;

/// 根目录在队列中即表示已有执行线程，后续请求只合并待处理工作。
pub struct RootScheduler<T> {
    roots: Mutex<HashMap<String, Option<T>>>,
}

impl<T> RootScheduler<T> {
    pub fn new() -> Self {
        Self {
            roots: Mutex::new(HashMap::new()),
        }
    }

    pub fn submit(&self, root: &str, work: T, merge: impl FnOnce(&mut T, T)) -> bool {
        let mut roots = self.roots.lock().unwrap();
        if let Some(pending) = roots.get_mut(root) {
            if let Some(previous) = pending {
                merge(previous, work);
            } else {
                *pending = Some(work);
            }
            return false;
        }
        roots.insert(root.to_string(), Some(work));
        true
    }

    pub fn next(&self, root: &str) -> Option<T> {
        let mut roots = self.roots.lock().unwrap();
        let pending = roots.get_mut(root)?.take();
        if pending.is_none() {
            roots.remove(root);
        }
        pending
    }
}

/// 系统文件锁覆盖独立 CLI 进程，进程退出时由操作系统释放。
pub fn lock_root(root: &str) -> Result<File, String> {
    let directory = runtime_dir(root);
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(directory.join("worker.lock"))
        .map_err(|error| error.to_string())?;
    file.lock().map_err(|error| error.to_string())?;
    Ok(file)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 同根目录请求合并且运行中变更不会丢失() {
        let scheduler = RootScheduler::new();
        assert!(scheduler.submit("a", vec![1], |a, b| a.extend(b)));
        assert!(!scheduler.submit("a", vec![2], |a, b| a.extend(b)));
        assert_eq!(scheduler.next("a"), Some(vec![1, 2]));
        assert!(!scheduler.submit("a", vec![3], |a, b| a.extend(b)));
        assert_eq!(scheduler.next("a"), Some(vec![3]));
        assert_eq!(scheduler.next("a"), None);
        assert!(scheduler.submit("a", vec![4], |a, b| a.extend(b)));
        assert!(scheduler.submit("b", vec![5], |a, b| a.extend(b)));
    }

    #[test]
    fn 系统锁按根目录隔离且释放后可再次获取() {
        let root = std::env::temp_dir().join(format!("x-file-lock-{}", crate::epoch_millis()));
        let first = lock_root(root.to_str().unwrap()).unwrap();
        let second = OpenOptions::new()
            .read(true)
            .write(true)
            .open(runtime_dir(root.to_str().unwrap()).join("worker.lock"))
            .unwrap();
        assert!(second.try_lock().is_err());
        let other = lock_root(root.join("other").to_str().unwrap()).unwrap();
        drop(first);
        second.lock().unwrap();
        drop(second);
        drop(other);
        fs::remove_dir_all(root).unwrap();
    }
}
