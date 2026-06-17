import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { FileScanResult } from "../../scanner/file-scanner.js";
import type { IndexedDocumentWritePayload, ManualDocumentBindingTarget } from "../../repositories/catalog-write-repository.js";

export interface FileIdentityFingerprint {
  inodeKey: string | null;
  contentHash: string | null;
}

export function makeStableId(prefix: string, value: string): string {
  const digest = crypto.createHash("sha1").update(value).digest("hex");
  return `${prefix}_${digest}`;
}

export function normalizeRelativePath(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}

export function normalizeFileIdentityValue(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized ? normalized : null;
}

export function buildDocumentContentHash(text: string): string | null {
  if (!text.trim()) {
    return null;
  }
  return crypto.createHash("sha1").update(text).digest("hex");
}

export function buildDocumentIdentityFingerprint(
  file: FileScanResult,
  document: IndexedDocumentWritePayload,
): FileIdentityFingerprint {
  return {
    inodeKey: normalizeFileIdentityValue(file.inodeKey),
    contentHash: buildDocumentContentHash(document.text),
  };
}

export function resolveRootDirFromFile(file: FileScanResult): string | null {
  const normalizedRelativePath = file.relativePath.split(path.sep).join("/");
  if (!normalizedRelativePath) {
    return path.dirname(file.fullPath);
  }
  const suffix = normalizedRelativePath.split("/").join(path.sep);
  if (!file.fullPath.endsWith(suffix)) {
    return path.dirname(file.fullPath);
  }
  const rootDir = file.fullPath.slice(0, file.fullPath.length - suffix.length);
  return rootDir.replace(/[\\/]$/, "") || path.parse(file.fullPath).root || null;
}

export function doesSiblingPathStillExist(file: FileScanResult, candidateRelativePath: string): boolean {
  const rootDir = resolveRootDirFromFile(file);
  if (!rootDir) {
    return true;
  }
  return fs.existsSync(path.join(rootDir, candidateRelativePath));
}

export function serializeManualFileBindingIdentity(target: ManualDocumentBindingTarget, tagId: string): string {
  return JSON.stringify({
    inodeKey: target.inodeKey ?? null,
    contentHash: target.contentHash ?? null,
    size: target.size,
    extension: target.extension,
    tagId,
  });
}

export function buildIdentityContentKey(
  contentHash: string | null,
  size: number,
  extension: string,
): string | null {
  if (!contentHash) {
    return null;
  }
  return `${contentHash}::${size}::${extension}`;
}

export function buildIdentityDocumentIdsByInode(
  rows: Array<{ inodeKey: string | null }>,
): Map<string, number> {
  const counts = new Map<string, number>();
  rows.forEach((row) => {
    if (!row.inodeKey) {
      return;
    }
    counts.set(row.inodeKey, (counts.get(row.inodeKey) ?? 0) + 1);
  });
  return counts;
}

export function buildIdentityDocumentIdsByContent(
  rows: Array<{ contentHash: string | null; size: number; extension: string }>,
): Map<string, number> {
  const counts = new Map<string, number>();
  rows.forEach((row) => {
    const key = buildIdentityContentKey(row.contentHash, row.size, row.extension);
    if (!key) {
      return;
    }
    counts.set(key, (counts.get(key) ?? 0) + 1);
  });
  return counts;
}

export function hasSameManualBindingIdentity(
  left: ManualDocumentBindingTarget,
  right: ManualDocumentBindingTarget,
): boolean {
  if (left.inodeKey && right.inodeKey) {
    return left.inodeKey === right.inodeKey;
  }
  return buildIdentityContentKey(left.contentHash, left.size, left.extension)
    === buildIdentityContentKey(right.contentHash, right.size, right.extension);
}
