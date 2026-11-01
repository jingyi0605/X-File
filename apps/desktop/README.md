# X-File 桌面壳

这个目录是 X-File Tauri 2 桌面壳。它支持 TypeScript build、`cargo check`、macOS universal、Windows x86_64 和 Linux x86_64 打包，并通过 Tauri updater 提供签名更新。国内 HTTPS 镜像可以作为更新首选源，GitHub Releases 作为回退源。

## 启动关系

1. Node Fastify 后端监听 `127.0.0.1:17321`，提供 `/api/*`。
2. React 前端开发服务监听 `127.0.0.1:17320`。
3. Tauri 2 窗口加载前端页面，前端调用本机后端 API。
4. 第一版 `dev` 脚本会拉起后端开发进程，并提示另开终端启动前端。
5. 正式包不内置 Node 后端，文档库核心使用 Rust 原生引擎；外部 Node sidecar 需要通过 `X_FILE_EXTERNAL_NODE_SIDECAR` 显式启用，开发期后端仍可由桌面壳托管。
6. `persistent=true` 时桌面壳会拦截关闭窗口并隐藏主窗口，进程继续保留；托盘菜单可以显示/隐藏窗口、开启/关闭常驻、启动/停止内置后端和退出应用。

## 开发启动

```bash
pnpm --filter @x-file/desktop dev
```

这个脚本只负责开发期后端进程，前端仍需另开终端：

```bash
pnpm --filter @x-file/web dev
```

如果要打开 Tauri 窗口：

```bash
pnpm --filter @x-file/desktop tauri:dev
```

在仓库根目录运行以下命令，可仅保留前端热更新：

```bash
pnpm dev:desktop:frontend
```

该模式启动时仍会编译共享依赖并按需编译 Rust，但运行期间关闭 Rust 源码监听、共享包监听编译和 Node 后端自动重启，仅保留 Vite 热更新。后端和共享包源码改动需要退出并重新运行该命令才会生效；`pnpm dev:desktop` 的原有监听行为不变。

## 构建校验

```bash
pnpm --filter @x-file/desktop build
```

这个命令会执行：

- `tsc -p tsconfig.json`
- `cargo check --manifest-path src-tauri/Cargo.toml`

## 打包边界

- 根目录统一打包入口是 `bash scripts/package-desktop.sh [macos|windows|linux]`。
- Linux 入口是 `bash scripts/package-desktop.sh linux`；稳定版默认生成 AppImage、deb 和 rpm，预发布版默认生成 AppImage 和 deb（RPM 不接受带连字符的预发布版本号）。
- `pnpm --filter @x-file/desktop tauri:build` 仍是底层 Tauri 命令，但不再作为仓库公开流程入口。
- `pnpm --filter @x-file/desktop release:check` 会调用根目录 `scripts/verify-desktop.mjs --mode preflight` 检查 Tauri updater 配置结构。
- 真实发布前必须执行 `node ../../scripts/verify-desktop.mjs --platform <平台> --mode preflight --require-real-secrets`，并配置真实 updater 私钥、公钥。国内更新清单地址是可选配置；未配置时使用 GitHub 官方源。
- 当前 updater 支持 stable/beta 双通道、签名下载、安装重启和国内镜像优先回退；Windows 代码签名证书是可选项，不影响 Tauri updater 正常验签更新。
- 外部后端托管入口依赖调用方提供的 Node 运行时；正式包不携带 Node runtime 或内置助手插件。
- `scripts/archive/20260616/prepare-bundled-server.mjs` 会清理旧 Node 资源与内置助手插件，并写出 `apps/desktop/src-tauri/resources/x-file-resource-boundary.json`，用于记录主包资源边界和宿主查找优先级。

桌面端不再提供内置 AI / 文件助手，已删除供应商检测、会话入口和助手专用插件管理命令。原生可执行文件新增 `cli` 和 `mcp` 子命令，提供 28 项共享工具及内嵌 SKILL；这两个入口不启动桌面窗口或 Node 服务。在设置的「集成服务」配置 API Key 并启用外部 Agent（默认关闭），调用进程使用 `X_FILE_AGENT_API_KEY` 环境变量；同页提供 MCP/CLI 配置和 SKILL 安装命令。接入说明见根目录 `docs/20261026-外部Agent工具接入说明.md`。
