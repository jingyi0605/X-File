import type { CSSProperties } from "react";

import { t } from "../../i18n";
import { THEMES, getThemeLabel, useTheme, type ThemeId } from "./theme";

export function ThemeSwitcher() {
  const { theme, selectedTheme, autoTheme, setTheme, setAutoTheme } = useTheme();

  function handleChange(newTheme: ThemeId): void {
    setTheme(newTheme);
  }

  return (
    <div className="theme-switcher">
      <div className="settings-current">
        <span>{t("theme.switchLabel")}</span>
        <strong>{autoTheme ? t("theme.auto") : t(`theme.${selectedTheme}`)}</strong>
      </div>
      <div className="theme-switcher-options" role="group" aria-label={t("theme.switchLabel")}>
        {THEMES.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`theme-option ${theme === item.id && !autoTheme ? "active" : ""}`}
            onClick={() => handleChange(item.id)}
            title={getThemeLabel(item)}
            aria-label={getThemeLabel(item)}
            aria-pressed={theme === item.id && !autoTheme}
            style={{ "--theme-color": item.color } as CSSProperties}
          >
            <span className="theme-option-dot" />
            <span className="theme-option-label">{getThemeLabel(item)}</span>
          </button>
        ))}
      </div>
      <label className="switch-row theme-auto-row">
        <span>{t("theme.auto")}</span>
        <input type="checkbox" checked={autoTheme} onChange={(event) => setAutoTheme(event.target.checked)} />
      </label>
      <p className="settings-helper-text">{t("theme.autoDescription")}</p>
    </div>
  );
}
