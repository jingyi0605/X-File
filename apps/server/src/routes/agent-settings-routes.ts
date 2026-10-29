import type { FastifyInstance } from "fastify";
import type { SaveAgentIntegrationSettingsInput } from "@x-file/shared";

import {
  AgentSettingsError,
  createAgentSettingsService,
  type AgentSettingsService,
} from "../integrations/agent-settings-service.js";

const SETTINGS_PATH = "/api/integration/agent/settings";

export function registerAgentSettingsRoutes(
  app: FastifyInstance,
  service: AgentSettingsService = createAgentSettingsService(),
): void {
  app.route({
    method: ["GET", "PUT", "OPTIONS"],
    url: SETTINGS_PATH,
    bodyLimit: 8192,
    // 登录认证通过全局 HTTP auth hook 统一执行；设置路由不再接受专用管理令牌。
    // JSON 解析错误可能携带输入片段，统一返回不含密钥的错误。
    errorHandler: (error, _request, reply) => {
      const status = error.statusCode && error.statusCode >= 400 && error.statusCode < 500
        ? error.statusCode : 500;
      return reply.code(status).send({ errorCode: "INVALID_REQUEST", detail: "Agent 设置请求无法处理。" });
    },
    onRequest: async (_request, reply) => {
      reply.header("Cache-Control", "no-store");
      reply.header("Pragma", "no-cache");
    },
    handler: async (request, reply) => {
      try {
        if (request.method === "GET") return await service.get();
        if (!isSettingsInput(request.body)) {
          return reply.code(400).send({ errorCode: "INVALID_ARGUMENT", detail: "Agent 设置请求格式无效。" });
        }
        return await service.save(request.body);
      } catch (error) {
        if (error instanceof AgentSettingsError) {
          return reply.code(error.statusCode).send({ errorCode: error.code, detail: error.message });
        }
        return reply.code(500).send({ errorCode: "SETTINGS_ERROR", detail: "无法读写 Agent 设置。" });
      }
    },
  });
}

function isSettingsInput(value: unknown): value is SaveAgentIntegrationSettingsInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value).every(([key, field]) => key === "apiKey"
    ? typeof field === "string" && /^[\x21-\x7e]{32,512}$/.test(field)
    : key === "accessMode"
      ? field === "read_only" || field === "read_write"
      : ["enabled", "generateApiKey", "clearApiKey"].includes(key) && typeof field === "boolean");
}
