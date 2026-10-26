# X-File

X-File 是从 CodingNS 拆出的文档库独立应用，使用 Tauri 2、React 和 Rust 原生文档引擎。文档扫描、索引和静态导出统一由 Rust 执行；Fastify 保留 HTTP 业务接口，通过原生 CLI 发起索引任务。

## 目录

- `apps/web`：React + TypeScript 前端，负责显示应用入口和后端连接状态。
- `apps/server`：Fastify + TypeScript 后端，提供健康检查、文档库 API、HTTP 服务状态和集成入口。
- `apps/desktop`：Tauri 2 桌面壳骨架，包含窗口配置、Rust 入口、系统托盘菜单、常驻策略和后端子进程托管入口。
- `packages/indexer`：原生 CLI 客户端、只读快照类型和文件可见性规则，不包含 TypeScript 扫描器、解析器或 SQLite 存储。
- `docs`：验收说明和 CodingNS 接入说明。
- `scripts`：前后端调试脚本，以及桌面客户端统一验证、统一打包脚本。

## 脚本

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm dev:server
pnpm dev:web
pnpm dev:desktop
pnpm dev:desktop:frontend
pnpm verify:desktop
pnpm package:desktop:macos
pnpm package:desktop:windows
```

## 文档索引

- 扫描在一次目录遍历中完成文件发现、属性比对和数量统计，不再预扫描目录。
- 目录发现使用队列；文件扩展名在读取文件属性前过滤。索引一次保存路径、属性、标签和摘要，不再启动后台摘要回填。
- 同一根目录的桌面任务在后台线程中串行执行，复用带文件版本校验的目录与索引状态缓存；运行中的新变更保留到下一轮。跨目录变更保留独立路径集合，不再扩大为公共根目录。独立 CLI 与标签重算通过系统文件锁串行写入同一根目录。
- 文件监听回调先快速收集路径，每 150ms 合并提交一次；文件系统要求重扫时按通知范围重新遍历。任务完成后通过原生事件同步空闲页面的列表和标签计数。
- 索引恢复日志使用缓冲追加；进度每 500ms 合并写入，部分快照按 5 秒间隔保存。文件属性未变化时复用旧索引；无变化刷新不改写 catalog、活动文件快照、索引状态快照和导出文件。
- 导出按 `dirtyScope` 更新受影响的文档详情、目录元数据、标签根和文档关系。目录元数据使用稳定的目录分片标识，首次读取旧布局时重建为新布局。
- 搜索索引保存文档到搜索桶的映射和词项指纹，只对变化文档分词，并更新其新旧搜索桶；词项未变化时复用搜索产物。每个词项前缀按文档标识分成 16 片，桶名如 `han-03`，读取器按 manifest 中的路径读取。桶内仍为 `search-bucket-v2`；manifest 保持 `search-v2` 并记录 `partition_count: 16`。旧前缀桶在下次有变化时迁移，读取器兼容新旧布局。删除文档同时清理旧倒排记录。
- 桌面读取视图按快照文件版本缓存，并缓存目录到文档位置的映射；分页后才读取当前页文件的大小和创建时间。

手动刷新和文件监听使用 `full` 流程。原生 CLI 支持 `full`、`index-only`、`export-only` 和 `tags-only`，请求 JSON 可以通过 stdin 传入；`targetPath` 使用文档库内的相对路径，`targetPaths` 可传入多个文件或目录，重叠范围只遍历一次。旧 TypeScript worker、执行器注册层、SQLite 回退、独立全文解析和重复的搜索构建入口已经删除。

验证与性能测量不需要启动开发服务器：

```bash
cargo build --manifest-path apps/desktop/src-tauri/Cargo.toml
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --lib
pnpm --filter @x-file/shared build
pnpm --filter @x-file/indexer build
pnpm benchmark:index -- --files 10000 --dirs 100
```

性能脚本创建临时资料库，分别测量首次索引、无变化刷新，以及摘要词项不变和改变两种单文件更新，并报告实际改写的导出文件数量，结束后清理测试数据。`X_FILE_DESKTOP_CLI_PATH` 可以指定待测 CLI；默认寻找本地桌面构建产物。

调试脚本只保留前后端独立入口：

- `pnpm dev:server`：只启动后端调试服务，默认 `http://0.0.0.0:17321`。
- `pnpm dev:web`：只启动前端调试服务，默认 `http://0.0.0.0:17320`。
- 前端 `/api/*` 会代理到本机后端 `http://127.0.0.1:17321`。

可通过环境变量覆盖：`X_FILE_WEB_HOST`、`X_FILE_WEB_PORT`、`X_FILE_SERVER_HOST`、`X_FILE_SERVER_PORT`。后端调试脚本会显式设置 `X_FILE_ALLOW_PUBLIC_HOST=1`，并把 HTTP 状态写到仓库内 `.x-file-dev/http-server-state.json`，避免污染正式用户配置。

`pnpm dev:desktop` 现在直接走 `pnpm --filter @x-file/desktop tauri:dev`，会按 Tauri dev 流程自动拉起前端开发服务并启动桌面调试窗口。正式桌面骨架校验使用 `pnpm --filter @x-file/desktop build`，它会跑 TypeScript 编译和 Tauri Rust `cargo check`。

`pnpm dev:desktop:frontend` 启动仅前端热更新的桌面调试窗口：保留 Vite 热更新，通过 `tauri dev --no-watch` 关闭 Rust 源码监听，同时关闭共享包监听编译和 Node 后端自动重启。启动时仍会编译共享依赖并按需编译 Rust；运行期间修改 Rust、Node 后端或共享包源码不会自动重编译或重启后端与桌面窗口。这些改动需要退出并重新运行该命令才会生效。

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

## 外部 Agent 接入方向

X-File 不再提供内置 AI 助手或文件助手，也不再内置 Codex、Claude Code 的对话、会话、权限审批和供应商插件。已有文档管理、预览、索引、标签及 ONLYOFFICE 功能继续保留；本次移除不会主动清理用户磁盘上的历史助手数据。

已提供 31 项原生工具，通过 CLI 和 MCP stdio 共用工具目录、JSON Schema、结果格式与业务实现。覆盖资料库配置、检索、文件、标签、收藏、索引和 ONLYOFFICE；配套 `skills/x-file/SKILL.md` 帮助外部 Agent 发现和调用能力。无需启动图形窗口或 Node 后端。

```bash
apps/desktop/src-tauri/target/debug/x-file-desktop cli list
apps/desktop/src-tauri/target/debug/x-file-desktop cli call xfile_status
apps/desktop/src-tauri/target/debug/x-file-desktop mcp
```

在「设置 → 集成服务 → 外部 Agent 接入」配置 API Key 并启用（默认关闭）。CLI/MCP 使用 `X_FILE_AGENT_API_KEY` 环境变量；设置页提供只读配置模板和 SKILL 安装命令。

构建和接入说明见 `docs/20261026-外部Agent工具接入说明.md`。范围与验收见 `specs/spec004-X-File移除内置助手与外部Agent接入/`。本阶段不提供远程 MCP HTTP 或远程认证。

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
- `scripts/verify-desktop.mjs`：默认执行完整桌面打包验证；也支持单独跑前置检查或产物检查。
- `scripts/package-desktop.sh`：统一做 macOS / Windows 桌面打包。
- `scripts/sync-version.mjs`：以根 `VERSION` 为唯一真源同步全仓版本号。
- `scripts/archive/20260616/`：归档的历史脚本和临时工具脚本。
  - 包含原 `build-macos.sh`、`build-windows.sh`、`release-macos.sh`、`check-desktop-release-secrets.mjs`、`prepare-bundled-server.mjs` 以及临时工具脚本。
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
pnpm verify:desktop -- --platform=macos --mode=preflight --require-real-secrets
```

Windows self-hosted 实机构建入口（手动，保留用于实机调试）：

```text
.github/workflows/x-file-windows-build.yml
```

## 当前边界

- 已建立 dev/stable 双更新通道（GitHub Releases + Tauri updater）和 tag 触发的跨平台发布 CI；macOS 签名公证复用 Apple Developer ID 证书，Windows 不做 authenticode 签名（首次运行有 SmartScreen 警告）。
- 不主动启动长期 dev server。
- 已实现基础系统托盘菜单；不实现开机自启和 deep link 注册。
- 文档库索引不依赖 Node 或 SQLite。独立 Web/HTTP 功能的 Node 依赖由对应模块维护，不能假设用户机器一定有 Node。
- 不引入 CodingNS 的工作区、事务模式、Teable、Butler 或代码工作台能力。
