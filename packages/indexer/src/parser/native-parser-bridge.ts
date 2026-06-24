import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { AppError } from "../errors/app-error.js";
import { APP_ERROR_CODES } from "../errors/error-codes.js";
import type { ParseInput, ParsedDocumentPayload } from "./parser-adapter.js";

const execFileAsync = promisify(execFile);

const SUPPORTED_NATIVE_PARSER_EXTENSIONS = new Set([".docx", ".xlsx", ".pptx", ".pdf"]);

export interface NativeParserCliRequest {
  filePath: string;
  extension: string;
}

function normalizeExtension(extension: string): string {
  const normalized = extension.trim().toLowerCase();
  return normalized.startsWith(".") ? normalized : `.${normalized}`;
}

function resolveDesktopCliPath(): string | null {
  const explicit = process.env.X_FILE_DESKTOP_CLI_PATH?.trim();
  if (!explicit) {
    return null;
  }
  return fs.existsSync(explicit) ? explicit : null;
}

function validateParsedDocumentPayload(
  input: ParseInput,
  payload: unknown,
): ParsedDocumentPayload {
  if (!payload || typeof payload !== "object") {
    throw new AppError(
      `native parser 返回非法结果：${input.filePath}`,
      APP_ERROR_CODES.PARSER_COMPLEX_OUTPUT_INVALID,
    );
  }
  const candidate = payload as Partial<ParsedDocumentPayload>;
  if (
    typeof candidate.title !== "string"
    || typeof candidate.text !== "string"
    || typeof candidate.summary !== "string"
    || typeof candidate.parser !== "string"
  ) {
    throw new AppError(
      `native parser 返回字段不完整：${input.filePath}`,
      APP_ERROR_CODES.PARSER_COMPLEX_OUTPUT_INVALID,
    );
  }
  if (candidate.structured && !Array.isArray(candidate.structured.blocks)) {
    throw new AppError(
      `native parser structured.blocks 非法：${input.filePath}`,
      APP_ERROR_CODES.PARSER_COMPLEX_OUTPUT_INVALID,
    );
  }
  return candidate as ParsedDocumentPayload;
}

export async function isNativeParserCliAvailable(): Promise<boolean> {
  return resolveDesktopCliPath() !== null;
}

export function supportsNativeParserExtension(extension: string): boolean {
  return SUPPORTED_NATIVE_PARSER_EXTENSIONS.has(normalizeExtension(extension));
}

export async function parseFileWithNativeParser(
  input: NativeParserCliRequest,
): Promise<ParsedDocumentPayload> {
  const cliPath = resolveDesktopCliPath();
  if (!cliPath) {
    throw new AppError(
      "未检测到桌面原生 parser CLI",
      APP_ERROR_CODES.PARSER_ADAPTER_UNAVAILABLE,
    );
  }
  const normalizedExtension = normalizeExtension(input.extension);
  const request = {
    rootDir: input.filePath,
    targetPath: input.filePath,
    allowedExtensions: [normalizedExtension],
    reason: "native_complex_parser",
  };
  let stdout: string;
  try {
    const result = await execFileAsync(cliPath, [
      "library-worker",
      "parse-file",
      JSON.stringify(request),
    ], {
      cwd: path.dirname(cliPath),
      maxBuffer: 8 * 1024 * 1024,
    });
    stdout = result.stdout.trim();
  } catch (error) {
    throw new AppError(
      `native parser 执行失败：${input.filePath}`,
      APP_ERROR_CODES.PARSER_ADAPTER_UNAVAILABLE,
      { cause: error },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new AppError(
      `native parser 输出无法解析：${input.filePath}`,
      APP_ERROR_CODES.PARSER_COMPLEX_OUTPUT_INVALID,
      { cause: error },
    );
  }
  return validateParsedDocumentPayload(
    {
      filePath: input.filePath,
      extension: normalizedExtension,
    },
    parsed,
  );
}
