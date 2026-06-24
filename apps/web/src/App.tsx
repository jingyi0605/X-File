import { useEffect, useState } from "react";

import { fetchHealthWithTransport, type HealthResponse } from "./api/health";
import { toApiErrorMessage } from "./api/http";
import { LibraryPage, type WorkbenchPlatformData } from "./features/library/LibraryPage";
import { SettingsPage } from "./features/settings/SettingsPage";
import { t } from "./i18n";
import { usePreferencesSelector } from "./preferences/preferences-store";
import {
  getNativeDesktopRuntimeInfo,
  type NativeMacOsTitlebarMetrics,
} from "./runtime/native-library-bridge";
import { isRuntimeConfigured } from "./runtime/runtime-config";
import { useRuntimeConfigSelector } from "./runtime/runtime-config-store";
import { formatDateTime } from "./shared/format";
import "./styles.css";

type AppSection = "library" | "health";

type HealthState =
  | { status: "checking" }
  | { status: "online"; data: HealthResponse }
  | { status: "offline"; error: string };

interface DevHealthDebugState {
  transport: "native" | "http" | "idle";
  detail: string;
  updatedAt: string | null;
}

export function App() {
  const [section, setSection] = useState<AppSection>("library");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [libraryReloadKey, setLibraryReloadKey] = useState(0);
  const [health, setHealth] = useState<HealthState>({ status: "checking" });
  const [healthDebug, setHealthDebug] = useState<DevHealthDebugState>({
    transport: "idle",
    detail: "尚未检查 health",
    updatedAt: null,
  });
  const platformData = useWorkbenchPlatformData();
  usePreferencesSelector((state) => state.profile.language);
  const runtimeConfig = useRuntimeConfigSelector((state) => state.config);

  async function checkHealth() {
    setHealth({ status: "checking" });
    try {
      const result = await fetchHealthWithTransport();
      setHealth({ status: "online", data: result.data });
      setHealthDebug({
        transport: result.transport,
        detail: result.detail,
        updatedAt: new Date().toISOString(),
      });
    } catch (error) {
      setHealth({ status: "offline", error: toApiErrorMessage(error) });
      setHealthDebug({
        transport: "http",
        detail: `health 检查失败: ${toApiErrorMessage(error)}`,
        updatedAt: new Date().toISOString(),
      });
    }
  }

  useEffect(() => {
    if (!isRuntimeConfigured(runtimeConfig)) {
      setHealth({ status: "offline", error: t("runtimeMirrorApiRequired") });
      setHealthDebug({
        transport: "idle",
        detail: "mirror 模式缺少可用 API 地址，health 检查未发出",
        updatedAt: new Date().toISOString(),
      });
      return;
    }
    void checkHealth();
  }, [runtimeConfig.mode, runtimeConfig.remoteApiBaseUrl]);

  if (section === "library") {
    return (
      <>
        <LibraryPage
          key={libraryReloadKey}
          onOpenSettings={() => setSettingsOpen(true)}
          platformData={platformData}
          runtimeConfig={runtimeConfig}
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
    <div className="app-shell xfile-secondary-shell" data-runtime-platform={platformData.runtimePlatform} data-os-family={platformData.osFamily}>
      <header className="xfile-secondary-header">
        <button type="button" className="affairs-stage-breadcrumb-button root" onClick={() => setSection("library")}>
          ‹
        </button>
        <div>
          <strong>{t("navHealth")}</strong>
          <span>{t("appTitle")}</span>
        </div>
      </header>
      <HealthPanel health={health} healthDebug={healthDebug} onRetry={() => void checkHealth()} />
    </div>
  );
}

function HealthPanel({
  health,
  healthDebug,
  onRetry,
}: {
  health: HealthState;
  healthDebug: DevHealthDebugState;
  onRetry: () => void;
}) {
  const [debugPanelOpen, setDebugPanelOpen] = useState(false);
  const [copied, setCopied] = useState(false);

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
        {import.meta.env.DEV ? (
          debugPanelOpen ? (
            <div className="health-card library-native-debug-panel" data-testid="health-debug-panel">
              <div className="section-header library-native-debug-toolbar">
                <h3>Health 调试命中</h3>
                <div className="library-native-debug-toolbar-actions">
                  <span className="library-native-debug-runtime-badge" data-transport={healthDebug.transport}>
                    {healthDebug.transport}
                  </span>
                  <button
                    type="button"
                    className="library-native-debug-icon-button"
                    aria-label={copied ? "已复制调试结果" : "复制调试结果"}
                    title={copied ? "已复制调试结果" : "复制调试结果"}
                    onClick={() => {
                      void copyDebugText(buildHealthDebugSummary(healthDebug));
                      setCopied(true);
                      window.setTimeout(() => setCopied(false), 1200);
                    }}
                  >
                    <DebugCopyIcon />
                  </button>
                  <button
                    type="button"
                    className="library-native-debug-icon-button"
                    aria-label="收起调试命中"
                    title="收起调试命中"
                    onClick={() => setDebugPanelOpen(false)}
                  >
                    <DebugCollapseIcon collapsed={false} />
                  </button>
                </div>
              </div>
              <p className="library-native-debug-channel-detail">{healthDebug.detail}</p>
              <p className="library-native-debug-channel-time">
                {healthDebug.updatedAt ? formatDateTime(healthDebug.updatedAt) : "尚无 health 检查记录"}
              </p>
            </div>
          ) : (
            <button
              type="button"
              className="library-native-debug-collapsed-button"
              data-testid="health-debug-toggle"
              aria-label="展开 Health 调试命中"
              title="展开 Health 调试命中"
              onClick={() => setDebugPanelOpen(true)}
            >
              <DebugBugIcon />
              <span className="library-native-debug-runtime-badge" data-transport={healthDebug.transport}>
                {healthDebug.transport}
              </span>
            </button>
          )
        ) : null}
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

function buildHealthDebugSummary(healthDebug: DevHealthDebugState): string {
  return JSON.stringify(
    {
      channel: "health",
      transport: healthDebug.transport,
      detail: healthDebug.detail,
      updatedAt: healthDebug.updatedAt,
    },
    null,
    2
  );
}

async function copyDebugText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "-9999px";
  document.body.append(textarea);
  textarea.focus();
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

function DebugBugIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M9 7.5h6M10 4.5h4M8.5 10.5h7a2.5 2.5 0 0 1 2.5 2.5v3a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4v-3a2.5 2.5 0 0 1 2.5-2.5Zm-3 1.5 2 1.5m11-1.5-2 1.5m-11 6 2-1.5m9 1.5-2-1.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function DebugCopyIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M9 9.5V6.8A1.8 1.8 0 0 1 10.8 5h6.4A1.8 1.8 0 0 1 19 6.8v8.4a1.8 1.8 0 0 1-1.8 1.8H14m-5 2H6.8A1.8 1.8 0 0 1 5 17.2v-8.4A1.8 1.8 0 0 1 6.8 7H13a1.8 1.8 0 0 1 1.8 1.8v8.4A1.8 1.8 0 0 1 13 19Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function DebugCollapseIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d={collapsed ? "m9 6 6 6-6 6" : "m15 18-6-6 6-6"}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}


function useWorkbenchPlatformData(): WorkbenchPlatformData {
  const [platformData, setPlatformData] = useState<WorkbenchPlatformData>(() => resolveWorkbenchPlatformData());

  useEffect(() => {
    let disposed = false;

    async function syncPlatformData() {
      const basePlatformData = resolveWorkbenchPlatformData();
      let nextPlatformData = basePlatformData;

      if (
        basePlatformData.runtimePlatform === "desktop" &&
        basePlatformData.osFamily === "macos"
      ) {
        const runtimeInfo = await getNativeDesktopRuntimeInfo();
        if (disposed) {
          return;
        }
        const macosTitlebar = runtimeInfo?.windowChrome?.macosTitlebar ?? null;
        nextPlatformData = {
          ...basePlatformData,
          overlayTitlebar: macosTitlebar?.overlay ?? true,
        };
        applyMacOsTitlebarVariables(macosTitlebar);
      } else {
        clearMacOsTitlebarVariables();
      }

      setPlatformData(nextPlatformData);
      applyPlatformDatasets(nextPlatformData);
    }

    void syncPlatformData();

    return () => {
      disposed = true;
    };
  }, []);

  return platformData;
}

function applyPlatformDatasets(platformData: WorkbenchPlatformData): void {
  const html = document.documentElement;
  const body = document.body;
  html.dataset.runtimePlatform = platformData.runtimePlatform;
  body.dataset.runtimePlatform = platformData.runtimePlatform;
  html.dataset.osFamily = platformData.osFamily;
  body.dataset.osFamily = platformData.osFamily;
  html.dataset.overlayTitlebar = String(platformData.overlayTitlebar);
  body.dataset.overlayTitlebar = String(platformData.overlayTitlebar);

  if (platformData.overlayTitlebar) {
    html.dataset.workbenchMacosVibrancy = "true";
    body.dataset.workbenchMacosVibrancy = "true";
  } else {
    delete html.dataset.workbenchMacosVibrancy;
    delete body.dataset.workbenchMacosVibrancy;
  }
}

const MACOS_TITLEBAR_STYLE_KEYS = [
  "--desktop-macos-traffic-light-center-y",
  "--desktop-macos-traffic-light-leading-inset",
  "--desktop-macos-traffic-light-safe-zone-width",
  "--desktop-macos-titlebar-height",
  "--desktop-macos-traffic-light-button-diameter",
] as const;

function clearMacOsTitlebarVariables(): void {
  const html = document.documentElement;
  const body = document.body;
  for (const key of MACOS_TITLEBAR_STYLE_KEYS) {
    html.style.removeProperty(key);
    body?.style.removeProperty(key);
  }
}

function applyMacOsTitlebarVariables(metrics: NativeMacOsTitlebarMetrics | null): void {
  if (!metrics) {
    clearMacOsTitlebarVariables();
    return;
  }

  const html = document.documentElement;
  const body = document.body;
  const styleEntries: Array<[typeof MACOS_TITLEBAR_STYLE_KEYS[number], string]> = [
    ["--desktop-macos-traffic-light-center-y", `${metrics.trafficLightCenterY}px`],
    ["--desktop-macos-traffic-light-leading-inset", `${metrics.trafficLightLeadingInset}px`],
    ["--desktop-macos-traffic-light-safe-zone-width", `${metrics.trafficLightSafeZoneWidth}px`],
    ["--desktop-macos-titlebar-height", `${metrics.titlebarHeight}px`],
    ["--desktop-macos-traffic-light-button-diameter", `${metrics.trafficLightButtonDiameter}px`],
  ];

  for (const [key, value] of styleEntries) {
    html.style.setProperty(key, value);
    body?.style.setProperty(key, value);
  }
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
    overlayTitlebar:
      typeof window !== "undefined" &&
      "__TAURI_INTERNALS__" in window &&
      isMacOS
  };
}
