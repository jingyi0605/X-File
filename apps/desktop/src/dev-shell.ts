import { spawn } from "node:child_process";

const server = spawn("pnpm", ["--filter", "@x-file/server", "dev"], {
  stdio: "inherit",
  shell: true
});

console.log("X-File 桌面壳占位已启动内置后端。");
console.log("前端开发服务请另开终端运行：pnpm --filter @x-file/web dev");
console.log("健康检查地址：http://127.0.0.1:17321/api/health");
console.log("注意：第一版 dev shell 不实现系统托盘，也不托管真实常驻后台子进程。");

function shutdown() {
  server.kill("SIGTERM");
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

server.on("exit", (code) => {
  process.exitCode = code ?? 0;
});
