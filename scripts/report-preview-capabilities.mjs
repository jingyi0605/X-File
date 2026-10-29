import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, "..");
const manifest = JSON.parse(fs.readFileSync(
  path.join(rootDir, "packages/shared/src/library-preview-capabilities.json"),
  "utf8",
));

const previewExtensions = new Set(manifest.formats.flatMap((format) => format.extensions));
const previewableExtensions = new Set(manifest.formats
  .filter((format) => format.previewable)
  .flatMap((format) => format.extensions));
const indexedExtensions = new Set([
  ...extractQuotedExtensions("apps/server/src/library/library-config-service.ts"),
  ...extractQuotedExtensions("apps/server/src/library/library-service.ts"),
]);
const visualExtensions = new Set(extractVisualExtensions(
  "apps/web/src/features/library/document-visual.ts",
));

function normalizeExtension(value) {
  const normalized = value.toLowerCase();
  return normalized.startsWith(".") ? normalized : `.${normalized}`;
}

function extractQuotedExtensions(relativePath) {
  const source = fs.readFileSync(path.join(rootDir, relativePath), "utf8");
  return [...source.matchAll(/"(\.[a-z0-9]+)"/gi)].map((match) => normalizeExtension(match[1]));
}

function extractVisualExtensions(relativePath) {
  const source = fs.readFileSync(path.join(rootDir, relativePath), "utf8");
  const block = source.match(/const DOCUMENT_PRESETS[\s\S]*?;\n\nconst PRESET_MAP/u)?.[0] ?? "";
  return [...block.matchAll(/\[\[([^\]]*)\]/gu)]
    .flatMap((match) => [...match[1].matchAll(/"([a-z0-9]+)"/gi)].map((item) => `.${item[1].toLowerCase()}`));
}

function difference(left, right) {
  return [...left].filter((value) => !right.has(value)).sort();
}

const report = {
  generatedAt: new Date().toISOString(),
  manifestExtensions: [...previewExtensions].sort(),
  previewableExtensions: [...previewableExtensions].sort(),
  indexedExtensions: [...indexedExtensions].sort(),
  visualExtensions: [...visualExtensions].sort(),
  indexedButUnsupported: difference(indexedExtensions, previewableExtensions),
  visualButUnsupported: difference(visualExtensions, previewableExtensions),
  previewableButNotIndexed: difference(previewableExtensions, indexedExtensions),
  previewableButNoVisual: difference(previewableExtensions, visualExtensions),
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
