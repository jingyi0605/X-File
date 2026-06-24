# 任务清单 - spec002-X-File内置文档引擎与集成插件化（人话版）

状态：Draft

## 这份文档是干什么的

这份任务清单不是为了写漂亮大词，而是为了把这次架构收缩真正落地：

- 先切清主 APP、内置文档引擎、插件三者边界
- 再把文档库重活稳稳留在主 APP 内置 sidecar
- 再把 assistant / CLI 从安装包里彻底拆出去
- 最后补插件安装、更新、回滚和验收

## 状态说明

- `TODO`：还没开始
- `IN_PROGRESS`：正在做
- `BLOCKED`：被外部问题卡住
- `IN_REVIEW`：已经有结果，等复核
- `DONE`：已经完成，并且已经回写状态
- `CANCELLED`：取消，不做了，但要写原因

规则：

- 只有 `状态：DONE` 的任务才能勾选成 `[x]`
- `BLOCKED` 必须写清楚卡在哪里
- `CANCELLED` 必须写清楚为什么不做
- 每做完一个任务，必须立刻更新这里

---

## 阶段 1：先把边界切干净

- [x] 1.1 盘清当前安装包和运行边界
  - 状态：DONE
  - 本次完成结果：已新增 `docs/20260616-当前打包与依赖边界清单.md`，确认当前 `tauri.conf.json` 仍随包带 `x-file-server` 和 `x-file-runtime`，资源目录约 `336M`，其中 `x-file-runtime` 约 `105M`、`x-file-server` 约 `226M`；同时确认 `@codingns/session-sync-core` 是当前 assistant / CLI 进入正式 server 生产依赖的关键入口。
  - 剩余缺口：这里只做边界盘点，不改打包实现；实际移除 assistant / CLI 和收缩随包资源放到阶段 2。
  - 这一步到底做什么：把当前桌面包里哪些内容属于文档库核心，哪些内容属于 assistant / CLI 依赖，逐项盘清并形成可执行清单。
  - 做完你能看到什么：后续删包、拆依赖、调打包时不会靠猜。
  - 先依赖什么：无
  - 开始前先看：
    - `requirements.md` 需求 1、需求 3
    - `design.md` §2.1「系统结构」
    - `design.md` §2.2「模块职责」
  - 主要改哪里：
    - `specs/spec002-X-File内置文档引擎与集成插件化/`
    - 当前打包脚本与 desktop 配置相关文档引用
  - 这一步先不做什么：不删代码，不改打包。
  - 怎么算完成：
    1. 当前随包内容有清晰分类
    2. assistant / CLI 相关依赖名单被单独列出来
    3. 文档库核心内置范围被明确钉死
  - 怎么验证：
    - 人工走查打包配置和依赖树
  - 对应需求：`requirements.md` 需求 1、需求 3
  - 对应设计：`design.md` §2.1、§2.2

- [x] 1.2 定义主 APP 与内置文档引擎接口
  - 状态：DONE
  - 本次完成结果：已新增 `docs/20260616-主APP与内置文档引擎接口边界.md`，明确第一阶段采用本地 HTTP 作为过渡 transport，由 `LibraryEngineClient` 屏蔽协议；读接口不得隐式触发重任务，刷新、watcher、SQLite、export 归属内置 `library-engine`。
  - 剩余缺口：接口文档已定，但具体 `LibraryEngineHost`、`LibraryEngineClient` 和 sidecar 进程实现放到阶段 2。
  - 这一步到底做什么：明确主 APP 和 `library-engine` 之间到底走什么接口，哪些请求属于读，哪些请求属于重任务。
  - 做完你能看到什么：sidecar 改造不会变成“把旧后端整个搬个位置”。
  - 先依赖什么：1.1
  - 开始前先看：
    - `requirements.md` 需求 2
    - `design.md` §2.3.1「主 APP 启动与内置文档引擎拉起」
    - `design.md` §3.3.1「主 APP 到内置文档引擎」
  - 主要改哪里：
    - `specs/spec002-X-File内置文档引擎与集成插件化/design.md`
    - 主 APP / sidecar 边界相关实现文件
  - 这一步先不做什么：不实现插件系统。
  - 怎么算完成：
    1. sidecar 接口清单明确
    2. 查询链路和重任务链路分开
    3. 错误模型和健康检查路径明确
  - 怎么验证：
    - 人工走查接口与边界
  - 对应需求：`requirements.md` 需求 2
  - 对应设计：`design.md` §2.3.1、§3.3.1、§4.2

### 阶段检查

- [x] 1.3 阶段检查：边界已经定死
  - 状态：DONE
  - 本次完成结果：阶段 1 已经确认三条硬边界：文档库主链路无插件可运行；assistant / CLI 不进入主安装包；插件模型只有主 APP + Integration Plugin 一层。后续实现不得把 `@codingns/session-sync-core` 继续作为正式主包生产依赖。
  - 剩余缺口：阶段 2 需要按这个边界开始改代码和打包脚本。
  - 这一步到底做什么：确认这次改造已经知道“什么必须内置、什么必须移除、什么以后走插件”，不再边做边摇摆。
  - 做完你能看到什么：后续实现不会再把 assistant 偷偷塞回主包。
  - 先依赖什么：1.1、1.2
  - 开始前先看：
    - `requirements.md`
    - `design.md`
    - `tasks.md`
  - 主要改哪里：本阶段全部相关文件
  - 这一步先不做什么：不进入实现细节。
  - 怎么算完成：
    1. 主 APP / sidecar / 插件边界一致
    2. 没有含糊地带留给实现时拍脑袋
  - 怎么验证：
    - 人工走查
  - 对应需求：`requirements.md` 需求 1、需求 2、需求 3、需求 4
  - 对应设计：`design.md` §2、§3

---

## 阶段 2：把文档库重活收进内置 sidecar

- [x] 2.1 建立内置 `library-engine` sidecar 宿主
  - 状态：DONE
  - 本次完成结果：已新增 `packages/library-engine` workspace 包，提供 `createLibraryEngineServer`、`/api/engine/health` 和独立 `dist/main.js` 入口；桌面壳资源查找已优先使用 `x-file-library-engine/dist/main.js`，打包准备脚本也开始生成 `x-file-library-engine` 资源目录。
  - 剩余缺口：当前 `library-engine` 仍复用 `@x-file/server/app` 和现有 HTTP API 作为过渡，真正把 `indexer + sqlite + watcher + export` 从协调层收口到独立引擎内部放到 2.2；assistant 生产依赖彻底移除放到 2.3。
  - 这一步到底做什么：让主 APP 能单独拉起、停止并检查内置文档引擎。
  - 做完你能看到什么：主 APP 不再直接依赖一整套随包通用后端。
  - 先依赖什么：1.3
  - 开始前先看：
    - `requirements.md` 需求 1、需求 2
    - `design.md` §2.1「系统结构」
    - `design.md` §3.1「核心组件」
  - 主要改哪里：
    - `apps/desktop/`
    - `apps/desktop/src-tauri/`
    - `apps/server/` 或新的引擎宿主目录
  - 这一步先不做什么：不处理插件。
  - 怎么算完成：
    1. 主 APP 可以拉起内置引擎
    2. 有健康检查和错误状态
    3. 有明确启停生命周期
  - 怎么验证：
    - 引擎启停集成测试
  - 对应需求：`requirements.md` 需求 1、需求 2
  - 对应设计：`design.md` §2.3.1、§3.1、§4.2

- [x] 2.2 把 `indexer + sqlite + watcher + export` 收口到内置引擎
  - 状态：DONE
  - 本次完成结果：已新增 `apps/server/src/library/library-engine-feature.ts`，把文档库核心服务装配集中到一个无 assistant 的 engine feature；`packages/library-engine/src/app.ts` 现在直接创建自己的 Fastify 实例并注册文档库、目录浏览、ONLYOFFICE、标签、集成状态和 `/api/engine/health`，不再通过 `@x-file/server/app` 间接继承整套旧后端。当前 `LibraryIndexService` 继续承担 indexer 调度，SQLite 和 export 仍由 `@x-file/indexer` 与现有 storage/export reader 提供，watcher 服务保留在文档库层并随 engine 边界归属，不进入插件。
  - 剩余缺口：watcher 目前仍是服务能力和测试覆盖，尚未新增独立 HTTP 启停接口；这不影响“归属 engine”边界，但后续插件阶段前应补 `startWatcher()` / `stopWatcher()` 的显式调用面。
  - 这一步到底做什么：让文档库真正的重任务都从主 APP 协调层移到内置引擎里执行。
  - 做完你能看到什么：文档库主链路还是能跑，但重活边界变清楚了。
  - 先依赖什么：2.1
  - 开始前先看：
    - `requirements.md` 需求 1、需求 2
    - `design.md` §2.2「模块职责」
    - `design.md` §3.3.1「主 APP 到内置文档引擎」
  - 主要改哪里：
    - `packages/indexer/`
    - `apps/server/src/library/`
    - sidecar 接口实现相关文件
  - 这一步先不做什么：不把所有外围业务都迁进引擎。
  - 怎么算完成：
    1. 四条核心链路都由内置引擎承担
    2. 查询接口不再顺手触发重活
    3. 崩溃和异常有可读状态
  - 怎么验证：
    - 文档库主链路回放
    - 重任务集成测试
  - 对应需求：`requirements.md` 需求 1、需求 2
  - 对应设计：`design.md` §2.2、§2.3.2、§3.3.1

- [x] 2.3 从正式安装包移除 assistant / CLI 依赖
  - 状态：DONE
  - 本次完成结果：`@codingns/session-sync-core` 已从 `@x-file/server` 生产依赖移到 devDependency；正式准备脚本现在只 `pnpm --filter @x-file/library-engine --prod deploy`，不再部署 `x-file-server`。脚本会删除旧 `resources/x-file-server`，并清理 engine 资源目录中的 assistant 源码、assistant dist、assistant shared types、旧 server app/main 入口和 dev 元数据。Tauri resources 现在只声明 `x-file-library-engine` 与 `x-file-runtime`。
  - 产物检查结果：`apps/desktop/src-tauri/resources/x-file-server` 已删除；`x-file-library-engine` 为 `27M`，`x-file-runtime` 为 `105M`，resources 总计约 `131M`；扫描未发现 `session-sync-core`、`@openai/codex-sdk`、`assistant-routes`、`ClaudeRuntimeAdapter`、`CodexRuntimeAdapter`。
  - 剩余缺口：完整 Node runtime 仍随包存在，这是后续 Rust/Tauri commands 或更轻 native sidecar 才能继续砍掉的 105M；assistant / CLI 插件安装和更新属于阶段 3。
  - 这一步到底做什么：把 Codex、Claude Code、session-sync-core 及相关依赖从正式构建链路里剥出去。
  - 做完你能看到什么：安装包里不再包含非核心 assistant 运行时。
  - 先依赖什么：2.2
  - 开始前先看：
    - `requirements.md` 需求 3
    - `design.md` §2.1「系统结构」
    - `design.md` §5.1「错误类型」
  - 主要改哪里：
    - `apps/server/package.json`
    - `packages/session-sync-core/`
    - 桌面打包脚本和构建配置
  - 这一步先不做什么：不立即做插件接入。
  - 怎么算完成：
    1. 正式打包链路不再引用 assistant / CLI 依赖
    2. 无插件状态下文档库仍完整可用
    3. 缺失 assistant 不影响主 APP 启动
  - 怎么验证：
    - 构建产物检查
    - 无插件启动验证
  - 对应需求：`requirements.md` 需求 3
  - 对应设计：`design.md` §2.1、§6.1

### 阶段检查

- [x] 2.4 阶段检查：主包已经只剩文档库核心
  - 状态：DONE
  - 本次完成结果：阶段 2 已完成主包资源收缩：正式包不再带 `x-file-server`，不再带 assistant / CLI 运行依赖，内置 sidecar 入口固定为 `x-file-library-engine/dist/main.js`；旧 `@x-file/server/app` 仍保留开发/兼容入口，assistant 仅在旧 server 入口通过动态 import 可选加载，不参与正式 engine deploy。
  - 验证结果：已通过 `pnpm --filter @x-file/shared build`、`pnpm --filter @x-file/indexer build`、`pnpm --filter @x-file/server build`、`pnpm --filter @x-file/library-engine build`、`pnpm typecheck`、`node scripts/archive/20260616/prepare-bundled-server.mjs`；生产资源扫描确认无 assistant / CLI 运行依赖。
  - 剩余缺口：阶段 3 需要实现单层 Integration Plugin 的 manifest、注册表、安装、更新、回滚，以及 codex / assistant 插件化接入。
  - 这一步到底做什么：确认主 APP 已经回到该有的形状，不再带 assistant 包袱。
  - 做完你能看到什么：主包瘦身方向成立，下一步才能上插件系统。
  - 先依赖什么：2.1、2.2、2.3
  - 开始前先看：
    - `requirements.md`
    - `design.md`
    - `tasks.md`
  - 主要改哪里：本阶段全部相关文件
  - 这一步先不做什么：不加新功能。
  - 怎么算完成：
    1. 文档库主链路无插件可跑
    2. assistant / CLI 不再进入正式包
    3. sidecar 边界稳定
  - 怎么验证：
    - 人工走查
    - 构建和功能回放
  - 对应需求：`requirements.md` 需求 1、需求 2、需求 3
  - 对应设计：`design.md` §2、§3、§6

---

## 阶段 3：建立单层 Integration Plugin 系统

- [x] 3.1 建立插件目录、manifest 和注册表
  - 状态：DONE
  - 本次完成结果：已新增 `packages/shared/src/plugin-types.ts`，定义单层 `Integration Plugin` 的 `PluginManifest`、`PluginRegistryRecord`、`PluginHealth`、`PluginListResult`；主 APP 后端新增 `PluginRegistryStore`、`PluginService` 和 `GET /api/plugins`，插件目录固定落在 `~/.x-file/plugins`；设置页集成页已新增插件注册表面板，可展示插件根目录、已注册插件、版本、启用状态、能力声明和健康状态。
  - 附带修复：为避免 Fastify 在 listen 后再补 assistant 路由触发 `FST_ERR_INSTANCE_ALREADY_LISTENING`，`createServer()` 已改成同步注册 assistant 路由，真正的 `AssistantRuntimeService` 仅在请求进入时懒加载；这保持了打包边界，也恢复了后端测试稳定性。
  - 剩余缺口：当前只实现注册表读取与展示，还没有下载、校验、解压、启用、禁用、升级和卸载；provider CLI/auth 探测仍留给 3.2/3.3。
  - 这一步到底做什么：建立唯一的一层插件模型，让主 APP 能识别、记录和管理 Integration Plugin。
  - 做完你能看到什么：插件不再是散落脚本，而是有 manifest 和注册表的正式扩展。
  - 先依赖什么：2.4
  - 开始前先看：
    - `requirements.md` 需求 4、需求 6
    - `design.md` §3.2「数据结构」
    - `design.md` §4.1「数据关系」
  - 主要改哪里：
    - 插件管理相关主 APP 目录
    - 本地状态存储
    - 插件管理 UI 入口
  - 这一步先不做什么：不实现远程插件商店。
  - 怎么算完成：
    1. Integration Plugin manifest 可解析
    2. 本地注册表可记录安装和启用状态
    3. 只有一种插件类型
  - 怎么验证：
    - `pnpm --filter @x-file/server test`
    - `pnpm --filter @x-file/web test -- --run SettingsPage.test.tsx`
    - `pnpm typecheck`
  - 对应需求：`requirements.md` 需求 4、需求 6
  - 对应设计：`design.md` §3.2、§4.1

- [x] 3.2 实现插件安装、更新、禁用和卸载
  - 状态：DONE
  - 本次完成结果：主 APP 后端 `PluginService` 已补齐 `installPlugin`、`updatePlugin`、`enablePlugin`、`disablePlugin`、`uninstallPlugin`，并通过 `PluginRegistryStore` 管理 `~/.x-file/plugins/<pluginId>/<version>` 目录；当前安装源采用“本地目录插件源”，安装和更新前校验 manifest、入口和 `minAppVersion`，更新失败会保留旧注册记录并回滚。前端设置页集成页已新增插件源目录输入、安装按钮、启用/禁用、更新和卸载动作。
  - 这一步的收敛策略：第一版故意不接远程下载和插件市场，只做本地目录源。原因不是功能缩水，而是先把安装状态机、注册表切换、失败回滚和 UI 操作路径做扎实；远程下载后续只需要替换 source adapter，不该先把复杂度引进来。
  - 剩余缺口：还没有 hash/签名校验，也没有远程 JSON 索引或下载器；provider CLI/auth 健康探测和 assistant 真实接入留给 3.3。
  - 这一步到底做什么：让主 APP 可以在运行后真正装插件、更新插件，并在失败时回滚。
  - 做完你能看到什么：用户不用重装主程序就能接入 assistant / CLI。
  - 先依赖什么：3.1
  - 开始前先看：
    - `requirements.md` 需求 5、需求 6
    - `design.md` §2.3.3「插件安装」
    - `design.md` §2.3.4「插件更新与回滚」
  - 主要改哪里：
    - `plugin-manager`
    - 插件状态 UI
    - 本地插件目录相关实现
  - 这一步先不做什么：不做插件市场推荐。
  - 怎么算完成：
    1. 可以安装插件
    2. 可以更新并回滚
    3. 可以禁用和卸载
  - 怎么验证：
    - `pnpm --filter @x-file/server test`
    - `pnpm --filter @x-file/web test -- --run SettingsPage.test.tsx`
    - `pnpm typecheck`
  - 对应需求：`requirements.md` 需求 5、需求 6
  - 对应设计：`design.md` §2.3.3、§2.3.4、§5.3

- [x] 3.3 实现 assistant / CLI Integration Plugin 接入
  - 状态：DONE
  - 本次完成结果：已新增 `ProviderBridgeService`，把 provider 的 CLI 命令探测、登录态探测和健康状态统一收口到插件系统；`PluginService` 现在会对带 `manifest.provider` 的插件计算 `commandReady/authReady/detail/status`，并新增 `listEnabledAssistantProviders()` 作为 assistant 唯一 provider 来源。`AssistantRuntimeService` 已删除写死 provider 列表，不再自己维护 codex / claude-code 真相，而是只消费“已安装且启用的 Integration Plugin + 本机探测结果”。前端设置页集成页已展示插件级 `命令检测 / 登录态检测` 状态，仓库也新增了 `plugins/codex-integration/manifest.json` 与 `plugins/claude-code-integration/manifest.json` 两个本地示例插件。
  - 验证结果：新增 `apps/server/src/plugins/provider-bridge-service.test.ts` 覆盖命令缺失、未登录和完全就绪三种健康状态；新增 `apps/server/src/routes/assistant-routes.test.ts` 验证 `/api/assistant/providers` 只返回“已安装且启用”的 provider 插件；原有插件路由测试和设置页测试已同步覆盖 provider 健康字段展示。
  - 剩余缺口：当前 provider bridge 只支持本地 CLI + 本地登录态文件/目录探测；远程插件源、签名校验、自定义 auth strategy 和真正按插件 backend/ui 入口执行的扩展逻辑留给后续阶段。
  - 这一步到底做什么：把 Codex / Claude Code 之类能力改成插件接入，并优先复用本机 CLI 和登录态。
  - 做完你能看到什么：assistant 不在安装包里，但按需装完插件就能看到 provider 状态和入口。
  - 先依赖什么：3.2
  - 开始前先看：
    - `requirements.md` 需求 6、需求 7
    - `design.md` §2.3.5「assistant / CLI 插件接入」
    - `design.md` §3.3.3「provider 探测接口」
  - 主要改哪里：
    - assistant 插件 manifest 和宿主入口
    - provider bridge 相关实现
    - 插件管理与 provider UI
  - 这一步先不做什么：不重新把 provider runtime 打进主包。
  - 怎么算完成：
    1. 插件能探测本机 CLI
    2. 插件能探测登录态
    3. 缺失条件时返回清楚诊断
  - 怎么验证：
    - `pnpm --filter @x-file/server test`
    - `pnpm --filter @x-file/web test -- --run SettingsPage.test.tsx`
    - `pnpm typecheck`
  - 对应需求：`requirements.md` 需求 6、需求 7
  - 对应设计：`design.md` §2.3.5、§3.3.3

### 最终检查

- [x] 3.4 最终检查点
  - 状态：DONE
  - 本次完成结果：已按 Spec 全链路复核主包、sidecar 和插件边界。正式 Tauri resources 当前只保留 `x-file-library-engine` 与 `x-file-runtime`，其中 `x-file-library-engine` 约 `27M`、`x-file-runtime` 约 `105M`；`tauri.conf.json` 资源声明和打包脚本都已不再引用 `x-file-server`。`@x-file/server` 生产依赖已只保留 `fastify + @x-file/indexer + @x-file/shared`，`@codingns/session-sync-core` 仅保留在 devDependency。assistant provider 入口已完全改成“已安装且启用的 Integration Plugin + 本机 CLI/auth 探测”驱动，仓库内也有 `plugins/codex-integration` 与 `plugins/claude-code-integration` 两个示例插件 manifest 可直接用于本地安装联调。
  - 验证结果：对 `apps/desktop/src-tauri/resources` 做资源扫描，未命中 `session-sync-core`、`assistant-routes`、`ClaudeRuntimeAdapter`、`CodexRuntimeAdapter`、`@openai/codex-sdk` 等旧 assistant 关键符号；server / web / workspace typecheck 已全部通过，插件安装、更新、回滚、provider bridge 与 assistant providers 插件可见性测试均已跑通。
  - 剩余缺口：主包里仍带完整 Node runtime `105M`，这是下一阶段继续砍体积时要面对的独立问题；要继续往下压，只能再做 native sidecar / Rust 收口，而不是再回头把 assistant 或通用后端塞回主包。
  - 这一步到底做什么：确认这次改造真的把主包、内置引擎、可选集成三者切干净了。
  - 做完你能看到什么：后续继续做体积优化、插件演进、provider 接入时不会再回到混装状态。
  - 先依赖什么：3.1、3.2、3.3
  - 开始前先看：
    - `requirements.md`
    - `design.md`
    - `tasks.md`
  - 主要改哪里：当前 Spec 全部文件
  - 这一步先不做什么：不再追加新范围。
  - 怎么算完成：
    1. 文档库主链路无插件可用
    2. assistant / CLI 已改为插件接入
    3. 安装、更新、回滚链路可验证
  - 怎么验证：
    - `du -sh apps/desktop/src-tauri/resources/*`
    - `rg -n "session-sync-core|@openai/codex-sdk|assistant-routes|ClaudeRuntimeAdapter|CodexRuntimeAdapter|claude-code|codex" apps/desktop/src-tauri/resources/x-file-library-engine apps/desktop/src-tauri/resources/x-file-runtime`
    - `pnpm --filter @x-file/server test`
    - `pnpm --filter @x-file/web test -- --run SettingsPage.test.tsx`
    - `pnpm typecheck`
  - 对应需求：`requirements.md` 全部需求
  - 对应设计：`design.md` 全文

## 阶段 3 增量补切：assistant 运行时真正插件拥有

- [x] 3.5 建立 plugin backend entry contract 并接通最小 assistant 运行时链路
  - 状态：DONE
  - 本次完成结果：新增 `packages/shared/src/assistant-plugin-types.ts` 作为插件 backend entry contract，主 APP 新增 `apps/server/src/plugins/plugin-backend-loader.ts` 负责按已安装插件的 `manifest.entry.backend` 动态装载 runtime module；`AssistantRuntimeService` 已删除宿主内 `CodexRuntimeAdapter / ClaudeRuntimeAdapter` 的直接构造，改成按会话 provider 从插件 backend entry 获取 runtime adapter 与能力声明。仓库内 `plugins/codex-integration/backend/index.js` 与 `plugins/claude-code-integration/backend/index.js` 现在是可执行的真实 backend entry，不再只是 manifest 占位。
  - 最小链路证明：新增 `apps/server/src/plugins/plugin-backend-loader.test.ts` 覆盖 backend entry 装载；新增 `apps/server/src/routes/assistant-runtime-plugin-chain.test.ts` 覆盖“安装带 backend entry 的 codex 插件 -> 创建 assistant session -> 通过插件 runtime 返回 SSE assistant message”的最小会话链路。
  - 还残留的宿主职责：会话持久化、SSE 下发、权限请求桥接、统一 DTO、provider bridge 健康诊断仍在主 APP，这些属于宿主边界，不再承担 provider-specific runtime。
  - 剩余缺口：当前权限桥接仍按 codex 请求结构解析，说明 permission request 规范还没完全抽象成插件通用 contract；会话生命周期持久化仍由宿主管理，后续若继续下切，应优先定义插件级 permission schema 与 session lifecycle hook。
  - 这一步到底做什么：把 assistant 从“provider 列表插件化”推进到“真实运行时入口由插件提供”。
  - 做完你能看到什么：主 APP 不再写死 codex / claude-code runtime 初始化，至少一条 assistant 会话已经通过插件 backend entry 执行。
  - 先依赖什么：3.3
  - 开始前先看：
    - `requirements.md` 需求 6、需求 7
    - `design.md` §2.3.5「assistant / CLI 插件接入」
  - 主要改哪里：
    - `packages/shared/src/assistant-plugin-types.ts`
    - `apps/server/src/plugins/`
    - `apps/server/src/assistant/assistant-runtime-service.ts`
    - `plugins/codex-integration/`
    - `plugins/claude-code-integration/`
  - 怎么算完成：
    1. 插件 backend entry 可动态装载
    2. provider runtime adapter 由插件返回
    3. 至少一条 assistant session 通过插件 runtime 跑通
  - 怎么验证：
    - `pnpm --filter @x-file/server test`
    - `pnpm typecheck`

- [x] 3.6 增加 runtime.install manifest contract 与隔离 npm runtime 安装骨架
  - 状态：DONE
  - 本次完成结果：已扩展 `packages/shared/src/plugin-types.ts`，为 Integration Plugin 增加 `runtime.install` 字段，支持 `system-cli` 与 `npm-runtime` 两种策略；主 APP 新增 `apps/server/src/plugins/plugin-runtime-installer.ts`，负责把 npm-runtime 插件安装到 `~/.x-file/plugin-runtimes/<pluginId>/<version>` 隔离目录，再从该目录加载 backend entry。当前已进一步加上 lockfile 前置校验、默认 `npm ci --omit=dev --ignore-scripts`、失败清理和 `runtimeInstallDir` registry 回写。`loadAssistantPluginRuntimeModule()` 已接入该安装器，但现有 `codex / claude-code` 示例插件未声明 `runtime.install=npm-runtime`，因此它们仍按原来的 system-cli + 原目录 backend entry 路径工作，调用逻辑未变。
  - 验证结果：新增 `plugin-runtime-installer.test.ts` 覆盖 `system-cli` 不触发热安装；新增 `plugin-backend-loader.test.ts` 覆盖 `npm-runtime` 插件会在隔离 runtime 目录产出安装结果并从该目录加载 backend entry。
  - 约束保持：这一步只补“宿主通用热安装与加载框架”，没有把 provider-specific runtime 收回宿主，也没有改动现有 `codex / claude-code` backend entry 的构造和调用路径。
  - 剩余缺口：当前 `npm-runtime` 只提供 installer skeleton，尚未接 hash/lockfile 强校验、离线缓存、安装失败回滚清理、npm 可执行路径探测与前端状态展示；这些都应继续作为宿主通用框架补齐，而不是侵入 provider 代码。
  - 这一步到底做什么：为未来依赖 Node 包的插件预埋“隔离热安装 + backend entry 加载”能力，同时保证现有 system-cli 插件完全不受影响。
  - 先依赖什么：3.5
  - 主要改哪里：
    - `packages/shared/src/plugin-types.ts`
    - `apps/server/src/plugins/`
    - `apps/server/src/storage/plugin-registry-store.ts`
  - 怎么算完成：
    1. manifest 能声明 runtime.install
    2. 宿主能把 npm-runtime 装进隔离目录
    3. system-cli 插件仍走原逻辑
  - 怎么验证：
    - `pnpm --filter @x-file/server test`
    - `pnpm typecheck`

- [x] 3.7 在设置页展示插件 runtime.install 策略与宿主安装结果
  - 状态：DONE
  - 本次完成结果：设置页集成卡片已直接展示插件运行时策略和宿主安装结果。`system-cli` 插件明确显示“系统 CLI，由宿主管理”；`npm-runtime` 插件显示“宿主热安装 runtime”以及 `registry.runtimeInstallDir` 隔离目录。这样前端不再只是“看起来有插件”，而是能看到宿主和插件之间真实的运行时边界与装配结果。
  - 验证结果：`SettingsPage.test.tsx` 已新增覆盖，验证 `system-cli` 展示宿主管理说明，`npm-runtime` 展示隔离 runtime 目录。
  - 约束保持：没有改动 `codex / claude-code` 的 provider 调用逻辑，也没有把 provider-specific runtime 收回宿主。
  - 剩余缺口：前端目前只展示宿主已记录的 runtime 结果，还没有暴露“重新安装 runtime / 查看安装日志 / 查看 lockfile 校验结果”等操作面；这些属于下一轮宿主通用框架增强，不应污染 provider 代码。
  - 这一步到底做什么：把 runtime.install contract 从后端状态延伸到用户可见层，证明宿主只负责安装与装配，而不是重新拥有 provider runtime。
  - 先依赖什么：3.6
  - 主要改哪里：
    - `apps/web/src/features/settings/SettingsPage.tsx`
    - `apps/web/src/i18n.ts`
    - `apps/web/src/features/settings/__tests__/SettingsPage.test.tsx`
  - 怎么算完成：
    1. 插件卡片能区分 `system-cli` 和 `npm-runtime`
    2. `npm-runtime` 能显示隔离安装目录
    3. `system-cli` 继续明确归属宿主通用框架而非 provider 逻辑
  - 怎么验证：
    - `pnpm --filter @x-file/web test -- --run SettingsPage.test.tsx`
    - `pnpm typecheck`

- [x] 3.8 抽离插件通用权限请求 contract，去掉宿主里的 provider-specific 审批解析
  - 状态：DONE
  - 本次完成结果：`packages/shared/src/assistant-plugin-types.ts` 已新增插件通用权限请求 contract，插件现在向宿主提交标准化的 `kind/title/summary/detail` 请求，并可通过 `buildPermissionResponse()` 自己构造 provider-specific 审批结果。宿主 `AssistantRuntimeService` 不再解析 `codex` 私有请求结构，也不再硬编码 `buildCodexApprovalResult()`；它现在只负责权限请求持久化、SSE 推送、超时默认处理和用户回复转发。
  - 验证结果：新增 `assistant-runtime-plugin-chain.test.ts` 覆盖最小权限链路，证明插件可提交标准化 `command` 权限请求，宿主记录并推送给前端，前端回复 `decline` 后由插件自己的 response builder 收到 `{ decision: "decline" }`。
  - 约束保持：没有修改 `codex / claude-code` 的既有 provider runtime 调用路径，也没有把 provider-specific 审批协议重新收回宿主；只是把这层协议解释责任移回插件 backend entry。
  - 剩余缺口：当前权限请求 contract 仍只覆盖基础字段，没有为更复杂的差异预览、批量文件授权、细粒度 command metadata 定义结构化 schema；下一步应先扩展这个 contract，而不是让宿主再去理解各家 provider 原始 payload。
  - 这一步到底做什么：把 assistant 运行时边界继续往插件侧推进，让宿主只做桥，不做 provider-specific 协议翻译器。
  - 先依赖什么：3.5
  - 主要改哪里：
    - `packages/shared/src/assistant-plugin-types.ts`
    - `apps/server/src/assistant/assistant-runtime-service.ts`
    - `plugins/codex-integration/backend/index.js`
    - `apps/server/src/routes/assistant-runtime-plugin-chain.test.ts`
  - 怎么算完成：
    1. 宿主不再解析 provider-specific 权限请求
    2. 插件可提交标准化权限请求
    3. 插件可自行构造审批响应
  - 怎么验证：
    - `pnpm --filter @x-file/server test`
    - `pnpm typecheck`

- [x] 3.9 把 assistant 权限请求 DTO 结构化到前端展示层
  - 状态：DONE
  - 本次完成结果：共享 `AssistantPermissionRequest` 已新增结构化 `metadata`，覆盖 `command / file_change / other` 三类权限请求；宿主在接收插件标准化权限请求时会把 `payload` 映射成结构化 DTO，前端 `AssistantPermissionList` 现在直接展示命令、工作目录、目标路径和方法，不再只依赖 `detail` 字符串猜 provider 语义。
  - 验证结果：新增 `AssistantPermissionList.test.tsx` 覆盖命令和文件改动两类权限卡片展示；`assistant-runtime-plugin-chain.test.ts` 同步断言宿主已为权限请求填充结构化 `metadata`。
  - 约束保持：没有改动 `codex / claude-code` provider runtime 调用路径；只是把结构化语义继续前推到共享 DTO 和前端显示层。
  - 剩余缺口：当前 `other` 类型仍只保留 `method/payloadText` 级别摘要，没有更细粒度的 schema；后续若要支持 diff 预览、批量路径列表、命令参数高亮，应继续扩展 `metadata`，不要再回退成字符串拼接。
  - 这一步到底做什么：把宿主和前端从“字符串化权限提示”推进到“结构化权限 DTO”，让插件 runtime 边界真正可见且可消费。
  - 先依赖什么：3.8
  - 主要改哪里：
    - `packages/shared/src/assistant-types.ts`
    - `apps/server/src/assistant/assistant-runtime-service.ts`
    - `plugins/codex-integration/backend/index.js`
    - `apps/web/src/features/assistant/components/AssistantPermissionList.tsx`
  - 怎么算完成：
    1. 权限请求有结构化 metadata
    2. 前端直接渲染结构化字段
    3. 宿主不需要再靠 detail 字符串拼展示语义
  - 怎么验证：
    - `pnpm --filter @x-file/server test`
    - `pnpm --filter @x-file/web test -- --run AssistantPermissionList.test.tsx`
    - `pnpm typecheck`

- [x] 3.10 扩展 file_change 权限 metadata 为路径列表、操作类型与可选 diff 摘要
  - 状态：DONE
  - 本次完成结果：共享 `AssistantPermissionFileChangeMetadata` 已从单个 `targetPath` 升级为真实可用结构：`primaryPath + changes[] + diffSummary`。`codex` 插件 backend 现在会把 `item/fileChange/requestApproval` 的 `changes[]` 原始数据映射进插件权限 payload；宿主会把这些字段收敛成统一 DTO；前端权限卡片则直接展示主路径、变更列表和可选 diff 摘要，不再依赖 provider 文本描述来猜有哪些文件被改动。
  - 验证结果：`AssistantPermissionList.test.tsx` 已覆盖文件改动权限卡片展示；`pnpm typecheck` 已通过。
  - 约束保持：没有把 file change 语义重新搬回宿主硬编码判断 provider 类型；宿主只做统一 DTO 映射，原始 `changes` 解释仍归插件 backend entry。
  - 剩余缺口：当前 `diffSummary` 仍是可选文本摘要，真实 provider 若不给 diff，就只能展示文件级摘要；这符合 `session-sync-core` 当前实际上游数据形状。后续若 provider 能给统一 diff 块，再继续升级 contract，不要先做虚假字段。
  - 这一步到底做什么：把 assistant 插件权限 contract 在最难泛化的 `file_change` 场景里补成真实结构，进一步证明插件负责 provider 语义，宿主只做桥接。
  - 先依赖什么：3.9
  - 主要改哪里：
    - `packages/shared/src/assistant-types.ts`
    - `plugins/codex-integration/backend/index.js`
    - `apps/server/src/assistant/assistant-runtime-service.ts`
    - `apps/web/src/features/assistant/components/AssistantPermissionList.tsx`
  - 怎么算完成：
    1. `file_change` 有路径列表与操作类型
    2. 可选 diff 摘要能透传到前端
    3. 前端不再只依赖 summary/detail 猜测文件改动范围
  - 怎么验证：
    - `pnpm --filter @x-file/web test -- --run AssistantPermissionList.test.tsx`
    - `pnpm typecheck`

- [x] 3.11 类型化插件权限请求 payload，收紧插件到宿主的运行时 contract
  - 状态：DONE
  - 本次完成结果：`packages/shared/src/assistant-plugin-types.ts` 里的 `AssistantPluginPermissionRequest.payload` 已不再是宽泛的 `Record<string, unknown>`，而是按 `command / file_change / other` 分支的联合类型。宿主 `AssistantRuntimeService` 现在基于 `input.kind` 对 payload 做编译期缩窄，不再在权限桥层依赖无类型对象猜字段。这让“插件解释 provider 语义、宿主只做桥接”第一次在类型系统里被真正钉死。
  - 验证结果：`pnpm typecheck` 已通过，说明插件 contract、宿主映射和前端消费都已与新联合类型对齐。
  - 约束保持：没有改动 `codex / claude-code` 的运行路径；只是把插件到宿主的权限请求协议从“约定俗成”升级成“编译期可校验”的正式 contract。
  - 剩余缺口：当前只有 `codex` 明确消费了这套类型化 payload；后续若 `claude-code` 也出现 server-side permission hook，需要直接按这套联合类型接入，不允许再回退成原始字典对象。
  - 这一步到底做什么：把 assistant 插件运行时的权限桥再收紧一层，避免宿主以后重新长出 provider-specific 的动态字段判断。
  - 先依赖什么：3.10
  - 主要改哪里：
    - `packages/shared/src/assistant-plugin-types.ts`
    - `apps/server/src/assistant/assistant-runtime-service.ts`
  - 怎么算完成：
    1. 插件权限 payload 不再是任意对象
    2. 宿主按 kind 做编译期缩窄
    3. 插件到宿主的权限协议可被 typecheck 约束
  - 怎么验证：
    - `pnpm typecheck`

- [x] 3.12 文档化当前插件系统能力边界，形成后续演进基线
  - 状态：DONE
  - 本次完成结果：已新增 `docs/20260616-X-File当前插件系统能力边界说明.md`，明确记录当前单层 Integration Plugin 系统已经具备的真实能力、宿主与插件职责边界、已验证链路、当前未做范围，以及后续扩展硬规则。这份文档不是愿景清单，而是当前代码与测试状态的基线快照，后续继续切 assistant runtime 时必须以它为边界约束。后续又补充了“内置插件自动注册”基线：`codex / claude-code` 这类插件允许随程序包进入 `resources/x-file-plugins`，backend 启动时会自动扫描并默认启用，用户不需要先手工安装插件目录；只有 provider runtime 依赖仍按 `runtime.install` 进入隔离 runtime。设置页集成页也已同步移除“插件源目录 / 安装插件”表单，改为直接展示内置插件列表，避免 UI 继续误导成手工安装模型。
  - 验证结果：已人工走查文档中的实现引用与当前代码位置一致；文档名、日期前缀和中文规范符合仓库要求。
  - 约束保持：这一步不新增功能，也不改变现有运行时路径；只把当前已落地边界正式固化，避免后续演进时边做边漂移。
  - 剩余缺口：文档现在主要覆盖服务端插件系统和 assistant 权限桥；如果后续前端插件管理入口、远程源、插件授权面板继续演进，需要在同一文档里持续维护，而不是再散落出第二份“插件能力说明”。
  - 这一步到底做什么：把当前插件系统从“实现里看得出来”提升到“团队成员能直接读到并据此继续开发”的正式基线。
  - 先依赖什么：3.11
  - 主要改哪里：
    - `docs/20260616-X-File当前插件系统能力边界说明.md`
    - `specs/spec002-X-File内置文档引擎与集成插件化/tasks.md`
  - 怎么算完成：
    1. 当前插件能力边界有单独正式文档
    2. 宿主职责和插件职责被明确写清
    3. 后续扩展规则被写成硬约束而不是口头约定
  - 怎么验证：
    - 人工走查文档与实现引用
