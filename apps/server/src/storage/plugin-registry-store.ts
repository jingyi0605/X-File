import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { PluginRegistryRecord } from "@x-file/shared";

const REGISTRY_FILE_NAME = "plugin-registry.json";
const PLUGINS_DIR_NAME = "plugins";

export interface PluginRegistryStoreOptions {
  dataDir?: string;
}

interface PluginRegistryFile {
  records: PluginRegistryRecord[];
}

export class PluginRegistryStore {
  private readonly filePath: string;
  private readonly pluginRootDir: string;

  constructor(options: PluginRegistryStoreOptions = {}) {
    const dataDir = resolveDataDir(options.dataDir);
    this.filePath = path.join(dataDir, REGISTRY_FILE_NAME);
    this.pluginRootDir = path.join(dataDir, PLUGINS_DIR_NAME);
  }

  list(): PluginRegistryRecord[] {
    if (!fs.existsSync(this.filePath)) {
      return [];
    }

    const payload = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as PluginRegistryFile;
    return Array.isArray(payload.records) ? payload.records.map(normalizeRegistryRecord) : [];
  }

  write(records: PluginRegistryRecord[]): PluginRegistryRecord[] {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, `${JSON.stringify({ records }, null, 2)}\n`, "utf8");
    return records;
  }

  get(pluginId: string): PluginRegistryRecord | null {
    return this.list().find((record) => record.pluginId === pluginId) ?? null;
  }

  upsert(record: PluginRegistryRecord): PluginRegistryRecord {
    const records = this.list();
    const nextRecords = records.filter((item) => item.pluginId !== record.pluginId);
    nextRecords.push(normalizeRegistryRecord(record));
    nextRecords.sort((left, right) => left.pluginId.localeCompare(right.pluginId, "en"));
    this.write(nextRecords);
    return record;
  }

  remove(pluginId: string): void {
    const records = this.list().filter((record) => record.pluginId !== pluginId);
    this.write(records);
  }

  getPluginRootDir(): string {
    fs.mkdirSync(this.pluginRootDir, { recursive: true });
    return this.pluginRootDir;
  }
}

function resolveDataDir(explicitDataDir: string | undefined): string {
  if (explicitDataDir?.trim()) {
    return path.resolve(explicitDataDir);
  }

  if (process.env.X_FILE_DATA_DIR?.trim()) {
    return path.resolve(process.env.X_FILE_DATA_DIR);
  }

  return path.join(os.homedir(), ".x-file");
}

function normalizeRegistryRecord(record: PluginRegistryRecord): PluginRegistryRecord {
  return {
    pluginId: record.pluginId,
    version: record.version,
    installDir: record.installDir,
    enabled: record.enabled !== false,
    installedAt: record.installedAt,
    updatedAt: record.updatedAt,
    lastHealthStatus: record.lastHealthStatus ?? "unknown",
    lastError: record.lastError ?? null,
    grantedCapabilities: Array.isArray(record.grantedCapabilities) ? record.grantedCapabilities : [],
  };
}
