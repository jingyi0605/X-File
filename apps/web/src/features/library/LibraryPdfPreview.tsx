import { useEffect, useState } from "react";
import { LIBRARY_PREVIEW_BUDGETS } from "@x-file/shared";
import { t } from "../../i18n";
import { readPreviewResource } from "./preview-resource-controller";
import { PdfContinuousPreview } from "./PdfContinuousPreview";

const MAX_PDF_BYTES = LIBRARY_PREVIEW_BUDGETS.resourceMaxBytes;
const MAX_PAGES = 2000;

export function LibraryPdfPreview({ path, previewUrl, revision, bytes: providedBytes }: { path: string; previewUrl: string | null; revision?: string; bytes?: Uint8Array }) {
  const [bytes, setBytes] = useState<Uint8Array | null>(providedBytes ?? null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    if (providedBytes) {
      setBytes(providedBytes);
      setLoading(false);
      return () => controller.abort();
    }
    setBytes(null);
    void readPdfBytes(path, previewUrl, controller.signal, revision).then((nextBytes) => {
      if (!controller.signal.aborted) setBytes(nextBytes);
    }).catch(() => {
      if (!controller.signal.aborted) {
        setLoading(false);
        setError(t("fileViewerPdfUnavailable"));
      }
    });
    return () => controller.abort();
  }, [path, previewUrl, revision, providedBytes]);

  if (error) return <div className="file-viewer-pdf-error" role="status">{error}</div>;
  if (!bytes) {
    return (
      <section className="file-viewer-pdf-preview" aria-label={path}>
        {loading ? <div className="office-preview-pptx-loading" role="status">{t("fileViewerOfficeLoading")}</div> : null}
      </section>
    );
  }
  return <PdfContinuousPreview bytes={bytes} path={path} maxPages={MAX_PAGES} />;
}

async function readPdfBytes(path: string, previewUrl: string | null, signal: AbortSignal, revision?: string): Promise<Uint8Array> {
  return readPreviewResource({
    path,
    previewUrl,
    maxBytes: MAX_PDF_BYTES,
    signal,
    revision,
  });
}
