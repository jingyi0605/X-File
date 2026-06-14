# X-File

X-File 是从 CodingNS 拆出的文档库独立应用。当前仓库已经建立第一版骨架：Tauri 2 桌面壳、React 前端、Fastify 后端、HTTP 服务启停 API、系统托盘菜单、窗口常驻策略、桌面壳托管后端入口和 CodingNS 集成入口。

## 目录

- `apps/web`：React + TypeScript 前端，负责显示应用入口和后端连接状态。
- `apps/server`：Fastify + TypeScript 后端，提供健康检查、文档库 API、HTTP 服务状态和集成入口。
- `apps/desktop`：Tauri 2 桌面壳骨架，包含窗口配置、Rust 入口、系统托盘菜单、常驻策略和后端子进程托管入口。
- `docs`：验收说明和 CodingNS 接入说明。
- `scripts`：版本同步、macOS 签名公证、Windows 打包和发布前置校验脚本。

## 脚本

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm dev
pnpm dev:server
pnpm dev:web
pnpm dev:all
pnpm dev:desktop
pnpm build:macos
pnpm build:windows
```

调试脚本分前后端独立入口：

- `pnpm dev:server`：只启动后端调试服务，默认 `http://0.0.0.0:17321`。
- `pnpm dev:web`：只启动前端调试服务，默认 `http://0.0.0.0:17320`。
- `pnpm dev` / `pnpm dev:all`：同时编排启动前端和后端。
- 前端 `/api/*` 会代理到本机后端 `http://127.0.0.1:17321`。

可通过环境变量覆盖：`X_FILE_WEB_HOST`、`X_FILE_WEB_PORT`、`X_FILE_SERVER_HOST`、`X_FILE_SERVER_PORT`。后端调试脚本会显式设置 `X_FILE_ALLOW_PUBLIC_HOST=1`，并把 HTTP 状态写到仓库内 `.x-file-dev/http-server-state.json`，避免污染正式用户配置。

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

## 桌面打包与发布

X-File 用 Tauri 2 打包为 macOS（universal `.app` / `.dmg`）和 Windows（NSIS `.exe` / MSI）应用，通过 GitHub Releases + `tauri-plugin-updater` 提供 dev / stable 双更新通道。整体链路参考父项目 CodingNS。

关键文件：

- `apps/desktop/src-tauri/tauri.conf.json`：bundle 目标、updater 公钥与 endpoint。
- `apps/desktop/src-tauri/src/updater.rs`：检查 / 下载 / 安装更新，按通道（stable / dev）选择 endpoint。
- `apps/desktop/src-tauri/src/lib.rs`：注册 updater 命令（`check_for_update` / `download_update` / `install_update` / `get_release_channel` / `set_release_channel` / `open_external_url`）。
- `scripts/sync-version.mjs`：以根 `VERSION` 为唯一真源同步全仓版本号。
- `scripts/build-macos.sh`：universal 构建 + 自动接 `release-macos.sh` 签名公证。
- `scripts/release-macos.sh`：Developer ID 签名 + DMG 重建 + Apple 公证 + stapling + Gatekeeper 校验。
- `scripts/build-windows.sh`：Windows 打包（按版本通道切 NSIS / MSI）。
- `.github/workflows/desktop-release.yml`：tag 触发的跨平台打包发布 CI。
- `.github/workflows/ci.yml`：PR 类型检查 + 测试 + 构建。

### 版本管理

版本号统一来自根目录 `VERSION` 文件（semver）。改版本后执行：

```bash
# 改 VERSION（例如 0.2.0 或 0.2.0-beta.1），再同步
pnpm version:sync   # 同步到 package.json / tauri.conf.json / Cargo.toml / Cargo.lock
```

### 发布流程

1. 改 `VERSION`，跑 `pnpm version:sync`，提交。
2. 打 tag：`git tag v<VERSION>`（如 `v0.2.0` 或 `v0.2.0-beta.1`），推送。
3. `desktop-release.yml` 自动触发：macOS universal 签名公证 + Windows 打包 + 生成 `latest.json` + 上传到 GitHub Release。
4. 通道由版本号决定：
   - **stable**（`VERSION` 不含 `-`，如 `0.2.0`）：产物上传到版本 tag release，GitHub `releases/latest` 自动指向。客户端 stable 通道查 `releases/latest/download/latest.json`。
   - **beta**（`VERSION` 含 `-`，如 `0.2.0-beta.1`）：版本 tag release 标记为 prerelease，同时维护滚动 release `beta-latest`（含 `latest.json` 指针）。客户端 beta 通道查 `releases/download/beta-latest/latest.json`。

### 必需的 secrets

在仓库 Settings → Secrets（或 `release` environment）配置：

macOS 签名公证（复用 Apple Developer ID 证书）：

- `APPLE_CERTIFICATE_P12_BASE64` / `APPLE_CERTIFICATE_PASSWORD` / `APPLE_KEYCHAIN_PASSWORD`
- `APPLE_SIGN_IDENTITY` / `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID`

Tauri updater 签名：

- `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`：minisign 私钥，签更新包。
- `X_FILE_UPDATER_PUBLIC_KEY`（secret）：公钥，值必须与 `tauri.conf.json` 的 `plugins.updater.pubkey` 一致。
- `X_FILE_UPDATER_ENDPOINT`（vars）：stable URL 占位（双通道下运行时按通道选，仅校验用）。

Windows 代码签名默认不做（沿用父项目现状），仅保留 Tauri updater 的 minisign 签名保证自动更新可验签。

发布前置检查（本地）：

```bash
node scripts/check-desktop-release-secrets.mjs --platform macos --require-real-secrets
```

Windows self-hosted 实机构建入口（手动，保留用于实机调试）：

```text
.github/workflows/x-file-windows-build.yml
```

## 当前边界

- 已建立 dev/stable 双更新通道（GitHub Releases + Tauri updater）和 tag 触发的跨平台发布 CI；macOS 签名公证复用 Apple Developer ID 证书，Windows 不做 authenticode 签名（首次运行有 SmartScreen 警告）。
- 不主动启动长期 dev server。
- 已实现基础系统托盘菜单；不实现开机自启和 deep link 注册。
- 桌面壳能托管后端子进程并优先寻找打包资源里的 `x-file-server/main.js`；发布包仍需要携带 Node runtime 或改为真正 sidecar，不能假设用户机器一定有 Node。
- 不引入 CodingNS 的工作区、事务模式、Teable、Butler 或代码工作台能力。
