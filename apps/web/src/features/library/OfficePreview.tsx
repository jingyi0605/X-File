import { lazy, Suspense, useEffect, useState } from "react";

import { t } from "../../i18n";
import { formatBytes } from "../../shared/format";

const OfficePreviewContent = lazy(() => import("./office-preview-content"));

interface OfficePreviewProps {
  fileName: string;
  relativePath: string;
  previewUrl: string | null;
  localFilePath: string | null;
  size: number;
}

export function OfficePreview({ fileName, relativePath, previewUrl, localFilePath, size }: OfficePreviewProps) {
  const [error, setError] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [openingAvailable, setOpeningAvailable] = useState(false);
  const [previewResourceAvailable, setPreviewResourceAvailable] = useState(false);

  useEffect(() => {
    setOpeningAvailable(typeof window !== "undefined" && "__TAURI_INTERNALS__" in window);
  }, []);

  useEffect(() => {
    setPreviewResourceAvailable(previewUrl !== null);
  }, [previewUrl]);

  async function openInLocalApp(): Promise<void> {
    if (!localFilePath || !openingAvailable) return;
    setOpening(true);
    setOpenError(null);
    try {
      const tauriApi = await import("@tauri-apps/api/core");
      await tauriApi.invoke("open_path", { path: localFilePath });
    } catch {
      setOpenError(t("fileViewerOfficeOpenFailed"));
    } finally {
      setOpening(false);
    }
  }

  return (
    <section className="office-preview-shell" aria-label={fileName}>
      <header className="office-preview-toolbar">
        <span className="office-preview-format">{getOfficeFormat(fileName)}</span>
        <span className="office-preview-size">{formatBytes(size)}</span>
        {openingAvailable && localFilePath ? (
          <button
            type="button"
            className="secondary-button office-preview-open-button"
            disabled={opening}
            onClick={() => void openInLocalApp()}
          >
            <span>{opening ? t("fileViewerOfficeOpening") : t("libraryContextOpenLocalApp")}</span>
          </button>
        ) : null}
      </header>
      {openError ? <p className="inline-alert" role="alert">{openError}</p> : null}
      {error ? (
        <OfficePreviewFallback error={error} onOpen={localFilePath && openingAvailable ? () => void openInLocalApp() : null} />
      ) : previewResourceAvailable || (openingAvailable && localFilePath) ? (
        <Suspense fallback={<div className="office-preview-state" role="status">{t("fileViewerOfficeLoading")}</div>}>
          <OfficePreviewContent
            fileName={fileName}
            relativePath={relativePath}
            previewUrl={previewResourceAvailable ? previewUrl ?? "" : ""}
            onError={setError}
          />
        </Suspense>
      ) : (
        <OfficePreviewFallback
          error={t("fileViewerOfficeResourceUnavailable")}
          onOpen={localFilePath && openingAvailable ? () => void openInLocalApp() : null}
        />
      )}
    </section>
  );
}

function OfficePreviewFallback({ error, onOpen }: { error: string; onOpen: (() => void) | null }) {
  return (
    <div className="office-preview-state office-preview-error" role="status">
      <p>{error}</p>
      {onOpen ? (
        <button type="button" className="secondary-button" onClick={onOpen}>
          {t("libraryContextOpenLocalApp")}
        </button>
      ) : null}
    </div>
  );
}

function getOfficeFormat(fileName: string): string {
  const extension = fileName.split(".").pop()?.toUpperCase() ?? "OFFICE";
  return extension === "DOCX" || extension === "XLSX" || extension === "PPTX" ? extension : "OFFICE";
}
