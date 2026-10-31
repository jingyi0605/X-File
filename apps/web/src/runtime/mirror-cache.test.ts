import { beforeEach, describe, expect, it, vi } from "vitest";

import type { LibraryMirrorSnapshot } from "@x-file/shared";

const CACHE_URL = "http://primary.test";

function createCacheSnapshot(): LibraryMirrorSnapshot {
  const generatedAt = "2026-10-31T00:00:00.000Z";
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
  return {
    version: 1,
    revision: "cached-revision",
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
    snapshot: {
      binding,
      defaultRootDir: binding.rootDir,
      requiresInitialization: false,
      initializationRedirectPath: "/init",
      status: {
        state: "fresh",
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
      documentCount: 0,
      lastError: null,
    },
    documents: [],
    tagDetails: [],
    documentTagBindings: [],
    folderTagBindings: [],
  };
}

describe("mirror cache persistence", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it("restores the last primary snapshot after the app module is reloaded", async () => {
    const initialCache = await import("./mirror-cache");
    await initialCache.saveMirrorCache(CACHE_URL, {
      snapshot: createCacheSnapshot(),
      pendingMutations: [],
      syncResults: [],
      source: "primary",
      lastSyncedAt: "2026-10-31T00:00:00.000Z",
      lastError: null,
    });

    vi.resetModules();
    const reloadedCache = await import("./mirror-cache");
    const restored = await reloadedCache.loadMirrorCache(CACHE_URL);

    expect(restored.snapshot?.revision).toBe("cached-revision");
    expect(restored.lastSyncedAt).toBe("2026-10-31T00:00:00.000Z");
  });
});
