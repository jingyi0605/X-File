#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pnpm = "pnpm";

function run(args) {
  const result = spawnSync(pnpm, args, {
    cwd: rootDir,
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

run(["--filter", "@x-file/shared", "build"]);
run(["--filter", "@x-file/indexer", "build"]);
run(["--filter", "@x-file/web", "build"]);
run(["run", "prepare:bundled-server"]);
