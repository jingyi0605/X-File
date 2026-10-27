import type {
  AgentIntegrationSettings,
  AgentIntegrationSettingsSaved,
  SaveAgentIntegrationSettingsInput,
} from "@x-file/shared";

import { t } from "../i18n";
import { getRuntimeConfigSnapshot } from "../runtime/runtime-config-store";
import {
  getNativeAgentIntegrationSettings,
  saveNativeAgentIntegrationSettings,
} from "../runtime/native-library-bridge";
import { apiRequest } from "./http";

export const AGENT_SETTINGS_PATH = "/api/integration/agent/settings";

export function usesNativeAgentSettings(): boolean {
  return getRuntimeConfigSnapshot().config.mode === "local"
    && typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function getAgentIntegrationSettings(): Promise<AgentIntegrationSettings> {
  if (usesNativeAgentSettings()) {
    const settings = await getNativeAgentIntegrationSettings();
    if (!settings) throw new Error(t("agentUnavailable"));
    return settings;
  }
  return apiRequest(AGENT_SETTINGS_PATH);
}

export async function saveAgentIntegrationSettings(
  input: SaveAgentIntegrationSettingsInput,
): Promise<AgentIntegrationSettingsSaved> {
  if (usesNativeAgentSettings()) {
    const saved = await saveNativeAgentIntegrationSettings(input);
    if (!saved) throw new Error(t("agentUnavailable"));
    return saved;
  }
  return apiRequest(AGENT_SETTINGS_PATH, { method: "PUT", body: JSON.stringify(input) });
}
