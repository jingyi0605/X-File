import fs from "node:fs";
import path from "node:path";

import type { LibraryBinding } from "@x-file/shared";

const STORE_FILE_NAME = "library-binding.json";

export interface LibraryBindingStoreOptions {
  dataDir?: string;
}

export class LibraryBindingStore {
  private readonly filePath: string;

  constructor(options: LibraryBindingStoreOptions = {}) {
    this.filePath = path.join(resolveDataDir(options.dataDir), STORE_FILE_NAME);
  }

  read(): LibraryBinding | null {
    if (!fs.existsSync(this.filePath)) {
      return null;
    }

    const raw = fs.readFileSync(this.filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<LibraryBinding>;
    return normalizeBinding(parsed);
  }

  write(binding: LibraryBinding): LibraryBinding {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, `${JSON.stringify(binding, null, 2)}\n`, "utf8");
    return binding;
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

function normalizeBinding(binding: Partial<LibraryBinding>): LibraryBinding {
  return {
    ...(binding as LibraryBinding),
    initialized: binding.initialized === true,
    initializedAt: typeof binding.initializedAt === "string" && binding.initializedAt.trim() ? binding.initializedAt : null
  };
}
