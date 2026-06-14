import { useEffect, useState } from "react";
import { t } from "../../i18n";

// 与 Rust apps/desktop/src-tauri/src/updater.rs 的返回类型对齐（serde camelCase）。
interface ReleaseManifest {
  channel: string;
  platform: string;
  version: string;
  tagName: string;
  title: string;
  notes: string;
  htmlUrl: string;
  publishedAt: string;
}

interface DesktopReleaseState {
  checkedAt: string;
  currentVersion: string;
  hasUpdate: boolean;
  manifest: ReleaseManifest | null;
  runtimeInfo: { version: string; appDataDir: string | null };
}

interface UpdateDownloadResult {
  ok: boolean;
  errorCode: string | null;
  detail: string | null;
  version: string | null;
  progress: { downloaded: number; contentLength: number | null; percent: number | null } | null;
}

type Channel = "stable" | "beta";

// 桌面壳内才有 __TAURI_INTERNALS__；网页模式下隐藏更新操作。
function isDesktopContext(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function describeError(err: unknown, fallback: string): string {
  if (err instanceof Error) {
    return err.message || fallback;
  }
  return String(err ?? fallback);
}

/**
 * 设置页「版本更新」面板。
 * 复用全局类名 .settings-section / .settings-appearance-grid / .settings-appearance-card /
 * .button-row / .primary-button / .secondary-button / .settings-current / .inline-note /
 * .inline-alert / .inline-success / .modal-empty-state，不引入局部魔法值。
 */
export function UpdatePanel() {
  const desktop = isDesktopContext();
  const [channel, setChannel] = useState<Channel>("stable");
  const [checking, setChecking] = useState(false);
  const [state, setState] = useState<DesktopReleaseState | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  // 启动时读取持久化的通道偏好（app_data_dir/release-channel.json）。
  useEffect(() => {
    if (!desktop) {
      return;
    }
    void (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const saved = await invoke<string>("get_release_channel");
        setChannel(saved === "beta" ? "beta" : "stable");
      } catch {
        // 读取失败回退 stable，静默处理。
      }
    })();
  }, [desktop]);

  async function handleCheck() {
    setError(null);
    setInfo(null);
    setChecking(true);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const result = await invoke<DesktopReleaseState>("check_for_update", { channel });
      setState(result);
      if (!result.hasUpdate) {
        setInfo(t("settingsUpdatesUpToDate"));
      }
    } catch (err) {
      setError(`${t("settingsUpdatesCheckError")} ${describeError(err, "")}`.trim());
    } finally {
      setChecking(false);
    }
  }

  async function handleDownloadAndInstall() {
    setError(null);
    setInfo(null);
    setDownloading(true);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const result = await invoke<UpdateDownloadResult>("download_update", { channel });
      if (!result.ok) {
        throw new Error(result.detail ?? "download failed");
      }
      setDownloading(false);
      setInstalling(true);
      // install_update 成功后应用会退出并重启；若未退出，提示重启。
      await invoke("install_update", { channel });
      setInfo(t("settingsUpdatesRestartHint"));
    } catch (err) {
      setError(describeError(err, t("settingsUpdatesCheckError")));
    } finally {
      setDownloading(false);
      setInstalling(false);
    }
  }

  async function handleChannelChange(next: Channel) {
    if (next === channel) {
      return;
    }
    setChannel(next);
    setError(null);
    setInfo(null);
    setState(null);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("set_release_channel", { channel: next });
    } catch {
      // 持久化失败不阻塞本地切换，静默处理。
    }
  }

  async function handleViewRelease(url: string) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("open_external_url", { url });
    } catch {
      // 桌面命令失败时回退到 window.open（网页模式或异常）
      window.open(url, "_blank", "noopener,noreferrer");
    }
  }

  if (!desktop) {
    return (
      <section className="settings-section">
        <h2>{t("settingsUpdatesTitle")}</h2>
        <div className="modal-empty-state" data-compact="true">
          <strong className="modal-empty-state-title">{t("settingsUpdatesNotDesktopTitle")}</strong>
          <p className="modal-empty-state-description">{t("settingsUpdatesNotDesktopDescription")}</p>
        </div>
      </section>
    );
  }

  const hasUpdate = state?.hasUpdate ?? false;
  const manifest = state?.manifest;
  const currentVersion = state?.currentVersion ?? state?.runtimeInfo?.version ?? "—";
  const busy = checking || downloading || installing;

  return (
    <section className="settings-section">
      <h2>{t("settingsUpdatesTitle")}</h2>

      <div className="settings-appearance-grid">
        <div className="settings-appearance-card">
          <h3>{t("settingsUpdatesChannelTitle")}</h3>
          <p>{t("settingsUpdatesChannelDescription")}</p>
          <div className="button-row">
            <button
              type="button"
              className={channel === "stable" ? "primary-button" : "secondary-button"}
              disabled={busy}
              onClick={() => void handleChannelChange("stable")}
            >
              {t("settingsUpdatesChannelStable")}
            </button>
            <button
              type="button"
              className={channel === "beta" ? "primary-button" : "secondary-button"}
              disabled={busy}
              onClick={() => void handleChannelChange("beta")}
            >
              {t("settingsUpdatesChannelDev")}
            </button>
          </div>
        </div>

        <div className="settings-appearance-card">
          <h3>{t("settingsUpdatesStatusTitle")}</h3>
          <div className="settings-current">
            <span>{t("settingsUpdatesCurrentVersion")}</span>
            <strong>{currentVersion}</strong>
          </div>
          <div className="settings-current">
            <span>{t("settingsUpdatesLatestVersion")}</span>
            <strong>{manifest?.version ?? "—"}</strong>
          </div>
          {manifest?.publishedAt ? (
            <div className="settings-current">
              <span>{t("settingsUpdatesPublishedAt")}</span>
              <strong>{manifest.publishedAt}</strong>
            </div>
          ) : null}
          <div className="button-row">
            <button
              type="button"
              className="primary-button"
              disabled={busy}
              onClick={() => void handleCheck()}
            >
              {checking ? t("settingsUpdatesChecking") : t("settingsUpdatesCheck")}
            </button>
            {manifest?.htmlUrl ? (
              <button
                type="button"
                className="secondary-button"
                onClick={() => void handleViewRelease(manifest.htmlUrl)}
              >
                {t("settingsUpdatesViewRelease")}
              </button>
            ) : null}
          </div>
        </div>
      </div>

      {info ? <div className="inline-success">{info}</div> : null}
      {error ? <div className="inline-alert">{error}</div> : null}

      {hasUpdate && manifest ? (
        <>
          <div className="inline-note">
            {t("settingsUpdatesAvailable", { version: manifest.version })}
          </div>
          {manifest.notes ? (
            <details>
              <summary>{t("settingsUpdatesNotes")}</summary>
              <pre>{manifest.notes}</pre>
            </details>
          ) : null}
          <div className="button-row">
            <button
              type="button"
              className="primary-button"
              disabled={busy}
              onClick={() => void handleDownloadAndInstall()}
            >
              {installing
                ? t("settingsUpdatesInstalling")
                : downloading
                  ? t("settingsUpdatesDownloading")
                  : t("settingsUpdatesDownload")}
            </button>
          </div>
        </>
      ) : null}
    </section>
  );
}
