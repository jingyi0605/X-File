import fs from "node:fs";
import path from "node:path";
import type {
  ParseInput,
  ParsedDocumentPayload,
  ParserAdapter,
  ParserAvailability,
} from "./parser-adapter.js";

const SUPPORTED_TEXT_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".mdx",
  ".txt",
  ".rtf",
  ".html",
  ".htm",
  ".xml",
  ".json",
  ".yaml",
  ".yml",
  ".tsv",
  ".csv",
]);

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function shortSummary(text: string, limit = 180): string {
  const normalized = normalizeWhitespace(text);
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 1)}…`;
}

function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        index += 1;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }

    if (char === "," && !inQuotes) {
      cells.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  cells.push(current.trim());
  return cells;
}

function buildCsvText(raw: string): string {
  const lines = raw
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .slice(0, 200);
  return lines.map(line => splitCsvLine(line).join(" ")).join("\n");
}

/**
 * 轻量文本解析适配器。
 */
export class PlainTextParserAdapter implements ParserAdapter {
  readonly name = "plain_text";

  supports(ext: string): boolean {
    return SUPPORTED_TEXT_EXTENSIONS.has(ext.toLowerCase());
  }

  async availability(): Promise<ParserAvailability> {
    return "available";
  }

  async parse(input: ParseInput): Promise<ParsedDocumentPayload> {
    const raw = fs.readFileSync(input.filePath, "utf-8");
    const title = path.basename(input.filePath, input.extension);
    const text = input.extension === ".csv" ? buildCsvText(raw) : raw;

    return {
      title,
      text,
      summary: shortSummary(text),
      parser: input.extension === ".html" || input.extension === ".htm"
        ? "html_fallback"
        : input.extension === ".csv"
          ? "csv"
        : input.extension === ".json" || input.extension === ".yaml" || input.extension === ".yml" || input.extension === ".xml"
          ? "structured_text_fallback"
          : "plain_text",
      metadata: {
        adapter: this.name,
      },
    };
  }
}
