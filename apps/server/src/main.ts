import { pathToFileURL } from "node:url";

import { createServer } from "./app.js";
import { getDefaultHttpServerHost, getDefaultHttpServerPort, HttpServerManager } from "./http-server-manager.js";

function readPort(rawPort = process.env.X_FILE_SERVER_PORT) {
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
  try {
    httpServerManager.bindServerFactory(() => createServer({
      httpServerManager,
      manageHttpServerLifecycle: true,
      sidecarProfile: resolveStandaloneSidecarProfile()
    }));

    configureInitialHttpServerState(httpServerManager, process.env);

    if (httpServerManager.getState().enabled) {
      await httpServerManager.start();
    }
  } catch (error) {
    httpServerManager.markError(error);
    throw error;
  }
}

export function configureInitialHttpServerState(
  manager: HttpServerManager,
  environment: NodeJS.ProcessEnv,
) {
  const current = manager.getState();
  const requestedHost = environment.X_FILE_SERVER_HOST?.trim();
  const host = requestedHost || (
    !current.authConfigured && current.host !== getDefaultHttpServerHost()
      ? getDefaultHttpServerHost()
      : current.host
  );
  const port = environment.X_FILE_SERVER_PORT
    ? readPort(environment.X_FILE_SERVER_PORT)
    : current.port;

  return manager.save({
    enabled: current.enabled,
    host,
    port
  });
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
