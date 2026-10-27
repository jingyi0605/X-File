import fs from "node:fs";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import type { HttpServerHostOption } from "@x-file/shared";
import type { FastifyInstance } from "fastify";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 17321;
const WILDCARD_HOST = "0.0.0.0";

export type HttpServerLifecycleState = "disabled" | "starting" | "running" | "failed" | "stopping";

export interface HttpServerState {
  enabled: boolean;
  host: string;
  port: number;
  persistent: boolean;
  running: boolean;
  actualHost: string | null;
  actualPort: number | null;
  lifecycleState: HttpServerLifecycleState;
  startedAt: string | null;
  lastError: string | null;
  hostOptions?: HttpServerHostOption[];
  accessUrls?: string[];
  authEnabled: boolean;
  authConfigured: boolean;
  authUsername: string | null;
}

export interface SaveHttpServerStateInput {
  enabled?: boolean;
  host?: string;
  port?: number;
  persistent?: boolean;
  authEnabled?: boolean;
  authUsername?: string;
  authPassword?: string;
  clearAuth?: boolean;
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
  actualHost: null,
  actualPort: null,
  lifecycleState: "disabled",
  startedAt: null,
  lastError: null,
  authEnabled: false,
  authConfigured: false,
  authUsername: null
};

const PASSWORD_HASH_ITERATIONS = 120_000;

interface SavedHttpServerAuth {
  username: string;
  salt: string;
  passwordHash: string;
}

interface SavedHttpServerState extends Partial<HttpServerState> {
  auth?: SavedHttpServerAuth | null;
}

export class HttpServerManager {
  private state: HttpServerState;
  private auth: SavedHttpServerAuth | null;
  private app: FastifyInstance | null = null;
  private appFactory: (() => FastifyInstance) | null = null;

  constructor(
    private readonly stateFilePath = resolveDefaultStateFilePath(),
    runtimeState: HttpServerRuntimeState = {}
  ) {
    const savedState = readSavedState(stateFilePath);
    this.auth = savedState?.auth ?? null;
    const savedValues = savedState ? { ...savedState } : {};
    delete savedValues.auth;
    this.state = {
      ...DEFAULT_STATE,
      ...savedValues,
      running: runtimeState.running ?? false,
      actualHost: runtimeState.running ? savedState?.host ?? DEFAULT_STATE.host : null,
      actualPort: runtimeState.running ? savedState?.port ?? DEFAULT_STATE.port : null,
      lifecycleState: deriveLifecycleState({
        enabled: savedState?.enabled ?? DEFAULT_STATE.enabled,
        running: runtimeState.running ?? false,
        lastError: runtimeState.lastError ?? savedState?.lastError ?? null
      }),
      startedAt: runtimeState.startedAt ?? null,
      lastError: runtimeState.lastError ?? savedState?.lastError ?? null,
      authEnabled: resolveAuthEnabled(
        savedState?.host ?? DEFAULT_STATE.host,
        savedState?.host !== DEFAULT_STATE.host && savedState?.authEnabled === false
          ? undefined
          : savedState?.authEnabled,
      ),
      authConfigured: Boolean(this.auth),
      authUsername: this.auth?.username ?? null
    };
  }

  getState(): HttpServerState {
    return {
      ...this.state,
      hostOptions: getHttpServerHostOptions(),
      accessUrls: this.state.running
        ? getHttpServerAccessUrls(this.state.actualHost ?? this.state.host, this.state.actualPort ?? this.state.port)
        : []
    };
  }

  bindServer(app: FastifyInstance): void {
    this.app = app;
  }

  bindServerFactory(factory: () => FastifyInstance): void {
    this.appFactory = factory;
  }

  save(input: SaveHttpServerStateInput): HttpServerState {
    this.reloadSavedAuthentication();
    const host = normalizeHost(input.host ?? this.state.host);
    const authEnabled = resolveAuthEnabled(host, input.authEnabled);
    const nextAuth = resolveAuthChange(this.auth, input);
    if (authEnabled && !nextAuth) {
      throw new Error("请先配置并保存局域网访问用户名和密码，再选择非 127.0.0.1 监听地址");
    }
    this.auth = nextAuth;
    this.state = {
      ...this.state,
      enabled: input.enabled ?? this.state.enabled,
      host,
      port: normalizePort(input.port ?? this.state.port),
      persistent: input.persistent ?? this.state.persistent,
      authEnabled,
      authConfigured: Boolean(this.auth),
      authUsername: this.auth?.username ?? null,
      actualHost: this.state.running ? this.state.actualHost : null,
      actualPort: this.state.running ? this.state.actualPort : null,
      lifecycleState: deriveLifecycleState({
        enabled: input.enabled ?? this.state.enabled,
        running: this.state.running,
        lastError: this.state.lastError
      })
    };
    this.persist();
    return this.getState();
  }

  verifyCredentials(username: string, password: string): boolean {
    if (!this.auth) {
      return false;
    }
    const normalizedUsername = username.trim();
    if (normalizedUsername !== this.auth.username) {
      return false;
    }
    const candidate = derivePasswordHash(password, this.auth.salt);
    const expected = Buffer.from(this.auth.passwordHash, "hex");
    const actual = Buffer.from(candidate, "hex");
    return expected.length === actual.length && timingSafeEqual(expected, actual);
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
            actualHost: null,
            actualPort: null,
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
      actualHost: null,
      actualPort: null,
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

  async restartListener(): Promise<HttpServerState> {
    if (this.state.running) {
      await this.stop();
    }
    if (this.state.enabled) {
      await this.start();
    }
    return this.getState();
  }

  markRunning(input: { host?: string; port?: number; startedAt?: string | null } = {}): HttpServerState {
    this.state = {
      ...this.state,
      host: normalizeHost(input.host ?? this.state.host),
      port: normalizePort(input.port ?? this.state.port),
      running: true,
      actualHost: normalizeHost(input.host ?? this.state.host),
      actualPort: normalizePort(input.port ?? this.state.port),
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
      actualHost: null,
      actualPort: null,
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
      actualHost: null,
      actualPort: null,
      lifecycleState: "failed",
      lastError: error instanceof Error ? error.message : String(error)
    };
    this.persist();
    return this.getState();
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.stateFilePath), { recursive: true });
    fs.writeFileSync(this.stateFilePath, JSON.stringify(toSavedState(this.state, this.auth), null, 2));
  }

  private reloadSavedAuthentication(): void {
    const savedState = readSavedState(this.stateFilePath);
    if (savedState) {
      this.auth = savedState.auth ?? null;
    }
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

export function getHttpServerHostOptions(): HttpServerHostOption[] {
  const options: HttpServerHostOption[] = [
    { value: WILDCARD_HOST, interfaceName: null },
    { value: DEFAULT_HOST, interfaceName: null }
  ];

  for (const [interfaceName, addresses] of Object.entries(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (!isIpv4Address(address.address) || address.address === DEFAULT_HOST) {
        continue;
      }
      if (options.some((option) => option.value === address.address)) {
        continue;
      }
      options.push({ value: address.address, interfaceName });
    }
  }

  return options;
}

export function getHttpServerAccessUrls(host: string, port: number): string[] {
  const accessHosts = host === WILDCARD_HOST
    ? getHttpServerHostOptions()
      .map((option) => option.value)
      .filter((value) => value !== WILDCARD_HOST && value !== DEFAULT_HOST)
    : [host];
  const resolvedHosts = accessHosts.length > 0 ? accessHosts : [DEFAULT_HOST];
  return [...new Set(resolvedHosts)].map((accessHost) => `http://${accessHost}:${port}/`);
}

function readSavedState(stateFilePath: string): SavedHttpServerState | null {
  if (!fs.existsSync(stateFilePath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(stateFilePath, "utf8")) as SavedHttpServerState;
    return {
      enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : undefined,
      host: parsed.host ? normalizeHost(parsed.host) : undefined,
      port: parsed.port ? normalizePort(parsed.port) : undefined,
      persistent: typeof parsed.persistent === "boolean" ? parsed.persistent : undefined,
      authEnabled: typeof parsed.authEnabled === "boolean" ? parsed.authEnabled : undefined,
      lifecycleState: normalizeSavedLifecycleState(parsed.lifecycleState),
      lastError: parsed.lastError ?? null,
      auth: normalizeSavedAuth(parsed.auth)
    };
  } catch {
    return { lastError: "HTTP 服务状态文件损坏，已回退到默认配置" };
  }
}

function toSavedState(state: HttpServerState, auth: SavedHttpServerAuth | null = null): SavedHttpServerState {
  return {
    enabled: state.enabled,
    host: state.host,
    port: state.port,
    persistent: state.persistent,
    authEnabled: state.authEnabled,
    lifecycleState: state.lifecycleState,
    lastError: state.lastError,
    auth
  };
}

function normalizeHost(value: string): string {
  const host = value.trim();
  if (net.isIPv4(host)) {
    return host;
  }

  throw new Error("HTTP 服务监听地址必须是 IPv4 地址，例如 127.0.0.1、0.0.0.0 或本机网卡地址");
}

function normalizePort(value: number): number {
  if (!Number.isInteger(value) || value <= 0 || value > 65535) {
    throw new Error(`HTTP 服务端口无效：${value}`);
  }
  return value;
}

function resolveAuthChange(
  current: SavedHttpServerAuth | null,
  input: SaveHttpServerStateInput,
): SavedHttpServerAuth | null {
  if (input.clearAuth) {
    return null;
  }

  const username = input.authUsername?.trim() ?? "";
  const password = input.authPassword ?? "";
  if (!username && !password) {
    return current;
  }

  const nextUsername = username || current?.username;
  if (!nextUsername) {
    throw new Error("配置 HTTP 服务认证时必须填写用户名");
  }
  if (nextUsername.length > 128) {
    throw new Error("HTTP 服务认证用户名不能超过 128 个字符");
  }
  if (password) {
    if (password.length < 8) {
      throw new Error("HTTP 服务认证密码至少需要 8 个字符");
    }
    const salt = randomBytes(16).toString("hex");
    return {
      username: nextUsername,
      salt,
      passwordHash: derivePasswordHash(password, salt)
    };
  }
  if (!current) {
    throw new Error("首次配置 HTTP 服务认证时必须填写密码");
  }
  return {
    ...current,
    username: nextUsername
  };
}

function resolveAuthEnabled(host: string, requested: boolean | undefined): boolean {
  const requiresAuth = host !== DEFAULT_HOST;
  if (!requiresAuth && requested === true) {
    throw new Error("HTTP 服务仅绑定 127.0.0.1 时不能启用局域网访问认证");
  }
  if (requiresAuth && requested === false) {
    throw new Error("HTTP 服务绑定非 127.0.0.1 网卡时必须启用局域网访问认证");
  }
  return requiresAuth;
}

function derivePasswordHash(password: string, salt: string): string {
  let value = Buffer.from(`${salt}:${password}`, "utf8");
  for (let index = 0; index < PASSWORD_HASH_ITERATIONS; index += 1) {
    const hash = createHash("sha256");
    hash.update(value);
    hash.update(password, "utf8");
    hash.update(salt, "utf8");
    value = hash.digest();
  }
  return value.toString("hex");
}

function normalizeSavedAuth(value: unknown): SavedHttpServerAuth | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const auth = value as Partial<SavedHttpServerAuth>;
  if (
    typeof auth.username !== "string"
    || typeof auth.salt !== "string"
    || typeof auth.passwordHash !== "string"
    || !auth.username
    || !auth.salt
    || !auth.passwordHash
  ) {
    return null;
  }
  return {
    username: auth.username,
    salt: auth.salt,
    passwordHash: auth.passwordHash
  };
}

function isIpv4Address(value: string): boolean {
  return net.isIPv4(value);
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
