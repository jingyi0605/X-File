import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { RuntimeErrorEvent, RuntimeEvent, RuntimeStatusEvent } from "@codingns/session-sync-core";

import { mapRuntimeEventToAssistantStatus } from "./assistant-runtime-service.js";
import { AssistantSessionStore } from "./assistant-session-store.js";

function createStatusEvent(
  overrides: Partial<RuntimeStatusEvent> & Pick<RuntimeStatusEvent, "type" | "status">
): RuntimeStatusEvent {
  const { type, status, ...rest } = overrides;
  return {
    sessionId: "session-1",
    provider: "codex",
    providerSessionId: "provider-session-1",
    rawStoreRef: null,
    timestamp: "2026-06-16T08:00:00.000Z",
    detail: null,
    interruptSource: null,
    errorCode: null,
    rawEventRef: null,
    message: null,
    ...rest,
    type,
    status
  };
}

function createErrorEvent(overrides: Partial<RuntimeErrorEvent> = {}): RuntimeErrorEvent {
  return {
    sessionId: "session-1",
    provider: "codex",
    providerSessionId: "provider-session-1",
    rawStoreRef: null,
    timestamp: "2026-06-16T08:00:00.000Z",
    detail: "runtime failed",
    interruptSource: null,
    errorCode: "PROVIDER_RUNTIME_ERROR",
    rawEventRef: null,
    message: null,
    ...overrides,
    type: "error",
    status: "failed"
  };
}

test("文档助手会把 runtime complete 事件映射成 completed 终态", () => {
  const mapped = mapRuntimeEventToAssistantStatus(
    createStatusEvent({
      type: "complete",
      status: "completed",
      detail: "run completed"
    })
  );

  assert.deepEqual(mapped, {
    status: "completed",
    terminal: true
  });
});

test("文档助手保留 interrupted 作为终态", () => {
  const mapped = mapRuntimeEventToAssistantStatus(
    createStatusEvent({
      type: "interrupted",
      status: "interrupted",
      detail: "interrupt requested",
      interruptSource: "user"
    })
  );

  assert.deepEqual(mapped, {
    status: "interrupted",
    terminal: true
  });
});

test("文档助手忽略 failed status 事件，失败统一走 error 事件", () => {
  const mapped = mapRuntimeEventToAssistantStatus(
    createErrorEvent({
      detail: "runtime failed"
    })
  );

  assert.equal(mapped, null);
});

test("文档助手忽略 failed status 类型，失败仍然由 error 事件驱动", () => {
  const mapped = mapRuntimeEventToAssistantStatus(
    createStatusEvent({
      type: "status",
      status: "failed",
      detail: "runtime failed"
    })
  );

  assert.equal(mapped, null);
});

test("会话存储会为默认标题的历史记录回填首条用户消息标题", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "x-file-assistant-session-store-"));
  const sessionsDir = path.join(tempDir, "assistant-sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });

  fs.writeFileSync(
    path.join(sessionsDir, "session-1.json"),
    JSON.stringify({
      sessionId: "session-1",
      title: "新对话",
      provider: "codex",
      providerSessionId: null,
      rawStoreRef: null,
      workspacePath: "/tmp/workspace",
      runtimeHomeDir: "/tmp/runtime",
      createdAt: "2026-06-16T08:00:00.000Z",
      messages: [
        {
          messageId: "message-1",
          role: "user",
          kind: "text",
          content: "修复文件助手历史会话标题一直显示默认值的问题",
          toolCall: null,
          attachments: [],
          timestamp: "2026-06-16T08:00:00.000Z",
          sequence: 1,
          providerSessionId: null
        }
      ],
      permissionRequests: []
    }),
    "utf8"
  );

  const store = new AssistantSessionStore(tempDir);
  const record = store.loadRecord("session-1");

  assert.equal(record?.title, "修复文件助手历史会话标题一直显示默认值的问题");
});
