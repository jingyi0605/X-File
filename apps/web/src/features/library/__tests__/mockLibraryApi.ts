import { vi } from "vitest";
import type {
  LibraryBinding,
  LibraryDocumentList,
  LibraryDocumentRecord,
  LibraryFileList,
  LibraryFileNode,
  LibraryIndexStatus,
  LibrarySnapshot,
  LibraryTagDetailWithRules,
  LibraryTagNode,
} from "@x-file/shared";

export const libraryApiMock = {
  browseHostDirectories: vi.fn(),
  createLibraryTag: vi.fn(),
  deleteLibraryTag: vi.fn(),
  downloadLibraryFile: vi.fn(),
  getHttpServerState: vi.fn(),
  getLibraryBinding: vi.fn(),
  getLibraryConfig: vi.fn(),
  getDocumentTagDetails: vi.fn(),
  getFolderTagDetails: vi.fn(),
  getLibraryPreview: vi.fn(),
  getLibrarySnapshot: vi.fn(),
  getLibraryTagRecomputeTask: vi.fn(),
  getOnlyOfficeSettings: vi.fn(),
  getOnlyOfficeStatus: vi.fn(),
  listLibraryDocuments: vi.fn(),
  listLibraryFiles: vi.fn(),
  listLibraryTagDetails: vi.fn(),
  listLibraryTags: vi.fn(),
  operateLibraryFile: vi.fn(),
  requestLibraryRefresh: vi.fn(),
  requestLibraryTagRecompute: vi.fn(),
  saveHttpServerState: vi.fn(),
  saveDocumentTags: vi.fn(),
  saveFolderTags: vi.fn(),
  saveLibraryBinding: vi.fn(),
  saveLibraryConfig: vi.fn(),
  saveOnlyOfficeSettings: vi.fn(),
  updateLibraryFavorites: vi.fn(),
  updateLibraryTag: vi.fn(),
};

export function installLibraryApiMock(): void {
  vi.doMock("../../../api/library", () => libraryApiMock);
}

export function resetLibraryApiMock(): void {
  Object.values(libraryApiMock).forEach((mock) => mock.mockReset());
  libraryApiMock.getLibrarySnapshot.mockResolvedValue(createLibrarySnapshot());
  libraryApiMock.getLibraryBinding.mockResolvedValue(createLibraryBinding());
  libraryApiMock.getLibraryConfig.mockResolvedValue(createLibraryConfig());
  libraryApiMock.getHttpServerState.mockResolvedValue({
    enabled: false,
    host: "127.0.0.1",
    port: 17321,
    running: false,
    persistent: false,
    lifecycleState: "disabled",
    lastStartedAt: null,
    lastStoppedAt: null,
    errorSummary: null,
  });
  libraryApiMock.getOnlyOfficeSettings.mockResolvedValue({
    enabled: false,
    serverUrl: null,
    publicBaseUrl: null,
    callbackBaseUrl: null,
    userDisplayName: null,
    userAvatarUrl: null,
    jwtConfigured: false,
  });
  libraryApiMock.getOnlyOfficeStatus.mockResolvedValue({
    enabled: false,
    configured: false,
    healthy: false,
    serverUrl: null,
    publicBaseUrl: null,
    callbackBaseUrl: null,
    jwtConfigured: false,
    checkedAt: null,
    errorSummary: null,
  });
  libraryApiMock.listLibraryTags.mockResolvedValue([]);
  libraryApiMock.listLibraryDocuments.mockResolvedValue(createDocumentList());
  libraryApiMock.listLibraryFiles.mockResolvedValue(createFileList());
  libraryApiMock.getLibraryPreview.mockResolvedValue({
    kind: "text",
    path: "docs/真实文件名.md",
    title: "真实文件名.md",
    content: "",
    updatedAt: null,
  });
  libraryApiMock.operateLibraryFile.mockResolvedValue({ ok: true });
  libraryApiMock.requestLibraryRefresh.mockResolvedValue({
    taskId: "task-test",
    status: createIndexStatus(),
  });
  libraryApiMock.updateLibraryFavorites.mockResolvedValue({ items: [] });
  libraryApiMock.listLibraryTagDetails.mockResolvedValue([]);
  libraryApiMock.saveLibraryConfig.mockImplementation(async (input) => ({
    ...createLibraryConfig(),
    ...input,
    binding: createLibraryBinding({
      allowedExtensions: input.allowedExtensions,
      includedHiddenPaths: input.includedHiddenPaths,
      folderOpenBehavior: input.folderOpenBehavior,
      enabled: typeof input.enabled === "boolean" ? input.enabled : undefined,
    }),
  }));
}

export function createLibraryBinding(
  overrides: Partial<LibraryBinding> = {},
): LibraryBinding {
  return {
    libraryId: "library-test",
    rootDir: "/Users/test/Documents",
    enabled: true,
    mirrorRoot: null,
    allowedExtensions: [".md", ".pdf"],
    includedHiddenPaths: [],
    folderOpenBehavior: "double_click",
    configRelativePath: ".x-file/library.json",
    exportMode: "v2",
    initialized: true,
    initializedAt: "2026-06-09T00:00:00.000Z",
    updatedAt: "2026-06-09T00:00:00.000Z",
    ...overrides,
  };
}

export function createLibraryConfig(overrides: Record<string, unknown> = {}) {
  const binding = createLibraryBinding();
  return {
    binding,
    enabled: binding.enabled,
    mirrorRoot: binding.mirrorRoot,
    allowedExtensions: binding.allowedExtensions,
    includedHiddenPaths: binding.includedHiddenPaths,
    folderOpenBehavior: binding.folderOpenBehavior,
    configRelativePath: binding.configRelativePath,
    canWrite: true,
    ...overrides,
  };
}

export function createIndexStatus(
  overrides: Partial<LibraryIndexStatus> = {},
): LibraryIndexStatus {
  return {
    state: "fresh",
    dirtyReasons: [],
    lastRequestedAt: null,
    lastStartedAt: null,
    lastCompletedAt: "2026-06-09T00:00:00.000Z",
    lastFailedAt: null,
    nextAllowedAt: null,
    runningTaskId: null,
    runningStage: null,
    errorSummary: null,
    ...overrides,
  };
}

export function createLibrarySnapshot(
  overrides: Partial<LibrarySnapshot> = {},
): LibrarySnapshot {
  return {
    binding: createLibraryBinding(),
    defaultRootDir: "/Users/test/X-File",
    requiresInitialization: false,
    initializationRedirectPath: "/init",
    status: createIndexStatus(),
    tags: [],
    favorites: [],
    folders: [],
    documentCount: 0,
    lastError: null,
    ...overrides,
  };
}

export function createDocumentRecord(
  overrides: Partial<LibraryDocumentRecord> = {},
): LibraryDocumentRecord {
  return {
    documentId: "doc-1",
    path: "docs/真实文件名.md",
    title: "摘要标题不是文件名",
    summary: "这是一段摘要",
    updatedAt: "2026-06-09T00:00:00.000Z",
    createdAt: "2026-06-08T00:00:00.000Z",
    sizeBytes: 1234,
    tags: [],
    derivedTags: [],
    isFavorite: false,
    ...overrides,
  };
}

export function createDocumentList(
  items: LibraryDocumentRecord[] = [],
  overrides: Partial<LibraryDocumentList> = {},
): LibraryDocumentList {
  return {
    total: items.length,
    offset: 0,
    limit: 60,
    items,
    tagFacetCounts: {},
    directoryStatus: null,
    ...overrides,
  };
}

export function createFileNode(overrides: Partial<LibraryFileNode> = {}): LibraryFileNode {
  return {
    path: "资料夹",
    name: "资料夹",
    kind: "directory",
    size: null,
    updatedAt: "2026-06-09T00:00:00.000Z",
    ...overrides,
  };
}

export function createFileList(
  items: LibraryFileNode[] = [],
  overrides: Partial<LibraryFileList> = {},
): LibraryFileList {
  return {
    items,
    path: "",
    total: items.length,
    limit: 200,
    ...overrides,
  };
}

export function createTagDetail(
  overrides: Partial<LibraryTagDetailWithRules> = {},
): LibraryTagDetailWithRules {
  const path = overrides.path ?? "类型/报告";
  return {
    id: overrides.id ?? path,
    path,
    name: overrides.name ?? path.split("/").at(-1) ?? path,
    rootType: overrides.rootType ?? path.split("/")[0] ?? path,
    parentId: overrides.parentId ?? null,
    parentPath: overrides.parentPath ?? null,
    status: overrides.status ?? "active",
    documentCount: overrides.documentCount ?? 0,
    description: overrides.description ?? null,
    createdAt: overrides.createdAt ?? "2026-06-09T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-06-09T00:00:00.000Z",
    disabledAt: overrides.disabledAt ?? null,
    smartRules: overrides.smartRules ?? [],
    smartRuleEnabled: overrides.smartRuleEnabled ?? false,
    ...overrides,
  };
}

export function createTagNode(overrides: Partial<LibraryTagNode> = {}): LibraryTagNode {
  const path = overrides.path ?? "类型/报告";
  return {
    path,
    name: overrides.name ?? path.split("/").at(-1) ?? path,
    rootType: overrides.rootType ?? path.split("/")[0] ?? path,
    parentPath: overrides.parentPath ?? null,
    depth: overrides.depth ?? path.split("/").filter(Boolean).length - 1,
    documentCount: overrides.documentCount ?? 1,
    ...overrides,
  };
}
