import { readNativePreviewResource } from "../../runtime/native-library-bridge";
import { getRuntimeConfigSnapshot } from "../../runtime/runtime-config-store";
import { LIBRARY_PREVIEW_BUDGETS } from "@x-file/shared";

export const DEFAULT_PREVIEW_RESOURCE_MAX_BYTES = LIBRARY_PREVIEW_BUDGETS.resourceMaxBytes;
export const DEFAULT_PREVIEW_RESOURCE_TIMEOUT_MS = 20_000;

const MAX_CACHE_ENTRIES = 6;
const MAX_CACHE_BYTES = 64 * 1024 * 1024;
const CACHE_TTL_MS = 30_000;
const MAX_CONCURRENT_READS = 4;

interface PreviewResourceCacheEntry {
  bytes: Uint8Array;
  lastUsedAt: number;
  expiresAt: number;
}

export interface ReadPreviewResourceOptions {
  path: string;
  previewUrl: string | null;
  maxBytes?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  cacheKey?: string;
  revision?: string | number | null;
}

const resourceCache = new Map<string, PreviewResourceCacheEntry>();
let cachedBytes = 0;
let activeReads = 0;
const readWaiters: Array<{
  signal: AbortSignal;
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  onAbort: () => void;
}> = [];

export async function readPreviewResource(options: ReadPreviewResourceOptions): Promise<Uint8Array> {
  const maxBytes = options.maxBytes ?? DEFAULT_PREVIEW_RESOURCE_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_PREVIEW_RESOURCE_TIMEOUT_MS;
  const cacheKey = options.cacheKey ?? buildPreviewResourceCacheKey(options);
  const cached = cacheKey ? resourceCache.get(cacheKey) : undefined;

  if (cached) {
    if (cached.expiresAt > Date.now()) {
      cached.lastUsedAt = Date.now();
      throwIfAborted(options.signal);
      return cloneBytes(cached.bytes);
    }
    resourceCache.delete(cacheKey!);
    cachedBytes -= cached.bytes.byteLength;
  }

  throwIfAborted(options.signal);
  const timeout = createTimeoutSignal(options.signal, timeoutMs);
  let releaseRead: (() => void) | null = null;

  try {
    releaseRead = await acquireReadSlot(timeout.signal);
    let bytes: Uint8Array | null;
    if (options.previewUrl && !options.previewUrl.startsWith("file://")) {
      bytes = await readHttpPreviewResource(options.previewUrl, maxBytes, timeout.signal);
    } else {
      const nativeRead = await readNativePreviewResourceWithCancellation(options.path, timeout.signal);
      const releaseWhenNativeFinishes = releaseRead;
      releaseRead = null;
      void nativeRead.settled.then(releaseWhenNativeFinishes, releaseWhenNativeFinishes);
      bytes = await nativeRead.result;
    }

    throwIfAborted(options.signal);
    if (bytes === null) throw new Error("resource");
    if (bytes.byteLength > maxBytes) throw new Error("size");

    if (cacheKey) setCachedResource(cacheKey, bytes);
    return cloneBytes(bytes);
  } catch (error) {
    if (isAbortError(error) || timeout.signal.aborted) {
      throw new Error(options.signal?.aborted ? "cancelled" : "timeout");
    }
    throw error;
  } finally {
    releaseRead?.();
    timeout.dispose();
  }
}

export function clearPreviewResourceCache(): void {
  resourceCache.clear();
  cachedBytes = 0;
}

function buildPreviewResourceCacheKey(options: ReadPreviewResourceOptions): string | null {
  const source = options.previewUrl && !options.previewUrl.startsWith("file://")
    ? options.previewUrl
    : "native";
  return `${source}:${options.path}:${options.maxBytes ?? DEFAULT_PREVIEW_RESOURCE_MAX_BYTES}:${options.revision ?? ""}`;
}

function acquireReadSlot(signal: AbortSignal): Promise<() => void> {
  throwIfAborted(signal);
  if (activeReads < MAX_CONCURRENT_READS) {
    activeReads += 1;
    return Promise.resolve(createReadRelease());
  }

  return new Promise((resolve, reject) => {
    const waiter = {
      signal,
      resolve,
      reject,
      onAbort: () => {
        const index = readWaiters.indexOf(waiter);
        if (index >= 0) readWaiters.splice(index, 1);
        reject(new Error("cancelled"));
      },
    };
    signal.addEventListener("abort", waiter.onAbort, { once: true });
    readWaiters.push(waiter);
  });
}

function createReadRelease(): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    while (readWaiters.length) {
      const waiter = readWaiters.shift();
      if (!waiter) break;
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      if (waiter.signal.aborted) {
        waiter.reject(new Error("cancelled"));
        continue;
      }
      waiter.resolve(createReadRelease());
      return;
    }
    activeReads = Math.max(0, activeReads - 1);
  };
}

async function readHttpPreviewResource(
  previewUrl: string,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const response = await fetch(previewUrl, { signal });
  if (!response.ok) throw new Error("resource");

  const declaredSize = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredSize) && declaredSize > maxBytes) {
    throw new Error("size");
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) throw new Error("size");
  return bytes;
}

async function readNativePreviewResourceWithCancellation(
  path: string,
  signal: AbortSignal,
): Promise<{ result: Promise<Uint8Array | null>; settled: Promise<void> }> {
  if (getRuntimeConfigSnapshot().config.mode !== "local") {
    throw new Error("resource");
  }

  const readPromise = readNativePreviewResource(path);
  const result = new Promise<Uint8Array | null>((resolve, reject) => {
    const onAbort = () => reject(new DOMException("Preview resource read was cancelled.", "AbortError"));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    readPromise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
  const settled = readPromise.then(() => undefined, () => undefined);
  return { result, settled };
}

function createTimeoutSignal(parentSignal: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  parentSignal?.addEventListener("abort", onAbort, { once: true });

  return {
    signal: controller.signal,
    dispose: () => {
      window.clearTimeout(timeoutId);
      parentSignal?.removeEventListener("abort", onAbort);
    },
  };
}

function setCachedResource(key: string, bytes: Uint8Array): void {
  const existing = resourceCache.get(key);
  if (existing) cachedBytes -= existing.bytes.byteLength;
  const now = Date.now();
  resourceCache.set(key, { bytes: cloneBytes(bytes), lastUsedAt: now, expiresAt: now + CACHE_TTL_MS });
  cachedBytes += bytes.byteLength;

  while (resourceCache.size > MAX_CACHE_ENTRIES || cachedBytes > MAX_CACHE_BYTES) {
    const oldestKey = [...resourceCache.entries()]
      .sort(([, left], [, right]) => left.lastUsedAt - right.lastUsedAt)[0]?.[0];
    if (!oldestKey) break;
    const removed = resourceCache.get(oldestKey);
    if (removed) cachedBytes -= removed.bytes.byteLength;
    resourceCache.delete(oldestKey);
  }
}

function cloneBytes(bytes: Uint8Array): Uint8Array {
  return bytes.slice();
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("cancelled");
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError"
    || error instanceof Error && error.name === "AbortError";
}
