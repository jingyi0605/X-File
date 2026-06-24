// 文档助手前端 API 客户端：对接后端 /api/assistant/*。
// 消息发送走 SSE 流（手动 fetch + ReadableStream 解析）。
import type {
  AssistantAttachment,
  AssistantMessage,
  AssistantPermissionAction,
  AssistantPermissionRequest,
  AssistantProviderInfo,
  AssistantProviderId,
  AssistantSessionSummary,
  AssistantStreamEvent
} from "@x-file/shared";

import { apiRequest, postJson, resolveApiUrl } from "../../../api/http";
import { getRuntimeConfigSnapshot } from "../../../runtime/runtime-config-store";

export type {
  AssistantMessage,
  AssistantPermissionAction,
  AssistantPermissionRequest,
  AssistantProviderInfo,
  AssistantProviderId,
  AssistantSessionSummary,
  AssistantStreamEvent
} from "@x-file/shared";

export interface StartSessionInput {
  provider: AssistantProviderId;
  resumeProviderSessionId?: string | null;
}

export interface SendMessageInput {
  content: string;
  model?: string | null;
  reasoningLevel?: string | null;
  attachments?: Array<AssistantAttachment & { dataUrl: string }>;
}

interface ProvidersResult {
  providers: AssistantProviderInfo[];
}

interface SessionResult {
  session: AssistantSessionSummary;
}

interface MessagesResult {
  messages: AssistantMessage[];
}

function assertAssistantRuntimeAvailable(): void {
  if (getRuntimeConfigSnapshot().config.mode === "local") {
    throw new Error("主包本地模式已移除内建文档助手 Node sidecar，请改用外部 assistant runtime。");
  }
}

export function listAssistantProviders(): Promise<AssistantProviderInfo[]> {
  assertAssistantRuntimeAvailable();
  return apiRequest<ProvidersResult>("/api/assistant/providers").then((r) => r.providers);
}

export function startAssistantSession(
  input: StartSessionInput
): Promise<AssistantSessionSummary> {
  assertAssistantRuntimeAvailable();
  return postJson<SessionResult>("/api/assistant/sessions", input).then((r) => r.session);
}

export function listAssistantSessions(): Promise<AssistantSessionSummary[]> {
  assertAssistantRuntimeAvailable();
  return apiRequest<{ sessions: AssistantSessionSummary[] }>("/api/assistant/sessions").then(
    (r) => r.sessions
  );
}

export interface AssistantSessionDetail {
  session: AssistantSessionSummary;
  messages: AssistantMessage[];
}

export function getAssistantSession(sessionId: string): Promise<AssistantSessionDetail> {
  assertAssistantRuntimeAvailable();
  return apiRequest<AssistantSessionDetail>(
    `/api/assistant/sessions/${encodeURIComponent(sessionId)}`
  );
}

export function deleteAssistantSession(sessionId: string): Promise<void> {
  assertAssistantRuntimeAvailable();
  return apiRequest<void>(`/api/assistant/sessions/${encodeURIComponent(sessionId)}`, {
    method: "DELETE"
  }).then(() => undefined);
}

export function getAssistantMessages(sessionId: string): Promise<AssistantMessage[]> {
  assertAssistantRuntimeAvailable();
  return apiRequest<MessagesResult>(
    `/api/assistant/sessions/${encodeURIComponent(sessionId)}/messages`
  ).then((r) => r.messages);
}

export function interruptAssistantSession(sessionId: string): Promise<void> {
  assertAssistantRuntimeAvailable();
  return postJson(`/api/assistant/sessions/${encodeURIComponent(sessionId)}/interrupt`, {}).then(
    () => undefined
  );
}

export function replyAssistantPermissionRequest(
  sessionId: string,
  requestId: string,
  action: AssistantPermissionAction
): Promise<AssistantPermissionRequest | null> {
  assertAssistantRuntimeAvailable();
  return postJson<{
    request: AssistantPermissionRequest | null;
  }>(
    `/api/assistant/sessions/${encodeURIComponent(sessionId)}/permission-requests/${encodeURIComponent(requestId)}/reply`,
    { action }
  ).then((r) => r.request);
}

export interface AssistantStreamHandlers {
  onEvent: (event: AssistantStreamEvent) => void;
  onError?: (error: Error) => void;
  onClose?: () => void;
}

export interface AssistantStreamHandle {
  abort: () => void;
}

// 发送消息并以 SSE 流接收运行时事件。
export function streamAssistantMessage(
  sessionId: string,
  input: SendMessageInput,
  handlers: AssistantStreamHandlers
): AssistantStreamHandle {
  assertAssistantRuntimeAvailable();
  const controller = new AbortController();

  void (async () => {
    try {
      const response = await fetch(
        resolveApiUrl(`/api/assistant/sessions/${encodeURIComponent(sessionId)}/messages`),
        {
          method: "POST",
          signal: controller.signal,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input)
        }
      );

      if (!response.ok || !response.body) {
        const detail = response.status
          ? `请求失败：${response.status}`
          : "无法连接文档助手服务";
        handlers.onError?.(new Error(detail));
        handlers.onClose?.();
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        let separatorIndex: number;
        while ((separatorIndex = buffer.indexOf("\n\n")) >= 0) {
          const chunk = buffer.slice(0, separatorIndex);
          buffer = buffer.slice(separatorIndex + 2);
          dispatchSseChunk(chunk, handlers.onEvent);
        }
      }

      handlers.onClose?.();
    } catch (error) {
      if ((error as { name?: string })?.name === "AbortError") {
        handlers.onClose?.();
        return;
      }
      handlers.onError?.(error instanceof Error ? error : new Error("文档助手流读取失败"));
      handlers.onClose?.();
    }
  })();

  return { abort: () => controller.abort() };
}

function dispatchSseChunk(
  chunk: string,
  onEvent: (event: AssistantStreamEvent) => void
): void {
  for (const rawLine of chunk.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) {
      continue;
    }
    const payload = line.slice(5).trim();
    if (!payload) {
      continue;
    }
    try {
      onEvent(JSON.parse(payload) as AssistantStreamEvent);
    } catch {
      // 单行解析失败忽略，继续下一行。
    }
  }
}
