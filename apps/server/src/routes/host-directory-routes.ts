import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { toLibraryErrorResponse } from "../library/library-errors.js";
import type { HostDirectoryBrowserService } from "../library/host-directory-browser-service.js";

interface HostDirectoryBrowseQuery {
  path?: string;
}

export async function registerHostDirectoryRoutes(
  app: FastifyInstance,
  hostDirectoryBrowserService: HostDirectoryBrowserService
): Promise<void> {
  app.get(
    "/api/host/directories",
    async (request: FastifyRequest<{ Querystring: HostDirectoryBrowseQuery }>, reply: FastifyReply) => {
      try {
        reply.send(hostDirectoryBrowserService.browse(request.query.path));
      } catch (error) {
        const response = toLibraryErrorResponse(error);
        reply.code(response.statusCode).send(response.body);
      }
    }
  );
}
