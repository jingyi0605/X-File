import type { LibraryHealth } from "@x-file/shared";

import { apiRequest } from "./http";

export type HealthResponse = LibraryHealth;

export function fetchHealth(signal?: AbortSignal): Promise<HealthResponse> {
  return apiRequest<HealthResponse>("/api/health", { signal });
}
