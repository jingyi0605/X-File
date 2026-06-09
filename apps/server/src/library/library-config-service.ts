import type { LibraryConfig, SaveLibraryConfigInput } from "@x-file/shared";

import { LibraryError } from "./library-errors.js";
import type { LibraryBindingStore } from "../storage/library-binding-store.js";
import type { LibraryConfigStore } from "../storage/library-config-store.js";

const DEFAULT_ALLOWED_EXTENSIONS = [
  ".md",
  ".markdown",
  ".txt",
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx"
];

export class LibraryConfigService {
  constructor(
    private readonly bindingStore: LibraryBindingStore,
    private readonly configStore: LibraryConfigStore
  ) {}

  getConfig(): LibraryConfig {
    const binding = this.bindingStore.read();
    return {
      binding,
      mirrorRoot: binding?.mirrorRoot ?? null,
      allowedExtensions: binding?.allowedExtensions?.length ? binding.allowedExtensions : DEFAULT_ALLOWED_EXTENSIONS,
      includedHiddenPaths: binding?.includedHiddenPaths ?? [],
      folderOpenBehavior: binding?.folderOpenBehavior ?? "double_click",
      configRelativePath: binding?.configRelativePath ?? ".ai-index/doc-semantic-index.config.json",
      canWrite: binding !== null
    };
  }

  saveConfig(input: SaveLibraryConfigInput): LibraryConfig {
    const binding = this.bindingStore.read();
    if (!binding) {
      throw new LibraryError(400, "LIBRARY_NOT_BOUND", "请先绑定文档库根目录");
    }

    const updatedBinding = this.bindingStore.write({
      ...binding,
      mirrorRoot: normalizeNullablePath(input.mirrorRoot, binding.mirrorRoot),
      allowedExtensions: normalizeExtensions(input.allowedExtensions, binding.allowedExtensions),
      includedHiddenPaths: normalizeStringList(input.includedHiddenPaths, binding.includedHiddenPaths),
      folderOpenBehavior: input.folderOpenBehavior === "single_click" ? "single_click" : "double_click",
      updatedAt: new Date().toISOString()
    });

    this.configStore.writeForBinding(updatedBinding);
    return this.getConfig();
  }
}

function normalizeNullablePath(value: string | null | undefined, fallback: string | null): string | null {
  if (value === undefined) {
    return fallback;
  }

  const normalized = value?.trim() ?? "";
  return normalized ? normalized : null;
}

function normalizeExtensions(value: string[] | undefined, fallback: string[]): string[] {
  if (!Array.isArray(value)) {
    return fallback;
  }

  const items = value
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
    .map((item) => item.startsWith(".") ? item : `.${item}`);

  return Array.from(new Set(items));
}

function normalizeStringList(value: string[] | undefined, fallback: string[]): string[] {
  if (!Array.isArray(value)) {
    return fallback;
  }

  return Array.from(new Set(value.map((item) => item.trim().replaceAll("\\", "/")).filter(Boolean)));
}
