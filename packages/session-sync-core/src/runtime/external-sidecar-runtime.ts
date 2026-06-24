import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import readline from "node:readline";

import type {
  ProviderRuntimeAdapter,
  ProviderRuntimeEventSink,
  ProviderRuntimeLaunchResult,
  ProviderRuntimeRunRequest,
  RuntimeEventInput,
  RuntimeSendOptions,
} from "./types.js";

interface ExternalSidecarRuntimeOptions {
  providerId: string;
  commandPath: string;
  adapterExport: string;
  commandArgs?: string[];
  runtimeHomeDir?: string | null;
  shell?: boolean;
  permissionProtocol?: "none" | "codex-server-request-v1";
  adapterOptions?: Record<string, unknown>;
  requestPermission?: (input: {
    sessionId: string;
    providerSessionId: string;
    request: Record<string, unknown>;
  }) => Promise<unknown>;
}

interface SidecarMessageEnvelope {
  type: "session_started" | "event" | "complete" | "error" | "permission_request";
  providerSessionId?: string | null;
  rawStoreRef?: string | null;
  event?: RuntimeEventInput | null;
  detail?: string | null;
  errorCode?: string | null;
  requestId?: string | null;
  request?: Record<string, unknown> | null;
}

interface SidecarStartPayload {
  action: "start" | "continue";
  request: ProviderRuntimeRunRequest;
}

interface SidecarInRunPayload {
  action: "submit";
  options: RuntimeSendOptions;
}

interface SidecarPermissionResponsePayload {
  action: "permission_response";
  requestId: string;
  response: unknown;
}

export class ExternalSidecarRuntimeAdapter implements ProviderRuntimeAdapter {
  readonly providerId: string;
  private readonly commandPath: string;
  private readonly commandArgs: string[];
  private readonly shell: boolean;
  private readonly requestPermission: ExternalSidecarRuntimeOptions["requestPermission"];

  constructor(private readonly options: ExternalSidecarRuntimeOptions) {
    this.providerId = options.providerId;
    this.commandPath = options.commandPath.trim();
    this.commandArgs = options.commandArgs ?? [];
    this.shell = options.shell ?? false;
    this.requestPermission = options.requestPermission;
  }

  async startSession(
    request: ProviderRuntimeRunRequest,
    sink: ProviderRuntimeEventSink
  ): Promise<ProviderRuntimeLaunchResult> {
    return this.launchSidecar("start", request, sink);
  }

  async continueSession(
    request: ProviderRuntimeRunRequest,
    sink: ProviderRuntimeEventSink
  ): Promise<ProviderRuntimeLaunchResult> {
    return this.launchSidecar("continue", request, sink);
  }

  private async launchSidecar(
    action: "start" | "continue",
    request: ProviderRuntimeRunRequest,
    sink: ProviderRuntimeEventSink
  ): Promise<ProviderRuntimeLaunchResult> {
    const child = spawn(this.commandPath, this.commandArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: this.shell,
      env: {
        ...process.env,
        X_FILE_PROVIDER_ID: this.providerId,
        X_FILE_PROVIDER_RUNTIME_ADAPTER_EXPORT: this.options.adapterExport,
        X_FILE_PROVIDER_RUNTIME_PERMISSION_PROTOCOL: this.options.permissionProtocol ?? "none",
        X_FILE_RUNTIME_HOME_DIR: request.runtimeHomeDir ?? this.options.runtimeHomeDir ?? "",
        X_FILE_PROVIDER_RUNTIME_ADAPTER_OPTIONS_JSON: JSON.stringify(this.options.adapterOptions ?? {}),
      },
    });
    const childProcess = child as ChildProcessWithoutNullStreams;
    let providerSessionId = request.providerSessionId ?? `sidecar-${this.providerId}-${randomUUID()}`;
    let rawStoreRef = request.rawStoreRef ?? null;
    let interrupted = false;
    let completed = false;
    let cleanedUp = false;

    const cleanup = () => {
      if (cleanedUp) {
        return;
      }
      cleanedUp = true;
      try {
        childProcess.stdin.end();
      } catch {
        /* ignore */
      }
      if (childProcess.exitCode === null && !interrupted) {
        try {
          childProcess.kill("SIGTERM");
        } catch {
          /* ignore */
        }
      }
    };

    const completedPromise = new Promise<void>((resolve, reject) => {
      const rl = readline.createInterface({ input: childProcess.stdout });
      rl.on("line", (line) => {
        if (!line.trim()) {
          return;
        }
        try {
          const payload = JSON.parse(line) as SidecarMessageEnvelope;
          if (payload.type === "session_started") {
            providerSessionId = payload.providerSessionId ?? providerSessionId;
            rawStoreRef = payload.rawStoreRef ?? rawStoreRef;
            sink.updateSessionBinding({
              providerSessionId,
              rawStoreRef
            });
            return;
          }
          if (payload.type === "event" && payload.event) {
            void sink.emit({
              ...payload.event,
              providerSessionId: payload.event.providerSessionId ?? providerSessionId,
              rawStoreRef: payload.event.rawStoreRef ?? rawStoreRef,
            });
            return;
          }
          if (payload.type === "permission_request") {
            const requestId = payload.requestId?.trim();
            if (!requestId || !payload.request) {
              completed = true;
              rl.close();
              cleanup();
              reject(new Error("external sidecar runtime 返回了无效 permission_request"));
              return;
            }
            void this.resolvePermissionRequest(request, providerSessionId, requestId, payload.request, childProcess);
            return;
          }
          if (payload.type === "error") {
            completed = true;
            void sink.emit({
              type: "error",
              status: "failed",
              detail: payload.detail ?? "external sidecar runtime failed",
              errorCode: payload.errorCode ?? "EXTERNAL_SIDECAR_RUNTIME_FAILED",
              providerSessionId,
              rawStoreRef,
            });
            rl.close();
            cleanup();
            reject(new Error(payload.detail ?? "external sidecar runtime failed"));
            return;
          }
          if (payload.type === "complete") {
            completed = true;
            rl.close();
            cleanup();
            resolve();
          }
        } catch (error) {
          completed = true;
          rl.close();
          cleanup();
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
      childProcess.once("error", (error) => {
        completed = true;
        rl.close();
        cleanup();
        reject(error);
      });
      childProcess.once("exit", (code) => {
        cleanup();
        if (completed) {
          return;
        }
        completed = true;
        rl.close();
        if (code === 0 || interrupted) {
          resolve();
          return;
        }
        reject(new Error(`external sidecar runtime exited with code ${code ?? -1}`));
      });
    });

    childProcess.stdin.write(`${JSON.stringify({
      action,
      request,
    } satisfies SidecarStartPayload)}\n`);

    return {
      providerSessionId,
      rawStoreRef,
      completed: completedPromise,
      interrupt: async () => {
        interrupted = true;
        cleanup();
        childProcess.kill("SIGTERM");
      },
      submitDuringRun: async (options) => {
        childProcess.stdin.write(`${JSON.stringify({
          action: "submit",
          options,
        } satisfies SidecarInRunPayload)}\n`);
      },
      isAlive: () => !completed && childProcess.exitCode === null,
    };
  }

  private async resolvePermissionRequest(
    request: ProviderRuntimeRunRequest,
    providerSessionId: string,
    requestId: string,
    rawRequest: Record<string, unknown>,
    childProcess: ChildProcessWithoutNullStreams,
  ): Promise<void> {
    if (!this.requestPermission) {
      throw new Error("external sidecar runtime 缺少 requestPermission 回调");
    }

    const response = await this.requestPermission({
      sessionId: request.sessionId,
      providerSessionId,
      request: rawRequest,
    });
    childProcess.stdin.write(`${JSON.stringify({
      action: "permission_response",
      requestId,
      response: response ?? null,
    } satisfies SidecarPermissionResponsePayload)}\n`);
  }
}
