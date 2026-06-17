# 任务清单 - spec003.1-X-File-Indexer-SQLite-Export-Runtime-收口（人话版）

状态：In Progress

## 当前阶段：删 Node 六条硬阻塞总攻

- [x] A. `TextIndexTagStore` 补齐 manual binding / identity migration / legacy fallback 完整语义
  - 已完成：默认成功路径的 `manual binding / identity migration / carry-forward / syncManualResolvedTags / legacy fallback` 已迁入独立 `TextIndexTagStore`，不再依赖旧仓库这批语义。
- [x] B. `ParserSkipRepository` 从默认 index-only 主写链彻底独立
  - 已完成：默认主写链已改走独立 `parser-skip-store.ts`，`text-index-catalog-store.ts` 不再直接 `new ParserSkipRepository`。
- [ ] C. `DocumentParser` / parser-router 从默认执行体里抽成宿主无关接口，桌面主链优先 native
- [ ] D. 默认 SQLite 宿主不再依赖 Node runtime
- [ ] E. 桌面 Rust 宿主去掉 Node worker fallback 默认依赖
- [ ] F. `apps/server` Node sidecar 从正式包必须宿主继续剥离，并同步更新资源边界/验包

## 阶段 1：先把数据面真实边界盘死

- [x] 1.1 盘清 `indexer / sqlite / export` 的真实宿主和调用链
  - 状态：DONE
  - 这一步到底做什么：把真正拖着 `x-file-runtime` 的链路从调度层里剥出来，别再把所有东西都叫“library-engine”。
  - 做完你能看到什么：知道谁只是排队，谁真的在干活，谁在写 SQLite，谁在写导出产物。
  - 先依赖什么：无
  - 开始前先看：
    - `spec003-X-File-Native-Library-Engine-Rust-收口/design.md`
    - `apps/server/src/library/index-service.ts`
    - `packages/indexer/src/library-index-tool.ts`
    - `packages/indexer/src/sqlite/open-database.ts`
    - `packages/indexer/src/services/export/export-builder.ts`
  - 主要改哪里：
    - `specs/spec003.1-X-File-Indexer-SQLite-Export-Runtime-收口/*.md`
  - 这一步先不做什么：先不重写算法，也不先碰前端。
  - 怎么算完成：
    1. 已明确 `LibraryIndexService` 只是 orchestration
    2. 已明确真正执行层是 `runLibraryIndexOnce -> better-sqlite3 -> TextIndexer -> ExportBuilder`
    3. 已明确前台读链主要消费 `.ai-index/exports/*`
  - 怎么验证：
    - 人工走查代码与文档

- [x] 1.2 建立 `spec003.1` 文档并写清本轮切片
  - 状态：DONE
  - 这一步到底做什么：把新阶段目标固定成“数据面收口”，避免继续在 preview/前台控制面上兜圈子。
  - 做完你能看到什么：`README.md`、`requirements.md`、`design.md`、`tasks.md` 都建立完成，而且目标明确指向 `indexer / sqlite / export`。
  - 先依赖什么：1.1
  - 开始前先看：
    - `specs/000-Spec规范/Spec模板/*`
    - `specs/spec003-X-File-Native-Library-Engine-Rust-收口/*`
  - 主要改哪里：
    - `specs/spec003.1-X-File-Indexer-SQLite-Export-Runtime-收口/*.md`
  - 这一步先不做什么：先不宣称已经去掉 Node runtime。
  - 怎么算完成：
    1. 新 spec 已建立
    2. 当前边界、迁移原则、切片顺序都已经写清楚
  - 怎么验证：
    - 人工检查 spec 文档

### 阶段检查

- [x] 1.3 阶段检查：真正核心问题已经对准
  - 状态：DONE
  - 这一步到底做什么：确认 `spec003.1` 的焦点已经从“前台 preview/bridge”转到“Node runtime 真正赖以存在的数据面”。
  - 做完你能看到什么：后续实现可以直接围着 `index/export/sqlite` 打，不再偏题。
  - 先依赖什么：1.1、1.2
  - 开始前先看：
    - `requirements.md`
    - `design.md`
    - `tasks.md`
  - 主要改哪里：当前 Spec 全部文件
  - 这一步先不做什么：不扩新需求，不加 UI。
  - 怎么算完成：
    1. `x-file-runtime` 的保留原因已被缩小到数据面
    2. 下一阶段可以直接开始代码切片
  - 怎么验证：
    - 人工走查

## 阶段 2：落第一条数据面收口切片

- [x] 2.1 先把 index/export 调度入口从 Node HTTP 面里抽出来
  - 状态：DONE
  - 这一步到底做什么：优先切 orchestration，让 Rust/Tauri 能显式驱动一次 index/export worker，而不是只能打 `/api/library/refresh`。
  - 做完你能看到什么：索引触发和状态推进的主控权开始从 Node 宿主转移到桌面宿主。
  - 先依赖什么：1.3
  - 开始前先看：
    - `apps/server/src/library/index-service.ts`
    - `apps/desktop/src-tauri/src/lib.rs`
    - `packages/indexer/src/library-index-tool.ts`
  - 主要改哪里：
    - `apps/desktop/src-tauri/src/lib.rs`
    - `apps/web/src/runtime/native-library-bridge.ts`
    - 可能新增最小 worker 入口文件
  - 这一步先不做什么：先不重写 `better-sqlite3`，先不改全文索引算法。
  - 怎么算完成：
    1. 桌面宿主可以直接发起一次 index/export worker 执行
    2. 不再必须依赖 Node HTTP `/api/library/refresh` 作为唯一入口
  - 怎么验证：
    - `cargo check`
    - 最小 typecheck / 预检
  - 本轮落地记录：
    - 已新增 `apps/server/src/library/library-index-worker.ts`，把一次 `runLibraryIndexOnce` 执行收成最小 Node worker。
    - 已把 `apps/desktop/src-tauri/src/lib.rs` 的 native refresh 从 HTTP `/api/library/refresh` 改为桌面宿主直接拉起 Node worker。
    - native watcher 与 OnlyOffice callback 后续 refresh 也已切到同一条 worker 链，不再把 `/api/library/refresh` 当唯一入口。

- [x] 2.2 缩小 Node 到临时 worker 边界，并回写状态链路
  - 状态：DONE
  - 这一步到底做什么：让 Node 只负责 `runLibraryIndexOnce` 这段临时 worker 任务，而不是继续当全局宿主。
  - 做完你能看到什么：Node 的职责更窄，后续替换 `sqlite/export` 时不用再连着 HTTP 宿主一起动。
  - 先依赖什么：2.1
  - 开始前先看：
    - `packages/indexer/src/library-index-tool.ts`
    - `apps/server/src/storage/library-runtime-status-store.ts`
    - `apps/server/src/storage/library-export-reader.ts`
  - 主要改哪里：
    - index worker 入口
    - runtime-status 推进链
    - 相关验证文档
  - 这一步先不做什么：先不要求正式包已经完全去掉 `x-file-runtime`。
  - 怎么算完成：
    1. Node worker 边界清晰
    2. `runtime-status.json` 与导出产物契约保持稳定
  - 怎么验证：
    - 相关测试
    - `cargo check`
    - `pnpm --filter @x-file/web typecheck`
  - 本轮落地记录：
    - Node 现在只保留为一次性 index/export worker，负责 `runLibraryIndexOnce -> better-sqlite3 -> TextIndexer -> ExportBuilder`。
    - `runtime-status.json` 继续由 worker 写入 queued/running/cooldown/failed 状态，前台 snapshot/documents/files 继续消费现有 `.ai-index/exports/*`。
    - 导出产物契约未改：`manifest.json`、meta/detail/tag/search/taxonomy/bootstrap 结构保持原样。

### 阶段检查

- [x] 2.3 阶段检查：Node 已经从“宿主”收缩成“worker”
  - 状态：DONE
  - 这一步到底做什么：确认这轮不是“又加了一层胶水”，而是真的把 Node 的宿主边界往里压了。
  - 做完你能看到什么：后续要切 `export/sqlite` 时，目标模块更小、更稳。
  - 先依赖什么：2.1、2.2
  - 开始前先看：
    - `requirements.md`
    - `design.md`
    - `tasks.md`
  - 主要改哪里：本阶段全部相关文件
  - 这一步先不做什么：不再扩新范围。
  - 怎么算完成：
    1. index/export 触发链已不再完全依赖 Node HTTP 宿主
    2. 已清楚写明仍保留 Node 的局部原因
  - 怎么验证：
    - 人工走查
    - 关键命令验证
  - 本轮检查结果：
    - native refresh / watcher / onlyoffice callback 后续刷新已不再依赖 `/api/library/refresh`。
    - Node 仍保留给 `better-sqlite3 + TextIndexer + ExportBuilder + runLibraryIndexOnce` 这条一次性 worker 数据面。

## 阶段 3：验证、资源边界和下一刀

- [x] 3.1 执行测试、typecheck 和桌面预检
  - 状态：DONE
  - 这一步到底做什么：给出真实结果，不再说“理论上 Node 已经更少了”。
  - 做完你能看到什么：知道代码、类型、桌面预检有没有真过。
  - 先依赖什么：2.3
  - 开始前先看：
    - `requirements.md`
    - `design.md`
  - 主要改哪里：验证记录与必要修正
  - 这一步先不做什么：不额外加功能。
  - 怎么算完成：
    1. 关键命令实际运行
    2. 结果已回写
  - 怎么验证：
    - `cargo check`
    - `pnpm --filter @x-file/web typecheck`
    - `node scripts/verify-desktop.mjs --platform macos --mode preflight`
  - 本轮真实结果：
    - `pnpm --filter @x-file/server typecheck`：通过
    - `cargo check`：通过；仅有 `http_post_json` 未使用 warning
    - `node scripts/verify-desktop.mjs --platform macos --mode preflight`：通过
    - `pnpm --filter @x-file/web typecheck`：失败，但失败点在 `apps/web/src/features/settings/SettingsPage.tsx` 的既有 `isBundledPlugin` 未定义，与本轮 index/export 收口改动无关

- [x] 3.2 最终检查：数据面收口边界已清楚
  - 状态：DONE
  - 这一步到底做什么：确认哪些东西已经脱离完整 Node 宿主，哪些还没动，下一刀该切哪里。
  - 做完你能看到什么：后续接手的人不用再重做依赖盘点。
  - 先依赖什么：3.1
  - 开始前先看：
    - `requirements.md`
    - `design.md`
    - `tasks.md`
  - 主要改哪里：当前 Spec 全部文件
  - 这一步先不做什么：不再追加新需求。
  - 怎么算完成：
    1. 已 native / 已收口 / 仍保留 Node 三类边界清楚
    2. 包资源和依赖链变化清楚
    3. 下一刀目标明确
  - 怎么验证：
    - 按 Spec 验收逐项核对
  - 本轮追加进展：
    - `packages/indexer/src/library-index-tool.ts` 已拆出 `prepareLibraryIndexRuntime`、`runLibraryTextIndex`、`runLibraryExportOnce` 三段可复用入口。
    - `apps/server/src/library/library-index-worker.ts` 现在只接受 `index-only`；`apps/server/src/library/library-export-worker.ts` 单独承接 `export-only`。
    - `export` 现在已经不是 worker 里的内联尾巴，而是可独立调用的执行入口。
  - 本轮最终检查结果：
    - 已 native / 已收口：桌面宿主直接驱动 worker，refresh / watcher / onlyoffice callback 不再依赖 Node HTTP 宿主。
    - 已进一步收口：`export` 已经能独立执行；桌面宿主默认 full refresh 已改成 `index-only -> export-only` 两段调度，worker 侧 `full` 已彻底下线，`export-only` 也已从 index worker 中拆成独立 worker 入口。
    - 仍保留 Node：`better-sqlite3`、`TextIndexer`、`ExportBuilder` 仍在 Node 数据面里；只是 `ExportBuilder` 现在已有单独入口，而且 Rust 已成为 full refresh 的唯一 orchestration 方。
    - 真实验证：
      - `pnpm --filter @x-file/indexer build`：通过
      - `pnpm --filter @x-file/server typecheck`：通过
      - `pnpm --filter @x-file/server build`：通过
      - `cargo check`：通过；仅 `http_post_json` 未使用 warning
      - `pnpm --filter @x-file/web typecheck`：通过
      - `node scripts/verify-desktop.mjs --platform macos --mode preflight`：通过
      - `pnpm --filter @x-file/server test -- --test-name-pattern 'export 可以从 full worker 中拆出并独立执行|索引工具能产出后端可读取的文档库 export|增量索引会返回限定 targetPath 的 dirty scope'`：命令整体因全量 test harness 超时退出，但目标子测试输出均为 `ok`
      - `pnpm --filter @x-file/server test -- --test-name-pattern 'library index worker 支持 index-only 后接 export-only 的两段执行|export 可以从 full worker 中拆出并独立执行'`：命令整体仍因全量 harness 超时退出；其中 `export 可以从 full worker 中拆出并独立执行` 为 `ok`，`library index worker 支持 index-only 后接 export-only 的两段执行` 的独立测试文件已补，但独立用 `node --import tsx --test ...` 运行时受当前 workspace 顶层 `tsx` 解析基线影响，未作为最终通过项计入

- [x] 3.3 worker full 入口下线，full 语义只保留在 Rust 宿主
  - 状态：DONE
  - 这一步到底做什么：把 `full` 从 Node worker 的协议里删掉，避免 worker 再次膨胀成宿主。
  - 做完你能看到什么：Node worker 只接受 `index-only` / `export-only`；任何 `full` 调用都会立即失败，强制 full orchestration 留在桌面 Rust。
  - 先依赖什么：3.2
  - 开始前先看：
    - `apps/server/src/library/library-index-worker.ts`
    - `apps/desktop/src-tauri/src/lib.rs`
    - `specs/spec003.1-X-File-Indexer-SQLite-Export-Runtime-收口/design.md`
  - 主要改哪里：
    - `apps/server/src/library/library-index-worker.ts`
    - `specs/spec003.1-X-File-Indexer-SQLite-Export-Runtime-收口/design.md`
    - `specs/spec003.1-X-File-Indexer-SQLite-Export-Runtime-收口/tasks.md`
  - 这一步先不做什么：不改前端 `mode: "full"` 语义；那仍然是宿主 API，不是 worker API。
  - 怎么算完成：
    1. worker mode 类型不再包含 `full`
    2. 缺失或非法 mode 直接报错
    3. spec 已明确 `full` 只保留在 Rust 宿主
  - 怎么验证：
    - `pnpm --filter @x-file/server typecheck`
    - `pnpm --filter @x-file/server build`

- [x] 3.4 native 轻量 parser 补齐 `.markdown` 与轻量文本类型 tag
  - 状态：DONE
  - 这一步到底做什么：把 Rust native 轻量索引和现有 Node `PlainTextParserAdapter` / 默认扩展名之间最明显的低风险缺口补平，但不去动 `lib.rs` 和 Node parser 本体。
  - 做完你能看到什么：`.markdown` 文件会进入 native 轻量索引；轻量文本摘要继续走原有文本截断逻辑；导出快照里的派生类型标签对 `.markdown` 与 `Markdown` 类型保持一致。
  - 先依赖什么：3.3
  - 开始前先看：
    - `apps/desktop/src-tauri/src/native_index.rs`
    - `packages/indexer/src/parser/plain-text-parser-adapter.ts`
    - `packages/indexer/src/tagging/simple-tag-inference.ts`
  - 主要改哪里：
    - `apps/desktop/src-tauri/src/native_index.rs`
    - `specs/spec003.1-X-File-Indexer-SQLite-Export-Runtime-收口/tasks.md`
  - 这一步先不做什么：
    - 不改 `apps/desktop/src-tauri/src/lib.rs`
    - 不改 Node 侧 parser/router
    - 不改 snapshot/export JSON 契约字段
  - 怎么算完成：
    1. native 轻量索引允许 `.markdown`
    2. `.markdown` 走轻量文本摘要，不落回空摘要
    3. `.markdown` 的派生标签归到 `类型/文本/Markdown`
  - 怎么验证：
    - `cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml`
  - 本轮落地记录：
    - 已把 `.markdown` 补进 Rust native 轻量扩展白名单与通用扫描扩展集合，避免默认扩展里允许、native 轻量索引却跳过。
    - 已把 `.markdown` 接到现有 `read_text_summary` 轻量文本摘要链路，继续复用当前 snapshot/export 契约。
    - 已把 `.markdown` 的派生类型标签对齐为 `类型/文本/Markdown`，和现有 Node `simple-tag-inference` 语义保持一致。

- [x] 3.4 export-only 从 index worker 中拆出独立 worker 入口
  - 状态：DONE
  - 这一步到底做什么：继续压缩 Node worker 边界，让 index 和 export 不再挂在同一个入口脚本下面。
  - 做完你能看到什么：Rust 宿主在 `index-only -> export-only` 两段调度时，会分别拉起 `library-index-worker` 和 `library-export-worker`。
  - 先依赖什么：3.3
  - 开始前先看：
    - `apps/server/src/library/library-index-worker.ts`
    - `apps/desktop/src-tauri/src/lib.rs`
    - `apps/server/src/library/library-index-worker.test.ts`
  - 主要改哪里：
    - `apps/server/src/library/library-worker-support.ts`
    - `apps/server/src/library/library-index-worker.ts`
    - `apps/server/src/library/library-export-worker.ts`
    - `apps/desktop/src-tauri/src/lib.rs`
    - `specs/spec003.1-X-File-Indexer-SQLite-Export-Runtime-收口/design.md`
    - `specs/spec003.1-X-File-Indexer-SQLite-Export-Runtime-收口/tasks.md`
  - 这一步先不做什么：不改导出结构，不改前台读取契约，不碰 TextIndexer 算法本体。
  - 怎么算完成：
    1. index worker 只接受 `index-only`
    2. export worker 只接受 `export-only`
    3. Rust 宿主按 mode 选择对应 worker 入口
  - 怎么验证：
    - `pnpm --filter @x-file/server build`
    - `cargo check`

- [x] 3.5 抽出 export 读边界，为脱离 SQLite/Node 做准备
  - 状态：DONE
  - 这一步到底做什么：先不重写 export 算法，先把 `ExportBuilder` / `SearchIndexBuilder` 依赖的 catalog 读取面抽成独立 data source。
  - 做完你能看到什么：export 侧不再直接把 `new CatalogRepository(...)` 写死在实现里，后续可以替换成别的读取后端。
  - 先依赖什么：3.4
  - 开始前先看：
    - `packages/indexer/src/services/export/export-builder.ts`
    - `packages/indexer/src/services/search/search-index-builder.ts`
    - `packages/indexer/src/repositories/catalog-repository.ts`
  - 主要改哪里：
    - `packages/indexer/src/services/export/export-data-source.ts`
    - `packages/indexer/src/services/export/export-builder.ts`
    - `packages/indexer/src/services/search/search-index-builder.ts`
    - `packages/indexer/src/index.ts`
    - `specs/spec003.1-X-File-Indexer-SQLite-Export-Runtime-收口/design.md`
    - `specs/spec003.1-X-File-Indexer-SQLite-Export-Runtime-收口/tasks.md`
  - 这一步先不做什么：不修改 manifest/meta/tag/search/taxonomy/bootstrap 契约，不替换 SQLite。
  - 怎么算完成：
    1. export 读面接口已独立定义
    2. `ExportBuilder` / `SearchIndexBuilder` 默认仍可用 SQLite data source 运行
    3. 后续迁移不再需要先连着 `CatalogRepository` 一起撕
  - 怎么验证：
    - `pnpm --filter @x-file/indexer build`
    - `pnpm --filter @x-file/server build`

- [x] 3.6 落地 snapshot data source，让 export 可以不直读 SQLite 运行
  - 状态：DONE
  - 这一步到底做什么：让 `index-only` 在完成后写出 export catalog snapshot，再让 `export-only` 优先消费这个 snapshot。
  - 做完你能看到什么：export 阶段已经具备一个不直连 SQLite 的可运行数据源切片。
  - 先依赖什么：3.5
  - 开始前先看：
    - `packages/indexer/src/services/export/export-data-source.ts`
    - `packages/indexer/src/library-index-tool.ts`
    - `apps/server/src/library/library-index-worker.ts`
    - `apps/server/src/library/library-index-e2e.test.ts`
  - 主要改哪里：
    - `packages/indexer/src/services/export/export-data-source.ts`
    - `packages/indexer/src/library-index-tool.ts`
    - `apps/server/src/library/library-index-worker.ts`
    - `apps/server/src/library/library-index-e2e.test.ts`
    - `specs/spec003.1-X-File-Indexer-SQLite-Export-Runtime-收口/design.md`
    - `specs/spec003.1-X-File-Indexer-SQLite-Export-Runtime-收口/tasks.md`
  - 这一步先不做什么：不删除 SQLite catalog；snapshot 目前只覆盖 export 读面，不覆盖 TextIndexer 写面。
  - 怎么算完成：
    1. `index-only` 完成后会刷新 export catalog snapshot
    2. `export-only` 默认优先使用 snapshot data source
    3. 删除 SQLite db 后，export 仍能依赖 snapshot 产出 exports
  - 怎么验证：
    - `pnpm --filter @x-file/indexer build`
    - `pnpm --filter @x-file/server build`
    - `pnpm --filter @x-file/server test -- --test-name-pattern 'export 可以优先消费 index 阶段写出的 catalog snapshot'`

- [x] 3.7 export-only 默认显式走 snapshot 主路径
  - 状态：DONE
  - 这一步到底做什么：把 `export-only` 从“如果有 snapshot 就优先”推进到“协议上显式声明 snapshot 模式”。
  - 做完你能看到什么：桌面宿主触发 export worker 时会把 `exportDataSourceMode=snapshot` 写进 payload，export worker 返回结果里也会带回这个模式。
  - 先依赖什么：3.6
  - 开始前先看：
    - `apps/server/src/library/library-export-worker.ts`
    - `apps/desktop/src-tauri/src/lib.rs`
    - `packages/indexer/src/library-index-tool.ts`
    - `packages/indexer/src/services/export/export-data-source.ts`
  - 主要改哪里：
    - `apps/server/src/library/library-worker-support.ts`
    - `apps/server/src/library/library-export-worker.ts`
    - `apps/desktop/src-tauri/src/lib.rs`
    - `packages/indexer/src/library-index-tool.ts`
    - `packages/indexer/src/services/export/export-data-source.ts`
    - `apps/server/src/library/library-index-worker.test.ts`
    - `specs/spec003.1-X-File-Indexer-SQLite-Export-Runtime-收口/design.md`
    - `specs/spec003.1-X-File-Indexer-SQLite-Export-Runtime-收口/tasks.md`
  - 这一步先不做什么：不删除 SQLite fallback；目前 `auto` / `sqlite` 仍保留给后续回退和调试。
  - 怎么算完成：
    1. payload 支持 `exportDataSourceMode`
    2. export worker 默认使用 `snapshot`
    3. worker 测试可观测到 `snapshot` 模式返回

- [x] 3.8 export snapshot 主路径收尾：补齐返回字段、错误信息和回退语义说明
  - 状态：DONE
  - 这一步到底做什么：把 `export-only` 的 snapshot 主路径从“能跑”收紧成“协议明确、测试可观测、错误可操作”。
  - 做完你能看到什么：worker 输出会明确带回 snapshot 路径和 dirtyScope 摘要；snapshot 缺失时不再静默兜底。
  - 先依赖什么：3.7
  - 开始前先看：
    - `apps/server/src/library/library-export-worker.ts`
    - `apps/server/src/library/library-index-worker.ts`
    - `apps/server/src/library/library-worker-support.ts`
    - `apps/desktop/src-tauri/src/lib.rs`
    - `apps/server/src/library/library-index-worker.test.ts`
    - `apps/server/src/library/library-index-e2e.test.ts`
  - 主要改哪里：
    - `apps/server/src/library/library-export-worker.ts`
    - `apps/server/src/library/library-index-worker.ts`
    - `apps/server/src/library/library-worker-support.ts`
    - `apps/desktop/src-tauri/src/lib.rs`
    - `apps/server/src/library/library-index-worker.test.ts`
    - `apps/server/src/library/library-index-e2e.test.ts`
    - `specs/spec003.1-X-File-Indexer-SQLite-Export-Runtime-收口/design.md`
    - `specs/spec003.1-X-File-Indexer-SQLite-Export-Runtime-收口/tasks.md`
  - 这一步先不做什么：不改前端，不碰 `sqlite/open-database`，不把 `sqlite` 调试/应急模式从代码里彻底删除。
  - 怎么算完成：
    1. `export-only` 缺少 `dirtyScope` 会直接失败并提示先执行 `index-only`
    2. worker 返回包含 `exportCatalogSnapshotPath`、`dirtyScopeSummary`、`exportCatalogSnapshotRequired`
    3. Rust 宿主在 `full -> index-only -> export-only` 链路上会拒绝空 `dirtyScope`
    4. snapshot 缺失时给出明确错误，并说明 `sqlite` 仅保留为显式调试/应急模式
  - 怎么验证：
    - `node --import tsx --test src/library/library-index-worker.test.ts`
    - `pnpm --filter @x-file/server test -- --test-name-pattern 'export 可以优先消费 index 阶段写出的 catalog snapshot|snapshot 主路径缺失时 export-only 会报出明确错误，不做静默 sqlite 回退'`
    - `pnpm --filter @x-file/server build`
    - `cargo check`
  - 怎么验证：
    - `pnpm --filter @x-file/indexer build`
    - `pnpm --filter @x-file/server build`
    - `pnpm --filter @x-file/server typecheck`

## 阶段 4：完整迁移任务清单（总表）

- [x] 4.1 打包资源边界盘清并收口
  - 状态：DONE
  - 这一步到底做什么：把正式包里 `x-file-library-engine`、`x-file-runtime`、`x-file-plugins` 的进入路径、资源映射、宿主查找逻辑全部盘清。
  - 做完你能看到什么：知道哪个目录是为了 Node 宿主，哪个目录只是为了 worker，哪个目录其实可以从主包剥离。
  - 先依赖什么：3.7
  - 开始前先看：
    - `apps/desktop/src-tauri/tauri.conf.json`
    - `apps/desktop/src-tauri/src/lib.rs`
    - `scripts/archive/20260616/prepare-bundled-server.mjs`
    - `scripts/package-desktop.sh`
  - 主要改哪里：
    - 资源映射、打包脚本、spec 文档
  - 怎么算完成：
    1. 已列出 `x-file-library-engine` / `x-file-runtime` / `x-file-plugins` 的真实用途
    2. 已明确哪些资源可后续剥离出主包
    3. 宿主查找路径不再混杂“旧 server / 新 engine / worker”三套历史包袱
    4. 已明确 `better-sqlite3.node` 当前是随哪条资源链进入正式包
  - 怎么验证：
    - `node scripts/verify-desktop.mjs --platform macos --mode preflight`
  - 本次完成结果：
    - 已确认 `tauri.conf.json` 正式 resources 只声明 `x-file-library-engine`、`x-file-runtime`、`x-file-plugins`。
    - 已确认 `prepare-bundled-server.mjs` 仍通过 `pnpm --filter @x-file/library-engine --prod deploy` 把 `better-sqlite3.node` 带进 `x-file-library-engine/node_modules/better-sqlite3/build/Release/better_sqlite3.node`，也就是说原生 SQLite 绑定当前随 `x-file-library-engine` 进入正式包，而不是随 `x-file-runtime` 进入。
    - 已把 Rust 宿主里的后端入口候选收敛到 `bundled_backend_entry_candidates()`，worker 入口候选收敛到 `bundled_worker_entry_candidates()`；`x-file-server/*` 只剩历史兼容 fallback。
    - 已让 `prepare-bundled-server.mjs` 生成 `apps/desktop/src-tauri/resources/x-file-resource-boundary.json`，把资源用途、保留原因、可剥离条件、宿主查找优先级固化成机器可读清单。
    - 已让 `scripts/verify-desktop.mjs` 对 `bundle.resources` 和 `x-file-resource-boundary.json` 做预检，防止主包资源映射回漂。
  - 当前资源结论：
    - `x-file-library-engine`：必须保留。原因不是“名字叫 engine”，而是正式包主入口和 Node worker 入口目前都从这里找，且 `better-sqlite3.node` 也随它进入主包。
    - `x-file-runtime`：当前默认正式包仍必须保留。原因是随包 Node 二进制仍负责拉起 `x-file-library-engine/dist/main.js` 与默认 `index-only` worker；`export-only` 已经不再是桌面主链保留原因。
    - `x-file-plugins`：应保留，但它不是体积主因；当前目录体积几乎为零，作用只是内置 Integration Plugin 资源目录。
    - 可继续剥离的不是 `x-file-plugins`，而是未来把 `x-file-library-engine` 中仍留着的 HTTP 服务继续拆小，并最终消除 `x-file-runtime` 对完整 Node 的依赖。

- [x] 4.2 export worker 的 SQLite fallback 降级为应急路径
  - 状态：DONE
  - 这一步到底做什么：把桌面主链固定为 snapshot data source，仅把 `sqlite` / `auto` 保留给调试和救火。
  - 做完你能看到什么：正式主链的 `export-only` 不再默默退回 SQLite 直读。
  - 先依赖什么：3.7
  - 开始前先看：
    - `apps/server/src/library/library-export-worker.ts`
    - `packages/indexer/src/library-index-tool.ts`
    - `packages/indexer/src/services/export/export-data-source.ts`
  - 主要改哪里：
    - export worker payload / 错误语义 / 测试 / spec 文档
  - 实际结果：
    - `runLibraryExportOnce()` 现在会返回 `requestedDataSourceMode`、`resolvedDataSourceMode`、`exportCatalogSnapshotPath`，不再把“请求模式”和“实际命中模式”混在一起。
    - `runLibraryIndexOnce()` 与桌面 `export-only` 主链默认都显式改成 `snapshot`，不再通过默认 `auto` 留下静默 SQLite 回退暗门。
    - `export worker` 返回里新增 `exportDataSourceModeRequested`，并用 `exportFallbackToSqlite` 明确标出是否真的命中了 SQLite 应急路径。
    - `auto/sqlite` 仍保留，但只会在显式请求时可观测地进入，应急语义已经从“暗回退”变成“明回退”。
  - 怎么算完成：
    1. export worker 主路径只接受 snapshot
    2. fallback 语义明确且可观测
    3. 缺失 snapshot 时错误信息直接指向 index-only 前置条件
  - 怎么验证：
    - worker 单测
    - export snapshot e2e

- [x] 4.3 SearchIndexBuilder 继续脱离 SQLite 读取依赖
  - 状态：DONE
  - 这一步到底做什么：确认 search 增量构建全链已经只依赖 export data source，不再暗藏 SQLite 直读捷径。
  - 做完你能看到什么：search 桶构建可以跟着 export data source 一起迁移。
  - 先依赖什么：3.7
  - 开始前先看：
    - `packages/indexer/src/services/search/search-index-builder.ts`
    - `packages/indexer/src/services/export/export-data-source.ts`
  - 主要改哪里：
    - search build 计划、测试、必要的 snapshot 数据补充
  - 实际结果：
    - `SearchIndexBuilder` 的构造默认值已从直接调用 `createSqliteExportCatalogDataSource(config.dbPath)` 改成统一走 `createExportCatalogDataSource(config, "sqlite")`。
    - `ExportBuilder` 的默认读取入口也同步改成 `createExportCatalogDataSource(config, "sqlite")`，不再在实现体里直写 SQLite data source 构造器。
    - search 构建逻辑本体已经只消费 `ExportCatalogDataSource`：增量计划、文档遍历、bucket 重建都不再知道底层是 SQLite 还是 snapshot。
  - 怎么算完成：
    1. search 构建只通过 data source 读取 export 输入
    2. snapshot / sqlite 的切换面只保留在 export data source 解析层
  - 怎么验证：
    - `pnpm --filter @x-file/indexer build`
    - `node --import tsx --test src/library/library-index-e2e.test.ts`

- [x] 4.4 better-sqlite3 访问面抽成真正的 driver 边界
  - 状态：DONE
  - 这一步到底做什么：不先替换 SQLite，但先把 `openDatabase()` 这层从“实现细节”升级为“明确 driver contract”。
  - 做完你能看到什么：仓库层不再默认把 better-sqlite3 当唯一世界。
  - 先依赖什么：3.7
  - 开始前先看：
    - `packages/indexer/src/sqlite/open-database.ts`
    - `packages/indexer/src/repositories/catalog-repository.ts`
    - `packages/indexer/src/repositories/catalog-write-repository.ts`
    - `packages/indexer/src/parser/parser-skip-repository.ts`
  - 主要改哪里：
    - sqlite driver 抽象、repository 构造参数、最小测试
  - 怎么算完成：
    1. repository 不直接绑定 specific runtime module
    2. 至少有一层可替换 driver contract
  - 怎么验证：
    - indexer build
    - server build
  - 本轮落地记录：
    - `packages/indexer/src/sqlite/open-database.ts` 已新增 `LibraryIndexerDatabaseDriver`，默认实现仍为 `better-sqlite3`
    - `packages/indexer/src/sqlite/init-catalog.ts` 与 `packages/indexer/src/sqlite/migration-runner.ts` 已支持从入口注入 driver
    - `packages/indexer/src/repositories/catalog-repository.ts`、`packages/indexer/src/repositories/catalog-write-repository.ts`、`packages/indexer/src/parser/parser-skip-repository.ts` 已统一改成通过 driver 打开连接
    - `packages/indexer/src/services/indexer/text-indexer.ts` 与 `packages/indexer/src/library-index-tool.ts` 已把 driver 透传到 catalog 初始化和索引读写链
  - 本轮真实结果：
    - `pnpm --filter @x-file/indexer build`：通过
    - `pnpm --filter @x-file/server build`：通过

- [x] 4.5 TextIndexer 的 SQLite 读写职责切面拆分
  - 状态：DONE
  - 这一步到底做什么：把 `TextIndexer` 当前缠在一起的扫描/解析/写 catalog/算 dirty scope 继续拆出清晰切面。
  - 做完你能看到什么：后续替换执行载体时，不需要把整坨算法连锅搬。
  - 先依赖什么：4.4
  - 开始前先看：
    - `packages/indexer/src/services/indexer/text-indexer.ts`
    - `packages/indexer/src/services/dirty/dirty-scope-resolver.ts`
  - 主要改哪里：
    - index pipeline helper、repository 依赖注入、测试
  - 实际结果：
    - 已新增 `text-index-catalog-store.ts`，把 `CatalogWriteRepository + CatalogRepository + ParserSkipRepository` 对 `TextIndexer` 暴露成最小 `TextIndexCatalogStore`。
    - `TextIndexer` 不再直接 new 三个 SQLite repository，而是消费可注入的 `catalogStore` 与 `dirtyScopeResolver`。
    - `DirtyScopeResolver` 构造参数已从 `CatalogRepository` 收缩成最小 `DirtyScopeDocumentReader` 接口，dirty scope 计算不再硬绑具体 SQLite repository 类型。
    - 当前默认实现仍然是 SQLite store，所以产物契约和运行结果保持不变，但扫描/写入/dirty scope 三段职责已经拆开。
  - 怎么算完成：
    1. 至少拆清扫描/写入/dirty scope 三段职责
    2. 后续可单独替换 catalog 存储层
  - 怎么验证：
    - dirty scope 测试
    - index e2e

- [x] 4.6 Parser skip / catalog write / tag recompute 链继续去硬编码
  - 状态：DONE
  - 这一步到底做什么：把跟着 `TextIndexer` 一起拖着 SQLite 的配套仓库也拆出边界，避免“主索引能换，配套仓库换不了”的半吊子状态。
  - 做完你能看到什么：parser skip、tag recompute、allowed extensions diff 这些支链不会继续把 SQLite 硬绑回去。
  - 先依赖什么：4.4、4.5
  - 开始前先看：
    - `packages/indexer/src/parser/parser-skip-repository.ts`
    - `packages/indexer/src/services/tagging/tag-recompute-service.ts`
    - `packages/indexer/src/services/indexer/allowed-extensions-diff-service.ts`
  - 主要改哪里：
    - repository 构造边界、支链调用入口、测试
  - 实际结果：
    - `TextIndexer` 侧新增的 `TextIndexCatalogStore` 已经把 parser skip 聚合、catalog 写入和导出文档读取统一收进 store 边界，`ParserSkipRepository` 不再从索引主流程里被直接构造。
    - 已新增 `allowed-extensions-store.ts`，`AllowedExtensionsDiffService` 不再直接 new `CatalogRepository/CatalogWriteRepository`，而是走可注入 store。
    - 已新增 `tag-recompute-store.ts`，`TagRecomputeService` 不再直接 new `CatalogRepository/CatalogWriteRepository`，而是走可注入 store。
    - 当前默认实现仍然是 SQLite store，但支链入口已经和主索引边界保持一致，后续不会再新增新的 `better-sqlite3` 直接绑定点。
  - 怎么算完成：
    1. 支链依赖与主索引边界一致
    2. 不再新增新的 better-sqlite3 直接绑定点
  - 怎么验证：
    - indexer build
    - tag / parser 相关测试

- [x] 4.7 library-engine / Node Fastify 壳继续瘦身
  - 状态：DONE
  - 这一步到底做什么：区分“桌面文档库主链已经 native 化”的能力，和“仍需要 HTTP sidecar 的服务”。
  - 做完你能看到什么：`packages/library-engine` 不再背文档库主链的历史包袱。
  - 先依赖什么：4.1
  - 开始前先看：
    - `packages/library-engine/src/app.ts`
    - `apps/server/src/app.ts`
    - `apps/server/src/library/library-engine-feature.ts`
  - 主要改哪里：
    - engine app / server feature 注册边界 / 打包脚本说明
  - 实际结果：
    - `library-engine-feature.ts` 已拆成 `createLibraryEngineFeature()`、`registerLibraryCoreRoutes()`、`registerLibraryNodeServiceRoutes()` 三层。
    - 文档库 binding/snapshot/documents/files/preview/tag/core 路由与 host directory 路由被明确归到 `library core routes`。
    - OnlyOffice、integration status、plugin routes、server state 这些仍需 HTTP sidecar 的服务被明确归到 `node service routes`。
    - `packages/library-engine/src/app.ts` 已改成显式装配上述两层；`apps/server/src/app.ts` 也补了注释，明确 Node 入口不再代表桌面文档库主宿主。
  - 怎么算完成：
    1. 文档库 native 主链与 Node HTTP 壳职责清晰
    2. 资源包里保留 Node 的理由只剩必要服务
  - 怎么验证：
    - desktop preflight
    - server build

- [x] 4.8 Assistant / Plugin / OnlyOffice 与主包边界复核
  - 状态：DONE
  - 这一步到底做什么：确认 assistant、插件 runtime、OnlyOffice 这些仍在 Node 的服务不会重新把文档库数据面塞回主包。
  - 做完你能看到什么：Node 留下来的原因被拆成“服务面”和“数据面”两类，而不是继续混成一团。
  - 先依赖什么：4.1、4.7
  - 开始前先看：
    - `apps/server/src/assistant/**`
    - `apps/server/src/plugins/**`
    - `apps/server/src/office/**`
  - 主要改哪里：
    - 文档 / 资源映射 / 必要的边界保护
  - 实际结果：
    - 已核对 `assistant / plugin / onlyoffice` 三条服务面代码，未发现它们直接依赖 `@x-file/indexer` 或直接持有 `index/export` worker 执行入口。
    - Assistant 依赖的是 `LibraryBindingStore + PluginService`，主要职责是把文档库根目录作为插件 provider 的 workspace。
    - PluginService 只负责插件注册、runtime 安装和 provider bridge，不直接接触 library 数据面执行链。
    - OnlyOffice 通过 `LibraryPreviewLinkService + LibraryService` 消费只读预览能力，并在回调保存后仅通过 `notifyFileChanged()` 上报文件变更。
    - 已在 `LibraryService.notifyFileChanged()` 和 `registerLibraryNodeServiceRoutes()` 补上边界注释，明确 Node sidecar 服务面对数据面的唯一合法写入口是“文件变更通知”，不是重新宿主管理 index/export 执行。
  - 怎么算完成：
    1. assistant / plugin / onlyoffice 与 library index/export 不交叉污染
    2. 主包边界继续保持干净
  - 怎么验证：
    - 相关 typecheck / 测试

- [x] 4.9 正式包资源缩减验证
  - 状态：DONE
  - 这一步到底做什么：不是只说“边界更清楚了”，而是要给出正式包资源目录里到底少了什么、还剩什么。
  - 做完你能看到什么：`x-file-runtime` 是否还完整存在、`x-file-library-engine` 是否缩小、哪些 native 资源仍必要。
  - 先依赖什么：4.1、4.7、4.8
  - 开始前先看：
    - `apps/desktop/src-tauri/resources/*`
    - `scripts/package-desktop.sh`
    - `scripts/verify-desktop.mjs`
  - 主要改哪里：
    - 打包脚本、验证脚本、spec 文档
  - 本轮已确认的真实现状：
    - `x-file-runtime` 当前目录里实际上只剩 `node/bin/node` 一个文件，但体积仍约 `105M`，说明它已经被压成最小 carrier 形态，剩余体积主要就是 Node 二进制本体。
    - `x-file-library-engine` 当前约 `28M`，并继续承载 `dist/main.js`、`@x-file/server/dist/library/*.js` worker 入口、以及 `better_sqlite3.node`。
    - 当前资源目录里仍可见 `@x-file/indexer/contracts/src`、多个 workspace `tsconfig.json`，以及 `@x-file/server/dist/library/*.test.*` 测试产物，这些都不该进入正式包。
    - `@x-file/indexer/dist/src/*` 不能删，因为当前 package `main/exports` 就指向这里；它是运行时入口，不是可裁的垃圾文件。
  - 本轮已落地的收口：
    - `prepare-bundled-server.mjs` 已新增对 deploy 后测试产物和顶层源码/tsconfig 的裁剪。
    - `verify-desktop.mjs` 已新增资源内容级校验：禁止 `x-file-server` 残留、禁止 `x-file-library-engine/src`、禁止 `tsconfig.json`、禁止 `library/*.test.*` 泄漏进正式包。
  - 本轮真实结果：
    - 重新执行 `node scripts/archive/20260616/prepare-bundled-server.mjs` 后，`x-file-library-engine` 资源目录由约 `27M` 进一步收缩到约 `26M`。
    - 重新扫描资源目录，已确认 `@x-file/server/dist/library/*.test.*`、`@x-file/indexer/contracts/src`、workspace `tsconfig.json` 等无效残留已被裁掉。
    - `x-file-runtime` 仍约 `105M`，且当前目录内容实测几乎只剩 `node/bin/node`；这说明它已经不是“塞了很多额外文件”，而是 Node 二进制本体仍然大。
    - `x-file-plugins` 维持约 `16K`，继续不是体积主因。
  - 怎么算完成：
    1. 已列出资源目录差异
    2. 已说明 `x-file-runtime` 还能不能继续删
    3. 已给出真实验证结果
  - 怎么验证：
    - preflight
    - 资源目录人工比对

- [x] 4.10 最终收口：决定是“继续保留最小 Node worker”还是“彻底去掉 Node runtime”
  - 状态：DONE
  - 这一步到底做什么：在前面每刀都收完之后，给出最终技术决定，而不是一直停在“以后还可以再切”。
  - 做完你能看到什么：知道正式包最终边界，知道下一阶段是删 runtime 还是只保留极小 helper。
  - 先依赖什么：4.1-4.9
  - 开始前先看：
    - 当前 spec 全部文件
    - 打包资源目录
    - 最终验证结果
  - 主要改哪里：
    - spec 文档
    - 必要的收尾脚本与代码
  - 最终技术判断：
    - 当前阶段正式选择“继续保留最小 Node worker / sidecar”，不在本 spec 内继续追求强删 `x-file-runtime`。
    - 原因不是保守，而是当前资源实测已经说明：`x-file-runtime` 现在几乎只剩 Node 二进制本体，真正卡住删除的是默认正式主链里仍运行在 Node 的 `index-only / TextIndexer / parser / SQLite`，而不是宿主壳或 export-only。
    - 下一阶段的主目标应切换为“替换执行体”，而不是继续挤 Rust orchestration、HTTP 壳或资源映射细节。
  - 交接入口：
    - 先替换 SQLite 默认 store / `better-sqlite3`
    - 再继续拆 `TextIndexer`
    - 再让 `ExportBuilder / SearchIndexBuilder` 脱离 Node-only 执行环境
    - 执行体迁走后再删除 `x-file-runtime`
  - 怎么算完成：
    1. 已给出最终技术判断
    2. 已说明保留或删除 Node runtime 的具体理由
    3. 已给出下一阶段接手入口
  - 怎么验证：
    - 最终验收走查

- [x] 4.11 落一个非默认启用的第二 SQLite driver 样本
  - 状态：DONE
  - 这一步到底做什么：不是现在就把 `better-sqlite3` 换掉，而是证明 `LibraryIndexerDatabaseDriver` 已经能承载第二实现，不再只是空接口。
  - 做完你能看到什么：`open-database.ts` 内部同时存在 `better-sqlite3` 与 `node:sqlite` 两个 driver，但默认主链仍固定走 `better-sqlite3`。

- [x] 4.12 fallback-export 改为复用统一 export/search 数据源抽象
  - 状态：DONE
  - 这一步到底做什么：把 `fallback-export-builder` 从“自己手搓一套 manifest/meta/bootstrap/search 契约”的旧路，收敛成“扫描文件 -> 组最小 data source -> 复用正式 `ExportBuilder / SearchIndexBuilder`”。
  - 做完你能看到什么：fallback 仍保留在 Node 执行面，但不再额外维护第二套导出结构；主线和应急线开始共用同一份 export/search 构建逻辑。
  - 先依赖什么：4.3、4.5、4.6、4.11
  - 开始前先看：
    - `packages/indexer/src/services/export/fallback-export-builder.ts`
    - `packages/indexer/src/services/export/export-builder.ts`
    - `packages/indexer/src/services/search/search-index-builder.ts`
    - `packages/indexer/src/services/watch/watch-service.ts`
    - `packages/indexer/src/services/indexer/allowed-extensions-diff-service.ts`
    - `packages/indexer/src/services/tagging/tag-recompute-service.ts`
  - 主要改哪里：
    - `packages/indexer/src/services/export/fallback-export-builder.ts`
    - `packages/indexer/src/services/export/export-builder.ts`
    - `packages/indexer/src/library-index-tool.ts`
    - `packages/indexer/src/services/watch/watch-service.ts`
    - `packages/indexer/src/services/indexer/allowed-extensions-diff-service.ts`
    - `packages/indexer/src/services/tagging/tag-recompute-service.ts`
    - `packages/indexer/src/index.ts`
    - `specs/spec003.1-X-File-Indexer-SQLite-Export-Runtime-收口/design.md`
    - `specs/spec003.1-X-File-Indexer-SQLite-Export-Runtime-收口/tasks.md`
  - 实际结果：
    - `fallback-export-builder` 不再直接写 `manifest.json`、`meta/fallback.json`、`bootstrap.json` 等第二套产物；现在改成先扫描允许扩展名文件，再组一个最小 `ExportCatalogDataSource`，最后直接复用正式 `ExportBuilder` 产出 exports。
    - 为了避免“局部 fallback 导出把未扫描文档误删”这种坏语义，fallback 已明确收敛成应急全量导出，不再尝试特殊的 `targetPath` 局部导出契约。
    - 新增 `buildLibraryExport()` 共享 helper，`watch-service`、`AllowedExtensionsDiffService`、`TagRecomputeService`、`library-index-tool` 这些 export 调用点不再各自散落 `new ExportBuilder(...)` 默认构造器。
    - `SearchIndexBuilder` 继续通过 `ExportCatalogDataSource` 跟着主线一起复用，没有再新增新的 SQLite 直读口子。
  - 怎么算完成：
    1. fallback 不再维护第二套 export/search 产物契约
    2. export/search 调用入口继续向统一 helper 和 data source 边界收敛
    3. 现有 `.ai-index/exports/*` 契约保持不变
  - 怎么验证：
    - `pnpm --filter @x-file/indexer build`
    - `pnpm --filter @x-file/server build`
    - `pnpm --filter @x-file/server typecheck`
    - `pnpm --filter @x-file/server test src/library/library-index-e2e.test.ts`
  - 先依赖什么：4.4、4.10
  - 开始前先看：
    - `packages/indexer/src/sqlite/open-database.ts`
    - `packages/session-sync-core/src/sqlite/node-sqlite.ts`
    - `specs/spec003.1-X-File-Indexer-SQLite-Export-Runtime-收口/design.md`
  - 主要改哪里：
    - `packages/indexer/src/sqlite/open-database.ts`
    - `specs/spec003.1-X-File-Indexer-SQLite-Export-Runtime-收口/design.md`
    - `specs/spec003.1-X-File-Indexer-SQLite-Export-Runtime-收口/tasks.md`
  - 这一步先不做什么：不修改默认 driver，不把 `node:sqlite` 接进正式 worker 主链，不新增环境变量切换面。
  - 实际结果：
    - `open-database.ts` 已新增 `nodeSqliteDatabaseDriver`，实现最小契约：`exec / prepare().run|get|all / close`。
    - `better-sqlite3` 改成延迟加载，不再在模块顶层把具体实现硬 import 进去。
    - 公共 PRAGMA 初始化收敛到同一段 helper，两个 driver 共享同一套最小数据库初始化逻辑。
    - `openDatabase()` 仍只返回 `betterSqlite3DatabaseDriver.open(...)`，默认行为完全不变。
    - `apps/server/package.json` 已补回 `build / typecheck / test / start` 脚本，并把 `test` 入口改成可定向的 `node --import tsx --test`，避免数据面回归再被全量 assistant/plugin suite 噪声干扰。
    - worker 协议已新增 `sqliteDriver` 字段；`index-only` / `export-only` 都支持显式传 `"node:sqlite"`，并把 driver 选择继续收束在 `@x-file/indexer` 内部，不把实现对象泄漏到 `apps/server`。
    - 已新增 worker 垂直切片测试：`node:sqlite` 可经由 worker payload 跑通 `index-only -> export-only`，说明第二 driver 不再只是库内样本，而是可执行的数据面实验链。
  - 怎么算完成：
    1. 第二个 driver 样本已存在
    2. 默认主链零行为变化
    3. 后续执行体替换不再需要先改 repository / indexer 入口契约
  - 怎么验证：
    - `pnpm --filter @x-file/indexer build`
    - `pnpm --filter @x-file/server typecheck`
    - `pnpm --filter @x-file/server build`
    - `pnpm --filter @x-file/server test src/library/library-index-worker.test.ts`
    - `pnpm --filter @x-file/server test src/library/library-index-e2e.test.ts`
    - `pnpm --filter @x-file/server test src/library/index-service.test.ts`

- [x] 4.12 默认 SQLite 执行面切到 node:sqlite，better-sqlite3 降为显式兼容路径
  - 状态：DONE
  - 这一步到底做什么：把前一轮“可选实验 driver”推进成正式主链默认值，让 index-only / export-only 在不显式传参时不再依赖 `better-sqlite3` native binding。
  - 做完你能看到什么：`@x-file/indexer` 的默认 `openDatabase()`、worker 默认 `sqliteDriver`、以及 worker 回显结果都会统一指向 `node:sqlite`；`better-sqlite3` 只在显式指定时才进入链路。
  - 先依赖什么：4.11
  - 开始前先看：
    - `packages/indexer/src/sqlite/open-database.ts`
    - `apps/server/src/library/library-worker-support.ts`
    - `apps/server/src/library/library-index-worker.test.ts`
  - 主要改哪里：
    - `packages/indexer/src/sqlite/open-database.ts`
    - `apps/server/src/library/library-worker-support.ts`
    - `apps/server/src/library/library-index-worker.test.ts`
  - 这一步先不做什么：不删除 `better-sqlite3` 依赖，不改桌面 Rust，不碰打包脚本。
  - 实际结果：
    - `open-database.ts` 已新增 `DEFAULT_LIBRARY_INDEXER_DATABASE_DRIVER_KIND` 和 `defaultLibraryIndexerDatabaseDriver`，默认实现正式切到 `node:sqlite`。
    - `resolveLibraryIndexerDatabaseDriver()` 已改成默认返回 `node:sqlite`；只有显式传 `better-sqlite3` 才走旧 binding。
    - `openDatabase()` 已改成默认走 `node:sqlite`，仓库层和 migration/init 链在未显式注入 driver 时不再默认依赖 `better-sqlite3`。
    - `resolveWorkerSqliteDriver()` 已改成默认回显 `node:sqlite`，server worker 主链与 indexer 默认值保持一致。
    - worker 回归测试已同步翻转：不传 `sqliteDriver` 时 `index-only -> export-only` 默认跑 `node:sqlite`；显式传 `"node:sqlite"` 的垂直切片继续保留。
  - 怎么算完成：
    1. 默认 SQLite 执行面不再依赖 `better-sqlite3`
    2. `better-sqlite3` 仅保留为显式兼容/回退路径
    3. 主链 worker 回归能在默认值下跑通
  - 怎么验证：
    - `pnpm --filter @x-file/indexer build`
    - `pnpm --filter @x-file/server typecheck`
    - `pnpm --filter @x-file/server build`
    - `pnpm --filter @x-file/server test src/library/library-index-worker.test.ts`
    - `pnpm --filter @x-file/server test src/library/library-index-e2e.test.ts`

- [x] 4.13 桌面宿主/打包/验包改成按资源边界决定是否需要 x-file-runtime
  - 状态：DONE
  - 这一步到底做什么：把 `apps/desktop` Rust 宿主、`prepare-bundled-server.mjs`、`verify-desktop.mjs` 里对 `x-file-runtime` 的“硬编码必需”改成读取 `x-file-resource-boundary.json` 的声明式判断。
  - 做完你能看到什么：当前正式包默认仍然保留 `x-file-runtime`，但宿主和脚本已经具备“当执行体彻底脱离 Node 时，可直接省略 runtime 资源”的能力，不需要再返工这一层壳。
  - 先依赖什么：4.12
  - 开始前先看：
    - `apps/desktop/src-tauri/src/lib.rs`
    - `scripts/archive/20260616/prepare-bundled-server.mjs`
    - `scripts/verify-desktop.mjs`
  - 主要改哪里：
    - `apps/desktop/src-tauri/src/lib.rs`
    - `scripts/archive/20260616/prepare-bundled-server.mjs`
    - `scripts/verify-desktop.mjs`
    - `specs/spec003.1-X-File-Indexer-SQLite-Export-Runtime-收口/tasks.md`
  - 这一步先不做什么：不默认删除 `tauri.conf.json` 的 `x-file-runtime` resources 映射；在 `library-engine` 主入口和 worker 仍通过 Node 执行之前，不强切正式包默认值。
  - 实际结果：
    - Rust 宿主现在会先读取 `x-file-resource-boundary.json`，再决定是否查找 bundled Node；如果 manifest 明确声明 `x-file-runtime.requiredInMainBundle=false`，宿主不会再把 `x-file-runtime` 当默认查找前提。
    - `prepare-bundled-server.mjs` 已支持 `--omit-node-runtime` / `X_FILE_OMIT_NODE_RUNTIME=1`，可在非默认路径下生成“不带 runtime”的资源布局与边界清单。
    - `verify-desktop.mjs` 已改成只在 manifest 声明 `x-file-runtime.requiredInMainBundle=true` 时才强校验随包 Node 二进制；否则改成提醒而不是失败。
  - 怎么算完成：
    1. 宿主、打包、验包三层对 `x-file-runtime` 的判断已统一走边界清单
    2. 当前正式包默认行为不变
    3. 后续彻底移除 Node runtime 时不再需要重改这一层壳逻辑
  - 怎么验证：
    - `cargo check`
    - `node scripts/verify-desktop.mjs --platform macos --mode preflight`


- [x] 4.14 settings / service 本地模式 native bridge 收口
  - 状态：DONE
  - 这一步到底做什么：把桌面本地模式下设置页仍直连 Node HTTP sidecar 的几条服务面，先切成 Tauri native bridge 主路径。
  - 做完你能看到什么：local 模式下的 health、OnlyOffice、plugin list / toggle、server state 不再必须先依赖 `/api/health`、`/api/plugins`、`/api/office/onlyoffice/*`、`/api/server/state`。
  - 先依赖什么：4.7、4.8、4.13
  - 开始前先看：
    - `apps/desktop/src-tauri/src/lib.rs`
    - `apps/web/src/runtime/native-library-bridge.ts`
    - `apps/web/src/api/library.ts`
    - `apps/web/src/api/health.ts`
    - `apps/web/src/features/settings/SettingsPage.tsx`
  - 主要改哪里：
    - `apps/desktop/src-tauri/src/lib.rs`
    - `apps/web/src/runtime/native-library-bridge.ts`
    - `apps/web/src/api/library.ts`
    - `specs/spec003.1-X-File-Indexer-SQLite-Export-Runtime-收口/tasks.md`
  - 这一步先不做什么：不把 assistant/plugin runtime/onlyoffice callback 整体迁出 Node；当前先收本地模式 settings 的读写与状态面。
  - 实际结果：
    - `native_fetch_library_health` 已不再走 Node `/api/health`，改成直接返回桌面宿主观测到的 watcher / backend 状态。
    - Rust 宿主已新增本地 store/native bridge：`native_get_onlyoffice_settings`、`native_save_onlyoffice_settings`、`native_get_onlyoffice_status`、`native_list_plugins`、`native_enable_plugin`、`native_disable_plugin`、`native_get_http_server_state`、`native_save_http_server_state`。
    - `apps/web/src/api/library.ts` 已改成 local 模式优先走 native bridge；mirror 模式和非 Tauri 环境继续回退 HTTP，不破坏现有远端/浏览器链路。
    - settings 页不需要改 UI 结构；现有 `SettingsPage` 在 local 模式下会自动命中 native 读写主路径。
  - 怎么算完成：
    1. local 模式 settings 主链不再强依赖 Node HTTP sidecar
    2. mirror / web 路径保持原 HTTP 契约不变
    3. 不引入新的主包-插件越界
  - 怎么验证：
    - `pnpm --filter @x-file/web typecheck`
    - `cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml`
    - `node scripts/verify-desktop.mjs --platform macos --mode preflight`


- [x] 4.15 本地模式 binding / config / host-directory native bridge 收口
  - 状态：DONE
  - 这一步到底做什么：继续把本地模式初始化/设置链里还直连 Node HTTP sidecar 的 `library binding`、`library config`、`host directory browser` 收成 Tauri native bridge 主路径。
  - 做完你能看到什么：local 模式下初始化向导、设置页路径选择、binding/config 保存不再必须先依赖 `/api/library/binding`、`/api/library/config`、`/api/host/directories`。
  - 先依赖什么：4.14
  - 开始前先看：
    - `apps/desktop/src-tauri/src/lib.rs`
    - `apps/web/src/runtime/native-library-bridge.ts`
    - `apps/web/src/api/library.ts`
    - `apps/server/src/library/library-config-service.ts`
    - `apps/server/src/library/host-directory-browser-service.ts`
  - 主要改哪里：
    - `apps/desktop/src-tauri/src/lib.rs`
    - `apps/web/src/runtime/native-library-bridge.ts`
    - `apps/web/src/api/library.ts`
    - `specs/spec003.1-X-File-Indexer-SQLite-Export-Runtime-收口/tasks.md`
  - 这一步先不做什么：不改 mirror 模式远端链路，不把 assistant/plugin runtime 迁出 Node，不碰 index/export worker 执行体。
  - 实际结果：
    - Rust 宿主已新增 `native_get_library_binding`、`native_save_library_binding`、`native_get_library_config`、`native_save_library_config`、`native_browse_host_directories`。
    - 本地 binding/config 的持久化与 sidecar config 文件写入，已在 Rust 侧复刻现有 Node 行为：继续写 `.x-file/library-binding.json` 与 binding 指定的 config 相对路径，不破坏现有契约。
    - `apps/web/src/api/library.ts` 已改成 local 模式优先走上述 native bridge；mirror 模式和非 Tauri 环境继续回退 HTTP。
    - 到这一轮为止，local 模式下 settings/init 主链里真正仍强依赖 Node HTTP 的部分已经明显缩到 assistant/runtime 等剩余服务面，而不是 library 初始化/设置本身。
  - 怎么算完成：
    1. local 模式 binding/config/host-directory 不再强依赖 Node HTTP sidecar
    2. mirror / web 路径保持原 HTTP 契约不变
    3. library 配置文件和 binding 持久化契约不变
  - 怎么验证：
    - `cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml`
    - `pnpm --filter @x-file/web typecheck`
    - `node scripts/verify-desktop.mjs --platform macos --mode preflight`

- [x] 4.31 桌面默认 allowedExtensions 主链真正命中 native parser 执行体
  - 状态：DONE
  - 这一步到底做什么：把桌面宿主当前默认整库 `allowedExtensions` 真正推进到 Rust 原生 `index-only` 主链，而不是只在轻量文本或局部 `targetPath` 场景命中 native。
  - 做完你能看到什么：默认配置下的整库 refresh，不会再因为 `allowedExtensions` 里带着 `.pdf/.doc/.docx/.xls/.xlsx/.ppt/.pptx` 就整体回退到 Node worker。
  - 先依赖什么：4.30
  - 开始前先看：
    - `apps/desktop/src-tauri/src/native_index.rs`
    - `apps/desktop/src-tauri/src/lib.rs`
    - `apps/desktop/src-tauri/src/lib.rs` 中 `default_allowed_extensions()`
  - 主要改哪里：
    - `apps/desktop/src-tauri/src/native_index.rs`
    - `specs/spec003.1-X-File-Indexer-SQLite-Export-Runtime-收口/tasks.md`
  - 这一步先不做什么：不碰 `lib.rs` orchestration，不把 `.doc/.xls/.ppt` 这类旧二进制格式伪装成已原生解析成功，不改 export/search 契约。
  - 实际结果：
    - `can_native_index_lightweight_set()` 已从“只认轻量文本集合”收紧成“认桌面默认原生主链可处理集合”：轻量文本/CSV、PDF 最小摘要、openxml 最小摘要，以及 legacy binary skip-only 集合。
    - `.doc/.xls/.ppt` 已显式落成 native skip-only 扩展：它们不会再阻断默认整库 native 路由，但进入 Rust 索引时仍会被保守跳过，保持和旧 Node skip 语义同向，而不是冒然产出伪摘要。
    - 这样桌面默认 `allowedExtensions` 下的整库 refresh 已能真正命中非 Node parser 执行体；Node 只继续兜住更复杂的目录/目标路径/能力缺口。
  - 怎么算完成：
    1. 默认整库 `allowedExtensions` 不再因默认 office/pdf 集合整体退回 Node
    2. `.doc/.xls/.ppt` 不阻断 native 主链，但也不会被错误当成已成功原生解析
    3. 不改现有导出契约与宿主 orchestration
  - 怎么验证：
    - `cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml`

- [x] 4.30 TextIndexer parser 执行体解耦，桌面主链继续优先命中 native parser 能力
  - 状态：DONE
  - 这一步到底做什么：先把 `TextIndexer` 对默认 Node `DocumentParser` 的硬绑定拆成可注入执行体；同时把 Rust 原生侧“整组扩展可否原生执行”的判断抽成通用 helper，继续把桌面主链的 parser 能力边界压在 Rust 宿主侧。
  - 做完你能看到什么：默认 `index-only` 主执行体不再把 parser 策略写死在 `TextIndexer` 内部；桌面宿主可以继续优先命中 native parser 能力，而不需要把 Node `DocumentParser` 当成宿主默认真源。
  - 先依赖什么：4.29
  - 开始前先看：
    - `packages/indexer/src/parser/document-parser.ts`
    - `packages/indexer/src/parser/parser-router.ts`
    - `packages/indexer/src/services/indexer/text-indexer.ts`
    - `packages/indexer/src/library-index-tool.ts`
    - `apps/desktop/src-tauri/src/native_index.rs`
  - 主要改哪里：
    - `packages/indexer/src/parser/document-parser.ts`
    - `packages/indexer/src/parser/parser-router.ts`
    - `packages/indexer/src/services/indexer/text-indexer.ts`
    - `packages/indexer/src/library-index-tool.ts`
    - `apps/desktop/src-tauri/src/native_index.rs`
    - `specs/spec003.1-X-File-Indexer-SQLite-Export-Runtime-收口/tasks.md`
  - 这一步先不做什么：不扩到 export/search orchestration，不重写复杂 parser 算法，不把 Rust 最小摘要链误当成 Node 全量全文索引替代品。
  - 实际结果：
    - `DocumentParser` 已显式实现 `DocumentParseExecutor`，并新增 `createDefaultDocumentParseExecutor()` 与 `createDefaultParserRouter()`，默认 parser 装配点不再散落在索引流程里。
    - `TextIndexerDependencies.parser` 已收敛成基于 `DocumentParseExecutor` 的接口类型；`runLibraryIndexOnce()` 也开始把 parser 执行体一路透传到 `runLibraryTextIndex()`。
    - `native_index.rs` 已新增 `can_native_index_summary_set()` 与底层通用 helper，给桌面主链继续按 Rust 原生 parser 能力集合做优先路由留出稳定入口。
  - 怎么算完成：
    1. `TextIndexer` 默认 parser 执行策略已可注入
    2. `library-index-tool` 已能把 parser 执行体从入口透传到索引主流程
    3. 桌面主链继续优先命中 native parser 能力时，不需要反向依赖 Node parser 细节
  - 怎么验证：
    - `pnpm --filter @x-file/indexer build`
    - `cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml`

- [x] 4.30 PDF 单文件与纯 PDF 子目录的局部 refresh 补最小原生摘要链
  - 状态：DONE
  - 这一步到底做什么：把 `pdf` 从 mixed refresh 的明显剩余单点里再切掉一层，让单文件 `targetPath` 和纯 `pdf` 子目录都能走 Rust 最小摘要链。
  - 做完你能看到什么：桌面宿主不会因为单个 `pdf` 或纯 `pdf` 子目录 refresh 就直接回退到 Node worker；`export-catalog-snapshot.json` 的增量替换/删除也会认 `pdf`。
  - 先依赖什么：4.29
  - 开始前先看：
    - `packages/indexer/src/parser/pdf-parser-adapter.ts`
    - `apps/desktop/src-tauri/src/native_index.rs`
    - `apps/desktop/src-tauri/src/lib.rs`
  - 主要改哪里：
    - `apps/desktop/src-tauri/src/native_index.rs`
    - `apps/desktop/src-tauri/src/lib.rs`
    - `apps/desktop/src-tauri/Cargo.toml`
  - 这一步先不做什么：不补完整 `structured.blocks`，不重写 Node `TextIndexer`，不碰 `SearchIndexBuilder`。
  - 实际结果：
    - Rust 已补最小 PDF 对象/stream/text operator 提取，支持 `FlateDecode` 文本型 PDF 的最小 `summary` 生成。
    - `is_native_summary_extension()` 已纳入 `.pdf`；native snapshot merge 与 deleted-path 收口也从“只认 lightweight”改成“认全部 native summary 子集”。
    - 宿主已新增 `should_prefer_native_pdf_target()`，单个 `pdf` 的局部 refresh 现在会直接命中 Rust。
    - 纯 `pdf` 子目录，以及 `pdf + 轻量文本/openxml` 且全部仍落在原生摘要子集内的子目录 refresh，现在都会继续留在 Rust vertical slice。
  - 怎么算完成：
    1. `pdf` 单文件 `targetPath` 默认 native
    2. 纯 `pdf` 子目录默认 native
    3. native snapshot 增量替换/删除范围与 `pdf/openxml/轻量文本` 摘要子集对齐
    4. 不影响现有导出产物契约
  - 怎么验证：
    - `cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml`

- [x] 4.31 默认 index-only 的 dirty scope 不再为本轮变更文档回读 SQLite
  - 状态：DONE
  - 这一步到底做什么：先把默认增量索引里最没必要的一段 SQLite 读依赖砍掉。刚索引完的文档摘要、标签、本地 mtime 已经在内存里，就别再为了 dirty scope 从 catalog store 读一遍。
  - 做完你能看到什么：`TextIndexer` 在默认增量链里，dirty scope 计算优先吃本轮内存结果；SQLite store 仍保留写职责，但少一段“写完再读回”的无效耦合。
  - 先依赖什么：4.30
  - 开始前先看：
    - `packages/indexer/src/services/indexer/text-indexer.ts`
    - `packages/indexer/src/services/dirty/dirty-scope-resolver.ts`
  - 主要改哪里：
    - `packages/indexer/src/services/indexer/text-indexer.ts`
    - `packages/indexer/src/services/dirty/dirty-scope-resolver.ts`
  - 这一步先不做什么：不重写 SQLite 写入层，不改 `reconcileScope()`，不动 `TextIndexer` 的解析算法。
  - 实际结果：
    - `TextIndexer` 现在在处理 success 文档时，会直接收集 `path/title/summary/tags/derivedTags/mtime` 组成的 `changedDocuments`。
    - `DirtyScopeResolver.resolve()` 已显式支持优先消费 `changedDocuments`，避免默认增量链为了 dirty scope 再从 SQLite/catalog store 回读本轮刚写入的文档。
    - 这一步没有改导出产物契约，只是继续缩 `index-only` 对 Node/SQLite store 的默认读耦合。
  - 怎么算完成：
    1. dirty scope 计算不再依赖“先写 SQLite 再读回本轮变更文档”
    2. 默认增量链仍保持现有 dirty scope 输出结构不变
    3. 为下一步继续拆 `TextIndexCatalogStore` 留出更清晰边界
  - 怎么验证：
    - `pnpm --filter @x-file/indexer build`
    - `pnpm --filter @x-file/server build`

- [x] 4.32 TextIndexer 的 catalog store 先做读写分离，为 native/runtime store 替换铺路
  - 状态：DONE
  - 这一步到底做什么：先把 `TextIndexer` 里原本捏成一团的 store 依赖拆成 `readStore` / `writeStore`。这样后面可以单独替换读侧，不必一次性重写 SQLite 写侧。
  - 做完你能看到什么：默认实现仍然可用，但 `unchanged` 判定、active file 计数、dirty scope 文档读取这些读能力，已经和批量 upsert/reconcile 写能力分离。
  - 先依赖什么：4.31
  - 开始前先看：
    - `packages/indexer/src/services/indexer/text-index-catalog-store.ts`
    - `packages/indexer/src/services/indexer/text-indexer.ts`
  - 主要改哪里：
    - `packages/indexer/src/services/indexer/text-index-catalog-store.ts`
    - `packages/indexer/src/services/indexer/text-indexer.ts`
  - 这一步先不做什么：不改现有默认 SQLite 实现，不接入新的 runtime JSON store，不碰 `TextIndexer` 写事务逻辑。
  - 实际结果：
    - 已新增 `TextIndexCatalogReadStore` / `TextIndexCatalogWriteStore` 两个接口。
    - 已新增 `createSqliteTextIndexCatalogReadStore()` / `createSqliteTextIndexCatalogWriteStore()`，默认仍复用原 SQLite store。
    - `TextIndexerDependencies` 已支持 `readStore` / `writeStore` 注入，内部调用也已按读写职责拆开。
  - 怎么算完成：
    1. `TextIndexer` 不再强制要求单一 store 同时承担读写
    2. 默认执行路径行为不变
    3. 后续可单独替换读侧为 runtime/native store
  - 怎么验证：
    - `pnpm --filter @x-file/indexer build`
    - `pnpm --filter @x-file/server build`
    - `pnpm --filter @x-file/web typecheck`

- [x] 4.33 默认 index-only 读侧开始优先消费 runtime JSON snapshot，而不是直连 SQLite
  - 状态：DONE
  - 这一步到底做什么：把前一轮拆出来的 `readStore` 真接上运行时 JSON 镜像，不再停留在“接口上能替换”的纸面状态。
  - 做完你能看到什么：`TextIndexer` 的 `unchanged` 判定、active file 计数、按路径读取 export 文档，会优先走 `.ai-index/runtime/*.json`，SQLite 只保留回退源。
  - 先依赖什么：4.32
  - 开始前先看：
    - `packages/indexer/src/services/indexer/text-index-catalog-store.ts`
    - `packages/indexer/src/library-index-tool.ts`
  - 主要改哪里：
    - `packages/indexer/src/services/indexer/text-index-catalog-store.ts`
    - `packages/indexer/src/library-index-tool.ts`
  - 这一步先不做什么：不改 `manifest.json` / exports 契约，不替换 SQLite 写侧，不接管 `reconcileScope()`。
  - 实际结果：
    - 已新增 `.ai-index/runtime/active-file-state-snapshot.json` 内部镜像写入能力。
    - 已新增 `createRuntimeTextIndexCatalogReadStore()` 与 `createRuntimePreferredTextIndexCatalogReadStore()`。
    - `runLibraryTextIndex()` 现在默认使用“runtime 优先、SQLite 回退”的读侧 store；索引完成后会刷新 runtime active-file-state snapshot。
    - 现有导出产物契约未变，新增文件只服务 index-only 读侧收口。
  - 怎么算完成：
    1. 默认 index-only 读侧不再只会直连 SQLite
    2. 首次运行和缺失 runtime snapshot 时仍可安全回退 SQLite
    3. 为下一步继续替换 `reconcileScope()` 留出 runtime 基座
  - 怎么验证：
    - `pnpm --filter @x-file/indexer build`
    - `pnpm --filter @x-file/server build`
    - `pnpm --filter @x-file/web typecheck`

- [x] 4.34 默认 index-only 的 reconcile 删除判定改由 runtime 读侧列路径，SQLite 只保留按路径删除写职责
  - 状态：DONE
  - 这一步到底做什么：把默认 `index-only` 最后一段“SQLite 自己先枚举活跃文件，再决定删谁”的读依赖拔掉。读侧负责列出当前活跃路径，写侧只负责按路径删除。
  - 做完你能看到什么：`TextIndexer` 的 `reconcile` 阶段不再调用 SQLite 的 `reconcileScope()` 来枚举候选删除路径，而是改成 `readStore.listActiveFiles(scope) -> writeStore.deleteActiveFilesByPaths(paths)`。
  - 先依赖什么：4.33
  - 开始前先看：
    - `packages/indexer/src/services/indexer/text-indexer.ts`
    - `packages/indexer/src/services/indexer/text-index-catalog-store.ts`
    - `packages/indexer/src/repositories/catalog-write-repository.ts`
  - 主要改哪里：
    - `packages/indexer/src/repositories/catalog-write-repository.ts`
    - `packages/indexer/src/services/indexer/text-index-catalog-store.ts`
    - `packages/indexer/src/services/indexer/text-indexer.ts`
    - `packages/indexer/src/library-index-tool.ts`
  - 这一步先不做什么：不移除 SQLite 写事务，不重写 `deleteDocumentInConnection()`，不碰 `export/search` 契约。
  - 实际结果：
    - `CatalogWriteRepository` 已新增 `listActiveFiles()` 和 `deleteActiveFilesByPaths()`。
    - `TextIndexCatalogReadStore` / `TextIndexCatalogWriteStore` 已补齐对应接口，runtime snapshot 读侧可以正式承接 reconcile 的候选路径枚举。
    - `TextIndexer` 的 reconcile 现在由读侧列出 scope 内活跃文件，再由写侧按路径执行删除，SQLite 不再负责默认链的“候选路径发现”。
    - `.ai-index/runtime/active-file-state-snapshot.json` 现在写入的是全活跃文件状态，而不是绕 export snapshot 兜圈子。
  - 怎么算完成：
    1. 默认 index-only 的 reconcile 候选路径来源不再依赖 SQLite 内部枚举
    2. SQLite 仍保留删除事务和实际写职责
    3. 为后续继续替换写侧奠定清晰边界
  - 怎么验证：
    - `pnpm --filter @x-file/indexer build`
    - `pnpm --filter @x-file/server build`
    - `pnpm --filter @x-file/web typecheck`

- [x] 4.35 默认 TextIndexer 主入口统一接入 runtime active snapshot 读侧，不再只修单一 worker 路径
  - 状态：DONE
  - 这一步到底做什么：把前面做好的 runtime read-side 真正接到所有默认 `TextIndexer` 主入口，而不是只在 `runLibraryTextIndex()` 里做半套。
  - 做完你能看到什么：主 worker、watch cycle、allowed-extensions diff 这三条默认索引入口都会优先吃 runtime active snapshot 读侧，并在写后刷新 active-file-state mirror。
  - 先依赖什么：4.34
  - 开始前先看：
    - `packages/indexer/src/library-index-tool.ts`
    - `packages/indexer/src/services/watch/watch-service.ts`
    - `packages/indexer/src/services/indexer/allowed-extensions-diff-service.ts`
  - 主要改哪里：
    - `packages/indexer/src/library-index-tool.ts`
    - `packages/indexer/src/services/watch/watch-service.ts`
    - `packages/indexer/src/services/indexer/allowed-extensions-diff-service.ts`
  - 这一步先不做什么：不改 export/search 契约，不接管复杂 parser，不删 SQLite 写事务。
  - 实际结果：
    - `runLibraryTextIndex()` 已恢复并正式启用 `createRuntimePreferredTextIndexCatalogReadStore()`，不再只是写侧接入。
    - `WatchService.runCycleAsync()` 里的默认 `TextIndexer` 已改成 runtime-read + sqlite-write 组合，并在每轮索引后刷新 active-file-state snapshot。
    - `AllowedExtensionsDiffService.applyIfNeeded()` 里的新增扩展名索引链也已改成同一套 runtime-read + sqlite-write 组合，并补上 mirror 刷新。
  - 怎么算完成：
    1. 默认 `TextIndexer` 主入口不再出现“有的入口接 runtime，有的入口还直连 SQLite”这种脏分叉
    2. runtime active snapshot mirror 刷新链覆盖默认索引主入口
    3. 为后续继续削弱 SQLite 写面留出统一入口
  - 怎么验证：
    - `pnpm --filter @x-file/indexer build`
    - `pnpm --filter @x-file/server build`
    - `pnpm --filter @x-file/web typecheck`

- [x] 4.36 把默认 runtime-backed TextIndexer 组合抽成统一 helper，并继续削掉 watch 对 SQLite 计数的依赖
  - 状态：DONE
  - 这一步到底做什么：把前面散落在多个入口里的 runtime-read + sqlite-write 组装逻辑收成一个统一 helper，顺手把 watch 的“导出是否陈旧”判断从 SQLite 计数切到 runtime active snapshot。
  - 做完你能看到什么：默认索引主入口不再各自拼一遍 runtime-backed store；watch 也不再需要靠 `countActiveIndexedDocuments()` 才知道当前导出是不是落后。
  - 先依赖什么：4.35
  - 开始前先看：
    - `packages/indexer/src/services/indexer/text-index-catalog-store.ts`
    - `packages/indexer/src/library-index-tool.ts`
    - `packages/indexer/src/services/watch/watch-service.ts`
    - `packages/indexer/src/services/indexer/allowed-extensions-diff-service.ts`
  - 主要改哪里：
    - `packages/indexer/src/services/indexer/text-index-catalog-store.ts`
    - `packages/indexer/src/library-index-tool.ts`
    - `packages/indexer/src/services/watch/watch-service.ts`
    - `packages/indexer/src/services/indexer/allowed-extensions-diff-service.ts`
  - 这一步先不做什么：不动 SQLite 写事务本体，不改 export/search 契约，不切 parser skip。
  - 实际结果：
    - 已新增 `createDefaultRuntimeBackedTextIndexStores()`，统一产出 `readStore` / `writeStore`。
    - `runLibraryTextIndex()`、`WatchService`、`AllowedExtensionsDiffService` 都已切到这个 helper，不再各自手搓组合。
    - `WatchService` 的导出陈旧判定已从 SQLite `countActiveIndexedDocuments()` 改成读取 `active-file-state-snapshot.json` 的文件数。
    - SQLite 在 watch 路径里进一步缩回到元信息写入等剩余写职责。
  - 怎么算完成：
    1. 默认 runtime-backed TextIndexer 组合只有一份权威实现
    2. watch 导出陈旧判定不再依赖 SQLite 文档计数
    3. 继续缩小默认 index-only 对 SQLite 的非必要读取
  - 怎么验证：
    - `pnpm --filter @x-file/indexer build`
    - `pnpm --filter @x-file/server build`
    - `pnpm --filter @x-file/web typecheck`

- [x] 4.37 SearchIndexBuilder 先切成独立显式入口，不再只作为 ExportBuilder 的内嵌尾段
  - 状态：DONE
  - 这一步到底做什么：先把 search 阶段从导出器内部硬编码 `new SearchIndexBuilder(...).build()` 改成可单独调用的显式入口，给后续单独调度/替换执行体打地基。
  - 做完你能看到什么：search 仍保持现有产物契约，但 orchestration 边界已经切清，不再必须附着在 export builder 内部实现细节上。
  - 先依赖什么：4.36
  - 开始前先看：
    - `packages/indexer/src/services/search/search-index-builder.ts`
    - `packages/indexer/src/services/export/export-builder.ts`
  - 主要改哪里：
    - `packages/indexer/src/services/search/search-index-builder.ts`
    - `packages/indexer/src/services/export/export-builder.ts`
  - 这一步先不做什么：不改 search manifest/bucket 结构，不改分词算法，不改 incremental search 规则。
  - 实际结果：
    - 已新增 `buildLibrarySearchIndex()` 独立入口。
    - `ExportBuilder` 现在调用这个入口，而不是直接在内部 new `SearchIndexBuilder`。
    - search 产物契约保持不变，但后续已经可以单独把 search orchestration 抽走。
  - 怎么算完成：
    1. search 阶段已有稳定独立入口
    2. export builder 不再绑死具体 search builder 构造方式
    3. 现有 search 产物契约零破坏
  - 怎么验证：
    - `pnpm --filter @x-file/indexer build`
    - `pnpm --filter @x-file/server build`
    - `pnpm --filter @x-file/web typecheck`

- [x] 4.38 parser skip / failure / skipped 状态开始镜像到 runtime index-state.json，不再只存在 SQLite
  - 状态：DONE
  - 这一步到底做什么：先把 `parser skip / failure / skipped` 这批还绑在 SQLite 里的状态收一份 runtime mirror，缩小它们对 Node/SQLite-only 读取面的垄断。
  - 做完你能看到什么：`.ai-index/runtime/index-state.json` 会包含 failed/skipped 文档状态和 parser skip 聚合摘要，前台或宿主后续不必只能去 SQLite 才能拿到这些状态。
  - 先依赖什么：4.36
  - 开始前先看：
    - `packages/indexer/src/library-index-tool.ts`
    - `packages/indexer/src/services/indexer/text-index-catalog-store.ts`
    - `packages/indexer/src/parser/parser-skip-repository.ts`
  - 主要改哪里：
    - `packages/indexer/src/services/indexer/text-index-catalog-store.ts`
    - `packages/indexer/src/library-index-tool.ts`
  - 这一步先不做什么：不移除 SQLite 写入，不重写 parser skip repository，不改现有 parser skip 聚合算法。
  - 实际结果：
    - 已新增 `.ai-index/runtime/index-state.json` mirror 写入能力。
    - mirror 当前包含 `failedDocuments`、`skippedDocuments`、`parserSkips` 三部分。
    - `runLibraryTextIndex()` 在默认索引完成后会刷新这份 runtime index-state mirror。
  - 怎么算完成：
    1. failure/skip/parser skip 状态不再只存在 SQLite
    2. runtime 层已有最小可读镜像，为后续读链/宿主替换铺路
    3. 不破坏现有 SQLite 写事务与聚合逻辑
  - 怎么验证：
    - `pnpm --filter @x-file/indexer build`
    - `pnpm --filter @x-file/server build`
    - `pnpm --filter @x-file/web typecheck`

- [x] 4.39 Search 阶段继续独立成 search-only worker 入口
  - 状态：DONE
  - 这一步到底做什么：不只在 indexer 包里有独立 search 入口，还要在 Node worker 层把 search 单独立成 `search-only` 模式，避免宿主必须借 export 阶段才能驱动 search。
  - 做完你能看到什么：server 侧已经存在独立 `library-search-worker.ts`，search 阶段可以单独被调起。
  - 先依赖什么：4.37
  - 开始前先看：
    - `apps/server/src/library/library-worker-support.ts`
    - `apps/server/src/library/library-search-worker.ts`
    - `packages/indexer/src/services/search/search-index-builder.ts`
  - 主要改哪里：
    - `apps/server/src/library/library-worker-support.ts`
    - `apps/server/src/library/library-search-worker.ts`
  - 这一步先不做什么：暂不改 Rust 宿主调度，不改前端，不改 search 产物结构。
  - 实际结果：
    - `LibraryWorkerMode` 已新增 `search-only`。
    - 已新增 `apps/server/src/library/library-search-worker.ts`，单独承接 search 阶段。
    - worker 内部通过 `buildLibrarySearchIndex()` + export catalog data source 驱动 search，边界已从 export-only 里再剥出一层。
  - 怎么算完成：
    1. search 不再只能作为 export builder 的内嵌尾段存在
    2. Node worker 层已有单独 search 阶段入口
    3. 现有 search 产物契约保持不变
  - 怎么验证：
    - `pnpm --filter @x-file/indexer build`
    - `pnpm --filter @x-file/server build`

- [x] 4.40 runtime index-state.json 增加标准读取 helper，为后续宿主/服务消费铺路
  - 状态：DONE
  - 这一步到底做什么：把上一轮写出来的 `index-state.json` 从“只会写”补到“能标准读取”，避免 runtime mirror 继续沦为死文件。
  - 做完你能看到什么：indexer 包内已经有统一 `readRuntimeIndexStateSnapshot()`，后续 server/desktop/web 可以直接消费。
  - 先依赖什么：4.38
  - 开始前先看：
    - `packages/indexer/src/services/indexer/text-index-catalog-store.ts`
  - 主要改哪里：
    - `packages/indexer/src/services/indexer/text-index-catalog-store.ts`
  - 这一步先不做什么：暂不接到前台 snapshot，不改 `library-runtime-status-store`。
  - 实际结果：
    - 已新增 `readRuntimeIndexStateSnapshot()`。
    - `index-state.json` 现在具备标准 read/write helper，后续宿主/服务接入成本显著下降。
  - 怎么算完成：
    1. runtime index-state mirror 不再是只写不读
    2. failed/skipped/parserSkips 的 runtime 消费已有统一入口
    3. 不破坏现有 SQLite 真源
  - 怎么验证：
    - `pnpm --filter @x-file/indexer build`
    - `pnpm --filter @x-file/server build`
    - `pnpm --filter @x-file/web typecheck`

- [x] 4.41 server snapshot/status 读链开始消费 runtime index-state.json
  - 状态：DONE
  - 这一步到底做什么：把 `.ai-index/runtime/index-state.json` 从 indexer helper 真接进 server snapshot/status 读链，让 failed/skipped/parser skip 不再只是“写出来但没人用”。
  - 做完你能看到什么：`LibraryIndexStatus` 会稳定带上 runtime mirror 的 `failedDocuments / skippedDocuments / parserSkips`，server 重启前后都能读取。
  - 先依赖什么：4.40
  - 开始前先看：
    - `apps/server/src/storage/library-runtime-status-store.ts`
    - `apps/server/src/storage/library-export-reader.ts`
    - `apps/server/src/library/index-service.ts`
    - `packages/shared/src/library-types.ts`
  - 主要改哪里：
    - `packages/shared/src/library-types.ts`
    - `apps/server/src/storage/library-runtime-status-store.ts`
    - `apps/server/src/storage/index-runtime-store.ts`
    - `apps/server/src/storage/library-export-reader.ts`
    - `apps/server/src/library/index-service.ts`
  - 这一步先不做什么：不改现有 `runtime-status.json` 文件契约，不让前端强依赖新字段，不移除 SQLite 真源。
  - 实际结果：
    - `LibraryIndexStatus` 已新增可选 `runtimeIndexState` 字段，保持旧调用点兼容。
    - `LibraryRuntimeStatusStore` 已直接读取 `.ai-index/runtime/index-state.json`，并把 failed/skipped/parser skip 统一挂到 status 上。
    - server 的内存态、磁盘回读态、以及 `LibraryExportReader.readSnapshot()` 稳态输出现在都会保留这份 runtime mirror。
  - 怎么算完成：
    1. server snapshot/status 已真实消费 `index-state.json`
    2. failed/skipped/parser skip 不再只存在 SQLite 或 indexer 内部 helper
    3. 旧 snapshot / runtime-status 契约不被破坏
  - 怎么验证：
    - `pnpm --filter @x-file/server build`
    - `pnpm --filter @x-file/web typecheck`

- [x] 4.42 桌面 full 调度补成 index/export/search 三段，search-only 真正吃到 dirtyScope
  - 状态：DONE
  - 这一步到底做什么：不是只把 `search-only` worker 文件放在那里，而是让桌面 Rust 宿主在 `full` 调度时真的执行 `index-only -> export-only -> search-only`，并把 index 返回的 dirtyScope 传给 search 阶段。
  - 做完你能看到什么：`search-only` 不再是空壳入口；桌面 native refresh 的 full 语义已经变成明确三段调度。
  - 先依赖什么：4.39、4.40
  - 开始前先看：
    - `apps/desktop/src-tauri/src/lib.rs`
    - `apps/server/src/library/library-search-worker.ts`
  - 主要改哪里：
    - `apps/desktop/src-tauri/src/lib.rs`
  - 这一步先不做什么：不重写 search 算法本体，不把 `SearchIndexBuilder` 从 Node 执行体里移除。
  - 实际结果：
    - Rust 宿主 `mode=full` 已在 index/export 之后继续执行 `search-only`。
    - `search-only` 现在真正接收并消费来自 `index-only` 的 dirtyScope，而不是再用空 payload 伪调度。
    - 本地 Tauri snapshot 也开始读取 `.ai-index/runtime/index-state.json`，桌面直连模式与 server snapshot 的状态结构不再明显分叉。
  - 怎么算完成：
    1. full 调度已经是三段明确 orchestration
    2. `search-only` 真正可运行，不再缺 dirtyScope
    3. 桌面本地 snapshot 能读到 runtime index-state mirror
  - 怎么验证：
    - `cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml`
    - `pnpm --filter @x-file/server build`

- [x] 4.43 TextIndexer 的 skip/failure/parser skip 写侧开始直接维护 runtime mirror
  - 状态：DONE
  - 这一步到底做什么：不是马上删 SQLite 写事务，而是先让默认 `TextIndexer` 写侧在写入成功/失败/跳过/删除时同步维护 `.ai-index/runtime/index-state.json`，避免这批状态只能靠“事后再回读 SQLite”刷新。
  - 做完你能看到什么：skip/failure/parser skip 的 runtime mirror 开始在写侧实时推进，`index-state.json` 不再只是索引结束后的额外补写。
  - 先依赖什么：4.38、4.40
  - 开始前先看：
    - `packages/indexer/src/services/indexer/text-index-catalog-store.ts`
    - `packages/indexer/src/services/indexer/text-indexer.ts`
  - 主要改哪里：
    - `packages/indexer/src/services/indexer/text-index-catalog-store.ts`
  - 这一步先不做什么：不移除 SQLite 写事务，不重写 `CatalogWriteRepository`，不改 parser skip 聚合算法。
  - 实际结果：
    - 默认 runtime-backed write store 已新增 runtime-mirrored 包装层。
    - `batchUpsertDocuments / batchUpsertParseFailures / batchMarkSkippedDocuments / recordSkip / deleteActiveFilesByPaths` 现在会直接推进 runtime `index-state.json`。
    - 这意味着 failed/skipped/parser skip 的 mirror 生成时机开始前移，不再只依赖 `runLibraryTextIndex()` 结束后的补刷新。
  - 怎么算完成：
    1. skip/failure/parser skip mirror 已进入写侧默认路径
    2. 默认 index-only 对这批状态的读取不再只能等待 SQLite 事后回读
    3. SQLite 仍保留为真源，不破坏兼容
  - 怎么验证：
    - `pnpm --filter @x-file/indexer build`

- [x] 4.44 桌面主链 search 执行体迁到 Rust，Node search worker 不再是主路径
  - 状态：DONE
  - 这一步到底做什么：把 `SearchIndexBuilder` 的宿主依赖从桌面主链里拿掉，不再让 Rust 宿主必须拉 Node `library-search-worker.js` 才能完成 full refresh 的 search 阶段。
  - 做完你能看到什么：桌面 `search-only` 已直接走 Rust 原生执行器，基于现有 snapshot/export 契约生成 `search/*.json` 与 `search/manifest.json`。
  - 先依赖什么：4.42
  - 开始前先看：
    - `apps/desktop/src-tauri/src/native_export.rs`
    - `apps/desktop/src-tauri/src/lib.rs`
    - `packages/indexer/src/services/search/search-index-builder.ts`
  - 主要改哪里：
    - `apps/desktop/src-tauri/src/native_export.rs`
    - `apps/desktop/src-tauri/src/lib.rs`
  - 这一步先不做什么：不从 Node 包里删除 `SearchIndexBuilder`，不声称 server/CLI 也已去掉 Node search 执行体。
  - 实际结果：
    - Rust 已新增 `run_native_search_worker()`，直接基于 snapshot/export 文档生成 search bucket 与 manifest。
    - `lib.rs` 的 `search-only` 已优先走 Rust 原生执行器；桌面 full 主链不再依赖 Node `SearchIndexBuilder`。
    - Node `library-search-worker.ts` 仍保留作为兼容/过渡入口，但已不是桌面主路径。
  - 怎么算完成：
    1. 桌面主链 search 执行体不再依赖 Node
    2. `search/manifest.json` 与现有 bucket 契约保持兼容
    3. full 三段调度已经全部由 Rust 宿主掌控
  - 怎么验证：
    - `cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml`

- [x] 4.45 默认 index-only 主执行体先把状态写入抽成独立薄层
  - 状态：DONE
  - 这一步到底做什么：不急着整块替换 `CatalogWriteRepository`，先把 `failure / skipped / active-file / delete` 这组状态写入从“大而全写仓库”里抽成单独的 `TextIndexStatusStore` 边界。
  - 做完你能看到什么：默认 `TextIndexer` 路径已经显式区分“文档/标签/chunk 写入”和“状态类写入”，后续无论切 native SQLite 还是 file-backed 真源，都不用再先拆数据结构。
  - 先依赖什么：4.43
  - 开始前先看：
    - `packages/indexer/src/repositories/catalog-write-repository.ts`
    - `packages/indexer/src/services/indexer/text-index-catalog-store.ts`
    - `packages/indexer/src/services/indexer/text-index-status-store.ts`
  - 主要改哪里：
    - `packages/indexer/src/services/indexer/text-index-status-store.ts`
    - `packages/indexer/src/services/indexer/text-index-catalog-store.ts`
    - `packages/indexer/src/index.ts`
  - 这一步先不做什么：不把状态 SQL 实现完全搬出 `CatalogWriteRepository`，不重写 SQLite schema，不改 `TextIndexer` 算法本体。
  - 实际结果：
    - 已新增独立 `TextIndexStatusStore`。
    - `TextIndexCatalogStore` 现在显式组合 `statusStore`，默认路径上的 `count/list/get active file`、`failed/skipped` 批量写入、以及 delete 已从概念边界上与文档/标签写入分离。
    - 这一步让默认 `index-only` 主执行体后续继续去 Node 化时，有了清晰的状态真源切口。
  - 怎么算完成：
    1. 默认 `index-only` 主路径已经出现独立状态写层
    2. `CatalogWriteRepository` 不再是唯一概念承载体
    3. 现有行为与契约不被破坏
  - 怎么验证：
    - `pnpm --filter @x-file/indexer build`

- [x] 4.46 TextIndexStatusStore 改成真正独立 SQLite 实现，成功路径状态更新也切入
  - 状态：DONE
  - 这一步到底做什么：不再让 `TextIndexStatusStore` 只是 `CatalogWriteRepository` 的借壳 facade，而是把 `active-file / indexed / failed / skipped / delete` 这组状态 SQL 真正独立实现出来；同时把成功路径状态更新也接入这层。
  - 做完你能看到什么：默认 `index-only` 的状态真源已经可以脱离 `CatalogWriteRepository` 的成功/失败/跳过副作用，不再把这批状态逻辑硬绑在“大写仓库”里。
  - 先依赖什么：4.45
  - 开始前先看：
    - `packages/indexer/src/services/indexer/text-index-status-store.ts`
    - `packages/indexer/src/services/indexer/text-index-catalog-store.ts`
    - `packages/indexer/src/repositories/catalog-write-repository.ts`
  - 主要改哪里：
    - `packages/indexer/src/services/indexer/text-index-status-store.ts`
    - `packages/indexer/src/services/indexer/text-index-catalog-store.ts`
  - 这一步先不做什么：不改文档正文/tag/chunk 写入主仓库，不删除 `CatalogWriteRepository` 里的旧状态实现，不重写 schema。
  - 实际结果：
    - `TextIndexStatusStore` 已实现独立 SQLite SQL，不再调用 `CatalogWriteRepository` 作为底层。
    - 成功路径已新增 `batchUpsertIndexedDocuments` 状态更新，默认 `TextIndexer` flush success 后的 active/indexed 状态也进入独立状态层。
    - 至此，默认 `index-only` 的状态真源已经从“完全依赖 Node 仓库副作用”前进到“独立状态层 + 仓库并存”的结构。
  - 怎么算完成：
    1. 状态层拥有自己的 SQLite 实现
    2. success/failure/skipped/delete 都已接入独立状态层
    3. 默认 `index-only` 主执行体的状态真源不再依赖 `CatalogWriteRepository` 的状态副作用
  - 怎么验证：
    - `pnpm --filter @x-file/indexer build`
    - `pnpm --filter @x-file/server build`

- [x] 4.47 TextIndexTagStore 补齐 manual binding / identity migration / carry-forward 独立语义
  - 状态：DONE
  - 这一步到底做什么：把默认成功路径里真正还绑在 `CatalogWriteRepository` 的 manual binding 语义迁到独立 `TextIndexTagStore`，避免 tag 写侧继续借旧仓库的隐式副作用。
  - 做完你能看到什么：`TextIndexTagStore` 已自己处理 `manual binding / legacy fallback / identity migration / carry-forward / syncManualResolvedTags`，默认成功路径不再依赖旧仓库这批语义。
  - 先依赖什么：4.46
  - 开始前先看：
    - `packages/indexer/src/services/indexer/text-index-tag-store.ts`
    - `packages/indexer/src/services/indexer/text-index-catalog-store.ts`
    - `packages/indexer/src/repositories/catalog-write-repository.ts`
  - 主要改哪里：
    - `packages/indexer/src/services/indexer/text-index-tag-store.ts`
    - `packages/indexer/src/services/indexer/text-index-catalog-store.ts`
    - `packages/indexer/src/services/indexer/text-index-write-helpers.ts`
  - 这一步先不做什么：不删除 `CatalogWriteRepository` 旧实现，不扩大到 tag recompute / 管理端写面，不改导出契约。
  - 实际结果：
    - `TextIndexTagStore` 已新增 `captureBatchUpsertContexts()`，在成功写入前抓取旧 identity/manual binding 上下文。
    - 默认成功路径会先由 tag store 捕获旧上下文，再执行 document/chunk/tag/status 写入，避免 identity 迁移被写入时序覆盖。
    - `manual binding / legacy fallback / identity migration / carry-forward / syncManualResolvedTags` 已迁入独立 tag store，默认成功路径不再需要旧仓库承接这批语义。
  - 怎么算完成：
    1. 默认成功路径不再依赖 `CatalogWriteRepository` 的 manual tag 语义副作用
    2. identity-based manual file binding 可在独立 tag store 中继续生效
    3. 现有 `document_tags / derived_document_tags / manual_file_tag_bindings` 契约不破坏
  - 怎么验证：
    - `pnpm --filter @x-file/indexer build`

- [x] 4.48 parser skip 从默认主写链继续独立成 store 边界
  - 状态：DONE
  - 这一步到底做什么：把默认 `index-only` 主写链里对 `ParserSkipRepository` 的直接构造再外拉一层，避免主写链继续显式依赖旧 repository 类。
  - 做完你能看到什么：`text-index-catalog-store.ts` 已经只依赖 `ParserSkipStore` 边界，默认主写链不会再直接 `new ParserSkipRepository`。
  - 先依赖什么：4.47
  - 开始前先看：
    - `packages/indexer/src/services/indexer/text-index-catalog-store.ts`
    - `packages/indexer/src/parser/parser-skip-repository.ts`
  - 主要改哪里：
    - `packages/indexer/src/services/indexer/parser-skip-store.ts`
    - `packages/indexer/src/services/indexer/text-index-catalog-store.ts`
  - 这一步先不做什么：不改 parser skip 聚合算法，不移除 SQLite 真源，不去碰 parser 执行体。
  - 实际结果：
    - 已新增独立 `parser-skip-store.ts`，沿用现有 SQLite schema 和聚合契约。
    - `text-index-catalog-store.ts` 已改成注入/构造 `ParserSkipStore`，默认主写链不再直接构造 `ParserSkipRepository`。
  - 怎么算完成：
    1. 默认主写链的 parser skip 依赖已压到独立 store 边界
    2. 现有 `parser_skip_catalog` 聚合行为不变
    3. 后续原生或 file-backed 替换已有明确切口
  - 怎么验证：
    - `pnpm --filter @x-file/indexer build`

- [x] 4.16 桌面主链 export-only 从 Node worker 切到 Rust 原生执行
  - 状态：DONE
  - 这一步到底做什么：不碰 index-only 和全文索引算法，先把已经走 snapshot data source 的 `export-only` 从桌面主链里剥离出 Node worker，让 Rust 宿主直接产出既有 `.ai-index/exports/*` 契约。
  - 做完你能看到什么：桌面 `full -> index-only -> export-only` 里，前半段仍可暂时走 Node，后半段导出阶段已经不再需要 `library-export-worker.js`。
  - 先依赖什么：4.12、4.13、4.15
  - 开始前先看：
    - `apps/desktop/src-tauri/src/lib.rs`
    - `apps/server/src/library/library-export-worker.ts`
    - `packages/indexer/src/services/export/export-data-source.ts`
    - `packages/indexer/src/services/export/export-builder.ts`
    - `packages/indexer/src/services/search/search-index-builder.ts`
  - 主要改哪里：
    - `apps/desktop/src-tauri/src/native_export.rs`
    - `apps/desktop/src-tauri/src/lib.rs`
    - `specs/spec003.1-X-File-Indexer-SQLite-Export-Runtime-收口/tasks.md`
  - 这一步先不做什么：不迁移 `index-only`，不重写 parser，不改前台 reader，不删 Node runtime。
  - 实际结果：
    - 已新增 Rust 原生 `native_export` 模块，直接读取 `.ai-index/runtime/export-catalog-snapshot.json` 并生成现有 `manifest.json / meta / detail / tags / relations / bootstrap / search` 结构。
    - `lib.rs` 的 `run_native_library_index_worker_once()` 已改成：`index-only` 仍走 Node worker，`export-only` 直接走 Rust 原生执行器。
    - `runtime-status.json` 仍保持既有字段：`running(export_snapshot)` -> `cooldown/failed`，前台 snapshot/documents/files 读取契约未动。
    - 这一步把桌面主链的 export 执行体从 Node worker 里剥出来了，但 Node runtime 仍因 `index-only / TextIndexer / parser / SQLite 执行面` 保留。
  - 怎么算完成：
    1. 桌面宿主触发 `export-only` 时不再拉起 `library-export-worker.js`
    2. `.ai-index/exports/*` 契约保持不变
    3. `runtime-status.json` 契约保持不变
  - 怎么验证：
    - `cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml`
    - `pnpm --filter @x-file/web typecheck`
    - `node scripts/verify-desktop.mjs --platform macos --mode preflight`

- [x] 4.17 无 Node runtime 条件下的桌面原生 index/export vertical slice
  - 状态：DONE
  - 这一步到底做什么：不是直接宣布“Node 可删”，而是把桌面宿主补成在 `x-file-runtime` 缺失或已声明可省略时，仍可原生完成一次 `index-only -> export-only` 数据面切片。
  - 做完你能看到什么：即使不拉起 Node worker，桌面宿主也能扫描一批轻量文本/CSV 文档，生成 `export-catalog-snapshot.json`，再接着产出既有 `.ai-index/exports/*` 契约。
  - 先依赖什么：4.16
  - 开始前先看：
    - `apps/desktop/src-tauri/src/lib.rs`
    - `apps/desktop/src-tauri/src/native_export.rs`
    - `packages/indexer/src/scanner/file-scanner.ts`
    - `packages/indexer/src/parser/plain-text-parser-adapter.ts`
    - `packages/indexer/src/services/export/fallback-export-builder.ts`
  - 主要改哪里：
    - `apps/desktop/src-tauri/src/native_index.rs`
    - `apps/desktop/src-tauri/src/lib.rs`
    - `specs/spec003.1-X-File-Indexer-SQLite-Export-Runtime-收口/tasks.md`
  - 这一步先不做什么：不替换默认 Node `index-only` 主链，不重写 DOCX/XLSX/PDF parser，不宣称与 `TextIndexer` 完全等价。
  - 实际结果：
    - 已新增 Rust 原生 `native_index` 模块：支持扫描允许扩展名文件、读取轻量文本/CSV 摘要、生成最小 derived tags，并写出 `.ai-index/runtime/export-catalog-snapshot.json`。
    - `lib.rs` 已新增 fallback 逻辑：当 `x-file-resource-boundary.json` 声明 `x-file-runtime.requiredInMainBundle=false`，或随包 Node 入口不存在时，`index-only` 会自动切到 Rust 原生执行器。
    - 与上一步叠加后，桌面宿主在“无 Node runtime”条件下已经具备一个真实可运行的 `index-only(native) -> export-only(native)` vertical slice。
    - 当前 vertical slice 明确只覆盖轻量文本/CSV 数据面；默认正式主链仍优先走 Node `index-only`，以避免现阶段破坏全文索引与复杂 parser 行为。
  - 怎么算完成：
    1. `x-file-runtime` 缺失时桌面宿主不会直接瘫痪
    2. 能生成 `export-catalog-snapshot.json` 与既有 `.ai-index/exports/*` 契约
    3. 默认正式主链行为不变
  - 怎么验证：
    - `cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml`
    - `pnpm --filter @x-file/web typecheck`
    - `node scripts/verify-desktop.mjs --platform macos --mode preflight`

- [x] 4.18 从桌面资源边界中移除 export worker 必需性
  - 状态：DONE
  - 这一步到底做什么：把“桌面主链已经 native 化的 export-only”从宿主候选、资源边界说明和 spec 结论里彻底摘掉，避免 `x-file-runtime` 的保留理由继续被历史描述污染。
  - 做完你能看到什么：`x-file-runtime` 的保留原因会被进一步收缩到 `library-engine` 主入口与默认 `index-only` 执行面，不再把 `export-only` 也算进账。
  - 先依赖什么：4.16、4.17
  - 开始前先看：
    - `apps/desktop/src-tauri/src/lib.rs`
    - `scripts/archive/20260616/prepare-bundled-server.mjs`
    - `specs/spec003.1-X-File-Indexer-SQLite-Export-Runtime-收口/design.md`
    - `specs/spec003.1-X-File-Indexer-SQLite-Export-Runtime-收口/tasks.md`
  - 主要改哪里：
    - `apps/desktop/src-tauri/src/lib.rs`
    - `scripts/archive/20260616/prepare-bundled-server.mjs`
    - `specs/spec003.1-X-File-Indexer-SQLite-Export-Runtime-收口/design.md`
    - `specs/spec003.1-X-File-Indexer-SQLite-Export-Runtime-收口/tasks.md`
  - 实际结果：
    - `lib.rs` 已删除 `export-only -> library-export-worker.js` 的桌面候选分支；桌面宿主内部已经没有再解析 export worker 入口的必要。
    - `prepare-bundled-server.mjs` 里 `x-file-runtime` 的 purpose / mustKeepBecause / removableAfter 已收紧成只描述默认 `index-only` 与 Node 主入口。
    - spec 文档里的最终结论、资源边界说明与剩余阻塞已同步收口，不再把 `export-only` 当成 runtime 必留原因。
  - 怎么算完成：
    1. 桌面资源边界不再把 export worker 计入 Node 必需项
    2. `x-file-runtime` 的剩余保留理由更精确
    3. 不改变当前运行行为
  - 怎么验证：
    - `cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml`
    - `pnpm --filter @x-file/web typecheck`
    - `node scripts/verify-desktop.mjs --platform macos --mode preflight`

- [x] 4.19 轻量 parser 集合默认切到原生 index-only
  - 状态：DONE
  - 这一步到底做什么：不再只把 Rust 原生 `index-only` 当成“无 runtime 时兜底”，而是让轻量扩展名集合默认优先走原生扫描/解析/snapshot 链，把默认 `index-only` 从 Node/SQLite 主链再剥一层。
  - 做完你能看到什么：当 `allowedExtensions` 只包含 text/markdown/html/json/yaml/tsv/csv 这些轻量集合时，桌面宿主会直接走 Rust 原生 `index-only`；复杂格式仍继续回退到 Node worker。
  - 先依赖什么：4.17、4.18
  - 开始前先看：
    - `apps/desktop/src-tauri/src/native_index.rs`
    - `apps/desktop/src-tauri/src/lib.rs`
    - `packages/indexer/src/parser/plain-text-parser-adapter.ts`
    - `packages/indexer/src/parser/csv-parser-adapter.ts`
    - `packages/indexer/src/parser/complex-document-skip-adapter.ts`
  - 主要改哪里：
    - `apps/desktop/src-tauri/src/native_index.rs`
    - `apps/desktop/src-tauri/src/lib.rs`
    - `specs/spec003.1-X-File-Indexer-SQLite-Export-Runtime-收口/design.md`
    - `specs/spec003.1-X-File-Indexer-SQLite-Export-Runtime-收口/tasks.md`
  - 这一步先不做什么：不默认接管 PDF/DOCX/XLSX/PPTX 等复杂格式，不重写 SQLite catalog，不宣称已替代 `TextIndexer` 全语义。
  - 实际结果：
    - `native_index.rs` 已新增轻量扩展名集合判断：`.md/.mdx/.txt/.rtf/.html/.htm/.xml/.json/.yaml/.yml/.tsv/.csv`
    - `lib.rs` 已改成当 `allowedExtensions` 落在该轻量集合内时，默认 `index-only` 直接走 Rust 原生执行器，而不是先拉 Node worker。
    - 原生轻量索引现在会读取旧 `export-catalog-snapshot.json`，保留其中非轻量扩展名的复杂文档记录，只替换轻量文档集合，避免混合资料库场景下把复杂文档从 snapshot 里误删。
    - 本轮已补齐 `targetPath` 增量语义：原生轻量索引现在会按 `targetPath` 只扫描目标文件/目录，基于旧 snapshot 推导轻量文档的 `changedPaths/deletedPaths`，并返回 `trigger=incremental` 的 dirty scope；这样轻量局部 refresh 也能优先走 native，而不会把全量 dirty scope 硬塞给 export。
    - 复杂格式和完整 SQLite/TextIndexer 主链仍保留在 Node，这样不会破坏现有复杂文档行为，但默认链路已经从 Node/SQLite 再剥掉一块。
  - 怎么算完成：
    1. 轻量扩展名集合默认 `index-only` 已优先走 Rust 原生执行器
    2. 轻量 `targetPath` 增量 refresh 也已具备原生 dirty scope 语义
    3. 混合资料库场景下不会因原生轻量索引把复杂文档 snapshot 误删

- [x] 4.20 轻量原生 index-only 补齐 targetPath 增量语义
  - 状态：DONE
  - 这一步到底做什么：把 Rust 轻量索引从“只能全量 fallback”补成“对轻量集合的文件级/目录级增量 refresh 也能正常工作”，避免 local 模式下一旦传 `targetPath` 就又退回全量或错误 dirty scope。
  - 做完你能看到什么：轻量 `targetPath` 刷新时，Rust 原生链会只重扫目标作用域、只替换目标作用域内的轻量 snapshot 记录，并返回增量 dirty scope 给原生 export。
  - 先依赖什么：4.19
  - 开始前先看：
    - `apps/desktop/src-tauri/src/native_index.rs`
    - `apps/desktop/src-tauri/src/lib.rs`
    - `packages/indexer/src/services/dirty/dirty-scope-resolver.ts`
    - `packages/indexer/src/services/indexer/text-indexer.ts`
  - 主要改哪里：
    - `apps/desktop/src-tauri/src/native_index.rs`
    - `specs/spec003.1-X-File-Indexer-SQLite-Export-Runtime-收口/tasks.md`
  - 这一步先不做什么：不接管复杂 parser，不补 SQLite catalog reconcile，不宣称与 Node TextIndexer 的全文索引语义完全等价。
  - 实际结果：
    - 原生索引已新增 `targetPath` 作用域解析，支持文件级 `exact` 和目录级 `prefix` 两种轻量增量扫描。
    - snapshot 合并逻辑已收紧成“只替换目标作用域内的轻量文档”，不会把作用域外轻量文档或复杂文档从 `export-catalog-snapshot.json` 里误删。
    - 原生 dirty scope 已按旧 snapshot 与当前扫描结果计算 `changedPaths`、`deletedPaths`、`dirtyDirectories`、`dirtyMetaShards`、`dirtyDetailShards`、`dirtyRelations`，`trigger` 在增量场景下为 `incremental`。
    - 这样桌面宿主在轻量集合下，无论 full refresh 还是 `targetPath` 局部 refresh，都可以继续停留在原生 `index-only(native) -> export-only(native)` vertical slice 内，不必为了局部刷新退回 Node worker。
  - 怎么算完成：
    1. 轻量文件级 `targetPath` 可原生执行
    2. 轻量目录级 `targetPath` 可原生执行
    3. 返回的 dirty scope 已具备增量 export 所需最小契约
  - 怎么验证：
    - `cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml`
    - `pnpm --filter @x-file/web typecheck`

- [x] 4.21 混合格式资料库的单文件轻量 refresh 默认切到 Rust
  - 状态：DONE
  - 这一步到底做什么：不碰复杂目录级 refresh，也不重写复杂 parser，只把“混合格式资料库里某个轻量文件的局部 refresh”从默认 Node worker 路由中再剥出来。
  - 做完你能看到什么：即使文档库整体 `allowedExtensions` 不是纯轻量集合，只要这次 `targetPath` 明确指向一个轻量文件，桌面宿主也会默认优先走 Rust 原生 `index-only -> export-only`。
  - 先依赖什么：4.20
  - 开始前先看：
    - `apps/desktop/src-tauri/src/lib.rs`
    - `apps/desktop/src-tauri/src/native_index.rs`
  - 主要改哪里：
    - `apps/desktop/src-tauri/src/lib.rs`
    - `specs/spec003.1-X-File-Indexer-SQLite-Export-Runtime-收口/tasks.md`
  - 这一步先不做什么：不接管混合格式目录级 refresh，不改变复杂扩展名文件的默认路由，不改 Node TextIndexer 主链。
  - 实际结果：
    - 宿主判定已从“仅按 allowedExtensions 是否全轻量”扩成“两类命中即优先 native”：`allowedExtensions` 全轻量，或 `targetPath` 明确指向一个轻量扩展名文件。
    - 这样混合格式资料库里的 `docs/a.md`、`notes/x.txt`、`data/demo.csv` 这类单文件刷新，不再为了整库里有 PDF/DOCX 就回退到 Node。
    - 目录级 mixed refresh、复杂扩展名 refresh 仍继续走 Node worker，避免现在就把复杂作用域语义做脏。
  - 怎么算完成：
    1. mixed library 下的单文件轻量 `targetPath` 默认 native
    2. mixed library 下的目录级 `targetPath` 仍保留 Node
    3. 不破坏现有 full refresh 与复杂格式行为
  - 怎么验证：
    - `cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml`
    - `pnpm --filter @x-file/web typecheck`

- [x] 4.22 混合格式资料库的轻量目录 refresh 加一层保守 native 判定
  - 状态：DONE
  - 这一步到底做什么：继续压默认 `index-only` 的 Node 面积，但不冒进去接管所有 mixed 目录刷新；只有当 `targetPath` 指向的子目录内实际扫描不到复杂扩展名时，才默认切到 Rust。
  - 做完你能看到什么：mixed library 下的某个轻量子目录局部 refresh，不再因为整库其它地方有 PDF/DOCX 就强制走 Node worker。
  - 先依赖什么：4.21
  - 开始前先看：
    - `apps/desktop/src-tauri/src/lib.rs`
    - `apps/desktop/src-tauri/src/native_index.rs`
  - 主要改哪里：
    - `apps/desktop/src-tauri/src/lib.rs`
    - `specs/spec003.1-X-File-Indexer-SQLite-Export-Runtime-收口/tasks.md`
  - 这一步先不做什么：不接管包含复杂扩展名文件的 mixed 目录，不重写复杂 parser，不改 Node TextIndexer 的目录 reconcile 语义。
  - 实际结果：
    - 宿主已新增目录级保守判定：当 `targetPath` 指向实际存在的子目录，并且该子树里只发现轻量扩展名文件时，`index-only` 默认优先走 Rust 原生执行器。
    - 如果目录里存在复杂扩展名、路径不存在、或读取目录失败，宿主会继续保守回退到 Node worker，不会硬切坏现有行为。
    - 这样 mixed library 下的局部轻量目录 refresh 也开始从默认 Node 路径里退出一部分，而复杂目录仍保留在 Node。
  - 怎么算完成：
    1. mixed library 下的轻量子目录 `targetPath` 默认 native
    2. 包含复杂扩展名的 mixed 子目录仍保留 Node
    3. 不破坏 full refresh 与复杂目录 refresh
  - 怎么验证：
    - `cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml`
    - `pnpm --filter @x-file/web typecheck`

- [x] 4.23 `.markdown` 在 Node/Rust 两侧轻量链路完成对齐
  - 状态：DONE
  - 这一步到底做什么：补掉一个真实裂缝。前一轮 Rust native 已支持 `.markdown`，但 Node 主链的 scanner / plain text parser / 类型标签 / capability 列表还没全跟上。
  - 做完你能看到什么：无论当前请求最终落到 Rust native 还是 Node 主链，`.markdown` 都会被当成轻量 Markdown 文档处理，不再出现“一侧能索引、一侧跳过或标签不一致”的分叉。
  - 先依赖什么：4.22
  - 开始前先看：
    - `packages/indexer/src/scanner/file-scanner.ts`
    - `packages/indexer/src/parser/plain-text-parser-adapter.ts`
    - `packages/indexer/src/tagging/simple-tag-inference.ts`
    - `packages/indexer/src/parser/parser-capability-registry.ts`
  - 主要改哪里：
    - `packages/indexer/src/scanner/file-scanner.ts`
    - `packages/indexer/src/parser/plain-text-parser-adapter.ts`
    - `packages/indexer/src/tagging/simple-tag-inference.ts`
    - `packages/indexer/src/parser/parser-capability-registry.ts`
    - `specs/spec003.1-X-File-Indexer-SQLite-Export-Runtime-收口/tasks.md`
  - 这一步先不做什么：不改复杂 parser，不改 TextIndexer 主流程，不碰 SQLite/export 契约。
  - 实际结果：
    - Node scanner 已允许 `.markdown` 进入索引扫描。
    - Node `PlainTextParserAdapter` 已把 `.markdown` 视为轻量文本，继续走现有文本摘要链。
    - Node `SimpleTagInferenceEngine` 已把 `.markdown` 归到 `类型/文本/Markdown`。
    - parser capability 列表已补进 `.markdown`，前台/调试面不会再看到能力清单与实际行为不一致。
  - 怎么算完成：
    1. `.markdown` 在 Node/Rust 两侧都能进入轻量链路
    2. `.markdown` 的类型标签一致
    3. 不引入新的运行时分叉
  - 怎么验证：
    - `pnpm --filter @x-file/indexer build`
    - `cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml`

- [x] 4.24 默认 CSV 路由从复杂 parser 降到轻量文本链
  - 状态：DONE
  - 这一步到底做什么：继续压复杂 parser 剩余面，但不重写 CSV 的完整结构化输出。既然当前 `TextIndexer` 主流程只消费 `title/summary/text`，那默认 CSV 路由就没必要继续占着“复杂 parser”主路径。
  - 做完你能看到什么：默认 Node 索引链里，`.csv` 会优先走 `PlainTextParserAdapter` 的轻量文本路线；`CsvParserAdapter` 仍保留在代码里，但不再是默认主路径。
  - 先依赖什么：4.23
  - 开始前先看：
    - `packages/indexer/src/parser/plain-text-parser-adapter.ts`
    - `packages/indexer/src/parser/csv-parser-adapter.ts`
    - `packages/indexer/src/services/indexer/text-indexer.ts`
  - 主要改哪里：
    - `packages/indexer/src/parser/plain-text-parser-adapter.ts`
    - `specs/spec003.1-X-File-Indexer-SQLite-Export-Runtime-收口/tasks.md`
  - 这一步先不做什么：不删除 `CsvParserAdapter`，不改 parser router 顺序，不碰 Rust native CSV 契约，不补 structured table 输出到索引主流程。
  - 实际结果：
    - `PlainTextParserAdapter` 已支持 `.csv`，并在解析时做最小单元格拆分，把每行压成空格分隔文本，再产出 `text/summary`。
    - `parser` 字段对 `.csv` 直接回写为 `csv`，避免前台或调试链看到“CSV 实际走了轻量文本，但 parser 名字还是 plain_text”的假象。
    - 因为默认 adapter 列表里 `PlainTextParserAdapter` 排在 `CsvParserAdapter` 前面，`.csv` 现在默认走轻量链；复杂 CSV parser 代码保留，仅作为后续结构化输出实验面。
  - 怎么算完成：
    1. 默认 `.csv` 已不再依赖复杂 parser 主路径
    2. 现有索引主流程仍能拿到 `title/summary/text`
    3. 不破坏当前导出与搜索契约
  - 怎么验证：
    - `pnpm --filter @x-file/indexer build`
    - `pnpm --filter @x-file/web typecheck`

- [x] 4.25 CSV 从复杂 skip fallback 集合中摘除
  - 状态：DONE
  - 这一步到底做什么：把上一轮的 CSV 默认路由收口做干净。既然 `.csv` 已经默认走轻量文本链，那就不该继续在 `complex_document_skip` 的 fallback 集合里占一个“复杂格式跳过”席位。
  - 做完你能看到什么：parser 能力面和 fallback 语义不再把 CSV 误标成复杂格式应急路径。
  - 先依赖什么：4.24
  - 开始前先看：
    - `packages/indexer/src/parser/complex-document-skip-adapter.ts`
    - `packages/indexer/src/parser/parser-router.ts`
  - 主要改哪里：
    - `packages/indexer/src/parser/complex-document-skip-adapter.ts`
    - `specs/spec003.1-X-File-Indexer-SQLite-Export-Runtime-收口/tasks.md`
  - 这一步先不做什么：不删除 `CsvParserAdapter`，不改 parser router 顺序，不动 Rust native CSV 能力。
  - 实际结果：
    - `.csv` 已从 `complex_document_skip` 支持集合移除。
    - 当前默认 parser 路由下，CSV 只保留轻量文本主路径和可选的复杂 CSV adapter，不再同时挂一个“复杂 skip fallback”影子。
  - 怎么算完成：
    1. CSV 不再被 fallback 能力面误标成复杂 skip
    2. 默认 CSV 主路径保持轻量文本链
    3. 不影响复杂 office/pdf fallback
  - 怎么验证：
    - `pnpm --filter @x-file/indexer build`

- [x] 4.26 默认 allowedExtensions 把 CSV 视为轻量主链一等公民
  - 状态：DONE
  - 这一步到底做什么：把上一轮 CSV 默认路由收口到底。既然 `.csv` 已经默认走轻量链，就不该只在设置页 preset 里出现，而在宿主/服务默认配置里缺席。
  - 做完你能看到什么：新绑定或未显式配置 allowedExtensions 的默认文档库，会把 `.csv` 与 `.md/.markdown/.txt` 一样纳入默认索引集合。
  - 先依赖什么：4.25
  - 开始前先看：
    - `apps/desktop/src-tauri/src/lib.rs`
    - `apps/server/src/library/library-config-service.ts`
    - `apps/server/src/library/library-service.ts`
  - 主要改哪里：
    - `apps/desktop/src-tauri/src/lib.rs`
    - `apps/server/src/library/library-config-service.ts`
    - `apps/server/src/library/library-service.ts`
    - `specs/spec003.1-X-File-Indexer-SQLite-Export-Runtime-收口/tasks.md`
  - 这一步先不做什么：不把默认集合继续扩到 `.json/.html`，不碰复杂 office/pdf 默认值。
  - 实际结果：
    - 桌面宿主默认 allowedExtensions 已补进 `.csv`。
    - Node side 的 library config/service 默认 allowedExtensions 也已补进 `.csv`。
    - 这样默认配置、设置页 preset、Node parser 主链、Rust native 轻量链对 CSV 的态度终于一致，不再出现“某层默认支持、另一层默认忽略”的裂缝。
  - 怎么算完成：
    1. CSV 在默认配置层进入 allowedExtensions
    2. 宿主与 Node service 默认值一致
    3. 不改变复杂格式默认保留策略
  - 怎么验证：
    - `pnpm --filter @x-file/server build`
    - `cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml`

- [x] 4.27 docx/xlsx/pptx 的单文件局部 refresh 补最小原生摘要链
  - 状态：DONE
  - 这一步到底做什么：不去重写完整 openxml 结构化 parser，只给桌面 Rust 原生索引补最小 zip+xml 文本提取，让 `docx/xlsx/pptx` 的单文件 `targetPath` 局部 refresh 也能停留在原生 vertical slice 内。
  - 做完你能看到什么：当 `targetPath` 明确指向一个 `docx/xlsx/pptx` 文件时，宿主会默认优先走 Rust 原生 `index-only -> export-only`，并产出最小 `summary` / 类型标签 / snapshot 记录。
  - 先依赖什么：4.26
  - 开始前先看：
    - `apps/desktop/src-tauri/src/native_index.rs`
    - `apps/desktop/src-tauri/src/lib.rs`
    - `packages/indexer/src/parser/docx-parser-adapter.ts`
    - `packages/indexer/src/parser/xlsx-parser-adapter.ts`
    - `packages/indexer/src/parser/pptx-parser-adapter.ts`
  - 主要改哪里：
    - `apps/desktop/src-tauri/Cargo.toml`
    - `apps/desktop/src-tauri/src/native_index.rs`
    - `apps/desktop/src-tauri/src/lib.rs`
    - `specs/spec003.1-X-File-Indexer-SQLite-Export-Runtime-收口/tasks.md`
  - 这一步先不做什么：不补完整 `structured.blocks`，不接管 openxml 目录级 refresh，不改 Node 侧 parser adapter，不宣称与 Node complex parser 全语义等价。
  - 实际结果：
    - Rust 原生索引已新增最小 zip+xml 文本提取：`docx` 读取 `word/document.xml`，`pptx` 读取 `ppt/slides/*.xml`，`xlsx` 读取 `xl/worksheets/*.xml` + `xl/sharedStrings.xml`。
    - `read_summary()` 现在可为 `docx/xlsx/pptx` 产出最小文本摘要，不再一律空摘要。
    - 宿主已新增保守路由：只有 `targetPath` 明确指向 `docx/xlsx/pptx` 单文件时，才默认优先走 Rust 原生索引；复杂目录和全量链路仍留在 Node。
  - 怎么算完成：
    1. `docx/xlsx/pptx` 单文件 `targetPath` 可原生执行
    2. 能产出最小 `summary` 与既有 snapshot/export 契约
    3. 不扩散到复杂目录或全量默认链路
  - 怎么验证：
    - `cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml`
    - `pnpm --filter @x-file/web typecheck`

- [x] 4.28 纯 openxml 子目录的局部 refresh 也切到原生链
  - 状态：DONE
  - 这一步到底做什么：把 openxml 原生切片从“单文件 targetPath”继续推进到“纯 openxml 子目录 targetPath”，继续压 mixed 复杂目录里的 Node 面积，但不触碰全量或 mixed 子目录。
  - 做完你能看到什么：如果 `targetPath` 指向的子目录里只包含 `docx/xlsx/pptx` 文件，桌面宿主会默认优先走 Rust 原生 `index-only -> export-only`。
  - 先依赖什么：4.27
  - 开始前先看：
    - `apps/desktop/src-tauri/src/lib.rs`
    - `apps/desktop/src-tauri/src/native_index.rs`
  - 主要改哪里：
    - `apps/desktop/src-tauri/src/lib.rs`
    - `specs/spec003.1-X-File-Indexer-SQLite-Export-Runtime-收口/tasks.md`
  - 这一步先不做什么：不接管包含 PDF/其它复杂扩展名的 mixed 子目录，不改 openxml 全量链路，不补完整 structured 输出。
  - 实际结果：
    - 宿主已新增目录级保守判定：当 `targetPath` 指向的目录子树只发现 `docx/xlsx/pptx`，`index-only` 默认优先走 Rust 原生执行器。
    - 只要目录里混入其它复杂扩展名，宿主仍保守留在 Node，不会把复杂 mixed 目录语义做脏。
  - 怎么算完成：
    1. 纯 openxml 子目录 `targetPath` 默认 native
    2. mixed 复杂子目录仍保留 Node
    3. 不影响全量链路
  - 怎么验证：
    - `cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml`
    - `pnpm --filter @x-file/web typecheck`

- [x] 4.29 轻量文本与 openxml 混合子目录的局部 refresh 合并进原生摘要链
  - 状态：DONE
  - 这一步到底做什么：把“纯轻量子目录”和“纯 openxml 子目录”两条保守路由合并成一个更有用的原生摘要子集，只要目录里所有文件都落在 Rust 已支持最小摘要的集合内，就统一走 native。
  - 做完你能看到什么：同一个 `targetPath` 子目录里混合 `md/txt/csv/docx/xlsx/pptx` 这些文件时，也能默认留在 Rust 原生 `index-only -> export-only` vertical slice 内。
  - 先依赖什么：4.28
  - 开始前先看：
    - `apps/desktop/src-tauri/src/native_index.rs`
    - `apps/desktop/src-tauri/src/lib.rs`
  - 主要改哪里：
    - `apps/desktop/src-tauri/src/native_index.rs`
    - `apps/desktop/src-tauri/src/lib.rs`
    - `specs/spec003.1-X-File-Indexer-SQLite-Export-Runtime-收口/tasks.md`
  - 这一步先不做什么：不接管包含 PDF 的 mixed 子目录，不改全量复杂链路，不补复杂 structured 语义。
  - 实际结果：
    - Rust 侧新增 `is_native_summary_extension()`，把“轻量文本/CSV”和“最小 openxml 摘要”统一成一个原生摘要子集。
    - 宿主目录级判定已改成只看这个统一子集：目录里只要全是 `md/markdown/mdx/txt/rtf/html/htm/xml/json/yaml/yml/tsv/csv/docx/xlsx/pptx`，就默认 native。
    - 这样 mixed 子目录里只要还没混入 PDF 或其它未支持复杂格式，就不必回退 Node。
  - 怎么算完成：
    1. 轻量文本 + openxml 混合子目录 `targetPath` 默认 native
    2. 含 PDF 或其它未支持复杂格式的 mixed 子目录仍保留 Node
    3. 不影响单文件与全量链路
  - 怎么验证：
    - `cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml`
    - `pnpm --filter @x-file/web typecheck`
    1. 轻量扩展名集合默认 `index-only` 不再依赖 Node worker
    2. 复杂格式路径继续保留现有 Node 行为
    3. `x-file-runtime` 的剩余保留理由继续收缩到复杂格式与完整索引执行面
  - 怎么验证：
    - `cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml`
    - `pnpm --filter @x-file/web typecheck`
    - `node scripts/verify-desktop.mjs --platform macos --mode preflight`
