// 文档助手 controller：照搬 library-controller 的 arrow handler 风格。
// messages 端点用 reply.hijack + reply.raw 输出 SSE 流。
import type { FastifyReply, FastifyRequest } from "fastify";
import { createReadStream, existsSync } from "node:fs";
import path from "node:path";

import { AssistantError } from "./assistant-errors.js";
import type { AssistantRuntimeService } from "./assistant-runtime-service.js";
import {
  isAssistantProviderId,
  type AssistantStreamEvent
} from "./assistant-types.js";

interface StartSessionBody {
  provider?: unknown;
  resumeProviderSessionId?: unknown;
}

interface SendMessageBody {
  content?: unknown;
  model?: unknown;
  reasoningLevel?: unknown;
  attachments?: unknown;
}

export class AssistantController {
  constructor(private readonly runtime: AssistantRuntimeService) {}

  readonly listProviders = async (_request: FastifyRequest, reply: FastifyReply) => {
    reply.send({ providers: await this.runtime.listProviders() });
  };

  readonly listSessions = async (_request: FastifyRequest, reply: FastifyReply) => {
    reply.send({ sessions: this.runtime.getStore().listSummaries() });
  };

  readonly getSession = async (request: FastifyRequest, reply: FastifyReply) => {
    const sessionId = readSessionId(request);
    const record = this.runtime.loadSession(sessionId);
    if (!record) {
      throw new AssistantError(404, "ASSISTANT_SESSION_NOT_FOUND", `会话不存在: ${sessionId}`);
    }
    reply.send({
      session: this.runtime.getStore().toSummary(record),
      messages: record.messages
    });
  };

  readonly deleteSession = async (request: FastifyRequest, reply: FastifyReply) => {
    const sessionId = readSessionId(request);
    this.runtime.deleteSession(sessionId);
    reply.send({ ok: true });
  };

  readonly startSession = async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body ?? {}) as StartSessionBody;
    if (!isAssistantProviderId(body.provider)) {
      throw new AssistantError(
        400,
        "ASSISTANT_PROVIDER_NOT_SUPPORTED",
        `不支持的 provider: ${String(body.provider)}`
      );
    }
    const summary = await this.runtime.startSession({
      provider: body.provider,
      resumeProviderSessionId:
        typeof body.resumeProviderSessionId === "string" ? body.resumeProviderSessionId : null
    });
    reply.send({ session: summary });
  };

  readonly getMessages = async (request: FastifyRequest, reply: FastifyReply) => {
    const sessionId = readSessionId(request);
    const session = this.runtime.getStore().get(sessionId);
    if (!session) {
      throw new AssistantError(404, "ASSISTANT_SESSION_NOT_FOUND", `会话不存在: ${sessionId}`);
    }
    reply.send({ messages: this.runtime.getMessages(sessionId) });
  };

  readonly sendMessage = async (request: FastifyRequest, reply: FastifyReply) => {
    const sessionId = readSessionId(request);
    const session = this.runtime.getStore().get(sessionId);
    if (!session) {
      throw new AssistantError(404, "ASSISTANT_SESSION_NOT_FOUND", `会话不存在: ${sessionId}`);
    }
    const body = (request.body ?? {}) as SendMessageBody;
    const content = typeof body.content === "string" ? body.content : "";
    if (!content.trim()) {
      throw new AssistantError(400, "ASSISTANT_INVALID_INPUT", "消息内容不能为空");
    }

    // 接管响应，自己按 SSE 协议写 reply.raw。
    reply.hijack();
    const origin = readOrigin(request);
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": origin
    });

    const sink = (event: AssistantStreamEvent) => {
      if (reply.raw.writableEnded) {
        return;
      }
      try {
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {
        // 写入失败（客户端已断开）忽略，close 钩子会收尾。
      }
      if (event.kind === "end") {
        try {
          reply.raw.end();
        } catch {
          /* 忽略 */
        }
      }
    };

    // 只在客户端真正中止上传时结束流。
    // 这里不能监听 request.close：在 Node/Fastify 里，请求体读取完成后也可能触发 close，
    // 会把 SSE 连接过早掐断，导致前端只能收到第一条 starting 事件。
    const handleClientAbort = () => {
      if (!reply.raw.writableEnded) {
        try {
          reply.raw.end();
        } catch {
          /* 忽略 */
        }
      }
    };

    request.raw.on("aborted", handleClientAbort);
    reply.raw.on("close", () => {
      request.raw.off?.("aborted", handleClientAbort);
    });

    try {
      await this.runtime.sendMessage(
        sessionId,
        {
          content,
          model: typeof body.model === "string" ? body.model : null,
          reasoningLevel: typeof body.reasoningLevel === "string" ? body.reasoningLevel : null,
          attachments: normalizeAttachments(body.attachments)
        },
        sink
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : "文档助手运行失败";
      sink({ kind: "error", detail, errorCode: "ASSISTANT_RUNTIME_ERROR" });
      sink({ kind: "end" });
    }
  };

  readonly interrupt = async (request: FastifyRequest, reply: FastifyReply) => {
    const sessionId = readSessionId(request);
    await this.runtime.interrupt(sessionId);
    reply.send({ ok: true });
  };

  readonly listPermissionRequests = async (request: FastifyRequest, reply: FastifyReply) => {
    const sessionId = readSessionId(request);
    reply.send({ requests: this.runtime.getPermissionRequests(sessionId) });
  };

  readonly replyPermissionRequest = async (request: FastifyRequest, reply: FastifyReply) => {
    const requestId = readPermissionRequestId(request);
    const body = (request.body ?? {}) as { action?: unknown };
    const action = body.action === "accept" ? "accept" : "decline";
    const resolved = this.runtime.replyPermissionRequest(requestId, action);
    reply.send({ request: resolved });
  };

  readonly getAttachment = async (request: FastifyRequest, reply: FastifyReply) => {
    const sessionId = readSessionId(request);
    const attachmentId = readAttachmentId(request);
    const targetPath = this.runtime.resolveAttachmentPath(sessionId, attachmentId);
    if (!targetPath || !existsSync(targetPath)) {
      throw new AssistantError(404, "ASSISTANT_SESSION_NOT_FOUND", "附件不存在");
    }
    reply.header("Cache-Control", "private, max-age=300");
    reply.type(resolveAttachmentContentType(targetPath));
    return reply.send(createReadStream(targetPath));
  };
}

function normalizeAttachments(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    if (!item || typeof item !== "object") {
      return [];
    }
    const record = item as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id : "";
    const kind = record.kind === "file" ? "file" : record.kind === "image" ? "image" : null;
    const fileName = typeof record.fileName === "string" ? record.fileName : "";
    const mimeType = typeof record.mimeType === "string" ? record.mimeType : "";
    const dataUrl = typeof record.dataUrl === "string" ? record.dataUrl : "";
    const fileSize = typeof record.fileSize === "number" && Number.isFinite(record.fileSize)
      ? record.fileSize
      : 0;

    if (!id || !kind || !fileName || !mimeType || !dataUrl) {
      return [];
    }

    return [{
      id,
      kind: kind as "image" | "file",
      fileName,
      mimeType,
      fileSize
    , dataUrl }];
  });
}

function readSessionId(request: FastifyRequest): string {
  const params = request.params as { sessionId?: unknown } | undefined;
  const value = params?.sessionId;
  return typeof value === "string" ? value : "";
}

function readPermissionRequestId(request: FastifyRequest): string {
  const params = request.params as { requestId?: unknown } | undefined;
  const value = params?.requestId;
  return typeof value === "string" ? value : "";
}

function readOrigin(request: FastifyRequest): string {
  const origin = request.headers.origin;
  if (typeof origin === "string" && isAllowedLocalOrigin(origin)) {
    return origin;
  }
  return "http://127.0.0.1:17320";
}

function readAttachmentId(request: FastifyRequest): string {
  const params = request.params as { attachmentId?: unknown } | undefined;
  const value = params?.attachmentId;
  return typeof value === "string" ? value : "";
}

function resolveAttachmentContentType(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".png") return "image/png";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".webp") return "image/webp";
  return "application/octet-stream";
}

function isAllowedLocalOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (
      url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" ||
        url.hostname === "localhost" ||
        url.hostname === "::1")
    );
  } catch {
    return false;
  }
}
