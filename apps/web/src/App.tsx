import { useEffect, useState } from "react";

import { fetchHealth, type HealthResponse } from "./api/health";
import { toApiErrorMessage } from "./api/http";
import { LibraryPage, type WorkbenchPlatformData } from "./features/library/LibraryPage";
import { SettingsPage } from "./features/settings/SettingsPage";
import { t } from "./i18n";
import "./styles.css";

type AppSection = "library" | "health";

type HealthState =
  | { status: "checking" }
  | { status: "online"; data: HealthResponse }
  | { status: "offline"; error: string };

export function App() {
  const [section, setSection] = useState<AppSection>("library");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [libraryReloadKey, setLibraryReloadKey] = useState(0);
  const [health, setHealth] = useState<HealthState>({ status: "checking" });
  const platformData = useWorkbenchPlatformData();

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

  if (section === "library") {
    return (
      <>
        <LibraryPage
          key={libraryReloadKey}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenHealth={() => setSection("health")}
          platformData={platformData}
        />
        {settingsOpen ? (
          <SettingsPage
            onSaved={() => setLibraryReloadKey((current) => current + 1)}
            onClose={() => setSettingsOpen(false)}
          />
        ) : null}
      </>
    );
  }

  return (
    <div className="app-shell xfile-secondary-shell" data-runtime-platform={platformData.runtimePlatform} data-os-family={platformData.osFamily} data-overlay-titlebar={platformData.overlayTitlebar ? "true" : undefined}>
      <header className="xfile-secondary-header">
        <button type="button" className="affairs-stage-breadcrumb-button root" onClick={() => setSection("library")}>
          ‹
        </button>
        <div>
          <strong>{t("navHealth")}</strong>
          <span>{t("appTitle")}</span>
        </div>
      </header>
      <HealthPanel health={health} onRetry={() => void checkHealth()} />
    </div>
  );
}

function HealthPanel({ health, onRetry }: { health: HealthState; onRetry: () => void }) {
  return (
    <main className="health-page xfile-secondary-page">
      <section className="settings-section">
        <div className="section-header">
          <h2>{t("healthTitle")}</h2>
          <button type="button" className="secondary-button" onClick={onRetry}>
            {t("healthRetry")}
          </button>
        </div>
        <div className="health-card">
          <span className={health.status === "online" ? "affairs-stage-status-dot state-fresh" : health.status === "offline" ? "affairs-stage-status-dot state-failed" : "affairs-stage-status-dot"} />
          <strong>{renderHealthTitle(health)}</strong>
          <p>{renderHealthDetail(health)}</p>
        </div>
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


function useWorkbenchPlatformData(): WorkbenchPlatformData {
  const [platformData, setPlatformData] = useState<WorkbenchPlatformData>(() => resolveWorkbenchPlatformData());

  useEffect(() => {
    const nextPlatformData = resolveWorkbenchPlatformData();
    setPlatformData(nextPlatformData);

    const html = document.documentElement;
    const body = document.body;
    html.dataset.runtimePlatform = nextPlatformData.runtimePlatform;
    body.dataset.runtimePlatform = nextPlatformData.runtimePlatform;
    html.dataset.osFamily = nextPlatformData.osFamily;
    body.dataset.osFamily = nextPlatformData.osFamily;

    if (nextPlatformData.overlayTitlebar) {
      html.dataset.workbenchMacosVibrancy = "true";
      body.dataset.workbenchMacosVibrancy = "true";
      html.dataset.overlayTitlebar = "true";
      body.dataset.overlayTitlebar = "true";
    } else {
      delete html.dataset.workbenchMacosVibrancy;
      delete body.dataset.workbenchMacosVibrancy;
      delete html.dataset.overlayTitlebar;
      delete body.dataset.overlayTitlebar;
    }
  }, []);

  return platformData;
}

function resolveWorkbenchPlatformData(): WorkbenchPlatformData {
  if (typeof navigator === "undefined") {
    return { runtimePlatform: "web", osFamily: "web", overlayTitlebar: false };
  }

  const platform = navigator.platform || "";
  const userAgent = navigator.userAgent || "";
  const isMacOS = /Mac/i.test(platform) || /Mac OS X/i.test(userAgent);
  const isWindows = /Win/i.test(platform) || /Windows/i.test(userAgent);

  return {
    runtimePlatform: typeof window !== "undefined" && "__TAURI_INTERNALS__" in window ? "desktop" : "web",
    osFamily: isMacOS ? "macos" : isWindows ? "windows" : "web",
    overlayTitlebar: isMacOS
  };
}
