import Fastify from "fastify";

import { HttpServerManager, type HttpServerRuntimeState } from "./http-server-manager.js";
import { PersistentBackendManager } from "./lifecycle/persistent-backend-manager.js";
import { HostDirectoryBrowserService } from "./library/host-directory-browser-service.js";
import { LibraryController } from "./library/library-controller.js";
import { LibraryConfigService } from "./library/library-config-service.js";
import { LibraryService } from "./library/library-service.js";
import { LibraryPreviewLinkService } from "./library/preview-link-service.js";
import { TagController } from "./library/tag-controller.js";
import { TagService } from "./library/tag-service.js";
import { OnlyOfficeController } from "./office/onlyoffice-controller.js";
import { OnlyOfficeService } from "./office/onlyoffice-service.js";
import { registerHostDirectoryRoutes } from "./routes/host-directory-routes.js";
import { registerIntegrationRoutes } from "./routes/integration-routes.js";
import { registerLibraryRoutes } from "./routes/library-routes.js";
import { registerOfficeRoutes } from "./routes/office-routes.js";
import { registerServerStateRoutes } from "./routes/server-state-routes.js";
import { registerTagRoutes } from "./routes/tag-routes.js";
import { LibraryBindingStore } from "./storage/library-binding-store.js";
import { LibraryConfigStore } from "./storage/library-config-store.js";
import { OnlyOfficeSettingsStore } from "./storage/onlyoffice-settings-store.js";
import { TagStore } from "./storage/tag-store.js";

const APP_VERSION = "0.1.0";
const DEFAULT_SIGNING_SECRET = "x-file-local-preview-development-secret";

export interface CreateServerOptions {
  httpServerRuntimeState?: HttpServerRuntimeState;
  httpServerManager?: HttpServerManager;
  manageHttpServerLifecycle?: boolean;
}

export function createServer(options: CreateServerOptions = {}) {
  const server = Fastify({
    logger: true
  });

  server.addHook("onRequest", async (request, reply) => {
    const origin = request.headers.origin;
    if (typeof origin === "string" && isAllowedLocalOrigin(origin)) {
      reply.header("Access-Control-Allow-Origin", origin);
      reply.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
      reply.header("Access-Control-Allow-Headers", "content-type");
      reply.header("Access-Control-Allow-Credentials", "false");
    }
  });

  server.options("/*", async (_request, reply) => reply.code(204).send());

  server.get("/api/health", async () => ({
    ok: true,
    app: "X-File",
    version: APP_VERSION
  }));

  const libraryBindingStore = new LibraryBindingStore();
  const hostDirectoryBrowserService = new HostDirectoryBrowserService();
  const libraryService = new LibraryService(libraryBindingStore);
  const libraryConfigService = new LibraryConfigService(libraryBindingStore, new LibraryConfigStore());
  const tagService = new TagService(libraryBindingStore, new TagStore());
  const httpServerManager = options.httpServerManager
    ?? new HttpServerManager(undefined, options.httpServerRuntimeState);
  const persistentBackendManager = new PersistentBackendManager();
  const signingSecret = process.env.X_FILE_SIGNING_SECRET?.trim() || DEFAULT_SIGNING_SECRET;
  const previewLinkService = new LibraryPreviewLinkService(libraryService, signingSecret);
  const onlyOfficeService = new OnlyOfficeService(
    new OnlyOfficeSettingsStore(),
    previewLinkService,
    libraryService,
    signingSecret
  );

  void registerLibraryRoutes(
    server,
    new LibraryController(libraryService, previewLinkService, onlyOfficeService, libraryConfigService)
  );
  void registerHostDirectoryRoutes(server, hostDirectoryBrowserService);
  void registerOfficeRoutes(server, new OnlyOfficeController(onlyOfficeService));
  void registerServerStateRoutes(server, httpServerManager, persistentBackendManager, {
    manageLifecycle: options.manageHttpServerLifecycle === true
  });
  void registerTagRoutes(server, new TagController(tagService));
  void registerIntegrationRoutes(server, libraryService, httpServerManager);

  return server;
}

function isAllowedLocalOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (
      url.protocol === "http:"
      && (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1")
    );
  } catch {
    return false;
  }
}
