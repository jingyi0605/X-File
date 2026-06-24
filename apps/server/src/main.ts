import { pathToFileURL } from "node:url";

import { createServer } from "./app.js";
import { getDefaultHttpServerHost, getDefaultHttpServerPort, HttpServerManager } from "./http-server-manager.js";

function readPort() {
  const rawPort = process.env.X_FILE_SERVER_PORT;
  if (!rawPort) {
    return getDefaultHttpServerPort();
  }

  const port = Number(rawPort);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid X_FILE_SERVER_PORT: ${rawPort}`);
  }

  return port;
}

async function main() {
  const httpServerManager = new HttpServerManager();
  httpServerManager.bindServerFactory(() => createServer({
    httpServerManager,
    manageHttpServerLifecycle: true,
    sidecarProfile: resolveStandaloneSidecarProfile()
  }));

  const host = process.env.X_FILE_SERVER_HOST ?? httpServerManager.getState().host ?? getDefaultHttpServerHost();
  const port = process.env.X_FILE_SERVER_PORT ? readPort() : httpServerManager.getState().port;
  httpServerManager.save({
    enabled: httpServerManager.getState().enabled,
    host,
    port
  });

  if (httpServerManager.getState().enabled) {
    await httpServerManager.start();
  }
}

export function resolveStandaloneSidecarProfile(): "full" | "sidecar-only" {
  const raw = process.env.X_FILE_NODE_SIDECAR_PROFILE?.trim().toLowerCase();
  if (raw === "sidecar-only") {
    return "sidecar-only";
  }
  return "full";
}

if (isCliEntry()) {
  main().catch((error) => {
    new HttpServerManager().markError(error);
    console.error(error);
    process.exitCode = 1;
  });
}

function isCliEntry(): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  return import.meta.url === pathToFileURL(entry).href;
}
