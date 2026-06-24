import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  AssistantProviderId,
  InstallPluginInput,
  PluginListItem,
  PluginListResult,
  PluginManifest,
  PluginMutationResult,
  PluginRegistryRecord,
  UpdatePluginInput,
} from "@x-file/shared";

import { LibraryError } from "../library/library-errors.js";
import type { PluginRegistryStore } from "../storage/plugin-registry-store.js";
import { loadAssistantPluginRuntimeModule } from "./plugin-backend-loader.js";
import { ProviderBridgeService } from "./provider-bridge-service.js";

const MANIFEST_FILE_NAME = "manifest.json";
const APP_VERSION = "0.1.0-beta.1";
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT_DIR = path.resolve(MODULE_DIR, "..", "..", "..", "..");
const BUNDLED_PLUGIN_DIR_CANDIDATES = [
  path.join(WORKSPACE_ROOT_DIR, "apps", "desktop", "src-tauri", "resources", "x-file-plugins"),
  path.join(WORKSPACE_ROOT_DIR, "plugins"),
];

export class PluginService {
  private readonly bundledPluginRootDir: string | null;

  constructor(
    private readonly registryStore: PluginRegistryStore,
    private readonly providerBridge = new ProviderBridgeService()
  ) {
    this.bundledPluginRootDir = resolveBundledPluginRootDir();
    this.syncBundledPlugins();
  }

  listPlugins(): PluginListResult {
    this.syncBundledPlugins();
    const pluginRootDir = this.registryStore.getPluginRootDir();
    const registryRecords = this.registryStore.list();
    const plugins = registryRecords.map((record) => this.buildPluginListItem(record));
    return {
      plugins,
      pluginRootDir,
      bundledPluginRootDir: this.bundledPluginRootDir,
      bundledPluginScanCandidates: BUNDLED_PLUGIN_DIR_CANDIDATES,
    };
  }

  listEnabledAssistantProviders(): Array<{
    manifest: PluginManifest;
    registry: PluginRegistryRecord;
    health: PluginListItem["health"];
    providerId: AssistantProviderId;
  }> {
    this.syncBundledPlugins();
    return this.registryStore
      .list()
      .map((record) => this.buildPluginListItem(record))
      .flatMap((item) => {
        if (!item.registry.enabled || !item.manifest.provider) {
          return [];
        }
        const providerId = item.manifest.provider.providerId;
        if (!isAssistantProviderId(providerId)) {
          return [];
        }
        return [{
          manifest: item.manifest,
          registry: item.registry,
          health: item.health,
          providerId,
        }];
      });
  }

  async getEnabledAssistantRuntimePlugin(
    providerId: AssistantProviderId
  ): Promise<{
    manifest: PluginManifest;
    registry: PluginRegistryRecord;
    health: PluginListItem["health"];
    providerId: AssistantProviderId;
    runtimeModule: Awaited<ReturnType<typeof loadAssistantPluginRuntimeModule>>;
    } | null> {
    this.syncBundledPlugins();
    const match = this.listEnabledAssistantProviders().find((item) => item.providerId === providerId);
    if (!match) {
      return null;
    }
    const runtimeModule = await loadAssistantPluginRuntimeModule({
      manifest: match.manifest,
      registry: match.registry,
      registryStore: this.registryStore,
    });
    return {
      ...match,
      runtimeModule,
    };
  }

  installPlugin(input: InstallPluginInput): PluginMutationResult {
    const sourcePath = normalizeSourcePath(input.sourcePath);
    const manifest = this.readManifestFromDirectory(sourcePath);
    ensurePluginCompatibility(manifest);

    const installDir = this.resolveVersionInstallDir(manifest.id, manifest.version);
    if (fs.existsSync(installDir)) {
      throw new LibraryError(409, "PLUGIN_INCOMPATIBLE", `插件版本已存在：${manifest.id}@${manifest.version}`);
    }

    copyDirectory(sourcePath, installDir);
    try {
      const record = this.registryStore.upsert(
        buildRegistryRecord(manifest, installDir, this.registryStore.get(manifest.id))
      );
      return {
        plugin: this.buildPluginListItem(record),
        pluginRootDir: this.registryStore.getPluginRootDir(),
        bundledPluginRootDir: this.bundledPluginRootDir,
        bundledPluginScanCandidates: BUNDLED_PLUGIN_DIR_CANDIDATES,
      };
    } catch (error) {
      fs.rmSync(installDir, { recursive: true, force: true });
      throw error;
    }
  }

  updatePlugin(pluginId: string, input: UpdatePluginInput): PluginMutationResult {
    const existing = this.requireRegistryRecord(pluginId);
    if (this.isBundledPluginRecord(existing)) {
      throw new LibraryError(400, "PLUGIN_INCOMPATIBLE", `内置插件不支持手工更新：${pluginId}`);
    }
    const previousRecord = { ...existing };
    const sourcePath = normalizeSourcePath(input.sourcePath);
    const manifest = this.readManifestFromDirectory(sourcePath);
    if (manifest.id !== pluginId) {
      throw new LibraryError(400, "PLUGIN_INCOMPATIBLE", `插件 ID 不匹配：期望 ${pluginId}，实际 ${manifest.id}`);
    }
    ensurePluginCompatibility(manifest);

    const installDir = this.resolveVersionInstallDir(manifest.id, manifest.version);
    if (installDir !== existing.installDir && fs.existsSync(installDir)) {
      throw new LibraryError(409, "PLUGIN_INCOMPATIBLE", `目标版本目录已存在：${manifest.id}@${manifest.version}`);
    }

    copyDirectory(sourcePath, installDir);
    try {
      const nextRecord = this.registryStore.upsert({
        ...existing,
        version: manifest.version,
        installDir,
        updatedAt: new Date().toISOString(),
        lastHealthStatus: "unknown",
        lastError: null,
      });

      if (installDir !== previousRecord.installDir) {
        fs.rmSync(previousRecord.installDir, { recursive: true, force: true });
      }

      return {
        plugin: this.buildPluginListItem(nextRecord),
        pluginRootDir: this.registryStore.getPluginRootDir(),
        bundledPluginRootDir: this.bundledPluginRootDir,
        bundledPluginScanCandidates: BUNDLED_PLUGIN_DIR_CANDIDATES,
      };
    } catch (error) {
      this.registryStore.upsert(previousRecord);
      if (installDir !== previousRecord.installDir) {
        fs.rmSync(installDir, { recursive: true, force: true });
      }
      throw error;
    }
  }

  enablePlugin(pluginId: string): PluginMutationResult {
    const existing = this.requireRegistryRecord(pluginId);
    const record = this.registryStore.upsert({
      ...existing,
      enabled: true,
      updatedAt: new Date().toISOString(),
      lastError: null,
    });
    return {
      plugin: this.buildPluginListItem(record),
      pluginRootDir: this.registryStore.getPluginRootDir(),
      bundledPluginRootDir: this.bundledPluginRootDir,
      bundledPluginScanCandidates: BUNDLED_PLUGIN_DIR_CANDIDATES,
    };
  }

  disablePlugin(pluginId: string): PluginMutationResult {
    const existing = this.requireRegistryRecord(pluginId);
    const record = this.registryStore.upsert({
      ...existing,
      enabled: false,
      updatedAt: new Date().toISOString(),
    });
    return {
      plugin: this.buildPluginListItem(record),
      pluginRootDir: this.registryStore.getPluginRootDir(),
      bundledPluginRootDir: this.bundledPluginRootDir,
      bundledPluginScanCandidates: BUNDLED_PLUGIN_DIR_CANDIDATES,
    };
  }

  uninstallPlugin(pluginId: string): PluginListResult {
    const existing = this.requireRegistryRecord(pluginId);
    if (this.isBundledPluginRecord(existing)) {
      throw new LibraryError(400, "PLUGIN_INCOMPATIBLE", `内置插件不支持卸载：${pluginId}，如需停用请使用禁用`);
    }
    fs.rmSync(existing.installDir, { recursive: true, force: true });
    this.registryStore.remove(pluginId);
    return this.listPlugins();
  }

  private syncBundledPlugins(): void {
    const bundledRootDir = this.bundledPluginRootDir;
    if (!bundledRootDir || !fs.existsSync(bundledRootDir) || !fs.statSync(bundledRootDir).isDirectory()) {
      return;
    }

    const pluginDirs = fs.readdirSync(bundledRootDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(bundledRootDir, entry.name));

    for (const pluginDir of pluginDirs) {
      const manifestPath = path.join(pluginDir, MANIFEST_FILE_NAME);
      if (!fs.existsSync(manifestPath)) {
        continue;
      }
      const manifest = this.readManifestFromDirectory(pluginDir);
      ensurePluginCompatibility(manifest);
      const existing = this.registryStore.get(manifest.id);
      if (
        existing
        && existing.version === manifest.version
        && path.resolve(existing.installDir) === path.resolve(pluginDir)
      ) {
        continue;
      }
      this.registryStore.upsert(buildRegistryRecord(manifest, pluginDir, existing));
    }
  }

  private isBundledPluginRecord(record: PluginRegistryRecord): boolean {
    if (!this.bundledPluginRootDir) {
      return false;
    }
    const bundledRoot = ensureTrailingSeparator(path.resolve(this.bundledPluginRootDir));
    const installDir = ensureTrailingSeparator(path.resolve(record.installDir));
    return installDir.startsWith(bundledRoot);
  }

  private buildPluginListItem(record: PluginRegistryRecord): PluginListItem {
    const manifestPath = path.join(record.installDir, MANIFEST_FILE_NAME);
    if (!fs.existsSync(manifestPath)) {
      throw new LibraryError(500, "PLUGIN_ENTRY_INVALID", `插件 manifest 缺失: ${manifestPath}`);
    }

    const manifest = normalizeManifest(
      JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Partial<PluginManifest>,
      record.pluginId,
    );
    const health = this.providerBridge.buildHealth(manifest, record.enabled);

    return {
      manifest,
      registry: record,
      health,
    };
  }

  private readManifestFromDirectory(directory: string): PluginManifest {
    const manifestPath = path.join(directory, MANIFEST_FILE_NAME);
    if (!fs.existsSync(manifestPath)) {
      throw new LibraryError(400, "PLUGIN_ENTRY_INVALID", `插件目录缺少 manifest.json：${directory}`);
    }

    return normalizeManifest(
      JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Partial<PluginManifest>,
      path.basename(directory),
    );
  }

  private requireRegistryRecord(pluginId: string): PluginRegistryRecord {
    const record = this.registryStore.get(pluginId);
    if (!record) {
      throw new LibraryError(404, "PLUGIN_ENTRY_INVALID", `插件未安装：${pluginId}`);
    }
    return record;
  }

  private resolveVersionInstallDir(pluginId: string, version: string): string {
    return path.join(this.registryStore.getPluginRootDir(), pluginId, version);
  }
}

function normalizeManifest(input: Partial<PluginManifest>, fallbackPluginId: string): PluginManifest {
  const id = typeof input.id === "string" && input.id.trim() ? input.id.trim() : fallbackPluginId;
  const entry = typeof input.entry === "object" && input.entry ? input.entry : {};
  const provider = typeof input.provider === "object" && input.provider ? input.provider : null;
  const runtime = typeof input.runtime === "object" && input.runtime ? input.runtime : null;
  const assistant = typeof input.assistant === "object" && input.assistant ? input.assistant : null;
  return {
    id,
    name: typeof input.name === "string" && input.name.trim() ? input.name.trim() : id,
    version: typeof input.version === "string" && input.version.trim() ? input.version.trim() : "0.0.0",
    pluginType: "integration",
    minAppVersion: typeof input.minAppVersion === "string" && input.minAppVersion.trim()
      ? input.minAppVersion.trim()
      : "0.0.0",
    entry: {
      backend: typeof entry.backend === "string" && entry.backend.trim() ? entry.backend.trim() : null,
      ui: typeof entry.ui === "string" && entry.ui.trim() ? entry.ui.trim() : null,
    },
    runtime: runtime
      ? {
          install: runtime.install
            ? {
                strategy: runtime.install.strategy === "npm-runtime" ? "npm-runtime" : "system-cli",
                packageManager: runtime.install.packageManager === "npm" ? "npm" : undefined,
                projectDir: typeof runtime.install.projectDir === "string" && runtime.install.projectDir.trim()
                  ? runtime.install.projectDir.trim()
                  : null,
                lockfilePath: typeof runtime.install.lockfilePath === "string" && runtime.install.lockfilePath.trim()
                  ? runtime.install.lockfilePath.trim()
                  : null,
                installArgs: Array.isArray(runtime.install.installArgs)
                  ? runtime.install.installArgs.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
                  : [],
              }
            : null
        }
      : null,
    assistant: assistant
      ? {
          descriptor: assistant.descriptor ?? null,
        }
      : null,
    capabilities: Array.isArray(input.capabilities)
      ? input.capabilities.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : [],
    provider: provider
      ? {
          providerId: typeof provider.providerId === "string" && provider.providerId.trim()
            ? provider.providerId.trim()
            : id,
          displayName: typeof provider.displayName === "string" && provider.displayName.trim()
            ? provider.displayName.trim()
            : id,
          command: typeof provider.command === "string" && provider.command.trim()
            ? provider.command.trim()
            : null,
          auth: {
            strategy: provider.auth?.strategy === "directory_exists"
              || provider.auth?.strategy === "custom"
              ? provider.auth.strategy
              : "file_exists",
            path: typeof provider.auth?.path === "string" && provider.auth.path.trim()
              ? provider.auth.path.trim()
              : null,
          },
        }
      : null,
    signature: {
      algorithm: typeof input.signature?.algorithm === "string" && input.signature.algorithm.trim()
        ? input.signature.algorithm.trim()
        : "unsigned",
      value: typeof input.signature?.value === "string" && input.signature.value.trim()
        ? input.signature.value.trim()
        : "development",
    },
  };
}

function normalizeSourcePath(value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new LibraryError(400, "INVALID_INPUT", "插件源目录不能为空", "sourcePath");
  }
  const resolved = path.resolve(normalized);
  if (!fs.existsSync(resolved)) {
    throw new LibraryError(404, "PLUGIN_ENTRY_INVALID", `插件源目录不存在：${resolved}`, "sourcePath");
  }
  if (!fs.statSync(resolved).isDirectory()) {
    throw new LibraryError(400, "PLUGIN_ENTRY_INVALID", `插件源必须是目录：${resolved}`, "sourcePath");
  }
  return resolved;
}

function resolveBundledPluginRootDir(): string | null {
  const configured = process.env.X_FILE_BUNDLED_PLUGIN_DIR?.trim();
  if (!configured) {
    return BUNDLED_PLUGIN_DIR_CANDIDATES.find(isUsableBundledPluginRootDir) ?? null;
  }
  const resolved = path.resolve(configured);
  if (isUsableBundledPluginRootDir(resolved)) {
    return resolved;
  }
  return BUNDLED_PLUGIN_DIR_CANDIDATES.find(isUsableBundledPluginRootDir) ?? null;
}

function isUsableBundledPluginRootDir(candidate: string): boolean {
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isDirectory()) {
    return false;
  }
  return fs.readdirSync(candidate, { withFileTypes: true }).some((entry) => {
    if (!entry.isDirectory()) {
      return false;
    }
    return fs.existsSync(path.join(candidate, entry.name, MANIFEST_FILE_NAME));
  });
}

function ensureTrailingSeparator(value: string): string {
  return value.endsWith(path.sep) ? value : `${value}${path.sep}`;
}

function ensurePluginCompatibility(manifest: PluginManifest): void {
  if (manifest.pluginType !== "integration") {
    throw new LibraryError(400, "PLUGIN_ENTRY_INVALID", `不支持的插件类型：${manifest.pluginType}`);
  }
  if (!manifest.entry.backend && !manifest.entry.ui && !manifest.assistant?.descriptor) {
    throw new LibraryError(400, "PLUGIN_ENTRY_INVALID", "插件至少要声明一个 backend、ui 或 assistant.descriptor 入口");
  }
  if (manifest.entry.backend) {
    throw new LibraryError(
      400,
      "PLUGIN_ENTRY_INVALID",
      `插件 ${manifest.id} 仍声明 backend 入口 ${manifest.entry.backend}；主包已移除这条 Node backend ABI，请改用 assistant.descriptor 或纯 UI/integration 资源`
    );
  }
  if (manifest.runtime?.install?.strategy === "npm-runtime") {
    throw new LibraryError(
      400,
      "PLUGIN_ENTRY_INVALID",
      `插件 ${manifest.id} 仍声明 npm-runtime 热安装；主包已移除这条 Node 安装 ABI`
    );
  }
  if (manifest.capabilities.includes("assistant.entry") && !manifest.assistant?.descriptor) {
    throw new LibraryError(
      400,
      "PLUGIN_ENTRY_INVALID",
      `插件 ${manifest.id} 声明了 assistant.entry，但缺少 assistant.descriptor`
    );
  }
  if (compareSemver(manifest.minAppVersion, APP_VERSION) > 0) {
    throw new LibraryError(
      400,
      "PLUGIN_INCOMPATIBLE",
      `插件最低版本要求 ${manifest.minAppVersion}，当前主 APP 为 ${APP_VERSION}`,
    );
  }
}

function buildRegistryRecord(
  manifest: PluginManifest,
  installDir: string,
  existing: PluginRegistryRecord | null,
): PluginRegistryRecord {
  const timestamp = new Date().toISOString();
    return {
      pluginId: manifest.id,
      version: manifest.version,
      installDir,
      enabled: existing?.enabled ?? true,
    installedAt: existing?.installedAt ?? timestamp,
    updatedAt: timestamp,
    lastHealthStatus: "unknown",
    lastError: null,
    grantedCapabilities: existing?.grantedCapabilities ?? [],
  };
}

function copyDirectory(sourceDir: string, targetDir: string): void {
  fs.mkdirSync(path.dirname(targetDir), { recursive: true });
  fs.cpSync(sourceDir, targetDir, { recursive: true, force: false, errorOnExist: true });
}

function compareSemver(left: string, right: string): number {
  const leftParts = normalizeSemver(left);
  const rightParts = normalizeSemver(right);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const delta = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (delta !== 0) {
      return delta;
    }
  }
  return 0;
}

function normalizeSemver(value: string): number[] {
  return value
    .split("-")[0]
    .split(".")
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isFinite(part) ? part : 0));
}

function isAssistantProviderId(value: string): value is AssistantProviderId {
  return value === "codex" || value === "claude-code";
}
