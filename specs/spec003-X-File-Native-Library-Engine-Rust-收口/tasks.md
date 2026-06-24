# 任务清单 - spec003-X-File-Native-Library-Engine-Rust-收口（人话版）

状态：Draft

## 阶段 1：先盘清真实依赖边界

- [x] 1.1 盘清 desktop、library-engine 和打包链真实依赖
  - 状态：DONE
  - 本次完成结果：已确认 `apps/desktop/src-tauri/src/lib.rs` 当前通过 `BackendProcessManager` 拉起随包 Node，命令优先解析 `resources/x-file-runtime/.../node`，入口优先解析 `resources/x-file-library-engine/dist/main.js`；`tauri.conf.json` 仍在 `beforeBuildCommand` 中调用 `prepare-bundled-server.mjs` 准备 `x-file-library-engine + x-file-runtime`；`scripts/package-desktop.sh` 只是包一层 Tauri build，真正的资源准备和 Node runtime 注入发生在 archive 脚本。
  - 关键发现：`indexer + sqlite + export` 仍在 Node `@x-file/indexer` 链路里；`watcher` 代码虽然存在于 `apps/server/src/library/watch-service.ts`，但当前并未真正接入 `library-engine` 宿主；`/api/engine/health` 里的 `watcherReady/indexerReady/sqliteReady/exportReady` 目前是硬编码 `true`，不可信。
  - 怎么验证：人工走查 `tauri.conf.json`、`lib.rs`、`packages/library-engine`、`prepare-bundled-server.mjs`、`package-desktop.sh`

- [x] 1.2 建立 spec003 文档和阶段切片
  - 状态：DONE
  - 这一步到底做什么：把本轮目标固定为 native control plane，而不是失控重写全部后端。
  - 完成标准：`README.md`、`requirements.md`、`design.md`、`tasks.md` 建立完成并写清本轮 vertical slice。
  - 本次完成结果：已创建 `spec003-X-File-Native-Library-Engine-Rust-收口` 全套 spec 文档，并明确本轮最小切片为 `Rust watcher + Tauri commands + native health/snapshot/refresh bridge`，不尝试一口气重写 `indexer/sqlite/export`。

## 阶段 2：落第一条 native vertical slice

- [x] 2.1 建立 Rust native library state 与 watcher 宿主
  - 状态：DONE
  - 这一步到底做什么：让 watcher 生命周期和健康状态从假实现变成 Rust 真实宿主。
  - 完成标准：
    1. Rust 有独立 `NativeLibraryState`
    2. 可启动、停止、查询 watcher
    3. watcher 变更可调度 refresh
  - 本次完成结果：已在 `apps/desktop/src-tauri/src/lib.rs` 引入 `NativeLibraryState` 和 `notify` watcher，新增 `get_native_library_engine_state`、`start_native_library_watcher`、`stop_native_library_watcher`、`native_request_library_refresh`、`native_get_library_snapshot`、`native_fetch_library_health`；桌面壳现在可以原生托管 watcher 生命周期，并通过现有 Node HTTP 刷新接口调度索引。

- [x] 2.2 建立 Tauri native bridge 并接入前端本地模式
  - 状态：DONE
  - 这一步到底做什么：让本地桌面模式下的 `health / snapshot / refresh` 优先走 native bridge。
  - 完成标准：
    1. 前端有 bridge 封装
    2. 桌面本地模式优先走 bridge
    3. web / mirror 模式保持 HTTP fallback
  - 本次完成结果：已新增 `apps/web/src/runtime/native-library-bridge.ts`；`apps/web/src/api/health.ts` 和 `apps/web/src/features/library/useLibraryState.ts` 在桌面 `local` 模式优先走 native bridge，且绑定资料库后会自动尝试启动 native watcher，`refresh` 优先走 native bridge，失败时回退 HTTP。后续补充中，`native_get_library_snapshot` 已不再简单转发 `/api/library/snapshot`，而是由 Rust 直接读取 `~/.x-file/library-binding.json`、`library-favorites.json`、`<rootDir>/.ai-index/runtime-status.json` 与 `exports/manifest.json` 等本地文件组装 snapshot。

## 阶段 3：验证与下一刀边界

- [ ] 3.1 执行测试、typecheck 和桌面打包验证
  - 状态：DONE
  - 完成标准：给出真实命令与真实结果，不搞“理论可行”
  - 本次完成结果：已通过 `cargo check`（`apps/desktop/src-tauri`）、`pnpm --filter @x-file/web typecheck`、`node scripts/verify-desktop.mjs --platform macos --mode preflight`，以及 `pnpm --filter @x-file/server test -- --runInBand apps/server/src/routes/assistant-routes.test.ts` 对当前 server 测试集的回归验证；本轮新增的 dev-only native 命中面板、health transport 调试面板、Rust watcher / preview / refresh 日志，以及 Office 本地替代预览路径也已编译通过。本轮未执行完整桌面产物构建，因此当前验证结论是“native bridge + Rust 宿主编译通过，桌面打包前置检查通过”，不是“已产出新的正式安装包”。
  - 后续补充：继续切 `listDocuments / listFiles / preview` 后，再次通过 `cargo check`、`pnpm --filter @x-file/web typecheck` 和 `node scripts/verify-desktop.mjs --platform macos --mode preflight`；server 测试这轮未继续作为 preview 收口的阻塞项处理，当前已知独立问题仍是 `apps/server/src/plugins/plugin-runtime-installer.ts` 在 `npm-runtime` case 里触发 `ERR_FS_CP_EINVAL`（把目录复制到自己的子目录）。

- [ ] 3.2 回写本轮 native 化范围、保留 Node 范围和下一刀建议
  - 状态：DONE
  - 完成标准：明确列出已 native 化链路、仍保留 Node 链路、资源与依赖链变化
  - 本次完成结果：本轮已 native 化 `watcher 生命周期`、`watcher 触发 refresh 调度`、`desktop local 模式下的 health bridge`、`snapshot` 的本地读取与组装、`listDocuments / listFiles` 的本地读取，以及 `preview` 的大部分本地读取（`text / markdown / html / image / pdf`）；新增了仅 `dev` 显示的 native/http 命中调试面板，并把顶层 health 检查的 transport 也显式化，同时在 Rust 侧补了 watcher / refresh / preview 的命中日志。`Office preview` 这轮已经继续收口：Rust 现在会直接生成 OnlyOffice `editorConfig`，并启动一个最小本地 HTTP bridge 承接 `GET /api/library/preview-file/:token/*` 和 `POST /api/office/onlyoffice/callback/:token`，前端 Office 分支已可以从 Node `/api/library/preview` 切到 Rust 侧返回的 payload。仍保留 Node 的部分是 `x-file-library-engine` 宿主、OnlyOffice 在线编辑器本体、`indexer`、`sqlite`、`export` 和随包 `x-file-runtime`；依赖链变化是桌面壳新增 Rust `tiny_http + reqwest + hmac + jwt + base64 + mime_guess`，并开始直接读取 `~/.x-file/*`、`.ai-index/exports/*` 和本地文件内容，`tauri.conf.json` 及打包链目前仍保留 `x-file-library-engine + x-file-runtime` 资源准备。下一刀最值钱的点是继续把 Node-only 的 Office 协调面彻底收掉，随后再切 `indexer/sqlite/export` 里的 runtime 依赖。
