import { apiRequest, postJson, resolveApiUrl } from "./http";
import { setHttpAuthSessionToken } from "./http-auth-session";
import { getRuntimeConfigSnapshot } from "../runtime/runtime-config-store";

export interface HttpAuthStatus {
  required: boolean;
  configured: boolean;
  authenticated: boolean;
  username: string | null;
  sessionToken?: string;
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
  return postJson<HttpAuthStatus>("/api/auth/login", { username, password }).then((result) => {
    if (result.sessionToken) {
      setHttpAuthSessionToken(resolveApiUrl("/api/auth/login"), result.sessionToken);
    }
    return result;
  });
}

export async function logoutHttpAuth(): Promise<void> {
  const apiUrl = resolveApiUrl("/api/auth/logout");
  await postJson<void>("/api/auth/logout", {});
  setHttpAuthSessionToken(apiUrl, null);
}
