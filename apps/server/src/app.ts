import Fastify from "fastify";

import {
  HttpServerManager,
  type HttpServerRuntimeState,
} from "./http-server-manager.js";
import { AssistantController } from "./assistant/assistant-controller.js";
import { registerLibraryEngineFeature } from "./library/library-engine-feature.js";
import { registerAssistantRoutes } from "./routes/assistant-routes.js";
import { LibraryBindingStore } from "./storage/library-binding-store.js";

const APP_VERSION = "0.1.0";
const ROUTER_MAX_PARAM_LENGTH = 4096;

export interface CreateServerOptions {
  httpServerRuntimeState?: HttpServerRuntimeState;
  httpServerManager?: HttpServerManager;
  manageHttpServerLifecycle?: boolean;
  includeAssistant?: boolean;
  sidecarProfile?: "full" | "sidecar-only";
}

export function createServer(options: CreateServerOptions = {}) {
  const server = Fastify({
    logger: true,
    // ONLYOFFICE 预览 token 会把相对路径一起签进 URL，默认参数长度不够时
    // Fastify 会直接把真实路由当成 404，导致 Office 文件根本拿不到字节流。
    routerOptions: {
      maxParamLength: ROUTER_MAX_PARAM_LENGTH
    },
    // 移除每个请求的 "incoming request" / "request completed" 日志，
    // 只保留 error/warn 及路由内手动日志
    disableRequestLogging: true,
  });

  server.addHook("onRequest", async (request, reply) => {
    const origin = request.headers.origin;
    if (typeof origin === "string" && isAllowedLocalOrigin(origin)) {
      reply.header("Access-Control-Allow-Origin", origin);
      reply.header(
        "Access-Control-Allow-Methods",
        "GET,POST,PUT,DELETE,OPTIONS",
      );
      reply.header("Access-Control-Allow-Headers", "content-type");
      reply.header("Access-Control-Allow-Credentials", "false");
    }
  });

  server.options("/*", async (_request, reply) => reply.code(204).send());

  server.get("/api/health", async () => ({
    ok: true,
    app: "X-File",
    version: APP_VERSION,
  }));

  // Node 入口现在只负责装配仍需 HTTP sidecar 的服务；
  // 文档库主读链与 refresh 宿主已经优先走桌面 native 路径。
  const feature = registerLibraryEngineFeature(server, {
    ...options,
    sidecarProfile: options.sidecarProfile ?? "full",
  });
  if (options.includeAssistant !== false) {
    void registerAssistantRoutes(
      server,
      createLazyAssistantController(feature.libraryBindingStore, feature.pluginService),
    );
  }

  return server;
}

function createLazyAssistantController(
  libraryBindingStore: LibraryBindingStore,
  pluginService: ReturnType<typeof registerLibraryEngineFeature>["pluginService"]
): AssistantController {
  let controllerPromise: Promise<AssistantController> | null = null;

  const resolveController = async (): Promise<AssistantController> => {
    if (!controllerPromise) {
      controllerPromise = import("./assistant/assistant-runtime-service.js").then(
        ({ AssistantRuntimeService }) =>
          new AssistantController(new AssistantRuntimeService(libraryBindingStore, pluginService)),
      );
    }
    return controllerPromise;
  };

  return {
    listProviders: async (request, reply) => (await resolveController()).listProviders(request, reply),
    listSessions: async (request, reply) => (await resolveController()).listSessions(request, reply),
    getSession: async (request, reply) => (await resolveController()).getSession(request, reply),
    deleteSession: async (request, reply) => (await resolveController()).deleteSession(request, reply),
    startSession: async (request, reply) => (await resolveController()).startSession(request, reply),
    getMessages: async (request, reply) => (await resolveController()).getMessages(request, reply),
    sendMessage: async (request, reply) => (await resolveController()).sendMessage(request, reply),
    interrupt: async (request, reply) => (await resolveController()).interrupt(request, reply),
    listPermissionRequests: async (request, reply) => (await resolveController()).listPermissionRequests(request, reply),
    replyPermissionRequest: async (request, reply) => (await resolveController()).replyPermissionRequest(request, reply),
    getAttachment: async (request, reply) => (await resolveController()).getAttachment(request, reply),
  } as AssistantController;
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
