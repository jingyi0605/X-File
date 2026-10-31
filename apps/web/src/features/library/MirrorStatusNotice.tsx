import { createPortal } from "react-dom";
import { useEffect, useRef, useState } from "react";

import { t } from "../../i18n";
import { fetchHealth } from "../../api/health";
import { loadMirrorCache } from "../../runtime/mirror-cache";
import { getMirrorSnapshot } from "../../runtime/mirror-api";

const MIRROR_REFRESH_INTERVAL_MS = 30_000;

export function MirrorStatusNotice({
  remoteApiBaseUrl,
  onAvailable,
  libraryLoading,
}: {
  remoteApiBaseUrl: string;
  onAvailable?: () => void;
  libraryLoading?: boolean;
}) {
  const isLibraryLoading = libraryLoading ?? false;
  const onAvailableRef = useRef(onAvailable);
  onAvailableRef.current = onAvailable;
  const observedRevisionRef = useRef<string | null>(null);
  const previousReachableRef = useRef<boolean | null>(null);
  const syncInFlightRef = useRef(false);
  const normalizedApiUrl = remoteApiBaseUrl.trim().replace(/\/+$/g, "");
  const dismissalStorageKey = `x-file.mirror-notice-dismissed.${normalizedApiUrl}`;
  const [dismissedNoticeKey, setDismissedNoticeKey] = useState<string | null>(null);
  const [state, setState] = useState<{
    loaded: boolean;
    hasSnapshot: boolean;
    pendingCount: number;
    conflictCount: number;
    lastError: string | null;
  }>({
    loaded: false,
    hasSnapshot: false,
    pendingCount: 0,
    conflictCount: 0,
    lastError: null,
  });

  useEffect(() => {
    setDismissedNoticeKey(readDismissedNotice(dismissalStorageKey));
  }, [dismissalStorageKey]);

  useEffect(() => {
    let active = true;
    const refresh = async (allowRetry: boolean) => {
      const [cache, reachable] = await Promise.all([
        loadMirrorCache(normalizedApiUrl),
        fetchHealth().then(() => true).catch(() => false),
      ]);
      if (!active) return;

      const wasReachable = previousReachableRef.current;
      previousReachableRef.current = reachable;
      setState({
        loaded: true,
        hasSnapshot: cache.snapshot !== null,
        pendingCount: cache.pendingMutations.length,
        conflictCount: cache.syncResults.filter((result) => result.status === "conflict").length,
        lastError: reachable ? cache.lastError : "primary-unavailable",
      });

      const shouldSync = reachable && !isLibraryLoading && (
        allowRetry
        || Boolean(cache.lastError)
        || wasReachable === false
      );
      if (!shouldSync || syncInFlightRef.current) return;

      syncInFlightRef.current = true;
      try {
        const snapshot = await getMirrorSnapshot();
        if (!active) return;
        if (observedRevisionRef.current !== snapshot.revision) {
          observedRevisionRef.current = snapshot.revision;
          if (cache.snapshot?.revision !== snapshot.revision) {
            onAvailableRef.current?.();
          }
        }
        const updatedCache = await loadMirrorCache(normalizedApiUrl);
        if (active) {
          setState({
            loaded: true,
            hasSnapshot: updatedCache.snapshot !== null,
            pendingCount: updatedCache.pendingMutations.length,
            conflictCount: updatedCache.syncResults.filter((result) => result.status === "conflict").length,
            lastError: updatedCache.lastError,
          });
        }
      } catch {
        // The library screen owns the visible connection error and retry action.
      } finally {
        syncInFlightRef.current = false;
      }
    };
    void refresh(false);
    const timer = window.setInterval(() => void refresh(true), MIRROR_REFRESH_INTERVAL_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [isLibraryLoading, normalizedApiUrl]);

  const notice = state.pendingCount > 0
    ? {
        key: `pending:${state.pendingCount}`,
        tone: "warning" as const,
        message: t("mirrorPendingNotice", { count: state.pendingCount }),
      }
    : state.conflictCount > 0
      ? {
          key: `conflict:${state.conflictCount}`,
          tone: "danger" as const,
          message: t("mirrorConflictNotice", { count: state.conflictCount }),
        }
      : state.lastError && state.hasSnapshot
        ? {
            key: "offline",
            tone: "warning" as const,
            message: t("mirrorOfflineNotice"),
          }
        : null;

  useEffect(() => {
    if (!state.loaded || notice) return;
    clearDismissedNotice(dismissalStorageKey);
    setDismissedNoticeKey(null);
  }, [dismissalStorageKey, notice, state.loaded]);

  if (!notice || dismissedNoticeKey === notice.key || typeof document === "undefined") {
    return null;
  }

  return createPortal(
    <aside
      className="mirror-warning-toast"
      data-tone={notice.tone}
      role="status"
      aria-live="polite"
    >
      <span className="mirror-warning-toast-icon" aria-hidden="true">!</span>
      <div className="mirror-warning-toast-copy">
        <strong>{t("mirrorNoticeTitle")}</strong>
        <span>{notice.message}</span>
      </div>
      <button
        type="button"
        className="mirror-warning-toast-dismiss"
        aria-label={t("actionClose")}
        title={t("actionClose")}
        onClick={() => {
          persistDismissedNotice(dismissalStorageKey, notice.key);
          setDismissedNoticeKey(notice.key);
        }}
      >
        <span aria-hidden="true">×</span>
      </button>
    </aside>,
    document.body,
  );
}

function readDismissedNotice(storageKey: string): string | null {
  try {
    return window.localStorage.getItem(storageKey);
  } catch {
    return null;
  }
}

function persistDismissedNotice(storageKey: string, noticeKey: string): void {
  try {
    window.localStorage.setItem(storageKey, noticeKey);
  } catch {
    // Storage denial should not prevent dismissing the current notification.
  }
}

function clearDismissedNotice(storageKey: string): void {
  try {
    window.localStorage.removeItem(storageKey);
  } catch {
    // Storage denial should not prevent the mirror status from updating.
  }
}
