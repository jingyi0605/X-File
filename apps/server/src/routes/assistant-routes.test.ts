import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createServer } from "../app.js";

test("assistant provider 列表只返回已安装且启用的集成插件", async () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "x-file-assistant-provider-home-"));
  const previousHome = process.env.HOME;
  const previousDataDir = process.env.X_FILE_DATA_DIR;
  const previousBundledPluginDir = process.env.X_FILE_BUNDLED_PLUGIN_DIR;
  process.env.HOME = tempHome;
  process.env.X_FILE_DATA_DIR = path.join(tempHome, ".x-file-data");
  process.env.X_FILE_BUNDLED_PLUGIN_DIR = path.join(tempHome, "empty-bundled-plugins");
  createPluginSource(process.env.X_FILE_BUNDLED_PLUGIN_DIR, {
    id: "noop",
    name: "Noop Plugin",
    version: "0.1.0",
    capabilities: [],
    provider: {
      providerId: "noop",
      displayName: "Noop",
      command: null,
      auth: {
        strategy: "file_exists",
        path: null,
      },
    },
  });

  const authDir = path.join(tempHome, ".codex");
  fs.mkdirSync(authDir, { recursive: true });
  fs.writeFileSync(path.join(authDir, "auth.json"), "{}\n", "utf8");

  const app = createServer({ httpServerRuntimeState: { running: false } });

  try {
    const emptyProviders = await app.inject({ method: "GET", url: "/api/assistant/providers" });
    assert.equal(emptyProviders.statusCode, 200);
    assert.deepEqual(emptyProviders.json().providers, []);

    const pluginSourceDir = createPluginSource(tempHome, {
      id: "codex",
      name: "Codex Integration",
      version: "0.1.0",
      capabilities: ["provider.detect", "assistant.entry"],
      provider: {
        providerId: "codex",
        displayName: "Codex",
        command: "codex",
        auth: {
          strategy: "file_exists",
          path: path.join(authDir, "auth.json"),
        },
      },
    });

    const installed = await app.inject({
      method: "POST",
      url: "/api/plugins/install",
      payload: { sourcePath: pluginSourceDir },
    });
    assert.equal(installed.statusCode, 200);

    const providers = await app.inject({ method: "GET", url: "/api/assistant/providers" });
    assert.equal(providers.statusCode, 200);
    assert.equal(providers.json().providers.length, 1);
    assert.equal(providers.json().providers[0]?.id, "codex");

    const disabled = await app.inject({
      method: "PUT",
      url: "/api/plugins/codex/disable",
    });
    assert.equal(disabled.statusCode, 200);

    const afterDisable = await app.inject({ method: "GET", url: "/api/assistant/providers" });
    assert.equal(afterDisable.statusCode, 200);
    assert.deepEqual(afterDisable.json().providers, []);
  } finally {
    await app.close();
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    if (previousDataDir === undefined) {
      delete process.env.X_FILE_DATA_DIR;
    } else {
      process.env.X_FILE_DATA_DIR = previousDataDir;
    }
    if (previousBundledPluginDir === undefined) {
      delete process.env.X_FILE_BUNDLED_PLUGIN_DIR;
    } else {
      process.env.X_FILE_BUNDLED_PLUGIN_DIR = previousBundledPluginDir;
    }
  }
});

test("assistant provider 会自动发现随包内置插件，无需手工安装", async () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "x-file-assistant-bundled-provider-home-"));
  const previousHome = process.env.HOME;
  const previousDataDir = process.env.X_FILE_DATA_DIR;
  const previousBundledPluginDir = process.env.X_FILE_BUNDLED_PLUGIN_DIR;
  process.env.HOME = tempHome;
  process.env.X_FILE_DATA_DIR = path.join(tempHome, ".x-file-data");

  const authDir = path.join(tempHome, ".codex");
  fs.mkdirSync(authDir, { recursive: true });
  fs.writeFileSync(path.join(authDir, "auth.json"), "{}\n", "utf8");

  const bundledPluginDir = createPluginSource(tempHome, {
    id: "codex",
    name: "Codex Integration",
    version: "0.1.0",
    capabilities: ["provider.detect", "assistant.entry"],
    provider: {
      providerId: "codex",
      displayName: "Codex",
      command: process.platform === "win32" ? "where" : "which",
      auth: {
        strategy: "file_exists",
        path: path.join(authDir, "auth.json"),
      },
    },
  });
  process.env.X_FILE_BUNDLED_PLUGIN_DIR = path.dirname(bundledPluginDir);

  const app = createServer({ httpServerRuntimeState: { running: false } });

  try {
    const providers = await app.inject({ method: "GET", url: "/api/assistant/providers" });
    assert.equal(providers.statusCode, 200);
    assert.equal(providers.json().providers.length, 1);
    assert.equal(providers.json().providers[0]?.id, "codex");

    const plugins = await app.inject({ method: "GET", url: "/api/plugins" });
    assert.equal(plugins.statusCode, 200);
    assert.equal(plugins.json().plugins.length, 1);
    assert.equal(plugins.json().plugins[0]?.manifest.id, "codex");
    assert.equal(plugins.json().plugins[0]?.registry.enabled, true);
  } finally {
    await app.close();
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    if (previousDataDir === undefined) {
      delete process.env.X_FILE_DATA_DIR;
    } else {
      process.env.X_FILE_DATA_DIR = previousDataDir;
    }
    if (previousBundledPluginDir === undefined) {
      delete process.env.X_FILE_BUNDLED_PLUGIN_DIR;
    } else {
      process.env.X_FILE_BUNDLED_PLUGIN_DIR = previousBundledPluginDir;
    }
  }
});

test("assistant provider 在未显式传入环境变量时也能从默认内置插件目录发现 provider", async () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "x-file-assistant-default-bundled-provider-home-"));
  const previousHome = process.env.HOME;
  const previousDataDir = process.env.X_FILE_DATA_DIR;
  const previousBundledPluginDir = process.env.X_FILE_BUNDLED_PLUGIN_DIR;
  process.env.HOME = tempHome;
  process.env.X_FILE_DATA_DIR = path.join(tempHome, ".x-file-data");
  delete process.env.X_FILE_BUNDLED_PLUGIN_DIR;

  const bundledResourceDir = path.join(process.cwd(), "apps", "desktop", "src-tauri", "resources", "x-file-plugins");
  const targetPluginDir = path.join(bundledResourceDir, "codex");
  const backupDir = `${bundledResourceDir}.backup-${Date.now()}`;
  const restoreSourceDir = fs.existsSync(bundledResourceDir) ? backupDir : null;

  const authDir = path.join(tempHome, ".codex");
  fs.mkdirSync(authDir, { recursive: true });
  fs.writeFileSync(path.join(authDir, "auth.json"), "{}\n", "utf8");

  if (restoreSourceDir) {
    fs.rmSync(backupDir, { recursive: true, force: true });
    fs.renameSync(bundledResourceDir, backupDir);
  }
  fs.mkdirSync(bundledResourceDir, { recursive: true });
  createPluginSource(bundledResourceDir, {
    id: "codex",
    name: "Codex Integration",
    version: "0.1.0",
    capabilities: ["provider.detect", "assistant.entry"],
    provider: {
      providerId: "codex",
      displayName: "Codex",
      command: process.platform === "win32" ? "where" : "which",
      auth: {
        strategy: "file_exists",
        path: path.join(authDir, "auth.json"),
      },
    },
  });
  if (fs.existsSync(path.join(bundledResourceDir, "codex-plugin-source"))) {
    fs.renameSync(path.join(bundledResourceDir, "codex-plugin-source"), targetPluginDir);
  }

  const app = createServer({ httpServerRuntimeState: { running: false } });

  try {
    const providers = await app.inject({ method: "GET", url: "/api/assistant/providers" });
    assert.equal(providers.statusCode, 200);
    assert.equal(providers.json().providers.some((item: { id?: string }) => item.id === "codex"), true);
  } finally {
    await app.close();
    fs.rmSync(bundledResourceDir, { recursive: true, force: true });
    if (restoreSourceDir) {
      fs.renameSync(backupDir, bundledResourceDir);
    }
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    if (previousDataDir === undefined) {
      delete process.env.X_FILE_DATA_DIR;
    } else {
      process.env.X_FILE_DATA_DIR = previousDataDir;
    }
    if (previousBundledPluginDir === undefined) {
      delete process.env.X_FILE_BUNDLED_PLUGIN_DIR;
    } else {
      process.env.X_FILE_BUNDLED_PLUGIN_DIR = previousBundledPluginDir;
    }
  }
});

function createPluginSource(
  baseDir: string,
  input: {
    id: string;
    name: string;
    version: string;
    capabilities: string[];
    provider: Record<string, unknown>;
  }
): string {
  const targetDir = path.join(baseDir, `${input.id}-plugin-source`);
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(
    path.join(targetDir, "manifest.json"),
    `${JSON.stringify({
      id: input.id,
      name: input.name,
      version: input.version,
      pluginType: "integration",
      minAppVersion: "0.1.0",
      entry: {
        backend: null,
        ui: "ui/index.js",
      },
      assistant: input.capabilities.includes("assistant.entry")
        ? {
            descriptor: {
              type: "inline",
              descriptor: {
                formatVersion: 1,
                provider: {
                  providerId: "codex",
                  runtimeHomeDir: {
                    kind: "home_relative",
                    relativePath: ".codex"
                  }
                },
                capabilitySource: {
                  kind: "session-sync-provider-capabilities",
                  adapterExport: "CodexAdapter"
                },
                runtimeBridge: {
                  kind: "external-sidecar-runtime",
                  command: "x-file-codex-sidecar",
                  adapterExport: "CodexRuntimeAdapter",
                  args: ["serve-runtime"],
                  shell: false,
                  permissionProtocol: "codex-server-request-v1",
                  permissionResponseProtocol: "decision-accept-decline-v1"
                }
              }
            }
          }
        : null,
      capabilities: input.capabilities,
      provider: input.provider,
      signature: {
        algorithm: "unsigned",
        value: "development",
      },
    }, null, 2)}\n`,
    "utf8"
  );
  return targetDir;
}
