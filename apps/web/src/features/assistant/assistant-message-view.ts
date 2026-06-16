// 文件助手消息视图模型：将后端 AssistantMessage 归一化为消息行和工具组卡片。
import type { AssistantMessage, AssistantToolCall } from "@x-file/shared";

export interface AssistantMessageRowItem {
  key: string;
  type: "message";
  message: AssistantMessage;
}

export interface AssistantToolGroupItem {
  key: string;
  type: "tool_group";
  messages: AssistantMessage[];
  toolCall: AssistantToolCall;
  hasRequest: boolean;
  hasResult: boolean;
  updatedAt: string;
}

export type AssistantTimelineItem = AssistantMessageRowItem | AssistantToolGroupItem;

export function buildAssistantTimelineItems(messages: AssistantMessage[]): AssistantTimelineItem[] {
  const items: AssistantTimelineItem[] = [];
  let toolBlock: AssistantMessage[] = [];
  let activeToolCallId: string | null = null;

  const flushToolBlock = () => {
    if (toolBlock.length === 0) {
      return;
    }
    const grouped = mergeToolMessages(toolBlock);
    if (grouped) {
      items.push(grouped);
    } else {
      for (const message of toolBlock) {
        items.push({
          key: message.messageId,
          type: "message",
          message,
        });
      }
    }
    toolBlock = [];
    activeToolCallId = null;
  };

  for (const message of messages) {
    if (isToolMessage(message) && message.toolCall?.callId) {
      const nextCallId = message.toolCall.callId;
      if (activeToolCallId && activeToolCallId !== nextCallId) {
        flushToolBlock();
      }
      activeToolCallId = nextCallId;
      toolBlock.push(message);
      continue;
    }
    flushToolBlock();
    items.push({
      key: message.messageId,
      type: "message",
      message,
    });
  }

  flushToolBlock();
  return items;
}

export function isAssistantToolGroupItem(item: AssistantTimelineItem): item is AssistantToolGroupItem {
  return item.type === "tool_group";
}

function isToolMessage(message: AssistantMessage): boolean {
  return message.role === "tool" || message.kind === "tool_call" || message.kind === "tool_result";
}

function mergeToolMessages(messages: AssistantMessage[]): AssistantToolGroupItem | null {
  const toolMessages = messages
    .filter((message) => Boolean(message.toolCall))
    .map((message) => ({ message, toolCall: message.toolCall! }));

  if (toolMessages.length === 0) {
    return null;
  }

  const first = toolMessages[0]!;
  const last = toolMessages[toolMessages.length - 1]!;
  const mergedToolCall: AssistantToolCall = {
    ...first.toolCall,
    name: last.toolCall.name || first.toolCall.name,
    input: last.toolCall.input || first.toolCall.input,
    output: last.toolCall.output ?? first.toolCall.output,
    error: last.toolCall.error ?? first.toolCall.error,
    status: last.toolCall.status,
  };

  return {
    key: first.toolCall.callId || first.message.messageId,
    type: "tool_group",
    messages: [...messages],
    toolCall: mergedToolCall,
    hasRequest: messages.some((message) => message.kind === "tool_call"),
    hasResult: messages.some((message) => message.kind === "tool_result"),
    updatedAt: last.message.timestamp,
  };
}
