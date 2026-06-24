// 文档助手后端类型：共享部分从 @x-file/shared 复用（前后端同一份消息结构），
// 这里只保留后端专属输入类型与 sink 定义。
export type {
  AssistantMessage,
  AssistantMessageKind,
  AssistantMessageRole,
  AssistantPermissionAction,
  AssistantPermissionKind,
  AssistantPermissionMetadata,
  AssistantPermissionRequest,
  AssistantProviderId,
  AssistantProviderInfo,
  AssistantSessionSummary,
  AssistantStreamEvent,
  AssistantToolCall
} from "@x-file/shared";

export { ASSISTANT_PROVIDER_IDS, isAssistantProviderId } from "@x-file/shared";

import type { AssistantProviderId, AssistantStreamEvent } from "@x-file/shared";

export interface StartAssistantSessionInput {
  provider: AssistantProviderId;
  /** 可选：恢复指定 provider 原生会话；留空表示新建。 */
  resumeProviderSessionId?: string | null;
}

export interface SendAssistantMessageInput {
  content: string;
  model?: string | null;
  reasoningLevel?: string | null;
  attachments?: Array<{
    id: string;
    kind: "image" | "file";
    fileName: string;
    mimeType: string;
    fileSize: number;
    dataUrl: string;
  }>;
}

export type AssistantEventSink = (event: AssistantStreamEvent) => void;
