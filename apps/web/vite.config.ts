import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

const DEFAULT_WEB_HOST = "127.0.0.1";
const DEFAULT_WEB_PORT = 17320;
const DEFAULT_SERVER_HOST = "127.0.0.1";
const DEFAULT_SERVER_PORT = 17321;

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const webHost = readHost(env.X_FILE_WEB_HOST, DEFAULT_WEB_HOST);
  const webPort = readPort(env.X_FILE_WEB_PORT, DEFAULT_WEB_PORT, "X_FILE_WEB_PORT");
  const serverHost = readHost(env.X_FILE_SERVER_HOST, DEFAULT_SERVER_HOST);
  const serverPort = readPort(env.X_FILE_SERVER_PORT, DEFAULT_SERVER_PORT, "X_FILE_SERVER_PORT");

  return {
    plugins: [react()],
    server: {
      host: webHost,
      port: webPort,
      strictPort: true,
      proxy: {
        "/api": {
          target: `http://${toProxyTargetHost(serverHost)}:${serverPort}`,
          changeOrigin: true
        }
      }
    }
  };
});

function readHost(value: string | undefined, fallback: string): string {
  const host = value?.trim();
  return host || fallback;
}

function readPort(value: string | undefined, fallback: number, name: string): number {
  if (!value?.trim()) {
    return fallback;
  }

  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`${name} 无效：${value}`);
  }
  return port;
}

function toProxyTargetHost(host: string): string {
  // 后端监听 0.0.0.0 时，客户端不能把它当成目标地址连接，代理要连本机回环。
  return host === "0.0.0.0" ? "127.0.0.1" : host;
}
