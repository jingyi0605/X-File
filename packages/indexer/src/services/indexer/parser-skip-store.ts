import crypto from "node:crypto";

import {
  openDatabase,
  type LibraryIndexerDatabase,
  type LibraryIndexerDatabaseDriver,
  type LibraryIndexerStatement,
} from "../../sqlite/open-database.js";
import type {
  ParserSkipCatalogRecord,
  ParserSkipRecordInput,
} from "../../parser/parser-skip-repository.js";

export interface ParserSkipStore {
  beginSession(): void;
  endSession(): void;
  record(input: ParserSkipRecordInput): ParserSkipCatalogRecord;
  listRecent(limit?: number): ParserSkipCatalogRecord[];
}

function makeSkipKey(adapter: string, reasonCode: string, extension: string): string {
  const digest = crypto.createHash("sha1").update(`${adapter}:${reasonCode}:${extension}`).digest("hex").slice(0, 16);
  return `skip_${digest}`;
}

function normalizeSamplePaths(raw: string, candidatePath?: string, limit = 20): string[] {
  let values: string[] = [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      values = parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
    }
  } catch {
    values = [];
  }

  if (candidatePath && !values.includes(candidatePath)) {
    values.push(candidatePath);
  }

  return values.slice(0, limit);
}

export function createSqliteParserSkipStore(input: {
  dbPath: string;
  dbDriver?: LibraryIndexerDatabaseDriver | null;
}): ParserSkipStore {
  let activeDb: LibraryIndexerDatabase | null = null;
  let selectStatement: LibraryIndexerStatement | null = null;
  let upsertStatement: LibraryIndexerStatement | null = null;

  const openConnection = (): LibraryIndexerDatabase => (
    input.dbDriver
      ? input.dbDriver.open(input.dbPath)
      : openDatabase(input.dbPath)
  );

  const prepareSession = (db: LibraryIndexerDatabase): void => {
    selectStatement = db.prepare(`
      SELECT sample_paths_json, sample_count, total_count, first_seen_at
      FROM parser_skip_catalog
      WHERE skip_key = ?
    `);
    upsertStatement = db.prepare(`
      INSERT INTO parser_skip_catalog(
        skip_key, adapter, reason_code, extension, sample_paths_json, sample_count, total_count, last_message, first_seen_at, last_seen_at, last_run_at
      )
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(skip_key) DO UPDATE SET
        sample_paths_json = excluded.sample_paths_json,
        sample_count = excluded.sample_count,
        total_count = excluded.total_count,
        last_message = excluded.last_message,
        last_seen_at = excluded.last_seen_at,
        last_run_at = excluded.last_run_at
    `);
  };

  const withStatements = <T>(handler: (
    db: LibraryIndexerDatabase,
    select: LibraryIndexerStatement,
    upsert: LibraryIndexerStatement,
    ownsTransaction: boolean,
  ) => T): T => {
    if (activeDb && selectStatement && upsertStatement) {
      return handler(activeDb, selectStatement, upsertStatement, false);
    }

    const db = openConnection();
    prepareSession(db);
    try {
      return handler(db, selectStatement!, upsertStatement!, true);
    } finally {
      db.close();
      selectStatement = null;
      upsertStatement = null;
    }
  };

  return {
    beginSession(): void {
      if (activeDb) {
        return;
      }
      activeDb = openConnection();
      prepareSession(activeDb);
    },
    endSession(): void {
      if (!activeDb) {
        return;
      }
      activeDb.close();
      activeDb = null;
      selectStatement = null;
      upsertStatement = null;
    },
    record(inputRecord): ParserSkipCatalogRecord {
      const skipKey = makeSkipKey(inputRecord.adapter, inputRecord.reasonCode, inputRecord.extension);
      return withStatements((db, select, upsert, ownsTransaction) => {
        try {
          if (ownsTransaction) {
            db.exec("BEGIN IMMEDIATE");
          }

          const existing = select.get(skipKey) as {
            sample_paths_json?: string;
            sample_count?: number;
            total_count?: number;
            first_seen_at?: string;
          } | undefined;

          const samplePaths = normalizeSamplePaths(existing?.sample_paths_json ?? "[]", inputRecord.path);
          const sampleCount = samplePaths.length;
          const totalCount = Number(existing?.total_count ?? 0) + 1;
          const firstSeenAt = existing?.first_seen_at ?? inputRecord.observedAt;

          upsert.run(
            skipKey,
            inputRecord.adapter,
            inputRecord.reasonCode,
            inputRecord.extension,
            JSON.stringify(samplePaths),
            sampleCount,
            totalCount,
            inputRecord.message,
            firstSeenAt,
            inputRecord.observedAt,
            inputRecord.observedAt,
          );

          if (ownsTransaction) {
            db.exec("COMMIT");
          }
          return {
            skipKey,
            adapter: inputRecord.adapter,
            reasonCode: inputRecord.reasonCode,
            extension: inputRecord.extension,
            samplePaths,
            sampleCount,
            totalCount,
            lastMessage: inputRecord.message,
            firstSeenAt,
            lastSeenAt: inputRecord.observedAt,
            lastRunAt: inputRecord.observedAt,
          };
        } catch (error) {
          if (ownsTransaction) {
            db.exec("ROLLBACK");
          }
          throw error;
        }
      });
    },
    listRecent(limit = 100): ParserSkipCatalogRecord[] {
      const db = openConnection();
      try {
        const rows = db.prepare(`
          SELECT skip_key, adapter, reason_code, extension, sample_paths_json, sample_count, total_count, last_message, first_seen_at, last_seen_at, last_run_at
          FROM parser_skip_catalog
          ORDER BY last_seen_at DESC, extension ASC
          LIMIT ?
        `).all(limit) as Array<Record<string, unknown>>;

        return rows.map((row) => ({
          skipKey: String(row.skip_key),
          adapter: String(row.adapter),
          reasonCode: String(row.reason_code),
          extension: String(row.extension),
          samplePaths: normalizeSamplePaths(String(row.sample_paths_json ?? "[]")),
          sampleCount: Number(row.sample_count ?? 0),
          totalCount: Number(row.total_count ?? 0),
          lastMessage: row.last_message ? String(row.last_message) : null,
          firstSeenAt: String(row.first_seen_at),
          lastSeenAt: String(row.last_seen_at),
          lastRunAt: String(row.last_run_at),
        }));
      } finally {
        db.close();
      }
    },
  };
}
