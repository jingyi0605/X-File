import { createConverter } from "@deepseek-ai/libreoffice-kit";

const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath) process.exit(2);

const controller = new AbortController();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (value) => {
  if (value.includes("cancel")) controller.abort(new Error("cancelled"));
});

let converter;
try {
  converter = await createConverter({
    timeoutMs: 120_000,
    maxInputBytes: 20 * 1024 * 1024,
    maxOutputBytes: 20 * 1024 * 1024,
    maxArchiveEntries: 10_000,
    maxUncompressedBytes: 256 * 1024 * 1024,
    maxLoadedFontBytes: 128 * 1024 * 1024,
    fontMetadataCacheDirectory: false,
  });
  const result = await converter.render({ inputPath, outputPath }, controller.signal);
  process.stdout.write(JSON.stringify({
    pageCount: result.pageCount,
    backend: result.backend,
    missingFonts: result.missingFonts,
  }));
} catch (error) {
  console.error(error?.code ?? "failed", error?.message ?? String(error));
  process.exitCode = error?.code === "timeout" ? 124 : 1;
} finally {
  await converter?.dispose();
}
