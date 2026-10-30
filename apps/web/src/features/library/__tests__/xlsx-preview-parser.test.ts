import { strToU8, zipSync } from "fflate";
import * as XLSX from "@e965/xlsx";
import { describe, expect, it } from "vitest";

import { parseXlsxBytes, XLSX_PREVIEW_LIMITS } from "../xlsx-preview-parser";

describe("xlsx preview parser", () => {
  it("preserves text and supplies an explicit visible text style for the grid renderer", () => {
    const worksheet = XLSX.utils.aoa_to_sheet([["合同案例一览表", "客户名称"], ["案例 001", "嘉略"]]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "合同案例一览表");
    const bytes = new Uint8Array(XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as ArrayBuffer);

    const parsed = parseXlsxBytes(bytes).sheets[0];

    expect(parsed.rows[0][0]).toBe("合同案例一览表");
    expect(parsed.fortuneData.data[0][0]).toMatchObject({
      v: "合同案例一览表",
      m: "合同案例一览表",
      fc: "#000000",
      fs: 11,
    });
    expect(parsed.fortuneData.celldata).toContainEqual({
      r: 0,
      c: 0,
      v: parsed.fortuneData.data[0][0],
    });
  });

  it("keeps sheet names while parsing only the requested sheet", () => {
    const first = XLSX.utils.aoa_to_sheet([["First"]]);
    const second = XLSX.utils.aoa_to_sheet([["Second"]]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, first, "First");
    XLSX.utils.book_append_sheet(workbook, second, "Second");
    const bytes = new Uint8Array(XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as ArrayBuffer);

    const parsed = parseXlsxBytes(bytes, { sheetIndex: 1 });

    expect(parsed.sheetNames).toEqual(["First", "Second"]);
    expect(parsed.sheets).toHaveLength(1);
    expect(parsed.sheets[0].name).toBe("Second");
    expect(parsed.sheets[0].rows[0][0]).toBe("Second");
  });

  it("rejects an archive whose expanded entry exceeds the safety budget before workbook parsing", () => {
    const oversizedEntry = strToU8("x".repeat(XLSX_PREVIEW_LIMITS.maxUncompressedBytes + 1));
    const bytes = zipSync({ "xl/sharedStrings.xml": oversizedEntry });

    expect(() => parseXlsxBytes(bytes)).toThrow("size");
  });

  it("rejects malformed ZIP input with a stable format error", () => {
    expect(() => parseXlsxBytes(Uint8Array.from([0x50, 0x4b, 0x03, 0x04]))).toThrow("format");
  });
});
