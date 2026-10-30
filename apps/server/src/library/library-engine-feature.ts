import type { FastifyInstance } from "fastify";
import type { LibraryIndexProgress, LibraryMirrorMutation, LibraryTask } from "@x-file/shared";

import { HttpServerManager, type HttpServerRuntimeState } from "../http-server-manager.js";
import { PersistentBackendManager } from "../lifecycle/persistent-backend-manager.js";
import { registerHostDirectoryRoutes } from "../routes/host-directory-routes.js";
import { registerIntegrationRoutes } from "../routes/integration-routes.js";
import { registerLibraryRoutes } from "../routes/library-routes.js";
import { registerServerStateRoutes } from "../routes/server-state-routes.js";
import { registerTagRoutes } from "../routes/tag-routes.js";
import { IndexRuntimeStore } from "../storage/index-runtime-store.js";
import { LibraryBindingStore } from "../storage/library-binding-store.js";
import { LibraryConfigStore } from "../storage/library-config-store.js";
import { TagStore } from "../storage/tag-store.js";
import { TaskManager } from "../tasks/task-manager.js";
import { HostDirectoryBrowserService } from "./host-directory-browser-service.js";
import { LibraryIndexService } from "./index-service.js";
import { LibraryConfigService } from "./library-config-service.js";
import { LibraryController } from "./library-controller.js";
import { LibraryError } from "./library-errors.js";
import { toLibraryErrorResponse } from "./library-errors.js";
import { LibraryService } from "./library-service.js";
import { LibraryMirrorService } from "./library-mirror-service.js";
import { LibraryPreviewLinkService } from "./preview-link-service.js";
import { TagController } from "./tag-controller.js";
import { TagService } from "./tag-service.js";

const DEFAULT_SIGNING_SECRET = "x-file-local-preview-development-secret";

export interface RegisterLibraryEngineFeatureOptions {
  httpServerRuntimeState?: HttpServerRuntimeState;
  httpServerManager?: HttpServerManager;
  manageHttpServerLifecycle?: boolean;
  sidecarProfile?: "full" | "sidecar-only";
}

export interface LibraryEngineFeature {
  libraryBindingStore: LibraryBindingStore;
  libraryService: LibraryService;
  libraryIndexService: LibraryIndexService;
  tagService: TagService;
  libraryMirrorService: LibraryMirrorService;
  taskManager: TaskManager;
  httpServerManager: HttpServerManager;
  persistentBackendManager: PersistentBackendManager;
}

export function createLibraryEngineFeature(
  options: RegisterLibraryEngineFeatureOptions = {}
): LibraryEngineFeature {
  const libraryBindingStore = new LibraryBindingStore();
  const taskManager = new TaskManager();
  const tagService = new TagService(libraryBindingStore, new TagStore(), taskManager);
  tagService.registerTasks();
  const libraryIndexService = new LibraryIndexService(
    taskManager,
    new IndexRuntimeStore(),
    undefined,
    undefined,
    () => { tagService.requestFullRecompute(); },
  );
  const libraryService = new LibraryService(
    libraryBindingStore,
    undefined,
    libraryIndexService,
  );
  const libraryMirrorService = new LibraryMirrorService(libraryService, tagService);
  const httpServerManager =
    options.httpServerManager ??
    new HttpServerManager(undefined, options.httpServerRuntimeState);
  const persistentBackendManager = new PersistentBackendManager();
  return {
    libraryBindingStore,
    libraryService,
    libraryIndexService,
    tagService,
    libraryMirrorService,
    taskManager,
    httpServerManager,
    persistentBackendManager,
  };
}

export function registerLibraryCoreRoutes(
  server: FastifyInstance,
  feature: LibraryEngineFeature,
  options: RegisterLibraryEngineFeatureOptions = {},
): void {
  if (resolveSidecarProfile(options) === "sidecar-only") {
    registerLibraryCoreRoutePlaceholders(server);
    return;
  }

  const libraryConfigService = new LibraryConfigService(
    feature.libraryBindingStore,
    new LibraryConfigStore(),
    (binding) => feature.libraryIndexService.requestRefresh(binding, {
      reason: "library_config_changed",
    }),
  );
  const previewLinkService = new LibraryPreviewLinkService(
    feature.libraryService,
    process.env.X_FILE_SIGNING_SECRET?.trim() || DEFAULT_SIGNING_SECRET,
  );
  const tagService = feature.tagService;

  void registerLibraryRoutes(
    server,
    new LibraryController(
      feature.libraryService,
      previewLinkService,
      libraryConfigService,
    ),
  );
  void registerTagRoutes(server, new TagController(tagService));
  server.get("/api/library/mirror/snapshot", async (_request, reply) => {
    reply.send(feature.libraryMirrorService.getSnapshot());
  });
  server.post("/api/library/mirror/mutations", async (request, reply) => {
    try {
      const body = request.body as { mutations?: unknown } | undefined;
      const mutations = Array.isArray(body?.mutations) ? body.mutations : [];
      reply.send(feature.libraryMirrorService.applyMutations(mutations as LibraryMirrorMutation[]));
    } catch (error) {
      const response = toLibraryErrorResponse(
        error instanceof LibraryError
          ? error
          : new LibraryError(400, "INVALID_INPUT", error instanceof Error ? error.message : "镜像同步失败"),
      );
      reply.code(response.statusCode).send(response.body);
    }
  });
  server.get("/api/library/tasks", async (): Promise<LibraryTask[]> => {
    const binding = feature.libraryBindingStore.read();
    if (!binding) return [];
    return feature.taskManager.list(binding.rootDir).map((task) => {
      const progress = task.progress as (LibraryIndexProgress & Pick<LibraryTask, "stageProgress">) | null;
      return {
        taskId: task.taskId,
        taskType: task.taskType === "library.index_refresh" ? "library.index" : task.taskType,
        rootDir: task.key,
        targetPath: null,
        categoryTitle: task.categoryTitle,
        source: task.source,
        state: task.state === "fresh" ? "completed"
          : task.state === "queue_timeout" ? "failed" : task.state,
        stage: task.runningStage,
        totalCount: progress?.totalCount ?? null,
        processedCount: progress?.scannedCount ?? 0,
        stageProgress: progress?.stageProgress,
        errorSummary: task.errorSummary,
        queuedAt: task.queuedAt,
        startedAt: task.startedAt,
        completedAt: task.completedAt ?? task.failedAt,
      };
    });
  });
  void registerHostDirectoryRoutes(server, new HostDirectoryBrowserService());
}

export function registerLibraryNodeServiceRoutes(
  server: FastifyInstance,
  feature: LibraryEngineFeature,
  options: RegisterLibraryEngineFeatureOptions = {},
): void {
  // 这里保留的是 Node sidecar 仍必须承担的服务面：
  // integration/status、server state。
  // 它们可以消费 library 的只读视图或通过 notifyFileChanged 上报文件变更，
  // 但不应重新持有 index/export 执行面的宿主职责。
  void registerServerStateRoutes(
    server,
    feature.httpServerManager,
    feature.persistentBackendManager,
    {
      manageLifecycle: options.manageHttpServerLifecycle === true,
    },
  );
  if (resolveSidecarProfile(options) === "sidecar-only") {
    registerSidecarOnlyIntegrationRoutes(server, feature.httpServerManager);
  } else {
    void registerIntegrationRoutes(server, feature.libraryService, feature.httpServerManager);
  }
}

export function registerLibraryEngineFeature(
  server: FastifyInstance,
  options: RegisterLibraryEngineFeatureOptions = {}
): LibraryEngineFeature {
  const feature = createLibraryEngineFeature(options);
  registerLibraryCoreRoutes(server, feature, options);
  registerLibraryNodeServiceRoutes(server, feature, options);
  return feature;
}

function resolveSidecarProfile(
  options: RegisterLibraryEngineFeatureOptions,
): "full" | "sidecar-only" {
  if (options.sidecarProfile) {
    return options.sidecarProfile;
  }
  const raw = process.env.X_FILE_NODE_SIDECAR_PROFILE?.trim().toLowerCase();
  if (raw === "full") {
    return "full";
  }
  return "sidecar-only";
}

function registerLibraryCoreRoutePlaceholders(server: FastifyInstance): void {
  const reject = async () => {
    throw new LibraryError(
      503,
      "LIBRARY_TODO",
      "当前 Node sidecar 已切到 sidecar-only 模式；正式包默认不再由它提供 library 核心数据面 HTTP 路由。请改走桌面 native bridge，或仅在调试时显式设置 X_FILE_NODE_SIDECAR_PROFILE=full。",
    );
  };
  server.get("/api/library/binding", reject);
  server.put("/api/library/binding", reject);
  server.get("/api/library/config", reject);
  server.put("/api/library/config", reject);
  server.get("/api/library/snapshot", reject);
  server.get("/api/library/tasks", reject);
  server.get("/api/library/documents", reject);
  server.get("/api/library/files", reject);
  server.get("/api/library/preview", reject);
  server.get("/api/library/download", reject);
  server.post("/api/library/ops", reject);
  server.post("/api/library/refresh", reject);
  server.put("/api/library/favorites", reject);
  server.get("/api/library/backup", reject);
  server.post("/api/library/backup", reject);
  server.get("/api/library/preview-file/:token/*", reject);
  server.get("/preview/library-files/:token/*", reject);
  server.get("/api/library/tags", reject);
  server.post("/api/library/tags", reject);
  server.post("/api/library/tags/ensure", reject);
  server.post("/api/library/tags/recompute", reject);
  server.get("/api/library/tags/recompute-task", reject);
  server.get("/api/library/tags/:tagId", reject);
  server.put("/api/library/tags/:tagId", reject);
  server.delete("/api/library/tags/:tagId", reject);
  server.get("/api/library/documents/:documentId/tag-details", reject);
  server.put("/api/library/documents/:documentId/tags", reject);
  server.get("/api/library/folders/tag-details", reject);
  server.put("/api/library/folders/tags", reject);
  server.get("/api/library/mirror/snapshot", reject);
  server.post("/api/library/mirror/mutations", reject);
  server.get("/api/host/directories", reject);
}

function registerSidecarOnlyIntegrationRoutes(
  server: FastifyInstance,
  httpServerManager: HttpServerManager,
): void {
  server.get("/api/integration/status", async () => ({
    ok: true,
    app: "X-File",
    integrationVersion: 1,
    httpServer: httpServerManager.getState(),
    library: {
      available: false,
      libraryId: null,
      rootDir: null,
      indexState: "native-host",
      documentCount: 0,
      tagCount: 0,
      favoriteCount: 0,
      folderCount: 0,
      lastError: "Node sidecar 处于 sidecar-only 模式；library 核心读写链已迁到桌面 native 宿主。",
    },
    api: {
      health: "/api/health",
      serverState: "/api/server/state",
    },
  }));
}
