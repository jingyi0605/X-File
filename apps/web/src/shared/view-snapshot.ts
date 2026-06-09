const MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;

interface StoredSnapshot<T> {
  value: T;
  updatedAt: number;
}

export function readViewSnapshot<T>(key: string): T | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) {
      return null;
    }

    const snapshot = JSON.parse(raw) as StoredSnapshot<T>;
    if (!snapshot || Date.now() - snapshot.updatedAt > MAX_AGE_MS) {
      return null;
    }

    return snapshot.value;
  } catch {
    return null;
  }
}

export function writeViewSnapshot<T>(key: string, value: T): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(key, JSON.stringify({ value, updatedAt: Date.now() }));
  } catch {
    // 视图缓存失败不应该影响文档库主流程。
  }
}
