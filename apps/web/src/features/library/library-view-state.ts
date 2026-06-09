import type { LibraryDocumentRecord } from "@x-file/shared";

import { readViewSnapshot, writeViewSnapshot } from "../../shared/view-snapshot";
import { getLocaleForIntl } from "../../i18n";

export type LibraryViewMode = "grid" | "list";
export type LibrarySortMode = "recent" | "name" | "type" | "size" | "createdAt";
export type LibrarySortDirection = "asc" | "desc";
export type FinderColumnKey = "name" | "size" | "updatedAt" | "type" | "createdAt";

export const FINDER_COLUMN_MIN_WIDTHS: Record<FinderColumnKey, number> = {
  name: 240,
  size: 88,
  updatedAt: 156,
  type: 120,
  createdAt: 156
};

export const DEFAULT_FINDER_COLUMN_WIDTHS: Record<FinderColumnKey, number> = {
  name: 320,
  size: 96,
  updatedAt: 176,
  type: 132,
  createdAt: 176
};

export interface LibrarySortState {
  mode: LibrarySortMode;
  direction: LibrarySortDirection;
}

export interface LibraryViewState {
  libraryId: string;
  browseMode: "folder" | "tag";
  viewMode: LibraryViewMode;
  selectedFolderPath: string | null;
  selectedFolderEntryPath: string | null;
  selectedTagPath: string | null;
  selectedTagPaths: string[];
  selectedDocumentId: string | null;
  selectedFavoriteId: string | null;
  keyword: string;
  librarySort: LibrarySortState;
  finderColumnWidths: Record<FinderColumnKey, number>;
}

export type LibraryEntry =
  | {
      kind: "folder";
      path: string;
      name: string;
      documentCount: number;
      updatedAt: string | null;
    }
  | ({
      kind: "document";
    } & LibraryDocumentRecord);

const DEFAULT_SORT: LibrarySortState = {
  mode: "recent",
  direction: "desc"
};

const DEFAULT_STATE: Omit<LibraryViewState, "libraryId"> = {
  browseMode: "folder",
  viewMode: "grid",
  selectedFolderPath: null,
  selectedFolderEntryPath: null,
  selectedTagPath: null,
  selectedTagPaths: [],
  selectedDocumentId: null,
  selectedFavoriteId: null,
  keyword: "",
  librarySort: DEFAULT_SORT,
  finderColumnWidths: DEFAULT_FINDER_COLUMN_WIDTHS
};

function buildStateKey(libraryId: string): string {
  return `x-file.library.view.${libraryId}`;
}

export function createDefaultLibraryViewState(libraryId = "default"): LibraryViewState {
  return {
    libraryId,
    ...DEFAULT_STATE
  };
}

export function readLibraryViewState(libraryId = "default"): LibraryViewState {
  const cached = readViewSnapshot<Partial<LibraryViewState>>(buildStateKey(libraryId));
  if (!cached) {
    return createDefaultLibraryViewState(libraryId);
  }

  return normalizeLibraryViewState(libraryId, cached);
}

export function writeLibraryViewState(state: LibraryViewState): void {
  writeViewSnapshot(buildStateKey(state.libraryId), normalizeLibraryViewState(state.libraryId, state));
}

export function normalizeLibrarySortState(value: Partial<LibrarySortState> | null | undefined): LibrarySortState {
  const mode = value?.mode;
  const direction = value?.direction;

  return {
    mode: mode === "recent" || mode === "name" || mode === "type" || mode === "size" || mode === "createdAt"
      ? mode
      : DEFAULT_SORT.mode,
    direction: direction === "asc" || direction === "desc" ? direction : DEFAULT_SORT.direction
  };
}

export function sortLibraryEntries(entries: LibraryEntry[], sort: LibrarySortState): LibraryEntry[] {
  const direction = sort.direction === "asc" ? 1 : -1;
  return [...entries].sort((left, right) => {
    if (left.kind !== right.kind) {
      return left.kind === "folder" ? -1 : 1;
    }

    const result = compareEntryValue(left, right, sort.mode);
    return result * direction;
  });
}

function normalizeLibraryViewState(libraryId: string, value: Partial<LibraryViewState>): LibraryViewState {
  return {
    libraryId,
    browseMode: value.browseMode === "tag" ? "tag" : "folder",
    viewMode: value.viewMode === "list" ? "list" : "grid",
    selectedFolderPath: normalizeNullable(value.selectedFolderPath),
    selectedFolderEntryPath: normalizeNullable(value.selectedFolderEntryPath),
    selectedTagPath: normalizeNullable(value.selectedTagPath),
    selectedTagPaths: Array.isArray(value.selectedTagPaths)
      ? value.selectedTagPaths.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : [],
    selectedDocumentId: normalizeNullable(value.selectedDocumentId),
    selectedFavoriteId: normalizeNullable(value.selectedFavoriteId),
    keyword: value.keyword?.trim() ?? "",
    librarySort: normalizeLibrarySortState(value.librarySort),
    finderColumnWidths: normalizeFinderColumnWidths(value.finderColumnWidths)
  };
}

export function normalizeFinderColumnWidths(
  value: Partial<Record<FinderColumnKey, number>> | null | undefined
): Record<FinderColumnKey, number> {
  return {
    name: normalizeFinderColumnWidth("name", value?.name),
    size: normalizeFinderColumnWidth("size", value?.size),
    updatedAt: normalizeFinderColumnWidth("updatedAt", value?.updatedAt),
    type: normalizeFinderColumnWidth("type", value?.type),
    createdAt: normalizeFinderColumnWidth("createdAt", value?.createdAt)
  };
}

function normalizeFinderColumnWidth(column: FinderColumnKey, value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_FINDER_COLUMN_WIDTHS[column];
  }
  const nextValue = value;
  return Math.max(FINDER_COLUMN_MIN_WIDTHS[column], Math.round(nextValue));
}

function normalizeNullable(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function compareEntryValue(left: LibraryEntry, right: LibraryEntry, mode: LibrarySortMode): number {
  if (mode === "name") {
    return getEntryName(left).localeCompare(getEntryName(right), getLocaleForIntl());
  }

  if (mode === "type") {
    return getEntryExtension(left).localeCompare(getEntryExtension(right), getLocaleForIntl());
  }

  if (mode === "size") {
    return getEntrySize(left) - getEntrySize(right);
  }

  if (mode === "createdAt") {
    return getTime(left.kind === "document" ? left.createdAt : null) - getTime(right.kind === "document" ? right.createdAt : null);
  }

  return getTime(getEntryUpdatedAt(left)) - getTime(getEntryUpdatedAt(right));
}

function getEntryName(entry: LibraryEntry): string {
  return entry.kind === "folder" ? entry.name : entry.title || entry.path;
}

function getEntryExtension(entry: LibraryEntry): string {
  if (entry.kind === "folder") {
    return "folder";
  }
  const dotIndex = entry.path.lastIndexOf(".");
  return dotIndex >= 0 ? entry.path.slice(dotIndex + 1).toLowerCase() : "";
}

function getEntrySize(entry: LibraryEntry): number {
  return entry.kind === "document" ? entry.sizeBytes ?? 0 : 0;
}

function getEntryUpdatedAt(entry: LibraryEntry): string | null {
  return entry.kind === "folder" ? entry.updatedAt : entry.updatedAt;
}

function getTime(value: string | null | undefined): number {
  if (!value) {
    return 0;
  }
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
}
