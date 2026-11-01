#!/usr/bin/env node
// 兼容旧入口：版本同步统一由 scripts/version.mjs 实现。

const { spawn } = await import("node:child_process");
const scriptPath = new URL("./version.mjs", import.meta.url);

const child = spawn(process.execPath, [scriptPath, "sync"], {
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
