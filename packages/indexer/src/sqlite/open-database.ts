import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

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

/**
 * 打开 SQLite 数据库。
 * 这里统一走 better-sqlite3，禁止加载 Node 实验性的 node:sqlite。
 */
export function openDatabase(
  dbPath: string,
  options: OpenDatabaseOptions = {},
): LibraryIndexerDatabase {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath) as unknown as LibraryIndexerDatabase;
  const tempStore = options.tempStore ?? "FILE";
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec("PRAGMA synchronous=NORMAL;");
  db.exec(`PRAGMA temp_store=${tempStore};`);
  db.exec("PRAGMA foreign_keys=ON;");
  db.exec("PRAGMA busy_timeout=5000;");
  return db;
}
