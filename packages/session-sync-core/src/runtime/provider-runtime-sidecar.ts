import process from "node:process";
import readline from "node:readline";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  type ProviderRuntimeAdapter,
  type ProviderRuntimeEventSink,
  type ProviderRuntimeLaunchResult,
  type ProviderRuntimeRunRequest,
  type RuntimeEventInput,
  type RuntimeSendOptions,
} from "./types.js";

interface SidecarInboundEnvelope {
  action: "start" | "continue" | "submit" | "permission_response";
  request?: ProviderRuntimeRunRequest;
  options?: RuntimeSendOptions;
  requestId?: string;
  response?: unknown;
}

interface SidecarOutboundEnvelope {
  type: "session_started" | "event" | "complete" | "error" | "permission_request";
  providerSessionId?: string | null;
  rawStoreRef?: string | null;
  event?: RuntimeEventInput | null;
  detail?: string | null;
  errorCode?: string | null;
  requestId?: string;
  request?: Record<string, unknown> | null;
}

type PermissionDeferred = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

export type SidecarPermissionProtocol = "none" | "codex-server-request-v1";

export interface SidecarProviderConfig {
  providerId: string;
  adapterExport: string;
  permissionProtocol: SidecarPermissionProtocol;
  runtimeHomeDir: string;
  adapterOptions: Record<string, unknown>;
}

const permissionDeferreds = new Map<string, PermissionDeferred>();

async function main(): Promise<void> {
  const config = readSidecarProviderConfig();
  const adapter = await createRuntimeAdapter(config);
  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  let launch: ProviderRuntimeLaunchResult | null = null;
  let started = false;

  rl.on("line", (line) => {
    void handleLine(line).catch((error) => {
      emitEnvelope({
        type: "error",
        detail: error instanceof Error ? error.message : String(error),
        errorCode: "RUNTIME_SIDECAR_PROTOCOL_ERROR",
      });
      process.exitCode = 1;
    });
  });

  async function handleLine(line: string): Promise<void> {
    if (!line.trim()) {
      return;
    }
    const payload = JSON.parse(line) as SidecarInboundEnvelope;
    if (payload.action === "permission_response") {
      resolvePermission(payload);
      return;
    }
    if (payload.action === "submit") {
      if (!launch?.submitDuringRun || !payload.options) {
        throw new Error("runtime sidecar 当前没有可接收的 submitDuringRun");
      }
      await launch.submitDuringRun(payload.options);
      return;
    }
    if (started) {
      throw new Error("runtime sidecar 只接受一次 start/continue");
    }
    if ((payload.action !== "start" && payload.action !== "continue") || !payload.request) {
      throw new Error("runtime sidecar 缺少有效的 start/continue 请求");
    }
    started = true;
    launch = await launchRuntime(adapter, payload.action, payload.request);
  }
}

async function launchRuntime(
  adapter: ProviderRuntimeAdapter,
  action: "start" | "continue",
  request: ProviderRuntimeRunRequest,
): Promise<ProviderRuntimeLaunchResult> {
  let latestProviderSessionId = request.providerSessionId ?? null;
  let latestRawStoreRef = request.rawStoreRef ?? null;
  const sink: ProviderRuntimeEventSink = {
    emit: async (event) => {
      if (event.providerSessionId !== undefined) {
        latestProviderSessionId = event.providerSessionId;
      }
      if (event.rawStoreRef !== undefined) {
        latestRawStoreRef = event.rawStoreRef;
      }
      emitEnvelope({
        type: "event",
        providerSessionId: latestProviderSessionId,
        rawStoreRef: latestRawStoreRef,
        event,
      });
    },
    updateSessionBinding: (binding) => {
      latestProviderSessionId = binding.providerSessionId;
      latestRawStoreRef = binding.rawStoreRef;
      emitEnvelope({
        type: "session_started",
        providerSessionId: latestProviderSessionId,
        rawStoreRef: latestRawStoreRef,
      });
    },
  };
  const launch = action === "continue"
    ? await adapter.continueSession(request, sink)
    : await adapter.startSession(request, sink);
  latestProviderSessionId = launch.providerSessionId;
  latestRawStoreRef = launch.rawStoreRef;
  emitEnvelope({
    type: "session_started",
    providerSessionId: launch.providerSessionId,
    rawStoreRef: launch.rawStoreRef,
  });
  void launch.completed.then(
    () => {
      emitEnvelope({
        type: "complete",
        providerSessionId: latestProviderSessionId,
        rawStoreRef: latestRawStoreRef,
      });
    },
    (error) => {
      emitEnvelope({
        type: "error",
        providerSessionId: latestProviderSessionId,
        rawStoreRef: latestRawStoreRef,
        detail: error instanceof Error ? error.message : String(error),
        errorCode: "RUNTIME_SIDECAR_FAILED",
      });
      process.exitCode = 1;
    }
  );
  return launch;
}

export async function createRuntimeAdapter(
  config: SidecarProviderConfig
): Promise<ProviderRuntimeAdapter> {
  const sessionSyncCore = await import("../index.js");
  return createRuntimeAdapterFromModule(sessionSyncCore as Record<string, unknown>, config);
}

export function createRuntimeAdapterFromModule(
  sessionSyncCore: Record<string, unknown>,
  config: SidecarProviderConfig
): ProviderRuntimeAdapter {
  const RuntimeAdapter = sessionSyncCore[config.adapterExport];
  if (typeof RuntimeAdapter !== "function") {
    throw new Error(
      `runtime sidecar 找不到 adapter export: ${config.adapterExport}`
    );
  }
  return new (RuntimeAdapter as new (options: Record<string, unknown>) => ProviderRuntimeAdapter)(
    buildAdapterOptions(config)
  );
}

export function readSidecarProviderConfig(
  env: NodeJS.ProcessEnv = process.env
): SidecarProviderConfig {
  const providerId = env.X_FILE_PROVIDER_ID?.trim();
  if (!providerId) {
    throw new Error("runtime sidecar 缺少 X_FILE_PROVIDER_ID");
  }
  const adapterExport = env.X_FILE_PROVIDER_RUNTIME_ADAPTER_EXPORT?.trim();
  if (!adapterExport) {
    throw new Error("runtime sidecar 缺少 X_FILE_PROVIDER_RUNTIME_ADAPTER_EXPORT");
  }
  const permissionProtocol = normalizePermissionProtocol(
    env.X_FILE_PROVIDER_RUNTIME_PERMISSION_PROTOCOL
  );
  return {
    providerId,
    adapterExport,
    permissionProtocol,
    runtimeHomeDir: env.X_FILE_RUNTIME_HOME_DIR?.trim() || "",
    adapterOptions: parseAdapterOptionsJson(env.X_FILE_PROVIDER_RUNTIME_ADAPTER_OPTIONS_JSON)
  };
}

export function buildAdapterOptions(
  config: SidecarProviderConfig
): Record<string, unknown> {
  const options: Record<string, unknown> = {
    ...config.adapterOptions
  };
  if (!options.homeDir) {
    options.homeDir = config.runtimeHomeDir;
  }
  if (config.permissionProtocol === "codex-server-request-v1") {
    options.handleServerRequest = async (input: {
      providerSessionId: string;
      request: Record<string, unknown>;
    }) => {
      const requestId = `perm-${randomUUID()}`;
      emitEnvelope({
        type: "permission_request",
        providerSessionId: input.providerSessionId,
        requestId,
        request: input.request,
      });
      return await waitForPermissionResponse(requestId);
    };
  }
  return options;
}

function normalizePermissionProtocol(value: string | undefined): SidecarPermissionProtocol {
  const normalized = value?.trim() || "none";
  if (normalized === "none" || normalized === "codex-server-request-v1") {
    return normalized;
  }
  throw new Error(`runtime sidecar 不支持的 permission protocol: ${normalized}`);
}

function parseAdapterOptionsJson(value: string | undefined): Record<string, unknown> {
  const source = value?.trim();
  if (!source) {
    return {};
  }
  const parsed = JSON.parse(source) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("runtime sidecar 的 adapter options 必须是 JSON object");
  }
  return parsed as Record<string, unknown>;
}

function emitEnvelope(envelope: SidecarOutboundEnvelope): void {
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
}

function waitForPermissionResponse(requestId: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    permissionDeferreds.set(requestId, { resolve, reject });
  });
}

function resolvePermission(payload: SidecarInboundEnvelope): void {
  const requestId = payload.requestId?.trim();
  if (!requestId) {
    throw new Error("permission_response 缺少 requestId");
  }
  const deferred = permissionDeferreds.get(requestId);
  if (!deferred) {
    throw new Error(`permission_response 找不到 requestId=${requestId}`);
  }
  permissionDeferreds.delete(requestId);
  deferred.resolve(payload.response ?? null);
}

function isEntrypoint(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) {
    return false;
  }
  return path.resolve(argv1) === fileURLToPath(import.meta.url);
}

if (isEntrypoint()) {
  main().catch((error) => {
    emitEnvelope({
      type: "error",
      detail: error instanceof Error ? error.message : String(error),
      errorCode: "RUNTIME_SIDECAR_BOOT_FAILED",
    });
    process.exitCode = 1;
  });
}
