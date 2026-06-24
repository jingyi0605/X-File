# 设计文档 - spec002-X-File内置文档引擎与集成插件化

状态：Draft

## 1. 概述

### 1.1 目标

- 把 X-File 当前“前端 + Tauri + Node runtime + 后端 + assistant 依赖”的混装结构，收敛成更清晰的主 APP 架构。
- 让文档库真正需要随安装程序交付的能力，稳定沉到内置文档引擎 sidecar。
- 把 assistant / CLI 从正式安装程序中完全拆除，改成运行后可安装的 Integration Plugin。
- 保持插件模型最小化，只保留主 APP + Integration Plugin 一层结构。

### 1.2 覆盖需求

- `requirements.md` 需求 1：主 APP 只内置必需核心能力
- `requirements.md` 需求 2：内置文档引擎 sidecar 承担重任务
- `requirements.md` 需求 3：assistant / CLI 从安装程序移除
- `requirements.md` 需求 4：插件系统只保留一层模型
- `requirements.md` 需求 5：插件支持运行后安装与更新
- `requirements.md` 需求 6：插件声明权限和健康状态
- `requirements.md` 需求 7：assistant / CLI 插件优先复用本机能力

### 1.3 技术约束

- 桌面壳继续使用 Tauri 2。
- 文档库主界面继续使用当前 React + TypeScript 前端。
- 当前版本不要求一次性把所有 Node 服务都重写成 Rust，但必须先把运行边界从“随包通用后端”收缩成“内置文档引擎 sidecar + 主 APP 协调层”。
- Integration Plugin 必须安装在主 APP bundle 外部目录，不能写入已签名应用包内部。
- 插件系统只允许一种插件类型：Integration Plugin。
- assistant / CLI Integration Plugin 必须默认接入本机已有 CLI 和登录态。

## 2. 架构

### 2.1 系统结构

改造后的 X-File 结构如下：

```text
X-File 主 APP
├── desktop-shell
│   ├── Tauri 窗口
│   ├── 生命周期和设置
│   ├── sidecar 启停控制
│   └── 插件安装与注册入口
├── web-ui
│   ├── 文档库页面
│   ├── 设置页
│   └── 插件管理页
├── app-backend-bridge
│   ├── 主 APP 与 sidecar RPC/HTTP 桥接
│   ├── 插件注册表
│   └── 健康状态聚合
├── built-in library-engine sidecar
│   ├── indexer
│   ├── sqlite
│   ├── watcher
│   └── export
└── integration-plugins
    ├── codex
    ├── claude-code
    └── 未来其他外部集成
```

核心原则：

- 文档库引擎是内置能力。
- assistant / CLI 是可选能力。
- 主 APP 只负责协调，不继续背一个无边界膨胀的随包通用后端。

### 2.2 模块职责

| 模块 | 职责 | 输入 | 输出 |
| --- | --- | --- | --- |
| `desktop-shell` | 启动主 APP、控制 sidecar、协调插件安装更新 | 用户操作、系统生命周期 | sidecar 状态、插件状态 |
| `web-ui` | 展示文档库页面和插件管理页面 | 主 APP 暴露的状态和 API | 用户操作、设置和安装请求 |
| `app-backend-bridge` | 封装主 APP 到内置引擎、插件和本地状态的桥接 | 前端请求、sidecar 状态、插件状态 | 统一 DTO 和错误 |
| `library-engine` | 承担索引、SQLite、watcher、export 核心任务 | rootDir、配置、刷新请求、文件事件 | 快照、状态、导出结果 |
| `plugin-manager` | 下载、校验、注册、启用、禁用、升级和卸载 Integration Plugin | 插件源、安装请求、manifest | 本地注册表、插件状态 |
| `integration-plugin-host` | 加载插件 manifest、建立入口、做健康检查和能力控制 | 已安装插件目录 | 可用插件列表、错误、权限状态 |
| `provider-bridge` | 供 codex / claude 之类插件探测本机 CLI 和登录态 | 插件请求、本机命令环境 | provider 健康状态、调用结果 |

### 2.3 关键流程

#### 2.3.1 主 APP 启动与内置文档引擎拉起

1. 用户启动 X-File。
2. `desktop-shell` 启动并检查本地配置。
3. 主 APP 拉起 `library-engine` sidecar。
4. `app-backend-bridge` 做健康检查。
5. 健康成功后，前端进入文档库主界面。
6. 如果 sidecar 启动失败，前端显示明确的引擎不可用错误和重试入口。

#### 2.3.2 文档库主链路调用

1. 前端发起文档库请求。
2. `app-backend-bridge` 负责统一 DTO、错误和状态。
3. 查询类请求走导出快照、轻量读取或 sidecar 提供的只读接口。
4. 重任务请求走 `library-engine` 的刷新、watcher、indexer、export 接口。
5. 主 APP 汇总状态后返回前端。

#### 2.3.3 插件安装

1. 用户在插件管理页选择安装插件。
2. `plugin-manager` 下载插件包到临时目录。
3. 校验 hash、签名、manifest 和版本兼容性。
4. 解压到本地插件目录。
5. 更新插件注册表。
6. `integration-plugin-host` 重新扫描并加载插件。
7. 前端显示插件已安装和当前健康状态。

#### 2.3.4 插件更新与回滚

1. 主 APP 检查插件源发现新版本。
2. 下载并校验新版本。
3. 解压到新的版本目录。
4. 切换 `current` 指针或注册表指向。
5. 做插件健康检查。
6. 成功则完成升级；失败则恢复旧版本状态。

#### 2.3.5 assistant / CLI 插件接入

1. 用户安装 `codex` 或 `claude-code` Integration Plugin。
2. 插件通过 `provider-bridge` 探测本机 CLI 是否存在。
3. 插件检查对应登录态目录是否存在。
4. 如果探测通过，则在 UI 暴露 provider 入口。
5. 如果探测失败，则返回明确的安装或登录提示。

## 3. 组件和接口

### 3.1 核心组件

覆盖需求：1、2、3、4、5、6、7

- `LibraryEngineHost`：主 APP 中负责拉起、停止、健康检查内置文档引擎的宿主层。
- `LibraryEngineClient`：主 APP 调用内置引擎的统一客户端，屏蔽 transport 细节。
- `PluginManagerService`：负责插件下载安装、校验、切换版本和卸载。
- `PluginRegistryStore`：保存插件注册表、启用状态、上次错误和权限确认记录。
- `IntegrationPluginHost`：扫描并加载本地插件目录，暴露插件入口和健康状态。
- `ProviderBridgeService`：供 Integration Plugin 检测本机 CLI、登录态和 provider 可用性。

### 3.2 数据结构

#### 3.2.1 `PluginManifest`

| 字段 | 类型 | 必填 | 说明 | 约束 |
| --- | --- | --- | --- | --- |
| `id` | `string` | 是 | 插件唯一 ID | 全局唯一 |
| `name` | `string` | 是 | 展示名称 | 非空 |
| `version` | `string` | 是 | 插件版本 | semver |
| `pluginType` | `"integration"` | 是 | 插件类型 | 当前固定一种 |
| `minAppVersion` | `string` | 是 | 最低兼容主 APP 版本 | semver |
| `entry` | `PluginEntry` | 是 | 插件入口 | 至少包含一个入口 |
| `capabilities` | `string[]` | 是 | 能力声明 | 白名单能力 |
| `provider` | `PluginProviderMeta \| null` | 否 | provider 类插件元信息 | 可空 |
| `signature` | `PluginSignature` | 是 | 签名信息 | 安装时校验 |

#### 3.2.2 `PluginRegistryRecord`

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `pluginId` | `string` | 是 | 插件 ID |
| `version` | `string` | 是 | 当前启用版本 |
| `installDir` | `string` | 是 | 插件安装目录 |
| `enabled` | `boolean` | 是 | 是否启用 |
| `installedAt` | `string` | 是 | 安装时间 |
| `updatedAt` | `string` | 是 | 更新时间 |
| `lastHealthStatus` | `"unknown" \| "healthy" \| "degraded" \| "failed"` | 是 | 最近健康状态 |
| `lastError` | `string \| null` | 否 | 最近错误 |
| `grantedCapabilities` | `string[]` | 是 | 已确认权限 |

#### 3.2.3 `LibraryEngineHealth`

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `running` | `boolean` | 是 | 是否运行中 |
| `version` | `string` | 是 | 引擎版本 |
| `startedAt` | `string \| null` | 否 | 最近启动时间 |
| `lastError` | `string \| null` | 否 | 最近错误 |
| `indexerReady` | `boolean` | 是 | 索引能力是否就绪 |
| `sqliteReady` | `boolean` | 是 | SQLite 能力是否就绪 |
| `watcherReady` | `boolean` | 是 | watcher 能力是否就绪 |
| `exportReady` | `boolean` | 是 | export 能力是否就绪 |

#### 3.2.4 `PluginHealth`

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `pluginId` | `string` | 是 | 插件 ID |
| `enabled` | `boolean` | 是 | 是否启用 |
| `status` | `"healthy" \| "degraded" \| "failed"` | 是 | 健康状态 |
| `detail` | `string \| null` | 否 | 诊断信息 |
| `commandReady` | `boolean \| null` | 否 | 对于 CLI 插件，本机命令是否可用 |
| `authReady` | `boolean \| null` | 否 | 对于 CLI 插件，登录态是否就绪 |

### 3.3 接口契约

#### 3.3.1 主 APP 到内置文档引擎

- 类型：本地 RPC / 本地 HTTP
- 接口：
  - `getHealth()`
  - `getSnapshot()`
  - `listDocuments()`
  - `requestRefresh()`
  - `startWatcher()`
  - `stopWatcher()`
- 约束：
  - 读接口不得隐式触发重任务
  - 错误必须返回结构化错误和可读 detail

#### 3.3.2 插件管理接口

- 类型：主 APP 内部服务 + 前端调用
- 接口：
  - `listPlugins()`
  - `installPlugin(source)`
  - `enablePlugin(pluginId)`
  - `disablePlugin(pluginId)`
  - `updatePlugin(pluginId)`
  - `uninstallPlugin(pluginId)`
- 输出：
  - `PluginRegistryRecord`
  - `PluginHealth`
  - 结构化安装 / 更新错误

#### 3.3.3 provider 探测接口

- 类型：主 APP 内部服务
- 接口：
  - `detectCommand(commandName)`
  - `detectAuth(providerId)`
  - `getProviderCapabilities(providerId)`
- 输出：
  - `commandReady`
  - `authReady`
  - `detail`

## 4. 数据与状态模型

### 4.1 数据关系

- `主 APP` 拥有 `PluginRegistryStore` 和 `LibraryEngineHost`
- `LibraryEngineHost` 管理 `library-engine` 的进程状态和健康状态
- `IntegrationPluginHost` 从插件目录读取 `PluginManifest`
- `PluginRegistryStore` 记录当前启用版本和权限授予状态
- `ProviderBridgeService` 只提供探测和桥接，不拥有 provider runtime 本体

### 4.2 状态流转

#### 4.2.1 插件安装状态

| 状态 | 含义 | 进入条件 | 退出条件 |
| --- | --- | --- | --- |
| `downloading` | 正在下载 | 用户发起安装或更新 | 下载完成或失败 |
| `verifying` | 正在校验 | 下载完成 | 校验完成或失败 |
| `installing` | 正在解压和注册 | 校验通过 | 注册完成或失败 |
| `installed` | 已安装 | 注册成功 | 启用、升级、卸载 |
| `failed` | 安装或更新失败 | 任一阶段失败 | 重试或回滚完成 |

#### 4.2.2 内置引擎健康状态

| 状态 | 含义 | 进入条件 | 退出条件 |
| --- | --- | --- | --- |
| `starting` | 正在启动 | 主 APP 拉起引擎 | 健康成功或失败 |
| `healthy` | 正常可用 | 健康检查通过 | 崩溃、停止或降级 |
| `degraded` | 部分能力异常 | 部分子能力失败 | 恢复健康或失败 |
| `failed` | 当前不可用 | 启动失败或崩溃 | 重启成功 |

## 5. 错误处理

### 5.1 错误类型

- `ENGINE_START_FAILED`：内置文档引擎启动失败
- `ENGINE_HEALTH_FAILED`：内置引擎健康检查失败
- `PLUGIN_DOWNLOAD_FAILED`：插件下载失败
- `PLUGIN_VERIFY_FAILED`：插件签名或 hash 校验失败
- `PLUGIN_INCOMPATIBLE`：插件版本与主 APP 不兼容
- `PLUGIN_ENTRY_INVALID`：插件入口缺失或 manifest 非法
- `PROVIDER_COMMAND_MISSING`：本机 CLI 命令不存在
- `PROVIDER_AUTH_MISSING`：本机登录态不存在

### 5.2 错误响应格式

```json
{
  "detail": "插件签名校验失败",
  "error_code": "PLUGIN_VERIFY_FAILED",
  "field": null,
  "timestamp": "2026-06-16T00:00:00Z"
}
```

### 5.3 处理策略

1. 内置引擎启动失败：主 APP 进入受控错误状态，允许重试，不让 UI 静默卡死。
2. 插件下载或校验失败：拒绝安装，不污染当前已启用版本。
3. 插件更新失败：回滚到上一版本注册记录。
4. provider 探测失败：插件保留已安装状态，但健康状态为 `degraded` 或 `failed`。

## 6. 正确性属性

### 6.1 属性 1：文档库主链路不依赖插件

*对于任何* 未安装任何 Integration Plugin 的主 APP，系统都应该满足：文档库绑定、索引、列表、预览和刷新仍然可用。

**验证需求：** 需求 1、需求 3

### 6.2 属性 2：插件不能污染主 APP 安装包

*对于任何* 插件安装、更新和卸载操作，系统都应该满足：主 APP bundle 内部内容不被运行后写入或修改。

**验证需求：** 需求 5、需求 6

## 7. 测试策略

### 7.1 单元测试

- `PluginManifest` 解析与校验
- 插件注册表读写
- provider 命令和登录态探测
- 内置引擎健康状态映射

### 7.2 集成测试

- 主 APP 拉起内置 `library-engine`
- 插件安装、启用、禁用、升级、卸载
- 插件升级失败回滚
- 无插件状态下文档库主链路可用

### 7.3 端到端测试

- 全新安装主 APP 后，文档库可直接使用
- 安装 Codex Integration Plugin 后，主 APP 能正确展示 provider 状态
- 缺少 CLI 或登录态时，插件状态返回可读诊断

### 7.4 验证映射

| 需求 | 设计章节 | 验证方式 |
| --- | --- | --- |
| `requirements.md` 需求 1 | `design.md` §2.1、§2.2、§6.1 | 构建产物检查、无插件主链路回放 |
| `requirements.md` 需求 2 | `design.md` §2.3.1、§3.3.1、§4.2 | sidecar 启停与健康检查集成测试 |
| `requirements.md` 需求 5 | `design.md` §2.3.3、§2.3.4、§3.3.2 | 插件安装 / 更新 / 回滚测试 |
| `requirements.md` 需求 7 | `design.md` §2.3.5、§3.3.3 | provider 探测测试 |

## 8. 风险与待确认项

### 8.1 风险

- 当前文档库后端和 UI 之间仍有 Node 服务残留边界，sidecar 收缩时容易出现职责重复。
- assistant 现有实现依赖 `@codingns/session-sync-core` 和 Node CLI 宿主，拆成 Integration Plugin 时需要控制好边界，不要重新把运行时拖回主包。
- 插件下载和签名校验如果设计太松，会把主 APP 变成不受控执行器。

### 8.2 待确认项

- 内置 `library-engine` 的 transport 最终采用本地 RPC、stdio 还是本地 HTTP。
- assistant Integration Plugin 第一版是否只做 provider 探测和入口暴露，还是要同时带会话桥接 UI。
- 插件源第一版是本地静态索引还是远程 JSON 索引。
