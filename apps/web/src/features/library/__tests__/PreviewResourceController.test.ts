import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearPreviewResourceCache,
  readPreviewResource,
} from "../preview-resource-controller";

const { nativeReadMock } = vi.hoisted(() => ({ nativeReadMock: vi.fn() }));

vi.mock("../../../runtime/native-library-bridge", () => ({
  readNativePreviewResource: nativeReadMock,
}));
vi.mock("../../../runtime/runtime-config-store", () => ({
  getRuntimeConfigSnapshot: () => ({ config: { mode: "local" } }),
}));

describe("preview resource controller", () => {
  beforeEach(() => {
    clearPreviewResourceCache();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("caches HTTP preview bytes and returns isolated copies", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(Uint8Array.from([1, 2, 3]).buffer));

    const first = await readPreviewResource({
      path: "docs/manual.pdf",
      previewUrl: "/preview/manual.pdf",
    });
    first[0] = 99;
    const second = await readPreviewResource({
      path: "docs/manual.pdf",
      previewUrl: "/preview/manual.pdf",
    });

    expect(second).toEqual(Uint8Array.from([1, 2, 3]));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects resources over the declared size budget before reading them", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, {
      status: 200,
      headers: { "content-length": "11" },
    }));

    await expect(readPreviewResource({
      path: "docs/large.pdf",
      previewUrl: "/preview/large.pdf",
      maxBytes: 10,
    })).rejects.toThrow("size");
  });

  it("times out a stalled HTTP request", async () => {
    vi.mocked(fetch).mockImplementation((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));

    await expect(readPreviewResource({
      path: "docs/slow.pdf",
      previewUrl: "/preview/slow.pdf",
      timeoutMs: 10,
    })).rejects.toThrow("timeout");
  });

  it("drops a cancelled result before it reaches the caller", async () => {
    let resolveFetch: (response: Response) => void = () => undefined;
    vi.mocked(fetch).mockImplementation(() => new Promise((resolve) => {
      resolveFetch = resolve;
    }));
    const controller = new AbortController();
    const pending = readPreviewResource({
      path: "docs/slow.pdf",
      previewUrl: "/preview/slow.pdf",
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    controller.abort();
    resolveFetch(new Response(Uint8Array.from([1]).buffer));

    await expect(pending).rejects.toThrow("cancelled");
  });

  it("limits HTTP resource reads to four concurrent requests", async () => {
    let active = 0;
    let maximumActive = 0;
    vi.mocked(fetch).mockImplementation(() => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      return new Promise<Response>((resolve) => {
        window.setTimeout(() => {
          active -= 1;
          resolve(new Response(Uint8Array.from([1]).buffer));
        }, 5);
      });
    });

    const reads = Array.from({ length: 5 }, (_, index) => readPreviewResource({
      path: `docs/${index}.pdf`,
      previewUrl: `/preview/${index}.pdf`,
    }));
    await Promise.all(reads);
    expect(maximumActive).toBe(4);
  });

  it("removes an aborted queued read without consuming a slot", async () => {
    const pendingResponses: Array<(response: Response) => void> = [];
    vi.mocked(fetch).mockImplementation(() => new Promise<Response>((resolve) => {
      pendingResponses.push(resolve);
    }));
    const activeReads = Array.from({ length: 4 }, (_, index) => readPreviewResource({
      path: `docs/${index}.pdf`,
      previewUrl: `/preview/${index}.pdf`,
    }));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(4));

    const controller = new AbortController();
    const queuedRead = readPreviewResource({
      path: "docs/queued.pdf",
      previewUrl: "/preview/queued.pdf",
      signal: controller.signal,
    });
    controller.abort();
    await expect(queuedRead).rejects.toThrow("cancelled");
    expect(fetch).toHaveBeenCalledTimes(4);

    pendingResponses.forEach((resolve) => resolve(new Response(Uint8Array.from([1]).buffer)));
    await Promise.all(activeReads);
  });

  it("keeps a native read slot occupied until the unabortable command settles", async () => {
    const finishNativeReads: Array<(bytes: Uint8Array) => void> = [];
    nativeReadMock.mockImplementation(() => new Promise<Uint8Array>((resolve) => {
      finishNativeReads.push(resolve);
    }));
    const controller = new AbortController();
    const nativeReads = Array.from({ length: 4 }, (_, index) => readPreviewResource({
      path: `docs/native-${index}.pdf`,
      previewUrl: null,
      signal: index === 0 ? controller.signal : undefined,
    }));
    await vi.waitFor(() => expect(nativeReadMock).toHaveBeenCalledTimes(4));
    controller.abort();
    await expect(nativeReads[0]!).rejects.toThrow("cancelled");

    vi.mocked(fetch).mockResolvedValue(new Response(Uint8Array.from([2]).buffer));
    const networkRead = readPreviewResource({ path: "docs/http.pdf", previewUrl: "/preview/http.pdf" });
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(fetch).not.toHaveBeenCalled();

    finishNativeReads[0]?.(Uint8Array.from([1]));
    expect(await networkRead).toEqual(Uint8Array.from([2]));
    expect(fetch).toHaveBeenCalledOnce();
    finishNativeReads.slice(1).forEach((finish) => finish(Uint8Array.from([1])));
    await Promise.all(nativeReads.slice(1));
  });

  it("uses a source revision to avoid serving stale cached bytes", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(Uint8Array.from([1]).buffer))
      .mockResolvedValueOnce(new Response(Uint8Array.from([2]).buffer));

    const first = await readPreviewResource({
      path: "docs/manual.pdf",
      previewUrl: "/preview/manual.pdf",
      revision: "1:old",
    });
    const second = await readPreviewResource({
      path: "docs/manual.pdf",
      previewUrl: "/preview/manual.pdf",
      revision: "2:new",
    });

    expect(first).toEqual(Uint8Array.from([1]));
    expect(second).toEqual(Uint8Array.from([2]));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("expires cached resources after thirty seconds", async () => {
    vi.useFakeTimers();
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(Uint8Array.from([1]).buffer))
      .mockResolvedValueOnce(new Response(Uint8Array.from([2]).buffer));

    const options = { path: "docs/manual.pdf", previewUrl: "/preview/manual.pdf" };
    await readPreviewResource(options);
    vi.advanceTimersByTime(30_001);
    const refreshed = await readPreviewResource(options);

    expect(refreshed).toEqual(Uint8Array.from([2]));
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
