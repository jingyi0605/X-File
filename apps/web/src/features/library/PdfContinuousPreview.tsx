import { useEffect, useRef, useState, type RefObject } from "react";
import type { PDFDocumentProxy, PDFDocumentLoadingTask, PDFPageProxy, RenderTask } from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

import { t } from "../../i18n";

const SCALE_OPTIONS = [0.75, 1, 1.25, 1.5] as const;

export function PdfContinuousPreview({
  bytes,
  path,
  maxPages,
  onError,
}: {
  bytes: Uint8Array;
  path: string;
  maxPages: number;
  onError?: () => void;
}) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [scale, setScale] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    let loadingTask: PDFDocumentLoadingTask | null = null;
    let documentProxy: PDFDocumentProxy | null = null;
    setLoading(true);
    setError(false);
    setPdf(null);
    setPageCount(0);
    setCurrentPage(1);
    setScale(null);

    void import("pdfjs-dist").then(({ getDocument, GlobalWorkerOptions }) => {
      GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
      loadingTask = getDocument({ data: bytes });
      return loadingTask.promise;
    }).then(async (document) => {
      if (document.numPages > maxPages) throw new Error("page-limit");
      if (cancelled) {
        await document.destroy();
        return;
      }
      documentProxy = document;
      setPdf(document);
      setPageCount(document.numPages);
      setLoading(false);
    }).catch(() => {
      if (!cancelled) {
        setLoading(false);
        setError(true);
        onError?.();
      }
    });

    return () => {
      cancelled = true;
      void loadingTask?.destroy();
      void documentProxy?.destroy();
    };
  }, [bytes, maxPages, onError]);

  function scrollToPage(pageNumber: number): void {
    const target = scrollRef.current?.querySelector<HTMLElement>(`[data-pdf-page="${pageNumber}"]`);
    target?.scrollIntoView?.({ block: "start", behavior: "smooth" });
    setCurrentPage(pageNumber);
  }

  if (error) return <div className="file-viewer-pdf-error" role="status">{t("fileViewerPdfUnavailable")}</div>;
  return (
    <section className="file-viewer-pdf-preview file-viewer-pdf-continuous" aria-label={path}>
      <header className="file-viewer-pdf-toolbar" aria-live="polite">
        <button
          className="secondary-button"
          type="button"
          disabled={loading || currentPage <= 1}
          onClick={() => scrollToPage(Math.max(1, currentPage - 1))}
        >
          {t("fileViewerPdfPrevious")}
        </button>
        <span>{loading ? t("fileViewerOfficeLoading") : `${currentPage} / ${pageCount}`}</span>
        <button
          className="secondary-button"
          type="button"
          disabled={loading || currentPage >= pageCount}
          onClick={() => scrollToPage(Math.min(pageCount, currentPage + 1))}
        >
          {t("fileViewerPdfNext")}
        </button>
        <div className="file-viewer-pdf-zoom-controls" aria-label={t("fileViewerPdfZoom")}>
          <button
            className="secondary-button"
            type="button"
            disabled={scale !== null && scale <= SCALE_OPTIONS[0]}
            onClick={() => setScale((current) => resolveZoom(current, -1))}
            aria-label={t("fileViewerPdfZoomOut")}
          >
            −
          </button>
          <button
            className="secondary-button"
            type="button"
            onClick={() => setScale(null)}
            aria-label={t("fileViewerPdfFit")}
          >
            {scale === null ? t("fileViewerPdfFit") : `${Math.round(scale * 100)}%`}
          </button>
          <button
            className="secondary-button"
            type="button"
            disabled={scale !== null && scale >= SCALE_OPTIONS[SCALE_OPTIONS.length - 1]}
            onClick={() => setScale((current) => resolveZoom(current, 1))}
            aria-label={t("fileViewerPdfZoomIn")}
          >
            +
          </button>
        </div>
      </header>
      <div ref={scrollRef} className="file-viewer-pdf-continuous-scroll">
        {pdf ? Array.from({ length: pageCount }, (_, index) => (
          <ContinuousPdfPage
            key={index + 1}
            pdf={pdf}
            pageNumber={index + 1}
            path={path}
            scale={scale}
            rootRef={scrollRef}
            onVisible={setCurrentPage}
          />
        )) : null}
      </div>
    </section>
  );
}

function ContinuousPdfPage({
  pdf,
  pageNumber,
  path,
  scale,
  rootRef,
  onVisible,
}: {
  pdf: PDFDocumentProxy;
  pageNumber: number;
  path: string;
  scale: number | null;
  rootRef: RefObject<HTMLDivElement | null>;
  onVisible: (pageNumber: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [visible, setVisible] = useState(false);
  const [containerWidth, setContainerWidth] = useState(0);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    if (typeof IntersectionObserver === "undefined") {
      const root = rootRef.current;
      if (!root) {
        setVisible(pageNumber === 1);
        if (pageNumber === 1) onVisible(pageNumber);
        return;
      }
      const checkVisibility = () => {
        const rootRect = root.getBoundingClientRect();
        const pageRect = container.getBoundingClientRect();
        const nearViewport = pageRect.bottom >= rootRect.top - 700 && pageRect.top <= rootRect.bottom + 700;
        setVisible(nearViewport);
        if (nearViewport && pageRect.top <= rootRect.top + rootRect.height / 2) onVisible(pageNumber);
      };
      checkVisibility();
      root.addEventListener("scroll", checkVisibility, { passive: true });
      window.addEventListener("resize", checkVisibility, { passive: true });
      return () => {
        root.removeEventListener("scroll", checkVisibility);
        window.removeEventListener("resize", checkVisibility);
      };
    }
    const observer = new IntersectionObserver(([entry]) => {
      const nextVisible = entry.isIntersecting;
      setVisible(nextVisible);
      if (nextVisible) {
        onVisible(pageNumber);
      }
    }, { root: rootRef.current, rootMargin: "700px 0px" });
    observer.observe(container);
    return () => {
      observer.disconnect();
    };
  }, [onVisible, pageNumber, rootRef]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !("ResizeObserver" in window)) return;
    const observer = new ResizeObserver(() => setContainerWidth(container.clientWidth));
    observer.observe(container);
    setContainerWidth(container.clientWidth);
    return () => observer.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!visible || !containerRef.current || !canvasRef.current) return;
    let cancelled = false;
    let page: PDFPageProxy | null = null;
    let renderTask: RenderTask | null = null;
    const renderedCanvas: { current: HTMLCanvasElement | null } = { current: null };
    void pdf.getPage(pageNumber).then((loadedPage) => {
      page = loadedPage;
      if (cancelled) return;
      const canvas = canvasRef.current;
      const context = canvas?.getContext("2d");
      if (!canvas || !context) throw new Error("canvas-unavailable");
      renderedCanvas.current = canvas;
      const width = containerWidth || containerRef.current?.clientWidth || 800;
      const base = loadedPage.getViewport({ scale: 1 });
      const fittedScale = Math.max(0.35, Math.min(1.6, (width - 32) / base.width));
      const viewport = loadedPage.getViewport({ scale: scale ?? fittedScale });
      const outputScale = Math.min(
        window.devicePixelRatio || 1,
        2,
        Math.sqrt(16_000_000 / (viewport.width * viewport.height)),
      );
      canvas.width = Math.ceil(viewport.width * outputScale);
      canvas.height = Math.ceil(viewport.height * outputScale);
      canvas.style.width = `${Math.ceil(viewport.width)}px`;
      canvas.style.height = `${Math.ceil(viewport.height)}px`;
      context.setTransform(outputScale, 0, 0, outputScale, 0, 0);
      renderTask = loadedPage.render({ canvas, viewport, background: "#ffffff" });
      return renderTask.promise;
    }).catch(() => undefined);
    return () => {
      cancelled = true;
      renderTask?.cancel();
      page?.cleanup?.();
      if (renderedCanvas.current) {
        renderedCanvas.current.width = 0;
        renderedCanvas.current.height = 0;
        renderedCanvas.current.style.width = "";
        renderedCanvas.current.style.height = "";
      }
    };
  }, [containerWidth, pageNumber, pdf, scale, visible]);

  return (
    <div
      ref={containerRef}
      data-pdf-page={pageNumber}
      className="file-viewer-pdf-continuous-page"
      aria-label={`${path}, ${pageNumber}`}
    >
      {visible ? <canvas ref={canvasRef} /> : <span aria-hidden="true">{pageNumber}</span>}
    </div>
  );
}

function resolveZoom(current: number | null, direction: -1 | 1): number {
  const currentIndex = current === null ? 1 : Math.max(0, SCALE_OPTIONS.indexOf(current as typeof SCALE_OPTIONS[number]));
  return SCALE_OPTIONS[Math.min(SCALE_OPTIONS.length - 1, Math.max(0, currentIndex + direction))];
}
