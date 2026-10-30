# 设计文档 - X-File 镜像模式离线数据模型与同步

状态：Draft

## 1. 概述

### 1.1 目标

- 在主端增加可版本化的完整镜像快照。
- 在 Web mirror 运行时增加持久化快照和待同步标签操作队列。
- 让所有文件和库配置写入口在 mirror 模式下保持主端执行。
- 以记录级 `updatedAt` 和幂等 mutation ID 实现可恢复的最后修改时间合并。

### 1.2 覆盖需求

- `requirements.md` 需求 1
- `requirements.md` 需求 2
- `requirements.md` 需求 3
- `requirements.md` 需求 4

### 1.3 技术约束

- 后端：Node.js、Fastify、现有 `LibraryService` 和 `TagService`
- 前端：React、TypeScript、现有 API 层和 V3 全局样式
- 数据存储：主端现有 JSON stores；镜像端优先 IndexedDB，测试或不可用环境回退 localStorage
- 认证授权：复用现有 HTTP 会话认证
- 外部依赖：不引入新的同步服务或数据库

## 2. 架构

### 2.1 系统结构

主端继续持有文件系统和索引真源，新增 `GET /api/library/mirror/snapshot` 导出数据模型。镜像端 API 层在 mirror 模式下先尝试主端请求；成功后写入快照并处理待同步队列，失败时从本地快照读取。

```text
主端文件系统 / 索引 / 标签 stores
              │
              ├── GET mirror snapshot
              └── existing tag write APIs
                         ▲
                         │ online
镜像端 IndexedDB/localStorage ── pending tag mutations
              │ offline
              └── local snapshot reads and optimistic tag state
```

### 2.2 模块职责

| 模块 | 职责 | 输入 | 输出 |
| --- | --- | --- | --- |
| `LibraryMirrorService` | 主端组装完整快照和版本 | `LibraryService`、`TagService` | `LibraryMirrorSnapshot` |
| `mirror-cache` | 镜像端快照和队列持久化 | 快照、mutation | 本地记录 |
| `mirror-api` | 在线请求、离线回退、队列重放 | 现有 API 输入 | 现有 API DTO |
| `LibraryPage` 状态提示 | 显示离线缓存和待同步状态 | mirror 状态事件 | 警告和同步结果 |

### 2.3 关键流程

#### 2.3.1 首次同步和离线读取

1. mirror 初始化时请求主端镜像快照。
2. 成功后保存快照、快照版本和同步时间。
3. 资料库读取优先使用在线响应；网络失败时使用本地快照适配现有 DTO。
4. 应用启动时若只有缓存，直接展示缓存并后台尝试恢复同步。

#### 2.3.2 离线标签修改和恢复

1. 标签写入先生成 `mutationId` 和 `updatedAt`。
2. 本地基于快照执行相同的标签状态变更，并保存 mutation。
3. UI 显示“已保存到镜像，等待主端同步”。
4. 连接恢复后读取主端快照，按时间顺序提交未完成 mutation。
5. 主端按目标记录的 `updatedAt` 判断接受、覆盖或跳过，并返回同步结果。
6. 镜像端保存合并后的新快照并清理已处理 mutation。

## 3. 组件和接口

### 3.1 核心组件

- `LibraryMirrorService`：主端生成模型和版本。
- `mirror-cache.ts`：镜像端本地快照、队列和状态存储。
- `mirror-api.ts`：mirror 模式读写适配及离线降级。
- `library.ts`：把现有库 API 接入 mirror 适配，不改变 local/native 分支。

### 3.2 数据结构

#### 3.2.1 `LibraryMirrorSnapshot`

| 字段 | 类型 | 必填 | 说明 | 约束 |
| --- | --- | --- | --- | --- |
| `version` | `1` | 是 | 快照格式版本 | 只向后兼容扩展 |
| `revision` | `string` | 是 | 主端模型修订号 | 由最新修改时间和内容摘要组成 |
| `generatedAt` | `string` | 是 | 快照生成时间 | ISO 时间 |
| `snapshot` | `LibrarySnapshot` | 是 | 库摘要、目录和标签节点 | 复用现有类型 |
| `documents` | `LibraryDocumentRecord[]` | 是 | 完整文档索引模型 | 不包含文件正文 |
| `tagDetails` | `LibraryTagDetailWithRules[]` | 是 | 标签定义和规则 | 包含禁用标签 |
| `documentTagBindings` | `LibraryMirrorDocumentTagBinding[]` | 是 | 文件手工标签 | 每条带 `updatedAt` |
| `folderTagBindings` | `LibraryMirrorFolderTagBinding[]` | 是 | 目录标签 | 每条带 `updatedAt` |

#### 3.2.2 `LibraryMirrorMutation`

| 字段 | 类型 | 必填 | 说明 | 约束 |
| --- | --- | --- | --- | --- |
| `mutationId` | `string` | 是 | 幂等操作 ID | UUID |
| `kind` | `tag_definition \| document_tags \| folder_tags` | 是 | 修改对象 | 不允许文件操作 |
| `updatedAt` | `string` | 是 | 客户端修改时间 | ISO 时间 |
| `payload` | `unknown` | 是 | 对应现有标签写入请求 | 仅允许标签请求 |
| `baseRevision` | `string \| null` | 否 | 操作产生时的快照版本 | 用于诊断 |

### 3.3 接口契约

#### 3.3.1 镜像快照

- 类型：HTTP GET
- 路径或标识：`/api/library/mirror/snapshot`
- 输入：现有 HTTP 会话
- 输出：`LibraryMirrorSnapshot`
- 校验：必须存在已初始化资料库
- 错误：沿用现有库错误响应

#### 3.3.2 标签 mutation 重放

- 类型：HTTP POST
- 路径或标识：`/api/library/mirror/mutations`
- 输入：`{ mutations: LibraryMirrorMutation[] }`
- 输出：`{ revision, results: Array<{ mutationId, status, updatedAt, detail? }> }`
- 校验：只接受三类标签 mutation；同一 `mutationId` 重复提交必须幂等
- 错误：单条 mutation 失败不丢弃同批其他记录

#### 3.3.3 现有标签接口

- 类型：HTTP GET/POST/PUT/DELETE
- 路径或标识：现有 `/api/library/tags*`、`/api/library/documents/*/tags`、`/api/library/folders/tags`
- 输入：保持现有请求体；在线 mirror 由适配层附加本地 mutation 元数据
- 输出：保持现有 DTO，并允许增加可选 `syncState`
- 校验：mirror 端不调用文件和库配置写入口的本地实现

## 4. 数据与状态模型

### 4.1 数据关系

- 主端 `LibraryBinding`、索引导出和 `TagStore` 是真源。
- `LibraryMirrorSnapshot` 是主端某一时刻的只读投影。
- 镜像端只保存投影和 mutation 队列，不成为主端文件数据源。
- mutation 通过 `mutationId` 去重，通过 `updatedAt` 与主端记录比较。

### 4.2 状态流转

| 状态 | 含义 | 进入条件 | 退出条件 |
| --- | --- | --- | --- |
| `online` | 主端可连接 | 快照或 API 请求成功 | 请求失败 |
| `offline_cached` | 使用最近快照 | 请求失败且存在快照 | 成功取得主端快照 |
| `offline_empty` | 没有可用快照 | 请求失败且没有快照 | 首次同步成功 |
| `pending_sync` | 存在待同步 mutation | 离线写入或同步失败 | mutation 全部处理 |
| `syncing` | 正在提交 mutation | 恢复连接 | 批次完成或失败 |

## 5. 错误处理

### 5.1 错误类型

- `MIRROR_SNAPSHOT_UNAVAILABLE`：主端不可用且没有本地快照。
- `MIRROR_WRITE_QUEUED`：标签修改已保存到镜像队列。
- `MIRROR_FILE_WRITE_REQUIRES_PRIMARY`：镜像端尝试文件或配置写入。
- `MIRROR_MUTATION_CONFLICT`：mutation 已被更新的主端记录覆盖。

### 5.2 错误响应格式

沿用现有 `LibraryErrorResponse`；前端本地状态额外保存 `detail`、`updatedAt` 和 `pendingCount`。

### 5.3 处理策略

1. 输入验证错误：沿用现有标签服务校验。
2. 业务规则错误：保留原错误，不进入队列。
3. 外部依赖错误：读取回退本地快照；标签写入转入队列。
4. 重试、降级或补偿：恢复连接后自动重试，幂等 mutation 失败保留在队列并显示原因。

## 6. 正确性属性

### 6.1 属性 1：镜像端不直接写文件

*对于任何* mirror 模式下的文件操作、刷新或库配置写入，系统都应该在本地拒绝该操作，并且不修改镜像快照中的文件模型以外的主端配置。

**验证需求：** 需求 3

### 6.2 属性 2：同一记录最后修改时间胜出

*对于任何* 同一标签定义、文件标签绑定或目录标签绑定的主端记录和 mutation，系统都应该保留 `updatedAt` 较新的值。

**验证需求：** 需求 4

### 6.3 属性 3：离线快照可重启恢复

*对于任何* 已成功保存的镜像快照，应用重启且主端不可用时，系统都应该能恢复同一快照和未完成 mutation 队列。

**验证需求：** 需求 1、需求 2、需求 3

## 7. 测试策略

### 7.1 单元测试

- 主端镜像快照组装、修订号和空库兼容。
- mirror cache 的持久化、离线筛选和 mutation 合并。
- 标签 mutation 的时间戳冲突和幂等重放。

### 7.2 集成测试

- Fastify 镜像快照和 mutation 路由。
- 在线 mirror 读取、主端不可用时的缓存回退。
- 文件写入口在 mirror 模式下拒绝。

### 7.3 端到端测试

- 首次同步后关闭主端，镜像端浏览目录和标签。
- 离线修改文件标签，恢复主端后检查主端和镜像结果。

### 7.4 验证映射

| 需求 | 设计章节 | 验证方式 |
| --- | --- | --- |
| `requirements.md` 需求 1 | `design.md` §3.2、§3.3 | 服务端路由和快照单测 |
| `requirements.md` 需求 2 | `design.md` §2.3.1、§6.3 | mirror API 缓存回退测试 |
| `requirements.md` 需求 3 | `design.md` §3.3.3、§5.3 | 文件写拒绝和标签队列测试 |
| `requirements.md` 需求 4 | `design.md` §2.3.2、§4.2、§6.2 | mutation 合并集成测试 |

## 8. 风险与待确认项

### 8.1 风险

- 将完整文档索引保存在浏览器本地会占用更多存储空间，需要对快照大小和写入失败做降级。
- 文件正文和二进制预览仍依赖主端或已有本地文件镜像根目录；离线保证范围以文件模型为主。
- 现有 native local 路径不应被 mirror cache 改写，避免影响桌面本地模式。
- 本轮验证发现 server 全量测试中 3 个 ONLYOFFICE 用例失败（预览 link mock 缺方法、预览路由返回 503）；Web 全量测试亦出现视口预加载及预览用例失败且执行被外部信号终止。相关测试文件不属于本 Spec 改动范围，但因 worktree 原有变更较多，仍需在干净基线上复核归属。
- 主端在线能力仍要求主端 HTTP 服务启用完整 library API profile；mirror 端可离线读取成功缓存的数据模型，但文件正文、Office/二进制资源预览不在镜像快照中。

### 8.2 待确认项

- 后续是否需要把文本正文和预览资源也纳入快照。
- 是否需要独立的镜像端管理页面展示每条冲突记录。
