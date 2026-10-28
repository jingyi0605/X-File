import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy, PDFDocumentLoadingTask, RenderTask } from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { t } from "../../i18n";
import { readNativePreviewResource } from "../../runtime/native-library-bridge";
import { getRuntimeConfigSnapshot } from "../../runtime/runtime-config-store";

const MAX_PDF_BYTES = 20 * 1024 * 1024;
const MAX_PAGES = 2000;

export function LibraryPdfPreview({ path, previewUrl }: { path: string; previewUrl: string | null }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setBytes(null);
    setPdf(null);
    setPageNumber(1);
    setPageCount(0);
    void readPdfBytes(path, previewUrl).then((nextBytes) => {
      if (!cancelled) setBytes(nextBytes);
    }).catch(() => {
      if (!cancelled) {
        setLoading(false);
        setError(t("fileViewerPdfUnavailable"));
      }
    });
    return () => { cancelled = true; };
  }, [path, previewUrl]);

  useEffect(() => {
    if (!bytes) return;
    let cancelled = false;
    let loadingTask: PDFDocumentLoadingTask | null = null;

    setLoading(true);
    setError(null);
    void import("pdfjs-dist").then(({ getDocument, GlobalWorkerOptions }) => {
      GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
      loadingTask = getDocument({ data: bytes });
      return loadingTask.promise;
    }).then(async (document) => {
      if (cancelled) {
        await loadingTask?.destroy();
        return;
      }
      if (document.numPages > MAX_PAGES) throw new Error("page-limit");
      setPageCount(document.numPages);
      setPdf(document);
    }).catch(() => {
      if (!cancelled) {
        setLoading(false);
        setError(t("fileViewerPdfUnavailable"));
      }
    });

    return () => {
      cancelled = true;
      void loadingTask?.destroy();
    };
  }, [bytes]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!pdf || !canvas) return;
    let cancelled = false;
    let renderTask: RenderTask | null = null;
    setLoading(true);
    void pdf.getPage(pageNumber).then((page) => {
      if (cancelled) return;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("canvas");
      const availableWidth = canvas.parentElement?.clientWidth ?? 900;
      const unscaledViewport = page.getViewport({ scale: 1 });
      const scale = Math.min(1.6, Math.max(0.4, (availableWidth - 32) / unscaledViewport.width));
      const viewport = page.getViewport({ scale });
      const maxPixels = 16_000_000;
      const outputScale = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(maxPixels / (viewport.width * viewport.height)));
      canvas.width = Math.ceil(viewport.width * outputScale);
      canvas.height = Math.ceil(viewport.height * outputScale);
      canvas.style.width = `${Math.ceil(viewport.width)}px`;
      canvas.style.height = `${Math.ceil(viewport.height)}px`;
      context.setTransform(outputScale, 0, 0, outputScale, 0, 0);
      renderTask = page.render({ canvas, viewport, background: "#ffffff" });
      return renderTask.promise;
    }).then(() => {
      if (!cancelled) setLoading(false);
    }).catch(() => {
      if (!cancelled) {
        setLoading(false);
        setError(t("fileViewerPdfUnavailable"));
      }
    });
    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [pdf, pageNumber]);

  if (error) return <div className="file-viewer-pdf-error" role="status">{error}</div>;
  return (
    <section className="file-viewer-pdf-preview" aria-label={path}>
      <header className="file-viewer-pdf-toolbar">
        <button className="secondary-button" type="button" disabled={loading || pageNumber <= 1} onClick={() => setPageNumber((page) => Math.max(1, page - 1))}>
          {t("fileViewerPdfPrevious")}
        </button>
        <span aria-live="polite">{pageNumber} / {pageCount || "..."}</span>
        <button className="secondary-button" type="button" disabled={loading || pageNumber >= pageCount} onClick={() => setPageNumber((page) => Math.min(pageCount, page + 1))}>
          {t("fileViewerPdfNext")}
        </button>
      </header>
      <div className="file-viewer-pdf-canvas-wrap">
        {loading ? <div className="office-preview-pptx-loading" role="status">{t("fileViewerOfficeLoading")}</div> : null}
        <canvas ref={canvasRef} aria-label={`${path}, ${pageNumber}`} />
      </div>
    </section>
  );
}

async function readPdfBytes(path: string, previewUrl: string | null): Promise<Uint8Array> {
  let bytes: Uint8Array;
  if (previewUrl && !previewUrl.startsWith("file://")) {
    const response = await fetch(previewUrl);
    if (!response.ok) throw new Error("resource");
    const declaredSize = Number(response.headers.get("content-length"));
    if (declaredSize > MAX_PDF_BYTES) throw new Error("size");
    bytes = new Uint8Array(await response.arrayBuffer());
  } else {
    if (getRuntimeConfigSnapshot().config.mode !== "local") throw new Error("resource");
    const nativeBytes = await readNativePreviewResource(path);
    if (!nativeBytes) throw new Error("resource");
    bytes = nativeBytes;
  }
  if (bytes.byteLength > MAX_PDF_BYTES) throw new Error("size");
  return bytes;
}
