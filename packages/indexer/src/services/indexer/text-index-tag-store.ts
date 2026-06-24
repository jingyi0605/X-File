import fs from "node:fs";
import path from "node:path";
import type { IndexedDocumentBatchEntry, ManualDocumentBindingTarget } from "../../repositories/catalog-write-repository.js";
import type { ExportTagRecord } from "../../repositories/catalog-repository.js";
import type { FileScanResult } from "../../scanner/file-scanner.js";
import type { RuntimeConfig } from "../../types/runtime-config.js";
import type { ExportCatalogSnapshot } from "../export/export-data-source.js";
import { resolveExportCatalogSnapshotPath } from "../export/export-data-source.js";
import {
  openDatabase,
  type LibraryIndexerDatabase,
  type LibraryIndexerDatabaseDriver,
  type LibraryIndexerStatement,
} from "../../sqlite/open-database.js";
import {
  buildDocumentIdentityFingerprint,
  buildIdentityContentKey,
  buildIdentityDocumentIdsByContent,
  buildIdentityDocumentIdsByInode,
  doesSiblingPathStillExist,
  hasSameManualBindingIdentity,
  makeStableId,
  normalizeFileIdentityValue,
  normalizeRelativePath,
  serializeManualFileBindingIdentity,
  type FileIdentityFingerprint,
} from "./text-index-write-helpers.js";

export interface TextIndexTagWriteContext {
  previousManualBindingTarget: ManualDocumentBindingTarget | null;
  resolvedManualTagPaths?: string[];
}

export interface TextIndexTagStore {
  captureBatchUpsertContexts(entries: IndexedDocumentBatchEntry[]): Map<string, TextIndexTagWriteContext>;
  batchUpsertDocuments(
    entries: IndexedDocumentBatchEntry[],
    observedAt?: string,
    contexts?: Map<string, TextIndexTagWriteContext>,
  ): Array<{ fileId: string; documentId: string }>;
  cleanupOrphanTags(): void;
  deleteTagsByPaths?(relativePaths: string[]): void;
}

interface RuntimeTagDocumentIdentityRecord {
  path: string;
  documentId: string;
  inodeKey: string | null;
  contentHash: string | null;
  size: number;
  extension: string;
  resolvedManualTagPaths?: string[];
}

interface RuntimeTagStateSnapshot {
  version: 1;
  generatedAt: string;
  documents: RuntimeTagDocumentIdentityRecord[];
}

interface RuntimeTagIdentityIndexes {
  documentsByPath: Map<string, RuntimeTagDocumentIdentityRecord>;
  documentsByDocumentId: Map<string, RuntimeTagDocumentIdentityRecord>;
  documentsByInodeKey: Map<string, RuntimeTagDocumentIdentityRecord[]>;
  documentsByContentKey: Map<string, RuntimeTagDocumentIdentityRecord[]>;
}

function normalizeTagPathList(values: Iterable<string>): string[] {
  return [...new Set(
    [...values]
      .map((item) => item.trim())
      .filter(Boolean),
  )].sort((left, right) => left.localeCompare(right, "zh-Hans-CN"));
}

function appendRuntimeIdentityRecord(
  map: Map<string, RuntimeTagDocumentIdentityRecord[]>,
  key: string | null,
  record: RuntimeTagDocumentIdentityRecord,
): void {
  if (!key) {
    return;
  }
  const list = map.get(key) ?? [];
  list.push(record);
  map.set(key, list);
}

function buildRuntimeTagIdentityIndexes(
  snapshotPath: string | null | undefined,
): RuntimeTagIdentityIndexes {
  const documentsByPath = new Map<string, RuntimeTagDocumentIdentityRecord>();
  const documentsByDocumentId = new Map<string, RuntimeTagDocumentIdentityRecord>();
  const documentsByInodeKey = new Map<string, RuntimeTagDocumentIdentityRecord[]>();
  const documentsByContentKey = new Map<string, RuntimeTagDocumentIdentityRecord[]>();

  if (!snapshotPath) {
    return {
      documentsByPath,
      documentsByDocumentId,
      documentsByInodeKey,
      documentsByContentKey,
    };
  }

  const runtimeState = readRuntimeTagStateSnapshot(snapshotPath);
  runtimeState.documents.forEach((rawRecord) => {
    const record: RuntimeTagDocumentIdentityRecord = {
      ...rawRecord,
      path: normalizeRelativePath(rawRecord.path),
      inodeKey: normalizeFileIdentityValue(rawRecord.inodeKey),
      contentHash: typeof rawRecord.contentHash === "string" && rawRecord.contentHash.trim()
        ? rawRecord.contentHash
        : null,
      resolvedManualTagPaths: normalizeTagPathList(rawRecord.resolvedManualTagPaths ?? []),
    };
    documentsByPath.set(record.path, record);
    documentsByDocumentId.set(record.documentId, record);
    appendRuntimeIdentityRecord(documentsByInodeKey, record.inodeKey, record);
    appendRuntimeIdentityRecord(
      documentsByContentKey,
      buildIdentityContentKey(record.contentHash, record.size, record.extension),
      record,
    );
  });

  return {
    documentsByPath,
    documentsByDocumentId,
    documentsByInodeKey,
    documentsByContentKey,
  };
}

function resolveRuntimeMigrationCandidate(
  indexes: RuntimeTagIdentityIndexes,
  file: FileScanResult,
  fingerprint: FileIdentityFingerprint,
): FileIdentityMigrationCandidate | null {
  const normalizedPath = normalizeRelativePath(file.relativePath);
  if (fingerprint.inodeKey) {
    const inodeMatches = (indexes.documentsByInodeKey.get(fingerprint.inodeKey) ?? [])
      .filter((record) => record.path !== normalizedPath);
    if (inodeMatches.length === 1) {
      const match = inodeMatches[0];
      return {
        fileId: makeStableId("file", match.path),
        path: match.path,
        documentId: match.documentId,
        inodeKey: match.inodeKey,
        contentHash: match.contentHash,
        size: match.size,
        extension: match.extension,
      };
    }
    if (inodeMatches.length > 1) {
      return null;
    }
  }

  const contentKey = buildIdentityContentKey(fingerprint.contentHash, file.size, file.extension);
  if (!contentKey) {
    return null;
  }
  const contentMatches = (indexes.documentsByContentKey.get(contentKey) ?? [])
    .filter((record) => record.path !== normalizedPath)
    .filter((record) => !doesSiblingPathStillExist(file, record.path));
  if (contentMatches.length !== 1) {
    return null;
  }
  const match = contentMatches[0];
  return {
    fileId: makeStableId("file", match.path),
    path: match.path,
    documentId: match.documentId,
    inodeKey: match.inodeKey,
    contentHash: match.contentHash,
    size: match.size,
    extension: match.extension,
  };
}

interface ManualFileBindingRow {
  id: string;
  tagId: string;
  source: string;
  createdAt: string;
  updatedAt: string;
}

interface ManualFileBindingResolveOptions {
  runtimeIndexes?: RuntimeTagIdentityIndexes | null;
  tagCache?: Map<string, string>;
  observedAt?: string;
}

interface FileIdentityMigrationCandidate {
  fileId: string;
  path: string;
  documentId: string;
  inodeKey: string | null;
  contentHash: string | null;
  size: number;
  extension: string;
}

interface TagStatements {
  insertTag: LibraryIndexerStatement;
  selectTagByPath: LibraryIndexerStatement;
  selectActiveFileIdentityByPath: LibraryIndexerStatement;
  updateFileIdentityByPath: LibraryIndexerStatement;
  selectUnseenIdentityCandidates: LibraryIndexerStatement;
  selectManualBindingsByDocumentId: LibraryIndexerStatement;
  insertManualDocumentBinding: LibraryIndexerStatement;
  deleteManualBindingByPair: LibraryIndexerStatement;
  selectManualDocumentTagsByDocumentId: LibraryIndexerStatement;
  selectManualFileBindingsForIdentity: LibraryIndexerStatement;
  selectManualFileBindingRowsForIdentity: LibraryIndexerStatement;
  insertManualFileBinding: LibraryIndexerStatement;
  deleteManualFileBindingById: LibraryIndexerStatement;
  deleteDocumentTagByDocumentAndSource: LibraryIndexerStatement;
  insertDocumentTag: LibraryIndexerStatement;
  insertDerivedTag: LibraryIndexerStatement;
  upsertDocumentTag: LibraryIndexerStatement;
  upsertDerivedTag: LibraryIndexerStatement;
  deleteDerivedDocumentTagByPair: LibraryIndexerStatement;
  selectDerivedTagIds: LibraryIndexerStatement;
  selectTagChildrenByParentId: LibraryIndexerStatement;
}

function openConnection(dbPath: string, dbDriver?: LibraryIndexerDatabaseDriver | null): LibraryIndexerDatabase {
  return dbDriver ? dbDriver.open(dbPath) : openDatabase(dbPath);
}

function prepareStatements(db: LibraryIndexerDatabase): TagStatements {
  return {
    insertTag: db.prepare(`
      INSERT OR IGNORE INTO tags(id, root_type, path, name, parent_id, canonical_name, description, status, created_by, created_at, updated_at, disabled_at)
      VALUES(?, ?, ?, ?, ?, ?, '', 'active', ?, ?, ?, NULL)
    `),
    selectTagByPath: db.prepare(`
      SELECT id, root_type, path, name, parent_id, canonical_name, description, status, created_by, created_at, updated_at, disabled_at
      FROM tags
      WHERE path = ?
    `),
    selectActiveFileIdentityByPath: db.prepare(`
      SELECT
        d.id AS document_id,
        f.inode_key,
        f.content_hash,
        f.size,
        f.extension
      FROM files f
      JOIN documents d ON d.file_id = f.id
      WHERE f.path = ?
        AND f.status = 'active'
        AND d.index_status IN ('indexed', 'failed', 'skipped')
    `),
    updateFileIdentityByPath: db.prepare(`
      UPDATE files
      SET inode_key = ?,
          content_hash = ?,
          last_seen_at = ?
      WHERE path = ?
    `),
    selectUnseenIdentityCandidates: db.prepare(`
      SELECT
        f.id AS file_id,
        f.path,
        f.inode_key,
        f.content_hash,
        f.size,
        f.extension,
        d.id AS document_id
      FROM files f
      JOIN documents d ON d.file_id = f.id
      WHERE f.status = 'active'
        AND d.index_status IN ('indexed', 'failed', 'skipped')
        AND f.path <> ?
        AND f.last_seen_at <> ?
        AND (
          (? IS NOT NULL AND f.inode_key = ?)
          OR (
            ? IS NOT NULL
            AND f.content_hash = ?
            AND f.size = ?
            AND f.extension = ?
          )
        )
      ORDER BY
        CASE
          WHEN ? IS NOT NULL AND f.inode_key = ? THEN 0
          ELSE 1
        END,
        f.last_seen_at DESC,
        f.path
    `),
    selectManualBindingsByDocumentId: db.prepare(`
      SELECT id, tag_id, source, created_at, updated_at
      FROM manual_document_tag_bindings
      WHERE document_id = ?
      ORDER BY tag_id
    `),
    insertManualDocumentBinding: db.prepare(`
      INSERT OR REPLACE INTO manual_document_tag_bindings(id, document_id, tag_id, source, created_at, updated_at)
      VALUES(?, ?, ?, ?, ?, ?)
    `),
    deleteManualBindingByPair: db.prepare(`
      DELETE FROM manual_document_tag_bindings
      WHERE document_id = ? AND tag_id = ?
    `),
    selectManualDocumentTagsByDocumentId: db.prepare(`
      SELECT tag_id, confidence, source_ref, evidence, manual_override, updated_at
      FROM document_tags
      WHERE document_id = ?
        AND source = 'manual_document'
      ORDER BY tag_id
    `),
    selectManualFileBindingsForIdentity: db.prepare(`
      SELECT id
      FROM manual_file_tag_bindings
      WHERE (? IS NOT NULL AND inode_key = ?)
         OR (
           ? IS NOT NULL
           AND inode_key IS NULL
           AND content_hash = ?
           AND file_size = ?
           AND extension = ?
         )
    `),
    selectManualFileBindingRowsForIdentity: db.prepare(`
      SELECT id, tag_id, source, created_at, updated_at
      FROM manual_file_tag_bindings
      WHERE (? IS NOT NULL AND inode_key = ?)
         OR (
           ? IS NOT NULL
           AND inode_key IS NULL
           AND content_hash = ?
           AND file_size = ?
           AND extension = ?
         )
      ORDER BY updated_at DESC, id
    `),
    insertManualFileBinding: db.prepare(`
      INSERT OR REPLACE INTO manual_file_tag_bindings(id, inode_key, content_hash, file_size, extension, tag_id, source, created_at, updated_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    deleteManualFileBindingById: db.prepare(`DELETE FROM manual_file_tag_bindings WHERE id = ?`),
    deleteDocumentTagByDocumentAndSource: db.prepare(`
      DELETE FROM document_tags
      WHERE document_id = ? AND source = ?
    `),
    insertDocumentTag: db.prepare(`
      INSERT INTO document_tags(id, document_id, tag_id, confidence, source, source_ref, evidence, manual_override, updated_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(document_id, tag_id) DO UPDATE SET
        confidence = excluded.confidence,
        source = excluded.source,
        source_ref = excluded.source_ref,
        evidence = excluded.evidence,
        manual_override = excluded.manual_override,
        updated_at = excluded.updated_at
    `),
    insertDerivedTag: db.prepare(`
      INSERT INTO derived_document_tags(id, document_id, tag_id, source, source_ref, rule_name, evidence, computed_at, updated_at, expires_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(document_id, tag_id) DO UPDATE SET
        source = excluded.source,
        source_ref = excluded.source_ref,
        rule_name = excluded.rule_name,
        evidence = excluded.evidence,
        computed_at = excluded.computed_at,
        updated_at = excluded.updated_at,
        expires_at = excluded.expires_at
    `),
    upsertDocumentTag: db.prepare(`
      INSERT INTO document_tags(id, document_id, tag_id, confidence, source, source_ref, evidence, manual_override, updated_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(document_id, tag_id) DO UPDATE SET
        confidence = excluded.confidence,
        source = excluded.source,
        source_ref = excluded.source_ref,
        evidence = excluded.evidence,
        manual_override = excluded.manual_override,
        updated_at = excluded.updated_at
    `),
    upsertDerivedTag: db.prepare(`
      INSERT INTO derived_document_tags(id, document_id, tag_id, source, source_ref, rule_name, evidence, computed_at, updated_at, expires_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(document_id, tag_id) DO UPDATE SET
        source = excluded.source,
        source_ref = excluded.source_ref,
        rule_name = excluded.rule_name,
        evidence = excluded.evidence,
        computed_at = excluded.computed_at,
        updated_at = excluded.updated_at,
        expires_at = excluded.expires_at
    `),
    deleteDerivedDocumentTagByPair: db.prepare(`
      DELETE FROM derived_document_tags
      WHERE document_id = ? AND tag_id = ?
    `),
    selectDerivedTagIds: db.prepare(`SELECT tag_id FROM derived_document_tags WHERE document_id = ?`),
    selectTagChildrenByParentId: db.prepare(`SELECT id FROM tags WHERE parent_id = ?`),
  };
}

function ensureTag(
  statements: TagStatements,
  tagCache: Map<string, string>,
  tagPath: string,
  createdBy: string,
): string {
  const cached = tagCache.get(tagPath);
  if (cached) {
    return cached;
  }

  const existing = statements.selectTagByPath.get(tagPath) as { id?: string } | undefined;
  if (existing?.id) {
    tagCache.set(tagPath, existing.id);
    return existing.id;
  }

  const segments = tagPath.split("/").filter(Boolean);
  const rootType = segments[0] ?? "未分类";
  const parentPath = segments.length > 1 ? segments.slice(0, -1).join("/") : null;
  const parentId = parentPath ? ensureTag(statements, tagCache, parentPath, createdBy) : null;
  const name = segments[segments.length - 1] ?? rootType;
  const tagId = makeStableId("tag", tagPath);
  const now = new Date().toISOString();

  statements.insertTag.run(
    tagId,
    rootType,
    tagPath,
    name,
    parentId,
    name,
    createdBy,
    now,
    now,
  );
  tagCache.set(tagPath, tagId);
  return tagId;
}

function cleanupOrphanTags(db: LibraryIndexerDatabase): void {
  const selectOrphans = db.prepare(`
    SELECT t.id
    FROM tags t
    WHERE NOT EXISTS (SELECT 1 FROM tags child WHERE child.parent_id = t.id)
      AND NOT EXISTS (SELECT 1 FROM document_tags dt WHERE dt.tag_id = t.id)
      AND NOT EXISTS (SELECT 1 FROM derived_document_tags ddt WHERE ddt.tag_id = t.id)
      AND NOT EXISTS (SELECT 1 FROM tag_aliases ta WHERE ta.tag_id = t.id)
      AND NOT EXISTS (SELECT 1 FROM tag_rules tr WHERE tr.tag_id = t.id)
      AND NOT EXISTS (SELECT 1 FROM manual_document_tag_bindings mdtb WHERE mdtb.tag_id = t.id)
      AND NOT EXISTS (SELECT 1 FROM manual_file_tag_bindings mftb WHERE mftb.tag_id = t.id)
      AND NOT EXISTS (SELECT 1 FROM folder_tag_bindings ftb WHERE ftb.tag_id = t.id)
  `);
  const deleteTag = db.prepare(`DELETE FROM tags WHERE id = ?`);

  while (true) {
    const rows = selectOrphans.all() as Array<{ id: string }>;
    if (rows.length === 0) {
      return;
    }
    rows.forEach((row) => {
      deleteTag.run(row.id);
    });
  }
}

function buildManualBindingTarget(
  file: FileScanResult,
  fingerprint: FileIdentityFingerprint,
  documentId: string,
): ManualDocumentBindingTarget {
  return {
    documentId,
    inodeKey: fingerprint.inodeKey,
    contentHash: fingerprint.contentHash,
    size: file.size,
    extension: file.extension,
  };
}

function resolveMigrationCandidateInConnection(
  statements: TagStatements,
  file: FileScanResult,
  fingerprint: FileIdentityFingerprint,
  observedAt: string,
  runtimeIndexes?: RuntimeTagIdentityIndexes | null,
): FileIdentityMigrationCandidate | null {
  if (!fingerprint.inodeKey && !fingerprint.contentHash) {
    return null;
  }

  const runtimeCandidate = runtimeIndexes
    ? resolveRuntimeMigrationCandidate(runtimeIndexes, file, fingerprint)
    : null;
  if (runtimeCandidate) {
    return runtimeCandidate;
  }

  const normalizedPath = normalizeRelativePath(file.relativePath);
  const rows = statements.selectUnseenIdentityCandidates.all(
    normalizedPath,
    observedAt,
    fingerprint.inodeKey,
    fingerprint.inodeKey,
    fingerprint.contentHash,
    fingerprint.contentHash,
    file.size,
    file.extension,
    fingerprint.inodeKey,
    fingerprint.inodeKey,
  ) as Array<Record<string, unknown>>;

  if (rows.length === 0) {
    return null;
  }

  const candidates = rows.map((row) => ({
    fileId: String(row.file_id),
    path: String(row.path),
    documentId: String(row.document_id),
    inodeKey: normalizeFileIdentityValue(row.inode_key),
    contentHash: typeof row.content_hash === "string" && row.content_hash.trim() ? String(row.content_hash) : null,
    size: Number(row.size ?? 0),
    extension: String(row.extension ?? ""),
  }));

  const inodeMatches = fingerprint.inodeKey
    ? candidates.filter((candidate) => candidate.inodeKey === fingerprint.inodeKey)
    : [];
  if (inodeMatches.length === 1) {
    return inodeMatches[0];
  }
  if (inodeMatches.length > 1) {
    return null;
  }

  const contentMatches = fingerprint.contentHash
    ? candidates.filter((candidate) =>
      candidate.contentHash === fingerprint.contentHash
      && candidate.size === file.size
      && candidate.extension === file.extension
      && !doesSiblingPathStillExist(file, candidate.path))
    : [];
  return contentMatches.length === 1 ? contentMatches[0] : null;
}

function migrateManualBindingsInConnection(
  statements: TagStatements,
  previousDocumentId: string,
  nextDocumentId: string,
  observedAt: string,
): void {
  if (!previousDocumentId || !nextDocumentId || previousDocumentId === nextDocumentId) {
    return;
  }

  const bindingRows = statements.selectManualBindingsByDocumentId.all(previousDocumentId) as Array<Record<string, unknown>>;
  bindingRows.forEach((row) => {
    const tagId = String(row.tag_id);
    statements.insertManualDocumentBinding.run(
      makeStableId("manual_binding", `${nextDocumentId}:${tagId}`),
      nextDocumentId,
      tagId,
      String(row.source ?? "manual_document"),
      String(row.created_at ?? observedAt),
      observedAt,
    );
    statements.deleteManualBindingByPair.run(previousDocumentId, tagId);
  });

  const manualTagRows = statements.selectManualDocumentTagsByDocumentId.all(previousDocumentId) as Array<Record<string, unknown>>;
  manualTagRows.forEach((row) => {
    const tagId = String(row.tag_id);
    statements.upsertDocumentTag.run(
      makeStableId("doc_tag", `${nextDocumentId}:${tagId}`),
      nextDocumentId,
      tagId,
      Number(row.confidence ?? 1),
      "manual_document",
      typeof row.source_ref === "string" ? row.source_ref : null,
      typeof row.evidence === "string" ? row.evidence : "手动分配",
      Number(row.manual_override ?? 1) ? 1 : 0,
      observedAt,
    );
  });
}

function listManualFileBindingRowsForIdentityInConnection(
  statements: TagStatements,
  target: ManualDocumentBindingTarget,
): ManualFileBindingRow[] {
  if (!target.inodeKey && !target.contentHash) {
    return [];
  }

  const rows = statements.selectManualFileBindingRowsForIdentity.all(
    target.inodeKey,
    target.inodeKey,
    target.contentHash,
    target.contentHash,
    target.size,
    target.extension,
  ) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    id: String(row.id),
    tagId: String(row.tag_id),
    source: String(row.source ?? "manual_document"),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }));
}

function carryForwardManualFileBindingsForSameDocumentInConnection(
  statements: TagStatements,
  previousTarget: ManualDocumentBindingTarget | null,
  nextTarget: ManualDocumentBindingTarget,
  observedAt: string,
): void {
  if (!previousTarget || previousTarget.documentId !== nextTarget.documentId) {
    return;
  }
  if (hasSameManualBindingIdentity(previousTarget, nextTarget)) {
    return;
  }

  const existingNextRows = listManualFileBindingRowsForIdentityInConnection(statements, nextTarget);
  if (existingNextRows.length > 0) {
    return;
  }

  const previousRows = listManualFileBindingRowsForIdentityInConnection(statements, previousTarget);
  if (previousRows.length === 0) {
    return;
  }

  previousRows.forEach((row) => {
    statements.insertManualFileBinding.run(
      makeStableId("manual_file_binding", serializeManualFileBindingIdentity(nextTarget, row.tagId)),
      nextTarget.inodeKey,
      nextTarget.contentHash,
      nextTarget.size,
      nextTarget.extension,
      row.tagId,
      row.source,
      row.createdAt,
      observedAt,
    );
    statements.deleteManualFileBindingById.run(row.id);
  });
}

function listActiveDocumentIdentityRowsInConnection(
  db: LibraryIndexerDatabase,
  inodeKeys: string[],
  contentHashes: string[],
): Array<{ inodeKey: string | null; contentHash: string | null; size: number; extension: string }> {
  if (inodeKeys.length === 0 && contentHashes.length === 0) {
    return [];
  }

  const predicateParts: string[] = [];
  const params: string[] = [];
  if (inodeKeys.length > 0) {
    predicateParts.push(`f.inode_key IN (${inodeKeys.map(() => "?").join(", ")})`);
    params.push(...inodeKeys);
  }
  if (contentHashes.length > 0) {
    predicateParts.push(`f.content_hash IN (${contentHashes.map(() => "?").join(", ")})`);
    params.push(...contentHashes);
  }

  const rows = db.prepare(`
    SELECT f.inode_key, f.content_hash, f.size, f.extension
    FROM documents d
    JOIN files f ON f.id = d.file_id
    WHERE f.status = 'active'
      AND d.index_status = 'indexed'
      AND (${predicateParts.join(" OR ")})
  `).all(...params) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    inodeKey: normalizeFileIdentityValue(row.inode_key),
    contentHash: typeof row.content_hash === "string" && row.content_hash.trim() ? String(row.content_hash) : null,
    size: Number(row.size ?? 0),
    extension: String(row.extension ?? ""),
  }));
}

function resolveRuntimeManualTagPathsForTarget(
  target: ManualDocumentBindingTarget,
  runtimeIndexes?: RuntimeTagIdentityIndexes | null,
): string[] {
  const directRecord = runtimeIndexes?.documentsByDocumentId.get(target.documentId);
  if (directRecord?.resolvedManualTagPaths?.length) {
    return [...directRecord.resolvedManualTagPaths];
  }

  if (target.inodeKey) {
    const inodeMatches = (runtimeIndexes?.documentsByInodeKey.get(target.inodeKey) ?? [])
      .filter((record) => record.resolvedManualTagPaths?.length);
    if (inodeMatches.length === 1) {
      return [...(inodeMatches[0]?.resolvedManualTagPaths ?? [])];
    }
    if (inodeMatches.length > 1) {
      return [];
    }
  }

  const contentKey = buildIdentityContentKey(target.contentHash, target.size, target.extension);
  if (!contentKey) {
    return [];
  }
  const contentMatches = (runtimeIndexes?.documentsByContentKey.get(contentKey) ?? [])
    .filter((record) => record.resolvedManualTagPaths?.length);
  if (contentMatches.length !== 1) {
    return [];
  }
  return [...(contentMatches[0]?.resolvedManualTagPaths ?? [])];
}

function materializeRuntimeManualBindingsInConnection(
  statements: TagStatements,
  target: ManualDocumentBindingTarget,
  runtimeTagPaths: string[],
  tagCache: Map<string, string>,
  observedAt: string,
): ManualFileBindingRow[] {
  if (runtimeTagPaths.length === 0 || (!target.inodeKey && !target.contentHash)) {
    return [];
  }

  return normalizeTagPathList(runtimeTagPaths).map((tagPath) => {
    const tagId = ensureTag(statements, tagCache, tagPath, "manual_document");
    const bindingId = makeStableId("manual_file_binding", serializeManualFileBindingIdentity(target, tagId));
    statements.insertManualFileBinding.run(
      bindingId,
      target.inodeKey,
      target.contentHash,
      target.size,
      target.extension,
      tagId,
      "manual_document",
      observedAt,
      observedAt,
    );
    return {
      id: bindingId,
      tagId,
      source: "manual_document",
      createdAt: observedAt,
      updatedAt: observedAt,
    };
  });
}

function resolveManualFileBindingsForTargetInConnection(
  db: LibraryIndexerDatabase,
  statements: TagStatements,
  target: ManualDocumentBindingTarget,
  options: ManualFileBindingResolveOptions = {},
): ManualFileBindingRow[] {
  const runtimeTagPaths = resolveRuntimeManualTagPathsForTarget(target, options.runtimeIndexes);
  if (runtimeTagPaths.length > 0) {
    return materializeRuntimeManualBindingsInConnection(
      statements,
      target,
      runtimeTagPaths,
      options.tagCache ?? new Map<string, string>(),
      options.observedAt ?? new Date().toISOString(),
    );
  }

  if (!target.inodeKey && !target.contentHash) {
    return [];
  }

  const candidateRows = db.prepare(`
    SELECT id, inode_key, content_hash, file_size, extension, tag_id, source, created_at, updated_at
    FROM manual_file_tag_bindings
    WHERE (? IS NOT NULL AND inode_key = ?)
       OR (? IS NOT NULL AND content_hash = ? AND file_size = ? AND extension = ?)
    ORDER BY updated_at DESC, id
  `).all(
    target.inodeKey,
    target.inodeKey,
    target.contentHash,
    target.contentHash,
    target.size,
    target.extension,
  ) as Array<Record<string, unknown>>;

  if (candidateRows.length === 0) {
    return [];
  }

  const candidateInodeKeys = [...new Set(candidateRows
    .map((row) => normalizeFileIdentityValue(row.inode_key))
    .filter((value): value is string => Boolean(value)))];
  const candidateContentHashes = [...new Set(candidateRows
    .map((row) => typeof row.content_hash === "string" && row.content_hash.trim() ? String(row.content_hash) : null)
    .filter((value): value is string => Boolean(value)))];

  const activeIdentityRows = listActiveDocumentIdentityRowsInConnection(
    db,
    candidateInodeKeys,
    candidateContentHashes,
  );
  const activeDocIdsByInode = buildIdentityDocumentIdsByInode(activeIdentityRows);
  const activeDocIdsByContent = buildIdentityDocumentIdsByContent(activeIdentityRows);
  const targetContentKey = buildIdentityContentKey(target.contentHash, target.size, target.extension);

  return candidateRows
    .filter((row) => {
      const candidateInodeKey = normalizeFileIdentityValue(row.inode_key);
      if (candidateInodeKey && target.inodeKey && candidateInodeKey === target.inodeKey) {
        return true;
      }
      const candidateContentKey = buildIdentityContentKey(
        typeof row.content_hash === "string" && row.content_hash.trim() ? String(row.content_hash) : null,
        Number(row.file_size ?? 0),
        String(row.extension ?? ""),
      );
      if (!candidateContentKey || !targetContentKey || candidateContentKey !== targetContentKey) {
        return false;
      }
      const contentMatches = activeDocIdsByContent.get(candidateContentKey);
      if (contentMatches !== 1) {
        return false;
      }
      if (!candidateInodeKey) {
        return true;
      }
      return !activeDocIdsByInode.has(candidateInodeKey);
    })
    .map((row) => ({
      id: String(row.id),
      tagId: String(row.tag_id),
      source: String(row.source ?? "manual_document"),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }));
}

function backfillManualFileBindingsFromLegacyDocumentBindingsInConnection(
  statements: TagStatements,
  target: ManualDocumentBindingTarget,
  observedAt: string,
): void {
  if (!target.inodeKey && !target.contentHash) {
    return;
  }

  const existingIdentityRows = statements.selectManualFileBindingsForIdentity.all(
    target.inodeKey,
    target.inodeKey,
    target.contentHash,
    target.contentHash,
    target.size,
    target.extension,
  ) as Array<Record<string, unknown>>;
  if (existingIdentityRows.length > 0) {
    return;
  }

  const legacyRows = statements.selectManualBindingsByDocumentId.all(target.documentId) as Array<Record<string, unknown>>;
  legacyRows.forEach((row) => {
    const tagId = String(row.tag_id);
    statements.insertManualFileBinding.run(
      makeStableId("manual_file_binding", serializeManualFileBindingIdentity(target, tagId)),
      target.inodeKey,
      target.contentHash,
      target.size,
      target.extension,
      tagId,
      String(row.source ?? "manual_document"),
      String(row.created_at ?? observedAt),
      observedAt,
    );
  });
}

function syncManualResolvedTagsForDocumentInConnection(
  db: LibraryIndexerDatabase,
  statements: TagStatements,
  target: ManualDocumentBindingTarget,
  observedAt: string,
  runtimeIndexes?: RuntimeTagIdentityIndexes | null,
  tagCache: Map<string, string> = new Map(),
): void {
  const existingManualTagRows = statements.selectManualDocumentTagsByDocumentId.all(target.documentId) as Array<Record<string, unknown>>;
  backfillManualFileBindingsFromLegacyDocumentBindingsInConnection(statements, target, observedAt);
  statements.deleteDocumentTagByDocumentAndSource.run(target.documentId, "manual_document");

  let manualBindings = resolveManualFileBindingsForTargetInConnection(db, statements, target, {
    runtimeIndexes,
    tagCache,
    observedAt,
  });
  if (manualBindings.length === 0 && existingManualTagRows.length > 0 && (target.inodeKey || target.contentHash)) {
    existingManualTagRows.forEach((row) => {
      const tagId = String(row.tag_id);
      statements.insertManualFileBinding.run(
        makeStableId("manual_file_binding", serializeManualFileBindingIdentity(target, tagId)),
        target.inodeKey,
        target.contentHash,
        target.size,
        target.extension,
        tagId,
        "manual_document",
        String(row.updated_at ?? observedAt),
        observedAt,
      );
    });
    manualBindings = resolveManualFileBindingsForTargetInConnection(db, statements, target, {
      runtimeIndexes,
      tagCache,
      observedAt,
    });
  }

  manualBindings.forEach((binding) => {
    statements.upsertDocumentTag.run(
      makeStableId("doc_tag", `${target.documentId}:${binding.tagId}`),
      target.documentId,
      binding.tagId,
      1,
      "manual_document",
      binding.id,
      "手动分配",
      1,
      observedAt,
    );
  });
}

function resolveManualTagPathsForTargetInConnection(
  db: LibraryIndexerDatabase,
  statements: TagStatements,
  target: ManualDocumentBindingTarget,
  runtimeIndexes?: RuntimeTagIdentityIndexes | null,
): string[] {
  const runtimeTagPaths = resolveRuntimeManualTagPathsForTarget(target, runtimeIndexes);
  if (runtimeTagPaths.length > 0) {
    return normalizeTagPathList(runtimeTagPaths);
  }

  const manualFileBindings = resolveManualFileBindingsForTargetInConnection(db, statements, target, {
    runtimeIndexes,
  });
  if (manualFileBindings.length > 0) {
    const tagPaths = manualFileBindings.map((binding) => {
      const row = db.prepare(`SELECT path FROM tags WHERE id = ?`).get(binding.tagId) as { path?: string } | undefined;
      return typeof row?.path === "string" ? row.path : null;
    }).filter((value): value is string => Boolean(value));
    if (tagPaths.length > 0) {
      return [...new Set(tagPaths)].sort((left, right) => left.localeCompare(right, "zh-Hans-CN"));
    }
  }

  const legacyRows = statements.selectManualDocumentTagsByDocumentId.all(target.documentId) as Array<Record<string, unknown>>;
  const legacyTagIds = [...new Set(legacyRows.map((row) => String(row.tag_id ?? "")).filter(Boolean))];
  const tagPaths: string[] = [];
  for (const tagId of legacyTagIds) {
    const row = db.prepare(`SELECT path FROM tags WHERE id = ?`).get(tagId) as { path?: string } | undefined;
    if (typeof row?.path === "string" && row.path.trim()) {
      tagPaths.push(row.path);
    }
  }
  return [...new Set(tagPaths)].sort((left, right) => left.localeCompare(right, "zh-Hans-CN"));
}

function applyTags(
  db: LibraryIndexerDatabase,
  statements: TagStatements,
  entry: IndexedDocumentBatchEntry,
  observedAt: string,
  tagCache: Map<string, string>,
  context: TextIndexTagWriteContext | undefined,
  runtimeIndexes?: RuntimeTagIdentityIndexes | null,
): void {
  const documentId = makeStableId("doc", entry.file.relativePath);
  const normalizedPath = normalizeRelativePath(entry.file.relativePath);
  const fingerprint = buildDocumentIdentityFingerprint(entry.file, entry.document);
  const manualBindingTarget = buildManualBindingTarget(entry.file, fingerprint, documentId);

  statements.updateFileIdentityByPath.run(
    fingerprint.inodeKey,
    fingerprint.contentHash,
    observedAt,
    normalizedPath,
  );

  const migrationCandidate = resolveMigrationCandidateInConnection(
    statements,
    entry.file,
    fingerprint,
    observedAt,
    runtimeIndexes,
  );
  if (migrationCandidate) {
    migrateManualBindingsInConnection(
      statements,
      migrationCandidate.documentId,
      documentId,
      observedAt,
    );
  }

  carryForwardManualFileBindingsForSameDocumentInConnection(
    statements,
    context?.previousManualBindingTarget ?? null,
    manualBindingTarget,
    observedAt,
  );

  syncManualResolvedTagsForDocumentInConnection(
    db,
    statements,
    manualBindingTarget,
    observedAt,
    runtimeIndexes,
    tagCache,
  );

  entry.tags.forEach((tag) => {
    const tagId = ensureTag(statements, tagCache, tag.tagPath, tag.source.split("+")[0] || "rule");
    statements.upsertDocumentTag.run(
      makeStableId("doc_tag", `${documentId}:${tagId}`),
      documentId,
      tagId,
      tag.confidence,
      tag.source,
      null,
      tag.evidence,
      tag.manualOverride ? 1 : 0,
      observedAt,
    );
  });

  const existingDerivedTagRows = statements.selectDerivedTagIds.all(documentId) as Array<{ tag_id: string }>;
  const existingDerivedTagIds = new Set(existingDerivedTagRows.map((row) => String(row.tag_id)));
  const nextDerivedTagIds = new Set<string>();

  entry.derivedTags.forEach((tag) => {
    const tagId = ensureTag(statements, tagCache, tag.tagPath, tag.source);
    nextDerivedTagIds.add(tagId);
    statements.upsertDerivedTag.run(
      makeStableId("derived_tag", `${documentId}:${tagId}`),
      documentId,
      tagId,
      "system_derived",
      null,
      tag.source,
      tag.evidence,
      observedAt,
      observedAt,
    );
  });

  existingDerivedTagIds.forEach((tagId) => {
    if (!nextDerivedTagIds.has(tagId)) {
      statements.deleteDerivedDocumentTagByPair.run(documentId, tagId);
    }
  });
}

function getActiveManualBindingTargetByPath(
  statements: TagStatements,
  relativePath: string,
): ManualDocumentBindingTarget | null {
  const row = statements.selectActiveFileIdentityByPath.get(
    normalizeRelativePath(relativePath),
  ) as Record<string, unknown> | undefined;
  if (!row?.document_id) {
    return null;
  }
  return {
    documentId: String(row.document_id),
    inodeKey: normalizeFileIdentityValue(row.inode_key),
    contentHash: typeof row.content_hash === "string" && row.content_hash.trim() ? String(row.content_hash) : null,
    size: Number(row.size ?? 0),
    extension: String(row.extension ?? ""),
  };
}

export function createSqliteTextIndexTagStore(input: {
  dbPath: string;
  dbDriver?: LibraryIndexerDatabaseDriver | null;
  runtimeTagStateSnapshotPath?: string | null;
}): TextIndexTagStore {
  return {
    captureBatchUpsertContexts(entries): Map<string, TextIndexTagWriteContext> {
    const db = openConnection(input.dbPath, input.dbDriver ?? null);
      const statements = prepareStatements(db);
      const runtimeIndexes = buildRuntimeTagIdentityIndexes(input.runtimeTagStateSnapshotPath);
      try {
        const result = new Map<string, TextIndexTagWriteContext>();
        entries.forEach((entry) => {
          const previousManualBindingTarget = getActiveManualBindingTargetByPath(statements, entry.file.relativePath);
          const runtimeRecord = runtimeIndexes.documentsByPath.get(normalizeRelativePath(entry.file.relativePath));
          result.set(entry.file.relativePath, {
            previousManualBindingTarget,
            resolvedManualTagPaths: runtimeRecord?.resolvedManualTagPaths?.length
              ? [...runtimeRecord.resolvedManualTagPaths]
              : previousManualBindingTarget
                ? resolveManualTagPathsForTargetInConnection(
                  db,
                  statements,
                  previousManualBindingTarget,
                  runtimeIndexes,
                )
                : [],
          });
        });
        return result;
      } finally {
        db.close();
      }
    },
    batchUpsertDocuments(entries, observedAt = new Date().toISOString(), contexts = new Map()) {
      if (entries.length === 0) {
        return [];
      }

      const db = openConnection(input.dbPath, input.dbDriver ?? null);
      const statements = prepareStatements(db);
      const tagCache = new Map<string, string>();
      const runtimeIndexes = buildRuntimeTagIdentityIndexes(input.runtimeTagStateSnapshotPath);
      try {
        db.exec("BEGIN IMMEDIATE");
        const results = entries.map((entry) => {
          applyTags(
            db,
            statements,
            entry,
            observedAt,
            tagCache,
            contexts.get(entry.file.relativePath),
            runtimeIndexes,
          );
          return {
            fileId: makeStableId("file", entry.file.relativePath),
            documentId: makeStableId("doc", entry.file.relativePath),
          };
        });
        cleanupOrphanTags(db);
        db.exec("COMMIT");
        return results;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      } finally {
        db.close();
      }
    },
    cleanupOrphanTags(): void {
      const db = openConnection(input.dbPath, input.dbDriver ?? null);
      try {
        cleanupOrphanTags(db);
      } finally {
        db.close();
      }
    },
  };
}

function readTagSnapshot(snapshotPath: string): ExportCatalogSnapshot {
  if (!fs.existsSync(snapshotPath)) {
    return {
      version: 1,
      generatedAt: new Date().toISOString(),
      tags: [],
      documents: [],
    };
  }
  return JSON.parse(fs.readFileSync(snapshotPath, "utf-8")) as ExportCatalogSnapshot;
}

function writeTagSnapshot(snapshotPath: string, snapshot: ExportCatalogSnapshot): void {
  fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
  fs.writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf-8");
}

function resolveRuntimeTagStateSnapshotPath(config: RuntimeConfig): string {
  return path.join(config.indexDir, "runtime", "tag-state-snapshot.json");
}

function readRuntimeTagStateSnapshot(snapshotPath: string): RuntimeTagStateSnapshot {
  if (!fs.existsSync(snapshotPath)) {
    return {
      version: 1,
      generatedAt: new Date().toISOString(),
      documents: [],
    };
  }
  return JSON.parse(fs.readFileSync(snapshotPath, "utf-8")) as RuntimeTagStateSnapshot;
}

function writeRuntimeTagStateSnapshot(snapshotPath: string, snapshot: RuntimeTagStateSnapshot): void {
  fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
  fs.writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf-8");
}

function buildRuntimeTagDocumentMap(snapshotPath: string): Map<string, RuntimeTagDocumentIdentityRecord> {
  const runtimeState = readRuntimeTagStateSnapshot(snapshotPath);
  return new Map(
    runtimeState.documents.map((item) => [normalizeRelativePath(item.path), {
      ...item,
      path: normalizeRelativePath(item.path),
      resolvedManualTagPaths: normalizeTagPathList(item.resolvedManualTagPaths ?? []),
    }]),
  );
}

function buildTagTree(tagPaths: Iterable<string>): ExportTagRecord[] {
  const tagMap = new Map<string, ExportTagRecord>();
  for (const tagPath of tagPaths) {
    const segments = tagPath.split("/").map((item) => item.trim()).filter(Boolean);
    for (let index = 0; index < segments.length; index += 1) {
      const currentPath = segments.slice(0, index + 1).join("/");
      if (tagMap.has(currentPath)) {
        continue;
      }
      tagMap.set(currentPath, {
        path: currentPath,
        name: segments[index]!,
        rootType: segments[0]!,
        parentPath: index === 0 ? null : segments.slice(0, index).join("/"),
        depth: index,
      });
    }
  }
  return [...tagMap.values()].sort((left, right) => left.path.localeCompare(right.path, "zh-Hans-CN"));
}

export function createRuntimeTextIndexTagStore(
  config: RuntimeConfig,
  mirrorStore: TextIndexTagStore | null = null,
): TextIndexTagStore {
  const snapshotPath = resolveExportCatalogSnapshotPath(config);
  const runtimeTagStateSnapshotPath = resolveRuntimeTagStateSnapshotPath(config);
  return {
    captureBatchUpsertContexts(entries) {
      const runtimeDocumentMap = buildRuntimeTagDocumentMap(runtimeTagStateSnapshotPath);
      const fallbackContexts = mirrorStore?.captureBatchUpsertContexts(entries) ?? new Map();
      const contexts = new Map<string, TextIndexTagWriteContext>();
      for (const entry of entries) {
        const relativePath = normalizeRelativePath(entry.file.relativePath);
        const runtimeRecord = runtimeDocumentMap.get(relativePath);
        if (runtimeRecord) {
          contexts.set(entry.file.relativePath, {
            previousManualBindingTarget: {
              documentId: runtimeRecord.documentId,
              inodeKey: runtimeRecord.inodeKey,
              contentHash: runtimeRecord.contentHash,
              size: runtimeRecord.size,
              extension: runtimeRecord.extension,
            },
            resolvedManualTagPaths: [...(runtimeRecord.resolvedManualTagPaths ?? [])],
          });
          continue;
        }
        contexts.set(
          entry.file.relativePath,
          fallbackContexts.get(entry.file.relativePath) ?? {
            previousManualBindingTarget: null,
          },
        );
      }
      return contexts;
    },
    batchUpsertDocuments(entries, observedAt = new Date().toISOString(), contexts) {
      const snapshot = readTagSnapshot(snapshotPath);
      const runtimeState = readRuntimeTagStateSnapshot(runtimeTagStateSnapshotPath);
      const documentMap = new Map(snapshot.documents.map((item) => [normalizeRelativePath(item.path), item]));
      const runtimeDocumentMap = new Map(
        runtimeState.documents.map((item) => [normalizeRelativePath(item.path), item]),
      );
      for (const entry of entries) {
        const relativePath = normalizeRelativePath(entry.file.relativePath);
        const current = documentMap.get(relativePath);
        if (!current) {
          continue;
        }
        const documentId = makeStableId("doc", entry.file.relativePath);
        const fingerprint = buildDocumentIdentityFingerprint(entry.file, entry.document);
        const mergedManualTagPaths = [
          ...(runtimeDocumentMap.get(relativePath)?.resolvedManualTagPaths ?? []),
          ...(contexts?.get(entry.file.relativePath)?.resolvedManualTagPaths ?? []),
        ];
        const normalizedManualTagPaths = normalizeTagPathList(mergedManualTagPaths);
        current.tags = [...new Set([
          ...entry.tags.map((item) => item.tagPath),
          ...normalizedManualTagPaths,
        ])].sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
        current.derivedTags = entry.derivedTags.map((item) => item.tagPath).sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
        runtimeDocumentMap.set(relativePath, {
          path: relativePath,
          documentId,
          inodeKey: fingerprint.inodeKey,
          contentHash: fingerprint.contentHash,
          size: entry.file.size,
          extension: entry.file.extension,
          resolvedManualTagPaths: normalizedManualTagPaths,
        });
      }
      const allTagPaths = new Set<string>();
      for (const document of documentMap.values()) {
        for (const tagPath of document.tags) {
          allTagPaths.add(tagPath);
        }
        for (const tagPath of document.derivedTags) {
          allTagPaths.add(tagPath);
        }
      }
      writeTagSnapshot(snapshotPath, {
        version: 1,
        generatedAt: observedAt,
        tags: buildTagTree(allTagPaths),
        documents: [...documentMap.values()].sort((left, right) => left.path.localeCompare(right.path, "zh-Hans-CN")),
      });
      writeRuntimeTagStateSnapshot(runtimeTagStateSnapshotPath, {
        version: 1,
        generatedAt: observedAt,
        documents: [...runtimeDocumentMap.values()]
          .map((item) => ({
            ...item,
            resolvedManualTagPaths: normalizeTagPathList(item.resolvedManualTagPaths ?? []),
          }))
          .sort((left, right) => left.path.localeCompare(right.path, "zh-Hans-CN")),
      });
      return mirrorStore?.batchUpsertDocuments(entries, observedAt, contexts) ?? entries.map((entry) => ({
        fileId: makeStableId("file", entry.file.relativePath),
        documentId: makeStableId("doc", entry.file.relativePath),
      }));
    },
    cleanupOrphanTags(): void {
      const snapshot = readTagSnapshot(snapshotPath);
      const allTagPaths = new Set<string>();
      for (const document of snapshot.documents) {
        for (const tagPath of document.tags) {
          allTagPaths.add(tagPath);
        }
        for (const tagPath of document.derivedTags) {
          allTagPaths.add(tagPath);
        }
      }
      writeTagSnapshot(snapshotPath, {
        version: 1,
        generatedAt: new Date().toISOString(),
        tags: buildTagTree(allTagPaths),
        documents: snapshot.documents
          .slice()
          .sort((left, right) => left.path.localeCompare(right.path, "zh-Hans-CN")),
      });
      mirrorStore?.cleanupOrphanTags();
    },
    deleteTagsByPaths(relativePaths: string[]): void {
      const deleted = new Set(relativePaths.map((item) => normalizeRelativePath(item)).filter(Boolean));
      if (deleted.size === 0) {
        return;
      }
      const snapshot = readTagSnapshot(snapshotPath);
      const runtimeState = readRuntimeTagStateSnapshot(runtimeTagStateSnapshotPath);
      const documents = snapshot.documents
        .filter((item) => !deleted.has(normalizeRelativePath(item.path)))
        .sort((left, right) => left.path.localeCompare(right.path, "zh-Hans-CN"));
      const allTagPaths = new Set<string>();
      for (const document of documents) {
        for (const tagPath of document.tags) {
          allTagPaths.add(tagPath);
        }
        for (const tagPath of document.derivedTags) {
          allTagPaths.add(tagPath);
        }
      }
      writeTagSnapshot(snapshotPath, {
        version: 1,
        generatedAt: new Date().toISOString(),
        tags: buildTagTree(allTagPaths),
        documents,
      });
      writeRuntimeTagStateSnapshot(runtimeTagStateSnapshotPath, {
        version: 1,
        generatedAt: new Date().toISOString(),
        documents: runtimeState.documents
          .filter((item) => !deleted.has(normalizeRelativePath(item.path)))
          .sort((left, right) => left.path.localeCompare(right.path, "zh-Hans-CN")),
      });
      mirrorStore?.deleteTagsByPaths?.(relativePaths);
    },
  };
}
