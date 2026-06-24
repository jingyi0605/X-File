import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AssistantRuntimeService } from "../assistant/assistant-runtime-service.js";
import { AssistantSessionStore } from "../assistant/assistant-session-store.js";
import type { AssistantStreamEvent } from "../assistant/assistant-types.js";
import { PluginService } from "../plugins/plugin-service.js";
import { LibraryBindingStore } from "../storage/library-binding-store.js";
import { PluginRegistryStore } from "../storage/plugin-registry-store.js";

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 3000,
): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("等待异步事件超时");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("assistant 最小会话链路通过 descriptor runtime 启动 sidecar bridge", async () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "x-file-assistant-runtime-home-"));
  const previousHome = process.env.HOME;
  const previousDataDir = process.env.X_FILE_DATA_DIR;
  const previousBundledPluginDir = process.env.X_FILE_BUNDLED_PLUGIN_DIR;
  process.env.HOME = tempHome;
  process.env.X_FILE_DATA_DIR = path.join(tempHome, ".x-file-data");
  process.env.X_FILE_BUNDLED_PLUGIN_DIR = createIsolatedBundledPluginRoot(tempHome);

  const authDir = path.join(tempHome, ".codex");
  fs.mkdirSync(authDir, { recursive: true });
  fs.writeFileSync(path.join(authDir, "auth.json"), "{}\n", "utf8");

  const dataDir = process.env.X_FILE_DATA_DIR;
  const libraryRoot = path.join(tempHome, "library");
  fs.mkdirSync(libraryRoot, { recursive: true });

  const bindingStore = new LibraryBindingStore({ dataDir });
  bindingStore.write({
    libraryId: "default-library",
    rootDir: libraryRoot,
    enabled: true,
    mirrorRoot: "",
    allowedExtensions: [],
    includedHiddenPaths: [],
    folderOpenBehavior: "double_click",
    configRelativePath: ".x-file.json",
    exportMode: "v2",
    initialized: true,
    initializedAt: "2026-06-16T10:00:00.000Z",
    updatedAt: "2026-06-16T10:00:00.000Z"
  });

  const pluginService = new PluginService(new PluginRegistryStore({ dataDir }));
  const runtime = new AssistantRuntimeService(
    bindingStore,
    pluginService,
    new AssistantSessionStore(dataDir)
  );

  try {
    const pluginSourceDir = createPluginSource(tempHome, {
      id: "codex",
      name: "Codex Integration",
      version: "0.1.0",
      command: process.platform === "win32" ? "where" : "which",
      authPath: path.join(authDir, "auth.json"),
    });
    pluginService.installPlugin({ sourcePath: pluginSourceDir });

    const session = await runtime.startSession({ provider: "codex" });
    const events: AssistantStreamEvent[] = [];

    await runtime.sendMessage(
      session.sessionId,
      { content: "hello plugin runtime" },
      (event) => {
        events.push(event);
      }
    );
    await waitFor(() =>
      events.some(
        (event) =>
          event.kind === "message" &&
          event.message.content === "plugin-runtime-ready"
      )
    );

    assert.equal(events.some((event) => event.kind === "message"), true);
    assert.equal(
      events.some(
        (event) =>
          event.kind === "message" &&
          event.message.content === "plugin-runtime-ready"
      ),
      true
    );
    const storedSession = runtime.loadSession(session.sessionId);
    const storedProviderSessionId = storedSession?.providerSessionId;
    assert.equal(typeof storedProviderSessionId, "string");
    assert.equal((storedProviderSessionId as string).length > 0, true);
    assert.equal(storedSession?.rawStoreRef, "plugin-raw-store");
  } finally {
    await runtime.dispose();
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

test("assistant 权限请求链路由插件提供标准化请求和审批响应", async () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "x-file-assistant-runtime-permission-home-"));
  const previousHome = process.env.HOME;
  const previousDataDir = process.env.X_FILE_DATA_DIR;
  const previousBundledPluginDir = process.env.X_FILE_BUNDLED_PLUGIN_DIR;
  process.env.HOME = tempHome;
  process.env.X_FILE_DATA_DIR = path.join(tempHome, ".x-file-data");
  process.env.X_FILE_BUNDLED_PLUGIN_DIR = createIsolatedBundledPluginRoot(tempHome);

  const authDir = path.join(tempHome, ".codex");
  fs.mkdirSync(authDir, { recursive: true });
  fs.writeFileSync(path.join(authDir, "auth.json"), "{}\n", "utf8");

  const dataDir = process.env.X_FILE_DATA_DIR;
  const libraryRoot = path.join(tempHome, "library");
  fs.mkdirSync(libraryRoot, { recursive: true });

  const bindingStore = new LibraryBindingStore({ dataDir });
  bindingStore.write({
    libraryId: "default-library",
    rootDir: libraryRoot,
    enabled: true,
    mirrorRoot: "",
    allowedExtensions: [],
    includedHiddenPaths: [],
    folderOpenBehavior: "double_click",
    configRelativePath: ".x-file.json",
    exportMode: "v2",
    initialized: true,
    initializedAt: "2026-06-16T10:00:00.000Z",
    updatedAt: "2026-06-16T10:00:00.000Z"
  });

  const pluginService = new PluginService(new PluginRegistryStore({ dataDir }));
  const runtime = new AssistantRuntimeService(
    bindingStore,
    pluginService,
    new AssistantSessionStore(dataDir)
  );

  try {
    const pluginSourceDir = createPermissionPluginSource(tempHome, {
      id: "codex",
      name: "Codex Integration",
      version: "0.1.0",
      command: process.platform === "win32" ? "where" : "which",
      authPath: path.join(authDir, "auth.json"),
    });
    pluginService.installPlugin({ sourcePath: pluginSourceDir });

    const session = await runtime.startSession({ provider: "codex" });
    const events: AssistantStreamEvent[] = [];

    await runtime.sendMessage(
      session.sessionId,
      { content: "need permission" },
      (event) => {
        events.push(event);
        if (event.kind === "permission_request") {
          runtime.replyPermissionRequest(event.request.requestId, "decline");
        }
      }
    );
    await waitFor(() =>
      events.some((event) => event.kind === "permission_request")
    );
    await waitFor(() =>
      events.some(
        (event) => event.kind === "message" && event.message.content === "permission-result:decline"
      )
    );

    const permissionEvent = events.find((event) => event.kind === "permission_request");
    assert.ok(permissionEvent && permissionEvent.kind === "permission_request");
    assert.equal(permissionEvent.request.kind, "command");
    assert.equal(permissionEvent.request.summary, "rm -rf /tmp/demo");
    assert.equal(permissionEvent.request.detail, "需要删除测试目录");
    assert.deepEqual(permissionEvent.request.metadata, {
      kind: "command",
      command: "rm -rf /tmp/demo",
      reason: "需要删除测试目录",
      cwd: null
    });

    const storedRequests = runtime.getPermissionRequests(session.sessionId);
    assert.equal(storedRequests.length, 1);
    assert.equal(storedRequests[0]?.status, "rejected");

    const storedSession = runtime.loadSession(session.sessionId);
    const storedProviderSessionId = storedSession?.providerSessionId;
    assert.equal(typeof storedProviderSessionId, "string");
    assert.equal((storedProviderSessionId as string).length > 0, true);
    assert.equal(storedSession?.rawStoreRef, "plugin-raw-store");

    const resultMessage = events.find(
      (event) => event.kind === "message" && event.message.content === "permission-result:decline"
    );
    assert.ok(resultMessage);
  } finally {
    await runtime.dispose();
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

test("assistant 文件改动权限请求会携带路径列表与操作类型", async () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "x-file-assistant-runtime-file-change-home-"));
  const previousHome = process.env.HOME;
  const previousDataDir = process.env.X_FILE_DATA_DIR;
  const previousBundledPluginDir = process.env.X_FILE_BUNDLED_PLUGIN_DIR;
  process.env.HOME = tempHome;
  process.env.X_FILE_DATA_DIR = path.join(tempHome, ".x-file-data");
  process.env.X_FILE_BUNDLED_PLUGIN_DIR = createIsolatedBundledPluginRoot(tempHome);

  const authDir = path.join(tempHome, ".codex");
  fs.mkdirSync(authDir, { recursive: true });
  fs.writeFileSync(path.join(authDir, "auth.json"), "{}\n", "utf8");

  const dataDir = process.env.X_FILE_DATA_DIR;
  const libraryRoot = path.join(tempHome, "library");
  fs.mkdirSync(libraryRoot, { recursive: true });

  const bindingStore = new LibraryBindingStore({ dataDir });
  bindingStore.write({
    libraryId: "default-library",
    rootDir: libraryRoot,
    enabled: true,
    mirrorRoot: "",
    allowedExtensions: [],
    includedHiddenPaths: [],
    folderOpenBehavior: "double_click",
    configRelativePath: ".x-file.json",
    exportMode: "v2",
    initialized: true,
    initializedAt: "2026-06-16T10:00:00.000Z",
    updatedAt: "2026-06-16T10:00:00.000Z"
  });

  const pluginService = new PluginService(new PluginRegistryStore({ dataDir }));
  const runtime = new AssistantRuntimeService(
    bindingStore,
    pluginService,
    new AssistantSessionStore(dataDir)
  );

  try {
    const pluginSourceDir = createFileChangePermissionPluginSource(tempHome, {
      id: "codex",
      name: "Codex Integration",
      version: "0.1.0",
      command: process.platform === "win32" ? "where" : "which",
      authPath: path.join(authDir, "auth.json"),
    });
    pluginService.installPlugin({ sourcePath: pluginSourceDir });

    const session = await runtime.startSession({ provider: "codex" });
    const events: AssistantStreamEvent[] = [];

    await runtime.sendMessage(
      session.sessionId,
      { content: "need file permission" },
      (event) => {
        events.push(event);
        if (event.kind === "permission_request") {
          runtime.replyPermissionRequest(event.request.requestId, "accept");
        }
      }
    );
    await waitFor(() =>
      events.some((event) => event.kind === "permission_request")
    );

    const permissionEvent = events.find((event) => event.kind === "permission_request");
    assert.ok(permissionEvent && permissionEvent.kind === "permission_request");
    assert.deepEqual(permissionEvent.request.metadata, {
      kind: "file_change",
      primaryPath: "docs/spec.md",
      changes: [
        { path: "docs/spec.md", action: "update" },
        { path: "docs/new.md", action: "add" }
      ],
      diffSummary: "*** Update File: docs/spec.md"
    });

    const storedSession = runtime.loadSession(session.sessionId);
    const storedProviderSessionId = storedSession?.providerSessionId;
    assert.equal(typeof storedProviderSessionId, "string");
    assert.equal((storedProviderSessionId as string).length > 0, true);
  } finally {
    await runtime.dispose();
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

function createPluginSource(
  baseDir: string,
  input: {
    id: string;
    name: string;
    version: string;
    command: string;
    authPath: string;
  }
): string {
  const targetDir = path.join(baseDir, `${input.id}-runtime-plugin-source`);
  const sidecarScriptPath = path.join(targetDir, "sidecar.mjs");
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
        ui: null,
      },
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
              command: process.execPath,
              adapterExport: "CodexRuntimeAdapter",
              args: [sidecarScriptPath],
              shell: false,
              permissionProtocol: "codex-server-request-v1",
              permissionResponseProtocol: "decision-accept-decline-v1"
            }
          }
        }
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
    }, null, 2)}\n`,
    "utf8"
  );
  fs.writeFileSync(
    sidecarScriptPath,
    `import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const payload = JSON.parse(line);
  if (payload.action === "start" || payload.action === "continue") {
    process.stdout.write(JSON.stringify({
      type: "session_started",
      providerSessionId: "plugin-provider-session",
      rawStoreRef: "plugin-raw-store"
    }) + "\\n");
    process.stdout.write(JSON.stringify({
      type: "event",
      providerSessionId: "plugin-provider-session",
      rawStoreRef: "plugin-raw-store",
      event: {
        type: "message",
        message: {
          messageId: "assistant-1",
          role: "assistant",
          kind: "text",
          content: "plugin-runtime-ready",
          toolCall: null,
          attachments: [],
          timestamp: new Date().toISOString(),
          sequence: 2,
          providerSessionId: "plugin-provider-session"
        }
      }
    }) + "\\n");
    process.stdout.write(JSON.stringify({
      type: "complete",
      providerSessionId: "plugin-provider-session",
      rawStoreRef: "plugin-raw-store"
    }) + "\\n");
    process.exit(0);
  }
});
`,
    "utf8"
  );
  return targetDir;
}

function createPermissionPluginSource(
  baseDir: string,
  input: {
    id: string;
    name: string;
    version: string;
    command: string;
    authPath: string;
  }
): string {
  const targetDir = path.join(baseDir, `${input.id}-permission-plugin-source`);
  const sidecarScriptPath = path.join(targetDir, "sidecar.mjs");
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
        ui: null,
      },
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
              command: process.execPath,
              adapterExport: "CodexRuntimeAdapter",
              args: [sidecarScriptPath],
              shell: false,
              permissionProtocol: "codex-server-request-v1",
              permissionResponseProtocol: "decision-accept-decline-v1"
            }
          }
        }
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
    }, null, 2)}\n`,
    "utf8"
  );
  fs.writeFileSync(
    sidecarScriptPath,
    `import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let waiting = false;
rl.on("line", (line) => {
  const payload = JSON.parse(line);
  if (payload.action === "start" || payload.action === "continue") {
    process.stdout.write(JSON.stringify({
      type: "session_started",
      providerSessionId: "plugin-provider-session",
      rawStoreRef: "plugin-raw-store"
    }) + "\\n");
    process.stdout.write(JSON.stringify({
      type: "permission_request",
      providerSessionId: "plugin-provider-session",
      requestId: "perm-1",
      request: {
        method: "item/commandExecution/requestApproval",
        params: {
          command: "rm -rf /tmp/demo",
          reason: "需要删除测试目录",
          cwd: null
        }
      }
    }) + "\\n");
    waiting = true;
    return;
  }
  if (payload.action === "permission_response" && waiting) {
    waiting = false;
    process.stdout.write(JSON.stringify({
      type: "event",
      providerSessionId: "plugin-provider-session",
      rawStoreRef: "plugin-raw-store",
      event: {
        type: "message",
        message: {
          messageId: "assistant-1",
          role: "assistant",
          kind: "text",
          content: "permission-result:" + (payload.response?.decision ?? "unknown"),
          toolCall: null,
          attachments: [],
          timestamp: new Date().toISOString(),
          sequence: 2,
          providerSessionId: "plugin-provider-session"
        }
      }
    }) + "\\n");
    process.stdout.write(JSON.stringify({
      type: "complete",
      providerSessionId: "plugin-provider-session",
      rawStoreRef: "plugin-raw-store"
    }) + "\\n");
    process.exit(0);
  }
});
`,
    "utf8"
  );
  return targetDir;
}

function createFileChangePermissionPluginSource(
  baseDir: string,
  input: {
    id: string;
    name: string;
    version: string;
    command: string;
    authPath: string;
  }
): string {
  const targetDir = path.join(baseDir, `${input.id}-file-change-plugin-source`);
  const sidecarScriptPath = path.join(targetDir, "sidecar.mjs");
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
        ui: null,
      },
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
              command: process.execPath,
              adapterExport: "CodexRuntimeAdapter",
              args: [sidecarScriptPath],
              shell: false,
              permissionProtocol: "codex-server-request-v1",
              permissionResponseProtocol: "decision-accept-decline-v1"
            }
          }
        }
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
    }, null, 2)}\n`,
    "utf8"
  );
  fs.writeFileSync(
    sidecarScriptPath,
    `import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let waiting = false;
rl.on("line", (line) => {
  const payload = JSON.parse(line);
  if (payload.action === "start" || payload.action === "continue") {
    process.stdout.write(JSON.stringify({
      type: "session_started",
      providerSessionId: "plugin-provider-session",
      rawStoreRef: "plugin-raw-store"
    }) + "\\n");
    process.stdout.write(JSON.stringify({
      type: "permission_request",
      providerSessionId: "plugin-provider-session",
      requestId: "perm-1",
      request: {
        method: "item/fileChange/requestApproval",
        params: {
          grantRoot: "docs/spec.md",
          primaryPath: "docs/spec.md",
          changes: [
            { path: "docs/spec.md", kind: "update", diff: "*** Update File: docs/spec.md" },
            { path: "docs/new.md", kind: "add", diff: null }
          ]
        }
      }
    }) + "\\n");
    waiting = true;
    return;
  }
  if (payload.action === "permission_response" && waiting) {
    waiting = false;
    process.stdout.write(JSON.stringify({
      type: "complete",
      providerSessionId: "plugin-provider-session",
      rawStoreRef: "plugin-raw-store"
    }) + "\\n");
    process.exit(0);
  }
});
`,
    "utf8"
  );
  return targetDir;
}
