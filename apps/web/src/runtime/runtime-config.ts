import { getRuntimeConfigSnapshot, type XFileRuntimeConfig } from "./runtime-config-store";

const DEFAULT_API_BASE_URL = "http://127.0.0.1:17321";

export function getActiveApiBaseUrl(): string | null {
  const config = getRuntimeConfigSnapshot().config;
  if (config.mode === "mirror") {
    return normalizeBaseUrl(config.remoteApiBaseUrl) ?? DEFAULT_API_BASE_URL;
  }

  if (typeof window !== "undefined" && /^https?:$/i.test(window.location.protocol)) {
    return null;
  }

  return DEFAULT_API_BASE_URL;
}

export function isRuntimeConfigured(config: XFileRuntimeConfig): boolean {
  if (config.mode === "local") {
    return true;
  }

  return Boolean(normalizeBaseUrl(config.remoteApiBaseUrl));
}

export function normalizeBaseUrl(value: string): string | null {
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

