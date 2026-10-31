import { t } from "../i18n";
import { getActiveApiBaseUrl } from "../runtime/runtime-config";
import { getRuntimeConfigSnapshot } from "../runtime/runtime-config-store";
import { getHttpAuthSessionToken } from "./http-auth-session";

export class ApiClientError extends Error {
  readonly status: number;
  readonly path: string;
  readonly detail: string;

  constructor(path: string, status: number, detail: string) {
    super(detail);
    this.name = "ApiClientError";
    this.path = path;
    this.status = status;
    this.detail = detail;
  }
}

export interface ApiDownloadProgress {
  loadedBytes: number;
  totalBytes: number | null;
}

export interface ApiRequestOptions extends RequestInit {
  onDownloadProgress?: (progress: ApiDownloadProgress) => void;
}

export async function apiRequest<T>(
  path: string,
  options: ApiRequestOptions = {}
): Promise<T> {
  let response: Response;
  const apiUrl = resolveApiUrl(path);
  const sessionToken = getHttpAuthSessionToken(apiUrl);
  const { onDownloadProgress, ...requestOptions } = options;

  try {
    response = await fetch(apiUrl, {
      ...requestOptions,
      credentials: sessionToken ? "omit" : "include",
      headers: {
        ...(sessionToken ? { "x-file-session": sessionToken } : {}),
        ...(requestOptions.body ? { "content-type": "application/json" } : {}),
        ...requestOptions.headers
      }
    });
  } catch (error) {
    if (shouldUseMirrorDevLocalApi(apiUrl)) {
      try {
        response = await fetchMirrorDevLocalApi(path, requestOptions);
      } catch {
        throw new ApiClientError(path, 0, error instanceof Error ? error.message : t("apiNetworkFailed"));
      }
    } else {
      throw new ApiClientError(path, 0, error instanceof Error ? error.message : t("apiNetworkFailed"));
    }
  }

  if (!response.ok) {
    if (response.status === 401 && shouldUseMirrorDevLocalApi(apiUrl)) {
      try {
        response = await fetchMirrorDevLocalApi(path, requestOptions);
      } catch {
        // 保留原始远端 401，避免开发态回退失败时隐藏真正的认证问题。
      }
    }
  }

  if (!response.ok) {
    throw new ApiClientError(path, response.status, await resolveErrorDetail(response, path));
  }

  if (response.status === 204) {
    return undefined as T;
  }

  if (onDownloadProgress && response.body) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const textChunks: string[] = [];
    const contentLength = Number(response.headers.get("content-length"));
    const totalBytes = Number.isFinite(contentLength) && contentLength > 0 ? contentLength : null;
    let loadedBytes = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      textChunks.push(decoder.decode(value, { stream: true }));
      loadedBytes += value.byteLength;
      onDownloadProgress({ loadedBytes, totalBytes });
    }

    textChunks.push(decoder.decode());
    return JSON.parse(textChunks.join("")) as T;
  }

  return response.json() as Promise<T>;
}

export function toApiErrorMessage(error: unknown): string {
  if (error instanceof ApiClientError) {
    if (error.status === 404) {
      return t("apiNotAvailable", { path: error.path });
    }
    return error.detail;
  }

  return error instanceof Error ? error.message : String(error);
}

export function resolveApiUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) {
    return path;
  }

  const explicitBase = import.meta.env.VITE_X_FILE_API_BASE_URL;
  if (typeof explicitBase === "string" && explicitBase.trim()) {
    return new URL(path, explicitBase.trim()).toString();
  }

  const runtimeBase = getActiveApiBaseUrl();
  if (!runtimeBase) {
    return path;
  }

  return new URL(path, runtimeBase).toString();
}

function shouldUseMirrorDevLocalApi(apiUrl: string): boolean {
  if (!import.meta.env.DEV || getRuntimeConfigSnapshot().config.mode !== "mirror") {
    return false;
  }

  try {
    const remote = new URL(apiUrl);
    const page = new URL(window.location.href);
    return (
      remote.hostname !== "127.0.0.1"
      && remote.hostname !== "localhost"
      && (
        page.port === "17322"
        || page.hostname === "tauri.localhost"
        || page.protocol === "tauri:"
      )
    );
  } catch {
    return false;
  }
}

async function fetchMirrorDevLocalApi(
  path: string,
  options: RequestInit,
): Promise<Response> {
  const apiUrl = `http://127.0.0.1:17321${path}`;
  const sessionToken = getHttpAuthSessionToken(apiUrl);
  return fetch(apiUrl, {
    ...options,
    credentials: sessionToken ? "omit" : "include",
    headers: {
      ...(sessionToken ? { "x-file-session": sessionToken } : {}),
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...options.headers,
    },
  });
}

function jsonBody(value: unknown): BodyInit {
  return JSON.stringify(value);
}

export function putJson<T>(path: string, body: unknown): Promise<T> {
  return apiRequest<T>(path, { method: "PUT", body: jsonBody(body) });
}

export function postJson<T>(path: string, body: unknown): Promise<T> {
  return apiRequest<T>(path, { method: "POST", body: jsonBody(body) });
}

async function resolveErrorDetail(response: Response, path: string): Promise<string> {
  try {
    const payload = await response.json() as { detail?: unknown; message?: unknown };
    const detail = typeof payload.detail === "string" ? payload.detail : payload.message;
    if (typeof detail === "string" && detail.trim()) {
      return detail;
    }
  } catch {
    // 非 JSON 错误响应继续走通用文案。
  }

  return t("apiRequestFailed", { status: response.status || path });
}
