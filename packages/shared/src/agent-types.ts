export interface AgentCapability {
  name: string;
  description: string;
  available?: boolean;
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
  accessMode: "read_only" | "read_write";
  updatedAt: string | null;
  executablePath: string;
  dataDir: string;
  platform: string;
  capabilities?: AgentCapability[];
}

export interface SaveAgentIntegrationSettingsInput {
  enabled?: boolean;
  accessMode?: "read_only" | "read_write";
  apiKey?: string;
  generateApiKey?: boolean;
  clearApiKey?: boolean;
}

export interface AgentIntegrationSettingsSaved {
  settings: AgentIntegrationSettings;
  apiKey?: string;
}
