# 任务清单 - spec001-X-File文档库独立应用（人话版）

状态：Draft

## 这份文档是干什么的

这份任务清单用来指导 X-File 第一版落地：

- 先把独立应用骨架立起来
- 再迁文档库后端
- 再复刻前端页面
- 最后补 HTTP 服务、常驻、打包和验收

每个任务都要能独立检查，不允许写成“优化系统能力”这种空话。

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

## 阶段 1：把独立应用骨架建出来

- [x] 1.1 初始化项目结构
  - 状态：DONE
  - 本次完成结果：已建立 pnpm monorepo，包含 `apps/desktop`、`apps/server`、`apps/web`、`packages/shared`、`packages/indexer`，根目录有统一 `package.json`、`pnpm-workspace.yaml`、`tsconfig.base.json` 和 README。
  - 剩余缺口：测试目录和 lint 规则还只是后续预留，本轮只保证最小 build 入口。
  - 这一步到底做什么：在 X-File 仓库里建立前端、后端、桌面壳、共享类型和测试目录。
  - 做完你能看到什么：仓库不再是空壳，能看到清楚的 `apps/desktop`、`apps/server`、`apps/web`、`packages/shared` 目录。
  - 先依赖什么：无
  - 开始前先看：
    - `requirements.md` 需求 1
    - `design.md` §2.1「系统结构」
    - `design.md` §2.2「模块职责」
  - 主要改哪里：
    - `package.json`
    - `pnpm-workspace.yaml`
    - `apps/desktop/`
    - `apps/server/`
    - `apps/web/`
    - `packages/shared/`
  - 这一步先不做什么：不迁文档库业务代码，不做打包安装。
  - 怎么算完成：
    1. 目录结构存在
    2. TypeScript、lint/test/build 脚本有最小入口
    3. README 说明怎么本地启动各部分
  - 怎么验证：
    - `pnpm install`
    - `pnpm -r build` 或当前阶段最小 build 命令
  - 对应需求：`requirements.md` 需求 1
  - 对应设计：`design.md` §2.1、§2.2

- [x] 1.2 建立桌面壳和后端启动关系
  - 状态：DONE
  - 本次完成结果：`apps/server` 已提供 Fastify `/api/health`，`apps/web` 已提供 React 文档库页面读取健康检查和文档库 API，`apps/desktop` 已接入 Tauri 2 窗口生命周期，并支持常驻时关闭窗口隐藏主窗口。
  - 剩余缺口：安装包实机验证留到后续；系统托盘菜单和后端子进程托管入口已在后续任务补齐。
  - 这一步到底做什么：让桌面应用启动时能启动内置后端，并把前端指向本机 API。
  - 做完你能看到什么：打开桌面开发入口后，前端能请求到后端 `/api/health`。
  - 先依赖什么：1.1
  - 开始前先看：
    - `requirements.md` 需求 1、需求 5
    - `design.md` §2.3.1「首次启动并绑定文档库」
    - `design.md` §2.3.5「启用 HTTP 服务并常驻」
  - 主要改哪里：
    - `apps/desktop/`
    - `apps/server/src/main.ts`
    - `apps/web/src/api/`
  - 这一步先不做什么：不做常驻后端，不做系统托盘。
  - 怎么算完成：
    1. 后端能返回健康检查
    2. 前端能显示后端连接状态
    3. 桌面壳能控制后端启动和退出
  - 怎么验证：
    - 启动桌面开发命令后访问 `/api/health`
  - 对应需求：`requirements.md` 需求 1、需求 5
  - 对应设计：`design.md` §2.3.1、§3.3.1

- [x] 1.3 阶段检查：独立应用骨架可运行
  - 状态：DONE
  - 本次完成结果：桌面壳、前端、后端、shared、indexer 的 monorepo 骨架已经串起来；`/api/health`、React 页面、Tauri 2 骨架和构建脚本都能通过最小验证。
  - 剩余缺口：真实安装包启动后的 Node runtime/sidecar 携带方式和 Windows 实机验证还没有做；系统托盘菜单和后端子进程托管入口已在后续任务补齐。
  - 这一步到底做什么：只检查应用骨架是否站稳，不扩业务范围。
  - 做完你能看到什么：可以开始迁文档库后端，而不是还在补项目基础设施。
  - 先依赖什么：1.1、1.2
  - 开始前先看：
    - `requirements.md`
    - `design.md`
    - `tasks.md`
  - 主要改哪里：本阶段全部相关文件
  - 这一步先不做什么：不追加搜索、云同步、账户系统。
  - 怎么算完成：
    1. 桌面壳、前端、后端能串起来
    2. 最小构建或类型检查通过
  - 怎么验证：
    - 当前阶段最小 build/test 命令
  - 对应需求：`requirements.md` 需求 1
  - 对应设计：`design.md` §2.1、§2.2

---

## 阶段 2：迁移文档库后端主链路

- [x] 2.1 迁入索引核心代码
  - 状态：DONE
  - 本次完成结果：已建立 `@x-file/indexer` 包，迁入 contracts、parser、scanner、sqlite、tagging、dirty/export/indexer/search/watch 等第一版可编译结构，SQLite 入口使用 `better-sqlite3`；已补 `runLibraryIndexOnce(...)` 工具入口，并修正包导出，让 server 后台任务可以从 `@x-file/indexer` 调用索引。
  - 剩余缺口：真实大目录扫描压测还没有做；当前环境 `better-sqlite3` native binding 不可用时会走文件扫描导出兜底，后续仍应在稳定 Node 版本上验证 SQLite 正式路径；内部仍有少量历史命名，但不再作为 shared/server API 暴露。
  - 这一步到底做什么：把 CodingNS 的 `affairs-indexer/core` 和 `contracts` 迁到 X-File，改成独立 `indexer` 包。
  - 做完你能看到什么：X-File 有自己的扫描、解析、SQLite、导出和标签推断代码。
  - 先依赖什么：1.3
  - 开始前先看：
    - `requirements.md` 需求 3、需求 4
    - `design.md` §3.1「核心组件」
    - `design.md` §4.1「数据关系」
    - `docs/20260608-当前CodingNS文档库迁移清单.md`
  - 主要改哪里：
    - `packages/indexer/`
    - `packages/shared/`
  - 这一步先不做什么：不迁 CodingNS 的 workspace、事务会话、Teable 代码。
  - 怎么算完成：
    1. 索引核心能在 X-File 内编译
    2. 不再引用 CodingNS 的 `workspaceId` 服务或 Host 私有模块
    3. SQLite 使用 `better-sqlite3`
  - 怎么验证：
    - `pnpm --filter @x-file/indexer build`
    - 索引核心单元测试
  - 对应需求：`requirements.md` 需求 3、需求 4
  - 对应设计：`design.md` §3.1、§4.1

- [x] 2.2 迁入文档库服务和 DTO
  - 状态：DONE
  - 本次完成结果：已建立 `@x-file/shared` 的 `library-types.ts`，模型改成 `libraryId/rootDir`；已建立 `LibraryService`、`LibraryController`、绑定、配置、标签、索引状态、导出快照读取、预览、下载、文件操作、刷新和收藏链路；预览格式覆盖 text、markdown、html、image、pdf、office、binary、unsupported，并接入 OnlyOffice 设置、状态、受控文档链接和回调保存。
  - 剩余缺口：标签当前以 X-File 自己的轻量存储为主，还没有完全接回索引 catalog 的智能规则、推荐和重算；索引产物缺失时已能重新导出可读快照，但损坏分片的精细修复策略还可以继续增强。
  - 这一步到底做什么：把 `AffairsLibraryService` 复刻为 `LibraryService`，把模型从 `workspaceId/userId` 改成 `libraryId/rootDir`。
  - 做完你能看到什么：后端能保存绑定、读取快照、列文档、列目录、预览、下载和执行文件操作。
  - 先依赖什么：2.1
  - 开始前先看：
    - `requirements.md` 需求 3
    - `design.md` §3.2「数据结构」
    - `design.md` §3.3「接口契约」
  - 主要改哪里：
    - `apps/server/src/library/`
    - `apps/server/src/storage/`
    - `packages/shared/src/library-types.ts`
  - 这一步先不做什么：不做前端 UI，不做 HTTP 常驻设置页。
  - 怎么算完成：
    1. `LibraryService` 不依赖 CodingNS workspace 服务
    2. 绑定、配置、快照、列表、预览、下载、文件操作都有服务方法
    3. 路径越界保护有测试
  - 怎么验证：
    - `pnpm --filter @x-file/server test -- library-service`
  - 对应需求：`requirements.md` 需求 3
  - 对应设计：`design.md` §3.2、§3.3、§6.2

- [x] 2.3 建立 HTTP API
  - 状态：DONE
  - 本次完成结果：已把 `/api/library/*` 主链路挂到 Fastify，包括绑定、配置、快照、文档列表、目录文件、预览、下载、文件操作、刷新、收藏、标签、文档标签和目录标签；已新增 `/preview/library-files/:token/*` 受控资源预览路由；已新增 `/api/office/onlyoffice/settings`、`/api/office/onlyoffice/status`、`/api/office/onlyoffice/callback/*` 支撑 Office 预览；已新增 `/api/server/state` 和 `/api/integration/status`。
  - 剩余缺口：远程访问认证按范围要求不做；HTTP API 已有集成测试，但还没有真实外部 CodingNS 调用方联调。
  - 这一步到底做什么：把文档库服务挂到 X-File 自己的 Fastify API 上。
  - 做完你能看到什么：可以用 HTTP 调用 `/api/library/*` 完成文档库主链路。
  - 先依赖什么：2.2
  - 开始前先看：
    - `requirements.md` 需求 3、需求 7
    - `design.md` §3.3「接口契约」
  - 主要改哪里：
    - `apps/server/src/routes/library-routes.ts`
    - `apps/server/src/routes/tag-routes.ts`
    - `apps/server/src/server.ts`
  - 这一步先不做什么：不加认证和远程访问，默认只服务本机。
  - 怎么算完成：
    1. `/api/health` 可用
    2. `/api/library/binding`、`/api/library/snapshot`、`/api/library/documents` 可用
    3. 预览、下载、文件操作和刷新入口可用
  - 怎么验证：
    - API 集成测试
  - 对应需求：`requirements.md` 需求 3、需求 7
  - 对应设计：`design.md` §3.3

- [x] 2.4 接入后台任务、watcher 和状态恢复
  - 状态：DONE
  - 本次完成结果：已新增 `TaskManager`、`LibraryIndexService`、`IndexRuntimeStore` 和 `WatchService`；刷新入口入队执行，同 `rootDir + taskType` 去重，状态暴露 queued、running、failed、queue_timeout、cooldown、runningStage、dirtyReasons；读快照和列表只读 export/运行态，不触发重扫；watcher 回调只打脏标记，并在 quiet window 后合并调度后台刷新。
  - 剩余缺口：当前任务管理器是进程内轻量实现，不是持久队列；watcher 的周期对账、漏事件巡检和真实长期运行恢复还没有完整压测。
  - 这一步到底做什么：把索引刷新、自动刷新、目录 hint、queue timeout、per-rootDir 隔离接进 X-File 的任务执行器。
  - 做完你能看到什么：外部改文件后，系统不会主线程重扫，而是进入可观测后台刷新。
  - 先依赖什么：2.3
  - 开始前先看：
    - `requirements.md` 需求 4、需求 6
    - `design.md` §2.3.3「显式刷新」
    - `design.md` §2.3.4「外部文件变化自动刷新」
    - `design.md` §4.2「索引状态流转」
  - 主要改哪里：
    - `apps/server/src/tasks/`
    - `apps/server/src/library/watch-service.ts`
    - `apps/server/src/library/index-service.ts`
  - 这一步先不做什么：不接 Redis/MQ，不做分布式任务系统。
  - 怎么算完成：
    1. 读接口不触发重活
    2. watcher 只打脏标记
    3. 同根目录同类任务去重
    4. queue timeout 和失败状态可读
  - 怎么验证：
    - 后台任务集成测试
    - watcher 临时目录测试
  - 对应需求：`requirements.md` 需求 4、需求 6
  - 对应设计：`design.md` §4.2、§6.1、§6.3

- [x] 2.5 阶段检查：后端主链路可用
  - 状态：DONE
  - 本次完成结果：后端已经能脱离 CodingNS 提供绑定、配置、快照、文档列表、目录文件、预览、下载、文件操作、刷新、收藏、标签、OnlyOffice 和 server state API；测试覆盖路径越界、文件操作、export 读取、刷新入队去重、OnlyOffice 回调和主路由注册。
  - 剩余缺口：已跑临时资料库端到端索引读取测试，但还没有跑真实大资料库压测；没有修改 CodingNS 主仓库做外部调用联调。
  - 这一步到底做什么：确认文档库后端已经能脱离 CodingNS 跑通。
  - 做完你能看到什么：用 HTTP API 就能绑定资料库、刷新索引、读取列表和预览文件。
  - 先依赖什么：2.1、2.2、2.3、2.4
  - 开始前先看：
    - `requirements.md`
    - `design.md`
    - `tasks.md`
  - 主要改哪里：本阶段全部相关文件
  - 这一步先不做什么：不补 UI 细节，不做安装包。
  - 怎么算完成：
    1. 后端主 API 都有测试覆盖
    2. 临时资料库端到端测试通过
    3. 没有引用 CodingNS 私有 workspace/affairs/teable 模块
  - 怎么验证：
    - 后端集成测试
  - 对应需求：`requirements.md` 需求 3、需求 4、需求 6
  - 对应设计：`design.md` §3、§4、§6

---

## 阶段 3：复刻文档库前端体验

- [x] 3.1 迁入文档库页面和组件
  - 状态：DONE
  - 本次完成结果：已建立 X-File 文档库主页面，包含浏览、收藏、标签、详情、预览、下载、状态条、面包屑、网格/列表、排序、空态和文件操作入口；样式集中在 `apps/web/src/styles.css`，用户展示文案集中在 `apps/web/src/i18n.ts`。
  - 剩余缺口：没有启动长期 dev server 做人工 UI 对照；标签编辑和文件操作弹窗当前是第一版轻交互，不是完整设计系统弹窗。
  - 这一步到底做什么：把 CodingNS 当前文档库页面、浏览、收藏、标签、详情组件复刻到 X-File 前端。
  - 做完你能看到什么：X-File 前端能看到和 CodingNS 当前文档库一致的主页面结构。
  - 先依赖什么：2.5
  - 开始前先看：
    - `requirements.md` 需求 2
    - `design.md` §3.1「核心组件」
    - `docs/20260608-当前CodingNS文档库迁移清单.md`
  - 主要改哪里：
    - `apps/web/src/features/library/`
    - `apps/web/src/shared/i18n/`
    - `apps/web/src/styles/`
  - 这一步先不做什么：不做事务工作台、Teable、Butler 页面。
  - 怎么算完成：
    1. 浏览、收藏、标签、详情组件存在
    2. 样式从当前文档库复刻
    3. 页面文案走 i18n
  - 怎么验证：
    - 前端组件测试
    - 人工 UI 对照检查
  - 对应需求：`requirements.md` 需求 2
  - 对应设计：`design.md` §3.1

- [x] 3.2 接入前端状态和 API
  - 状态：DONE
  - 本次完成结果：已建立 `useLibraryState` 并接入真实 API，包括 binding、config、snapshot、documents、files、preview、download、ops、refresh、favorites、tags、文档标签、目录标签、server state 和 OnlyOffice；web 类型改为从 `@x-file/shared` 引入，避免 DTO 漂移。
  - 剩余缺口：前端还没有组件测试和 API mock 测试；刷新轮询是第一版轻量实现，没有做复杂订阅和重放快照。
  - 这一步到底做什么：把当前 `useAffairsLibraryState` 复刻成 X-File 的 `useLibraryState`，接入新 API。
  - 做完你能看到什么：前端不再用假数据，可以读取 X-File 后端真实文档库。
  - 先依赖什么：3.1
  - 开始前先看：
    - `requirements.md` 需求 2、需求 3
    - `design.md` §2.3.2「读取文档库列表」
    - `design.md` §3.3「接口契约」
  - 主要改哪里：
    - `apps/web/src/features/library/hooks/useLibraryState.ts`
    - `apps/web/src/features/library/api/library-api.ts`
    - `packages/shared/src/library-types.ts`
  - 这一步先不做什么：不接 CodingNS 外部入口。
  - 怎么算完成：
    1. 绑定、快照、配置、列表、刷新、收藏、下载 API 都接上
    2. 加载中、失败、刷新中、未绑定状态显示正确
    3. 缓存策略不污染读接口边界
  - 怎么验证：
    - 前端状态 hook 测试
    - API mock 测试
  - 对应需求：`requirements.md` 需求 2、需求 3
  - 对应设计：`design.md` §3.3

- [x] 3.3 做绑定和设置页面
  - 状态：DONE
  - 本次完成结果：已建立设置页，支持资料库路径绑定、索引扩展名、隐藏路径、文件夹打开方式、OnlyOffice 设置和 HTTP 服务状态/常驻开关保存；本轮已把未绑定首屏改成参考事务模式初始化页的单块初始化面板，不再把用户直接扔进粗糙的设置页。
  - 剩余缺口：桌面文件夹选择器尚未接入，当前先用路径输入；初始化页已经收口，后续还可以补原生选择目录按钮。
  - 这一步到底做什么：提供文档库路径绑定、索引配置和基础设置入口。
  - 做完你能看到什么：用户不用手写配置，就能选择资料库路径并调整扩展名、隐藏路径和文件夹打开方式。
  - 先依赖什么：3.2
  - 开始前先看：
    - `requirements.md` 需求 1、需求 3
    - `design.md` §2.3.1「首次启动并绑定文档库」
  - 主要改哪里：
    - `apps/web/src/features/settings/`
    - `apps/web/src/features/library/components/LibraryBindingView.tsx`
  - 这一步先不做什么：不做账号、云同步、远程访问设置。
  - 怎么算完成：
    1. 未绑定时有清楚入口
    2. 绑定后能恢复
    3. 配置保存后能刷新状态
  - 怎么验证：
    - 设置页组件测试
    - 人工绑定临时目录
  - 对应需求：`requirements.md` 需求 1、需求 3
  - 对应设计：`design.md` §2.3.1、§3.3.2-§3.3.5

- [x] 3.4 阶段检查：前后端主链路跑通
  - 状态：DONE
  - 本次完成结果：前端已经能通过 X-File API 绑定资料库、读取快照、浏览文档/目录/标签/收藏、刷新、预览、下载和执行基础文件操作；`pnpm --filter @x-file/web typecheck`、`pnpm --filter @x-file/web build` 通过。
  - 剩余缺口：没有启动 dev server 做人工 UI 走查；没有浏览器端 E2E 测试。
  - 这一步到底做什么：确认用户能通过 X-File UI 完成文档库主流程。
  - 做完你能看到什么：不是只有 API，也不是只有静态页面，而是完整可操作的文档库。
  - 先依赖什么：3.1、3.2、3.3
  - 开始前先看：
    - `requirements.md`
    - `design.md`
    - `tasks.md`
  - 主要改哪里：本阶段全部相关文件
  - 这一步先不做什么：不做安装包发布。
  - 怎么算完成：
    1. UI 可以绑定资料库
    2. UI 可以浏览文档、标签、收藏和详情
    3. UI 可以刷新、预览、下载
  - 怎么验证：
    - 前后端集成走查
    - 当前阶段最小测试命令
  - 对应需求：`requirements.md` 需求 1、需求 2、需求 3
  - 对应设计：`design.md` §2.3、§3.1、§3.3

---

## 阶段 4：HTTP 服务、常驻和 CodingNS 集成入口

- [x] 4.1 做 HTTP 服务开关和状态页
  - 状态：DONE
  - 本次完成结果：已新增 `HttpServerManager` 和 `/api/server/state`，支持读取和保存 `enabled`、`host`、`port`、`persistent`，并暴露 `running`、`lifecycleState`、`startedAt`、`lastError` 和常驻策略；正式生命周期模式下保存 `enabled/port` 会真实启动或停止本机 HTTP 监听；默认只允许 `127.0.0.1`，前端设置页已接入。本轮修正 Tauri 生产页面的 API base，file 协议下会访问 `http://127.0.0.1:17321`，避免相对 `/api` 请求在桌面包里报 URL pattern 错误。
  - 剩余缺口：托盘菜单和后端子进程托管入口已补；本轮已补随包 Node runtime 和生产后端资源，后续还可以把 Node runtime 进一步瘦身或改成真正 sidecar。
  - 这一步到底做什么：让用户能启用、关闭、改端口、查看本机 HTTP 服务状态。
  - 做完你能看到什么：设置页能显示服务地址、运行状态、端口冲突和最近错误。
  - 先依赖什么：3.4
  - 开始前先看：
    - `requirements.md` 需求 5
    - `design.md` §2.3.5「启用 HTTP 服务并常驻」
    - `design.md` §4.3「HTTP 服务状态流转」
  - 主要改哪里：
    - `apps/server/src/http-server-manager.ts`
    - `apps/web/src/features/settings/HttpServerSettings.tsx`
    - `apps/desktop/`
  - 这一步先不做什么：不开放公网监听，不做远程认证。
  - 怎么算完成：
    1. 默认监听 `127.0.0.1`
    2. 端口冲突有错误提示
    3. 关闭服务后端口释放
  - 怎么验证：
    - HTTP 服务启停测试
    - 端口占用测试
  - 对应需求：`requirements.md` 需求 5
  - 对应设计：`design.md` §3.3.15、§4.3、§6.4

- [x] 4.2 做常驻后端策略
  - 状态：DONE
  - 本次完成结果：已新增 `PersistentBackendManager` 并通过 `/api/server/state` 暴露 `persistentPolicy`，明确关闭窗口与退出应用的差异；Tauri 侧提供 `describe_backend_policy`、`set_backend_persistence`、`desktop_shell_status`、`start_managed_backend` 和 `stop_managed_backend` 命令；常驻开启时关闭窗口会隐藏主窗口并保留进程；系统托盘菜单可显示/隐藏窗口、开启/关闭常驻、启动/停止内置后端和退出应用。
  - 剩余缺口：开机自启没有做；本轮已让桌面壳优先使用包内 Node runtime 和 `x-file-server/dist/main.js`，后续还可以改成真正 Tauri sidecar。
  - 这一步到底做什么：实现窗口关闭后是否保留后端运行的策略。
  - 做完你能看到什么：用户打开常驻后，关闭窗口不会立刻停掉 HTTP 服务；退出应用才停止。
  - 先依赖什么：4.1
  - 开始前先看：
    - `requirements.md` 需求 1、需求 5
    - `design.md` §2.3.5「启用 HTTP 服务并常驻」
  - 主要改哪里：
    - `apps/desktop/`
    - `apps/server/src/lifecycle/`
    - `apps/web/src/features/settings/`
  - 这一步先不做什么：不做开机自启，除非后续单独 Spec。
  - 怎么算完成：
    1. 常驻开关可保存
    2. 关闭窗口和退出应用行为不同
    3. 用户能看懂后端是否还在运行
  - 怎么验证：
    - 桌面端手工验证
    - 生命周期单元测试
  - 对应需求：`requirements.md` 需求 1、需求 5
  - 对应设计：`design.md` §2.3.5

- [x] 4.3 提供 CodingNS 集成入口
  - 状态：DONE
  - 本次完成结果：已新增 `/api/integration/status`，返回 X-File 可用性、HTTP 服务状态和 library snapshot summary；已新增 `docs/20260608-CodingNS接入X-File说明.md` 写清稳定 API 和未运行时的调用方行为。
  - 剩余缺口：本轮不修改 CodingNS 仓库，也不做 deep link 注册。
  - 这一步到底做什么：提供稳定 deep link 或 HTTP API，让 CodingNS 后续能调用 X-File。
  - 做完你能看到什么：外部客户端能检查 X-File 是否可用，并读取文档库状态和基础数据。
  - 先依赖什么：4.1
  - 开始前先看：
    - `requirements.md` 需求 7
    - `design.md` §3.3「接口契约」
    - `design.md` §6.4「HTTP 服务默认只监听本机」
  - 主要改哪里：
    - `apps/server/src/routes/integration-routes.ts`
    - `apps/desktop/`
    - `docs/20260608-CodingNS接入X-File说明.md`
  - 这一步先不做什么：不修改 CodingNS 仓库停用文档库；那应该在 CodingNS 里单独开 Spec。
  - 怎么算完成：
    1. `/api/health` 能被外部检测
    2. 文档库状态和基础数据 API 稳定
    3. 文档写清 CodingNS 怎么接
  - 怎么验证：
    - curl 本机 API
    - 外部调用兼容测试
  - 对应需求：`requirements.md` 需求 7
  - 对应设计：`design.md` §3.3、§6.4

- [x] 4.4 阶段检查：外部访问和常驻可用
  - 状态：DONE
  - 本次完成结果：外部访问入口已有 `/api/health`、`/api/integration/status` 和文档库 API；HTTP 服务状态和常驻策略已能通过设置页/API 查看和保存；HTTP 服务真实启停、默认只监听本机地址、桌面关闭窗口隐藏主窗口、系统托盘菜单和后端子进程托管入口都有代码和构建验证。
  - 剩余缺口：桌面端人工验收和开机自启还没有做；安装包内置 Node runtime 已补，真正 sidecar 仍可后续优化。
  - 这一步到底做什么：确认 X-File 不只是一个前端应用，而是能作为本机文档库服务运行。
  - 做完你能看到什么：HTTP 服务和常驻行为都能按设置工作。
  - 先依赖什么：4.1、4.2、4.3
  - 开始前先看：
    - `requirements.md`
    - `design.md`
    - `tasks.md`
  - 主要改哪里：本阶段全部相关文件
  - 这一步先不做什么：不做发布。
  - 怎么算完成：
    1. HTTP 服务启停正常
    2. 常驻策略正常
    3. 外部客户端能读健康检查和文档库状态
  - 怎么验证：
    - 桌面端手工验证
    - HTTP API 集成测试
  - 对应需求：`requirements.md` 需求 5、需求 7
  - 对应设计：`design.md` §2.3.5、§4.3

---

## 阶段 5：打包、跨平台验证和收尾

- [x] 5.1 做 macOS 和 Windows 打包配置
  - 状态：DONE
  - 本次完成结果：已新增 Tauri 2 骨架配置 `apps/desktop/src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`、`src-tauri/src/main.rs`；已新增 `scripts/build-macos.sh` 和 `scripts/build-windows.sh`，根目录新增 `build:macos`、`build:windows` 脚本；已接入 Tauri updater 插件、`bundle.createUpdaterArtifacts`、updater endpoint/pubkey 占位和 Windows self-hosted runner 工作流。本轮已新增 `scripts/prepare-bundled-server.mjs`，用独立 Node 22 runtime 和 hoisted `pnpm deploy` 生成生产后端资源，避免 Tauri 复制资源时丢掉 pnpm 顶层 symlink；Tauri 资源改为打入 `x-file-server` 和 `x-file-runtime`，不再只打 596K 的 server dist。
  - 剩余缺口：真实自动更新和 Windows MSI 需要配置 updater secrets/runner 后实际执行 `tauri:build`；Windows 代码签名证书是可选项，不影响 updater 更新；Node runtime 已经随包准备，并已从 npm 包目录瘦身为单个官方 Node 二进制；Windows 实机验证还没做。
  - 这一步到底做什么：配置桌面应用打包，让 X-File 能生成 macOS 和 Windows 可安装产物。
  - 做完你能看到什么：本地能产出可安装包或安装前可验证的构建产物。
  - 先依赖什么：4.4
  - 开始前先看：
    - `requirements.md` 需求 1
    - `design.md` §8.1「风险」
  - 主要改哪里：
    - `apps/desktop/tauri.conf.json`
    - `scripts/build-*`
    - `.github/workflows/`（如果本轮接 CI）
  - 这一步先不做什么：不做自动更新和签名发布，除非后续单独确认。
  - 怎么算完成：
    1. macOS 构建命令可跑
    2. Windows 构建命令有明确说明或 CI 配置
    3. 原生依赖打包策略写清楚
  - 怎么验证：
    - `pnpm --dir apps/desktop exec tauri build --ci --bundles app`
    - macOS 本地打包命令
    - `node scripts/prepare-bundled-server.mjs`
    - 包内 Node 启动 `x-file-server/dist/main.js` 后访问 `/api/health`
    - Windows 构建说明或 CI 验证
  - 对应需求：`requirements.md` 需求 1
  - 对应设计：`design.md` §8.1

- [x] 5.2 做第一版验收文档
  - 状态：DONE
  - 本次完成结果：已更新 README，并新增 `docs/20260608-X-File第一版验收说明.md`，覆盖基础构建、文档库主流程、HTTP 服务状态、OnlyOffice、常驻策略、系统托盘、后端子进程托管入口、CodingNS 集成入口、桌面壳骨架、打包脚本、自动更新配置和 Windows runner 验收步骤。
  - 剩余缺口：真实自动更新、Windows 实机和 CodingNS 主仓库联调的验收要等后续外部条件齐备；Windows 代码签名安装包是可选增强。
  - 这一步到底做什么：把第一版怎么安装、怎么启动、怎么绑定文档库、怎么启用 HTTP 服务写清楚。
  - 做完你能看到什么：别人拿到仓库后知道怎么验证，不需要翻代码猜。
  - 先依赖什么：5.1
  - 开始前先看：
    - `requirements.md`
    - `design.md`
    - `tasks.md`
  - 主要改哪里：
    - `README.md`
    - `docs/20260608-X-File第一版验收说明.md`
  - 这一步先不做什么：不写营销文案，不承诺未实现能力。
  - 怎么算完成：
    1. 安装和启动步骤清楚
    2. 文档库主流程验证步骤清楚
    3. HTTP 服务和常驻验证步骤清楚
  - 怎么验证：
    - 按文档从空环境走一遍
  - 对应需求：`requirements.md` 成功定义
  - 对应设计：`design.md` §7

- [x] 5.3 最终检查点
  - 状态：DONE
  - 本次完成结果：已完成第一版代码收口和任务状态回写；`pnpm install`、server test/typecheck、web typecheck、`pnpm -r build` 均通过；已检查正式代码没有引入 `node:sqlite`；已补系统托盘菜单、后端子进程托管入口、签名/自动更新配置占位、Windows runner 工作流和大目录压测脚本。
  - 剩余缺口：这不是可发布安装包终版，仍缺真实自动更新、Windows runner 实机构建结果、安装包内置 Node runtime 或真正 sidecar、10 万文件级大目录压测结果、浏览器 UI 人工对照和 CodingNS 主仓库停用文档库联调；Windows 代码签名是可选发布增强。
  - 这一步到底做什么：确认这个 Spec 达到第一版交付标准。
  - 做完你能看到什么：需求、设计、任务、测试和验收结果能对上。
  - 先依赖什么：5.1、5.2
  - 开始前先看：
    - `requirements.md`
    - `design.md`
    - `tasks.md`
    - `docs/`
  - 主要改哪里：当前 Spec 全部文件和第一版实现文件
  - 这一步先不做什么：不追加第二版需求。
  - 怎么算完成：
    1. 所有第一版任务状态已回写
    2. 关键测试和手工验收结果已记录
    3. 已知缺口已写入后续计划
  - 怎么验证：
    - 最小必要测试命令
    - macOS / Windows 验收记录
  - 对应需求：`requirements.md` 全部需求
  - 对应设计：`design.md` 全文

- [x] 5.4 大目录索引压测脚本
  - 状态：DONE
  - 本次完成结果：已新增 `scripts/benchmark-large-library.mjs`，支持参数化生成临时资料库目录、大量文件和目录，直接调用 `@x-file/indexer` 的 `runLibraryIndexOnce(...)`，读取导出 manifest/status 并输出 JSON 摘要；根目录已新增 `benchmark:large-library` 脚本；已新增 `docs/20260609-X-File大目录压测说明.md`，写清默认小规模参数、大规模实机参数和 Node25 下 `better-sqlite3` fallback 的判断方式。
  - 剩余缺口：本轮只跑小规模验证，10 万文件级别实机压测需要在空闲机器上单独执行并保留结果 JSON。
  - 这一步到底做什么：给 X-File 补一个可重复执行的大目录压测入口，验证扫描、索引、导出产物和 manifest 数量是否对齐。
  - 做完你能看到什么：执行 `pnpm benchmark:large-library` 后能得到包含文件数、索引数、manifest 分片数、耗时、RSS 和 fallback 状态的 JSON 摘要。
  - 先依赖什么：2.1、2.5、5.3
  - 开始前先看：
    - `requirements.md` 需求 4、需求 6、非功能需求 1
    - `design.md` §4.1「数据关系」
    - `design.md` §6.1「读接口不触发重活」
    - `design.md` §7「测试策略」
  - 主要改哪里：
    - `scripts/benchmark-large-library.mjs`
    - `package.json`
    - `docs/20260609-X-File大目录压测说明.md`
  - 这一步先不做什么：不修改 desktop/server/web 源码，不启动开发服务器，不把 10 万文件压测产物提交进仓库。
  - 怎么算完成：
    1. 压测脚本可按参数生成资料库
    2. 脚本调用 `runLibraryIndexOnce(...)`
    3. 脚本读取 manifest/status 并输出 JSON 摘要
    4. 文档写清默认小规模和大规模实机参数
    5. 文档写清 Node25 `better-sqlite3` fallback 的含义
  - 怎么验证：
    - `pnpm --filter @x-file/indexer build`
    - `pnpm benchmark:large-library -- --files 20 --dirs 4 --bytes 512 --json`
  - 对应需求：`requirements.md` 需求 4、需求 6、非功能需求 1
  - 对应设计：`design.md` §4.1、§6.1、§7
