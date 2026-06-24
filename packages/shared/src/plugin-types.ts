import type { AssistantPluginRuntimeManifest } from "./assistant-plugin-types.js";

export type PluginType = "integration";

export type PluginHealthStatus = "unknown" | "healthy" | "degraded" | "failed";

export interface PluginSignature {
  algorithm: string;
  value: string;
}

export interface PluginEntry {
  backend?: string | null;
  ui?: string | null;
}

export interface PluginRuntimeInstall {
  strategy: "system-cli" | "npm-runtime";
  packageManager?: "npm";
  projectDir?: string | null;
  lockfilePath?: string | null;
  installArgs?: string[];
}

export interface PluginProviderMeta {
  providerId: string;
  displayName: string;
  command: string | null;
  auth: {
    strategy: "file_exists" | "directory_exists" | "custom";
    path: string | null;
  };
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  pluginType: PluginType;
  minAppVersion: string;
  entry: PluginEntry;
  runtime?: {
    install?: PluginRuntimeInstall | null;
  } | null;
  assistant?: AssistantPluginRuntimeManifest | null;
  capabilities: string[];
  provider?: PluginProviderMeta | null;
  signature: PluginSignature;
}

export interface PluginRegistryRecord {
  pluginId: string;
  version: string;
  installDir: string;
  enabled: boolean;
  installedAt: string;
  updatedAt: string;
  lastHealthStatus: PluginHealthStatus;
  lastError: string | null;
  grantedCapabilities: string[];
}

export interface PluginHealth {
  pluginId: string;
  enabled: boolean;
  status: Exclude<PluginHealthStatus, "unknown"> | "unknown";
  detail: string | null;
  commandReady: boolean | null;
  authReady: boolean | null;
}

export interface PluginListItem {
  manifest: PluginManifest;
  registry: PluginRegistryRecord;
  health: PluginHealth;
}

export interface PluginListResult {
  plugins: PluginListItem[];
  pluginRootDir: string;
  bundledPluginRootDir?: string | null;
  bundledPluginScanCandidates?: string[];
}

export interface InstallPluginInput {
  sourcePath: string;
}

export interface UpdatePluginInput {
  sourcePath: string;
}

export interface PluginMutationResult {
  plugin: PluginListItem;
  pluginRootDir: string;
  bundledPluginRootDir?: string | null;
  bundledPluginScanCandidates?: string[];
}
