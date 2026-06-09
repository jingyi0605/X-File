import type { FastifyInstance } from "fastify";

import type { TagController } from "../library/tag-controller.js";
import { toLibraryErrorResponse } from "../library/library-errors.js";

export async function registerTagRoutes(app: FastifyInstance, tagController: TagController): Promise<void> {
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

  app.get("/api/library/tags", wrap(tagController.listTags));
  app.post("/api/library/tags", wrap(tagController.createTag));
  app.post("/api/library/tags/ensure", wrap(tagController.ensureTag));
  app.get("/api/library/documents/:documentId/tag-details", wrap(tagController.getDocumentTagDetails));
  app.put("/api/library/documents/:documentId/tags", wrap(tagController.saveDocumentTags));
  app.get("/api/library/folders/tag-details", wrap(tagController.getFolderTagDetails));
  app.put("/api/library/folders/tags", wrap(tagController.saveFolderTags));
}
