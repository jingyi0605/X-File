import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { unzipSync } from "fflate";
import "@fortune-sheet/react/dist/index.css";
import { LIBRARY_PREVIEW_BUDGETS } from "@x-file/shared";
import { t } from "../../i18n";
import {
  DEFAULT_PREVIEW_RESOURCE_MAX_BYTES,
  readPreviewResource,
} from "./preview-resource-controller";
import {
  parseXlsxBytes,
  type ParsedSpreadsheetSheet,
} from "./xlsx-preview-parser";

const MAX_COMPRESSED_BYTES = DEFAULT_PREVIEW_RESOURCE_MAX_BYTES;
const MAX_UNCOMPRESSED_BYTES = LIBRARY_PREVIEW_BUDGETS.xlsxMaxUncompressedBytes;
const MAX_ARCHIVE_ENTRIES = LIBRARY_PREVIEW_BUDGETS.xlsxMaxArchiveEntries;
const MAX_SLIDES = 500;
const FortuneSheetWorkbook = lazy(() => import("@fortune-sheet/react").then(({ Workbook }) => ({ default: Workbook })));

type OfficeContent =
  | { kind: "docx"; bytes: Uint8Array }
  | { kind: "xlsx"; sheets: XlsxSheet[] }
  | { kind: "pptx"; bytes: Uint8Array };

interface XlsxSheet {
  name: string;
  rows: string[][];
  fortuneData: FortuneSheetSheet;
  formulas: Map<string, string>;
  unsupportedFeatures: string[];
}

type FortuneSheetSheet = ParsedSpreadsheetSheet["fortuneData"];
type FortuneSheetCell = NonNullable<FortuneSheetSheet["data"][number][number]>;

interface PptxPresentationViewProps {
  bytes: Uint8Array;
  onError: (message: string) => void;
}

export default function OfficePreviewContent({
  fileName,
  previewUrl,
  relativePath,
  revision,
  resourceBytes,
  onError,
}: {
  fileName: string;
  previewUrl: string;
  relativePath: string;
  revision?: string;
  resourceBytes?: Uint8Array;
  onError: (message: string) => void;
}) {
  const [content, setContent] = useState<OfficeContent | null>(null);
  const [activeSheet, setActiveSheet] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setContent(null);
    setActiveSheet(0);
    void fetchOfficeContent(fileName, previewUrl, relativePath, controller.signal, revision, resourceBytes)
      .then((nextContent) => {
        if (!controller.signal.aborted) {
          setContent(nextContent);
          setLoading(false);
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setLoading(false);
          onError(toOfficeError(error));
        }
      });
    return () => controller.abort();
  }, [fileName, previewUrl, relativePath, revision, resourceBytes]);

  if (loading) return <div className="office-preview-state" role="status">{t("fileViewerOfficeLoading")}</div>;
  if (!content) return null;
  if (content.kind === "docx") return <DocxDocument bytes={content.bytes} onError={onError} />;
  if (content.kind === "xlsx") {
    const sheet = content.sheets[activeSheet];
    return (
      <div className="office-preview-workbook">
        <div className="office-preview-sheet-tabs" role="tablist" aria-label={t("fileViewerOfficeSheetLabel")}>
          {content.sheets.map((item, index) => (
            <button
              key={`${item.name}-${index}`}
              type="button"
              role="tab"
              aria-selected={index === activeSheet}
              className="office-preview-sheet-tab"
              onClick={() => setActiveSheet(index)}
            >
              {item.name}
            </button>
          ))}
        </div>
        {sheet ? <SpreadsheetGrid sheet={sheet} /> : null}
      </div>
    );
  }
  return <PptxPresentationView bytes={content.bytes} onError={onError} />;
}

async function fetchOfficeContent(
  fileName: string,
  previewUrl: string,
  relativePath: string,
  signal: AbortSignal,
  revision?: string,
  resourceBytes?: Uint8Array,
): Promise<OfficeContent> {
  const bytes = resourceBytes ?? await readPreviewResource({
    path: relativePath,
    previewUrl: previewUrl || null,
    maxBytes: MAX_COMPRESSED_BYTES,
    signal,
    revision,
  });
  if (signal.aborted) throw new Error("cancelled");
  const extension = fileName.split(".").pop()?.toLowerCase();
  if (extension === "pptx") return { kind: "pptx", bytes };
  if (extension === "xls" || extension === "xlsx") {
    return parseXlsxInWorker(bytes, signal);
  }

  let entryCount = 0;
  let uncompressedBytes = 0;
  const archive = unzipSync(bytes, {
    filter: (entry) => {
      entryCount += 1;
      uncompressedBytes += entry.originalSize;
      return entryCount <= 4000
        && entry.originalSize <= 48 * 1024 * 1024
        && uncompressedBytes <= 48 * 1024 * 1024;
    },
  });
  const entries = Object.entries(archive);
  if (entryCount > 4000
    || uncompressedBytes > 48 * 1024 * 1024
    || entries.some(([, value]) => value.byteLength > 48 * 1024 * 1024)) {
    throw new Error("size");
  }
  if (signal.aborted) throw new Error("cancelled");

  if (extension === "docx") {
    if (!archive["word/document.xml"]) throw new Error("format");
    return { kind: "docx", bytes };
  }
  throw new Error("format");
}

async function parseXlsxInWorker(bytes: Uint8Array, signal: AbortSignal): Promise<OfficeContent> {
  if (typeof Worker === "undefined" || import.meta.env.MODE === "test") {
    return parseXlsxOnMain(bytes);
  }

  const worker = new Worker(new URL("./xlsx-preview.worker.ts", import.meta.url), { type: "module" });
  const transferableBytes = bytes.slice();
  return await new Promise<OfficeContent>((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      worker.terminate();
      reject(new Error("timeout"));
    }, 20_000);
    const cleanup = () => {
      window.clearTimeout(timeoutId);
      signal.removeEventListener("abort", onAbort);
      worker.terminate();
    };
    const onAbort = () => {
      cleanup();
      reject(new Error("cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    worker.onmessage = (event: MessageEvent<{ ok: boolean; result?: { sheets: ParsedSpreadsheetSheet[] }; error?: string }>) => {
      cleanup();
      if (!event.data.ok || !event.data.result) {
        reject(new Error(event.data.error || "format"));
        return;
      }
      resolve({
        kind: "xlsx",
        sheets: event.data.result.sheets.map((sheet) => ({
          ...sheet,
          formulas: new Map(Object.entries(sheet.formulas)),
        })),
      });
    };
    worker.onerror = () => {
      cleanup();
      reject(new Error("format"));
    };
    worker.postMessage({ bytes: transferableBytes }, [transferableBytes.buffer]);
  });
}

async function parseXlsxOnMain(bytes: Uint8Array): Promise<OfficeContent> {
  const result = parseXlsxBytes(bytes);
  return {
    kind: "xlsx",
    sheets: result.sheets.map((sheet) => ({
      ...sheet,
      formulas: new Map(Object.entries(sheet.formulas)),
    })),
  };
}

function PptxPresentationView({ bytes, onError }: PptxPresentationViewProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const host = document.createElement("div");
    host.className = "office-preview-pptx-engine";
    mount.appendChild(host);

    let viewer: { destroy: () => void } | null = null;
    let cancelled = false;
    setLoading(true);
    setError(false);

    void import("@aiden0z/pptx-renderer").then(async ({
      buildPresentation,
      parseZipLazyMedia,
      PptxViewer,
      RECOMMENDED_ZIP_LIMITS,
    }) => {
      const zipLimits = {
        maxEntries: MAX_ARCHIVE_ENTRIES,
        maxEntryUncompressedBytes: MAX_UNCOMPRESSED_BYTES,
        maxTotalUncompressedBytes: MAX_UNCOMPRESSED_BYTES,
        maxMediaBytes: MAX_UNCOMPRESSED_BYTES,
        maxConcurrency: RECOMMENDED_ZIP_LIMITS.maxConcurrency,
      };
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      const files = await parseZipLazyMedia(buffer, zipLimits);
      if (files.slides.size > MAX_SLIDES) throw new Error("slide-limit");
      const presentation = buildPresentation(files, { lazySlides: true });
      const instance = new PptxViewer(host, {
        fitMode: "contain",
        externalMedia: "block",
        zipLimits,
        lazySlides: true,
        lazyMedia: true,
        scrollContainer: mount,
      });
      instance.load(presentation);
      await instance.renderList({
        windowed: true,
        initialSlides: 3,
        batchSize: 4,
        showSlideLabels: false,
      });
      if (cancelled) instance.destroy();
      else {
        viewer = instance;
        setLoading(false);
      }
    }).catch(() => {
      if (!cancelled) {
        setLoading(false);
        setError(true);
        onError(t("fileViewerOfficeUnavailable"));
      }
    });

    return () => {
      cancelled = true;
      viewer?.destroy();
      host.remove();
    };
  }, [bytes, onError]);

  if (error) {
    return (
      <div className="office-preview-state office-preview-error" role="status">
        <p>{t("fileViewerOfficeUnavailable")}</p>
      </div>
    );
  }
  return (
    <div ref={mountRef} className="office-preview-pptx-mount">
      {loading ? <div className="office-preview-pptx-loading" role="status">{t("fileViewerOfficeLoading")}</div> : null}
    </div>
  );
}

function SpreadsheetGrid({ sheet }: { sheet: XlsxSheet }) {
  const [selection, setSelection] = useState({ row: [0, 0], column: [0, 0] });
  const [copied, setCopied] = useState(false);
  const selectedAddress = selectionToAddress(selection);
  const selectedCell = sheet.fortuneData.data[selection.row[0]]?.[selection.column[0]] ?? null;

  async function copySelection(): Promise<void> {
    const text = selectionToText(sheet, selection);
    await navigator.clipboard?.writeText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }

  return (
    <div className="office-preview-spreadsheet">
      <div className="office-preview-spreadsheet-toolbar">
        <span className="office-preview-spreadsheet-address">{selectedAddress}</span>
        <output className="office-preview-spreadsheet-formula" aria-label={t("fileViewerOfficeFormulaBar")}>
          {sheet.formulas.get(selectedAddress) || selectedCell?.m || ""}
        </output>
        <button type="button" className="secondary-button" onClick={() => void copySelection()}>
          {copied ? t("fileViewerOfficeCopied") : t("fileViewerOfficeCopySelection")}
        </button>
      </div>
      {sheet.unsupportedFeatures.length ? (
        <p className="office-preview-spreadsheet-notice" role="status">
          {t("fileViewerOfficeUnsupportedFeatures")}
        </p>
      ) : null}
      <div className="office-preview-fortune-grid">
        <Suspense fallback={<div className="office-preview-state" role="status">{t("fileViewerOfficeLoading")}</div>}>
          <FortuneSheetWorkbook
            key={sheet.fortuneData.id}
            data={[sheet.fortuneData]}
            allowEdit={false}
            showToolbar={false}
            showFormulaBar={false}
            showSheetTabs={false}
            lang="zh"
            hooks={{
              afterSelectionChange: (
                _sheetId: string,
                nextSelection: { row: number[]; column: number[] },
              ) => {
                setSelection({
                  row: nextSelection.row ?? [0, 0],
                  column: nextSelection.column ?? [0, 0],
                });
              },
            }}
          />
        </Suspense>
      </div>
      <table className="office-preview-grid-accessibility">
        <tbody>
          {sheet.rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              <th scope="row">{rowIndex + 1}</th>
              {row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function DelimitedTextPreview({
  content,
  delimiter,
}: {
  content: string;
  delimiter: "\t" | ",";
}) {
  const sheet = useMemo(() => {
    const rows = parseDelimitedRows(content, delimiter);
    const columnCount = Math.max(1, Math.min(80, rows.reduce((max, row) => Math.max(max, row.length), 0)));
    const boundedRows = rows.slice(0, 500).map((row) => row.slice(0, columnCount));
    const data = boundedRows.map((row) => Array.from({ length: columnCount }, (_, columnIndex) => {
      const value = row[columnIndex] ?? "";
      return value ? { v: value, m: value } : null;
    }));
    return {
      name: delimiter === "\t" ? "TSV" : "CSV",
      rows: boundedRows,
      fortuneData: {
        id: `xfile-delimited-${delimiter}`,
        name: delimiter === "\t" ? "TSV" : "CSV",
        row: Math.max(1, boundedRows.length),
        column: columnCount,
        data,
        celldata: data.flatMap((dataRow, rowIndex) => dataRow.flatMap((cell, columnIndex) => (
          cell ? [{ r: rowIndex, c: columnIndex, v: cell }] : []
        ))),
        luckysheet_select_save: [{ row: [0, 0], column: [0, 0] }],
      },
      formulas: new Map<string, string>(),
      unsupportedFeatures: [],
    } satisfies XlsxSheet;
  }, [content, delimiter]);

  return <SpreadsheetGrid sheet={sheet} />;
}

function parseDelimitedRows(content: string, delimiter: "\t" | ","): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    const nextCharacter = content[index + 1];
    if (character === "\"") {
      if (quoted && nextCharacter === "\"") {
        cell += "\"";
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === delimiter && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && nextCharacter === "\n") index += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += character;
    }
  }

  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function selectionToAddress(selection: { row: number[]; column: number[] }): string {
  const row = selection.row[0] ?? 0;
  const column = selection.column[0] ?? 0;
  return `${columnName(column)}${row + 1}`;
}

function selectionToText(
  sheet: XlsxSheet,
  selection: { row: number[]; column: number[] },
): string {
  const startRow = selection.row[0] ?? 0;
  const endRow = selection.row[1] ?? startRow;
  const startColumn = selection.column[0] ?? 0;
  const endColumn = selection.column[1] ?? startColumn;
  return Array.from({ length: endRow - startRow + 1 }, (_, rowOffset) => (
    Array.from({ length: endColumn - startColumn + 1 }, (_, columnOffset) => (
      sheet.rows[startRow + rowOffset]?.[startColumn + columnOffset] ?? ""
    )).join("\t")
  )).join("\n");
}

function columnName(index: number): string {
  let value = index + 1;
  let name = "";
  while (value > 0) {
    value -= 1;
    name = String.fromCharCode(65 + (value % 26)) + name;
    value = Math.floor(value / 26);
  }
  return name;
}

function DocxDocument({ bytes, onError }: { bytes: Uint8Array; onError: (message: string) => void }) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const styleRef = useRef<HTMLDivElement | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const body = bodyRef.current;
    const styles = styleRef.current;
    if (!body || !styles) return;
    let cancelled = false;
    let resizeObserver: ResizeObserver | null = null;
    setLoading(true);
    void import("docx-preview").then(({ renderAsync }) => renderAsync(bytes, body, styles, {
      className: "xfile-docx",
      inWrapper: true,
      breakPages: true,
      ignoreWidth: false,
      ignoreHeight: false,
      renderAltChunks: false,
      renderComments: false,
    })).then(() => {
      if (cancelled) return;
      const fitPages = () => fitDocxPages(body);
      fitPages();
      if (typeof ResizeObserver !== "undefined") {
        resizeObserver = new ResizeObserver(fitPages);
        resizeObserver.observe(body);
      }
      setLoading(false);
    }).catch(() => {
      if (!cancelled) onError(t("fileViewerOfficeUnavailable"));
    });
    return () => {
      cancelled = true;
      resizeObserver?.disconnect();
      body.replaceChildren();
      styles.replaceChildren();
    };
  }, [bytes, onError]);

  return (
    <div className="office-preview-document">
      {loading ? <div className="office-preview-pptx-loading" role="status">{t("fileViewerOfficeLoading")}</div> : null}
      <div ref={styleRef} className="office-preview-docx-styles" />
      <div ref={bodyRef} className="office-preview-docx-body" />
    </div>
  );
}

function fitDocxPages(body: HTMLElement): void {
  const wrapper = body.querySelector<HTMLElement>(".xfile-docx-wrapper");
  if (!wrapper) return;
  const wrapperStyle = getComputedStyle(wrapper);
  const availableWidth = wrapper.clientWidth
    - parseFloat(wrapperStyle.paddingLeft || "0")
    - parseFloat(wrapperStyle.paddingRight || "0");
  if (!availableWidth) return;

  for (const page of Array.from(wrapper.querySelectorAll<HTMLElement>("section.xfile-docx"))) {
    page.style.transform = "none";
    page.style.transformOrigin = "top left";
    page.style.marginBottom = "";
    const pageRect = page.getBoundingClientRect();
    const naturalWidth = Math.max(page.offsetWidth, pageRect.width);
    const naturalHeight = Math.max(page.offsetHeight, pageRect.height);
    if (!naturalWidth || !naturalHeight) continue;
    const scale = Math.min(1, availableWidth / naturalWidth);
    const pageStyle = getComputedStyle(page);
    const naturalMarginBottom = parseFloat(pageStyle.marginBottom || "0");
    page.style.transform = `scale(${scale})`;
    page.style.marginBottom = `${naturalMarginBottom - (1 - scale) * naturalHeight}px`;
  }
}

function toOfficeError(error: unknown): string {
  if (error instanceof Error && error.message === "size") return "This file is too large to preview safely.";
  if (error instanceof Error && error.message === "resource") return t("fileViewerOfficeResourceUnavailable");
  return t("fileViewerOfficeUnavailable");
}
