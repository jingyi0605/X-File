# 任务清单 - 外部 Agent 平台与远程 MCP

状态：DONE（Server 全量测试仍有 5 项非 Agent 失败，详见 5.1）

## 阶段 1：建立 Spec 和基线

- [x] 1.1 锁定范围和兼容边界
  - 状态：DONE
  - 这一步到底做什么：明确本 Spec 只服务外部 Agent，并把远程 MCP HTTP 纳入本阶段。
  - 做完你能看到什么：需求明确包含本机 CLI、MCP stdio、远程 MCP HTTP、组合搜索、批量标签和访问策略。
  - 先依赖什么：无
  - 开始前先看：
    - `spec004-X-File移除内置助手与外部Agent接入/requirements.md`
    - `spec005-异步标签与统一任务中心/requirements.md`
    - `docs/20261026-外部Agent工具接入说明.md`
  - 主要改哪里：
    - `spec004.1-X-File外部Agent平台与远程MCP/README.md`
    - `spec004.1-X-File外部Agent平台与远程MCP/requirements.md`
    - `spec004.1-X-File外部Agent平台与远程MCP/design.md`
    - `spec004.1-X-File外部Agent平台与远程MCP/tasks.md`
    - `specs/README.md`
  - 这一步先不做什么：不实现模型、聊天、OAuth、多租户或向量搜索。
  - 怎么算完成：
    1. 范围、非目标和验收标准已经落盘。
    2. 远程 MCP 的鉴权方式明确为 Agent API Key Bearer。
  - 怎么验证：
    - Spec 文档走查。
    - 与当前工具目录、设置和传输实现对照。
  - 对应需求：全部
  - 对应设计：§1、§2

- [x] 1.2 基线检查点
  - 状态：DONE
  - 这一步到底做什么：确认当前工作区已有修改、Agent 测试基线和本地 `rmcp` 传输能力。
  - 做完你能看到什么：后续代码修改避开原有 Office 预览工作，远程传输实现有真实依赖依据。
  - 先依赖什么：1.1
  - 开始前先看：
    - `git status --short`
    - `apps/desktop/src-tauri/Cargo.toml`
    - `apps/desktop/src-tauri/src/agent_tools/mcp.rs`
    - 现有 `scripts/agent-tools.test.mjs`
  - 主要改哪里：无，只有检查记录
  - 这一步先不做什么：不启动开发服务器。
  - 怎么算完成：
    1. Rust Agent 工具测试 7 项通过；真实 CLI/MCP 测试 8 组通过。
    2. `rmcp 3.7.0` 有 Streamable HTTP Tower server transport；当前 HTTP 为 Fastify，采用 stateless Fastify 协议适配并调用原生 CLI 共用执行器。
    3. 工作区存在 Office 预览未提交修改，本 Spec 避开其文件和代码区段。
  - 怎么验证：
    - `cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --lib agent_tools`：7 passed。
    - `pnpm test:agent-tools`：8 passed。
    - `cargo tree --locked --manifest-path apps/desktop/src-tauri/Cargo.toml -i rmcp`：版本为 3.7.0。
  - 对应需求：需求 2、需求 6
  - 对应设计：§1.3、§2.1

## 阶段 2：访问策略和统一契约

- [ ] 2.1 增加服务端强制 access mode
  - 状态：DONE
  - 这一步到底做什么：在现有 Agent 设置中增加只读/读写策略，并让每次工具调用都重新校验。
  - 做完你能看到什么：即使客户端省略 `--read-only`，服务端只读策略也会拒绝写工具。
  - 先依赖什么：1.2
  - 开始前先看：
    - `requirements.md` 需求 1
    - `design.md` §3.1、§4.2、§5
    - `apps/desktop/src-tauri/src/agent_tools/settings.rs`
    - `packages/shared/src/agent-types.ts`
  - 主要改哪里：
    - `apps/desktop/src-tauri/src/agent_tools/settings.rs`
    - `apps/desktop/src-tauri/src/agent_tools/mod.rs`
    - `packages/shared/src/agent-types.ts`
    - `apps/server/src/routes/agent-settings-routes.ts`
    - `apps/web/src/features/settings/AgentIntegrationSettings.tsx`
    - `apps/web/src/i18n.ts`
  - 这一步先不做什么：不增加 OAuth、多用户或多 API Key 账户体系。
  - 怎么算完成：
    1. 旧设置文件可以读取，新设置写入 access mode。
    2. CLI、stdio 和 HTTP 入口都服从同一策略。
    3. 新生成配置默认只读，用户可显式切换读写。
  - 怎么验证：
    - Rust 设置和权限单元测试。
    - 设置 API 和前端 Agent 设置测试。
    - `pnpm --filter @x-file/web typecheck`
  - 对应需求：需求 1、需求 7
  - 对应设计：§3.1、§4.2、§5

- [ ] 2.2 统一工具契约和使用状态
  - 状态：DONE
  - 这一步到底做什么：补齐能力目录、搜索参数、批量工具和任务工具的 Schema、输出和文档。
  - 做完你能看到什么：CLI、stdio、HTTP 和设置页展示同一份实际能力。
  - 先依赖什么：2.1
  - 开始前先看：
    - `requirements.md` 需求 2
    - `design.md` §2.2、§3.2、§3.6
    - `apps/desktop/src-tauri/src/agent_tools/catalog.json`
    - `skills/x-file/SKILL.md`
  - 主要改哪里：
    - `apps/desktop/src-tauri/src/agent_tools/catalog.json`
    - `apps/desktop/src-tauri/src/agent_tools/output-schema.json`
    - `apps/desktop/src-tauri/src/agent_tools/mod.rs`
    - `skills/x-file/SKILL.md`
  - 这一步先不做什么：不复制第二套工具执行逻辑。
  - 怎么算完成：
    1. 新工具可以由 CLI schema 和 MCP tools/list 发现。
    2. 错误和成功结果保持统一信封。
  - 怎么验证：
    - Schema 校验测试。
    - `pnpm test:agent-tools`
  - 对应需求：需求 2
  - 对应设计：§2.2、§3.2、§3.6

### 阶段检查

- [ ] 2.3 访问策略和工具契约检查点
  - 状态：DONE
  - 这一步到底做什么：确认权限策略和新增工具契约已经可被三种入口一致发现。
  - 做完你能看到什么：可以进入搜索和批量业务实现，不会带着两套权限或 Schema 往前走。
  - 先依赖什么：2.1、2.2
  - 开始前先看：
    - `requirements.md` 需求 1、需求 2
    - `design.md` §2、§3、§4
  - 主要改哪里：阶段 2 全部相关文件
  - 这一步先不做什么：不加新的业务筛选条件。
  - 怎么算完成：
    1. 只读策略无法通过工具名或 CLI 参数绕过。
    2. 同一工具在 CLI 和 MCP 中的 Schema 完全一致。
  - 怎么验证：
    - Rust 单元测试和真实 CLI/MCP 回放。
  - 对应需求：需求 1、需求 2
  - 对应设计：§2、§3、§4

## 阶段 3：组合搜索和批量标签

- [ ] 3.1 修复本地组合搜索参数链路
  - 状态：DONE
  - 这一步到底做什么：让桌面 native bridge、HTTP API 和 Agent 工具都完整传递和暴露搜索范围、匹配模式和组合条件。
  - 做完你能看到什么：本地桌面模式和 HTTP 模式对同一搜索条件返回一致结果。
  - 先依赖什么：2.3
  - 开始前先看：
    - `requirements.md` 需求 3
    - `design.md` §2.3.2、§3.2、§6.2
    - `apps/web/src/api/library.ts`
    - `apps/web/src/runtime/native-library-bridge.ts`
    - `apps/desktop/src-tauri/src/lib.rs`
  - 主要改哪里：
    - `apps/web/src/api/library.ts`
    - `apps/web/src/runtime/native-library-bridge.ts`
    - `apps/desktop/src-tauri/src/agent_tools/catalog.json`
    - `apps/desktop/src-tauri/src/agent_tools/mod.rs`
    - 相关搜索测试
  - 这一步先不做什么：不引入向量搜索或模型推理。
  - 怎么算完成：
    1. `searchScope`、`searchMode` 能从 UI/Agent 到 native 完整到达。
    2. 多标签 AND、目录、收藏、关键词组合行为有回归测试。
  - 怎么验证：
    - server/native/web 搜索测试。
    - 真实 CLI 查询回放。
  - 对应需求：需求 3
  - 对应设计：§3.2、§6.2

- [ ] 3.2 实现批量文档标签工具
  - 状态：DONE
  - 这一步到底做什么：增加按文档 ID、目录或组合搜索结果执行 add/remove/replace 的统一工具。
  - 做完你能看到什么：Agent 可以一次处理搜索结果集，不再逐文件往返调用。
  - 先依赖什么：3.1
  - 开始前先看：
    - `requirements.md` 需求 4
    - `design.md` §2.3.3、§3.3、§6.3
    - `apps/desktop/src-tauri/src/native_core/tag_core.rs`
    - `apps/desktop/src-tauri/src/agent_tools/mod.rs`
  - 主要改哪里：
    - `apps/desktop/src-tauri/src/native_core/tag_core.rs`
    - `apps/desktop/src-tauri/src/agent_tools/mod.rs`
    - `apps/desktop/src-tauri/src/agent_tools/catalog.json`
    - `scripts/agent-tools.test.mjs`
  - 这一步先不做什么：不让 Agent 执行任意文件系统命令，不改变目录标签的继承语义。
  - 怎么算完成：
    1. dry-run 不产生写入。
    2. add/remove/replace 只影响冻结目标集合。
    3. 单次批量操作只执行范围导出，并返回结构化统计。
  - 怎么验证：
    - Rust 标签范围测试。
    - 临时资料库 CLI/MCP 真实回放。
  - 对应需求：需求 4、需求 5
  - 对应设计：§3.3、§4.2、§6.3

- [ ] 3.3 接入 Agent 任务查询
  - 状态：DONE
  - 这一步到底做什么：把批量标签和现有任务中心状态暴露给 Agent。
  - 做完你能看到什么：Agent 能查询任务阶段、进度和错误，不依赖桌面界面。
  - 先依赖什么：3.2
  - 开始前先看：
    - `requirements.md` 需求 5
    - `design.md` §3.4、§4.2
    - `apps/desktop/src-tauri/src/native_core/task_center.rs`
    - `apps/desktop/src-tauri/src/agent_tools/mod.rs`
  - 主要改哪里：
    - `apps/desktop/src-tauri/src/agent_tools/mod.rs`
    - `apps/desktop/src-tauri/src/agent_tools/catalog.json`
    - `apps/desktop/src-tauri/src/agent_tools/mcp.rs`
    - 任务测试
  - 这一步先不做什么：不承诺跨重启任务恢复，不实现复杂取消协议。
  - 怎么算完成：
    1. Agent 能按当前资料库读取任务列表和单个任务。
    2. 长任务状态读取不被不相关的只读请求永久阻塞。
  - 怎么验证：
    - MCP 并发请求测试。
    - 任务中心 Rust 测试。
  - 对应需求：需求 5
  - 对应设计：§3.4、§4.2

### 阶段检查

- [ ] 3.4 搜索和批量标签检查点
  - 状态：DONE
  - 这一步到底做什么：确认从组合搜索到批量标签的 Agent 主路径已经闭环。
  - 做完你能看到什么：Agent 可以查询候选文件、dry-run、执行批量标签并查询结果。
  - 先依赖什么：3.1、3.2、3.3
  - 开始前先看：
    - `requirements.md` 需求 3、需求 4、需求 5
    - `design.md` §3.2、§3.3、§3.4、§6
  - 主要改哪里：阶段 3 全部相关文件
  - 这一步先不做什么：不开始远程网络传输实现。
  - 怎么算完成：
    1. 搜索、dry-run、正式写入和状态查询均有真实回放。
    2. 范围外文档和标签保持不变。
  - 怎么验证：
    - `pnpm test:agent-tools`
    - 相关 Rust/server/web 测试。
  - 对应需求：需求 3、需求 4、需求 5
  - 对应设计：§3.2、§3.3、§3.4、§6.2、§6.3

## 阶段 4：远程 MCP HTTP

- [ ] 4.1 验证并接入 HTTP MCP transport
  - 状态：DONE
  - 这一步到底做什么：根据本地 `rmcp` 版本接入 Streamable HTTP server transport，复用统一 MCP handler。
  - 做完你能看到什么：现有 Fastify 服务可以承载 MCP 初始化和工具请求。
  - 先依赖什么：2.3、3.4
  - 开始前先看：
    - `requirements.md` 需求 6
    - `design.md` §2.1、§2.3.1、§3.5
    - `apps/desktop/src-tauri/Cargo.toml`
    - `apps/desktop/src-tauri/src/agent_tools/mcp.rs`
    - `apps/server/src/app.ts`
  - 主要改哪里：
    - `apps/desktop/src-tauri/src/agent_tools/mcp.rs`
    - `apps/desktop/src-tauri/src/agent_tools/mod.rs`
    - `apps/server/src/routes/`
    - `apps/server/src/app.ts`
    - `apps/server/package.json` 或 Rust 依赖配置（按实际 transport 边界）
  - 这一步先不做什么：不新增独立端口、不启动开发服务器、不实现 OAuth。
  - 怎么算完成：
    1. HTTP MCP 请求进入同一工具执行层。
    2. Bearer API Key 校验和 access mode 生效。
    3. 响应符合 MCP transport 契约。
  - 怎么验证：
    - Rust/Node HTTP MCP 协议测试。
    - 使用临时资料库执行初始化、tools/list、tools/call 和资源读取。
  - 对应需求：需求 2、需求 6
  - 对应设计：§2.1、§2.3.1、§3.5

- [ ] 4.2 远程 HTTP 安全和生命周期
  - 状态：DONE
  - 这一步到底做什么：补齐 Bearer 鉴权、请求大小、会话头、错误过滤、CORS 和服务配置边界。
  - 做完你能看到什么：远程 MCP 不会绕过既有 HTTP 认证边界，也不会泄露密钥或宿主信息。
  - 先依赖什么：4.1
  - 开始前先看：
    - `requirements.md` 需求 6
    - `design.md` §3.5、§5
    - `apps/server/src/http-server-manager.ts`
    - `apps/server/src/routes/agent-settings-routes.ts`
    - 现有 HTTP auth hook 和 CORS 配置
  - 主要改哪里：
    - `apps/server/src/`
    - `apps/desktop/src-tauri/src/agent_tools/settings.rs`
    - HTTP MCP 测试
  - 这一步先不做什么：不把 MCP Bearer Key 用作 Web 登录 Cookie，不提供 URL 密钥兼容。
  - 怎么算完成：
    1. 无 Key、错误 Key、撤销 Key、只读策略均有明确响应。
    2. 非法 Origin、过大请求和无效会话被拒绝。
    3. 日志和错误响应不包含密钥。
  - 怎么验证：
    - HTTP 集成测试。
    - 密钥轮换和已有连接回放。
  - 对应需求：需求 1、需求 6
  - 对应设计：§3.5、§5

- [ ] 4.3 远程接入文档和设置页
  - 状态：DONE
  - 这一步到底做什么：让用户能看到远程 MCP 地址、Bearer Key 使用方式、TLS 和反向代理要求。
  - 做完你能看到什么：用户可以在资料库主机配置远程 Agent，不需要猜路径或复制错误示例。
  - 先依赖什么：4.2
  - 开始前先看：
    - `docs/20260609-前端开发规范.md`
    - `requirements.md` 需求 7
    - `design.md` §3.1、§3.5
    - `apps/web/src/features/settings/AgentIntegrationSettings.tsx`
  - 主要改哪里：
    - `apps/web/src/features/settings/AgentIntegrationSettings.tsx`
    - `apps/web/src/i18n.ts`
    - `apps/web/src/styles.css`
    - `skills/x-file/SKILL.md`
    - `docs/20261026-外部Agent工具接入说明.md`
  - 这一步先不做什么：不自动写入第三方客户端配置。
  - 怎么算完成：
    1. 本机 stdio、CLI 和远程 HTTP 三种配置示例与实际能力一致。
    2. 设置页继续使用全局 token、统一按钮和 `DesktopModal`。
  - 怎么验证：
    - Agent 设置前端回归测试。
    - Web typecheck/build。
  - 对应需求：需求 7
  - 对应设计：§3.1、§3.5、§3.6

## 阶段 5：最终验证

- [x] 5.1 三种传输一致性验收
  - 状态：DONE
  - 这一步到底做什么：用同一临时资料库分别通过 CLI、MCP stdio 和远程 MCP HTTP 执行相同查询和标签流程。
  - 做完你能看到什么：三种入口的工具发现、搜索、批量标签、错误和权限结果一致。
  - 先依赖什么：4.3
  - 开始前先看：
    - `requirements.md`
    - `design.md` §7
    - `tasks.md`
  - 主要改哪里：
    - `scripts/agent-tools.test.mjs`
    - HTTP MCP 集成测试
    - `spec004.1-X-File外部Agent平台与远程MCP/docs/`
  - 这一步先不做什么：不启动开发服务器，不做真实生产公网部署。
  - 怎么算完成：
    1. 关键需求逐项有测试结果。
    2. 已知限制、TLS 部署责任和未覆盖平台写清楚。
  - 怎么验证：
    - Rust tests、server tests、web typecheck/build、CLI/MCP/HTTP E2E。
  - 当前验证记录：
    - DONE：真实 CLI + MCP stdio 回放 9/9；批量文档和目录 add/remove、dry-run、幂等重试、任务读取通过。
    - DONE：Rust Agent 工具测试 7/7，native tag/task 定向测试 12/12；Rust CLI binary 当前可成功构建。
    - DONE：Fastify 远程 MCP HTTP 测试 4/4，覆盖握手、工具/资源、组合搜索、批量标签任务、Origin、请求大小、notification、只读拒写和密钥轮换。
    - DONE：Web Agent 设置、HTTP 搜索参数和 native bridge 定向测试 16/16；Web typecheck 通过。
    - DONE：`cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --lib` 90/90；Rust CLI binary build 通过。
    - DONE：Server typecheck、Web typecheck 均通过。
    - KNOWN FAILURES：Server 全量测试 147/152；失败为索引 manifest 时间/hash 断言 2 项，以及 Office 预览服务契约 3 项。Agent HTTP 路由独立测试 4/4 通过。
    - INFO：本机没有安装 rustfmt，`cargo fmt --check` 无法运行。
  - 对应需求：全部
  - 对应设计：§7

- [x] 5.2 最终检查点
  - 状态：DONE
  - 这一步到底做什么：更新 Spec 状态、验收记录和当前能力说明。
  - 做完你能看到什么：需求、设计、实现、测试和文档能够互相追踪。
  - 先依赖什么：5.1
  - 开始前先看：
    - `requirements.md`
    - `design.md`
    - `tasks.md`
    - `docs/`
  - 主要改哪里：
    - 当前 Spec 全部文件
    - `README.md`
    - `specs/README.md`
    - `docs/20261026-外部Agent工具接入说明.md`
  - 这一步先不做什么：不追加新的平台化范围。
  - 怎么算完成：
    1. 需求与验证结果一一对应。
    2. 工作区既有用户修改没有被覆盖。
    3. 未启动开发服务器或提交未经用户要求的提交。
  - 怎么验证：
    - Spec 验收清单。
    - `git diff --check`。
  - 验收记录：CLI、MCP stdio 与远程 HTTP 关键流程均有真实回放；远程 MCP 使用现有 HTTP 服务、Bearer API Key 和 stateless POST，不启动服务、不改第三方配置、不提交。工作区的 Office/backup 用户修改均保留。Rust tests 和 TypeScript typecheck 通过；Server 全量测试有 5 项既有索引/Office 失败，详见 5.1。
  - 对应需求：全部
  - 对应设计：全文
