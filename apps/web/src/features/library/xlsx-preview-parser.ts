import { Unzip, UnzipInflate, UnzipPassThrough } from "fflate";
import * as XLSX from "@e965/xlsx";
import { LIBRARY_PREVIEW_BUDGETS } from "@x-file/shared";

export const XLSX_PREVIEW_LIMITS = {
  maxSheets: LIBRARY_PREVIEW_BUDGETS.xlsxMaxSheets,
  maxRows: LIBRARY_PREVIEW_BUDGETS.xlsxMaxRows,
  maxColumns: LIBRARY_PREVIEW_BUDGETS.xlsxMaxColumns,
  maxCells: LIBRARY_PREVIEW_BUDGETS.xlsxMaxCells,
  maxArchiveEntries: LIBRARY_PREVIEW_BUDGETS.xlsxMaxArchiveEntries,
  maxUncompressedBytes: LIBRARY_PREVIEW_BUDGETS.xlsxMaxUncompressedBytes,
} as const;

export interface ParseXlsxOptions {
  sheetIndex?: number;
}

export interface ParsedSpreadsheetCell {
  v?: string | number | boolean;
  m?: string;
  fc?: string;
  fs?: number;
  ct?: { fa?: string; t?: string };
}

export interface ParsedSpreadsheetSheet {
  name: string;
  rows: string[][];
  fortuneData: {
    id: string;
    name: string;
    row: number;
    column: number;
    data: Array<Array<ParsedSpreadsheetCell | null>>;
    celldata: Array<{ r: number; c: number; v: ParsedSpreadsheetCell }>;
    luckysheet_select_save: Array<{ row: number[]; column: number[] }>;
  };
  formulas: Record<string, string>;
  unsupportedFeatures: string[];
}

export interface ParsedSpreadsheetWorkbook {
  sheetNames: string[];
  sheets: ParsedSpreadsheetSheet[];
}

export function parseXlsxBytes(
  bytes: Uint8Array,
  options: ParseXlsxOptions = {},
): ParsedSpreadsheetWorkbook {
  const archive = inspectZipMetadata(bytes);
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(bytes, {
      type: "array",
      cellDates: true,
      cellFormula: true,
      bookFiles: true,
    });
  } catch {
    throw new Error("format");
  }
  const workbookFiles = (workbook as unknown as {
    files?: Record<string, { content?: Uint8Array }>;
  }).files;
  const unsupportedFeatures = inspectWorkbookFiles(workbookFiles, archive.unsupportedFeatures);
  (workbook as unknown as { files?: unknown }).files = undefined;
  const sheetNames = workbook.SheetNames.slice(0, XLSX_PREVIEW_LIMITS.maxSheets);
  const requestedSheetIndex = options.sheetIndex === undefined
    ? 0
    : Math.max(0, Math.min(options.sheetIndex, sheetNames.length - 1));
  const sheets = sheetNames
    .map((name, sheetIndex) => ({ name, sheetIndex }))
    .filter(({ sheetIndex }) => sheetIndex === requestedSheetIndex)
    .map(({ name, sheetIndex }) => {
    const worksheet = workbook.Sheets[name];
    const reference = worksheet?.["!ref"];
    if (!worksheet || !reference) return createEmptySheet(name, sheetIndex, unsupportedFeatures);

    const range = XLSX.utils.decode_range(reference);
    const columnCount = Math.min(XLSX_PREVIEW_LIMITS.maxColumns, Math.max(1, range.e.c + 1));
    const rowCount = Math.min(
      XLSX_PREVIEW_LIMITS.maxRows,
      Math.max(1, Math.floor(XLSX_PREVIEW_LIMITS.maxCells / columnCount)),
      Math.max(1, range.e.r + 1),
    );
    const rows: string[][] = [];
    const data: Array<Array<ParsedSpreadsheetCell | null>> = [];
    const celldata: Array<{ r: number; c: number; v: ParsedSpreadsheetCell }> = [];
    const formulas: Record<string, string> = {};

    for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
      const row: string[] = [];
      const dataRow: Array<ParsedSpreadsheetCell | null> = [];
      for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
        const address = XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex });
        const cell = worksheet[address] as {
          v?: string | number | boolean | Date;
          w?: string;
          f?: string;
          z?: string;
          t?: string;
        } | undefined;
        const displayValue = cell ? formatCell(cell) : "";
        row.push(displayValue);
        if (!cell || (cell.v == null && !cell.f)) {
          dataRow.push(null);
          continue;
        }
        const formula = cell.f ? (cell.f.startsWith("=") ? cell.f : `=${cell.f}`) : undefined;
        if (formula) formulas[address] = formula;
        const previewCell: ParsedSpreadsheetCell = {
          v: cell.v instanceof Date ? cell.v.toISOString() : cell.v,
          m: displayValue,
          fc: "#000000",
          fs: 11,
          ct: cell.z ? { fa: cell.z, t: cell.t } : undefined,
        };
        dataRow.push(previewCell);
        celldata.push({ r: rowIndex, c: columnIndex, v: previewCell });
      }
      rows.push(row);
      data.push(dataRow);
    }

    return {
      name,
      rows,
      fortuneData: {
        id: `xfile-sheet-${sheetIndex}-${name}`,
        name,
        row: rowCount,
        column: columnCount,
        data,
        celldata,
        luckysheet_select_save: [{ row: [0, 0], column: [0, 0] }],
      },
      formulas,
      unsupportedFeatures,
    };
  });

  if (!sheets.length) throw new Error("format");
  return { sheetNames, sheets };
}

function formatCell(cell: {
  v?: string | number | boolean | Date;
  w?: string;
  z?: string;
}): string {
  if (typeof cell.w === "string") return cell.w;
  if (cell.v == null) return "";
  if (cell.v instanceof Date) return cell.v.toISOString();
  if (cell.z) return XLSX.utils.format_cell(cell as never);
  return String(cell.v);
}

function inspectZipMetadata(bytes: Uint8Array): {
  unsupportedFeatures: string[];
} {
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    return { unsupportedFeatures: [] };
  }

  let entryCount = 0;
  let totalUncompressedBytes = 0;
  let failure: Error | null = null;
  // Preflight the expanded byte budget before SheetJS allocates workbook structures.
  try {
    const unzip = new Unzip((entry) => {
      entryCount += 1;
      if (entryCount > XLSX_PREVIEW_LIMITS.maxArchiveEntries
        || (entry.originalSize ?? 0) > XLSX_PREVIEW_LIMITS.maxUncompressedBytes) {
        failure = new Error("size");
        entry.terminate();
        return;
      }
      let entryBytes = 0;
      entry.ondata = (error, chunk) => {
        if (error) {
          failure = new Error("format");
          return;
        }
        entryBytes += chunk.byteLength;
        totalUncompressedBytes += chunk.byteLength;
        if (entryBytes > XLSX_PREVIEW_LIMITS.maxUncompressedBytes
          || totalUncompressedBytes > XLSX_PREVIEW_LIMITS.maxUncompressedBytes) {
          failure = new Error("size");
          entry.terminate();
        }
      };
      entry.start();
    });
    unzip.register(UnzipPassThrough);
    unzip.register(UnzipInflate);
    unzip.push(bytes, true);
  } catch (error) {
    if (error instanceof Error && error.message === "size") throw error;
    throw new Error("format");
  }
  if (failure) throw failure;
  return { unsupportedFeatures: [] };
}

function inspectWorkbookFiles(
  files: Record<string, { content?: Uint8Array }> | undefined,
  initialFeatures: string[],
): string[] {
  const features = new Set(initialFeatures);
  const names = Object.keys(files ?? {});
  if (names.some((name) => name.startsWith("xl/charts/"))) features.add("charts");
  if (names.some((name) => name.startsWith("xl/media/"))) features.add("images");
  if (names.some((name) => name.startsWith("xl/drawings/"))) features.add("shapes");
  if (names.some((name) => name.includes("worksheets/") && name.endsWith(".xml"))) {
    for (const name of names) {
      if (!name.includes("worksheets/") || !name.endsWith(".xml")) continue;
      const content = files?.[name]?.content;
      if (content && new TextDecoder().decode(content).includes("conditionalFormatting")) {
        features.add("conditionalFormatting");
        break;
      }
    }
  }
  return [...features];
}

function createEmptySheet(name: string, sheetIndex: number, unsupportedFeatures: string[]): ParsedSpreadsheetSheet {
  return {
    name,
    rows: [],
    fortuneData: {
      id: `xfile-sheet-empty-${sheetIndex}-${name}`,
      name,
      row: 1,
      column: 1,
      data: [[null]],
      celldata: [],
      luckysheet_select_save: [{ row: [0, 0], column: [0, 0] }],
    },
    formulas: {},
    unsupportedFeatures,
  };
}
