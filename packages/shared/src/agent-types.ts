export interface AgentCapability {
  name: string;
  description: string;
  readOnly: boolean;
  destructive: boolean;
  requiresBinding: boolean;
  parameters?: AgentCapabilityParameter[];
}

export interface AgentCapabilityParameter {
  name: string;
  valueType: string;
  required: boolean;
  description: string | null;
  allowedValues: string[];
}

export interface AgentIntegrationSettings {
  enabled: boolean;
  apiKeyConfigured: boolean;
  updatedAt: string | null;
  executablePath: string;
  dataDir: string;
  platform: string;
  capabilities?: AgentCapability[];
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
