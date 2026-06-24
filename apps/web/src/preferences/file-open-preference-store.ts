import { useSyncExternalStore } from "react";

export type FileOpenMode = "preview" | "local_app";

export interface FileOpenPreferenceItem {
  extension: string;
  mode: FileOpenMode;
}

interface FileOpenPreferenceState {
  items: FileOpenPreferenceItem[];
}

const STORAGE_KEY = "x-file.preferences.file-open";

let state: FileOpenPreferenceState = {
  items: readStoredItems(),
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

function getSnapshot(): FileOpenPreferenceState {
  return state;
}

function normalizeExtension(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return "";
  }
  const withDot = normalized.startsWith(".") ? normalized : `.${normalized}`;
  return /^\.[a-z0-9]+(?:[._-][a-z0-9]+)*$/i.test(withDot) ? withDot : "";
}

function normalizeMode(value: unknown): FileOpenMode {
  return value === "local_app" ? "local_app" : "preview";
}

function normalizeItems(input: unknown): FileOpenPreferenceItem[] {
  if (!Array.isArray(input)) {
    return [];
  }
  const deduped = new Map<string, FileOpenPreferenceItem>();
  for (const item of input) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const rawExtension = "extension" in item ? (item as { extension?: unknown }).extension : "";
    const extension = typeof rawExtension === "string" ? normalizeExtension(rawExtension) : "";
    if (!extension) {
      continue;
    }
    const rawMode = "mode" in item ? (item as { mode?: unknown }).mode : "preview";
    deduped.set(extension, {
      extension,
      mode: normalizeMode(rawMode),
    });
  }
  return Array.from(deduped.values()).sort((left, right) => left.extension.localeCompare(right.extension, "zh-Hans-CN"));
}

function readStoredItems(): FileOpenPreferenceItem[] {
  if (typeof window === "undefined") {
    return [];
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return [];
    }
    return normalizeItems(JSON.parse(raw));
  } catch {
    return [];
  }
}

function persistItems(items: FileOpenPreferenceItem[]): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch {
    // 桌面端打开偏好持久化失败时，不阻断主流程。
  }
}

export function initializeFileOpenPreferences(): void {
  state = {
    items: readStoredItems(),
  };
  emit();
}

export function getFileOpenPreferenceItems(): FileOpenPreferenceItem[] {
  return state.items;
}

export function getFileOpenModeForPath(path: string): FileOpenMode | null {
  const extension = normalizeExtension(path.split("/").pop()?.match(/(\.[^./\\]+)$/)?.[1] ?? "");
  if (!extension) {
    return null;
  }
  return state.items.find((item) => item.extension === extension)?.mode ?? null;
}

export async function saveFileOpenPreferenceItems(items: FileOpenPreferenceItem[]): Promise<FileOpenPreferenceItem[]> {
  const normalized = normalizeItems(items);
  state = {
    items: normalized,
  };
  persistItems(normalized);
  emit();
  return normalized;
}

export function useFileOpenPreferenceSelector<T>(selector: (state: FileOpenPreferenceState) => T): T {
  return useSyncExternalStore(subscribe, () => selector(getSnapshot()), () => selector(getSnapshot()));
}
