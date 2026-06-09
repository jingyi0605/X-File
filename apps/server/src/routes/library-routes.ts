import type { FastifyInstance } from "fastify";

import type { LibraryController } from "../library/library-controller.js";
import { toLibraryErrorResponse } from "../library/library-errors.js";

export async function registerLibraryRoutes(
  app: FastifyInstance,
  libraryController: LibraryController
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

  app.get("/api/library/binding", wrap(libraryController.getBinding));
  app.put("/api/library/binding", wrap(libraryController.saveBinding));
  app.get("/api/library/config", wrap(libraryController.getConfig));
  app.put("/api/library/config", wrap(libraryController.saveConfig));
  app.get("/api/library/snapshot", wrap(libraryController.getSnapshot));
  app.get("/api/library/documents", wrap(libraryController.listDocuments));
  app.get("/api/library/files", wrap(libraryController.listFiles));
  app.get("/api/library/preview", wrap(libraryController.previewFile));
  app.get("/api/library/download", wrap(libraryController.downloadFile));
  app.post("/api/library/ops", wrap(libraryController.operateFile));
  app.post("/api/library/refresh", wrap(libraryController.requestRefresh));
  app.put("/api/library/favorites", wrap(libraryController.updateFavorites));
  app.get("/preview/library-files/:token/*", libraryController.servePublicPreview);
}
