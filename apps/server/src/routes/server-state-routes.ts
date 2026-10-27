import type { FastifyInstance } from "fastify";

import { LibraryError, toLibraryErrorResponse } from "../library/library-errors.js";
import type { HttpServerManager } from "../http-server-manager.js";
import type { PersistentBackendManager } from "../lifecycle/persistent-backend-manager.js";

export interface RegisterServerStateRoutesOptions {
  manageLifecycle?: boolean;
}

export async function registerServerStateRoutes(
  app: FastifyInstance,
  httpServerManager: HttpServerManager,
  persistentBackendManager: PersistentBackendManager,
  options: RegisterServerStateRoutesOptions = {}
): Promise<void> {
  const wrap = (handler: (request: any, reply: any) => Promise<void>) => {
    return async (request: any, reply: any) => {
      try {
        await handler(request, reply);
      } catch (error) {
        const response = toLibraryErrorResponse(error);
        reply.code(response.statusCode).send(response.body);
      }
    };
  };

  app.get("/api/server/state", wrap(async (_request, reply) => {
    const state = httpServerManager.getState();
    reply.send({
      ...state,
      persistentPolicy: persistentBackendManager.getPolicy(state)
    });
  }));

  app.put("/api/server/state", wrap(async (request, reply) => {
    const previous = httpServerManager.getState();
    let state;
    try {
      const input = request.body ?? {};
      if (options.manageLifecycle && previous.running) {
        state = httpServerManager.save(input);
        const bindingChanged = state.host !== previous.host || state.port !== previous.port;
        const enabledChanged = state.enabled !== previous.enabled;
        if (bindingChanged || enabledChanged) {
          reply.raw.once("finish", () => {
            setTimeout(() => {
              void httpServerManager.restartListener().catch((error) => {
                httpServerManager.markError(error);
              });
            }, 0);
          });
          reply.send(state);
          return;
        }
      } else {
        state = await httpServerManager.applyStateChange(input, {
          manageLifecycle: options.manageLifecycle === true,
          deferStop: true
        });
      }
    } catch (error) {
      throw normalizeServerStateError(error);
    }
    reply.send({
      ...state,
      persistentPolicy: persistentBackendManager.getPolicy(state)
    });
  }));
}

function normalizeServerStateError(error: unknown): unknown {
  if (error instanceof LibraryError) {
    return error;
  }

  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("监听地址")) {
    return new LibraryError(400, "INVALID_INPUT", message, "host");
  }
  if (message.includes("端口无效")) {
    return new LibraryError(400, "INVALID_INPUT", message, "port");
  }
  if (message.includes("HTTP 服务认证") || message.includes("局域网访问认证")) {
    return new LibraryError(400, "INVALID_INPUT", message, "auth");
  }

  return error;
}
