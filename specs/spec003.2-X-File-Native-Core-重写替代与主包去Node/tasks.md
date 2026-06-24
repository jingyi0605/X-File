# 任务清单 - spec003.2-X-File-Native-Core-重写替代与主包去Node

状态：进行中

## 阶段 1：冻结契约

- [x] 1.1 建立 exports/runtime/bridge 契约清单
  - 目标：把必须保持不变的文件结构、字段 shape、前端消费路径写成清单
  - 主要看：
    - `apps/web/src/runtime/native-library-bridge.ts`
    - `apps/server/src/storage/library-export-reader.ts`
    - `apps/server/src/storage/library-runtime-status-store.ts`
    - `.ai-index/runtime/*`
    - `.ai-index/exports/*`
  - 完成标准：
    - 有一份明确的“不允许漂移”的契约表
  - 本次完成结果：
    - 已新增 `20260618-阶段1-契约清单.md`，冻结 exports/runtime/bridge/server reader 契约。
    - 已明确：兼容对象是对外契约，不是旧 Node worker 内部层次。

- [x] 1.2 为 `docx/xlsx/pptx/pdf + export/search/runtime-status` 补齐 golden / contract tests
  - 目标：后面重写内核时，能快速验证结果一致
  - 完成标准：
    - 原生 parser / export / runtime-status 有可执行基线
  - 本次完成结果：
    - Rust parser 契约测试继续覆盖 `docx/xlsx/pptx/pdf`。
    - `native_export.rs` 已新增 export manifest / runtime-status 契约测试。
    - `apps/web/src/runtime/native-library-bridge.test.ts` 已新增 bridge 契约测试。
    - `apps/server/src/storage/library-runtime-status-store.test.ts` 已新增 runtime-status 读取契约测试。

- [x] 1.3 冻结前端
  - 目标：明确后续不改样式、不改视觉、不改组件结构
  - 完成标准：
    - 仅允许改 adapter / bridge / host glue
  - 本次完成结果：
    - 本轮未改前端样式、视觉和组件结构。
    - 仅新增 runtime bridge 测试，继续把改动限制在 adapter / bridge / host glue。

## 阶段 2：重写 Native Core

- [x] 2.1 建立 `native_library_state_store`
  - 目标：形成 runtime snapshots 的统一 Rust 真源
  - 完成标准：
    - active/failed/skipped/tag/chunk/document 有统一写入层
  - 本次完成结果：
    - 已新增 `apps/desktop/src-tauri/src/native_core/state_store.rs`。
    - 已统一收口 runtime/export 关键路径，并让 `native_index.rs` / `native_export.rs` 开始消费这层路径真源。
  - 当前不足：
    - tag/chunk/document 细粒度 store 语义仍待继续拆分。

- [x] 2.2 建立 `native_library_index_core`
  - 目标：Rust 直接承接默认 `index-only`
  - 完成标准：
    - 不经 Node sidecar 也能跑完整索引主链
  - 本次完成结果：
    - 已新增 `apps/desktop/src-tauri/src/native_core/index_core.rs`。
    - `apps/desktop/src-tauri/src/lib.rs` 的默认原生 `index-only` 路径已通过 `run_native_library_index_core(...)` 收口。

- [x] 2.3 建立 `native_library_search_core`
  - 目标：Rust 直接承接默认 `search-only`
  - 完成标准：
    - 生成现有 search buckets / manifest
  - 本次完成结果：
    - 已新增 `apps/desktop/src-tauri/src/native_core/search_core.rs`。
    - `apps/desktop/src-tauri/src/lib.rs` 的默认原生 `search-only` 路径已通过 `run_native_library_search_core(...)` 收口。

- [x] 2.4 建立 `native_library_export_core`
  - 目标：Rust 直接承接默认 `export-only`
  - 完成标准：
    - 生成现有 manifest/meta/detail/taxonomy/bootstrap 契约
  - 本次完成结果：
    - 已新增 `apps/desktop/src-tauri/src/native_core/export_core.rs`。
    - `apps/desktop/src-tauri/src/lib.rs` 的默认原生 `export-only` 路径已通过 `run_native_library_export_core(...)` 收口。

- [x] 2.5 建立 `native_library_tag_core`
  - 目标：把 manual binding / identity migration / recompute 真源迁入 Rust
  - 完成标准：
    - 默认 tag 语义不再依赖 Node SQLite 主路径
  - 当前进展：
    - 已新增 `apps/desktop/src-tauri/src/native_core/tag_core.rs`，并把 Tauri tag 命令入口收口为独立 Native Core 边界。
    - 已将 `read_local_tag_recompute_task()`、`write_local_tag_recompute_task()`、`sync_local_tag_exports()`、`build_local_tag_snapshot()` 及相关 tag path resolve / snapshot helper 的核心实现迁入 `native_core/tag_core.rs`，`native_request_library_tag_recompute` / `native_get_library_tag_recompute_task` 也已直接走 `tag_core`。
    - 本轮已继续把 `read_local_library_tags_store()`、`write_local_library_tags_store()`、`local_library_tags_store_key()`、`empty_local_library_tags_store()`，以及 tag CRUD、document/folder binding 持久化与推荐/helper 一并迁入 `native_core/tag_core.rs`。
    - 本轮已继续把 tag 请求体、`LocalStoredTagRuleDraft` 和 `expand_local_tag_ancestor_paths()` 收口到 `native_core/tag_core.rs`。
    - `apps/desktop/src-tauri/src/lib.rs` 当前只剩共享 binding / document model / snapshot 读写等非 tag 专属基础能力；tag 真源、Tauri 命令入口、规则绑定、重算与快照路径已经正式进入 Rust Native Core。
  - 本次完成结果：
    - `native_library_tag_core` 已收尾，`tag_core.rs` 成为 tag 真源主文件。
    - `lib.rs` 不再承载 tag-only 请求体或祖先路径 helper。

## 阶段 3：切默认主链

- [ ] 3.1 让桌面宿主直接驱动 Native Core
  - 目标：不再通过 `apps/server` Node sidecar 发起默认 library 主链
  - 完成标准：
    - desktop host 可直接完成 `index -> search -> export`
  - 当前进展：
    - `apps/web/src/api/library.ts` 的本地模式 `snapshot/documents/files/preview/refresh` 已强制走 native bridge；bridge 缺失时直接报错，不再回退 `/api/library/*`。
    - `apps/server/src/app.ts` 默认 `sidecarProfile` 已切到 `sidecar-only`，并在启动时执行 `clearLibraryDefaultExecutors()`；Node 入口默认不再为 library 主链注册 text/search/export executor。
    - 桌面宿主的 refresh 主链已由 `native_request_library_refresh()` 串起 `index -> export -> search`，默认调度入口位于 `apps/desktop/src-tauri/src/lib.rs`。
    - 本轮已将桌面宿主的 `index-only` 默认路径改成强走 `run_native_library_index_core(...)`，不再默认回退 Node worker。
    - 本轮已将桌面宿主默认 `X_FILE_BACKEND_AUTOSTART` 改成关闭；library 本地主链不再依赖应用启动时顺手拉起 Node sidecar。
  - 当前不足：
    - library 主链的 `index-only -> export-only -> search-only` 现在都已由桌面 Rust core 直驱，且正式包默认不再自动拉起或内置 Node sidecar；但手动启动后端、assistant/provider runtime 与历史兼容残影尚未完全清空，因此这一步还不能宣称桌面宿主整面彻底去 Node。

- [ ] 3.2 前端 local/native bridge 默认只接 Rust 主链
  - 目标：前端仍用现有 shape，但数据来源改为 Rust 真源
  - 完成标准：
    - 前端页面零视觉改动，默认链不经 Node
  - 当前进展：
    - library 本地模式下 `snapshot/documents/files/preview/refresh` 已默认走 native bridge，bridge 缺失时直接失败，不再静默回退 `/api/library/*`。
    - 本轮已继续清掉本地主包里残留的 HTTP sidecar 回退：`apps/web/src/api/library.ts` 的 plugin list/enable/disable、ONLYOFFICE settings/status、http server state，以及 document/folder/tag recompute/tag CRUD 的 native 缺失分支都改成直接报错，不再静默回退 `/api/plugins/*`、`/api/office/*`、`/api/server/state` 或 `/api/library/tags/*`。
    - `apps/web/src/features/assistant/api/assistant.ts` 在 local 模式下已明确拒绝主包内建 assistant Node sidecar；`useDocumentAssistant.ts` 的 pending permission 轮询也已不再直接打 `/api/assistant/*`。
    - `apps/web/src/api/health.ts` 的 local 模式已改成“native health 缺失即失败”，不再回退 `/api/health`。
    - 本轮已把 `LibraryPage` 的主区域骨架条件收紧为“空内容 + 加载中”才阻塞显示，已有内容时刷新不再整页切成骨架遮罩。
  - 当前不足：
    - assistant/provider 功能当前是“主包本地模式禁用内建 Node sidecar，并要求外部 runtime”，还不是 Rust native assistant bridge；因此这一步仍不宣告完全完成，但主包 local 默认链已经不再偷偷依赖内建 HTTP sidecar。

- [x] 3.3 把 Node `*InProcess()` 执行面降为测试/兼容层
  - 目标：不再参与默认路径
  - 完成标准：
    - 默认执行注册不再引用 Node in-process 执行体
  - 本次完成结果：
    - `packages/indexer` 的 executor registry 已改成“默认 executor 未注册时直接报错”，只有显式调用时才允许走 `executeTextIndexInProcess()`、`executeSearchIndexInProcess()`、`buildLibraryExportInProcess()` fallback。
    - `apps/server/src/app.ts` 默认启动已不再注册 text/search/export executor，`apps/server/src/library/library-default-executors.ts` 的默认实现也改为显式抛错，阻止正式主链静默回落到 Node in-process 执行体。

- [x] 3.4 把 `apps/server` library 主路径退成非默认兼容层
  - 目标：Node sidecar 不再承接正式包默认 library 功能
  - 完成标准：
    - 正式包默认运行时不依赖 `apps/server` library 主链
  - 本次完成结果：
    - `apps/server/src/app.ts` 默认总闸已切：启动时执行 `clearLibraryDefaultExecutors()`，且默认 profile 改成 `sidecar-only`。
    - `apps/server/src/library/library-engine-feature.ts` 在 `sidecar-only` 模式下已不再注册真实 `library/tag/host-directory` 路由，而是统一返回 503 placeholder，明确要求正式包默认改走桌面 native bridge。
    - Node sidecar 当前保留的只剩 ONLYOFFICE、plugin、integration、server state 等服务面；`apps/server` 已退成非默认兼容层，不再承担正式包默认 library 核心数据面。

## 阶段 4：删除主包 Node

- [x] 4.1 删除 `x-file-runtime`
  - 目标：正式包不再携带随包 Node runtime
  - 完成标准：
    - 桌面资源校验不再要求 `x-file-runtime`
  - 当前进展：
    - library 主链默认 `index-only` 已强走 Rust core，不再默认回退 Node worker。
    - 桌面宿主默认已不再自动拉起 Node sidecar，且手动启动后端也不再提供宿主内建 Node 默认入口。
    - `apps/desktop/src-tauri/tauri.conf.json` 已去掉 `resources/x-file-runtime` 正式包资源映射。
    - `apps/desktop/src-tauri/resources/x-file-resource-boundary.json` 已删除 `x-file-runtime` 资源声明，并新增“正式包默认不再内置 Node sidecar”策略说明。
    - `scripts/archive/20260616/prepare-bundled-server.mjs` 已改成默认主动清理 `resources/x-file-runtime` 目录，不再为主包准备 runtime 产物。
    - `scripts/verify-desktop.mjs` 已不再把 `x-file-runtime` 当正式包强校验项；目录残留时仅给 warning。
  - 当前不足：
    - artifacts 级正式产物验证仍待补齐，但主包资源声明、默认 prepare 产物、宿主默认入口与 preflight 校验都已不再包含 runtime。

- [x] 4.2 删除 `x-file-server`
  - 目标：正式包不再携带 Node sidecar 主入口
  - 完成标准：
    - 主包运行不再需要 `x-file-server/dist/main.js`
  - 当前进展：
    - `apps/desktop/src-tauri/tauri.conf.json` 已从正式包 `bundle.resources` 移除 `resources/x-file-server`。
    - `apps/desktop/src-tauri/resources/x-file-resource-boundary.json` 已删除 `x-file-server` 资源声明，并把 `desktopHost.nodeSidecar.profileInMainBundle` 改成 `none`。
    - `scripts/verify-desktop.mjs` 已不再要求 `x-file-server/dist/main.js` 存在；目录残留时仅给 warning。
    - `scripts/archive/20260616/prepare-bundled-server.mjs` 已改成默认主动清理 `resources/x-file-server` 目录，不再为主包准备 sidecar 主入口。
    - `apps/desktop/src-tauri/src/lib.rs` 已停止扫描随包 `x-file-server` backend entry，且不再提供宿主默认 `node + server/dist/main.js` 启动参数。
  - 当前不足：
    - `apps/server` 代码库本体与 sidecar 服务面仍然存在，但它们已退出主包默认资源链；后续阻塞转移到 assistant/provider runtime 的主包外部化。

- [x] 4.3 删除 `x-file-library-engine` 兼容壳
  - 目标：清理历史资源残影
  - 完成标准：
    - resource boundary / verify / scripts 不再依赖兼容壳
  - 当前判断：
    - `x-file-library-engine` 已从正式包资源、宿主 fallback、verify 规则和物理资源目录中移除，当前只剩仓库里非主包路径上的历史代码等待后续代码库清扫。

- [x] 4.4 assistant/provider runtime 切到主包外部可选 sidecar
  - 目标：主包不再为 provider runtime 保留 Node 执行面
  - 完成标准：
    - 主包完整可运行，provider runtime 为外部可选
  - 本次完成结果：
    - `packages/shared/src/assistant-plugin-types.ts` 已将 assistant runtime bridge 收口为 `external-sidecar-runtime`。
    - `apps/server/src/plugins/plugin-backend-loader.ts` 已固定拒绝 legacy backend 入口，并只接受 descriptor + external sidecar runtime bridge。
    - `plugins/claude-code-integration/manifest.json` 与 `plugins/codex-integration/manifest.json` 已全部改为 external sidecar runtime。
    - `provider-runtime-sidecar` 入口实现已从 `apps/server/src/assistant/` 迁出到 `packages/session-sync-core/src/runtime/provider-runtime-sidecar.ts`，server 不再拥有这份 sidecar 实现源码。
    - `packages/session-sync-core/src/runtime/external-sidecar-runtime.ts` 已补齐 `permissionProtocol` 与 `adapterOptions` 的 sidecar 环境透传；`plugin-backend-loader` 也已把 descriptor 上的 permission protocol 正确传入 `ExternalSidecarRuntimeAdapter`。
    - `plugin-backend-loader`、`assistant-runtime-plugin-chain`、`assistant-routes`、`plugin-routes`、`provider-runtime-sidecar` 相关测试已实跑通过。

- [x] 4.5 跑完整验证
  - 目标：证明主包彻底无 Node 后仍可运行
  - 完成标准：
    - `cargo check`
    - Rust tests
    - web typecheck
    - desktop preflight / artifacts verify
    - 明确“已删除哪些 Node 资源和执行面”
  - 本次完成结果：
    - `cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml` 通过。
    - `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml native_` 通过。
    - `pnpm --filter @x-file/server typecheck` 通过。
    - `pnpm --filter @x-file/web typecheck` 通过。
    - `pnpm --filter @x-file/web test -- src/runtime/native-library-bridge.test.ts src/features/assistant/components/AssistantPermissionList.test.tsx src/features/library/__tests__/LibraryPage.test.tsx src/features/settings/__tests__/SettingsPage.test.tsx` 通过。
    - `pnpm --filter @codingns/session-sync-core build` 通过。
    - `node --test packages/session-sync-core/tests/provider-runtime-sidecar.test.mjs` 通过。
    - `pnpm --filter @x-file/server test -- src/plugins/plugin-backend-loader.test.ts` 通过。
    - `pnpm --filter @x-file/library-engine typecheck` 通过。
    - `pnpm --filter @x-file/library-engine build` 通过。
    - `pnpm run prepare:bundled-server` 通过；当前已改走 `bash scripts/archive/20260616/prepare-bundled-server.sh`，不再由 `tauri.conf.json` 直接调用 `node ...prepare-bundled-server.mjs`。
    - `node scripts/verify-desktop.mjs --platform macos --mode preflight` 通过。
    - `bash scripts/package-desktop.sh macos` 通过，生成 `apps/desktop/src-tauri/target/release/macos-release/X-File.dmg`。
    - `node scripts/verify-desktop.mjs --platform macos --mode artifacts` 通过。
    - `apps/desktop/src-tauri/target/universal-apple-darwin/release/bundle/macos/` 下已产出 `.app.tar.gz` 与 `.sig` updater 产物。
  - 当前说明：
    - Windows artifacts 本轮未在本机实跑，但 `.github/workflows/x-file-windows-build.yml` 与 `.github/workflows/desktop-release.yml` 已统一切到 `bash scripts/package-desktop.sh ...` / `pnpm run verify:desktop ...`，并修正了 Windows bundle 上传路径，避免 CI 继续依赖旧入口或漏传真实产物。

## 当前阶段结论

- [x] 阶段 1 已完成
  - 契约清单、golden/contract tests 与前端冻结边界都已落盘，后续 Native Core 重写已有稳定对照面。

- [x] 阶段 2 已完成到 2.4
  - `state_store / index_core / search_core / export_core` 已建立并接入默认主链。

- [x] 阶段 2.5 已完成
  - `native_library_tag_core` 已收口，tag 真源、请求体、共享 helper 与重算路径都已迁入 Rust。

- [x] 阶段 3 的 3.3、3.4 已完成
  - Node `*InProcess()` 与 `apps/server` library 主路径都已降到非默认兼容层。

- [x] 阶段 4 已完成到 4.5
  - `x-file-runtime`、`x-file-server`、`x-file-library-engine` 已退出主包正式资源链。
  - `assistant/provider runtime` 已收敛为 external sidecar，且 sidecar 入口实现已迁出 `apps/server`。
  - 打包前置已改走 `prepare-bundled-server.sh`，不再由 `tauri.conf.json` 直接硬绑 `node ...prepare-bundled-server.mjs`。
  - macOS preflight 与 artifacts 级验包已完成，主包当前默认链已不再依赖随包 Node 资源。

- [ ] 3.5 处理本地刷新期间的非阻塞加载体验
  - 目标：已有内容时刷新不再被整页骨架屏阻塞
  - 完成标准：
    - 刷新时主区域保留已有内容，加载态不再整块吞掉可点击区域
  - 当前进展：
    - `LibraryPage` 已把主区域骨架条件收紧为“空内容 + loading/documentsLoading”才显示。
    - 这次修复只改行为，不改视觉结构。
