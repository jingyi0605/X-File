import type { IndexedDocumentBatchEntry, ManualDocumentBindingTarget } from "../../repositories/catalog-write-repository.js";
import type { FileScanResult } from "../../scanner/file-scanner.js";
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
}

export interface TextIndexTagStore {
  captureBatchUpsertContexts(entries: IndexedDocumentBatchEntry[]): Map<string, TextIndexTagWriteContext>;
  batchUpsertDocuments(
    entries: IndexedDocumentBatchEntry[],
    observedAt?: string,
    contexts?: Map<string, TextIndexTagWriteContext>,
  ): Array<{ fileId: string; documentId: string }>;
  cleanupOrphanTags(): void;
}

interface ManualFileBindingRow {
  id: string;
  tagId: string;
  source: string;
  createdAt: string;
  updatedAt: string;
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
): FileIdentityMigrationCandidate | null {
  if (!fingerprint.inodeKey && !fingerprint.contentHash) {
    return null;
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

function resolveManualFileBindingsForTargetInConnection(
  db: LibraryIndexerDatabase,
  statements: TagStatements,
  target: ManualDocumentBindingTarget,
): ManualFileBindingRow[] {
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
): void {
  const existingManualTagRows = statements.selectManualDocumentTagsByDocumentId.all(target.documentId) as Array<Record<string, unknown>>;
  backfillManualFileBindingsFromLegacyDocumentBindingsInConnection(statements, target, observedAt);
  statements.deleteDocumentTagByDocumentAndSource.run(target.documentId, "manual_document");

  let manualBindings = resolveManualFileBindingsForTargetInConnection(db, statements, target);
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
    manualBindings = resolveManualFileBindingsForTargetInConnection(db, statements, target);
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

function applyTags(
  db: LibraryIndexerDatabase,
  statements: TagStatements,
  entry: IndexedDocumentBatchEntry,
  observedAt: string,
  tagCache: Map<string, string>,
  context: TextIndexTagWriteContext | undefined,
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
}): TextIndexTagStore {
  return {
    captureBatchUpsertContexts(entries): Map<string, TextIndexTagWriteContext> {
      const db = openConnection(input.dbPath, input.dbDriver ?? null);
      const statements = prepareStatements(db);
      try {
        const result = new Map<string, TextIndexTagWriteContext>();
        entries.forEach((entry) => {
          result.set(entry.file.relativePath, {
            previousManualBindingTarget: getActiveManualBindingTargetByPath(statements, entry.file.relativePath),
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
