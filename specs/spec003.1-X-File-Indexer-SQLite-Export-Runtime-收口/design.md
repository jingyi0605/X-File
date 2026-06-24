# 设计文档 - spec003.1-X-File-Indexer-SQLite-Export-Runtime-收口

状态：Draft

## 1. 概述

### 1.1 本轮核心判断

✅ 值得做：从“去掉完整 Node runtime / 砍掉正式包里 `x-file-runtime` 105M”这个目标看，`indexer / sqlite / export` 才是真正核心。

`spec003` 已经把前台控制面和读链路开始收回来，但那一刀解决的是“谁在协调”，不是“谁在干重活”。

真正拖着 Node runtime 的是这条链：

```text
LibraryIndexService
  -> loadRunLibraryIndexOnce()
  -> @x-file/indexer/runLibraryIndexOnce()
      -> loadRuntimeConfig()
      -> initCatalog()
          -> better-sqlite3
      -> TextIndexer.index()
      -> ExportBuilder.build()
      -> 写 runtime-status.json / .ai-index/exports/*
```

### 1.2 当前真实边界

- `apps/server/src/library/index-service.ts`
  - 只是任务排队、状态推进、dirty 标记和 `runtime-status.json` 的写入入口
- `packages/indexer/src/library-index-tool.ts`
  - 才是真正的“加载配置 -> 初始化 SQLite -> 文本索引 -> 导出快照”主执行器
- `packages/indexer/src/sqlite/open-database.ts`
  - 明确绑定 `better-sqlite3`
- `packages/indexer/src/services/export/export-builder.ts`
  - 直接写 `.ai-index/exports/manifest.json`、meta/detail/tag/search shards
- `apps/server/src/storage/library-export-reader.ts`
  - 前台现在消费的是导出产物，不是直接查 SQLite
- `packages/library-engine/src/health.ts`
  - `indexerReady/sqliteReady/exportReady` 仍是假状态
- `apps/desktop/src-tauri/tauri.conf.json`
  - 打包前仍必须 build `@x-file/indexer`
- `scripts/archive/20260616/prepare-bundled-server.mjs`
  - 仍把 `library-engine` 和 Node runtime 一起部署到 resources

### 1.4 当前打包资源入口

- `apps/desktop/src-tauri/tauri.conf.json`
  - 当前仍把 `resources/x-file-library-engine` 与 `resources/x-file-runtime` 一起映射进正式包
- `apps/desktop/src-tauri/src/lib.rs`
  - 当前仍会从 `x-file-runtime/**` 下查找 Node 可执行文件
  - 当前仍会从 `x-file-library-engine/node_modules/@x-file/server/dist/library/*.js` 查找 worker 入口
- `scripts/archive/20260616/prepare-bundled-server.mjs`
  - 当前仍负责把 `@x-file/library-engine`、`better-sqlite3.node`、Node runtime 和内置插件一起塞进桌面 resources

这说明现在的正式包资源边界还没有彻底收口：

1. Node 可执行文件仍独立随包
2. worker 入口仍依赖 `x-file-library-engine/node_modules/@x-file/server`
3. `better-sqlite3.node` 仍通过 deploy 进 `x-file-library-engine`

### 1.3 迁移原则

1. 不破坏现有导出产物契约
2. 先切 orchestration 和宿主边界，再决定是否重写算法
3. 能让 Rust 控任务，就不要继续让 Node 既当宿主又当 worker
4. 前台继续消费稳定的 `.ai-index/exports/*`

## 2. 本轮切片

### 2.1 选择

本轮最小可落地切片：

- 先把 `index/export` 的宿主边界和状态推进边界抽清
- 让桌面 Rust 宿主可以显式驱动一次“索引 worker 执行”
- Node 暂时退化为更窄的 worker 承担 `runLibraryIndexOnce`
- 保留现有导出结构与前台消费契约

### 2.2 为什么先切这一刀

- `LibraryIndexService` 本来就偏 orchestration，最适合先从 Node HTTP 面里拿出来
- 前台已经开始直接读 `.ai-index/exports/*`，说明“产物消费”边界已经稳定
- 真正难的是 `better-sqlite3 + TextIndexer`，先不要一头撞进去
- 先把“Node 是整个宿主”收缩成“Node 只是局部 worker”，才有机会后续继续砍 runtime

## 3. 架构

### 3.1 当前结构

```text
Tauri Rust Host
  -> HTTP /api/library/refresh
     -> LibraryIndexService (Node)
        -> TaskManager (Node)
        -> runLibraryIndexOnce (Node)
           -> better-sqlite3
           -> TextIndexer
           -> ExportBuilder

Frontend
  -> snapshot/documents/files/preview mostly already read local exports
```

### 3.2 目标结构（当前已落地切片）

```text
Tauri Rust Host
  -> native refresh/index orchestration
  -> native runtime-status observation
  -> native worker/native executor boundary
      -> Node Index Worker (temporary default)
          -> index-only
              -> initCatalog
              -> SQLite
              -> TextIndexer
      -> Rust Native Index Executor (fallback vertical slice)
          -> index-only
              -> scan light text/csv files
              -> write export-catalog-snapshot.json
      -> Rust Native Export Executor
          -> export-only
              -> read export-catalog-snapshot.json
              -> write manifest/meta/detail/tag/relation/search

Frontend
  -> continue reading local exports/runtime-status
```

### 3.3 模块职责

| 模块 | 职责 | 输入 | 输出 |
| --- | --- | --- | --- |
| `Desktop Rust Host` | 控制索引触发、观察状态、收口宿主边界，并负责把 full refresh 拆成 `index-only -> export-only` | `rootDir`、refresh reason、binding | worker 启动、runtime 状态、日志 |
| `Node Index Worker` | 临时承担一次默认 `index-only` 执行；不再接受 `full` 或 `export-only` | rootDir、allowedExtensions、reason | SQLite 更新、dirtyScope |
| `Rust Native Index Executor` | 仅在 runtime 缺失/省略时兜底承担一次 `index-only` vertical slice；当前只覆盖轻量文本/CSV | rootDir、allowedExtensions、reason | export catalog snapshot、最小 dirtyScope |
| `Rust Native Export Executor` | 桌面主链直接承担一次 `export-only` 执行；读取 snapshot 并生成既有 exports 契约 | rootDir、reason、dirtyScope、snapshot | exports 产物 |
| `LibraryExportReader / Rust local reader` | 消费稳定导出产物 | `.ai-index/exports/*` | snapshot/documents/files |

## 4. 迁移边界

### 4.1 本轮优先 native 化目标

- index/export 调度入口
- runtime-status 观察与推进入口
- Node worker 启停边界
- full refresh 的宿主 orchestration

### 4.2 本轮继续保留 Node 的部分

- `better-sqlite3`
- `TextIndexer`
- `ExportBuilder`
- worker 内部的实际数据面执行

但 `ExportBuilder` 的下一步切口已经明确：先把它对 `CatalogRepository / SQLite` 的直接读取依赖抽成独立 data source 接口，再决定是否把 export 执行体挪出 Node。

当前进展已经更进一步：`index-only` 阶段会落一个 `runtime/export-catalog-snapshot.json`，`export-only` 现在默认显式走 snapshot data source。也就是说，export 阶段已经存在一个“不直读 SQLite 也能跑”的可运行主路径。

`SearchIndexBuilder` 这一侧也继续收紧了读取边界：搜索桶构建本体已经只消费 `ExportCatalogDataSource`，而默认读取入口也收敛到 `createExportCatalogDataSource(...)`，不再在 search/export 实现体里直接写 SQLite data source 构造器。

当前打包资源边界也已经盘清并开始收口：

- `tauri.conf.json` 正式 resources 只声明 `x-file-library-engine`、`x-file-runtime`、`x-file-plugins`
- `prepare-bundled-server.mjs` 会额外生成 `resources/x-file-resource-boundary.json`
- Rust 宿主的后端入口候选和 worker 入口候选都已收敛成单点函数
- `x-file-server/*` 仍存在于 Rust 的兼容候选里，但只作为历史资源目录 fallback，不再是正式包主路径

本轮又把这个主路径收紧了一层：

1. `export-only` 默认要求 `dirtyScope`，不再接受“空 payload 也试着跑一下”的模糊语义
2. worker 返回值会显式带回 `exportDataSourceMode=snapshot`、`exportCatalogSnapshotPath`、`dirtyScopeSummary`
3. 当 snapshot 缺失时，主链直接报错提示“先执行 index-only”；`sqlite` 只保留为显式调试/应急模式，不做静默 fallback
4. `runLibraryExportOnce()` 现在会显式返回 `requestedDataSourceMode` 与 `resolvedDataSourceMode`；正式主链默认写死 `snapshot`，只有显式传入 `auto/sqlite` 才可能命中 SQLite 应急路径

### 4.3 下一刀建议

下一刀最值钱的顺序不是瞎猜，而是：

1. 先把 worker 侧 `full` 兼容入口彻底降成非主路径，必要时直接删除
2. 再评估 `sqlite` 能否替换 `better-sqlite3`
3. 最后再碰全文索引算法本体

当前进展已经完成第 1 步：`full` 现在只属于 Rust 宿主语义。

当前进展又进一步收口了一层：

1. 轻量扩展名集合（text/markdown/html/json/yaml/tsv/csv）默认 `index-only` 已优先走 Rust 原生执行，并会保留旧 snapshot 中的复杂文档记录
2. 复杂格式集合与完整 SQLite/TextIndexer 主链仍由 Node worker 承担
3. 当 `x-file-runtime` 缺失或已声明可省略时，桌面宿主仍可退到 Rust 原生 `index-only(native) -> export-only(native)` vertical slice
4. 桌面主链里的 `export-only` 已改成 Rust 原生执行，不再必须拉起 `library-export-worker.js`
5. `apps/server/src/library/library-export-worker.ts` 仍保留给 Node 侧测试/兼容路径，但已经不再参与桌面资源边界判断

fallback 线也已经从“第二套导出格式”收回到统一导出管线：

- `fallback-export-builder` 现在只负责把扫描结果整理成最小 `ExportCatalogDataSource`
- 真正的 `manifest / meta / detail / tag / relation / search` 仍然全部由正式 `ExportBuilder` 产出
- 为了保持数据自洽，fallback 已明确是“应急全量导出”，不再承诺 `targetPath` 局部导出语义
- 这样做的目的不是偷懒，而是把特殊分支压到最小，避免再维护一套会漂的格式契约

SQLite 替换切口这轮也已经开始落地，而不是继续停留在口头层：

- `open-database.ts` 已抽出 `LibraryIndexerDatabaseDriver`
- 默认 driver 仍然是 `better-sqlite3`，所以现有行为和产物契约不变
- `initCatalog` / `runCatalogMigrations` / `TextIndexer` / `CatalogRepository` / `CatalogWriteRepository` / `ParserSkipRepository` 已接入可注入 driver
- `open-database.ts` 现在已经落下第二个实验样本 `nodeSqliteDatabaseDriver`，证明最小 SQLite 契约可以承载第二实现；但 `openDatabase()` 仍固定返回 `better-sqlite3`，不让实验路径污染正式主链
- 实验链已经继续向上贯通：worker payload 现在可以显式传 `sqliteDriver: "node:sqlite"`，并在 Node 侧测试链里跑通；桌面正式主链现在只剩默认 `index-only` 仍经由该 worker 路径

这一步的价值不是“已经换掉 SQLite 后端”，而是先把最硬的构造耦合拆掉。后续如果要验证 `node:sqlite`、Rust bridge、或别的 SQLite backend，不需要再从每个 repository 的 `openDatabase()` 调用点往回撕。

再往后一刀，优先级已经很清楚：

1. 继续删除 `x-file-server/*` 历史兼容路径
2. 评估 `x-file-library-engine` 里哪些 HTTP 服务还能从主包再拆小
3. 在不破坏现有 `index-only` 执行面的前提下，再决定是否能进一步缩 `x-file-runtime`

## 5. 风险

- 如果直接重写 `TextIndexer`，复杂度会爆炸
- 如果破坏 `manifest/meta shard/taxonomy/bootstrap` 契约，前台会立刻回归
- 如果宿主和 worker 边界没定义清楚，只会得到“两边都负责一点”的垃圾结构

## 6. 并行迁移策略

为了避免继续串行慢吞吞推进，本阶段后续执行默认拆成三条可并行的独立线：

1. 打包资源边界线
   - 目标：压清 `x-file-runtime`、`x-file-library-engine`、`x-file-plugins` 的正式包入口和保留理由
2. export 主路径线
   - 目标：把 `export-only` 继续固定到 snapshot 主路径，减少对 SQLite 直读的依赖
3. sqlite 替换切口线
   - 目标：把 `better-sqlite3` 访问面继续抽象，给后续 driver 替换留下真实切口

这三条线的写集应尽量分离：

- 打包资源线：`apps/desktop/src-tauri/**`、`scripts/**`、spec 文档
- export 主路径线：`apps/server/src/library/**`、`packages/indexer/src/services/export/**`、spec 文档
- sqlite 切口线：`packages/indexer/src/sqlite/**`、`packages/indexer/src/repositories/**`、`packages/indexer/src/services/indexer/**`、spec 文档

## 7. 最终判断

### 7.1 本阶段最终技术决定

本阶段正式决定：

1. 暂时保留最小 Node worker / sidecar 方案
2. 停止继续为“宿主边界”做额外切分
3. 下一阶段主目标切换为“替换执行体”，而不是继续挤 HTTP 壳和 Rust orchestration

这里的“执行体”指：

- `TextIndexer`
- SQLite 默认 store / `better-sqlite3`
- `ExportBuilder`
- `SearchIndexBuilder`

### 7.2 为什么现在不该继续硬删 `x-file-runtime`

当前资源实测已经足够说明问题：

  - `x-file-runtime` 当前目录里几乎只剩 `node/bin/node`，但体积仍约 `105M`
- `x-file-library-engine` 已降到约 `26M`
- `x-file-library-engine` 里仍承载：
  - `dist/main.js`
  - `@x-file/server/dist/library/*.js` worker 入口
  - `better_sqlite3.node`

这说明现在的体积主因已经不是“目录里还有很多脏文件”，而是：

1. Node 二进制本体仍然必须存在
2. 默认正式主链里的 `index-only / TextIndexer / parser / SQLite` 执行体仍然运行在 Node

继续在这个阶段强删 runtime，只会得到两种坏结果：

1. 把当前可运行的 worker 链路打碎，但执行体并没有迁走
2. 换一个名字再塞进另一个同样大的 helper / sidecar

这两种都没有工程价值。

### 7.3 当前最务实的边界

所以当前最务实、也最可交接的边界是：

- Rust / Tauri 继续承担宿主、状态推进和 worker orchestration
- Node 继续承担最小数据面 worker 与必要 HTTP 服务面
- Node 留下来的职责明确限定为：
  - 启动 `x-file-library-engine`
  - 承接复杂格式与完整 SQLite/TextIndexer 的 `index-only` worker
  - 提供 OnlyOffice / plugin / assistant / integration 等 HTTP 服务

### 7.4 下一阶段接手入口

下一阶段如果继续追 `x-file-runtime 105M`，不该再从宿主边界下刀，而应该按这个顺序推进：

1. 替换 SQLite 默认 store / `better-sqlite3`
2. 继续拆 `TextIndexer` 执行体，减少对 Node runtime API 的隐式依赖
3. 让 `ExportBuilder / SearchIndexBuilder` 脱离 Node-only 执行环境
4. 等执行体真的迁走后，再删除 `x-file-runtime`
