import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const runtimeRequire = createRequire(import.meta.url);
const registeredDefaultDriverSymbol = Symbol.for("x-file.indexer.sqlite.default-driver");
const registeredDefaultDriverResolverSymbol = Symbol.for("x-file.indexer.sqlite.default-driver-resolver");

export interface OpenDatabaseOptions {
  tempStore?: "FILE" | "MEMORY";
}

export interface LibraryIndexerRunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

/**
 * indexer 只需要同步 SQL 的最小接口。
 * 不直接暴露 better-sqlite3 的完整 Statement 类型，避免它的绑定参数类型把运行时允许的多参数调用误报成错误。
 */
export interface LibraryIndexerStatement {
  run(...params: unknown[]): LibraryIndexerRunResult;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface LibraryIndexerDatabase {
  exec(sql: string): void;
  prepare(sql: string): LibraryIndexerStatement;
  close(): void;
}

export interface LibraryIndexerDatabaseDriver {
  readonly kind: string;
  open(dbPath: string, options?: OpenDatabaseOptions): LibraryIndexerDatabase;
}

export type LibraryIndexerDatabaseDriverKind = "better-sqlite3" | "node:sqlite";
export type LibraryIndexerDatabaseDriverResolver = () => LibraryIndexerDatabaseDriver | null | undefined;
export const DEFAULT_LIBRARY_INDEXER_DATABASE_DRIVER_KIND: LibraryIndexerDatabaseDriverKind = "better-sqlite3";

interface BetterSqliteStatementLike {
  run(...params: unknown[]): LibraryIndexerRunResult;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

interface BetterSqliteDatabaseLike extends LibraryIndexerDatabase {
  prepare(sql: string): BetterSqliteStatementLike;
}

type BetterSqliteConstructor = new (dbPath: string) => BetterSqliteDatabaseLike;

interface NodeSqliteStatementLike {
  run(...params: unknown[]): LibraryIndexerRunResult;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

interface NodeSqliteDatabaseLike {
  exec(sql: string): void;
  prepare(sql: string): NodeSqliteStatementLike;
  close(): void;
}

type NodeSqliteConstructor = new (dbPath: string) => NodeSqliteDatabaseLike;

type LibraryIndexerDriverRegistryState = typeof globalThis & {
  [registeredDefaultDriverSymbol]?: unknown;
  [registeredDefaultDriverResolverSymbol]?: unknown;
};

function isLibraryIndexerDatabaseDriver(value: unknown): value is LibraryIndexerDatabaseDriver {
  return typeof value === "object"
    && value !== null
    && typeof (value as { kind?: unknown }).kind === "string"
    && typeof (value as { open?: unknown }).open === "function";
}

function loadBetterSqlite3Constructor(): BetterSqliteConstructor {
  const runtimeModule = runtimeRequire("better-sqlite3") as BetterSqliteConstructor | {
    default?: BetterSqliteConstructor;
  };

  return (("default" in runtimeModule && runtimeModule.default) || runtimeModule) as BetterSqliteConstructor;
}

function loadNodeSqliteConstructor(): NodeSqliteConstructor {
  const runtimeModule = runtimeRequire("node:sqlite") as {
    DatabaseSync?: NodeSqliteConstructor;
    default?: {
      DatabaseSync?: NodeSqliteConstructor;
    };
  };
  const DatabaseSync = runtimeModule.DatabaseSync ?? runtimeModule.default?.DatabaseSync;
  if (!DatabaseSync) {
    throw new Error("INDEXER_NODE_SQLITE_DATABASE_SYNC_UNAVAILABLE");
  }
  return DatabaseSync;
}

function applyCommonPragmas(
  db: LibraryIndexerDatabase,
  options: OpenDatabaseOptions = {},
): LibraryIndexerDatabase {
  const tempStore = options.tempStore ?? "FILE";
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec("PRAGMA synchronous=NORMAL;");
  db.exec(`PRAGMA temp_store=${tempStore};`);
  db.exec("PRAGMA foreign_keys=ON;");
  db.exec("PRAGMA busy_timeout=5000;");
  return db;
}

export const betterSqlite3DatabaseDriver: LibraryIndexerDatabaseDriver = {
  kind: "better-sqlite3",
  open(dbPath: string, options: OpenDatabaseOptions = {}): LibraryIndexerDatabase {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const Database = loadBetterSqlite3Constructor();
    const db = new Database(dbPath);
    return applyCommonPragmas(db, options);
  },
};

export const nodeSqliteDatabaseDriver: LibraryIndexerDatabaseDriver = {
  kind: "node:sqlite",
  open(dbPath: string, options: OpenDatabaseOptions = {}): LibraryIndexerDatabase {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const DatabaseSync = loadNodeSqliteConstructor();
    const db = new DatabaseSync(dbPath);
    return applyCommonPragmas(db, options);
  },
};

/**
 * 宿主可在 indexer 入口外先注册真正的 SQLite driver。
 * 这样库内那些继续直接 `openDatabase(...)` 的薄层，也不会把正式默认链重新绑回 Node 专属实现。
 */
export function registerDefaultLibraryIndexerDatabaseDriver(
  driver: LibraryIndexerDatabaseDriver | null,
): void {
  const state = globalThis as LibraryIndexerDriverRegistryState;
  if (driver) {
    state[registeredDefaultDriverSymbol] = driver;
    return;
  }
  delete state[registeredDefaultDriverSymbol];
}

/**
 * 某些宿主不方便直接传 driver 对象，只能在更外层按需解析。
 * 这里允许宿主注册一个 resolver，但仍然要求最终返回最小同步 SQLite 契约。
 */
export function registerDefaultLibraryIndexerDatabaseDriverResolver(
  resolver: LibraryIndexerDatabaseDriverResolver | null,
): void {
  const state = globalThis as LibraryIndexerDriverRegistryState;
  if (resolver) {
    state[registeredDefaultDriverResolverSymbol] = resolver;
    return;
  }
  delete state[registeredDefaultDriverResolverSymbol];
}

export function clearDefaultLibraryIndexerDatabaseDriverRegistration(): void {
  const state = globalThis as LibraryIndexerDriverRegistryState;
  delete state[registeredDefaultDriverSymbol];
  delete state[registeredDefaultDriverResolverSymbol];
}

export function getRegisteredDefaultLibraryIndexerDatabaseDriver(): LibraryIndexerDatabaseDriver | null {
  const state = globalThis as LibraryIndexerDriverRegistryState;
  const directDriver = state[registeredDefaultDriverSymbol];
  if (isLibraryIndexerDatabaseDriver(directDriver)) {
    return directDriver;
  }

  const resolver = state[registeredDefaultDriverResolverSymbol];
  if (typeof resolver !== "function") {
    return null;
  }

  const resolvedDriver = (resolver as LibraryIndexerDatabaseDriverResolver)();
  return isLibraryIndexerDatabaseDriver(resolvedDriver) ? resolvedDriver : null;
}

function resolveBuiltInFallbackLibraryIndexerDatabaseDriver(): LibraryIndexerDatabaseDriver {
  try {
    loadBetterSqlite3Constructor();
    return betterSqlite3DatabaseDriver;
  } catch (betterSqliteError) {
    try {
      loadNodeSqliteConstructor();
      return nodeSqliteDatabaseDriver;
    } catch (nodeSqliteError) {
      throw new Error(
        `INDEXER_SQLITE_DEFAULT_DRIVER_UNAVAILABLE: ${
          betterSqliteError instanceof Error ? betterSqliteError.message : String(betterSqliteError)
        }; ${
          nodeSqliteError instanceof Error ? nodeSqliteError.message : String(nodeSqliteError)
        }`,
      );
    }
  }
}

/**
 * 默认 driver 解析改成 host-first。
 * 没有宿主注册时，才退回库内兼容 driver，避免默认世界再次写死成某个 Node runtime 模块。
 */
export function resolveDefaultLibraryIndexerDatabaseDriver(): LibraryIndexerDatabaseDriver {
  return getRegisteredDefaultLibraryIndexerDatabaseDriver()
    ?? resolveBuiltInFallbackLibraryIndexerDatabaseDriver();
}

export const defaultLibraryIndexerDatabaseDriver: LibraryIndexerDatabaseDriver = {
  kind: "default",
  open(dbPath: string, options: OpenDatabaseOptions = {}): LibraryIndexerDatabase {
    return resolveDefaultLibraryIndexerDatabaseDriver().open(dbPath, options);
  },
};

export function resolveLibraryIndexerDatabaseDriver(
  kind: LibraryIndexerDatabaseDriverKind | null | undefined,
): LibraryIndexerDatabaseDriver {
  if (kind === "better-sqlite3") {
    return betterSqlite3DatabaseDriver;
  }
  if (kind === "node:sqlite") {
    return nodeSqliteDatabaseDriver;
  }
  return resolveDefaultLibraryIndexerDatabaseDriver();
}

/**
 * 打开 SQLite 数据库。
 * 默认主链先走宿主注册 driver；只有宿主没接管时，才退回兼容 driver。
 */
export function openDatabase(
  dbPath: string,
  options: OpenDatabaseOptions = {},
): LibraryIndexerDatabase {
  return defaultLibraryIndexerDatabaseDriver.open(dbPath, options);
}
