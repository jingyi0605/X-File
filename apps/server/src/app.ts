import Fastify from "fastify";

import {
  HttpServerManager,
  type HttpServerRuntimeState,
} from "./http-server-manager.js";
import { registerLibraryEngineFeature } from "./library/library-engine-feature.js";
import { registerWebShellRoutes } from "./web-shell-routes.js";

const APP_VERSION = "0.1.0";
const ROUTER_MAX_PARAM_LENGTH = 4096;

export interface CreateServerOptions {
  httpServerRuntimeState?: HttpServerRuntimeState;
  httpServerManager?: HttpServerManager;
  manageHttpServerLifecycle?: boolean;
  sidecarProfile?: "full" | "sidecar-only";
  forceWebDevProxy?: boolean;
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
  registerLibraryEngineFeature(server, {
    ...options,
    sidecarProfile: options.sidecarProfile ?? "sidecar-only",
  });
  registerWebShellRoutes(server, {
    forceDevProxy: options.forceWebDevProxy === true
  });

  return server;
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
