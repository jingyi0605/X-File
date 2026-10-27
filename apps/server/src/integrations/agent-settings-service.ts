import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";

import { resolveNativeCli } from "@x-file/indexer";
import type {
  AgentIntegrationSettings,
  AgentIntegrationSettingsSaved,
  SaveAgentIntegrationSettingsInput,
} from "@x-file/shared";

export class AgentSettingsError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) {
    super(message);
  }
}

export interface AgentSettingsService {
  get(): Promise<AgentIntegrationSettings>;
  save(input: SaveAgentIntegrationSettingsInput): Promise<AgentIntegrationSettingsSaved>;
}

const unavailable = () => new AgentSettingsError(
  503, "AGENT_SETTINGS_UNAVAILABLE", "主机的原生 Agent 设置入口不可用，请更新桌面可执行文件并检查 X_FILE_DESKTOP_CLI_PATH。",
);

export function createAgentSettingsService(): AgentSettingsService {
  return {
    get: () => runWorker({ operation: "get" }),
    save: (input) => runWorker({ operation: "save", input }),
  };
}

async function runWorker<T>(request: object): Promise<T> {
  let executable: string;
  try {
    executable = resolveNativeCli();
  } catch {
    throw unavailable();
  }
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = execFile(executable, ["library-worker", "agent-settings"], {
      env: {
        ...process.env,
        X_FILE_DATA_DIR: path.resolve(process.env.X_FILE_DATA_DIR?.trim() || path.join(os.homedir(), ".x-file")),
      },
      timeout: 15_000,
      maxBuffer: 32 * 1024,
      windowsHide: true,
    }, (error, output) => error ? reject(unavailable()) : resolve(output));
    // 提前退出的旧版 worker 可能关闭 stdin；由进程结果统一报告不可用。
    child.stdin?.on("error", () => {});
    child.stdin?.end(JSON.stringify(request));
  });
  let response;
  try {
    response = JSON.parse(stdout);
  } catch {
    throw unavailable();
  }
  if (response?.ok === true && response.result && typeof response.result === "object") {
    return response.result as T;
  }
  if (response?.ok === false && typeof response.error?.code === "string"
    && typeof response.error?.message === "string") {
    const { code, message } = response.error;
    throw new AgentSettingsError(
      ["INVALID_ARGUMENT", "API_KEY_REQUIRED"].includes(code) ? 400 : 500, code, message,
    );
  }
  throw unavailable();
}
