import { parseXlsxBytes } from "./xlsx-preview-parser";

self.onmessage = (event: MessageEvent<{ bytes: Uint8Array }>) => {
  try {
    const result = parseXlsxBytes(event.data.bytes);
    self.postMessage({ ok: true, result });
  } catch (error) {
    self.postMessage({
      ok: false,
      error: error instanceof Error ? error.message : "format",
    });
  }
};
