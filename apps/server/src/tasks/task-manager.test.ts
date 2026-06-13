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
