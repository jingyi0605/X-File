import fs from "node:fs";
import path from "node:path";

const STORE_FILE_NAME = "onlyoffice-settings.json";

export interface OnlyOfficeSettingRecord {
  enabled: boolean;
  serverUrl: string | null;
  publicBaseUrl: string | null;
  callbackBaseUrl: string | null;
  userDisplayName: string | null;
  userAvatarUrl: string | null;
  jwtSecret: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OnlyOfficeSettingsStoreOptions {
  dataDir?: string;
}

export class OnlyOfficeSettingsStore {
  private readonly filePath: string;

  constructor(options: OnlyOfficeSettingsStoreOptions = {}) {
    this.filePath = path.join(resolveDataDir(options.dataDir), STORE_FILE_NAME);
  }

  read(): OnlyOfficeSettingRecord | null {
    if (!fs.existsSync(this.filePath)) {
      return null;
    }

    return JSON.parse(fs.readFileSync(this.filePath, "utf8")) as OnlyOfficeSettingRecord;
  }

  write(record: OnlyOfficeSettingRecord): OnlyOfficeSettingRecord {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    return record;
  }
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
