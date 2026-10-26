const SYSTEM_DIRECTORIES = new Set([
  "node_modules", "dist", "build", "coverage", ".git", ".svn", ".hg", ".next",
  ".nuxt", ".vite", ".cache", "__pycache__", "venv", ".venv",
]);

export function isLibraryPathVisible(relativePath: string, options: {
  isDirectory: boolean;
  includedHiddenPaths?: readonly string[];
  hideDotFiles?: boolean;
  hideSystemFolders?: boolean;
}): boolean {
  const relative = relativePath.replaceAll("\\", "/");
  const segments = relative.split("/").filter(Boolean);
  const directories = options.isDirectory ? segments : segments.slice(0, -1);
  if (directories.includes(".ai-index")) return false;
  if (options.hideSystemFolders !== false && directories.some(segment => SYSTEM_DIRECTORIES.has(segment))) return false;
  if (options.hideDotFiles === false || !segments.some(segment => segment.startsWith("."))) return true;
  return (options.includedHiddenPaths ?? []).some(included => relative === included || relative.startsWith(`${included}/`));
}
