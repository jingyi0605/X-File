# 需求文档 - spec002-X-File内置文档引擎与集成插件化

状态：Draft

## 简介

X-File 当前桌面包的主要问题，不是前端太大，也不是 Tauri 壳太重，而是打包边界错了。

现在安装程序把这些东西一起带上了：

- 文档库前端页面
- Tauri 桌面壳
- 内置 Node runtime
- Fastify HTTP 后端
- 索引、SQLite、watcher、export
- assistant / codex / claude 相关运行时与桥接依赖

这会带来三个直接问题：

1. 安装包体积过大，发布成本高。
2. 文档库核心能力和 assistant/CLI 集成能力没有边界，导致主包承担了不必要的依赖。
3. 后续想做插件化时，主 APP、内置能力、可选扩展之间没有清晰分层。

本 Spec 要把边界重新切干净：

- 文档库核心引擎是主 APP 的内置能力，继续随安装程序交付。
- assistant / CLI 不是主包能力，而是可选安装的 Integration Plugin。
- 插件系统只保留一层：主 APP + Integration Plugin，不引入多层插件体系。

## 术语表

- **System**：`X-File`
- **主 APP**：用户安装得到的正式桌面应用，包含桌面壳、前端和必须内置的文档库能力。
- **内置文档引擎 sidecar**：随主 APP 一起交付的本地执行组件，负责索引、SQLite、watcher、export 等重任务。
- **Integration Plugin**：运行后可安装的集成插件，只负责接入外部 CLI / provider / UI 入口，不进入正式安装程序。
- **插件注册表**：主 APP 本地维护的已安装插件清单、版本、启用状态和权限声明。
- **文档库核心链路**：绑定、索引、SQLite、导出、watcher、快照、列表、预览、文件操作等主功能。
- **assistant / CLI 能力**：Codex、Claude Code 等需要依赖本机 CLI、登录态和会话桥接的可选能力。

## 范围说明

### In Scope

- 把 X-File 当前“随包 Node 后端”改造成主 APP 内置 sidecar 承担文档库核心重任务。
- 明确并落地文档库核心引擎的内置范围：`indexer + sqlite + watcher + export`。
- 调整主 APP 与内置 sidecar 的接口边界、生命周期和错误恢复。
- 从正式安装程序中移除 assistant / CLI 运行时及其依赖。
- 建立单层插件模型：主 APP + Integration Plugin。
- 支持应用运行后安装、启用、停用、升级和卸载 Integration Plugin。
- 支持 assistant / CLI 作为 Integration Plugin 接入，但不要求进入主安装包。
- 为后续 Codex / Claude Code Integration Plugin 预留统一清单、权限和健康检查入口。

### Out of Scope

- 不把插件系统设计成三层或 marketplace 平台。
- 不在本 Spec 内实现云端插件商店、账户体系或远程授权体系。
- 不把文档库核心能力也做成可卸载插件。
- 不要求本 Spec 一次性把全部后端从 Node 重写成 Rust。
- 不在本 Spec 内新增全新 assistant 产品能力，只处理解耦和接入方式。
- 不修改 CodingNS 仓库的外部接入逻辑，除非为了兼容已经存在的 X-File API。

## 需求

### 需求 1：主 APP 必须只内置文档库真正必需的核心能力

**用户故事：** 作为维护者，我希望正式安装程序只包含文档库运行必须的能力，以便控制体积和发布复杂度。

#### 验收标准

1. WHEN 构建正式桌面安装程序 THEN System SHALL 只内置文档库核心链路所需的能力，而不再包含 assistant / CLI 相关运行时。
2. WHEN 用户安装并启动 X-File THEN System SHALL 在没有任何插件的情况下完成文档库主链路，包括绑定、索引、列表、预览、下载和刷新。
3. WHEN 内置文档引擎执行索引、watcher、export 或 SQLite 操作 THEN System SHALL 由内置 sidecar 承担，而不是继续把整套通用 Node 后端随包塞进安装程序。

### 需求 2：内置文档引擎 sidecar 必须承担文档库重任务并对主 APP 暴露稳定接口

**用户故事：** 作为应用开发者，我希望文档库重任务被隔离到稳定的本地引擎里，以便主 APP 更轻、更稳、更容易维护。

#### 验收标准

1. WHEN 主 APP 触发全量索引、增量刷新、watcher 合并刷新或导出 THEN System SHALL 通过内置 sidecar 执行。
2. WHEN 主 APP 只是读取快照、列表或预览元信息 THEN System SHALL 不在读请求里同步触发重任务。
3. WHEN sidecar 启动失败、崩溃或健康检查失败 THEN System SHALL 给主 APP 返回可诊断错误，并保留最近一次可读结果。
4. WHEN sidecar 需要重启 THEN System SHALL 有明确的启动、停止、重试和状态同步机制，而不是让前端卡死在无响应状态。

### 需求 3：assistant / CLI 能力必须完全从安装程序中移除

**用户故事：** 作为发布维护者，我希望 assistant / CLI 不再进入正式安装包，以便避免把非核心依赖强塞给所有用户。

#### 验收标准

1. WHEN 构建正式安装程序 THEN System SHALL 不打包 Codex、Claude Code、session-sync-core 及其相关运行时依赖。
2. WHEN 用户首次安装并启动 X-File THEN System SHALL 默认看不到已启用的 assistant / CLI 能力，除非后续手动安装对应插件。
3. WHEN 用户未安装任何 Integration Plugin THEN System SHALL 不影响文档库主链路使用。

### 需求 4：插件系统只允许一层模型：主 APP + Integration Plugin

**用户故事：** 作为架构维护者，我希望插件模型保持最小复杂度，以便避免把系统做成无法维护的嵌套平台。

#### 验收标准

1. WHEN System 加载插件 THEN System SHALL 只识别一层 Integration Plugin，不引入 plugin of plugin、plugin runtime 或多级宿主结构。
2. WHEN 插件声明能力 THEN System SHALL 通过统一 manifest 和本地注册表管理，而不是在不同插件类型之间分裂协议。
3. WHEN 后续新增 assistant / CLI 集成 THEN System SHALL 继续沿用同一套 Integration Plugin 机制，而不是再加第二套扩展系统。

### 需求 5：Integration Plugin 必须支持运行后安装和更新

**用户故事：** 作为用户，我希望在应用运行后按需安装和更新 assistant / CLI 集成，而不是每次都重装主程序。

#### 验收标准

1. WHEN 用户在主 APP 内安装 Integration Plugin THEN System SHALL 下载、校验、解压并注册插件到 bundle 外部目录。
2. WHEN 插件安装成功 THEN System SHALL 让主 APP 能发现并启用该插件，而不要求重装主程序。
3. WHEN 插件有新版本 THEN System SHALL 支持插件级更新，并保留失败回滚能力。
4. WHEN 插件被禁用或卸载 THEN System SHALL 停止暴露该插件对应的集成入口，但不影响文档库主链路。

### 需求 6：Integration Plugin 必须受控声明权限和健康状态

**用户故事：** 作为维护者，我希望插件不是黑盒脚本，而是有清单、权限和健康检查的受控扩展。

#### 验收标准

1. WHEN 插件安装或升级 THEN System SHALL 读取 manifest 中的插件 ID、版本、入口、权限和兼容约束。
2. WHEN 插件请求访问文档库、启动外部 CLI、读写本地状态或暴露 UI 入口 THEN System SHALL 按 manifest 能力声明进行控制。
3. WHEN 插件初始化失败、命令探测失败或登录态缺失 THEN System SHALL 在插件状态里给出明确错误，而不是让主界面静默失效。
4. WHEN 插件升级导致能力范围扩大 THEN System SHALL 要求重新确认或重新授权。

### 需求 7：assistant / CLI Integration Plugin 必须优先复用本机已安装能力

**用户故事：** 作为用户，我希望安装插件后直接接入本机已有 Codex / Claude Code，而不是再被主 APP 捆绑一套运行时。

#### 验收标准

1. WHEN 用户安装 Codex 或 Claude Code Integration Plugin THEN System SHALL 优先探测本机已有 CLI 和登录态。
2. WHEN 本机 CLI 或登录态缺失 THEN System SHALL 返回清楚的诊断结果和安装指引，而不是把 provider runtime 偷偷塞进主包。
3. WHEN 插件运行 THEN System SHALL 只负责接入、桥接和 UI 暴露，不把 provider runtime 当主 APP 内置能力处理。

## 非功能需求

### 非功能需求 1：体积与分发

1. WHEN 构建正式安装程序 THEN System SHALL 显著降低非核心依赖占比，避免 assistant / CLI 依赖继续进入主包。
2. WHEN 插件安装或更新 THEN System SHALL 不修改已签名主 APP bundle 内部内容，插件内容必须落在 bundle 外部目录。

### 非功能需求 2：可靠性

1. WHEN 内置 sidecar 启动失败或异常退出 THEN System SHALL 提供明确健康状态、最近错误和恢复动作。
2. WHEN 插件安装包校验失败、入口缺失或版本不兼容 THEN System SHALL 拒绝启用该插件并保留可读错误。
3. WHEN 插件更新失败 THEN System SHALL 能回滚到上一版本，而不是把主 APP 一起拖挂。

### 非功能需求 3：可维护性

1. WHEN 后续继续演进文档库引擎 THEN System SHALL 保持主 APP 与 sidecar 的边界稳定，不把重任务重新塞回 UI 或主进程。
2. WHEN 后续新增更多 assistant / CLI 集成 THEN System SHALL 继续复用同一套 Integration Plugin manifest、注册表和状态机制。
3. WHEN 调试打包问题或依赖膨胀 THEN System SHALL 能清楚区分“主 APP 内置能力”和“插件可选能力”。

## 成功定义

- 正式安装程序不再包含 assistant / CLI 运行时及相关依赖。
- 文档库主链路在无插件条件下仍可完整运行。
- `indexer + sqlite + watcher + export` 以内置 sidecar 方式承担文档库重任务。
- 主 APP 可以运行后安装、启用、更新和卸载 Integration Plugin。
- Codex / Claude Code 之类能力改为可选插件接入，而不是继续进入主安装包。
