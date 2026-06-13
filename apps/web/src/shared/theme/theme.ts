import { updatePreferences, getPreferencesSnapshot, usePreferencesSelector, type ThemeId } from "../../preferences/preferences-store";
import { t } from "../../i18n";

export type { ThemeId };

export interface ThemeDefinition {
  id: ThemeId;
  labelKey: string;
  color: string;
}

export const THEMES: ThemeDefinition[] = [
  { id: "light", labelKey: "theme.light", color: "#f6f4ef" },
  { id: "dark", labelKey: "theme.dark", color: "#1b1b1b" },
  { id: "eye-green", labelKey: "theme.eyeGreen", color: "#16a34a" }
];

export function getThemeLabel(theme: ThemeDefinition): string {
  return t(theme.labelKey);
}

function getSystemTheme(): Extract<ThemeId, "light" | "dark"> {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return "light";
  }

  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function resolveTheme(theme: ThemeId, autoTheme: boolean): ThemeId {
  if (!autoTheme) {
    return theme;
  }

  return getSystemTheme();
}

export function getInitialTheme(): ThemeId {
  const { theme, autoTheme } = getPreferencesSnapshot().profile;
  return resolveTheme(theme, autoTheme);
}

export function setTheme(themeId: ThemeId): void {
  void updatePreferences({ theme: themeId, autoTheme: false }).catch(() => undefined);
}

export function setAutoTheme(enabled: boolean): void {
  void updatePreferences({ autoTheme: enabled }).catch(() => undefined);
}

export function applyThemeToDocument(themeId: ThemeId): void {
  if (typeof document === "undefined") {
    return;
  }

  document.documentElement.setAttribute("data-theme", themeId);
  document.body?.setAttribute("data-theme", themeId);
}

export function useTheme(): {
  theme: ThemeId;
  selectedTheme: ThemeId;
  autoTheme: boolean;
  setTheme: (id: ThemeId) => void;
  setAutoTheme: (enabled: boolean) => void;
} {
  const selectedTheme = usePreferencesSelector((state) => state.profile.theme);
  const autoTheme = usePreferencesSelector((state) => state.profile.autoTheme);
  const theme = resolveTheme(selectedTheme, autoTheme);

  return { theme, selectedTheme, autoTheme, setTheme, setAutoTheme };
}

export function initTheme(): void {
  applyThemeToDocument(getInitialTheme());
}
