export interface AgentIntegrationSettings {
  enabled: boolean;
  apiKeyConfigured: boolean;
  updatedAt: string | null;
  executablePath: string;
  dataDir: string;
  platform: string;
}

export interface SaveAgentIntegrationSettingsInput {
  enabled?: boolean;
  apiKey?: string;
  generateApiKey?: boolean;
  clearApiKey?: boolean;
}

export interface AgentIntegrationSettingsSaved {
  settings: AgentIntegrationSettings;
  apiKey?: string;
}
