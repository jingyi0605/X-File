import type { LibraryHealth } from "@x-file/shared";

import { apiRequest } from "./http";
import { fetchNativeLibraryHealth } from "../runtime/native-library-bridge";
import { getRuntimeConfigSnapshot } from "../runtime/runtime-config-store";

export type HealthResponse = LibraryHealth;

export interface HealthFetchResult {
  data: HealthResponse;
  transport: "native" | "http";
  detail: string;
}

export function fetchHealth(signal?: AbortSignal): Promise<HealthResponse> {
  return fetchHealthWithTransport(signal).then((result) => result.data);
}

export async function fetchHealthWithTransport(signal?: AbortSignal): Promise<HealthFetchResult> {
  const isLocalMode = getRuntimeConfigSnapshot().config.mode === "local";
  const native = isLocalMode
    ? await fetchNativeLibraryHealth()
    : null;
  if (native) {
    return {
      data: native,
      transport: "native",
      detail: "health 通过 Tauri invoke 命中 native bridge",
    };
  }

  if (isLocalMode) {
    throw new Error("主包本地模式已移除内建 HTTP sidecar，且缺少 native health bridge。");
  }

  return (async () => {
    const data = await apiRequest<HealthResponse>("/api/health", { signal });
    return {
      data,
      transport: "http",
      detail: isLocalMode
        ? "native health 不可用，已回退 /api/health"
        : "当前不是 local 模式，health 走 HTTP",
    };
  })();
}
