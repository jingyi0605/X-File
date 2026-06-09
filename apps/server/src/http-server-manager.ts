import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { FastifyInstance } from "fastify";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 17321;
const DEBUG_PUBLIC_HOST = "0.0.0.0";

export type HttpServerLifecycleState = "disabled" | "starting" | "running" | "failed" | "stopping";

export interface HttpServerState {
  enabled: boolean;
  host: string;
  port: number;
  persistent: boolean;
  running: boolean;
  lifecycleState: HttpServerLifecycleState;
  startedAt: string | null;
  lastError: string | null;
}

export interface SaveHttpServerStateInput {
  enabled?: boolean;
  host?: string;
  port?: number;
  persistent?: boolean;
  /**
   * 兼容前端表单和 shared 类型字段。设置接口不会信任这些运行态字段；
   * 真正运行态只能由 server listen 成功、停止或失败时更新。
   */
  running?: boolean;
  lifecycleState?: HttpServerLifecycleState;
  lastError?: string | null;
}

export interface HttpServerRuntimeState {
  running?: boolean;
  startedAt?: string | null;
  lastError?: string | null;
}

export interface ApplyHttpServerStateOptions {
  manageLifecycle?: boolean;
  deferStop?: boolean;
}

const DEFAULT_STATE: HttpServerState = {
  enabled: true,
  host: DEFAULT_HOST,
  port: DEFAULT_PORT,
  persistent: false,
  running: false,
  lifecycleState: "disabled",
  startedAt: null,
  lastError: null
};

export class HttpServerManager {
  private state: HttpServerState;
  private app: FastifyInstance | null = null;
  private appFactory: (() => FastifyInstance) | null = null;

  constructor(
    private readonly stateFilePath = resolveDefaultStateFilePath(),
    runtimeState: HttpServerRuntimeState = {}
  ) {
    const savedState = readSavedState(stateFilePath);
    this.state = {
      ...DEFAULT_STATE,
      ...savedState,
      running: runtimeState.running ?? false,
      lifecycleState: deriveLifecycleState({
        enabled: savedState?.enabled ?? DEFAULT_STATE.enabled,
        running: runtimeState.running ?? false,
        lastError: runtimeState.lastError ?? savedState?.lastError ?? null
      }),
      startedAt: runtimeState.startedAt ?? null,
      lastError: runtimeState.lastError ?? savedState?.lastError ?? null
    };
  }

  getState(): HttpServerState {
    return { ...this.state };
  }

  bindServer(app: FastifyInstance): void {
    this.app = app;
  }

  bindServerFactory(factory: () => FastifyInstance): void {
    this.appFactory = factory;
  }

  save(input: SaveHttpServerStateInput): HttpServerState {
    this.state = {
      ...this.state,
      enabled: input.enabled ?? this.state.enabled,
      host: normalizeHost(input.host ?? this.state.host),
      port: normalizePort(input.port ?? this.state.port),
      persistent: input.persistent ?? this.state.persistent,
      lifecycleState: deriveLifecycleState({
        enabled: input.enabled ?? this.state.enabled,
        running: this.state.running,
        lastError: this.state.lastError
      })
    };
    this.persist();
    return this.getState();
  }

  async applyStateChange(
    input: SaveHttpServerStateInput,
    options: ApplyHttpServerStateOptions = {}
  ): Promise<HttpServerState> {
    const previous = this.getState();
    const saved = this.save(input);
    if (!options.manageLifecycle) {
      return saved;
    }

    try {
      if (saved.enabled) {
        if (!saved.running || saved.port !== previous.port || saved.host !== previous.host) {
          if (previous.running) {
            await this.stop();
          }
          await this.start();
        }
      } else if (previous.running || saved.running) {
        if (options.deferStop) {
          this.state = {
            ...this.state,
            running: false,
            lifecycleState: "stopping",
            startedAt: null
          };
          this.persist();
          setTimeout(() => {
            this.stop().catch((error) => {
              this.markError(error);
            });
          }, 0);
          return this.getState();
        }
        await this.stop();
      }
    } catch (error) {
      this.markError(error);
      throw error;
    }

    return this.getState();
  }

  async start(): Promise<HttpServerState> {
    const app = this.app ?? this.appFactory?.();
    if (!app) {
      throw new Error("HTTP 服务还没有绑定 Fastify 实例或创建工厂");
    }
    this.app = app;

    if (this.state.running) {
      return this.getState();
    }

    this.state = {
      ...this.state,
      lifecycleState: "starting",
      lastError: null
    };
    this.persist();

    await app.listen({
      host: this.state.host,
      port: this.state.port
    });
    return this.markRunning({
      host: this.state.host,
      port: this.state.port
    });
  }

  async stop(): Promise<HttpServerState> {
    const app = this.app;
    if (!app) {
      throw new Error("HTTP 服务还没有绑定 Fastify 实例");
    }

    if (!this.state.running) {
      return this.markStopped();
    }

    this.state = {
      ...this.state,
      lifecycleState: "stopping"
    };
    this.persist();

    await app.close();
    if (this.appFactory) {
      this.app = null;
    }
    return this.markStopped();
  }

  markRunning(input: { host?: string; port?: number; startedAt?: string | null } = {}): HttpServerState {
    this.state = {
      ...this.state,
      host: normalizeHost(input.host ?? this.state.host),
      port: normalizePort(input.port ?? this.state.port),
      running: true,
      lifecycleState: "running",
      startedAt: input.startedAt ?? new Date().toISOString(),
      lastError: null
    };
    this.persist();
    return this.getState();
  }

  markStopped(): HttpServerState {
    this.state = {
      ...this.state,
      running: false,
      lifecycleState: "disabled",
      startedAt: null
    };
    this.persist();
    return this.getState();
  }

  markError(error: unknown): HttpServerState {
    this.state = {
      ...this.state,
      running: false,
      lifecycleState: "failed",
      lastError: error instanceof Error ? error.message : String(error)
    };
    this.persist();
    return this.getState();
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.stateFilePath), { recursive: true });
    fs.writeFileSync(this.stateFilePath, JSON.stringify(toSavedState(this.state), null, 2));
  }
}

export function resolveDefaultStateFilePath(): string {
  const explicitPath = process.env.X_FILE_SERVER_STATE_PATH?.trim();
  if (explicitPath) {
    return path.resolve(explicitPath);
  }
  return path.join(os.homedir(), ".x-file", "http-server-state.json");
}

export function getDefaultHttpServerHost(): string {
  return DEFAULT_HOST;
}

export function getDefaultHttpServerPort(): number {
  return DEFAULT_PORT;
}

function readSavedState(stateFilePath: string): Partial<HttpServerState> | null {
  if (!fs.existsSync(stateFilePath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(stateFilePath, "utf8")) as Partial<HttpServerState>;
    return {
      enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : undefined,
      host: parsed.host ? normalizeHost(parsed.host) : undefined,
      port: parsed.port ? normalizePort(parsed.port) : undefined,
      persistent: typeof parsed.persistent === "boolean" ? parsed.persistent : undefined,
      lifecycleState: normalizeSavedLifecycleState(parsed.lifecycleState),
      lastError: parsed.lastError ?? null
    };
  } catch {
    return { lastError: "HTTP 服务状态文件损坏，已回退到默认配置" };
  }
}

function toSavedState(state: HttpServerState): Omit<HttpServerState, "running" | "startedAt"> {
  return {
    enabled: state.enabled,
    host: state.host,
    port: state.port,
    persistent: state.persistent,
    lifecycleState: state.lifecycleState,
    lastError: state.lastError
  };
}

function normalizeHost(value: string): string {
  const host = value.trim();
  if (host === DEFAULT_HOST) {
    return host;
  }

  if (host === DEBUG_PUBLIC_HOST && process.env.X_FILE_ALLOW_PUBLIC_HOST === "1") {
    return host;
  }

  throw new Error("HTTP 服务默认只允许绑定 127.0.0.1；调试时如需 0.0.0.0，必须显式设置 X_FILE_ALLOW_PUBLIC_HOST=1");
}

function normalizePort(value: number): number {
  if (!Number.isInteger(value) || value <= 0 || value > 65535) {
    throw new Error(`HTTP 服务端口无效：${value}`);
  }
  return value;
}

function normalizeSavedLifecycleState(value: unknown): HttpServerLifecycleState | undefined {
  if (
    value === "disabled"
    || value === "starting"
    || value === "running"
    || value === "failed"
    || value === "stopping"
  ) {
    return value;
  }

  return undefined;
}

function deriveLifecycleState(input: {
  enabled: boolean;
  running: boolean;
  lastError: string | null;
}): HttpServerLifecycleState {
  if (input.running) {
    return "running";
  }

  if (input.lastError) {
    return "failed";
  }

  return "disabled";
}
