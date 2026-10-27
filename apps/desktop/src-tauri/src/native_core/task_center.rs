use std::cell::RefCell;
use std::collections::VecDeque;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::{atomic::{AtomicU64, Ordering}, Mutex, OnceLock};

use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskStageProgress {
    pub processed_count: usize,
    pub total_count: Option<usize>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryTask {
    pub task_id: String,
    pub task_type: String,
    pub root_dir: String,
    pub target_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category_title: Option<String>,
    pub source: String,
    pub state: String,
    pub stage: Option<String>,
    pub total_count: Option<usize>,
    pub processed_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stage_progress: Option<TaskStageProgress>,
    pub error_summary: Option<String>,
    pub queued_at: String,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
}

#[derive(Default)]
struct TaskCenter {
    tasks: VecDeque<LibraryTask>,
}

impl TaskCenter {
    fn update(&mut self, ids: &[String], update: impl Fn(&mut LibraryTask)) {
        for task in &mut self.tasks {
            if ids.contains(&task.task_id) {
                update(task);
            }
        }
        self.prune_history();
    }

    fn prune_history(&mut self) {
        let mut roots = self.tasks.iter()
            .filter(|task| task.state == "completed" || task.state == "failed")
            .map(|task| task.root_dir.clone())
            .collect::<std::collections::HashSet<_>>();
        let mut keep = std::collections::HashSet::new();
        for root in roots.drain() {
            let mut finished = self.tasks.iter()
                .filter(|task| task.root_dir == root && (task.state == "completed" || task.state == "failed"))
                .collect::<Vec<_>>();
            finished.sort_by(|left, right| right.completed_at.cmp(&left.completed_at));
            keep.extend(finished.into_iter().take(5).map(|task| task.task_id.clone()));
        }
        self.tasks.retain(|task| {
            (task.state != "completed" && task.state != "failed") || keep.contains(&task.task_id)
        });
    }
}

fn center() -> &'static Mutex<TaskCenter> {
    static CENTER: OnceLock<Mutex<TaskCenter>> = OnceLock::new();
    CENTER.get_or_init(|| Mutex::new(TaskCenter::default()))
}

type EventHandler = Box<dyn Fn(&LibraryTask) + Send + Sync>;
static EVENT_HANDLER: OnceLock<EventHandler> = OnceLock::new();

pub fn set_event_handler(handler: impl Fn(&LibraryTask) + Send + Sync + 'static) {
    let _ = EVENT_HANDLER.set(Box::new(handler));
}

fn update_tasks(ids: &[String], update: impl Fn(&mut LibraryTask)) {
    let updated = {
        let mut center = center().lock().unwrap();
        center.update(ids, update);
        center.tasks.iter().filter(|task| ids.contains(&task.task_id)).cloned().collect::<Vec<_>>()
    };
    if let Some(handler) = EVENT_HANDLER.get() {
        for task in &updated {
            handler(task);
        }
    }
}

thread_local! {
    static CURRENT: RefCell<Vec<String>> = const { RefCell::new(Vec::new()) };
}

pub fn register(root: &str, kind: &str, source: &str, target: Option<String>) -> String {
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    let id = format!("{}:{}:{}", kind, crate::epoch_millis(), SEQUENCE.fetch_add(1, Ordering::Relaxed));
    center().lock().unwrap().tasks.push_front(LibraryTask {
        task_id: id.clone(),
        task_type: kind.to_string(),
        root_dir: root.to_string(),
        target_path: target,
        category_title: None,
        source: source.to_string(),
        state: "queued".to_string(),
        stage: None,
        total_count: None,
        processed_count: 0,
        stage_progress: None,
        error_summary: None,
        queued_at: crate::iso_now(),
        started_at: None,
        completed_at: None,
    });
    id
}

pub fn list(root: &str) -> Vec<LibraryTask> {
    let mut center = center().lock().unwrap();
    center.prune_history();
    center.tasks.iter()
        .filter(|task| task.root_dir == root).cloned().collect()
}

pub fn stage(value: &str) {
    CURRENT.with(|current| {
        update_tasks(&current.borrow(), |task| {
            task.stage = Some(value.to_string());
            task.stage_progress = None;
        });
    });
}

pub fn progress(processed: usize, total: Option<usize>) {
    CURRENT.with(|current| {
        update_tasks(&current.borrow(), |task| {
            task.processed_count = processed;
            task.total_count = total;
        });
    });
}

pub fn stage_progress(stage: &str, processed: usize, total: Option<usize>) {
    CURRENT.with(|current| {
        update_tasks(&current.borrow(), |task| {
            task.stage = Some(stage.to_string());
            task.stage_progress = Some(TaskStageProgress { processed_count: processed, total_count: total });
        });
    });
}

pub fn category_title(value: String) {
    CURRENT.with(|current| {
        update_tasks(&current.borrow(), |task| {
            task.category_title = if value.is_empty() { None } else { Some(value.clone()) };
        });
    });
}

pub fn run<T>(ids: Vec<String>, work: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    update_tasks(&ids, |task| {
        task.state = "running".to_string();
        task.started_at = Some(crate::iso_now());
    });
    let parent = CURRENT.with(|current| current.replace(ids.clone()));
    let result = catch_unwind(AssertUnwindSafe(work)).unwrap_or_else(|panic| {
        let message = panic.downcast_ref::<String>().map(String::as_str)
            .or_else(|| panic.downcast_ref::<&str>().copied()).unwrap_or("后台任务异常退出");
        Err(message.to_string())
    });
    CURRENT.with(|current| current.replace(parent));
    update_tasks(&ids, |task| {
        task.state = if result.is_ok() { "completed" } else { "failed" }.to_string();
        task.error_summary = result.as_ref().err().cloned();
        task.completed_at = Some(crate::iso_now());
        task.stage = None;
        task.stage_progress = None;
    });
    result
}

pub fn run_new<T>(
    root: &str, kind: &str, source: &str, target: Option<String>,
    work: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    run(vec![register(root, kind, source, target)], work)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 保存阶段的进度独立于标签文件计数且完成后清空() {
        let root = "task-center-export-progress";
        run_new(root, "library.tag_assignment", "test", None, || {
            progress(40, Some(40));
            stage_progress("export_details", 20, Some(200));
            let tasks = list(root);
            assert_eq!(tasks[0].processed_count, 40);
            assert_eq!(tasks[0].total_count, Some(40));
            assert_eq!(tasks[0].stage_progress.as_ref().unwrap().processed_count, 20);
            assert_eq!(tasks[0].stage_progress.as_ref().unwrap().total_count, Some(200));
            assert_eq!(tasks[0].state, "running");
            Ok(())
        }).unwrap();
        assert!(list(root)[0].stage_progress.is_none());
    }

    #[test]
    fn 嵌套任务恢复父进度且按根目录隔离() {
        let root = "task-center-nested";
        let parent = register(root, "library.index", "test", None);
        run(vec![parent.clone()], || {
            run_new(root, "library.file_scan", "test", None, || {
                progress(3, None);
                Ok(())
            })?;
            progress(5, Some(8));
            assert!(list("other-library").is_empty());
            Ok(())
        }).unwrap();
        let tasks = list(root);
        let task = tasks.iter().find(|task| task.task_id == parent).unwrap();
        assert_eq!(task.processed_count, 5);
        assert_eq!(task.state, "completed");
        assert_eq!(tasks.iter().find(|task| task.task_type == "library.file_scan").unwrap().processed_count, 3);
    }

    #[test]
    fn 合并任务统一失败且异常不会留下运行状态() {
        let root = "task-center-failure";
        let ids = vec![register(root, "library.index", "test", None), register(root, "library.index", "test", None)];
        let result: Result<(), String> = run(ids, || panic!("测试异常"));
        assert_eq!(result.unwrap_err(), "测试异常");
        assert!(list(root).iter().all(|task| task.state == "failed" && task.error_summary.as_deref() == Some("测试异常")));
    }

    #[test]
    fn 历史裁剪按根目录保留最近五条且不删除活跃任务() {
        let mut center = TaskCenter::default();
        let template = LibraryTask {
            task_id: "active".into(), task_type: "library.index".into(), root_dir: "root".into(),
            target_path: None, category_title: None, source: "test".into(), state: "queued".into(), stage: None,
            total_count: None, processed_count: 0, stage_progress: None, error_summary: None,
            queued_at: crate::iso_now(), started_at: None, completed_at: None,
        };
        center.tasks.push_front(template.clone());
        for index in 0..8 {
            center.tasks.push_front(LibraryTask {
                task_id: index.to_string(), state: "completed".into(),
                completed_at: Some(format!("2026-10-27T00:00:{index:02}Z")), ..template.clone()
            });
        }
        center.prune_history();
        assert_eq!(center.tasks.len(), 6);
        assert!(center.tasks.iter().any(|task| task.task_id == "active"));
        assert!(center.tasks.iter().any(|task| task.task_id == "7"));
        assert!(!center.tasks.iter().any(|task| task.task_id == "2"));
    }
}
