import type {
  LibraryMirrorMutation,
  LibraryMirrorMutationResult,
  LibraryMirrorSnapshot,
} from "@x-file/shared";

export type MirrorCacheSource = "primary" | "cache" | "empty";

export interface MirrorCacheState {
  snapshot: LibraryMirrorSnapshot | null;
  pendingMutations: LibraryMirrorMutation[];
  syncResults: LibraryMirrorMutationResult[];
  source: MirrorCacheSource;
  lastSyncedAt: string | null;
  lastError: string | null;
}

const DB_NAME = "x-file-mirror";
const DB_VERSION = 1;
const STORE_NAME = "states";
const MEMORY_CACHE = new Map<string, MirrorCacheState>();
const listeners = new Set<() => void>();

export function subscribeMirrorCache(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getMirrorCacheKey(baseUrl: string): string {
  return `x-file.mirror.${baseUrl}`;
}

export async function loadMirrorCache(baseUrl: string): Promise<MirrorCacheState> {
  const key = getMirrorCacheKey(baseUrl);
  const cached = MEMORY_CACHE.get(key);
  if (cached) {
    return cloneState(cached);
  }

  const stored = await readIndexedDb(key).catch(() => null)
    ?? readLocalStorage(key);
  const state = normalizeState(stored);
  MEMORY_CACHE.set(key, state);
  return cloneState(state);
}

export async function saveMirrorCache(
  baseUrl: string,
  state: MirrorCacheState,
): Promise<MirrorCacheState> {
  const key = getMirrorCacheKey(baseUrl);
  const normalized = normalizeState(state);
  MEMORY_CACHE.set(key, normalized);
  await writeIndexedDb(key, normalized).catch(() => {
    writeLocalStorage(key, normalized);
  });
  emit();
  return cloneState(normalized);
}

export async function updateMirrorCache(
  baseUrl: string,
  update: (state: MirrorCacheState) => MirrorCacheState,
): Promise<MirrorCacheState> {
  const current = await loadMirrorCache(baseUrl);
  return saveMirrorCache(baseUrl, update(current));
}

function normalizeState(value: unknown): MirrorCacheState {
  if (!value || typeof value !== "object") {
    return emptyState();
  }
  const input = value as Partial<MirrorCacheState>;
  return {
    snapshot: input.snapshot ?? null,
    pendingMutations: Array.isArray(input.pendingMutations) ? input.pendingMutations : [],
    syncResults: Array.isArray(input.syncResults) ? input.syncResults : [],
    source: input.source === "primary" || input.source === "cache" ? input.source : "empty",
    lastSyncedAt: typeof input.lastSyncedAt === "string" ? input.lastSyncedAt : null,
    lastError: typeof input.lastError === "string" ? input.lastError : null,
  };
}

function emptyState(): MirrorCacheState {
  return {
    snapshot: null,
    pendingMutations: [],
    syncResults: [],
    source: "empty",
    lastSyncedAt: null,
    lastError: null,
  };
}

function cloneState(state: MirrorCacheState): MirrorCacheState {
  return {
    ...state,
    pendingMutations: state.pendingMutations.map((mutation) => ({
      ...mutation,
      payload: cloneValue(mutation.payload),
    })),
  };
}

function cloneValue<T>(value: T): T {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

function readLocalStorage(key: string): unknown {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeLocalStorage(key: string, value: MirrorCacheState): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 浏览器存储不可用时，内存缓存仍可支撑当前页面生命周期。
  }
}

async function readIndexedDb(key: string): Promise<unknown | null> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = database.transaction(STORE_NAME, "readonly")
      .objectStore(STORE_NAME)
      .get(key);
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB read failed"));
  });
}

async function writeIndexedDb(key: string, value: MirrorCacheState): Promise<void> {
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(value, key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB write failed"));
  });
}

function openDatabase(): Promise<IDBDatabase> {
  if (typeof window === "undefined" || !("indexedDB" in window)) {
    return Promise.reject(new Error("IndexedDB unavailable"));
  }
  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
  });
}
