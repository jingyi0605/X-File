# 设计文档 - spec003.2-X-File-Native-Core-重写替代与主包去Node

状态：Draft

## 1. 概述

### 1.1 核心判断

✅ 值得做：直接重写底层执行内核。  
❌ 不值得继续长期维护旧 Node 数据面 + fallback + 兼容壳的渐进拼接结构。

当前真正目标不是“Node 越来越薄”，而是：

- 主包无 Node
- 功能不变
- 导出结构不变
- 前端消费契约不变
- UI 样式完全不变

这本质上是**内核替换问题**，不是继续修补兼容层问题。

### 1.2 复用资产

这次重写不会推翻之前所有工作，以下资产直接复用：

1. Native parser 路由与契约测试
2. runtime snapshots 真源雏形
3. native export/search 已有能力
4. desktop host / native bridge / resource boundary / verify 脚本
5. assistant/plugin ABI 收口成果
6. 前端现有 local/native bridge shape

真正会被放弃的是这些“过渡层”：

1. Node sidecar library 主调度层
2. Node worker 兼容 transport
3. `executeTextIndexInProcess()` / `executeSearchIndexInProcess()` / `buildLibraryExportInProcess()`
4. 旧 SQLite 默认执行真源地位

## 2. 必须保留的对外契约

### 2.1 文件与目录契约

- `runtime-status.json`
- `.ai-index/runtime/active-file-state-snapshot.json`
- `.ai-index/runtime/index-state.json`
- `.ai-index/runtime/tag-state-snapshot.json`
- `.ai-index/runtime/export-catalog-snapshot.json`
- `.ai-index/exports/manifest.json`
- `.ai-index/exports/meta/*`
- `.ai-index/exports/detail/*`
- `.ai-index/exports/search/*`
- `.ai-index/exports/taxonomy/*`
- `.ai-index/exports/bootstrap/*`

### 2.2 前端消费契约

- `apps/web/src/runtime/native-library-bridge.ts` 当前返回 shape
- local 模式 library/tag/search/preview 当前数据形状
- 现有页面视觉、布局、样式 token 完全不变

### 2.3 配置契约

- `.x-file/library-binding.json`
- 现有 library config 相对路径规则
- 现有 `.ai-index/*` 目录约定

## 3. 新的 Rust Native Core 模块

### 3.1 `native_library_index_core`

职责：

- 文件扫描
- parser 路由
- 文本/summary/structured 产出
- skip/failure/status 更新
- dirty scope 计算
- runtime snapshot 写入

替代：

- `TextIndexer`
- `library-index-worker.ts`
- Node worker 内部 index-only 主执行面

### 3.2 `native_library_search_core`

职责：

- 从 runtime/export snapshot 构建 search buckets
- 写 `search manifest / buckets`

替代：

- `SearchIndexBuilder` 默认主执行面

### 3.3 `native_library_export_core`

职责：

- 生成完整 exports 契约
- 写 `manifest / meta / detail / taxonomy / bootstrap / relation / search`

替代：

- `ExportBuilder` 默认主执行面

### 3.4 `native_library_state_store`

职责：

- active files
- failed / skipped / parser skips
- document identity
- chunk/document/tag 状态真源

替代：

- 默认 Node SQLite 真源地位

### 3.5 `native_library_tag_core`

职责：

- manual binding
- identity migration
- orphan cleanup
- tag recompute 输入输出
- tag runtime snapshot 真源

替代：

- `TextIndexTagStore` 的 Node/SQLite 主语义路径

### 3.6 `native_provider_runtime_host`

职责：

- 主包仅保留 runtime host bridge
- provider runtime 下沉为外部可选 sidecar

替代：

- 主包内默认 Node provider runtime

## 4. 可一次性废掉的 Node 层

### 4.1 Library 主调度层

- `apps/server/src/library/library-worker-executor.ts`
- `library-index-worker.ts`
- `library-search-worker.ts`
- `library-export-worker.ts`
- `index-service.ts` 中和 Node worker 绑定的主路径

### 4.2 默认 in-process 兼容执行面

- `executeTextIndexInProcess()`
- `executeSearchIndexInProcess()`
- `buildLibraryExportInProcess()`

### 4.3 主包 Node 资源

- `x-file-runtime`
- `x-file-server`
- `x-file-library-engine`

### 4.4 主包内 provider Node runtime

- 内嵌 provider runtime 默认执行面

## 5. 四阶段落地方案

### 阶段 1：冻结契约

目标：

- 钉死 exports/runtime/bridge 契约
- 冻结前端样式和视觉
- 补 golden tests / contract tests

产出：

- 契约清单
- 验收基线

### 阶段 2：重写 Native Core

目标：

- 建立新的 Rust `index/search/export/state/tag` core
- 在不经过 Node sidecar 的情况下跑通完整主链

产出：

- 可运行的 Native Core
- 默认主链输出契约一致

### 阶段 3：切换默认主链

目标：

- 前端 / desktop host 默认走 Rust 主链
- Node 降为非默认兼容层

产出：

- `apps/server` 不再承接正式包 library 主路径
- `*InProcess()` 仅测试/兼容可见

### 阶段 4：删除主包 Node

目标：

- 删除 `x-file-runtime`
- 删除 `x-file-server`
- 删除 `x-file-library-engine`
- 更新验包和发布链

产出：

- 主包物理无 Node
- 桌面验证通过

## 6. 风险

### 6.1 真风险

1. 误把旧内部实现细节当成必须兼容对象
2. Native Core 输出与前端当前消费 shape 漂移
3. 迁移过程混用两套真源，导致状态不一致

### 6.2 控制策略

1. 只兼容对外契约，不兼容旧内部层次
2. 先 golden tests，再切主链
3. 每阶段必须明确“单一真源”

## 7. 最终判断

当前最正确的路线已经不是继续慢慢拆旧 Node 壳，而是：

1. 保住对外契约
2. 重写 Rust Native Core
3. 切默认主链
4. 物理删除主包 Node

这是一次内核替换，不是无限兼容修补。
