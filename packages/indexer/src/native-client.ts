import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { LibraryIndexProgress } from "@x-file/shared";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

export interface DirtyScope {
  trigger: string;
  changedPaths: string[];
  deletedPaths: string[];
  dirtyDirectories: string[];
  dirtyTagPaths: string[];
  dirtyMetaShards: string[];
  dirtyDetailShards: string[];
  dirtyPostingBuckets: string[];
  dirtyRelations: string[];
}

export interface NativeLibraryRequest {
  rootDir: string;
  targetPath?: string | null;
  targetPaths?: string[];
  allowedExtensions?: string[];
  includedHiddenPaths?: string[];
  hideDotFiles?: boolean;
  hideSystemFolders?: boolean;
  reason?: string;
  dirtyScope?: DirtyScope;
  tagStore?: unknown;
}

export interface NativeIndexResult {
  scannedCount: number;
  indexedCount: number;
  unchangedCount: number;
  indexedPaths: string[];
  deletedCount: number;
  deletedPaths: string[];
  dirtyScope: DirtyScope;
  timingsMs: Record<string, number>;
}

export interface NativeExportResult {
  manifestPath: string;
  exportedAt: string;
  filesWritten: string[];
}

export interface NativeLibraryResult {
  index: NativeIndexResult;
  exportResult: NativeExportResult;
}

function resolveNativeCli(): string {
  const configured = process.env.X_FILE_DESKTOP_CLI_PATH;
  if (configured) return configured;
  const desktop = path.join(workspaceRoot, "apps/desktop");
  const candidates = ["src-tauri/target/debug", "src-tauri/target/release", "target/debug", "target/release"]
    .map(directory => path.join(desktop, directory, process.platform === "win32" ? "x-file-desktop.exe" : "x-file-desktop"));
  const executable = candidates.find(candidate => fs.existsSync(candidate));
  if (!executable) throw new Error("未找到原生索引 CLI，请构建桌面端或设置 X_FILE_DESKTOP_CLI_PATH");
  return executable;
}

async function readStream(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

export async function runNativeLibraryWorker<T>(
  mode: "full" | "index-only" | "export-only" | "tags-only",
  input: NativeLibraryRequest,
  signal?: AbortSignal,
): Promise<T> {
  const child = spawn(resolveNativeCli(), ["library-worker", mode], { signal, stdio: ["pipe", "pipe", "pipe"] });
  const closed = once(child, "close");
  const written = pipeline([JSON.stringify(input)], child.stdin);
  const [stdout, stderr, [code]] = await Promise.all([readStream(child.stdout), readStream(child.stderr), closed, written]);
  if (code !== 0) throw new Error(stderr || `原生 worker 退出码：${code}`);
  return JSON.parse(stdout) as T;
}

export async function runLibraryIndexOnce(input: NativeLibraryRequest & {
  signal?: AbortSignal;
  onStageChange?: (stage: string) => void;
  onProgress?: (progress: LibraryIndexProgress) => void;
}): Promise<NativeLibraryResult> {
  const timer = input.onProgress || input.onStageChange ? setInterval(() => {
    const file = path.join(input.rootDir, ".ai-index/runtime-status.json");
    if (!fs.existsSync(file)) return;
    const status = JSON.parse(fs.readFileSync(file, "utf8")) as { runningStage?: string; progress?: LibraryIndexProgress };
    if (status.runningStage) input.onStageChange?.(status.runningStage);
    if (status.progress) input.onProgress?.(status.progress);
  }, 500) : null;
  try {
    return await runNativeLibraryWorker("full", input, input.signal);
  } finally {
    if (timer) clearInterval(timer);
  }
}
