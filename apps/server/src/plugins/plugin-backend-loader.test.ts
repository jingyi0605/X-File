import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { PluginManifest, PluginRegistryRecord } from "@x-file/shared";

import { loadAssistantPluginRuntimeModule } from "./plugin-backend-loader.js";
import { PluginRegistryStore } from "../storage/plugin-registry-store.js";

test("legacy 插件 backend 入口会被永久拒绝", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "x-file-plugin-loader-"));
  const backendDir = path.join(tempDir, "backend");
  fs.mkdirSync(backendDir, { recursive: true });
  fs.writeFileSync(
    path.join(backendDir, "index.js"),
    `export async function createAssistantRuntimeModule() {
      return {
        provider: { providerId: "codex", runtimeHomeDir: "/tmp/codex-home" },
        capabilities: {
          supportsAttachments: true,
          modelOptions: [{ id: "provider-default", name: "默认" }],
          defaultReasoningLevel: "medium",
          supportedReasoningLevels: ["medium"]
        },
        createRuntimeAdapter() {
          return { providerId: "codex", startSession() {}, continueSession() {} };
        }
      };
    }\n`,
    "utf8"
  );

  const manifest: PluginManifest = {
    id: "codex",
    name: "Codex Integration",
    version: "0.1.0",
    pluginType: "integration",
    minAppVersion: "0.1.0",
    entry: { backend: "backend/index.js", ui: null },
    capabilities: ["assistant.entry"],
    provider: null,
    signature: { algorithm: "unsigned", value: "development" },
  };
  const registry: PluginRegistryRecord = {
    pluginId: "codex",
    version: "0.1.0",
    installDir: tempDir,
    enabled: true,
    installedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastHealthStatus: "unknown",
    lastError: null,
    grantedCapabilities: [],
  };
  const registryStore = new PluginRegistryStore({ dataDir: path.join(tempDir, "data") });

  await assert.rejects(
    loadAssistantPluginRuntimeModule({ manifest, registry, registryStore }),
    /已移除这条 Node ABI/
  );
});

test("legacy npm-runtime backend 入口会被永久拒绝", async () => {
  const tempRootDir = fs.mkdtempSync(path.join(os.tmpdir(), "x-file-plugin-loader-npm-"));
  const tempDir = path.join(tempRootDir, "plugin-source");
  const dataDir = path.join(tempRootDir, "runtime-data");
  fs.mkdirSync(tempDir, { recursive: true });
  const backendDir = path.join(tempDir, "backend");
  fs.mkdirSync(backendDir, { recursive: true });
  fs.writeFileSync(
    path.join(tempDir, "package.json"),
    `${JSON.stringify({
      name: "x-file-test-plugin-runtime",
      version: "0.0.1"
    }, null, 2)}\n`,
    "utf8"
  );
  fs.writeFileSync(
    path.join(tempDir, "package-lock.json"),
    `${JSON.stringify({
      name: "x-file-test-plugin-runtime",
      version: "0.0.1",
      lockfileVersion: 3,
      requires: true,
      packages: {
        "": {
          name: "x-file-test-plugin-runtime",
          version: "0.0.1"
        }
      }
    }, null, 2)}\n`,
    "utf8"
  );
  fs.writeFileSync(
    path.join(backendDir, "index.js"),
    `export async function createAssistantRuntimeModule() {
      return {
        provider: { providerId: "codex", runtimeHomeDir: "/tmp/npm-runtime-home" },
        capabilities: {
          supportsAttachments: true,
          modelOptions: [{ id: "provider-default", name: "默认" }],
          defaultReasoningLevel: "medium",
          supportedReasoningLevels: ["medium"]
        },
        createRuntimeAdapter() {
          return { providerId: "codex", startSession() {}, continueSession() {} };
        }
      };
    }\n`,
    "utf8"
  );

  const manifest: PluginManifest = {
    id: "codex",
    name: "Codex Integration",
    version: "0.1.0",
    pluginType: "integration",
    minAppVersion: "0.1.0",
    entry: { backend: "backend/index.js", ui: null },
    runtime: {
      install: {
        strategy: "npm-runtime",
        packageManager: "npm",
        installArgs: ["install", "--package-lock=false", "--ignore-scripts"],
      }
    },
    capabilities: ["assistant.entry"],
    provider: null,
    signature: { algorithm: "unsigned", value: "development" },
  };
  const registry: PluginRegistryRecord = {
    pluginId: "codex",
    version: "0.1.0",
    installDir: tempDir,
    enabled: true,
    installedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastHealthStatus: "unknown",
    lastError: null,
    grantedCapabilities: [],
  };
  const registryStore = new PluginRegistryStore({ dataDir });

  await assert.rejects(
    loadAssistantPluginRuntimeModule({ manifest, registry, registryStore }),
    /已移除这条 Node ABI/
  );
});

test("descriptor 插件只能声明 external sidecar runtime bridge", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "x-file-plugin-loader-descriptor-"));
  const manifest: PluginManifest = {
    id: "codex",
    name: "Codex Integration",
    version: "0.1.0",
    pluginType: "integration",
    minAppVersion: "0.1.0",
    entry: { backend: null, ui: null },
    assistant: {
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
    },
    capabilities: ["assistant.entry"],
    provider: {
      providerId: "codex",
      displayName: "Codex",
      command: "codex",
      auth: {
        strategy: "file_exists",
        path: "~/.codex/auth.json"
      }
    },
    signature: { algorithm: "unsigned", value: "development" },
  };
  const registry: PluginRegistryRecord = {
    pluginId: "codex",
    version: "0.1.0",
    installDir: tempDir,
    enabled: true,
    installedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastHealthStatus: "unknown",
    lastError: null,
    grantedCapabilities: [],
  };
  const registryStore = new PluginRegistryStore({ dataDir: path.join(tempDir, "data") });

  const runtimeModule = await loadAssistantPluginRuntimeModule({ manifest, registry, registryStore });

  assert.equal(runtimeModule.provider.providerId, "codex");
  assert.equal(runtimeModule.provider.runtimeHomeDir, path.join(os.homedir(), ".codex"));
  assert.equal(runtimeModule.capabilities.supportsAttachments, true);
  assert.equal(typeof runtimeModule.createRuntimeAdapter, "function");
});

test("descriptor 插件可以声明 external sidecar runtime bridge", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "x-file-plugin-loader-external-sidecar-"));
  const manifest: PluginManifest = {
    id: "codex",
    name: "Codex Integration",
    version: "0.1.0",
    pluginType: "integration",
    minAppVersion: "0.1.0",
    entry: { backend: null, ui: null },
    assistant: {
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
    },
    capabilities: ["assistant.entry"],
    provider: {
      providerId: "codex",
      displayName: "Codex",
      command: "codex",
      auth: {
        strategy: "file_exists",
        path: "~/.codex/auth.json"
      }
    },
    signature: { algorithm: "unsigned", value: "development" },
  };
  const registry: PluginRegistryRecord = {
    pluginId: "codex",
    version: "0.1.0",
    installDir: tempDir,
    enabled: true,
    installedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastHealthStatus: "unknown",
    lastError: null,
    grantedCapabilities: [],
  };
  const registryStore = new PluginRegistryStore({ dataDir: path.join(tempDir, "data") });

  const runtimeModule = await loadAssistantPluginRuntimeModule({ manifest, registry, registryStore });
  const runtimeAdapter = await runtimeModule.createRuntimeAdapter({
    permissionBridge: {
      requestPermission: async () => ({ decision: "accept" })
    },
    session: {
      sessionId: "session-1",
      workspaceId: "workspace-1",
      workspacePath: tempDir,
    }
  }) as { providerId?: string };

  assert.equal(runtimeModule.provider.providerId, "codex");
  assert.equal(runtimeModule.provider.runtimeHomeDir, path.join(os.homedir(), ".codex"));
  assert.equal(runtimeAdapter.providerId, "codex");
});
