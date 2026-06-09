import fs from "node:fs";
import path from "node:path";

export interface StoredTagDefinition {
  id: string;
  path: string;
  name: string;
  rootType: string;
  parentId: string | null;
  parentPath: string | null;
  description: string | null;
  status: "active" | "disabled";
  createdAt: string;
  updatedAt: string;
  disabledAt: string | null;
}

export interface StoredDocumentTagBinding {
  documentId: string;
  path: string;
  title: string;
  manualTagIds: string[];
  updatedAt: string;
}

export interface StoredFolderTagBinding {
  folderPath: string;
  bindingTagIds: string[];
  updatedAt: string;
}

export interface StoredLibraryTags {
  libraryId: string;
  rootDir: string;
  tags: StoredTagDefinition[];
  documentTags: StoredDocumentTagBinding[];
  folderTags: StoredFolderTagBinding[];
  updatedAt: string;
}

export interface TagStoreOptions {
  dataDir?: string;
}

const STORE_FILE_NAME = "library-tags.json";

export class TagStore {
  private readonly filePath: string;

  constructor(options: TagStoreOptions = {}) {
    this.filePath = path.join(resolveDataDir(options.dataDir), STORE_FILE_NAME);
  }

  read(libraryId: string, rootDir: string): StoredLibraryTags {
    const all = this.readAll();
    return all[storeKey(libraryId, rootDir)] ?? createEmptyStore(libraryId, rootDir);
  }

  write(data: StoredLibraryTags): StoredLibraryTags {
    const all = this.readAll();
    all[storeKey(data.libraryId, data.rootDir)] = {
      ...data,
      updatedAt: new Date().toISOString()
    };
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, `${JSON.stringify(all, null, 2)}\n`, "utf8");
    return all[storeKey(data.libraryId, data.rootDir)];
  }

  private readAll(): Record<string, StoredLibraryTags> {
    if (!fs.existsSync(this.filePath)) {
      return {};
    }

    return JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Record<string, StoredLibraryTags>;
  }
}

function createEmptyStore(libraryId: string, rootDir: string): StoredLibraryTags {
  return {
    libraryId,
    rootDir,
    tags: [],
    documentTags: [],
    folderTags: [],
    updatedAt: new Date().toISOString()
  };
}

function storeKey(libraryId: string, rootDir: string): string {
  return `${libraryId}:${rootDir}`;
}

function resolveDataDir(explicitDataDir: string | undefined): string {
  if (explicitDataDir?.trim()) {
    return explicitDataDir;
  }

  if (process.env.X_FILE_DATA_DIR?.trim()) {
    return process.env.X_FILE_DATA_DIR;
  }

  return path.join(process.cwd(), ".x-file");
}
