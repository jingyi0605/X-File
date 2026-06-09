# X-File

X-File 是从 CodingNS 拆出的文档库独立应用。当前仓库已经建立第一版骨架：Tauri 2 桌面壳、React 前端、Fastify 后端、HTTP 服务启停 API、系统托盘菜单、窗口常驻策略、桌面壳托管后端入口和 CodingNS 集成入口。

## 目录

- `apps/web`：React + TypeScript 前端，负责显示应用入口和后端连接状态。
- `apps/server`：Fastify + TypeScript 后端，提供健康检查、文档库 API、HTTP 服务状态和集成入口。
- `apps/desktop`：Tauri 2 桌面壳骨架，包含窗口配置、Rust 入口、系统托盘菜单、常驻策略和后端子进程托管入口。
- `docs`：验收说明和 CodingNS 接入说明。
- `scripts`：macOS / Windows 构建骨架校验脚本。

## 脚本

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm dev:server
pnpm dev:web
pnpm dev:desktop
pnpm build:macos
pnpm build:windows
```

`pnpm dev:desktop` 会启动后端开发进程，并输出前端开发地址。正式桌面骨架校验使用 `pnpm --filter @x-file/desktop build`，它会跑 TypeScript 编译和 Tauri Rust `cargo check`。

## 健康检查

后端启动后可访问：

```text
GET http://127.0.0.1:17321/api/health
```

返回结构：

```json
{
  "ok": true,
  "app": "X-File",
  "version": "0.1.0"
}
```

## HTTP 服务状态

默认监听：

```text
http://127.0.0.1:17321
```

读取状态：

```text
GET /api/server/state
```

保存配置：

```text
PUT /api/server/state
```

返回字段包含：

- `enabled`：是否启用 HTTP 服务。
- `host`：第一版固定 `127.0.0.1`。
- `port`：服务端口，默认 `17321`。
- `persistent`：关闭窗口后是否允许常驻。
- `running`：当前进程是否正在监听。
- `startedAt`：最近启动时间。
- `lastError`：最近错误。

第一版规则是：关闭窗口和退出应用必须区分；`persistent=true` 时桌面壳会隐藏主窗口并保留当前进程，用户可以从托盘恢复窗口或退出应用，用户明确退出应用时停止桌面壳托管的后端子进程。开机自启和安装包代码签名不在本轮声称完成范围内。

## CodingNS 集成入口

```text
GET /api/integration/status
```

这个接口返回 X-File 可用性、HTTP 服务状态和文档库快照摘要。CodingNS 后续应该调用这个接口判断 X-File 是否可用，而不是继续启动自身文档库重扫描。

详细说明见：

- `docs/20260608-CodingNS接入X-File说明.md`
- `docs/20260608-X-File第一版验收说明.md`

## 桌面打包骨架

关键文件：

- `apps/desktop/src-tauri/tauri.conf.json`
- `apps/desktop/src-tauri/Cargo.toml`
- `apps/desktop/src-tauri/src/main.rs`

当前已接入 Tauri updater 插件并预留签名发布所需的配置占位，但不等于已经完成真实自动更新验收。macOS 和 Windows 本地脚本默认只做骨架校验；发布前必须配置真实 updater secrets，并在 Windows 实机 runner 上跑安装包构建。Windows 代码签名证书是可选项，不影响 updater 正常更新。

发布前置检查：

```bash
node scripts/check-desktop-release-secrets.mjs --platform windows --require-real-secrets
```

Windows 实机构建入口：

```text
.github/workflows/x-file-windows-build.yml
```

## 当前边界

- 已有自动更新插件、签名配置占位和 Windows runner 工作流，但没有声称真实自动更新或真实 Windows 安装包已经验证。
- 不主动启动长期 dev server。
- 已实现基础系统托盘菜单；不实现开机自启和 deep link 注册。
- 桌面壳能托管后端子进程并优先寻找打包资源里的 `x-file-server/main.js`；发布包仍需要携带 Node runtime 或改为真正 sidecar，不能假设用户机器一定有 Node。
- 不引入 CodingNS 的工作区、事务模式、Teable、Butler 或代码工作台能力。
