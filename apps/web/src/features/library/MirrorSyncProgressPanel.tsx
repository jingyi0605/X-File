import { t } from "../../i18n";
import { useMirrorSyncProgress } from "../../runtime/mirror-sync-progress";

export function MirrorSyncProgressPanel({ active }: { active: boolean }) {
  const progress = useMirrorSyncProgress();
  if (!active) return null;

  const stage = progress.phase === "saving" || progress.phase === "complete"
    ? 2
    : progress.phase === "receiving"
      ? 1
      : 0;
  const hasByteTotal = progress.totalBytes !== null && progress.totalBytes > 0;
  const hasDocumentTotal = progress.totalDocuments !== null;
  const percent = hasByteTotal
    ? Math.min(100, Math.round((progress.receivedBytes / progress.totalBytes!) * 100))
    : hasDocumentTotal
      ? progress.totalDocuments! > 0
        ? Math.min(100, Math.round((progress.receivedDocuments / progress.totalDocuments!) * 100))
        : 100
      : null;
  const phaseLabel = progress.phase === "saving"
    ? t("mirrorProgressSaving")
    : progress.phase === "complete"
      ? t("mirrorProgressDone")
      : progress.phase === "receiving"
        ? t("mirrorProgressReceiving")
        : t("mirrorProgressConnecting");
  const detail = hasByteTotal
    ? t("mirrorProgressByteCount", {
        received: formatMegabytes(progress.receivedBytes),
        total: formatMegabytes(progress.totalBytes!),
      })
    : hasDocumentTotal
    ? t("mirrorProgressDocumentCount", {
        received: progress.receivedDocuments.toLocaleString(),
        total: progress.totalDocuments?.toLocaleString() ?? "0",
      })
    : progress.receivedBytes > 0
      ? t("mirrorProgressBytesReceived", { received: formatMegabytes(progress.receivedBytes) })
    : progress.transport === "snapshot"
      ? t("mirrorProgressSnapshotDetail")
      : t("mirrorProgressConnectingDetail");
  const steps = [
    t("mirrorProgressConnecting"),
    t("mirrorProgressReceiving"),
    t("mirrorProgressSaving"),
  ];

  return (
    <section className="mirror-sync-progress-card" aria-label={t("mirrorProgressTitle")}>
      <div className="mirror-sync-progress-heading">
        <span className="mirror-sync-progress-orbit" aria-hidden="true">
          <span />
        </span>
        <div className="mirror-sync-progress-heading-copy">
          <span className="mirror-sync-progress-eyebrow">{t("mirrorProgressEyebrow")}</span>
          <strong>{phaseLabel}</strong>
        </div>
        {percent !== null ? <span className="mirror-sync-progress-percent">{percent}%</span> : null}
      </div>

      <div
        className="mirror-sync-progress-track"
        role="progressbar"
        aria-label={t("mirrorProgressTitle")}
        aria-valuemin={0}
        aria-valuemax={100}
        {...(percent === null ? {} : { "aria-valuenow": percent })}
      >
        <span
          className={`mirror-sync-progress-fill${percent === null ? " is-indeterminate" : ""}`}
          style={percent === null ? undefined : { width: `${percent}%` }}
        />
      </div>

      <div className="mirror-sync-progress-footer">
        <span>{detail}</span>
        {progress.transport === "legacy" ? <span>{t("mirrorProgressPagedMode")}</span> : null}
      </div>

      <div className="mirror-sync-progress-steps" aria-hidden="true">
        {steps.map((label, index) => (
          <span className={index <= stage ? "is-active" : ""} key={label}>{label}</span>
        ))}
      </div>
    </section>
  );
}

function formatMegabytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}
