import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { toLibraryErrorResponse } from "../library/library-errors.js";
import type { PluginService } from "../plugins/plugin-service.js";

export async function registerPluginRoutes(
  app: FastifyInstance,
  pluginService: PluginService,
): Promise<void> {
  const wrap = (handler: (request: any, reply: any) => Promise<void> | void) => {
    return async (request: any, reply: any) => {
      try {
        await handler(request, reply);
      } catch (error) {
        const response = toLibraryErrorResponse(error);
        reply.code(response.statusCode).send(response.body);
      }
    };
  };

  app.get("/api/plugins", wrap(async (_request: FastifyRequest, reply: FastifyReply) => {
    reply.send(pluginService.listPlugins());
  }));

  app.post("/api/plugins/install", wrap(async (request: FastifyRequest<{ Body: { sourcePath?: string } }>, reply: FastifyReply) => {
    reply.send(pluginService.installPlugin({ sourcePath: request.body?.sourcePath ?? "" }));
  }));

  app.post("/api/plugins/:pluginId/update", wrap(async (
    request: FastifyRequest<{ Params: { pluginId?: string }; Body: { sourcePath?: string } }>,
    reply: FastifyReply,
  ) => {
    reply.send(
      pluginService.updatePlugin(request.params.pluginId ?? "", {
        sourcePath: request.body?.sourcePath ?? "",
      }),
    );
  }));

  app.put("/api/plugins/:pluginId/enable", wrap(async (
    request: FastifyRequest<{ Params: { pluginId?: string } }>,
    reply: FastifyReply,
  ) => {
    reply.send(pluginService.enablePlugin(request.params.pluginId ?? ""));
  }));

  app.put("/api/plugins/:pluginId/disable", wrap(async (
    request: FastifyRequest<{ Params: { pluginId?: string } }>,
    reply: FastifyReply,
  ) => {
    reply.send(pluginService.disablePlugin(request.params.pluginId ?? ""));
  }));

  app.delete("/api/plugins/:pluginId", wrap(async (
    request: FastifyRequest<{ Params: { pluginId?: string } }>,
    reply: FastifyReply,
  ) => {
    reply.send(pluginService.uninstallPlugin(request.params.pluginId ?? ""));
  }));
}
