// 文档助手前后端共享的类型。纯结构，不依赖任何运行时（session-sync-core），
// 这样前端 web 不必引入后端依赖也能复用同一份消息结构。

export type AssistantProviderId = "codex" | "claude-code";

export const ASSISTANT_PROVIDER_IDS: readonly AssistantProviderId[] = ["codex", "claude-code"];

export function isAssistantProviderId(value: unknown): value is AssistantProviderId {
  return value === "codex" || value === "claude-code";
}

export type AssistantMessageRole = "user" | "assistant" | "tool" | "system";
export type AssistantMessageKind = "text" | "thinking" | "tool_call" | "tool_result";
export type AssistantAttachmentKind = "image" | "file";
export type AssistantReasoningLevel = "minimal" | "low" | "medium" | "high" | "maximum";

export interface AssistantAttachment {
  id: string;
  kind: AssistantAttachmentKind;
  fileName: string;
  mimeType: string;
  fileSize: number;
  contentUrl?: string | null;
}

export interface AssistantProviderModelOption {
  id: string;
  name: string;
  usesProviderDefault?: boolean;
  supportedReasoningEfforts?: string[];
}

export interface AssistantToolCall {
  callId: string;
  name: string;
  input: string;
  output: string | null;
  error: string | null;
  status: "running" | "completed" | "failed";
}

export interface AssistantMessage {
  messageId: string;
  role: AssistantMessageRole;
  kind: AssistantMessageKind;
  content: string;
  toolCall: AssistantToolCall | null;
  attachments?: AssistantAttachment[];
  timestamp: string;
  sequence: number;
  providerSessionId: string | null;
}

export interface AssistantProviderInfo {
  id: AssistantProviderId;
  label: string;
  /** 命令与登录态都就绪，可立即使用。 */
  available: boolean;
  /** CLI 命令是否可解析（which/where 命中）。 */
  commandReady: boolean;
  /** 登录态是否就绪。 */
  authReady: boolean;
  /** 不可用时的原因说明，null 表示一切就绪。 */
  detail: string | null;
  supportsAttachments?: boolean;
  supportedReasoningLevels?: AssistantReasoningLevel[];
  defaultReasoningLevel?: AssistantReasoningLevel | null;
  modelOptions?: AssistantProviderModelOption[];
}

export interface AssistantSessionSummary {
  sessionId: string;
  title: string;
  provider: AssistantProviderId;
  providerSessionId: string | null;
  workspacePath: string;
  createdAt: string;
  hasActiveRun: boolean;
  messageCount: number;
}

export type AssistantPermissionKind = "command" | "file_change" | "other";

export interface AssistantPermissionCommandMetadata {
  kind: "command";
  command: string;
  reason: string | null;
  cwd: string | null;
}

export interface AssistantPermissionFileChangeMetadata {
  kind: "file_change";
  primaryPath: string | null;
  changes: Array<{
    path: string;
    action: "add" | "update" | "delete" | "unknown";
  }>;
  diffSummary: string | null;
}

export interface AssistantPermissionOtherMetadata {
  kind: "other";
  method: string | null;
  payloadText: string | null;
}

export type AssistantPermissionMetadata =
  | AssistantPermissionCommandMetadata
  | AssistantPermissionFileChangeMetadata
  | AssistantPermissionOtherMetadata;

export interface AssistantPermissionRequest {
  requestId: string;
  sessionId: string;
  kind: AssistantPermissionKind;
  title: string;
  summary: string;
  detail: string | null;
  metadata: AssistantPermissionMetadata | null;
  status: "pending" | "approved" | "rejected";
  createdAt: string;
}

export type AssistantPermissionAction = "accept" | "decline";

/** 运行时推给前端的流式事件，SSE 按行下发。 */
export type AssistantStreamEvent =
  | { kind: "message"; message: AssistantMessage }
  | {
      kind: "status";
      status: "starting" | "running" | "completed" | "interrupted";
      detail: string | null;
    }
  | { kind: "permission_request"; request: AssistantPermissionRequest }
  | { kind: "error"; detail: string; errorCode: string | null }
  | { kind: "end" };
