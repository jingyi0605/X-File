import { parseXlsxBytes } from "./xlsx-preview-parser";

self.onmessage = (event: MessageEvent<{ bytes: Uint8Array; sheetIndex?: number }>) => {
  try {
    const result = parseXlsxBytes(event.data.bytes, {
      sheetIndex: event.data.sheetIndex,
    });
    self.postMessage({ ok: true, result });
  } catch (error) {
    self.postMessage({
      ok: false,
      error: error instanceof Error ? error.message : "format",
    });
  }
};
