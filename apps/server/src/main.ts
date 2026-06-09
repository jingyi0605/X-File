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
    manageHttpServerLifecycle: true
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

main().catch((error) => {
  new HttpServerManager().markError(error);
  console.error(error);
  process.exitCode = 1;
});
