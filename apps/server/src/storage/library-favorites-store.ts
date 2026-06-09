import fs from "node:fs";
import path from "node:path";

import type { LibraryFavoriteRecord } from "@x-file/shared";

const STORE_FILE_NAME = "library-favorites.json";

export interface LibraryFavoritesStoreOptions {
  dataDir?: string;
}

interface StoredLibraryFavorites {
  libraryId: string;
  rootDir: string;
  favorites: LibraryFavoriteRecord[];
  updatedAt: string;
}

/**
 * 收藏是用户显式状态，不能像当前快照一样从索引导出里临时拼。
 * 用独立 store 持久化，避免刷新、重启后收藏全部丢失。
 */
export class LibraryFavoritesStore {
  private readonly filePath: string;

  constructor(options: LibraryFavoritesStoreOptions = {}) {
    this.filePath = path.join(resolveDataDir(options.dataDir), STORE_FILE_NAME);
  }

  read(libraryId: string, rootDir: string): LibraryFavoriteRecord[] {
    const all = this.readAll();
    return normalizeFavorites(all[storeKey(libraryId, rootDir)]?.favorites ?? []);
  }

  write(libraryId: string, rootDir: string, favorites: LibraryFavoriteRecord[]): LibraryFavoriteRecord[] {
    const all = this.readAll();
    const normalized = normalizeFavorites(favorites);
    all[storeKey(libraryId, rootDir)] = {
      libraryId,
      rootDir,
      favorites: normalized,
      updatedAt: new Date().toISOString()
    };
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, `${JSON.stringify(all, null, 2)}\n`, "utf8");
    return normalized;
  }

  private readAll(): Record<string, StoredLibraryFavorites> {
    if (!fs.existsSync(this.filePath)) {
      return {};
    }

    return JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Record<string, StoredLibraryFavorites>;
  }
}

function normalizeFavorites(favorites: LibraryFavoriteRecord[]): LibraryFavoriteRecord[] {
  const seen = new Set<string>();
  const result: LibraryFavoriteRecord[] = [];
  for (const favorite of favorites) {
    const kind = favorite.kind === "tag_filter" ? "tag_filter" : favorite.kind === "tag" ? "tag" : "folder";
    const pathValue = favorite.path?.trim();
    if (!pathValue && kind !== "folder") {
      continue;
    }
    const tagPaths = Array.isArray(favorite.tagPaths)
      ? Array.from(new Set(favorite.tagPaths.map((item) => item.trim()).filter(Boolean)))
      : undefined;
    const normalizedPath = kind === "tag_filter" ? (tagPaths?.join("|") || pathValue) : pathValue;
    const key = `${kind}:${normalizedPath}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push({
      kind,
      path: normalizedPath,
      label: favorite.label?.trim() || normalizedPath || "根目录",
      ...(kind === "tag_filter" ? { tagPaths: tagPaths?.length ? tagPaths : normalizedPath.split("|").filter(Boolean) } : {})
    });
  }
  return result;
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
