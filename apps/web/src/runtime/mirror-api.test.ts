import { beforeEach, describe, expect, it, vi } from "vitest";

import type { LibraryMirrorSnapshot } from "@x-file/shared";
import { initializeRuntimeConfig, updateRuntimeConfig } from "./runtime-config-store";
import { loadMirrorCache, saveMirrorCache } from "./mirror-cache";

const fetchMock = vi.fn<typeof fetch>();

vi.stubGlobal("fetch", fetchMock);

function createSnapshot(): LibraryMirrorSnapshot {
  const generatedAt = "2026-10-30T00:00:00.000Z";
  const binding = {
    libraryId: "default",
    rootDir: "/primary/library",
    enabled: true,
    mirrorRoot: null,
    allowedExtensions: [".md"],
    includedHiddenPaths: [],
    hideDotFiles: true,
    hideSystemFolders: true,
    folderOpenBehavior: "double_click" as const,
    configRelativePath: ".ai-index/config.json",
    exportMode: "v2" as const,
    initialized: true,
    initializedAt: generatedAt,
    updatedAt: generatedAt,
  };
  const snapshot = {
    binding,
    defaultRootDir: "/primary/library",
    requiresInitialization: false,
    initializationRedirectPath: "/init",
    status: {
      state: "fresh" as const,
      dirtyReasons: [],
      lastRequestedAt: null,
      lastStartedAt: null,
      lastCompletedAt: generatedAt,
      lastFailedAt: null,
      nextAllowedAt: null,
      runningTaskId: null,
      runningStage: null,
      errorSummary: null,
    },
    tags: [],
    favorites: [],
    folders: [],
    documentCount: 1,
    lastError: null,
  };
  return {
    version: 1,
    revision: "rev-1",
    generatedAt,
    config: {
      binding,
      enabled: true,
      mirrorRoot: null,
      allowedExtensions: [".md"],
      includedHiddenPaths: [],
      hideDotFiles: true,
      hideSystemFolders: true,
      folderOpenBehavior: "double_click",
      configRelativePath: ".ai-index/config.json",
      canWrite: false,
    },
    snapshot,
    documents: [{
      documentId: "docs/a.md",
      path: "docs/a.md",
      title: "A",
      summary: "offline search text",
      updatedAt: generatedAt,
      tags: ["topic/offline"],
      derivedTags: [],
      isFavorite: false,
    }],
    tagDetails: [{
      id: "tag-topic",
      path: "topic",
      name: "topic",
      rootType: "topic",
      parentId: null,
      parentPath: null,
      description: null,
      status: "active",
      documentCount: 1,
      createdAt: generatedAt,
      updatedAt: generatedAt,
      disabledAt: null,
      smartRules: [],
      smartRuleEnabled: false,
    }],
    documentTagBindings: [{
      documentId: "docs/a.md",
      path: "docs/a.md",
      title: "A",
      manualTagIds: ["tag-topic"],
      updatedAt: generatedAt,
    }],
    folderTagBindings: [],
  };
}

describe("mirror API cache", () => {
  beforeEach(async () => {
    localStorage.clear();
    fetchMock.mockReset();
    initializeRuntimeConfig();
    await updateRuntimeConfig({ mode: "mirror", remoteApiBaseUrl: "http://primary.test" });
  });

  it("disconnects to cached document and folder reads", async () => {
    await saveMirrorCache("http://primary.test", {
      snapshot: createSnapshot(),
      pendingMutations: [],
      syncResults: [],
      source: "primary",
      lastSyncedAt: "2026-10-30T00:00:00.000Z",
      lastError: null,
    });
    fetchMock.mockRejectedValue(new Error("connection refused"));

    const { listMirrorDocuments, listMirrorFiles, getMirrorSnapshot } = await import("./mirror-api");
    const model = await getMirrorSnapshot();
    const snapshotRequestCount = fetchMock.mock.calls.length;
    const documents = await listMirrorDocuments({
      browseMode: "tag",
      selectedTagPaths: ["topic"],
      keyword: "offline",
      searchMode: "content",
    });
    const files = await listMirrorFiles("docs", 20);

    expect(model.revision).toBe("rev-1");
    expect(documents.items.map((item) => item.path)).toEqual(["docs/a.md"]);
    expect(files.items.map((item) => item.path)).toEqual(["docs/a.md"]);
    expect(fetchMock).toHaveBeenCalledTimes(snapshotRequestCount);
    expect((await loadMirrorCache("http://primary.test")).source).toBe("cache");
  });

  it.each([404, 500])("falls back to the legacy library APIs when the mirror snapshot route returns %s", async (status) => {
    const snapshot = createSnapshot();
    fetchMock.mockImplementation(async (url) => {
      const target = String(url);
      if (target.endsWith("/api/library/mirror/snapshot")) {
        return new Response(JSON.stringify({ detail: "route unavailable" }), { status });
      }
      if (target.endsWith("/api/library/snapshot")) {
        return new Response(JSON.stringify(snapshot.snapshot));
      }
      if (target.endsWith("/api/library/config")) {
        return new Response(JSON.stringify(snapshot.config));
      }
      if (target.includes("/api/library/tags")) {
        return new Response(JSON.stringify({ items: snapshot.tagDetails }));
      }
      if (target.includes("/api/library/documents?")) {
        return new Response(JSON.stringify({
          total: snapshot.documents.length,
          offset: 0,
          limit: 500,
          items: snapshot.documents,
        }));
      }
      throw new Error(`unexpected request: ${target}`);
    });

    const { getMirrorSnapshot } = await import("./mirror-api");
    const model = await getMirrorSnapshot();

    expect(model.revision).toMatch(/^legacy-/);
    expect(model.documents).toEqual(snapshot.documents);
    expect(model.tagDetails).toEqual(snapshot.tagDetails);
    expect(model.config.canWrite).toBe(false);
  });

  it("applies a revision-based delta to the cached mirror snapshot", async () => {
    const snapshot = createSnapshot();
    await saveMirrorCache("http://primary.test", {
      snapshot,
      pendingMutations: [],
      syncResults: [],
      source: "primary",
      lastSyncedAt: "2026-10-30T00:00:00.000Z",
      lastError: null,
    });
    const nextDocument = {
      ...snapshot.documents[0],
      documentId: "docs/b.md",
      path: "docs/b.md",
      title: "B",
    };
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      version: 1,
      kind: "delta",
      baseRevision: snapshot.revision,
      revision: "rev-2",
      generatedAt: "2026-10-31T00:00:00.000Z",
      config: snapshot.config,
      snapshot: { ...snapshot.snapshot, documentCount: 2 },
      documentUpserts: [nextDocument],
      deletedDocumentIds: [],
      tagDetailUpserts: [],
      deletedTagIds: [],
      documentTagBindingUpserts: [],
      deletedDocumentTagBindingIds: [],
      folderTagBindingUpserts: [],
      deletedFolderTagPaths: [],
    })));

    const { getMirrorSnapshot } = await import("./mirror-api");
    const next = await getMirrorSnapshot();

    expect(String(fetchMock.mock.calls[0][0])).toContain("sinceRevision=rev-1");
    expect(next.revision).toBe("rev-2");
    expect(next.documents.map((item) => item.documentId)).toEqual(["docs/a.md", "docs/b.md"]);
    expect(next.snapshot.documentCount).toBe(2);
  });

  it("reuses the local snapshot when the primary reports the revision is unchanged", async () => {
    const snapshot = createSnapshot();
    await saveMirrorCache("http://primary.test", {
      snapshot,
      pendingMutations: [],
      syncResults: [],
      source: "cache",
      lastSyncedAt: "2026-10-30T00:00:00.000Z",
      lastError: "offline",
    });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      version: 1,
      kind: "unchanged",
      revision: snapshot.revision,
      generatedAt: "2026-10-31T00:00:00.000Z",
    })));

    const { getMirrorSnapshot } = await import("./mirror-api");
    const result = await getMirrorSnapshot();

    expect(String(fetchMock.mock.calls[0][0])).toContain("sinceRevision=rev-1");
    expect(result.documents).toEqual(snapshot.documents);
    expect(result.revision).toBe(snapshot.revision);
    await expect(loadMirrorCache("http://primary.test")).resolves.toMatchObject({
      source: "primary",
      lastError: null,
    });
  });

  it("falls back to paged library reads when a primary snapshot response stalls", async () => {
    const snapshot = createSnapshot();
    fetchMock.mockImplementation((url, init) => {
      const target = String(url);
      if (target.endsWith("/api/library/mirror/snapshot")) {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      }
      if (target.endsWith("/api/library/snapshot")) {
        return Promise.resolve(new Response(JSON.stringify(snapshot.snapshot)));
      }
      if (target.endsWith("/api/library/config")) {
        return Promise.resolve(new Response(JSON.stringify(snapshot.config)));
      }
      if (target.includes("/api/library/tags")) {
        return Promise.resolve(new Response(JSON.stringify({ items: snapshot.tagDetails })));
      }
      if (target.includes("/api/library/documents?")) {
        return Promise.resolve(new Response(JSON.stringify({
          total: snapshot.documents.length,
          offset: 0,
          limit: 500,
          items: snapshot.documents,
        })));
      }
      return Promise.reject(new Error(`unexpected request: ${target}`));
    });

    vi.useFakeTimers();
    try {
      const { getMirrorSnapshot } = await import("./mirror-api");
      const result = getMirrorSnapshot();
      await vi.advanceTimersByTimeAsync(15_000);

      expect((await result).documents).toEqual(snapshot.documents);
    } finally {
      vi.useRealTimers();
    }
  });

  it("queues offline tag changes and applies optimistic local filtering", async () => {
    await saveMirrorCache("http://primary.test", {
      snapshot: createSnapshot(),
      pendingMutations: [],
      syncResults: [],
      source: "primary",
      lastSyncedAt: "2026-10-30T00:00:00.000Z",
      lastError: null,
    });
    fetchMock.mockRejectedValue(new Error("connection refused"));

    const { saveMirrorDocumentTags } = await import("./mirror-api");
    const details = await saveMirrorDocumentTags("docs/a.md", { tagIds: [] });
    const cache = await loadMirrorCache("http://primary.test");

    expect(details.syncState).toBe("queued");
    expect(cache.pendingMutations).toHaveLength(1);
    expect(cache.snapshot?.revision).toBe("rev-1");
    expect(fetchMock.mock.calls.every(([url]) => String(url).startsWith("http://primary.test/"))).toBe(true);
  });

  it("translates locally created tag IDs into stable paths for assignment replay", async () => {
    await saveMirrorCache("http://primary.test", {
      snapshot: createSnapshot(),
      pendingMutations: [],
      syncResults: [],
      source: "primary",
      lastSyncedAt: "2026-10-30T00:00:00.000Z",
      lastError: null,
    });
    fetchMock.mockRejectedValue(new Error("connection refused"));

    const { saveMirrorDocumentTags, saveMirrorTagDefinition } = await import("./mirror-api");
    const tag = await saveMirrorTagDefinition("create", null, { name: "offline-tag" });
    await saveMirrorDocumentTags("docs/a.md", { tagIds: [(tag as { id: string }).id] });
    const cache = await loadMirrorCache("http://primary.test");
    const assignment = cache.pendingMutations.find((mutation) => mutation.kind === "document_tags");

    expect(cache.pendingMutations).toHaveLength(2);
    expect((assignment?.payload as { input: { tagIds: string[]; createTagPaths: string[] } }).input).toMatchObject({
      tagIds: [],
      createTagPaths: ["offline-tag"],
    });
  });

  it("rejects mirror file and library-config writes before issuing HTTP requests", async () => {
    const { operateLibraryFile, saveLibraryConfig, restoreLibraryBackup } = await import("../api/library");

    await expect(operateLibraryFile({ opType: "delete", srcPath: "docs/a.md" })).rejects.toThrow(/镜像端不能修改文件/);
    await expect(saveLibraryConfig({ enabled: false })).rejects.toThrow(/镜像端不能修改主端资料库配置/);
    await expect(restoreLibraryBackup({})).rejects.toThrow(/镜像端不能导入资料库备份/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
