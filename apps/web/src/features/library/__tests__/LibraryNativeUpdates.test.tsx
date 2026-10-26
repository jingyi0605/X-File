import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createDocumentList,
  createFileList,
  createLibrarySnapshot,
  installLibraryApiMock,
  resetLibraryApiMock,
} from "./mockLibraryApi";

installLibraryApiMock();

const native = vi.hoisted(() => ({
  snapshot: vi.fn(),
  documents: vi.fn(),
  files: vi.fn(),
  listen: vi.fn(),
  stop: vi.fn(),
}));

vi.mock("../../../runtime/native-library-bridge", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../runtime/native-library-bridge")>(),
  fetchNativeLibrarySnapshot: native.snapshot,
  listNativeLibraryDocuments: native.documents,
  listNativeLibraryFiles: native.files,
  listenNativeLibraryUpdates: native.listen,
  startNativeLibraryWatcher: vi.fn().mockResolvedValue({ active: true }),
}));
vi.mock("../../../runtime/runtime-config-store", () => ({
  getRuntimeConfigSnapshot: () => ({ config: { mode: "local" } }),
}));

beforeEach(() => {
  localStorage.clear();
  resetLibraryApiMock();
  vi.clearAllMocks();
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
  native.snapshot.mockResolvedValue({ snapshot: createLibrarySnapshot() });
  native.documents.mockResolvedValue(createDocumentList());
  native.files.mockResolvedValue(createFileList());
  native.listen.mockResolvedValue(native.stop);
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

it("空闲页面在原生任务完成后同步列表和计数，并取消事件订阅", async () => {
  const { useLibraryState } = await import("../useLibraryState");
  const { result, unmount } = renderHook(() => useLibraryState());
  await waitFor(() => expect(native.listen).toHaveBeenCalled());
  await waitFor(() => expect(native.documents).toHaveBeenCalled());
  const previousCalls = native.documents.mock.calls.length;
  const snapshot = createLibrarySnapshot({ documentCount: 101 });
  native.snapshot.mockResolvedValue({ snapshot });
  const update = native.listen.mock.calls.at(-1)![0] as (root: string) => void;
  await act(async () => update(snapshot.binding!.rootDir));
  await waitFor(() => expect(result.current.snapshot?.documentCount).toBe(101));
  await waitFor(() => expect(native.documents.mock.calls.length).toBeGreaterThan(previousCalls));
  expect(result.current.refreshPending).toBe(false);
  unmount();
  expect(native.stop).toHaveBeenCalled();
});

it("忽略其他资料库的事件", async () => {
  const { useLibraryState } = await import("../useLibraryState");
  const { unmount } = renderHook(() => useLibraryState());
  await waitFor(() => expect(native.listen).toHaveBeenCalled());
  const previousCalls = native.snapshot.mock.calls.length;
  const update = native.listen.mock.calls.at(-1)![0] as (root: string) => void;
  await act(async () => update("/another-library"));
  expect(native.snapshot).toHaveBeenCalledTimes(previousCalls);
  unmount();
});
