import { randomBytes } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { HttpServerManager } from "../http-server-manager.js";

const SESSION_COOKIE = "x_file_session";
const SESSION_COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_FAILURES = 8;

interface LoginFailures {
  count: number;
  expiresAt: number;
}

export interface HttpAuthStatus {
  required: boolean;
  configured: boolean;
  authenticated: boolean;
  username: string | null;
}

export function registerHttpAuthRoutes(
  app: FastifyInstance,
  httpServerManager: HttpServerManager,
): void {
  const sessions = new Set<string>();
  const loginFailures = new Map<string, LoginFailures>();

  app.addHook("onRequest", async (request, reply) => {
    const pathname = readPathname(request.url);
    if (request.method === "OPTIONS" || !requiresLanAuthentication(request) || isPublicPath(pathname)) {
      return;
    }

    const state = httpServerManager.getState();
    if (!state.authEnabled) {
      sendAuthError(reply, 503, "AUTH_NOT_ENABLED", "当前监听地址未启用局域网访问认证");
      return;
    }
    if (!state.authConfigured) {
      sendAuthError(reply, 503, "AUTH_NOT_CONFIGURED", "请先在本机设置中配置局域网访问用户名和密码");
      return;
    }

    if (hasValidSession(request, sessions)) {
      return;
    }

    sendAuthError(reply, 401, "AUTH_REQUIRED", "请先登录后访问 X-File");
  });

  app.get("/api/auth/status", async (request): Promise<HttpAuthStatus> => {
    const state = httpServerManager.getState();
    const required = requiresLanAuthentication(request);
    const authenticated = !required || hasValidSession(request, sessions);
    return {
      required,
      configured: state.authEnabled && state.authConfigured,
      authenticated,
      username: authenticated ? state.authUsername : null
    };
  });

  app.post("/api/auth/login", async (request, reply) => {
    const body = isRecord(request.body) ? request.body : {};
    const username = typeof body.username === "string" ? body.username : "";
    const password = typeof body.password === "string" ? body.password : "";
    const state = httpServerManager.getState();
    if (!state.authEnabled) {
      sendAuthError(reply, 503, "AUTH_NOT_ENABLED", "当前监听地址未启用局域网访问认证");
      return;
    }

    if (!state.authConfigured) {
      sendAuthError(reply, 503, "AUTH_NOT_CONFIGURED", "请先在本机设置中配置局域网访问用户名和密码");
      return;
    }
    const clientKey = request.ip;
    const failures = getActiveLoginFailures(loginFailures, clientKey);
    if (failures && failures.count >= MAX_LOGIN_FAILURES) {
      sendAuthError(reply, 429, "AUTH_RATE_LIMITED", "登录尝试次数过多，请稍后再试");
      return;
    }
    if (!httpServerManager.verifyCredentials(username, password)) {
      recordLoginFailure(loginFailures, clientKey);
      sendAuthError(reply, 401, "AUTH_INVALID", "用户名或密码错误");
      return;
    }

    loginFailures.delete(clientKey);
    const token = randomBytes(32).toString("base64url");
    sessions.add(token);
    reply
      .header("set-cookie", buildSessionCookie(token))
      .send({
        required: true,
        configured: true,
        authenticated: true,
        username: state.authUsername
      });
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const token = readSessionToken(request);
    if (token) {
      sessions.delete(token);
    }
    reply.header("set-cookie", buildExpiredSessionCookie()).send({ ok: true });
  });
}

function requiresLanAuthentication(request: FastifyRequest): boolean {
  const remoteAddress = request.socket.remoteAddress;
  if (!remoteAddress) {
    return false;
  }
  const normalized = remoteAddress.replace(/^::ffff:/, "");
  return normalized !== "::1" && !normalized.startsWith("127.");
}

function isPublicPath(pathname: string): boolean {
  return (
    pathname === "/"
    || pathname === "/api/health"
    || pathname.startsWith("/api/auth/")
    || (!pathname.startsWith("/api/") && !pathname.startsWith("/preview/"))
  );
}

function hasValidSession(
  request: FastifyRequest,
  sessions: Set<string>,
): boolean {
  const token = readSessionToken(request);
  return token !== null && sessions.has(token);
}

function readSessionToken(request: FastifyRequest): string | null {
  const cookieHeader = request.headers.cookie;
  if (!cookieHeader) {
    return null;
  }
  const pair = cookieHeader
    .split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith(`${SESSION_COOKIE}=`));
  if (!pair) {
    return null;
  }
  try {
    return decodeURIComponent(pair.slice(SESSION_COOKIE.length + 1));
  } catch {
    return null;
  }
}

function getActiveLoginFailures(
  failures: Map<string, LoginFailures>,
  clientKey: string,
): LoginFailures | null {
  const current = failures.get(clientKey);
  if (!current) {
    return null;
  }
  if (current.expiresAt <= Date.now()) {
    failures.delete(clientKey);
    return null;
  }
  return current;
}

function recordLoginFailure(
  failures: Map<string, LoginFailures>,
  clientKey: string,
): void {
  const current = getActiveLoginFailures(failures, clientKey);
  failures.set(clientKey, {
    count: (current?.count ?? 0) + 1,
    expiresAt: current?.expiresAt ?? Date.now() + LOGIN_WINDOW_MS
  });
}

function buildSessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_COOKIE_MAX_AGE_SECONDS}`;
}

function buildExpiredSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function sendAuthError(
  reply: FastifyReply,
  statusCode: number,
  code: string,
  detail: string,
): void {
  reply.code(statusCode).send({
    code,
    detail,
    message: detail,
    statusCode
  });
}

function readPathname(url: string): string {
  try {
    return new URL(url, "http://127.0.0.1").pathname;
  } catch {
    return "/";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
