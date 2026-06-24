# 需求文档 - spec003.2-X-File-Native-Core-重写替代与主包去Node

状态：Draft

## 简介

当前仓库已经完成大量“渐进收口”工作，但仍残留以下主包 Node 依赖：

- `apps/server` Node sidecar 主调度层
- `index/search/export` 显式 Node in-process 兼容执行面
- `better-sqlite3 / node:sqlite` 兼容层
- assistant/provider runtime 的 Node 执行面

继续沿旧架构逐层拆壳，成本高且容易没完没了。  
本 Spec 直接改路线：

**重写 Native Core，只兼容对外契约和用户可见行为，不继续兼容旧 Node 内部实现结构。**

## 范围说明

### In Scope

- 定义必须保留的对外契约
- 新建 Rust Native Core 模块边界
- 让桌面宿主直接承接默认 `index/search/export`
- 规划并执行主包去 Node 的四阶段迁移
- 明确哪些旧 Node 层可以一次性退役

### Out of Scope

- 不改变前端样式、页面结构、设计 token
- 不重做 web UI
- 不重做 preview / office 已完成模块
- 不重做已经稳定的前端 bridge shape

## 需求

### 需求 1：必须保留现有对外契约

#### 验收标准

1. WHEN Native Core 替代旧 Node 执行面 THEN System SHALL 保持 `runtime-status.json` 契约不变。
2. WHEN Native Core 生成导出产物 THEN System SHALL 保持 `.ai-index/exports/manifest.json`、`meta shards`、`detail shards`、`taxonomy`、`bootstrap`、`search` 契约不变。
3. WHEN 前端继续消费本地产物与 bridge THEN System SHALL 保持 local/native 模式返回 shape 不变。
4. WHEN 用户使用当前前端页面 THEN System SHALL 不要求修改现有样式、视觉和组件结构。

### 需求 2：必须建立新的 Rust Native Core

#### 验收标准

1. WHEN 开始重写 THEN System SHALL 把新的执行内核划分为独立 Rust 模块，而不是继续散在 host glue 与兼容层中。
2. WHEN Native Core 完成默认主链 THEN System SHALL 直接承接 `index/search/export`，不再依赖 Node sidecar 主调度。
3. WHEN Native Core 承接状态与产物生成 THEN System SHALL 直接维护 runtime snapshots 与 exports 真源。

### 需求 3：必须明确并清除可废弃的 Node 层

#### 验收标准

1. WHEN 新内核主链可运行 THEN System SHALL 明确哪些 `apps/server` library 相关层可以整体退役。
2. WHEN 新内核主链可运行 THEN System SHALL 明确哪些 `*InProcess()` Node 兼容执行面可以删除。
3. WHEN SQLite 真源迁移完成 THEN System SHALL 明确 `better-sqlite3 / node:sqlite` 哪些路径可以删除或降为离线兼容层。
4. WHEN assistant/provider runtime 完成主包边界切换 THEN System SHALL 明确主包内哪些 Node runtime 不再需要保留。

### 需求 4：必须分阶段落地到“主包彻底无 Node”

#### 验收标准

1. WHEN 进入阶段 1 THEN System SHALL 冻结对外契约并补足验收基线。
2. WHEN 进入阶段 2 THEN System SHALL 建立可运行的 Native Core，并完成 `index/search/export` 主链替代。
3. WHEN 进入阶段 3 THEN System SHALL 切换默认主链到 Rust 宿主直驱，Node 降为非默认兼容层。
4. WHEN 进入阶段 4 THEN System SHALL 删除主包内 `x-file-runtime` 及其依赖资源，并通过桌面验证。

### 需求 5：必须给出真实可验证结果

#### 验收标准

1. WHEN 每阶段结束 THEN System SHALL 明确“已经物理删掉了哪些 Node 依赖”。
2. WHEN 每阶段结束 THEN System SHALL 明确“仍然保留哪些 Node 依赖，以及为什么”。
3. WHEN 每阶段结束 THEN System SHALL 提供真实构建、测试、桌面验包结果。

## 成功定义

- 新 Native Core 方案已经替代“继续拆旧 Node 壳”成为主路线
- 前端样式和页面视觉零变化
- 默认 `index/search/export` 主链由 Rust 承接
- 主包最终不再依赖 `x-file-runtime`
