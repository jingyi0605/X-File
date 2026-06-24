import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import Fastify from "fastify";

import { PluginService } from "../plugins/plugin-service.js";
import { registerPluginRoutes } from "./plugin-routes.js";
import { PluginRegistryStore } from "../storage/plugin-registry-store.js";

test("插件路由支持安装、更新、禁用、启用和卸载", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "x-file-plugin-routes-"));
  const previousBundledPluginDir = process.env.X_FILE_BUNDLED_PLUGIN_DIR;
  process.env.X_FILE_BUNDLED_PLUGIN_DIR = createIsolatedBundledPluginRoot(tempDir);
  const sourceV1Dir = createPluginSource(tempDir, "codex-source-v1", {
    id: "codex",
    name: "Codex Integration",
    version: "0.1.0",
    capabilities: ["provider.detect"],
    provider: {
      providerId: "codex",
      displayName: "Codex",
      command: "codex",
      auth: {
        strategy: "file_exists",
        path: path.join(tempDir, ".codex", "auth.json"),
      },
    },
  });
  const sourceV2Dir = createPluginSource(tempDir, "codex-source-v2", {
    id: "codex",
    name: "Codex Integration",
    version: "0.2.0",
    capabilities: ["provider.detect", "assistant.entry"],
    provider: {
      providerId: "codex",
      displayName: "Codex",
      command: "codex",
      auth: {
        strategy: "file_exists",
        path: path.join(tempDir, ".codex", "auth.json"),
      },
    },
  });
  const npmRuntimeDir = createPluginSource(tempDir, "npm-source-v1", {
    id: "npm-runtime-plugin",
    name: "Npm Runtime Plugin",
    version: "0.1.0",
    capabilities: ["assistant.entry"],
    runtime: {
      install: {
        strategy: "npm-runtime",
        packageManager: "npm",
      }
    }
  });

  const store = new PluginRegistryStore({ dataDir: tempDir });
  const app = Fastify({ logger: false });
  await registerPluginRoutes(app, new PluginService(store));

  try {
    const installed = await app.inject({
      method: "POST",
      url: "/api/plugins/install",
      payload: { sourcePath: sourceV1Dir },
    });
    assert.equal(installed.statusCode, 200);
    assert.equal(installed.json().plugin.manifest.version, "0.1.0");
    assert.equal(installed.json().plugin.registry.enabled, true);

    const disabled = await app.inject({
      method: "PUT",
      url: "/api/plugins/codex/disable",
    });
    assert.equal(disabled.statusCode, 200);
    assert.equal(disabled.json().plugin.registry.enabled, false);

    const enabled = await app.inject({
      method: "PUT",
      url: "/api/plugins/codex/enable",
    });
    assert.equal(enabled.statusCode, 200);
    assert.equal(enabled.json().plugin.registry.enabled, true);

    const updated = await app.inject({
      method: "POST",
      url: "/api/plugins/codex/update",
      payload: { sourcePath: sourceV2Dir },
    });
    assert.equal(updated.statusCode, 200);
    assert.equal(updated.json().plugin.manifest.version, "0.2.0");
    assert.equal(updated.json().plugin.manifest.capabilities.includes("assistant.entry"), true);

    const list = await app.inject({ method: "GET", url: "/api/plugins" });
    assert.equal(list.statusCode, 200);
    assert.equal(list.json().plugins[0]?.registry.version, "0.2.0");
    assert.equal(typeof list.json().plugins[0]?.health.commandReady, "boolean");
    assert.equal(typeof list.json().plugins[0]?.health.authReady, "boolean");

    const removed = await app.inject({
      method: "DELETE",
      url: "/api/plugins/codex",
    });
    assert.equal(removed.statusCode, 200);
    assert.equal(Array.isArray(removed.json().plugins), true);
    assert.equal(removed.json().plugins.length, 1);
    assert.equal(removed.json().plugins[0]?.manifest.id, "noop");

    const npmInstalled = await app.inject({
      method: "POST",
      url: "/api/plugins/install",
      payload: { sourcePath: npmRuntimeDir },
    });
    assert.equal(npmInstalled.statusCode, 400);
    assert.match(
      npmInstalled.json().detail,
      /已移除这条 Node 安装 ABI/
    );
  } finally {
    await app.close();
    if (previousBundledPluginDir === undefined) {
      delete process.env.X_FILE_BUNDLED_PLUGIN_DIR;
    } else {
      process.env.X_FILE_BUNDLED_PLUGIN_DIR = previousBundledPluginDir;
    }
  }
});

test("插件更新失败时保留旧版本注册记录", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "x-file-plugin-routes-rollback-"));
  const previousBundledPluginDir = process.env.X_FILE_BUNDLED_PLUGIN_DIR;
  process.env.X_FILE_BUNDLED_PLUGIN_DIR = createIsolatedBundledPluginRoot(tempDir);
  const sourceV1Dir = createPluginSource(tempDir, "claude-source-v1", {
    id: "claude-code",
    name: "Claude Code Integration",
    version: "0.1.0",
    capabilities: ["provider.detect"],
  });
  const brokenUpdateDir = createPluginSource(tempDir, "claude-source-broken", {
    id: "claude-code",
    name: "Claude Code Integration",
    version: "0.2.0",
    capabilities: [],
    entry: {
      backend: null,
      ui: null,
    },
  });

  const store = new PluginRegistryStore({ dataDir: tempDir });
  const app = Fastify({ logger: false });
  await registerPluginRoutes(app, new PluginService(store));

  try {
    const installed = await app.inject({
      method: "POST",
      url: "/api/plugins/install",
      payload: { sourcePath: sourceV1Dir },
    });
    assert.equal(installed.statusCode, 200);

    const failed = await app.inject({
      method: "POST",
      url: "/api/plugins/claude-code/update",
      payload: { sourcePath: brokenUpdateDir },
    });
    assert.equal(failed.statusCode, 400);

    const list = await app.inject({ method: "GET", url: "/api/plugins" });
    assert.equal(list.statusCode, 200);
    assert.equal(list.json().plugins[0]?.registry.version, "0.1.0");
  } finally {
    await app.close();
    if (previousBundledPluginDir === undefined) {
      delete process.env.X_FILE_BUNDLED_PLUGIN_DIR;
    } else {
      process.env.X_FILE_BUNDLED_PLUGIN_DIR = previousBundledPluginDir;
    }
  }
});

test("内置插件会自动注册且不允许卸载或手工更新", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "x-file-bundled-plugin-routes-"));
  const bundledRootDir = path.join(tempDir, "bundled-plugins");
  const previousBundledPluginDir = process.env.X_FILE_BUNDLED_PLUGIN_DIR;
  process.env.X_FILE_BUNDLED_PLUGIN_DIR = bundledRootDir;
  createPluginSource(bundledRootDir, "codex", {
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
        path: path.join(tempDir, ".codex", "auth.json"),
      },
    },
  });

  const sourceV2Dir = createPluginSource(tempDir, "codex-source-v2", {
    id: "codex",
    name: "Codex Integration",
    version: "0.2.0",
    capabilities: ["provider.detect", "assistant.entry"],
    provider: {
      providerId: "codex",
      displayName: "Codex",
      command: "codex",
      auth: {
        strategy: "file_exists",
        path: path.join(tempDir, ".codex", "auth.json"),
      },
    },
  });

  const store = new PluginRegistryStore({ dataDir: path.join(tempDir, "data") });
  const app = Fastify({ logger: false });
  await registerPluginRoutes(app, new PluginService(store));

  try {
    const list = await app.inject({ method: "GET", url: "/api/plugins" });
    assert.equal(list.statusCode, 200);
    assert.equal(list.json().plugins.length, 1);
    assert.equal(list.json().plugins[0]?.manifest.id, "codex");

    const removed = await app.inject({
      method: "DELETE",
      url: "/api/plugins/codex",
    });
    assert.equal(removed.statusCode, 400);

    const updated = await app.inject({
      method: "POST",
      url: "/api/plugins/codex/update",
      payload: { sourcePath: sourceV2Dir },
    });
    assert.equal(updated.statusCode, 400);
  } finally {
    await app.close();
    if (previousBundledPluginDir === undefined) {
      delete process.env.X_FILE_BUNDLED_PLUGIN_DIR;
    } else {
      process.env.X_FILE_BUNDLED_PLUGIN_DIR = previousBundledPluginDir;
    }
  }
});

function createPluginSource(
  baseDir: string,
  name: string,
  input: {
    id: string;
    name: string;
    version: string;
    capabilities: string[];
    entry?: {
      backend: string | null;
      ui: string | null;
    };
    runtime?: {
      install: {
        strategy: "system-cli" | "npm-runtime";
        packageManager?: "npm";
      };
    };
    provider?: Record<string, unknown> | null;
  },
): string {
  const targetDir = path.join(baseDir, name);
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(
    path.join(targetDir, "manifest.json"),
    `${JSON.stringify({
      id: input.id,
      name: input.name,
      version: input.version,
      pluginType: "integration",
      minAppVersion: "0.1.0",
      entry: input.entry ?? {
        backend: null,
        ui: "ui/index.js",
      },
      runtime: input.runtime ?? null,
      assistant: input.capabilities.includes("assistant.entry")
        ? {
            descriptor: {
              type: "inline",
              descriptor: {
                formatVersion: 1,
                provider: {
                  providerId: input.id,
                  runtimeHomeDir: {
                    kind: "home_relative",
                    relativePath: input.id === "claude-code" ? ".claude" : ".codex"
                  }
                },
                capabilitySource: {
                  kind: "session-sync-provider-capabilities",
                  adapterExport: input.id === "claude-code" ? "ClaudeCodeAdapter" : "CodexAdapter"
                },
                runtimeBridge: {
                  kind: "external-sidecar-runtime",
                  command: input.id === "claude-code" ? "x-file-claude-sidecar" : "x-file-codex-sidecar",
                  adapterExport: input.id === "claude-code" ? "ClaudeRuntimeAdapter" : "CodexRuntimeAdapter",
                  args: ["serve-runtime"],
                  shell: false,
                  permissionProtocol: input.id === "claude-code" ? "none" : "codex-server-request-v1",
                  permissionResponseProtocol: input.id === "claude-code" ? "none" : "decision-accept-decline-v1"
                }
              }
            }
          }
        : null,
      capabilities: input.capabilities,
      provider: input.provider ?? null,
      signature: {
        algorithm: "unsigned",
        value: "development",
      },
    }, null, 2)}\n`,
    "utf8",
  );
  if (input.runtime?.install.strategy === "npm-runtime") {
    fs.writeFileSync(
      path.join(targetDir, "package.json"),
      `${JSON.stringify({ name: input.id, version: input.version }, null, 2)}\n`,
      "utf8"
    );
    fs.writeFileSync(
      path.join(targetDir, "package-lock.json"),
      `${JSON.stringify({
        name: input.id,
        version: input.version,
        lockfileVersion: 3,
        requires: true,
        packages: {
          "": {
            name: input.id,
            version: input.version
          }
        }
      }, null, 2)}\n`,
      "utf8"
    );
  }
  return targetDir;
}

function createIsolatedBundledPluginRoot(baseDir: string): string {
  const bundledRootDir = path.join(baseDir, "bundled-plugins");
  const noopPluginDir = path.join(bundledRootDir, "noop");
  fs.mkdirSync(noopPluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(noopPluginDir, "manifest.json"),
    `${JSON.stringify({
      id: "noop",
      name: "Noop Plugin",
      version: "0.0.1",
      pluginType: "integration",
      minAppVersion: "0.1.0",
      entry: {
        backend: null,
        ui: "ui/index.js",
      },
      capabilities: [],
      provider: null,
      signature: {
        algorithm: "unsigned",
        value: "development",
      },
    }, null, 2)}\n`,
    "utf8"
  );
  return bundledRootDir;
}
