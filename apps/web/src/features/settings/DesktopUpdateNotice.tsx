import { useEffect, useState } from "react";

import { t } from "../../i18n";

const UPDATE_CHECK_DELAY_MS = 4_000;
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1_000;
const LAST_CHECK_STORAGE_KEY = "x-file.update.last-check";
const DISMISSED_STORAGE_PREFIX = "x-file.update.dismissed.";

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
}

export interface DesktopUpdateNoticeState {
  channel: "stable" | "beta";
  currentVersion: string;
  manifest: ReleaseManifest;
}

export function useDesktopUpdateNotice(): {
  notice: DesktopUpdateNoticeState | null;
  dismiss: () => void;
} {
  const desktop = isDesktopContext();
  const [notice, setNotice] = useState<DesktopUpdateNoticeState | null>(null);

  useEffect(() => {
    if (!desktop) {
      return;
    }

    let active = true;
    let timer: number | undefined;
    let interval: number | undefined;

    async function checkInBackground(): Promise<void> {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const savedChannel = await invoke<string>("get_release_channel").catch(() => "stable");
        const channel = savedChannel === "beta" ? "beta" : "stable";
        if (!shouldCheck(channel)) {
          return;
        }

        const result = await invoke<DesktopReleaseState>("check_for_update", { channel });
        if (!active) {
          return;
        }

        markChecked(channel);
        if (!result.hasUpdate || !result.manifest) {
          return;
        }

        const nextNotice = {
          channel,
          currentVersion: result.currentVersion,
          manifest: result.manifest,
        } satisfies DesktopUpdateNoticeState;
        if (readDismissedKey() !== buildNoticeKey(nextNotice)) {
          setNotice(nextNotice);
        }
      } catch {
        // 后台检查失败不打断启动；设置页仍提供手动重试入口。
      }
    }

    timer = window.setTimeout(() => {
      void checkInBackground();
    }, UPDATE_CHECK_DELAY_MS);
    interval = window.setInterval(() => {
      void checkInBackground();
    }, UPDATE_CHECK_INTERVAL_MS);

    return () => {
      active = false;
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
      if (interval !== undefined) {
        window.clearInterval(interval);
      }
    };
  }, [desktop]);

  function dismiss(): void {
    if (!notice) {
      return;
    }
    writeDismissedKey(buildNoticeKey(notice));
    setNotice(null);
  }

  return { notice, dismiss };
}

export function DesktopUpdateNotice({
  notice,
  onOpenSettings,
  onDismiss,
}: {
  notice: DesktopUpdateNoticeState;
  onOpenSettings: () => void;
  onDismiss: () => void;
}) {
  return (
    <aside className="update-available-toast" role="status" aria-live="polite">
      <span className="update-available-toast-icon" aria-hidden="true">↻</span>
      <div className="update-available-toast-copy">
        <strong>{t("settingsUpdatesNoticeTitle", { version: notice.manifest.version })}</strong>
        <span>{t("settingsUpdatesNoticeDescription", { channel: notice.channel })}</span>
      </div>
      <div className="update-available-toast-actions">
        <button type="button" className="secondary-button" onClick={onOpenSettings}>
          {t("settingsUpdatesNoticeOpen")}
        </button>
        <button
          type="button"
          className="update-available-toast-dismiss"
          aria-label={t("settingsUpdatesNoticeDismiss")}
          title={t("settingsUpdatesNoticeDismiss")}
          onClick={onDismiss}
        >
          ×
        </button>
      </div>
    </aside>
  );
}

export function buildNoticeKey(notice: Pick<DesktopUpdateNoticeState, "channel" | "manifest">): string {
  return `${notice.channel}:${notice.manifest.version}`;
}

function isDesktopContext(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function shouldCheck(channel: "stable" | "beta"): boolean {
  const raw = window.localStorage.getItem(LAST_CHECK_STORAGE_KEY);
  if (!raw) {
    return true;
  }

  try {
    const values = JSON.parse(raw) as Record<string, number>;
    return Date.now() - (values[channel] ?? 0) >= UPDATE_CHECK_INTERVAL_MS;
  } catch {
    return true;
  }
}

function markChecked(channel: "stable" | "beta"): void {
  let values: Record<string, number> = {};
  try {
    values = JSON.parse(window.localStorage.getItem(LAST_CHECK_STORAGE_KEY) ?? "{}");
  } catch {
    values = {};
  }
  values[channel] = Date.now();
  window.localStorage.setItem(LAST_CHECK_STORAGE_KEY, JSON.stringify(values));
}

function readDismissedKey(): string | null {
  return window.localStorage.getItem(DISMISSED_STORAGE_PREFIX);
}

function writeDismissedKey(value: string): void {
  window.localStorage.setItem(DISMISSED_STORAGE_PREFIX, value);
}
