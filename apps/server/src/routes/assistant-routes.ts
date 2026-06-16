// 文档助手路由注册，照搬 library-routes 的 wrap 模式。
import type { FastifyInstance } from "fastify";

import type { AssistantController } from "../assistant/assistant-controller.js";
import { toAssistantErrorResponse } from "../assistant/assistant-errors.js";

export async function registerAssistantRoutes(
  app: FastifyInstance,
  assistantController: AssistantController
): Promise<void> {
  const wrap = (handler: (request: any, reply: any) => Promise<void>) => {
    return async (request: any, reply: any) => {
      try {
        await handler(request, reply);
      } catch (error) {
        // SSE 已经接管响应（hijack 之后）时不能再回 JSON，直接结束流兜底。
        if (reply.raw && typeof reply.raw.headersSent === "boolean" && reply.raw.headersSent) {
          try {
            reply.raw.end();
          } catch {
            /* 忽略 */
          }
          return;
        }
        const response = toAssistantErrorResponse(error);
        reply.code(response.statusCode).send(response.body);
      }
    };
  };

  app.get("/api/assistant/providers", wrap(assistantController.listProviders));
  app.post("/api/assistant/sessions", wrap(assistantController.startSession));
  app.get("/api/assistant/sessions", wrap(assistantController.listSessions));
  app.get("/api/assistant/sessions/:sessionId", wrap(assistantController.getSession));
  app.get("/api/assistant/sessions/:sessionId/attachments/:attachmentId", wrap(assistantController.getAttachment));
  app.delete("/api/assistant/sessions/:sessionId", wrap(assistantController.deleteSession));
  app.get("/api/assistant/sessions/:sessionId/messages", wrap(assistantController.getMessages));
  app.post("/api/assistant/sessions/:sessionId/messages", wrap(assistantController.sendMessage));
  app.post("/api/assistant/sessions/:sessionId/interrupt", wrap(assistantController.interrupt));
  app.get(
    "/api/assistant/sessions/:sessionId/permission-requests",
    wrap(assistantController.listPermissionRequests)
  );
  app.post(
    "/api/assistant/sessions/:sessionId/permission-requests/:requestId/reply",
    wrap(assistantController.replyPermissionRequest)
  );
}
