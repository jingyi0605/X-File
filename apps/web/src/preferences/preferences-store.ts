import { useSyncExternalStore } from "react";

export type AppLanguage = "zh-CN" | "en-US";
export type ThemeId = "light" | "dark" | "eye-green";

export interface AccountPreferencesProfile {
  language: AppLanguage;
  theme: ThemeId;
  autoTheme: boolean;
  updatedAt: string;
}

export type AccountPreferencesPatch = Partial<Pick<AccountPreferencesProfile, "language" | "theme" | "autoTheme">>;

interface PreferencesState {
  profile: AccountPreferencesProfile;
  isFetching: boolean;
  error: Error | null;
}

const STORAGE_KEY = "x-file.preferences.profile";
const DEFAULT_PROFILE: AccountPreferencesProfile = {
  language: "zh-CN",
  theme: "light",
  autoTheme: false,
  updatedAt: new Date(0).toISOString()
};

let state: PreferencesState = {
  profile: readStoredProfile(),
  isFetching: false,
  error: null
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

function getSnapshot(): PreferencesState {
  return state;
}

function readStoredProfile(): AccountPreferencesProfile {
  if (typeof window === "undefined") {
    return DEFAULT_PROFILE;
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return DEFAULT_PROFILE;
    }
    const parsed = JSON.parse(raw) as Partial<AccountPreferencesProfile>;
    return normalizeProfile(parsed);
  } catch {
    return DEFAULT_PROFILE;
  }
}

function normalizeProfile(value: Partial<AccountPreferencesProfile>): AccountPreferencesProfile {
  return {
    language: value.language === "en-US" ? "en-US" : "zh-CN",
    theme: isThemeId(value.theme) ? value.theme : DEFAULT_PROFILE.theme,
    autoTheme: typeof value.autoTheme === "boolean" ? value.autoTheme : DEFAULT_PROFILE.autoTheme,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : DEFAULT_PROFILE.updatedAt
  };
}

function isThemeId(value: unknown): value is ThemeId {
  return value === "light" || value === "dark" || value === "eye-green";
}

function persistProfile(profile: AccountPreferencesProfile): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(profile));
  } catch {
    // 本地偏好持久化失败不应该阻断界面切换。
  }
}

export function initializePreferences(): void {
  state = {
    ...state,
    profile: readStoredProfile(),
    isFetching: false,
    error: null
  };
  emit();
}

export async function updatePreferences(patch: AccountPreferencesPatch): Promise<AccountPreferencesProfile> {
  const nextProfile = normalizeProfile({
    ...state.profile,
    ...patch,
    updatedAt: new Date().toISOString()
  });
  state = {
    ...state,
    profile: nextProfile,
    error: null
  };
  persistProfile(nextProfile);
  emit();
  return nextProfile;
}

export function getPreferencesSnapshot(): PreferencesState {
  return state;
}

export function usePreferencesSelector<T>(selector: (state: PreferencesState) => T): T {
  return useSyncExternalStore(subscribe, () => selector(getSnapshot()), () => selector(getSnapshot()));
}
