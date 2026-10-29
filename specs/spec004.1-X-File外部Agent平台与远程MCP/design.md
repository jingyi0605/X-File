# 设计文档 - 外部 Agent 平台与远程 MCP

状态：实施中（与当前实现对齐，最终验收见 tasks.md）

## 1. 概述

### 1.1 目标

- 在 X-File 内统一 CLI、MCP stdio 和远程 MCP HTTP 的 Agent 工具面。
- 将访问策略从客户端建议提升为宿主强制执行的权限边界。
- 让 Agent 可以使用组合检索结果完成一次批量标签操作。
- 保持 X-File 只做资料库操作，不增加模型推理和聊天运行时。

### 1.2 覆盖需求

- `requirements.md` 需求 1–7。

### 1.3 技术约束

- 后端：Tauri Rust Native Core、Fastify HTTP 服务、React 设置页。
- 传输：本机 CLI、本机 MCP stdio、现有 HTTP 服务内的 MCP Streamable HTTP。
- 数据存储：现有状态目录 JSON 文件、原生导出快照和任务中心。
- 认证授权：Agent API Key；远程 HTTP 使用 Bearer Header；Web 设置继续使用既有 HTTP 登录会话。
- 外部依赖：现有 `rmcp` Rust SDK；不新增模型、向量库或远程身份服务。
- 兼容性：保留既有 `X_FILE_AGENT_API_KEY`、CLI 参数、MCP stdio 配置和工具输出信封。

## 2. 架构

### 2.1 系统结构

```text
外部 Agent
  ├─ CLI 子进程
  ├─ MCP stdio 子进程
  └─ MCP Streamable HTTP
          │
          ▼
统一传输适配层
          │
          ▼
Agent Access Policy + Schema Validator
          │
          ▼
统一 Agent Tool Executor
  ├─ 资料库绑定、状态和配置
  ├─ 组合检索
  ├─ 文件读取与操作
  ├─ 标签和批量标签
  └─ 任务状态
          │
          ▼
Rust Native Core / Export / Task Center
```

CLI 和两种 MCP 传输都只负责协议适配。工具发现、参数校验、权限判断、结果封装和业务分发继续集中在 `apps/desktop/src-tauri/src/agent_tools`。

远程 HTTP 入口由现有 Fastify 服务注册。它不启动第二个服务，也不把 Agent API Key 注入已有 Web 登录 Cookie。MCP 请求在进入统一执行层前完成 Bearer 鉴权。

### 2.2 模块职责

| 模块 | 职责 | 输入 | 输出 |
| --- | --- | --- | --- |
| `agent_tools/catalog` | 工具名称、Schema、注解和输出契约 | JSON 目录 | CLI/MCP/设置页能力 |
| `agent_tools/settings` | API Key、访问模式、配置迁移和使用状态 | 设置请求、Bearer/API Key | 策略和安全错误 |
| `agent_tools/mod` | Schema 校验、权限判断、统一分发和结果封装 | 工具名、JSON 参数 | 结构化结果 |
| `agent_tools/mcp` | MCP stdio 协议适配 | JSON-RPC | MCP 响应 |
| HTTP MCP adapter | Streamable HTTP 会话和请求适配 | HTTP 请求 | MCP HTTP 响应 |
| native search | 组合过滤、分页和结果状态 | 搜索条件 | 文档列表 |
| native tag core | 目标冻结、标签变更、范围导出 | 批量标签请求 | 任务和统计 |
| task center | 任务状态、阶段和错误 | 任务更新 | Agent 可查询状态 |
| settings UI | 接入启停、权限状态和配置示例 | Tauri/HTTP 设置 DTO | 用户配置 |

### 2.3 关键流程

#### 2.3.1 远程 MCP HTTP 调用

1. Fastify 接收 MCP HTTP 请求。
2. 校验请求方法、Content-Type、无状态会话约束和请求体大小。
3. 从 `Authorization: Bearer` 读取 API Key，不读取查询参数中的密钥。
4. 读取当前 Agent 设置并校验 access mode。
5. 将工具调用交给原生 CLI 的统一工具执行层。
6. 将结构化结果返回为 MCP Streamable HTTP JSON 响应。
7. 业务日志只记录工具名、结果状态、耗时和错误码，不记录请求密钥。

#### 2.3.2 组合检索

1. 规范化目录、标签、收藏、关键词、搜索范围、搜索模式和分页参数。
2. 从已导出索引快照读取候选文档。
3. 按标签 AND、目录范围、收藏关系和关键词模式依次过滤。
4. 按稳定排序规则分页。
5. 返回查询摘要、总数、索引状态和文档记录。

#### 2.3.3 批量标签

1. 校验批量选择器和目标标签。
2. 在任务开始时冻结文档 ID 集合。
3. dry-run 只计算匹配和变化，不写标签存储。
4. 正式任务在资料库根锁内一次性更新手工标签集合。
5. 使用范围增量导出，更新标签关系和任务进度。
6. 返回任务状态和成功/跳过/失败统计。

## 3. 组件和接口

### 3.1 Agent 访问设置

覆盖需求：1、7。

现有 `agent-integration.json` 增加兼容字段：

```json
{
  "enabled": true,
  "apiKeyDigest": [0, 1, 2],
  "accessMode": "read_only",
  "updatedAt": "2026-10-29T00:00:00Z",
  "lastUsedAt": "2026-10-29T00:00:00Z"
}
```

旧配置没有 `accessMode` 时按兼容默认值读取，下一次设置保存时写入明确值。新生成的接入配置默认使用 `read_only`，用户必须显式切换到 `read_write`。

### 3.2 组合搜索工具

工具：`xfile_documents_list`

新增或统一公开的输入字段：

```json
{
  "browseMode": "tag",
  "selectedFolderPath": "项目/2026",
  "selectedTagPaths": ["客户/甲公司", "文档类型/合同"],
  "selectedFavoriteId": null,
  "keyword": "报价",
  "searchScope": "all",
  "searchMode": "name",
  "updatedAtOrder": "desc",
  "offset": 0,
  "limit": 100
}
```

输入继续使用资料库相对路径和既有上限。输出保留 `total`、`offset`、`limit`、`items`、标签统计和目录状态。

### 3.3 批量标签工具

工具：`xfile_documents_tags_batch`

建议输入：

```json
{
  "documentIds": ["doc-a", "doc-b"],
  "operation": "add",
  "tagPaths": ["项目/重要"],
  "createTagPaths": ["项目/重要"],
  "dryRun": false,
  "idempotencyKey": "agent-run-20261029-001"
}
```

三个目标选择器互斥且恰好提供一个：

- `documentIds`
- `folderPath` 或 `folderPaths`
- `query`

设置 `targetKind:"folders"` 时，目标为目录绑定；`folderPaths` 直接冻结目录集合，`documentIds` 或 `query` 则归并为相应文档的直接父目录。

`query` 复用 `xfile_documents_list` 的组合搜索字段，并在任务开始时冻结匹配结果。

文档 dry-run 返回冻结的 `targetDocumentIds`；目录 dry-run 返回 `targetFolderPaths`。两者均返回匹配/预计变化/跳过/验证统计。正式调用使用冻结集合与幂等键，返回：

```json
{
  "taskId": "agent-batch:...",
  "state": "completed",
  "matchedCount": 120,
  "changedCount": 116,
  "skippedCount": 3,
  "failedCount": 0
}
```

dry-run 不创建标签、不写文档或目录标签、不导出。Agent 任务结果保存在当前应用状态目录；过期无心跳任务标记为失败，重试需使用新的幂等键。

### 3.4 任务工具

新增只读工具：

- `xfile_tasks_list`
- `xfile_task_get`

工具返回现有任务中心的结构化字段，并按当前绑定资料库过滤。批量标签任务的状态不能依赖前端轮询才能存在。

### 3.5 远程 MCP HTTP

路径：`POST /api/mcp`，由现有 Fastify 服务注册。

采用 Streamable HTTP stateless 模式，不签发 `Mcp-Session-Id`，也不保存协议会话状态。当前工具不依赖 MCP 服务端会话；长任务由显式任务 ID 查询。

- `POST /api/mcp`：处理单条 MCP JSON-RPC request 或 notification，成功响应使用 MCP JSON。
- `GET /api/mcp`：返回 405；本阶段不提供服务端主动 SSE 流。
- `DELETE /api/mcp`：返回 405；stateless 模式没有 MCP 会话需要释放。
- notification 成功处理后返回 202 且无响应体。
- 拒绝客户端发送 `Mcp-Session-Id`，避免误认为端点提供有状态会话。

请求要求：

- `Authorization: Bearer <key>`
- `Content-Type: application/json`
- `Accept` 必须同时包含 `application/json` 和 `text/event-stream`；当前使用 JSON 响应
- `MCP-Protocol-Version` 除初始化请求外必须提供，且必须是支持版本
- 不接受 URL 中的 API Key

Fastify 只实现 HTTP/MCP JSON-RPC 适配，不复制 Rust 工具 Schema 或业务逻辑。工具目录、参数校验、访问策略和文件操作由现有原生 CLI 执行器完成。远程 MCP 使用 Fastify 已有主机和端口配置，不独立监听端口，也不绕过现有服务启停、LAN 登录保护或反向代理 TLS 部署策略。

已核对 `rmcp 3.7.0` 包含 Streamable HTTP Tower server transport，但 Fastify 不能直接挂载 Tower service；本阶段采用 stateless HTTP adapter + 原生 CLI 共享 dispatcher，避免增加内部监听端口和长驻 Rust HTTP 子服务。

### 3.6 输出和错误

业务工具继续使用：

```json
{
  "schemaVersion": 1,
  "ok": true,
  "tool": "xfile_documents_list",
  "result": {}
}
```

远程 MCP 将该信封放入 MCP structured content。鉴权错误使用稳定错误码：

- `AGENT_DISABLED`
- `UNAUTHORIZED`
- `ACCESS_POLICY_DENIED`
- `SETTINGS_ERROR`
- `MCP_SESSION_INVALID`
- `MCP_REQUEST_TOO_LARGE`

## 4. 数据与状态模型

### 4.1 数据关系

- Agent 设置属于当前应用状态目录。
- API Key 只保存摘要。
- access mode 属于应用级 Agent 接入策略。
- 资料库绑定仍然决定工具能访问的根目录。
- 批量标签任务引用绑定根目录和冻结后的目标文档集合。
- 远程 MCP stateless 请求不保存协议会话状态，也不保存 API Key。

### 4.2 状态流转

| 状态 | 含义 | 进入条件 | 退出条件 |
| --- | --- | --- | --- |
| `disabled` | 外部 Agent 关闭 | 未启用或撤销密钥 | 用户启用并配置密钥 |
| `read_only` | 只读策略 | 新配置或用户选择 | 用户切换为读写或关闭 |
| `read_write` | 允许写工具 | 用户显式选择 | 用户切换为只读或关闭 |
| `queued` | 批量任务已登记 | 创建批量任务 | 开始执行或失败 |
| `running` | 批量任务执行中 | 获取任务锁 | 完成或失败 |
| `completed` | 批量任务完成 | 导出成功 | 保留为历史结果 |
| `failed` | 批量任务失败 | 任一不可恢复错误 | 显式重试或保留失败结果 |

## 5. 错误处理

### 5.1 错误类型

- `AGENT_DISABLED`：接入未启用。
- `UNAUTHORIZED`：Bearer/API Key 缺失或无效。
- `ACCESS_POLICY_DENIED`：工具不符合当前访问模式。
- `MCP_SESSION_INVALID`：客户端使用了本端点不支持的会话头。
- `MCP_REQUEST_TOO_LARGE`：HTTP 或 MCP 请求超过限制。
- `INVALID_ARGUMENT`：搜索、标签或分页参数不合法。
- `VERSION_CONFLICT`：文件版本已变化。
- `LIBRARY_ERROR`：Native Core 返回业务失败。

### 5.2 处理策略

1. 鉴权失败只返回稳定错误码和用户可读提示，不回显密钥或请求原文。
2. 远程连接断开不回滚已经完成的文件或标签修改，结果通过任务状态确认。
3. 批量标签写入失败时保留实际已完成数量和错误目标。
4. 旧配置缺少新字段时使用兼容默认值，不删除已有设置。
5. HTTP MCP 错误不将 Rust/Node 堆栈返回给远程客户端。

## 6. 正确性属性

### 6.1 属性 1：权限单调收紧

对于任何工具调用，最终允许的权限必须同时满足应用访问策略、客户端只读限制、工具 Schema 和资料库路径边界。

**验证需求：** 需求 1、需求 2。

### 6.2 属性 2：组合查询一致

对于相同资料库快照和相同搜索输入，CLI、MCP stdio、远程 MCP HTTP、桌面本地模式和 HTTP 模式返回相同的候选集合和排序。

**验证需求：** 需求 2、需求 3。

### 6.3 属性 3：批量范围隔离

对于任何批量标签任务，范围外文档的手工标签、派生标签、目录绑定和导出结果不得因为本任务发生变化。

**验证需求：** 需求 4、需求 5。

### 6.4 属性 4：密钥不可回显

对于任何配置响应、业务结果、HTTP 错误、任务错误和日志记录，均不得包含 API Key 明文。

**验证需求：** 需求 1、需求 6、需求 7。

## 7. 测试策略

### 7.1 单元测试

- Agent 设置迁移、access mode 和策略判断。
- 组合搜索输入 Schema、标签 AND、目录和关键词组合。
- 批量标签 add/remove/replace、dry-run、幂等和范围隔离。
- HTTP Bearer 鉴权、请求大小和敏感信息过滤。

### 7.2 集成测试

- CLI 与 MCP stdio 使用相同工具目录。
- Fastify `/api/mcp` 与 stdio 的工具发现、调用和错误结构一致。
- 本地 Tauri bridge 将桌面组合搜索参数完整传入 native。
- 任务中心与批量标签结果一致。

### 7.3 端到端测试

- 临时资料库完成远程 MCP 初始化、工具发现、组合搜索和批量标签。
- 轮换/撤销密钥后已有远程会话后续调用被拒绝。
- 只读策略拒绝文件写入和标签写入。
- 断开远程连接后任务结果可以查询。

### 7.4 验证映射

| 需求 | 设计章节 | 验证方式 |
| --- | --- | --- |
| 需求 1 | §3.1、§4、§5 | Rust 设置测试、CLI/MCP/HTTP 鉴权测试 |
| 需求 2 | §2、§3.6 | 工具目录对照和三种传输集成测试 |
| 需求 3 | §3.2、§6.2 | Native、server、web 搜索测试 |
| 需求 4 | §3.3、§6.3 | Rust 标签范围和真实临时库回放 |
| 需求 5 | §3.4、§4.2 | 任务状态和断开恢复测试 |
| 需求 6 | §3.5、§5 | Fastify MCP HTTP 端到端测试 |
| 需求 7 | §3.1、§3.5 | 设置页、API 和文档检查 |

## 8. 风险与待确认项

### 8.1 风险

- 当前 `rmcp` 版本是否已经提供可直接复用的 Streamable HTTP server transport，需要以本地依赖实际 API 为准。
- 现有 HTTP 服务的认证钩子、CORS 和 LAN 暴露策略可能影响远程 MCP 的请求头和长连接。
- 批量标签和远程断开之间需要明确任务结果持久化边界。
- 当前任务中心部分状态为进程内数据，远程 HTTP 需要避免承诺跨进程或跨重启恢复。

### 8.2 待确认项

- 远程 MCP 的生产 TLS 由部署层负责，X-File 只提供 HTTP 服务内的 MCP 协议入口。
- 本阶段不实现 OAuth 或多用户身份系统，远程客户端使用 X-File Agent API Key。
