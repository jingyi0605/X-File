# 设计文档 - spec001-X-File文档库独立应用

状态：Draft

## 1. 概述

### 1.1 目标

- 把 CodingNS 当前文档库复刻成 X-File 独立桌面应用。
- 让文档库扫描、索引、自动刷新、预览和文件操作都在 X-File 后端运行。
- 提供可开关、可常驻的本机 HTTP 服务，方便应用前端和 CodingNS 访问。
- 保留当前文档库的页面体验，但去掉 CodingNS 的代码工作区、事务模式、Teable、Butler 等耦合。

### 1.2 覆盖需求

- `requirements.md` 需求 1：独立桌面应用
- `requirements.md` 需求 2：复刻前端体验
- `requirements.md` 需求 3：复刻后端主链路
- `requirements.md` 需求 4：索引重活留在 X-File 后端
- `requirements.md` 需求 5：HTTP 服务和常驻后端
- `requirements.md` 需求 6：状态和恢复能力
- `requirements.md` 需求 7：CodingNS 外部集成入口

### 1.3 技术约束

- 桌面壳建议使用 Tauri 2，前端使用 React + TypeScript。
- 后端建议使用 Node.js + Fastify，和桌面壳打包成同一个应用。
- 本地数据建议使用 SQLite，正式运行代码使用 `better-sqlite3`，禁止直接使用 Node 内置 `node:sqlite`。
- 后台重活必须从 HTTP 请求主链路和 UI 主线程里拆出去。
- watcher 只能打脏标记，不能直接跑扫描和索引。
- 第一版以复刻 CodingNS 当前文档库为目标，不做无关 UI 重画。

## 2. 架构

### 2.1 系统结构

X-File 是一个前后端一体的桌面应用：

```text
X-File 桌面应用
├── 桌面壳
│   ├── macOS / Windows 安装与启动
│   ├── 窗口生命周期
│   ├── 常驻后端开关
│   └── deep link / 系统托盘（后续可补）
├── 前端 UI
│   ├── 文档库首页
│   ├── 浏览 / 收藏 / 标签 / 详情
│   ├── 绑定和设置
│   └── HTTP 服务状态页
├── 内置后端
│   ├── HTTP API
│   ├── 文档库配置和绑定
│   ├── 文件预览、下载和操作
│   ├── 索引调度和状态
│   └── CodingNS 集成 API
└── 索引执行层
    ├── 文件扫描
    ├── 文档解析
    ├── 标签推断
    ├── SQLite 存储
    ├── 导出快照
    └── dirty watcher / 周期对账
```

用户可以只用桌面 UI，也可以启用本机 HTTP 服务让 CodingNS 或脚本调用。

### 2.2 模块职责

| 模块 | 职责 | 输入 | 输出 |
| --- | --- | --- | --- |
| `desktop-shell` | 启动应用、管理窗口、控制后端常驻 | 用户启动、设置 | 前端窗口、后端进程状态 |
| `web-ui` | 复刻文档库页面和交互 | HTTP API 数据、用户操作 | 文档库界面 |
| `http-server` | 暴露文档库 API 和健康状态 | HTTP 请求 | JSON、文件内容、错误响应 |
| `library-service` | 文档库绑定、配置、快照、收藏、文件操作 | rootDir、过滤条件、操作请求 | DTO、任务状态 |
| `index-service` | 调度索引、标签、导出、自动刷新 | dirty signal、显式刷新 | 索引结果、状态 |
| `watch-service` | 监听资料库根目录外部变化 | 文件系统事件 | 脏标记 |
| `task-runner` | 去重、排队、超时、取消和观测后台任务 | taskType、key、input | 任务快照、执行结果 |
| `storage` | 保存配置、状态、收藏和索引数据 | 服务层写入 | SQLite 数据、快照文件 |
| `codingns-adapter` | 给 CodingNS 提供稳定外部入口 | deep link / HTTP 请求 | 结构化文档库数据 |

### 2.3 关键流程

#### 2.3.1 首次启动并绑定文档库

1. 用户启动 X-File。
2. 桌面壳启动内置后端。
3. 前端读取 `/api/library/binding`。
4. 如果没有绑定，前端显示路径绑定入口。
5. 用户选择或输入资料库根目录。
6. 后端校验路径存在、可读、可写必要配置。
7. 后端保存绑定，并初始化 `.ai-index` 配置。
8. 后端返回绑定和初始状态。
9. 前端进入文档库主界面。

#### 2.3.2 读取文档库列表

1. 前端读取 `/api/library/snapshot` 获取绑定、状态、标签、收藏、目录和总数。
2. 前端按当前浏览状态读取 `/api/library/documents`。
3. 后端优先读取导出快照、热目录缓存或最近可用结果。
4. 后端返回文档列表、分页、标签统计和目录状态。
5. 前端展示浏览区，并把选中对象传给详情区。

#### 2.3.3 显式刷新

1. 用户点击刷新。
2. 前端调用 `POST /api/library/refresh`。
3. 后端只记录刷新原因并入队任务。
4. `task-runner` 按 `taskType + rootDir` 去重。
5. 索引执行层在后台扫描、解析、写库、导出。
6. 完成后更新状态和快照。
7. 前端轮询或订阅状态后展示最新结果。

#### 2.3.4 外部文件变化自动刷新

1. `watch-service` 监听资料库根目录。
2. 收到文件变化后过滤临时文件和 `.ai-index` 噪音。
3. 只写入 dirty signal，不做重活。
4. quiet window 到期后，`index-service` 合并脏标记。
5. 能定位目录时优先提交 targeted refresh 或 directory hint。
6. 不能定位时等待周期对账或全库巡检兜底。

#### 2.3.5 启用 HTTP 服务并常驻

1. 用户在设置里打开 HTTP 服务。
2. 后端按配置端口监听 `127.0.0.1`，默认不暴露到公网网卡。
3. 设置页显示服务地址、端口、状态、最近错误。
4. 用户关闭窗口时，如果常驻开关打开，桌面壳保留后端运行。
5. 用户退出应用或关闭服务时，后端停止监听端口。

## 3. 组件和接口

### 3.1 核心组件

覆盖需求：1、2、3、4、5、6、7

- `LibraryAppShell`：文档库应用主框架，只包含文档库导航和设置入口。
- `LibraryBrowserPage`：复刻当前 `MobileAffairsLibraryPage` 的主页面。
- `LibraryStateHook`：复刻并重命名当前 `useAffairsLibraryState`，去掉 workspace/affairs 命名。
- `LibraryController`：复刻当前 `AffairsLibraryController` 的文档库部分。
- `LibraryService`：复刻当前 `AffairsLibraryService`，但模型从 `workspaceId + userId` 改成 `libraryId/rootDir`。
- `IndexerCore`：迁入当前 `affairs-indexer/core` 的扫描、解析、SQLite、导出和标签逻辑。
- `HttpServerManager`：负责 HTTP 服务启停、端口检查、状态保存。
- `PersistentBackendManager`：负责窗口关闭后的常驻策略。

### 3.2 数据结构

#### 3.2.1 `LibraryBinding`

| 字段 | 类型 | 必填 | 说明 | 约束 |
| --- | --- | --- | --- | --- |
| `libraryId` | `string` | 是 | 文档库 ID | 第一版可以固定为 `default` |
| `rootDir` | `string` | 是 | 资料库根目录 | 必须存在且可访问 |
| `enabled` | `boolean` | 是 | 是否启用 | 默认 `true` |
| `mirrorRoot` | `string \| null` | 否 | 镜像根目录 | 可空 |
| `allowedExtensions` | `string[]` | 是 | 允许索引的扩展名 | 默认沿用 CodingNS 当前列表 |
| `includedHiddenPaths` | `string[]` | 是 | 允许包含的隐藏路径 | 默认空数组 |
| `folderOpenBehavior` | `"single_click" \| "double_click"` | 是 | 文件夹打开方式 | 默认 `double_click` |
| `configRelativePath` | `string` | 是 | 索引配置相对路径 | `.ai-index/doc-semantic-index.config.json` |
| `exportMode` | `"v2"` | 是 | 导出格式 | 第一版固定 `v2` |
| `updatedAt` | `string` | 是 | 更新时间 | ISO 时间 |

#### 3.2.2 `LibraryIndexStatus`

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `state` | `fresh \| stale \| queued \| running \| queue_timeout \| cooldown \| failed` | 是 | 当前索引状态 |
| `dirtyReasons` | `string[]` | 是 | 脏原因 |
| `lastRequestedAt` | `string \| null` | 否 | 最近请求刷新时间 |
| `lastStartedAt` | `string \| null` | 否 | 最近开始时间 |
| `lastCompletedAt` | `string \| null` | 否 | 最近完成时间 |
| `lastFailedAt` | `string \| null` | 否 | 最近失败时间 |
| `nextAllowedAt` | `string \| null` | 否 | 冷却截止时间 |
| `runningTaskId` | `string \| null` | 否 | 正在运行的任务 ID |
| `runningStage` | `string \| null` | 否 | 当前阶段 |
| `errorSummary` | `string \| null` | 否 | 错误摘要 |
| `workerHealth` | `LibraryWorkerHealth \| null` | 否 | 后台执行器健康信息 |
| `progress` | `LibraryIndexProgress \| null` | 否 | 扫描和索引进度 |

#### 3.2.3 `LibrarySnapshot`

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `binding` | `LibraryBinding \| null` | 是 | 当前绑定 |
| `status` | `LibraryIndexStatus` | 是 | 当前索引状态 |
| `tags` | `LibraryTagNode[]` | 是 | 标签树 |
| `favorites` | `LibraryFavoriteRecord[]` | 是 | 收藏 |
| `folders` | `LibraryFolderNode[]` | 是 | 文件夹树 |
| `documentCount` | `number` | 是 | 文档总数 |
| `lastError` | `string \| null` | 否 | 最近错误 |

#### 3.2.4 `LibraryDocumentRecord`

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `documentId` | `string` | 是 | 文档 ID |
| `path` | `string` | 是 | 相对路径 |
| `title` | `string` | 是 | 标题 |
| `summary` | `string` | 是 | 摘要 |
| `updatedAt` | `string` | 是 | 更新时间 |
| `createdAt` | `string \| null` | 否 | 创建时间 |
| `sizeBytes` | `number \| null` | 否 | 文件大小 |
| `tags` | `string[]` | 是 | 手动标签 |
| `derivedTags` | `string[]` | 是 | 推断标签 |
| `isFavorite` | `boolean` | 是 | 是否收藏 |

#### 3.2.5 `HttpServerState`

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `enabled` | `boolean` | 是 | 是否启用 HTTP 服务 |
| `host` | `string` | 是 | 默认 `127.0.0.1` |
| `port` | `number` | 是 | 监听端口 |
| `running` | `boolean` | 是 | 当前是否运行 |
| `persistent` | `boolean` | 是 | 是否允许常驻 |
| `startedAt` | `string \| null` | 否 | 最近启动时间 |
| `lastError` | `string \| null` | 否 | 最近错误 |

### 3.3 接口契约

#### 3.3.1 健康检查

- 类型：HTTP
- 路径：`GET /api/health`
- 输出：`{ ok: true, app: "X-File", version: string }`
- 错误：无特殊错误

#### 3.3.2 读取文档库绑定

- 类型：HTTP
- 路径：`GET /api/library/binding`
- 输出：`LibraryBinding | null`
- 错误：配置读取失败

#### 3.3.3 保存文档库绑定

- 类型：HTTP
- 路径：`PUT /api/library/binding`
- 输入：`{ rootDir: string }`
- 输出：`LibraryBinding`
- 校验：路径存在、可读、必要时可写 `.ai-index`
- 错误：路径无效、权限不足、配置写入失败

#### 3.3.4 读取文档库配置

- 类型：HTTP
- 路径：`GET /api/library/config`
- 输出：`LibraryBinding` 的配置部分

#### 3.3.5 保存文档库配置

- 类型：HTTP
- 路径：`PUT /api/library/config`
- 输入：`mirrorRoot`、`allowedExtensions`、`includedHiddenPaths`、`folderOpenBehavior`
- 输出：更新后的配置

#### 3.3.6 读取快照

- 类型：HTTP
- 路径：`GET /api/library/snapshot`
- 输出：`LibrarySnapshot`
- 约束：只读最近结果，不触发重扫描

#### 3.3.7 读取文档列表

- 类型：HTTP
- 路径：`GET /api/library/documents`
- 输入：`browseMode`、`selectedFolderPath`、`selectedTagPath`、`selectedTagPaths`、`selectedFavoriteId`、`keyword`、`offset`、`limit`
- 输出：`{ total, visibleEntryTotal, offset, limit, items, tagFacetCounts, directoryStatus }`
- 约束：只读快照或热目录缓存，不在请求内全库扫描

#### 3.3.8 读取目录文件

- 类型：HTTP
- 路径：`GET /api/library/files`
- 输入：`path`、`limit`
- 输出：当前目录文件和文件夹列表

#### 3.3.9 文件预览

- 类型：HTTP
- 路径：`GET /api/library/preview`
- 输入：`path`、`displayMode`
- 输出：预览内容、预览类型、能力信息
- 校验：路径必须在文档库根目录内

#### 3.3.10 文件下载

- 类型：HTTP
- 路径：`GET /api/library/download`
- 输入：`path`
- 输出：文件名、base64 内容、大小、更新时间

#### 3.3.11 文件操作

- 类型：HTTP
- 路径：`POST /api/library/ops`
- 输入：`opType`、`srcPath`、`dstPath`、`content`、`expectedVersion`
- 输出：操作结果
- 支持：`delete`、`move`、`copy`、`create_directory`、`create_file`、`write`

#### 3.3.12 请求刷新

- 类型：HTTP
- 路径：`POST /api/library/refresh`
- 输入：`reason`、`targetPath`
- 输出：刷新任务摘要和当前状态
- 约束：显式入口可以入队任务；读接口不允许顺手刷新

#### 3.3.13 更新收藏

- 类型：HTTP
- 路径：`PUT /api/library/favorites`
- 输入：`favorites`
- 输出：`{ items: LibraryFavoriteRecord[] }`

#### 3.3.14 标签接口

- 类型：HTTP
- 路径：
  - `GET /api/library/tags`
  - `POST /api/library/tags`
  - `POST /api/library/tags/ensure`
  - `GET /api/library/documents/:documentId/tag-details`
  - `PUT /api/library/documents/:documentId/tags`
  - `GET /api/library/folders/tag-details`
  - `PUT /api/library/folders/tags`
- 输出：复刻 CodingNS 当前标签 DTO

#### 3.3.15 HTTP 服务状态

- 类型：HTTP / 桌面内部调用
- 路径：
  - `GET /api/server/state`
  - `PUT /api/server/state`
- 输入：`enabled`、`port`、`persistent`
- 输出：`HttpServerState`

## 4. 数据与状态模型

### 4.1 数据关系

核心关系只有四层：

1. X-File 应用保存一个或多个 `LibraryBinding`。
2. 每个 `LibraryBinding` 指向一个 `rootDir`。
3. 每个 `rootDir` 下有自己的 `.ai-index` 配置、SQLite 数据和导出快照。
4. 前端和外部客户端只通过 HTTP API 读取 `LibrarySnapshot`、`LibraryDocumentRecord`、标签和收藏。

第一版可以只支持一个默认文档库，但模型必须保留 `libraryId`，避免以后支持多文档库时大改数据结构。

### 4.2 索引状态流转

| 状态 | 含义 | 进入条件 | 退出条件 |
| --- | --- | --- | --- |
| `fresh` | 当前结果可直接用 | 最近导出可用且无脏标记 | 外部变化、配置变化、显式刷新 |
| `stale` | 已变脏，等待刷新 | watcher、配置或周期对账发现变化 | 成功入队进入 `queued` |
| `queued` | 已排队但未开始 | 刷新任务入队 | 开始执行进入 `running`；超时进入 `queue_timeout` |
| `running` | 后台任务执行中 | worker 开始扫描或导出 | 成功进入 `cooldown`；失败进入 `failed` |
| `queue_timeout` | 排队太久 | 超过等待阈值 | 新刷新请求或自动恢复回 `stale` |
| `cooldown` | 刚完成，短时间不重复跑 | 任务完成 | 冷却结束进入 `fresh`；新变化进入 `stale` |
| `failed` | 最近一次失败 | 任务失败或恢复失败 | 用户重试或新脏标记进入 `stale` |

### 4.3 HTTP 服务状态流转

| 状态 | 含义 | 进入条件 | 退出条件 |
| --- | --- | --- | --- |
| `disabled` | 用户未启用 HTTP 服务 | 默认状态或用户关闭 | 用户启用服务 |
| `starting` | 正在启动监听 | 用户打开开关 | 成功进入 `running`；失败进入 `failed` |
| `running` | 正在监听本机端口 | 服务启动成功 | 用户关闭、应用退出、端口异常 |
| `failed` | 启动或运行失败 | 端口占用、权限错误、异常退出 | 用户修改配置后重试 |
| `stopping` | 正在停止 | 用户关闭服务或退出应用 | 完成进入 `disabled` |

## 5. 错误处理

### 5.1 错误类型

- **文档库未绑定**：还没有选择资料库根目录。
- **路径无效**：路径不存在、不可读、越界或权限不足。
- **索引配置错误**：`.ai-index` 配置缺失、不可写或格式错误。
- **导出快照损坏**：manifest、status 或分片数据缺失。
- **索引任务失败**：扫描、解析、写库、导出或标签重算失败。
- **队列等待超时**：任务长时间没有开始执行。
- **HTTP 服务启动失败**：端口被占用、监听失败或配置非法。
- **外部 API 不可用**：X-File 没有运行或 HTTP 服务没有开启。

### 5.2 错误响应格式

```json
{
  "detail": "可读错误说明",
  "errorCode": "LIBRARY_PATH_INVALID",
  "field": "rootDir",
  "timestamp": "2026-06-08T00:00:00.000Z"
}
```

### 5.3 处理策略

1. 输入验证错误：直接返回 400，并指出字段。
2. 路径和权限错误：不保存配置，前端给用户重新选择入口。
3. 索引失败：保留最近一次可读结果，状态进入 `failed`。
4. 排队超时：清理失效队列状态，允许用户重试。
5. HTTP 服务失败：保留设置，但显示最近错误，不静默重试打爆端口。
6. 外部调用失败：返回结构化错误，方便 CodingNS 给出启动 X-File 的提示。

## 6. 正确性属性

### 6.1 读接口不触发重活

*对于任何* 读取快照、读取列表、读取目录、读取标签的请求，系统都不应该在请求主链路里启动全量扫描或重索引。

**验证需求：** 需求 4、需求 6

### 6.2 路径不能越过文档库根目录

*对于任何* 预览、下载和文件操作请求，目标路径解析后的真实路径都必须落在当前 `rootDir` 内。

**验证需求：** 需求 3

### 6.3 同根目录同类任务去重

*对于任何* 同一个 `rootDir` 的同一种后台任务，系统同时最多只能有一个有效任务。

**验证需求：** 需求 4、需求 6

### 6.4 HTTP 服务默认只监听本机

*对于任何* 默认 HTTP 服务配置，监听地址必须是 `127.0.0.1`，除非后续明确增加远程访问配置。

**验证需求：** 需求 5、需求 7

## 7. 测试策略

### 7.1 单元测试

- 路径归一化和越界保护。
- 文档库绑定保存和恢复。
- 快照读取、列表筛选、标签筛选、收藏筛选。
- 索引状态流转。
- HTTP 服务配置校验。

### 7.2 集成测试

- 绑定临时资料库后触发索引并读取快照。
- 外部修改文件后 watcher 打脏标记并刷新。
- 队列等待超时和失败状态可见。
- 预览、下载和文件操作端到端。
- HTTP 服务启停和端口冲突。

### 7.3 桌面端验证

- macOS 安装包启动。
- Windows 安装包启动。
- 关闭窗口后常驻后端行为符合设置。
- 退出应用后后端停止。

### 7.4 验证映射

| 需求 | 设计章节 | 验证方式 |
| --- | --- | --- |
| 需求 1 | §2.1、§2.3.1 | 桌面端启动和首次绑定测试 |
| 需求 2 | §3.1 | 前端组件测试和人工 UI 走查 |
| 需求 3 | §3.3.2-§3.3.14 | API 集成测试 |
| 需求 4 | §2.3.3、§2.3.4、§4.2、§6.1 | 后台任务和 watcher 测试 |
| 需求 5 | §2.3.5、§3.3.15、§4.3 | HTTP 服务启停测试 |
| 需求 6 | §4.2、§5 | 状态流转和失败恢复测试 |
| 需求 7 | §3.3、§6.4 | 外部 API 兼容测试 |

## 8. 风险与待确认项

### 8.1 风险

- 当前 CodingNS 文档库代码和 `workspaceId/userId/affairs` 命名耦合，需要迁移时重命名和瘦身，不能直接复制就跑。
- Tauri 打包 Node 后端和原生依赖时，Windows 上 `better-sqlite3`、文档解析依赖可能需要预编译策略。
- 常驻后端涉及应用生命周期，设计不好会出现窗口关了但用户不知道服务还在跑的问题。
- HTTP 服务如果未来开放远程访问，需要额外认证；第一版默认只监听本机。

### 8.2 待确认项

- 第一版是否只支持一个默认文档库，还是直接支持多个文档库。
- 默认 HTTP 端口使用哪个值。
- 是否第一版就做系统托盘和开机自启。
- macOS / Windows 安装包的签名、自动更新是否纳入后续 Spec。
