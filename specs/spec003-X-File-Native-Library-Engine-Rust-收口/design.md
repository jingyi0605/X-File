# 设计文档 - spec003-X-File-Native-Library-Engine-Rust-收口

状态：Draft

## 1. 概述

### 1.1 本轮核心判断

✅ 值得做：当前 `105M` 的 `x-file-runtime` 就是正式包下一刀的主目标，而现有实现里最容易先切出来的不是 `indexer/sqlite/export` 数据面，而是 `watcher + refresh 调度 + health 聚合` 这条控制面。

### 1.2 当前真实边界

- Tauri Rust 壳当前通过 `BackendProcessManager` 拉起随包 Node。
- 启动命令优先指向 `resources/x-file-runtime/.../node`。
- 入口优先指向 `resources/x-file-library-engine/dist/main.js`。
- `packages/library-engine` 仍是 Node/Fastify 进程。
- `indexer + sqlite + export` 仍由 `@x-file/indexer` 和现有 Node 依赖承担。
- `watcher` 代码存在于 `apps/server/src/library/watch-service.ts`，但当前并没有真正接入 `library-engine` 宿主。
- `/api/engine/health` 当前把 `watcherReady/indexerReady/sqliteReady/exportReady` 全部硬编码成 `true`，这是假状态。

### 1.3 迁移原则

1. 不碰 assistant / CLI 边界。
2. 不把通用后端重新塞回主包。
3. 先迁控制面，再迁重数据面。
4. 前端优先通过统一 bridge 读状态，HTTP 保留为 fallback。

## 2. 本轮切片

### 2.1 选择

本轮最小可落地切片：

- Rust native `LibraryNativeState`
- Rust watcher 宿主
- Tauri commands：
  - `get_native_library_engine_state`
  - `start_native_library_watcher`
  - `stop_native_library_watcher`
  - `native_request_library_refresh`
  - `native_get_library_snapshot`
- 前端本地模式下优先走 native bridge 读取 `health/snapshot`，并通过 native bridge 触发 `refresh`

### 2.2 为什么先切这一刀

- `watcher` 现在本来就没真正挂起来，先迁它不会破坏现有稳定数据面。
- `refresh` 本身仍可复用现有 HTTP `/api/library/refresh`，所以 Rust 只需要做调度和状态聚合，不需要重写索引执行器。
- 这能把“控制谁在看目录、谁在发 refresh、健康状态到底是不是真的”先收回来。

## 3. 架构

### 3.1 本轮结构

```text
Tauri Rust Host
├── BackendProcessManager
├── NativeLibraryState
│   ├── currentRootDir
│   ├── watcher status
│   ├── last refresh request
│   └── last native error
├── file watcher
└── Tauri commands
    ├── native_get_library_snapshot -> HTTP snapshot + native watcher state merge
    ├── native_request_library_refresh -> HTTP refresh + native bookkeeping
    ├── start_native_library_watcher
    ├── stop_native_library_watcher
    └── get_native_library_engine_state

Node Library Engine
├── snapshot / documents / files / preview / export
├── refresh index execution
└── indexer + sqlite + export
```

### 3.2 状态归属

- `snapshot` 数据源短期仍是 Node engine HTTP
- `refresh` 执行器短期仍是 Node engine
- `watcher` 生命周期与健康状态本轮迁到 Rust
- `engine health` 本轮改为真实聚合：Node backend 进程状态 + native watcher 状态

## 4. 迁移边界

### 4.1 本轮已 native 化目标

- watcher 宿主
- watcher 健康状态
- refresh 调度入口
- snapshot 聚合入口

### 4.2 本轮继续保留 Node 的部分

- Fastify 路由主体
- LibraryService / ExportReader
- runLibraryIndexOnce
- better-sqlite3
- export 生成

### 4.3 下一刀建议

下一刀最值钱的是把 `snapshot/list/read` 从 HTTP Fastify 进一步收口：

1. 先把 `snapshot` DTO 组装迁到 Rust 或本地 sidecar
2. 再评估 `sqlite/export reader` 是否可直接改成 Rust 读 `.ai-index` 导出物
3. 最后再决定是否彻底替换 Node index execution

## 5. 风险

- Rust watcher 需要跨平台兼容，首版应接受能力最小化，先保证目录监听和 refresh 调度成立。
- 前端 native bridge 必须保留 HTTP fallback，避免破坏 web/mirror 模式。
- 如果直接在 Rust 实现完整 snapshot 读取，会把复杂度推爆，所以本轮只做聚合，不做重写。
