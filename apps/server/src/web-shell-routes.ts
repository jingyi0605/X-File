import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { FastifyInstance } from "fastify";

const DEFAULT_WEB_DEV_ORIGIN = "http://127.0.0.1:17320";
const API_PREFIX = "/api/";
const PREVIEW_PREFIX = "/preview/";

export interface RegisterWebShellRoutesOptions {
  forceDevProxy?: boolean;
}

export function registerWebShellRoutes(
  app: FastifyInstance,
  options: RegisterWebShellRoutesOptions = {}
): void {
  const webMode = resolveWebShellMode(options);
  if (webMode.kind === "disabled") {
    return;
  }

  app.get("/", async (_request, reply) => {
    await replyWithWebShell(reply, webMode, "/");
  });

  app.get("/*", async (request, reply) => {
    const pathname = readRequestPathname(request.url);
    if (pathname.startsWith(API_PREFIX) || pathname.startsWith(PREVIEW_PREFIX)) {
      reply.code(404).send({ message: `Route GET:${pathname} not found`, error: "Not Found", statusCode: 404 });
      return;
    }
    await replyWithWebShell(reply, webMode, request.url);
  });
}

type WebShellMode =
  | { kind: "disabled" }
  | { kind: "dist"; distDir: string; indexHtmlPath: string }
  | { kind: "dev-proxy"; origin: string };

function resolveWebShellMode(
  options: RegisterWebShellRoutesOptions
): WebShellMode {
  const explicitDevOrigin = normalizeHttpOrigin(
    process.env.X_FILE_WEB_DEV_URL?.trim() || buildWebDevOriginFromPort()
  );
  const distDir = resolveWebDistDir();
  const indexHtmlPath = path.join(distDir, "index.html");
  if (!options.forceDevProxy && fs.existsSync(indexHtmlPath)) {
    return {
      kind: "dist",
      distDir,
      indexHtmlPath
    };
  }
  if (explicitDevOrigin) {
    return {
      kind: "dev-proxy",
      origin: explicitDevOrigin
    };
  }
  return { kind: "disabled" };
}

async function replyWithWebShell(
  reply: { type: (value: string) => any; send: (payload: any) => any; header: (name: string, value: string) => any; code: (value: number) => any },
  mode: Exclude<WebShellMode, { kind: "disabled" }>,
  requestUrl: string
): Promise<void> {
  const pathname = readRequestPathname(requestUrl);
  if (mode.kind === "dist") {
    const resolved = resolveDistAssetPath(mode.distDir, pathname);
    if (resolved) {
      reply.type(resolveContentType(resolved));
      reply.send(fs.readFileSync(resolved));
      return;
    }
    reply.type("text/html; charset=utf-8");
    reply.send(fs.readFileSync(mode.indexHtmlPath));
    return;
  }

  const upstreamUrl = new URL(requestUrl, ensureTrailingSlash(mode.origin));
  const response = await fetch(upstreamUrl);
  const body = Buffer.from(await response.arrayBuffer());
  reply.code(response.status);
  const contentType = response.headers.get("content-type");
  if (contentType) {
    reply.header("content-type", contentType);
  }
  const cacheControl = response.headers.get("cache-control");
  if (cacheControl) {
    reply.header("cache-control", cacheControl);
  }
  reply.send(body);
}

function resolveWebDistDir(): string {
  const explicit = process.env.X_FILE_WEB_DIST_DIR?.trim();
  if (explicit) {
    return path.resolve(explicit);
  }
  const currentFileDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(currentFileDir, "../../web/dist");
}

function buildWebDevOriginFromPort(): string {
  const rawPort = process.env.X_FILE_WEB_PORT?.trim();
  if (!rawPort) {
    return DEFAULT_WEB_DEV_ORIGIN;
  }
  return `http://127.0.0.1:${rawPort}`;
}

function normalizeHttpOrigin(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  try {
    const url = new URL(value);
    if (!/^https?:$/i.test(url.protocol)) {
      return null;
    }
    return url.toString().replace(/\/+$/g, "");
  } catch {
    return null;
  }
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function readRequestPathname(url: string): string {
  try {
    return new URL(url, "http://127.0.0.1").pathname;
  } catch {
    return "/";
  }
}

function resolveDistAssetPath(distDir: string, pathname: string): string | null {
  const normalizedPath = pathname === "/" ? "/index.html" : pathname;
  const decodedPath = decodeURIComponent(normalizedPath);
  const relativePath = decodedPath.replace(/^\/+/, "");
  const candidate = path.resolve(distDir, relativePath);
  if (!candidate.startsWith(distDir)) {
    return null;
  }
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
    return null;
  }
  return candidate;
}

function resolveContentType(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".html") return "text/html; charset=utf-8";
  if (extension === ".js") return "text/javascript; charset=utf-8";
  if (extension === ".css") return "text/css; charset=utf-8";
  if (extension === ".json") return "application/json; charset=utf-8";
  if (extension === ".svg") return "image/svg+xml";
  if (extension === ".png") return "image/png";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".webp") return "image/webp";
  if (extension === ".ico") return "image/x-icon";
  return "application/octet-stream";
}
