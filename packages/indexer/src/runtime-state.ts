import fs from "node:fs";
import path from "node:path";
import type { LibraryRuntimeIndexState } from "@x-file/shared";

export type RuntimeIndexStateSnapshot = LibraryRuntimeIndexState;

export function readRuntimeIndexStateSnapshot(config: { indexDir: string }): RuntimeIndexStateSnapshot | null {
  const file = path.join(config.indexDir, "runtime/index-state.json");
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) as RuntimeIndexStateSnapshot : null;
}

export interface CatalogDocument {
  documentId: string;
  path: string;
  title: string;
  summary: string;
  tags: string[];
  derivedTags: string[];
  mtime: string;
}

export interface CatalogSnapshot {
  version: number;
  generatedAt: string;
  documents: CatalogDocument[];
  tags: Array<{ path: string; name: string; rootType: string; parentPath: string | null; depth: number }>;
}

const snapshots = new Map<string, { version: string; snapshot: CatalogSnapshot }>();

export function readCatalogSnapshot(root: string): CatalogSnapshot | null {
  const file = path.join(root, ".ai-index/runtime/export-catalog-snapshot.json");
  if (!fs.existsSync(file)) return null;
  const stat = fs.statSync(file, { bigint: true });
  const version = `${stat.ino}:${stat.mtimeNs}:${stat.size}`;
  const cached = snapshots.get(file);
  if (cached?.version === version) return cached.snapshot;
  const snapshot = JSON.parse(fs.readFileSync(file, "utf8")) as CatalogSnapshot;
  snapshots.set(file, { version, snapshot });
  return snapshot;
}
