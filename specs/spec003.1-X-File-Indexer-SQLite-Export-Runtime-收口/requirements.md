# 需求文档 - spec003.1-X-File-Indexer-SQLite-Export-Runtime-收口

状态：Draft

## 简介

`spec003` 已经把桌面文档库前台控制面开始从 Node sidecar 手里拿回来，但这还不够。

真正决定正式包能不能去掉完整 Node runtime 的，是后台重任务链路：

- `LibraryIndexService`
- `runLibraryIndexOnce`
- `better-sqlite3`
- `TextIndexer`
- `ExportBuilder`

现在这条链仍然全部挂在 Node 进程里，所以 `tauri.conf.json` 和归档脚本还必须把 `x-file-library-engine + x-file-runtime` 一起塞进正式包。

本 Spec 要推进第三刀：

- 先盘清 `indexer / sqlite / export` 的真实依赖边界
- 先把调度层和状态层从“必须靠 Node 宿主”收口成“Rust/Tauri 可控”
- 如果一轮做不到把 SQLite 和全文索引全部改写成 Rust，也必须先把 Node runtime 的必要范围继续缩小

## 范围说明

### In Scope

- 盘清 `LibraryIndexService -> runLibraryIndexOnce -> sqlite/index/export` 的真实调用链
- 明确 `runtime-status.json`、`.ai-index/exports/*`、SQLite catalog 的产物和状态边界
- 新建 `spec003.1`
- 落一版最小可运行的“数据面收口切片”
- 优先收 `index/export` 的 orchestration、状态推进或宿主边界
- 更新打包依赖链说明，明确 `x-file-runtime` 还因什么保留

### Out of Scope

- 本轮不强求一次性把全文索引算法完整重写成 Rust
- 本轮不重做前端 preview / office UI
- 本轮不动 assistant / CLI / Integration Plugin 边界
- 本轮不承诺正式包已经完全删掉 Node runtime，但必须把其必要范围继续压缩

## 需求

### 需求 1：必须把数据面真实依赖边界说清楚

#### 验收标准

1. WHEN 开始 `spec003.1` THEN System SHALL 明确 `LibraryIndexService` 当前只是调度层，而真正执行层落在 `@x-file/indexer`。
2. WHEN 盘点 `indexer / sqlite / export` THEN System SHALL 明确谁负责 `runtime-status.json`、SQLite catalog 和 `.ai-index/exports/*` 的生成。
3. WHEN 检查打包链 THEN System SHALL 明确 `x-file-runtime` 当前是因哪些数据面依赖还必须随包保留。
4. WHEN 检查桌面资源映射 THEN System SHALL 明确 `x-file-library-engine`、`x-file-runtime`、`x-file-plugins` 的主包用途、宿主查找优先级，以及 `better-sqlite3.node` 当前随哪条资源链进入正式包。

### 需求 2：本轮必须落一个真正可运行的数据面收口切片

#### 验收标准

1. WHEN 桌面本地模式触发文档库刷新 THEN System SHALL 至少有一段 `index/export` 相关的 orchestration 或宿主链路不再依赖 Node HTTP 控制面。
2. WHEN 本轮无法彻底替换 `better-sqlite3` 或全文索引 THEN System SHALL 仍然把 Node 的职责压缩到更窄的 worker 边界。
3. WHEN 新切片落地 THEN System SHALL 不破坏现有文档库刷新、导出和前台读取主链路。

### 需求 3：状态与产物边界必须继续稳定

#### 验收标准

1. WHEN 索引任务运行 THEN System SHALL 继续正确推进 `runtime-status.json` 的状态、阶段和进度。
2. WHEN 导出产物生成 THEN System SHALL 保持 `.ai-index/exports/manifest.json`、`meta shards`、`taxonomy`、`bootstrap` 等现有消费契约不破坏。
3. WHEN 本轮引入 Rust/Tauri 新宿主 THEN System SHALL 保持前台 `snapshot / documents / files / preview` 对现有导出结构的兼容。

### 需求 4：必须提供真实验证结果

#### 验收标准

1. WHEN 本轮结束 THEN System SHALL 明确哪些 `indexer / sqlite / export` 链路已经收口。
2. WHEN 本轮结束 THEN System SHALL 明确哪些部分仍然必须暂时依赖 Node。
3. WHEN 本轮结束 THEN System SHALL 给出真实的 `cargo check`、`typecheck`、相关测试和桌面预检结果。

## 成功定义

- `spec003.1` 已建立并进入执行
- `indexer / sqlite / export` 的依赖边界被明确写清
- 至少一条数据面 vertical slice 已开始落代码
- `x-file-runtime` 的保留原因被收缩而不是继续模糊
