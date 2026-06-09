import { t } from "../i18n";

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

const DEFAULT_API_BASE_URL = "http://127.0.0.1:17321";

export async function apiRequest<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  let response: Response;

  try {
    response = await fetch(resolveApiUrl(path), {
      ...options,
      headers: {
        ...(options.body ? { "content-type": "application/json" } : {}),
        ...options.headers
      }
    });
  } catch (error) {
    throw new ApiClientError(path, 0, error instanceof Error ? error.message : t("apiNetworkFailed"));
  }

  if (!response.ok) {
    throw new ApiClientError(path, response.status, await resolveErrorDetail(response, path));
  }

  if (response.status === 204) {
    return undefined as T;
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

function resolveApiUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) {
    return path;
  }

  const explicitBase = import.meta.env.VITE_X_FILE_API_BASE_URL;
  if (typeof explicitBase === "string" && explicitBase.trim()) {
    return new URL(path, explicitBase.trim()).toString();
  }

  if (typeof window !== "undefined" && /^https?:$/i.test(window.location.protocol)) {
    return path;
  }

  if (import.meta.env.DEV) {
    return new URL(path, DEFAULT_API_BASE_URL).toString();
  }

  return new URL(path, DEFAULT_API_BASE_URL).toString();
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
