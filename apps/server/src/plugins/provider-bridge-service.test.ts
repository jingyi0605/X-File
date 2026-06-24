import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { PluginManifest } from "@x-file/shared";

import { ProviderBridgeService } from "./provider-bridge-service.js";

test("provider bridge 在命令缺失时返回 failed", () => {
  const service = new ProviderBridgeService();
  const manifest = createProviderManifest({
    command: "__x_file_missing_command__",
    authPath: path.join(os.tmpdir(), "x-file-missing-auth.json"),
  });

  const health = service.buildHealth(manifest, true);

  assert.equal(health.status, "failed");
  assert.equal(health.commandReady, false);
  assert.equal(health.authReady, false);
});

test("provider bridge 在命令存在但未登录时返回 degraded", () => {
  const service = new ProviderBridgeService();
  const manifest = createProviderManifest({
    command: process.platform === "win32" ? "where" : "which",
    authPath: path.join(os.tmpdir(), "x-file-missing-auth.json"),
  });

  const health = service.buildHealth(manifest, true);

  assert.equal(health.status, "degraded");
  assert.equal(health.commandReady, true);
  assert.equal(health.authReady, false);
});

test("provider bridge 在命令和登录态都存在时返回 healthy", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "x-file-provider-auth-"));
  const authPath = path.join(tempDir, "auth.json");
  fs.writeFileSync(authPath, "{}\n", "utf8");

  const service = new ProviderBridgeService();
  const manifest = createProviderManifest({
    command: process.platform === "win32" ? "where" : "which",
    authPath,
  });

  const health = service.buildHealth(manifest, true);

  assert.equal(health.status, "healthy");
  assert.equal(health.commandReady, true);
  assert.equal(health.authReady, true);
});

function createProviderManifest(input: {
  command: string;
  authPath: string;
}): PluginManifest {
  return {
    id: "codex",
    name: "Codex Integration",
    version: "0.1.0",
    pluginType: "integration",
    minAppVersion: "0.1.0",
    entry: {
      backend: null,
      ui: "ui/index.js",
    },
    capabilities: ["provider.detect", "assistant.entry"],
    provider: {
      providerId: "codex",
      displayName: "Codex",
      command: input.command,
      auth: {
        strategy: "file_exists",
        path: input.authPath,
      },
    },
    signature: {
      algorithm: "unsigned",
      value: "development",
    },
  };
}
