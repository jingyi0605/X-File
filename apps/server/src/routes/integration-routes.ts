import type { FastifyInstance } from "fastify";
import type { LibrarySnapshot } from "@x-file/shared";

import type { HttpServerManager } from "../http-server-manager.js";
import type { LibraryService } from "../library/library-service.js";

export async function registerIntegrationRoutes(
  app: FastifyInstance,
  libraryService: LibraryService,
  httpServerManager: HttpServerManager
): Promise<void> {
  app.get("/api/integration/status", async () => {
    const snapshot = libraryService.getSnapshot();
    return {
      ok: true,
      app: "X-File",
      integrationVersion: 1,
      httpServer: httpServerManager.getState(),
      library: summarizeLibrarySnapshot(snapshot),
      api: {
        health: "/api/health",
        serverState: "/api/server/state",
        librarySnapshot: "/api/library/snapshot",
        libraryDocuments: "/api/library/documents",
        libraryFiles: "/api/library/files"
      }
    };
  });
}

function summarizeLibrarySnapshot(snapshot: LibrarySnapshot) {
  return {
    available: Boolean(snapshot.binding?.enabled),
    libraryId: snapshot.binding?.libraryId ?? null,
    rootDir: snapshot.binding?.rootDir ?? null,
    indexState: snapshot.status.state,
    documentCount: snapshot.documentCount,
    tagCount: snapshot.tags.length,
    favoriteCount: snapshot.favorites.length,
    folderCount: snapshot.folders.length,
    lastError: snapshot.lastError ?? snapshot.status.errorSummary ?? null
  };
}
