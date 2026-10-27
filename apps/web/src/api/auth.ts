import { apiRequest, postJson } from "./http";
import { getRuntimeConfigSnapshot } from "../runtime/runtime-config-store";

export interface HttpAuthStatus {
  required: boolean;
  configured: boolean;
  authenticated: boolean;
  username: string | null;
}

export function getHttpAuthStatus(): Promise<HttpAuthStatus> {
  if (
    getRuntimeConfigSnapshot().config.mode === "local"
    && typeof window !== "undefined"
    && "__TAURI_INTERNALS__" in window
  ) {
    return Promise.resolve({
      required: false,
      configured: false,
      authenticated: true,
      username: null
    });
  }
  return apiRequest<HttpAuthStatus>("/api/auth/status");
}

export function loginHttpAuth(username: string, password: string): Promise<HttpAuthStatus> {
  return postJson<HttpAuthStatus>("/api/auth/login", { username, password });
}

export function logoutHttpAuth(): Promise<void> {
  return postJson<void>("/api/auth/logout", {});
}
