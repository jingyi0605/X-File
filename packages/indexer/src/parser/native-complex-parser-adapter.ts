import type { ParseInput, ParsedDocumentPayload, ParserAvailability } from "./parser-adapter.js";
import { BaseComplexParserAdapter } from "./base-complex-parser-adapter.js";
import {
  isNativeParserCliAvailable,
  parseFileWithNativeParser,
  supportsNativeParserExtension,
} from "./native-parser-bridge.js";

/**
 * 桌面原生复杂文档解析适配器。
 * 默认主链优先走 Rust CLI；只有宿主没提供原生能力时才退回 Node 解析器。
 */
export class NativeComplexParserAdapter extends BaseComplexParserAdapter {
  readonly name = "native_complex_parser";

  supports(ext: string): boolean {
    return supportsNativeParserExtension(ext);
  }

  async availability(): Promise<ParserAvailability> {
    return await isNativeParserCliAvailable() ? "available" : "unavailable";
  }

  protected async parseComplex(input: ParseInput): Promise<ParsedDocumentPayload> {
    return await parseFileWithNativeParser({
      filePath: input.filePath,
      extension: input.extension,
    });
  }
}
