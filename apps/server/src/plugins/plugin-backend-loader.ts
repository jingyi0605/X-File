import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  AssistantPluginPermissionAction,
  AssistantPluginRuntimeCapability,
  AssistantPluginRuntimeDescriptor,
  AssistantPluginRuntimeDescriptorReference,
  AssistantPluginRuntimeModule,
  AssistantPluginRuntimePermissionBridge,
  AssistantPluginRuntimeSessionContext,
  PluginManifest,
  PluginRegistryRecord
} from "@x-file/shared";

import { LibraryError } from "../library/library-errors.js";
import type { PluginRegistryStore } from "../storage/plugin-registry-store.js";

export async function loadAssistantPluginRuntimeModule(input: {
  manifest: PluginManifest;
  registry: PluginRegistryRecord;
  registryStore: PluginRegistryStore;
}): Promise<AssistantPluginRuntimeModule> {
  const descriptor = await resolveAssistantRuntimeDescriptor(input.manifest, input.registry);
  if (descriptor) {
    return buildAssistantRuntimeModuleFromDescriptor(descriptor);
  }

  const backendEntry = input.manifest.entry.backend?.trim();
  if (!backendEntry) {
    throw new LibraryError(
      400,
      "PLUGIN_ENTRY_INVALID",
      `插件 ${input.manifest.id} 未声明 assistant descriptor；主包 assistant/plugin runtime 已不再接受 backend 入口`
    );
  }

  throw new LibraryError(
    400,
    "PLUGIN_ENTRY_INVALID",
    `插件 ${input.manifest.id} 仍依赖 backend 入口 ${backendEntry}；主包 assistant/plugin runtime 已移除这条 Node ABI，请改用 assistant.descriptor + external-sidecar-runtime`
  );
}

async function resolveAssistantRuntimeDescriptor(
  manifest: PluginManifest,
  registry: PluginRegistryRecord
): Promise<AssistantPluginRuntimeDescriptor | null> {
  const reference = manifest.assistant?.descriptor ?? null;
  if (!reference) {
    return null;
  }

  const descriptor =
    reference.type === "file"
      ? readAssistantRuntimeDescriptorFromFile(registry.installDir, reference)
      : reference.descriptor;
  validateAssistantRuntimeDescriptor(manifest.id, descriptor);
  return descriptor;
}

function readAssistantRuntimeDescriptorFromFile(
  installDir: string,
  reference: Extract<AssistantPluginRuntimeDescriptorReference, { type: "file" }>
): AssistantPluginRuntimeDescriptor {
  const descriptorPath = path.resolve(installDir, reference.path);
  if (!fs.existsSync(descriptorPath)) {
    throw new LibraryError(400, "PLUGIN_ENTRY_INVALID", `插件 descriptor 不存在：${descriptorPath}`);
  }
  return JSON.parse(fs.readFileSync(descriptorPath, "utf8")) as AssistantPluginRuntimeDescriptor;
}

async function buildAssistantRuntimeModuleFromDescriptor(
  descriptor: AssistantPluginRuntimeDescriptor
): Promise<AssistantPluginRuntimeModule> {
  const sessionSyncCore = await import("@codingns/session-sync-core");
  const providerHomeDir = resolveDescriptorHomePath(descriptor);
  const provider = buildDescriptorProviderInfo(descriptor, providerHomeDir);
  const capabilities = buildDescriptorCapabilities(sessionSyncCore, descriptor, providerHomeDir);

  return {
    descriptor,
    provider,
    capabilities,
    buildPermissionResponse: ({ action }) => buildPermissionResponse(descriptor, action),
    createRuntimeAdapter: ({ permissionBridge, session }) =>
      buildRuntimeAdapter(sessionSyncCore, descriptor, providerHomeDir, permissionBridge, session)
  };
}

function resolveDescriptorHomePath(descriptor: AssistantPluginRuntimeDescriptor): string {
  const runtimeHome = descriptor.provider.runtimeHomeDir;
  if (runtimeHome.kind !== "home_relative") {
    throw new LibraryError(400, "PLUGIN_ENTRY_INVALID", "当前只支持 home_relative runtimeHomeDir");
  }
  return path.join(os.homedir(), runtimeHome.relativePath);
}

function buildDescriptorProviderInfo(
  descriptor: AssistantPluginRuntimeDescriptor,
  runtimeHomeDir: string
): AssistantPluginRuntimeModule["provider"] {
  return {
    providerId: descriptor.provider.providerId,
    runtimeHomeDir
  };
}

function buildDescriptorCapabilities(
  sessionSyncCore: Record<string, unknown>,
  descriptor: AssistantPluginRuntimeDescriptor,
  runtimeHomeDir: string
): AssistantPluginRuntimeCapability {
  if (descriptor.capabilitySource.kind !== "session-sync-provider-capabilities") {
    throw new LibraryError(400, "PLUGIN_ENTRY_INVALID", "不支持的 capabilitySource.kind");
  }
  const AdapterCtor = readNamedExport(sessionSyncCore, descriptor.capabilitySource.adapterExport, "capabilitySource.adapterExport");
  const adapterInstance = new AdapterCtor({ homeDir: runtimeHomeDir });
  if (typeof adapterInstance.getProviderCapabilities !== "function") {
    throw new LibraryError(400, "PLUGIN_ENTRY_INVALID", `provider capability adapter 缺少 getProviderCapabilities`);
  }
  const capabilities = adapterInstance.getProviderCapabilities() as Record<string, unknown>;
  const modelOptions = Array.isArray(capabilities.modelOptions)
    ? capabilities.modelOptions.map((item: unknown) => {
        const record = item && typeof item === "object" ? item as Record<string, unknown> : {};
        return {
          id: typeof record.id === "string" ? record.id : "provider-default",
          name: typeof record.name === "string" ? record.name : "默认",
          usesProviderDefault: record.usesProviderDefault === true,
          supportedReasoningEfforts: Array.isArray(record.supportedReasoningEfforts)
            ? record.supportedReasoningEfforts.filter((effort: unknown): effort is string => typeof effort === "string")
          : []
        };
      })
    : [];
  const levels = new Set<string>();
  for (const option of modelOptions) {
    for (const effort of option.supportedReasoningEfforts ?? []) {
      levels.add(effort);
    }
  }
  return {
    supportsAttachments: capabilities.supportsAttachments === true,
    modelOptions,
    defaultReasoningLevel: typeof capabilities.defaultReasoningLevel === "string"
      ? capabilities.defaultReasoningLevel
      : null,
    supportedReasoningLevels: [...levels]
  };
}

function buildPermissionResponse(
  descriptor: AssistantPluginRuntimeDescriptor,
  action: AssistantPluginPermissionAction
): unknown {
  const protocol = descriptor.runtimeBridge.permissionResponseProtocol ?? "none";
  if (protocol === "decision-accept-decline-v1") {
    return {
      decision: action === "accept" ? "accept" : "decline"
    };
  }
  return {
    decision: action === "accept" ? "accept" : "decline"
  };
}

function buildRuntimeAdapter(
  sessionSyncCore: Record<string, unknown>,
  descriptor: AssistantPluginRuntimeDescriptor,
  runtimeHomeDir: string,
  permissionBridge: AssistantPluginRuntimePermissionBridge,
  session: AssistantPluginRuntimeSessionContext
): unknown {
  const RuntimeCtor = readNamedExport(
    sessionSyncCore,
    "ExternalSidecarRuntimeAdapter",
    "runtimeBridge.kind"
  );
  return new RuntimeCtor({
    providerId: descriptor.provider.providerId,
    commandPath: descriptor.runtimeBridge.command,
    adapterExport: descriptor.runtimeBridge.adapterExport,
    commandArgs: descriptor.runtimeBridge.args ?? [],
    runtimeHomeDir,
    shell: descriptor.runtimeBridge.shell ?? false,
    permissionProtocol: descriptor.runtimeBridge.permissionProtocol ?? "none",
    requestPermission: async (input: {
      sessionId: string;
      providerSessionId: string;
      request: Record<string, unknown>;
    }) =>
      permissionBridge.requestPermission({
        sessionId: input.sessionId || session.sessionId,
        providerSessionId: input.providerSessionId,
        request: parseCodexPermissionRequest(input.request)
      })
  });
}

function readNamedExport(
  source: Record<string, unknown>,
  exportName: string,
  fieldName: string
): new (...args: any[]) => any {
  const candidate = source[exportName];
  if (typeof candidate !== "function") {
    throw new LibraryError(400, "PLUGIN_ENTRY_INVALID", `${fieldName} 未导出有效构造器：${exportName}`);
  }
  return candidate as new (...args: any[]) => any;
}

function parseCodexPermissionRequest(request: Record<string, unknown>) {
  const method = typeof request?.method === "string" ? request.method : "";
  const params = request?.params && typeof request.params === "object"
    ? (request.params as Record<string, unknown>)
    : {};
  const command = typeof params.command === "string"
    ? params.command
    : typeof request.command === "string"
      ? request.command
      : "";
  const reason = typeof params.reason === "string"
    ? params.reason
    : typeof request.reason === "string"
      ? request.reason
      : "";
  const cwd = typeof params.cwd === "string"
    ? params.cwd
    : typeof request.cwd === "string"
      ? request.cwd
      : "";
  const grantRoot = typeof params.grantRoot === "string"
    ? params.grantRoot
    : typeof request.grantRoot === "string"
      ? request.grantRoot
      : "";
  const rawChanges = Array.isArray(params.changes)
    ? params.changes
    : Array.isArray(request.changes)
      ? request.changes
      : [];

  if (method === "item/commandExecution/requestApproval" || method === "item/command/requestApproval") {
    return {
      kind: "command" as const,
      title: "Codex 请求执行命令",
      summary: command || "执行命令",
      detail: reason || null,
      payload: {
        method,
        command: command || null,
        reason: reason || null,
        cwd: cwd || null,
      },
    };
  }

  if (method === "item/fileChange/requestApproval") {
    return {
      kind: "file_change" as const,
      title: "Codex 请求改动文件",
      summary: grantRoot || "改动文件",
      detail: null,
      payload: {
        method,
        grantRoot: grantRoot || null,
        primaryPath: grantRoot || null,
        changes: rawChanges.map((change) => {
          const record = change && typeof change === "object" ? change as Record<string, unknown> : {};
          return {
            path: typeof record.path === "string" ? record.path : null,
            kind: typeof record.kind === "string" ? record.kind : null,
            diff: typeof record.diff === "string" ? record.diff : null,
          };
        }),
      },
    };
  }

  return {
    kind: "other" as const,
    title: `Codex 请求：${method || "未知操作"}`,
    summary: method || "未知操作",
    detail: safeStringify(params),
    payload: {
      method,
      params,
    },
  };
}

function safeStringify(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    return text.length > 500 ? `${text.slice(0, 500)}...` : text;
  } catch {
    return "";
  }
}

function validateAssistantPluginRuntimeModule(pluginId: string, value: unknown): void {
  const module = value as Partial<AssistantPluginRuntimeModule>;
  if (!module.provider || typeof module.provider !== "object") {
    throw new LibraryError(400, "PLUGIN_ENTRY_INVALID", `插件 ${pluginId} 缺少 provider 定义`);
  }
  if (!module.capabilities || typeof module.capabilities !== "object") {
    throw new LibraryError(400, "PLUGIN_ENTRY_INVALID", `插件 ${pluginId} 缺少 capabilities 定义`);
  }
  if (typeof module.createRuntimeAdapter !== "function") {
    throw new LibraryError(400, "PLUGIN_ENTRY_INVALID", `插件 ${pluginId} 缺少 createRuntimeAdapter`);
  }
}

function validateAssistantRuntimeDescriptor(
  pluginId: string,
  descriptor: AssistantPluginRuntimeDescriptor
): void {
  if (descriptor.formatVersion !== 1) {
    throw new LibraryError(400, "PLUGIN_ENTRY_INVALID", `插件 ${pluginId} descriptor formatVersion 不支持`);
  }
  if (!descriptor.provider || typeof descriptor.provider !== "object") {
    throw new LibraryError(400, "PLUGIN_ENTRY_INVALID", `插件 ${pluginId} descriptor 缺少 provider 定义`);
  }
  if (!descriptor.capabilitySource || typeof descriptor.capabilitySource !== "object") {
    throw new LibraryError(400, "PLUGIN_ENTRY_INVALID", `插件 ${pluginId} descriptor 缺少 capabilitySource 定义`);
  }
  if (!descriptor.runtimeBridge || typeof descriptor.runtimeBridge !== "object") {
    throw new LibraryError(400, "PLUGIN_ENTRY_INVALID", `插件 ${pluginId} descriptor 缺少 runtimeBridge 定义`);
  }
}
