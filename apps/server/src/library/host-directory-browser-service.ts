import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { HostDirectoryBrowseResult, HostDirectoryOption } from "@x-file/shared";

import { resolveDefaultLibraryRootDir } from "../storage/library-binding-store.js";
import { LibraryError } from "./library-errors.js";

const HOST_DIRECTORY_BROWSE_LIMIT = 200;

export class HostDirectoryBrowserService {
  browse(requestedPath?: string | null): HostDirectoryBrowseResult {
    const roots = listHostDirectoryRoots();
    const fallbackPath = resolveDefaultHostBrowsePath(roots);
    const currentPath = resolveHostBrowsePath(requestedPath, fallbackPath);

    return {
      currentPath,
      parentPath: resolveHostParentPath(currentPath),
      roots,
      items: listChildDirectories(currentPath)
    };
  }
}

function listChildDirectories(currentPath: string): HostDirectoryOption[] {
  return fs
    .readdirSync(currentPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => ({
      path: path.join(currentPath, entry.name),
      name: entry.name
    }))
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, HOST_DIRECTORY_BROWSE_LIMIT);
}

function listHostDirectoryRoots(): HostDirectoryOption[] {
  const homePath = os.homedir();
  const roots: HostDirectoryOption[] = [];

  if (homePath && isReadableDirectory(homePath)) {
    roots.push({ path: path.resolve(homePath), name: "主目录" });
  }

  if (process.platform === "win32") {
    for (const letter of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
      const rootPath = `${letter}:\\`;
      if (isReadableDirectory(rootPath)) {
        roots.push({ path: rootPath, name: rootPath });
      }
    }
  } else if (isReadableDirectory("/")) {
    roots.push({ path: "/", name: "/" });
  }

  return dedupeDirectoryOptions(roots);
}

function resolveDefaultHostBrowsePath(roots: HostDirectoryOption[]): string {
  const homePath = os.homedir();

  if (homePath && isReadableDirectory(homePath)) {
    return path.resolve(homePath);
  }

  return roots[0]?.path ?? path.resolve(process.cwd());
}

function resolveHostBrowsePath(requestedPath: string | null | undefined, fallbackPath: string): string {
  const trimmedPath = requestedPath?.trim();
  if (!trimmedPath) {
    return fallbackPath;
  }

  const resolvedPath = path.resolve(trimmedPath);
  if (isReadableDirectory(resolvedPath)) {
    return resolvedPath;
  }

  if (resolvedPath === path.resolve(resolveDefaultLibraryRootDir())) {
    return fallbackPath;
  }

  throw new LibraryError(400, "NOT_A_DIRECTORY", "路径不是可读取目录", "path");
}

function resolveHostParentPath(currentPath: string): string | null {
  const parentPath = path.dirname(currentPath);
  return parentPath === currentPath ? null : parentPath;
}

function isReadableDirectory(targetPath: string): boolean {
  try {
    const stats = fs.statSync(targetPath);
    if (!stats.isDirectory()) {
      return false;
    }
    fs.accessSync(targetPath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function dedupeDirectoryOptions(options: HostDirectoryOption[]): HostDirectoryOption[] {
  const seen = new Set<string>();
  const result: HostDirectoryOption[] = [];

  for (const option of options) {
    const key = path.resolve(option.path);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(option);
  }

  return result;
}
