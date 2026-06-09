import type { FastifyInstance } from "fastify";

import type { OnlyOfficeController } from "../office/onlyoffice-controller.js";
import { toLibraryErrorResponse } from "../library/library-errors.js";

export async function registerOfficeRoutes(
  app: FastifyInstance,
  onlyOfficeController: OnlyOfficeController
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

  app.get("/api/office/onlyoffice/settings", wrap(onlyOfficeController.getSettings));
  app.put("/api/office/onlyoffice/settings", wrap(onlyOfficeController.updateSettings));
  app.get("/api/office/onlyoffice/status", wrap(onlyOfficeController.getStatus));
  app.post("/api/office/onlyoffice/callback/*", wrap(onlyOfficeController.handleCallback));
}
