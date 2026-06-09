export type LibraryDocumentTone =
  | "neutral"
  | "slate"
  | "red"
  | "blue"
  | "green"
  | "orange"
  | "purple"
  | "amber"
  | "indigo"
  | "cyan"
  | "pink"
  | "teal";

export interface LibraryDocumentVisual {
  extension: string;
  badge: string;
  tone: LibraryDocumentTone;
}

const DOCUMENT_PRESETS: Array<[string[], Omit<LibraryDocumentVisual, "extension">]> = [
  [["md", "mdx"], { tone: "green", badge: "MD" }],
  [["txt", "text", "log", "rtf"], { tone: "slate", badge: "TXT" }],
  [["pdf"], { tone: "red", badge: "PDF" }],
  [["doc", "docx", "odt", "wps"], { tone: "blue", badge: "DOC" }],
  [["xls", "xlsx", "ods", "csv", "tsv"], { tone: "green", badge: "XLS" }],
  [["ppt", "pptx", "odp", "key"], { tone: "orange", badge: "PPT" }],
  [["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "heic"], { tone: "purple", badge: "IMG" }],
  [["zip", "rar", "7z", "tar", "gz"], { tone: "amber", badge: "ZIP" }],
  [["html", "htm"], { tone: "cyan", badge: "HTML" }],
  [["js", "jsx", "ts", "tsx", "py", "go", "rs", "sh", "vue"], { tone: "indigo", badge: "CODE" }],
  [["json"], { tone: "cyan", badge: "JSON" }],
  [["xml"], { tone: "cyan", badge: "XML" }],
  [["yaml", "yml", "toml", "ini"], { tone: "cyan", badge: "YAML" }],
  [["mp3", "wav", "flac", "m4a"], { tone: "pink", badge: "AUDIO" }],
  [["mp4", "mov", "mkv", "webm"], { tone: "teal", badge: "VIDEO" }]
];

const PRESET_MAP = new Map<string, Omit<LibraryDocumentVisual, "extension">>();

for (const [extensions, preset] of DOCUMENT_PRESETS) {
  for (const extension of extensions) {
    PRESET_MAP.set(extension, preset);
  }
}

export function resolveDocumentVisual(filePath: string): LibraryDocumentVisual {
  const extension = resolveExtension(filePath);
  const preset = PRESET_MAP.get(extension);
  if (preset) {
    return { extension, ...preset };
  }

  if (extension === "document") {
    return { extension, badge: "FILE", tone: "neutral" };
  }

  return {
    extension,
    badge: extension.slice(0, 4).toUpperCase(),
    tone: "neutral"
  };
}

function resolveExtension(filePath: string): string {
  const normalized = filePath.trim();
  const dotIndex = normalized.lastIndexOf(".");
  if (dotIndex < 0 || dotIndex === normalized.length - 1) {
    return "document";
  }
  return normalized.slice(dotIndex + 1).toLowerCase();
}
