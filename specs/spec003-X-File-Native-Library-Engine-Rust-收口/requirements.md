# 需求文档 - spec003-X-File-Native-Library-Engine-Rust-收口

状态：Draft

## 简介

spec002 已经把主包边界切干净了一半：

- assistant / CLI 不再进入正式安装包
- Integration Plugin 模型已经建立
- 正式包只剩文档库核心相关资源

但现在真正卡体积的不是前端，也不是 Tauri 壳，而是完整 Node runtime 还随包存在。

本 Spec 要继续推进第二刀：

- 把当前仍挂在 Node sidecar 上的“控制面”能力先收口到 Rust / Tauri commands
- 逐步把 `health / snapshot / refresh 调度 / watcher 生命周期` 从 Node 宿主剥离
- 在不破坏文档库主链路和插件边界的前提下，为后续继续去掉完整 Node runtime 铺路

## 范围说明

### In Scope

- 盘清当前 desktop、library-engine、打包脚本与 Tauri resources 的真实依赖链
- 新建 `spec003`
- 建立 `native library bridge`
- 把 `health / snapshot / refresh 调度 / watcher 生命周期` 中至少一条真正切到 Rust / Tauri commands
- 保持前端在桌面本地模式下可通过 native bridge 调用对应能力
- 更新打包验证与依赖边界说明

### Out of Scope

- 本轮不要求一次性把 `indexer + sqlite + export` 全部重写成 Rust
- 本轮不重做 Integration Plugin 系统
- 本轮不把 assistant / CLI 重新接回主包
- 本轮不强求正式包已经 100% 移除 Node runtime，但必须让下一步迁移边界更清楚、更窄

## 需求

### 需求 1：必须先确认真实依赖边界，不能靠想象迁移

#### 验收标准

1. WHEN 开始 spec003 THEN System SHALL 明确当前 desktop 如何拉起 `x-file-library-engine`。
2. WHEN 盘点 `library-engine` THEN System SHALL 明确 `indexer / sqlite / watcher / export` 当前分别落在哪一层。
3. WHEN 检查打包链 THEN System SHALL 明确 `tauri.conf.json`、Rust 宿主、`scripts/package-desktop.sh`、`prepare-bundled-server` 与 archive 脚本的真实依赖关系。

### 需求 2：本轮必须落一个真正可运行的 native vertical slice

#### 验收标准

1. WHEN 桌面应用运行在本地模式 THEN System SHALL 至少有一条文档库控制面链路通过 Tauri commands/Rust 承担，而不是继续全走 Node HTTP。
2. WHEN native vertical slice 被启用 THEN System SHALL 保持现有产品边界不变，不破坏文档库核心内置定位。
3. WHEN 本轮无法完全移除 Node runtime THEN System SHALL 至少把后续最值钱的收口点继续缩小。

### 需求 3：watcher 生命周期必须停止“假装已经 native 化”

#### 验收标准

1. WHEN `engine health` 返回 watcher 状态 THEN System SHALL 反映真实 watcher 宿主状态，而不是硬编码 `true`。
2. WHEN 用户绑定或刷新本地资料库 THEN System SHALL 可以由 native 宿主控制 watcher 的启动、停止、重绑和状态查询。
3. WHEN watcher 触发变更 THEN System SHALL 通过现有 refresh 机制调度刷新，而不破坏现有索引数据面。

### 需求 4：前端必须能消费新的 native bridge，而不是只写后端代码

#### 验收标准

1. WHEN 前端运行在 Tauri 桌面环境且本地模式启用 THEN System SHALL 可以优先走 native bridge 获取 health / snapshot / refresh / watcher 状态。
2. WHEN 前端不在 Tauri 环境或处于 mirror 模式 THEN System SHALL 保持现有 HTTP 行为，不破坏兼容路径。

### 需求 5：必须提供可验证结果

#### 验收标准

1. WHEN 本轮结束 THEN System SHALL 明确哪些链路已经 native 化。
2. WHEN 本轮结束 THEN System SHALL 明确哪些链路仍临时保留 Node。
3. WHEN 本轮结束 THEN System SHALL 给出测试、typecheck、打包验证和依赖链变化的真实结果。

## 成功定义

- `spec003` 已建立并进入执行
- 至少一条 native vertical slice 已落代码并可验证
- watcher 不再是假健康状态
- 前端在桌面本地模式下已经能消费新的 native bridge
- 后续继续砍 `x-file-runtime` 的迁移边界更清楚
