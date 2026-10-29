import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";

import { t } from "../../i18n";
import { formatBytes } from "../../shared/format";
import { cancelNativeOfficeConverterOperation, convertNativeOfficePreview, getNativeOfficeConverterStatus, type NativeOfficeConverterStatus } from "../../runtime/native-library-bridge";
import { getRuntimeConfigSnapshot } from "../../runtime/runtime-config-store";

const OfficePreviewContent = lazy(() => import("./office-preview-content"));
const OfficeConvertedPdfPreview = lazy(() => import("./OfficeConvertedPdfPreview").then((module) => ({ default: module.OfficeConvertedPdfPreview })));

interface OfficePreviewProps {
  fileName: string;
  relativePath: string;
  previewUrl: string | null;
  localFilePath: string | null;
  size: number;
  revision?: string;
  resourceBytes?: Uint8Array;
  hideToolbar?: boolean;
  className?: string;
}

export function OfficePreview({
  fileName,
  relativePath,
  previewUrl,
  localFilePath,
  size,
  revision,
  resourceBytes,
  hideToolbar = false,
  className = "",
}: OfficePreviewProps) {
  const [error, setError] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [openingAvailable, setOpeningAvailable] = useState(false);
  const [previewResourceAvailable, setPreviewResourceAvailable] = useState(false);
  const [converterStatus, setConverterStatus] = useState<NativeOfficeConverterStatus | null>(null);
  const [converterChecked, setConverterChecked] = useState(false);
  const [convertedPdf, setConvertedPdf] = useState<Uint8Array | null>(null);
  const [conversionDetails, setConversionDetails] = useState<{ pageCount: number; elapsedMs: number; cached: boolean; missingFonts: string[] } | null>(null);
  const [converting, setConverting] = useState(false);
  const [conversionError, setConversionError] = useState(false);
  const conversionActiveRef = useRef(false);
  const conversionGenerationRef = useRef(0);
  const autoConversionPathRef = useRef<string | null>(null);
  const conversionButtonRef = useRef<HTMLButtonElement | null>(null);
  const officeFormat = getOfficeFormat(fileName);
  const shouldConvert = officeFormat === "DOCX" || officeFormat === "PPTX";
  const isNativeLocal = openingAvailable && getRuntimeConfigSnapshot().config.mode === "local";
  const converterChecking = isNativeLocal && shouldConvert && !converterChecked;

  const handleConvertedPdfError = useCallback(() => {
    setConvertedPdf(null);
    setConversionError(true);
  }, []);

  useEffect(() => {
    setOpeningAvailable(typeof window !== "undefined" && "__TAURI_INTERNALS__" in window);
  }, []);

  useEffect(() => {
    setPreviewResourceAvailable(previewUrl !== null);
  }, [previewUrl]);

  useEffect(() => {
    setError(null);
    setOpenError(null);
  }, [relativePath, previewUrl]);

  useEffect(() => {
    conversionGenerationRef.current += 1;
    autoConversionPathRef.current = null;
    setConvertedPdf(null);
    setConversionDetails(null);
    setConversionError(false);
    setConverting(false);
    setConverterChecked(false);
    if (!isNativeLocal || !shouldConvert) {
      setConverterStatus(null);
      setConverterChecked(true);
      return;
    }
    let active = true;
    void getNativeOfficeConverterStatus().then((status) => {
      if (!active) return;
      setConverterStatus(status);
      setConverterChecked(true);
      if (status?.installed && !status.busy && autoConversionPathRef.current !== relativePath) {
        autoConversionPathRef.current = relativePath;
        void convertForPreview();
      }
    }).catch(() => {
      if (active) {
        setConverterStatus(null);
        setConverterChecked(true);
      }
    });
    return () => {
      active = false;
      if (conversionActiveRef.current) void cancelNativeOfficeConverterOperation();
    };
  }, [relativePath, isNativeLocal, shouldConvert]);

  useEffect(() => () => {
    if (conversionActiveRef.current) void cancelNativeOfficeConverterOperation();
  }, []);

  async function convertForPreview(): Promise<void> {
    if (conversionActiveRef.current) return;
    const generation = conversionGenerationRef.current;
    conversionActiveRef.current = true;
    setConverting(true);
    setConversionError(false);
    try {
      const result = await convertNativeOfficePreview(relativePath);
      if (!result) throw new Error("native-command-unavailable");
      if (conversionGenerationRef.current === generation) {
        setConvertedPdf(result.bytes);
        setConversionDetails({ pageCount: result.pageCount, elapsedMs: result.elapsedMs, cached: result.cached, missingFonts: result.missingFonts });
      }
    } catch {
      if (conversionGenerationRef.current === generation) setConversionError(true);
    } finally {
      conversionActiveRef.current = false;
      if (conversionGenerationRef.current === generation) setConverting(false);
      void getNativeOfficeConverterStatus().then((status) => { if (status) setConverterStatus(status); });
    }
  }

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
    <section className={["office-preview-shell", className].filter(Boolean).join(" ")} aria-label={fileName}>
      {!hideToolbar ? (
        <header className="office-preview-toolbar">
          <span className="office-preview-format">{officeFormat}</span>
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
      ) : null}
      {openError ? <p className="inline-alert" role="alert">{openError}</p> : null}
      {converterChecking ? (
        <div className="office-preview-state" role="status">{t("fileViewerOfficeLoading")}</div>
      ) : null}
      {shouldConvert && convertedPdf ? (
        <Suspense fallback={<div className="office-preview-state" role="status">{t("fileViewerOfficeLoading")}</div>}>
          <OfficeConvertedPdfPreview
            bytes={convertedPdf}
            path={relativePath}
            onError={handleConvertedPdfError}
          />
        </Suspense>
      ) : null}
      {shouldConvert && converting ? (
        <div className="office-preview-state" role="status">
          <p>{t("fileViewerOfficeLoading")}</p>
          <button type="button" className="secondary-button" onClick={() => void cancelNativeOfficeConverterOperation()}>{t("fileViewerOfficeCancelConversion")}</button>
        </div>
      ) : null}
      {shouldConvert && converterStatus?.installed && !convertedPdf && !converting && conversionError ? (
        <div className="office-preview-conversion-action">
          <button type="button" className="secondary-button" disabled={converterStatus.busy} onClick={() => void convertForPreview()}>
            {t("fileViewerOfficeRetryConversion")}
          </button>
          <p role="status">{t("fileViewerOfficeConversionFallback")}</p>
        </div>
      ) : null}
      {shouldConvert && converterStatus?.installed && !convertedPdf && !converting && !conversionError ? (
        <div className="office-preview-conversion-action">
          <button ref={conversionButtonRef} type="button" className="secondary-button" disabled={converterStatus.busy} onClick={() => void convertForPreview()}>
            {t("fileViewerOfficeConvertPreview")}
          </button>
        </div>
      ) : null}
      {conversionDetails && convertedPdf ? (
        <p className="office-preview-conversion-meta" role="status">
          {t("fileViewerOfficeConversionDetails", {
            count: conversionDetails.pageCount,
            seconds: (conversionDetails.elapsedMs / 1000).toFixed(1),
            cache: conversionDetails.cached ? t("fileViewerOfficeCacheHit") : t("fileViewerOfficeCacheMiss"),
          })}
          {conversionDetails.missingFonts.length ? ` ${t("fileViewerOfficeMissingFonts", { fonts: conversionDetails.missingFonts.join(", ") })}` : ""}
        </p>
      ) : null}
      {converterChecking || convertedPdf || converting ? null : error ? (
        <OfficePreviewFallback error={error} onOpen={localFilePath && openingAvailable ? () => void openInLocalApp() : null} />
      ) : previewResourceAvailable || (openingAvailable && localFilePath) ? (
        <>
          {conversionError ? <p className="inline-note">{t("fileViewerOfficeConversionFallback")}</p> : null}
          <Suspense fallback={<div className="office-preview-state" role="status">{t("fileViewerOfficeLoading")}</div>}>
            <OfficePreviewContent
              fileName={fileName}
              relativePath={relativePath}
              previewUrl={previewResourceAvailable ? previewUrl ?? "" : ""}
              revision={revision}
              resourceBytes={resourceBytes}
              onError={setError}
            />
          </Suspense>
        </>
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
  return extension === "DOCX" || extension === "XLS" || extension === "XLSX" || extension === "PPTX" ? extension : "OFFICE";
}
