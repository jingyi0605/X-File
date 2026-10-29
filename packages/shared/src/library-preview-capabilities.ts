import manifest from "./library-preview-capabilities.json" with { type: "json" };

export type PreviewResourceClass = "text" | "resource";

export interface LibraryPreviewFormatDefinition {
  extensions: readonly string[];
  previewKind: "text" | "markdown" | "html" | "image" | "pdf" | "office" | "unsupported";
  adapterFamily: string;
  previewable: boolean;
  editable: boolean;
  resourceClass: PreviewResourceClass;
  nativeBytes?: boolean;
}

export const LIBRARY_PREVIEW_CAPABILITIES = manifest;
export const LIBRARY_PREVIEW_FORMATS = manifest.formats as readonly LibraryPreviewFormatDefinition[];
export const LIBRARY_PREVIEW_BUDGETS = manifest.budgets;
export const LIBRARY_PREVIEW_CONTENT_TYPES: Readonly<Record<string, string>> = manifest.contentTypes;

const extensionDefinitions = new Map<string, LibraryPreviewFormatDefinition>();
for (const definition of LIBRARY_PREVIEW_FORMATS) {
  for (const extension of definition.extensions) {
    if (extensionDefinitions.has(extension)) {
      throw new Error(`Duplicate preview extension in capability manifest: ${extension}`);
    }
    extensionDefinitions.set(extension, definition);
  }
}

export function resolveLibraryPreviewFormat(filePath: string): LibraryPreviewFormatDefinition | null {
  const baseName = filePath.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  const dotFileDefinition = extensionDefinitions.get(baseName);
  if (baseName.startsWith(".") && dotFileDefinition) return dotFileDefinition;
  const dotIndex = baseName.lastIndexOf(".");
  if (dotIndex <= 0) return null;
  return extensionDefinitions.get(baseName.slice(dotIndex)) ?? null;
}

export function listLibraryPreviewExtensions(): string[] {
  return [...extensionDefinitions.keys()].sort();
}
