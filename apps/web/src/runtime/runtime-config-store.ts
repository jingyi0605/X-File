import { useSyncExternalStore } from "react";

export type XFileRuntimeMode = "local" | "mirror";

export interface XFileRuntimeConfig {
  mode: XFileRuntimeMode;
  remoteApiBaseUrl: string;
  localRootDir: string;
  updatedAt: string;
}

export type XFileRuntimeConfigPatch = Partial<Pick<XFileRuntimeConfig, "mode" | "remoteApiBaseUrl" | "localRootDir">>;

interface RuntimeConfigState {
  config: XFileRuntimeConfig;
}

const STORAGE_KEY = "x-file.runtime.config";
const DEFAULT_REMOTE_API_BASE_URL = "http://127.0.0.1:17321";
const DEFAULT_CONFIG: XFileRuntimeConfig = {
  mode: "local",
  remoteApiBaseUrl: DEFAULT_REMOTE_API_BASE_URL,
  localRootDir: "",
  updatedAt: new Date(0).toISOString()
};

let state: RuntimeConfigState = {
  config: readStoredConfig()
};

const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): RuntimeConfigState {
  return state;
}

function readStoredConfig(): XFileRuntimeConfig {
  if (typeof window === "undefined") {
    return DEFAULT_CONFIG;
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return DEFAULT_CONFIG;
    }
    return normalizeConfig(JSON.parse(raw) as Partial<XFileRuntimeConfig>);
  } catch {
    return DEFAULT_CONFIG;
  }
}

function persistConfig(config: XFileRuntimeConfig): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {
    // 本地运行时配置持久化失败时，不阻断界面继续使用内存态。
  }
}

function normalizeConfig(value: Partial<XFileRuntimeConfig>): XFileRuntimeConfig {
  const remoteApiBaseUrl = normalizeOptionalUrl(value.remoteApiBaseUrl) ?? DEFAULT_REMOTE_API_BASE_URL;
  const localRootDir = typeof value.localRootDir === "string" ? value.localRootDir.trim() : "";
  return {
    mode: value.mode === "mirror" ? "mirror" : "local",
    remoteApiBaseUrl,
    localRootDir,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : DEFAULT_CONFIG.updatedAt
  };
}

function normalizeOptionalUrl(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  if (!normalized) {
    return null;
  }
  try {
    return new URL(normalized).toString().replace(/\/+$/g, "");
  } catch {
    return null;
  }
}

export function initializeRuntimeConfig(): void {
  state = {
    config: readStoredConfig()
  };
  emit();
}

export async function updateRuntimeConfig(patch: XFileRuntimeConfigPatch): Promise<XFileRuntimeConfig> {
  const nextConfig = normalizeConfig({
    ...state.config,
    ...patch,
    updatedAt: new Date().toISOString()
  });
  state = {
    config: nextConfig
  };
  persistConfig(nextConfig);
  emit();
  return nextConfig;
}

export function getRuntimeConfigSnapshot(): RuntimeConfigState {
  return state;
}

export function useRuntimeConfigSelector<T>(selector: (state: RuntimeConfigState) => T): T {
  return useSyncExternalStore(subscribe, () => selector(getSnapshot()), () => selector(getSnapshot()));
}

