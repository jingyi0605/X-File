import type { AssistantProviderId } from "./assistant-types.js";

export type AssistantPluginPermissionKind = "command" | "file_change" | "other";
export type AssistantPluginPermissionAction = "accept" | "decline";

export interface AssistantPluginCommandPermissionPayload {
  method: string | null;
  command: string | null;
  reason: string | null;
  cwd: string | null;
}

export interface AssistantPluginFileChangePermissionPayload {
  method: string | null;
  grantRoot: string | null;
  primaryPath: string | null;
  changes: Array<{
    path: string | null;
    kind: string | null;
    diff: string | null;
  }>;
}

export interface AssistantPluginOtherPermissionPayload {
  method: string | null;
  params?: Record<string, unknown> | null;
}

export interface AssistantPluginRuntimeCapability {
  supportsAttachments: boolean;
  modelOptions: Array<{
    id: string;
    name: string;
    usesProviderDefault?: boolean;
    supportedReasoningEfforts?: string[];
  }>;
  defaultReasoningLevel: string | null;
  supportedReasoningLevels: string[];
}

export interface AssistantPluginRuntimeProviderInfo {
  providerId: AssistantProviderId;
  runtimeHomeDir: string;
}

/**
 * descriptor 不直接携带绝对路径，避免把宿主环境细节编码进插件清单。
 * 宿主后续只需要知道“相对 home 的哪个目录”即可解析真实 runtime home。
 */
export interface AssistantPluginRuntimeHomeDirSpec {
  kind: "home_relative";
  relativePath: string;
}

/**
 * descriptor 层只描述 provider 的宿主无关信息。
 * 运行时模块仍然使用 AssistantPluginRuntimeProviderInfo 暴露已解析的绝对路径。
 */
export interface AssistantPluginRuntimeDescriptorProviderInfo {
  providerId: AssistantProviderId;
  runtimeHomeDir: AssistantPluginRuntimeHomeDirSpec;
}

/**
 * capabilitySource 告诉宿主：应从哪个 provider adapter 读取能力声明。
 * 这允许后续直接通过共享 runtime bridge 组装能力，而不是 import 插件 backend JS。
 */
export interface AssistantPluginRuntimeCapabilitySourceDescriptor {
  kind: "session-sync-provider-capabilities";
  adapterExport: string;
}

export type AssistantPluginRuntimePermissionProtocol =
  | "none"
  | "codex-server-request-v1";

export type AssistantPluginRuntimePermissionResponseProtocol =
  | "none"
  | "decision-accept-decline-v1";

export interface AssistantPluginExternalSidecarRuntimeBridgeDescriptor {
  kind: "external-sidecar-runtime";
  command: string;
  adapterExport: string;
  args?: string[];
  shell?: boolean;
  permissionProtocol?: AssistantPluginRuntimePermissionProtocol;
  permissionResponseProtocol?: AssistantPluginRuntimePermissionResponseProtocol | null;
}

export interface AssistantPluginRuntimeDescriptor {
  formatVersion: 1;
  provider: AssistantPluginRuntimeDescriptorProviderInfo;
  capabilitySource: AssistantPluginRuntimeCapabilitySourceDescriptor;
  runtimeBridge: AssistantPluginExternalSidecarRuntimeBridgeDescriptor;
}

/**
 * manifest 允许内联 descriptor，也允许后续下沉到插件目录内独立文件。
 * assistant/provider runtime 现已固定走 external sidecar/runtime bridge。
 */
export type AssistantPluginRuntimeDescriptorReference =
  | {
      type: "inline";
      descriptor: AssistantPluginRuntimeDescriptor;
    }
  | {
      type: "file";
      path: string;
    };

export interface AssistantPluginRuntimeManifest {
  descriptor?: AssistantPluginRuntimeDescriptorReference | null;
}

export type AssistantPluginPermissionRequest =
  | {
      kind: "command";
      title: string;
      summary: string;
      detail: string | null;
      payload?: AssistantPluginCommandPermissionPayload | null;
    }
  | {
      kind: "file_change";
      title: string;
      summary: string;
      detail: string | null;
      payload?: AssistantPluginFileChangePermissionPayload | null;
    }
  | {
      kind: "other";
      title: string;
      summary: string;
      detail: string | null;
      payload?: AssistantPluginOtherPermissionPayload | null;
    };

export interface AssistantPluginPermissionRequestInput {
  sessionId: string;
  providerSessionId: string;
  request: AssistantPluginPermissionRequest;
}

export interface AssistantPluginPermissionResponseBuilderInput {
  action: AssistantPluginPermissionAction;
  request: AssistantPluginPermissionRequest;
}

export interface AssistantPluginRuntimeSessionContext {
  sessionId: string;
  workspaceId: string;
  workspacePath: string;
}

export interface AssistantPluginRuntimePermissionBridge {
  requestPermission(
    input: AssistantPluginPermissionRequestInput
  ): Promise<unknown>;
}

export interface AssistantPluginRuntimeFactoryDeps {
  importSessionSyncCore(): Promise<Record<string, unknown>>;
  resolveHomePath(relativePath: string): string;
}

export interface AssistantPluginRuntimeModule {
  descriptor?: AssistantPluginRuntimeDescriptor | null;
  provider: AssistantPluginRuntimeProviderInfo;
  capabilities: AssistantPluginRuntimeCapability;
  buildPermissionResponse?(
    input: AssistantPluginPermissionResponseBuilderInput
  ): Promise<unknown> | unknown;
  createRuntimeAdapter(input: {
    permissionBridge: AssistantPluginRuntimePermissionBridge;
    session: AssistantPluginRuntimeSessionContext;
  }): Promise<unknown> | unknown;
}
