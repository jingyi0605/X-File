import assert from "node:assert/strict";
import test from "node:test";

import { TaskManager } from "./task-manager.js";

test("任务队列支持同 taskType/key 去重", () => {
  const taskManager = new TaskManager();
  let runCount = 0;
  taskManager.register<{ value: string }, void>({
    taskType: "test.dedupe",
    timeoutMs: 1000,
    run: async () => {
      runCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 50));
    },
  });

  const first = taskManager.enqueue("test.dedupe", {
    key: "same-root",
    source: "test",
    input: { value: "first" },
  });
  const second = taskManager.enqueue("test.dedupe", {
    key: "same-root",
    source: "test",
    input: { value: "second" },
  });

  assert.equal(first.taskId, second.taskId);
  assert.equal(second.deduped, true);
  assert.equal(runCount <= 1, true);
});

test("独立范围任务不去重，最新任务完成后仍能读取同库未完成任务", async () => {
  const manager = new TaskManager();
  const runs: string[] = [];
  const finishes = new Map<string, () => void>();
  manager.register<string, void>({
    taskType: "test.scoped",
    timeoutMs: 1000,
    run: async (value) => {
      runs.push(value);
      await new Promise<void>((resolve) => { finishes.set(value, resolve); });
    },
  });
  const first = manager.enqueue("test.scoped", { key: "root", source: "test", dedupe: false, input: "first" });
  const second = manager.enqueue("test.scoped", { key: "root", source: "test", dedupe: false, input: "second" });
  assert.notEqual(first.taskId, second.taskId);
  await waitFor(() => runs.length === 2);
  assert.equal(manager.get("test.scoped", "root")?.taskId, second.taskId);
  assert.equal(manager.get("test.scoped", "root")?.state, "running");
  finishes.get("second")?.();
  await waitFor(() => manager.list("root").find((task) => task.taskId === second.taskId)?.state === "fresh");
  assert.equal(manager.get("test.scoped", "root")?.taskId, second.taskId);
  finishes.get("first")?.();
  await waitFor(() => manager.list("root").every((task) => task.state === "fresh"));
  assert.deepEqual(runs, ["first", "second"]);
  assert.equal(manager.get("test.scoped", "root")?.taskId, second.taskId);
  assert.equal(manager.list("root").length, 2);
});

test("任务排队超时会留下 queue_timeout 状态且释放同 key 后续任务", async () => {
  const taskManager = new TaskManager({ queueTimeoutMs: 0 });
  let runCount = 0;
  taskManager.register<{ value: string }, void>({
    taskType: "test.queue_timeout",
    timeoutMs: 1000,
    run: async () => {
      runCount += 1;
    },
  });

  const timedOut = taskManager.enqueue("test.queue_timeout", {
    key: "root",
    source: "test",
    input: { value: "timeout" },
  });
  assert.equal(timedOut.state, "queue_timeout");
  assert.equal(timedOut.errorSummary, "任务排队超时");
  assert.equal(runCount, 0);

  const latest = taskManager.get("test.queue_timeout", "root");
  assert.equal(latest?.state, "queue_timeout");

  const next = taskManager.enqueue("test.queue_timeout", {
    key: "root",
    source: "test",
    input: { value: "next" },
  });
  assert.notEqual(next.taskId, timedOut.taskId);
  assert.equal(next.deduped, undefined);
});

test("任务运行超时会 abort 当前任务并释放同 key 后续任务", async () => {
  const taskManager = new TaskManager();
  let aborted = false;
  taskManager.register<{ value: string }, void>({
    taskType: "test.run_timeout",
    timeoutMs: 10,
    run: async (_input, context) => {
      await new Promise<void>((_resolve, reject) => {
        context.signal.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("任务运行超时"));
        }, { once: true });
      });
    },
  });

  const timedOut = taskManager.enqueue("test.run_timeout", {
    key: "root",
    source: "test",
    input: { value: "timeout" },
  });

  await waitFor(() => taskManager.get("test.run_timeout", "root")?.state === "failed");
  const latest = taskManager.get("test.run_timeout", "root");
  assert.equal(aborted, true);
  assert.equal(latest?.state, "failed");
  assert.equal(latest?.errorSummary, "任务运行超时");

  taskManager.register<{ value: string }, void>({
    taskType: "test.run_timeout_success",
    timeoutMs: 1000,
    run: async () => {},
  });
  const next = taskManager.enqueue("test.run_timeout", {
    key: "root",
    source: "test",
    input: { value: "next" },
  });
  assert.notEqual(next.taskId, timedOut.taskId);
  assert.equal(next.deduped, undefined);
});

test("任务运行时通过 setProgress 写入的进度快照会随 TaskSummary 暴露", async () => {
  const taskManager = new TaskManager();
  taskManager.register<{ value: string }, void>({
    taskType: "test.progress",
    timeoutMs: 1000,
    run: async (_input, context) => {
      context.setProgress({ scannedCount: 5, indexedCount: 2 });
      await new Promise((resolve) => setTimeout(resolve, 20));
      context.setProgress({ scannedCount: 10, indexedCount: 8 });
    },
  });

  taskManager.enqueue("test.progress", {
    key: "root",
    source: "test",
    input: { value: "progress" },
  });

  await waitFor(() => taskManager.get("test.progress", "root")?.state === "fresh");
  const latest = taskManager.get("test.progress", "root");
  assert.equal(latest?.state, "fresh");
  assert.deepEqual(latest?.progress, { scannedCount: 10, indexedCount: 8 });
});

async function waitFor(check: () => boolean): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 1000) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("等待任务状态超时");
}

test("统一列表按根目录隔离，保留已完成历史及真实失败", async () => {
  const manager = new TaskManager();
  manager.register<{ fail?: boolean }, void>({
    taskType: "library.tag_recompute",
    timeoutMs: 1000,
    run: async (input, context) => {
      context.setStage("write_snapshot");
      context.setProgress({ scannedCount: 445, totalCount: 445 });
      if (input.fail) throw new Error("导出失败");
    },
  });
  const first = manager.enqueue("library.tag_recompute", { key: "root", source: "test", categoryTitle: "客户/麦迪格", input: {} });
  await waitFor(() => manager.get("library.tag_recompute", "root")?.state === "fresh");
  const second = manager.enqueue("library.tag_recompute", { key: "root", source: "test", input: { fail: true } });
  manager.enqueue("library.tag_recompute", { key: "other", source: "test", input: {} });
  await waitFor(() => manager.get("library.tag_recompute", "root")?.state === "failed");
  const tasks = manager.list("root");
  assert.deepEqual(tasks.map((task) => task.taskId), [second.taskId, first.taskId]);
  assert.equal(tasks[0]?.errorSummary, "导出失败");
  assert.deepEqual(tasks[1]?.progress, { scannedCount: 445, totalCount: 445 });
  assert.equal(tasks[1]?.categoryTitle, "客户/麦迪格");
});

test("统一列表按完成时间倒序且每个文档库最多保留五条历史", async () => {
  const manager = new TaskManager();
  manager.register<{ index: number }, void>({
    taskType: "test.history",
    timeoutMs: 1000,
    run: async () => {},
  });
  const taskIds: string[] = [];
  for (let index = 0; index < 7; index += 1) {
    const task = manager.enqueue("test.history", {
      key: "root",
      source: "test",
      input: { index },
    });
    taskIds.push(task.taskId);
    await waitFor(() => manager.get("test.history", "root")?.taskId === task.taskId
      && manager.get("test.history", "root")?.state === "fresh");
    await new Promise((resolve) => setTimeout(resolve, 3));
  }

  const history = manager.list("root");
  assert.equal(history.length, 5);
  assert.deepEqual(history.map((task) => task.taskId), manager.list("root").map((task) => task.taskId));
  assert.deepEqual(history.map((task) => task.completedAt), [...history]
    .map((task) => task.completedAt).sort((left, right) => Date.parse(right!) - Date.parse(left!)));
  assert.deepEqual(history.map((task) => task.taskId), taskIds.slice(2).reverse());
});
