import fs from "node:fs";
import path from "node:path";

import type { LibraryBinding } from "@x-file/shared";

import { LibraryError } from "../library/library-errors.js";

export class LibraryConfigStore {
  writeForBinding(binding: LibraryBinding): void {
    const configPath = resolveConfigPath(binding);
    const config = {
      libraryId: binding.libraryId,
      rootDir: binding.rootDir,
      mirrorRoot: binding.mirrorRoot,
      allowedExtensions: binding.allowedExtensions,
      includedHiddenPaths: binding.includedHiddenPaths,
      folderOpenBehavior: binding.folderOpenBehavior,
      updatedAt: binding.updatedAt
    };

    try {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    } catch {
      throw new LibraryError(500, "LIBRARY_STORAGE_ERROR", "文档库配置写入失败");
    }
  }
}

function resolveConfigPath(binding: LibraryBinding): string {
  const relativePath = binding.configRelativePath.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!relativePath || relativePath.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new LibraryError(400, "LIBRARY_PATH_INVALID", "文档库配置路径无效", "configRelativePath");
  }

  return path.resolve(binding.rootDir, relativePath);
}
