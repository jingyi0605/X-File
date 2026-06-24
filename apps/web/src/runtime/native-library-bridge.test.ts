import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

describe("native-library-bridge 契约", () => {
  const invokeMock = vi.fn();
  const originalWindow = globalThis.window;

  beforeEach(() => {
    invokeMock.mockReset();
    vi.resetModules();
  });

  afterEach(() => {
    if (originalWindow === undefined) {
      Reflect.deleteProperty(globalThis, "window");
    } else {
      Object.defineProperty(globalThis, "window", {
        value: originalWindow,
        configurable: true,
        writable: true,
      });
    }
  });

  it("桌面命令缺失时返回 null，不把 bridge 调用炸穿", async () => {
    Object.defineProperty(globalThis, "window", {
      value: { __TAURI_INTERNALS__: {} },
      configurable: true,
      writable: true,
    });
    vi.doMock("@tauri-apps/api/core", () => ({
      invoke: invokeMock.mockRejectedValue(new Error("Command native_get_library_snapshot not found")),
    }));

    const bridge = await import("./native-library-bridge");
    await expect(bridge.fetchNativeLibrarySnapshot()).resolves.toBeNull();
    await expect(bridge.fetchNativeLibraryHealth()).resolves.toBeNull();
  });

  it("非桌面环境返回 unavailable=false 语义，不尝试调用 Tauri", async () => {
    Reflect.deleteProperty(globalThis, "window");
    const bridge = await import("./native-library-bridge");

    await expect(bridge.fetchNativeLibrarySnapshot()).resolves.toBeNull();
    await expect(bridge.getNativeLibraryTagRecomputeTaskOptional()).resolves.toEqual({
      available: false,
      value: null,
    });
  });

  it("tag recompute optional 接口继续返回 available + value 双字段", async () => {
    Object.defineProperty(globalThis, "window", {
      value: { __TAURI_INTERNALS__: {} },
      configurable: true,
      writable: true,
    });
    vi.doMock("@tauri-apps/api/core", () => ({
      invoke: invokeMock.mockResolvedValue({
        taskId: "task-1",
        taskType: "tag_recompute",
        key: "default",
        state: "queued",
        source: "native",
        queuedAt: "2026-06-18T10:00:00.000Z",
        startedAt: null,
        completedAt: null,
        failedAt: null,
        errorSummary: null,
        runningStage: null,
      }),
    }));

    const bridge = await import("./native-library-bridge");
    await expect(bridge.getNativeLibraryTagRecomputeTaskOptional()).resolves.toEqual({
      available: true,
      value: {
        taskId: "task-1",
        taskType: "tag_recompute",
        key: "default",
        state: "queued",
        source: "native",
        queuedAt: "2026-06-18T10:00:00.000Z",
        startedAt: null,
        completedAt: null,
        failedAt: null,
        errorSummary: null,
        runningStage: null,
      },
    });
  });

  it("native snapshot/refresh 缺少 dirtyReasons 时，前端主链仍拿到稳定数组", async () => {
    Object.defineProperty(globalThis, "window", {
      value: { __TAURI_INTERNALS__: {}, localStorage: { getItem: () => null, setItem: () => undefined } },
      configurable: true,
      writable: true,
    });
    vi.doMock("@tauri-apps/api/core", () => ({
      invoke: invokeMock.mockImplementation((command: string) => {
        if (command === "native_get_library_snapshot") {
          return Promise.resolve({
            watcher: {
              active: true,
              rootDir: "/tmp/demo",
              startedAt: null,
              lastEventAt: null,
              lastRefreshRequestedAt: null,
              lastRefreshReason: null,
              lastError: null,
            },
            snapshot: {
              binding: null,
              defaultRootDir: "/tmp/demo",
              requiresInitialization: false,
              initializationRedirectPath: "/init",
              status: {
                state: "fresh",
              },
              tags: [],
              favorites: [],
              folders: [],
              documentCount: 0,
              lastError: null,
            },
          });
        }
        if (command === "native_request_library_refresh") {
          return Promise.resolve({
            watcher: {
              active: true,
              rootDir: "/tmp/demo",
              startedAt: null,
              lastEventAt: null,
              lastRefreshRequestedAt: null,
              lastRefreshReason: null,
              lastError: null,
            },
            backendResponse: {
              accepted: true,
              scheduled: true,
              status: {
                state: "running",
              },
            },
          });
        }
        throw new Error(`unexpected command: ${command}`);
      }),
    }));

    const api = await import("../api/library");
    await expect(api.getLibrarySnapshot()).resolves.toMatchObject({
      status: {
        state: "fresh",
        dirtyReasons: [],
      },
    });
    await expect(api.requestLibraryRefresh({ reason: "manual_refresh" })).resolves.toMatchObject({
      status: {
        state: "running",
        dirtyReasons: [],
      },
    });
  });
});
