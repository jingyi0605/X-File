import { useEffect, useState } from "react";

import { fetchHealth, type HealthResponse } from "./api/health";
import { toApiErrorMessage } from "./api/http";
import { LibraryPage } from "./features/library/LibraryPage";
import { SettingsPage } from "./features/settings/SettingsPage";
import { t } from "./i18n";
import "./styles.css";

type AppSection = "library" | "settings" | "health";

type HealthState =
  | { status: "checking" }
  | { status: "online"; data: HealthResponse }
  | { status: "offline"; error: string };

export function App() {
  const [section, setSection] = useState<AppSection>("library");
  const [health, setHealth] = useState<HealthState>({ status: "checking" });

  async function checkHealth() {
    setHealth({ status: "checking" });
    try {
      setHealth({ status: "online", data: await fetchHealth() });
    } catch (error) {
      setHealth({ status: "offline", error: toApiErrorMessage(error) });
    }
  }

  useEffect(() => {
    void checkHealth();
  }, []);

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand-lockup">
          <span className="brand-mark">XF</span>
          <div>
            <strong>{t("appTitle")}</strong>
            <small>{t("appTagline")}</small>
          </div>
        </div>
        <nav className="app-nav" aria-label={t("appTitle")}>
          <button type="button" className={section === "library" ? "active" : ""} onClick={() => setSection("library")}>
            {t("navLibrary")}
          </button>
          <button type="button" className={section === "settings" ? "active" : ""} onClick={() => setSection("settings")}>
            {t("navSettings")}
          </button>
          <button type="button" className={section === "health" ? "active" : ""} onClick={() => setSection("health")}>
            {t("navHealth")}
          </button>
        </nav>
      </header>

      {section === "library" ? <LibraryPage onOpenSettings={() => setSection("settings")} /> : null}
      {section === "settings" ? <SettingsPage /> : null}
      {section === "health" ? <HealthPanel health={health} onRetry={() => void checkHealth()} /> : null}
    </div>
  );
}

function HealthPanel({ health, onRetry }: { health: HealthState; onRetry: () => void }) {
  return (
    <main className="health-page">
      <section className="page-heading">
        <div>
          <p className="eyebrow">{t("navHealth")}</p>
          <h1>{t("healthTitle")}</h1>
          <p className="page-subtitle">{renderHealthDetail(health)}</p>
        </div>
        <button type="button" className="primary-button" onClick={onRetry}>
          {t("healthRetry")}
        </button>
      </section>
      <section className="health-card">
        <span className={health.status === "online" ? "status-dot fresh" : health.status === "offline" ? "status-dot failed" : "status-dot muted"} />
        <strong>{renderHealthTitle(health)}</strong>
        <p>{renderHealthDetail(health)}</p>
      </section>
    </main>
  );
}

function renderHealthTitle(health: HealthState) {
  if (health.status === "online") {
    return t("healthOnline");
  }
  if (health.status === "offline") {
    return t("healthOffline");
  }
  return t("healthChecking");
}

function renderHealthDetail(health: HealthState) {
  if (health.status === "online") {
    return `${health.data.app} ${health.data.version}`;
  }
  if (health.status === "offline") {
    return health.error;
  }
  return t("healthChecking");
}
