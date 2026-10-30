const SESSION_STORAGE_PREFIX = "x-file.http-auth-session.";

const memorySessions = new Map<string, string>();

export function getHttpAuthSessionToken(apiUrl: string): string | null {
  const scope = resolveSessionScope(apiUrl);
  const inMemory = memorySessions.get(scope);
  if (inMemory) {
    return inMemory;
  }

  if (typeof window === "undefined") {
    return null;
  }

  try {
    const stored = window.sessionStorage.getItem(buildStorageKey(scope));
    if (stored) {
      memorySessions.set(scope, stored);
      return stored;
    }
  } catch {
    // 会话存储不可用时继续使用内存会话。
  }

  return null;
}

export function setHttpAuthSessionToken(apiUrl: string, token: string | null): void {
  const scope = resolveSessionScope(apiUrl);
  if (token) {
    memorySessions.set(scope, token);
  } else {
    memorySessions.delete(scope);
  }

  if (typeof window === "undefined") {
    return;
  }

  try {
    const storageKey = buildStorageKey(scope);
    if (token) {
      window.sessionStorage.setItem(storageKey, token);
    } else {
      window.sessionStorage.removeItem(storageKey);
    }
  } catch {
    // 会话存储不可用时继续使用内存会话。
  }
}

function resolveSessionScope(apiUrl: string): string {
  try {
    return new URL(apiUrl, typeof window === "undefined" ? "http://127.0.0.1" : window.location.href).origin;
  } catch {
    return apiUrl;
  }
}

function buildStorageKey(scope: string): string {
  return `${SESSION_STORAGE_PREFIX}${scope}`;
}
