import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import type {
  AssistantProviderId,
  PluginHealth,
  PluginManifest,
  PluginProviderMeta,
} from "@x-file/shared";

interface ProviderDetectionResult {
  commandReady: boolean;
  authReady: boolean;
  detail: string | null;
}

export class ProviderBridgeService {
  detectCommand(commandName: string | null | undefined): boolean {
    const command = commandName?.trim();
    if (!command) {
      return false;
    }
    try {
      const checker = process.platform === "win32" ? "where" : "which";
      const result = spawnSync(checker, [command], { stdio: "ignore" });
      return result.status === 0;
    } catch {
      return false;
    }
  }

  detectAuth(providerId: AssistantProviderId, authMeta: PluginProviderMeta["auth"]): boolean {
    const resolvedPath = resolveAuthPath(providerId, authMeta.path);
    if (!resolvedPath) {
      return false;
    }
    if (authMeta.strategy === "directory_exists") {
      return existsSync(resolvedPath);
    }
    if (authMeta.strategy === "file_exists") {
      return existsSync(resolvedPath);
    }
    return false;
  }

  detectProvider(manifest: PluginManifest): ProviderDetectionResult {
    const provider = manifest.provider;
    if (!provider) {
      return {
        commandReady: false,
        authReady: false,
        detail: "插件未声明 provider 元信息",
      };
    }

    if (!isSupportedAssistantProviderId(provider.providerId)) {
      return {
        commandReady: false,
        authReady: false,
        detail: `暂不支持的 provider：${provider.providerId}`,
      };
    }

    if (provider.auth.strategy === "custom") {
      return {
        commandReady: this.detectCommand(provider.command),
        authReady: false,
        detail: `${provider.displayName} 需要插件自定义登录态探测，当前版本暂不支持自动校验`,
      };
    }

    const commandReady = this.detectCommand(provider.command);
    if (!commandReady) {
      return {
        commandReady: false,
        authReady: false,
        detail: `未检测到 ${provider.command ?? provider.displayName} 命令，请先安装 ${provider.displayName} CLI`,
      };
    }

    const authReady = this.detectAuth(provider.providerId, provider.auth);
    if (!authReady) {
      return {
        commandReady: true,
        authReady: false,
        detail: `未检测到 ${provider.displayName} 登录态，请先在终端登录`,
      };
    }

    return {
      commandReady: true,
      authReady: true,
      detail: null,
    };
  }

  buildHealth(manifest: PluginManifest, enabled: boolean): PluginHealth {
    if (!enabled) {
      return {
        pluginId: manifest.id,
        enabled: false,
        status: "unknown",
        detail: "插件已禁用",
        commandReady: null,
        authReady: null,
      };
    }

    if (!manifest.provider) {
      return {
        pluginId: manifest.id,
        enabled: true,
        status: "healthy",
        detail: `${manifest.name} 已启用`,
        commandReady: null,
        authReady: null,
      };
    }

    const detection = this.detectProvider(manifest);
    return {
      pluginId: manifest.id,
      enabled: true,
      status: resolvePluginHealthStatus(detection),
      detail: detection.detail,
      commandReady: detection.commandReady,
      authReady: detection.authReady,
    };
  }
}

function resolveAuthPath(
  providerId: AssistantProviderId,
  explicitPath: string | null
): string | null {
  const sourcePath = explicitPath?.trim() || getDefaultAuthPath(providerId);
  if (!sourcePath) {
    return null;
  }
  if (sourcePath.startsWith("~/")) {
    return path.join(homedir(), sourcePath.slice(2));
  }
  return path.resolve(sourcePath);
}

function getDefaultAuthPath(providerId: AssistantProviderId): string {
  return providerId === "codex" ? "~/.codex/auth.json" : "~/.claude";
}

function resolvePluginHealthStatus(
  detection: ProviderDetectionResult
): PluginHealth["status"] {
  if (!detection.commandReady) {
    return "failed";
  }
  if (!detection.authReady) {
    return "degraded";
  }
  return "healthy";
}

function isSupportedAssistantProviderId(value: string): value is AssistantProviderId {
  return value === "codex" || value === "claude-code";
}
