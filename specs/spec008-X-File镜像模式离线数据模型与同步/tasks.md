# 任务清单 - X-File 镜像模式离线数据模型与同步（人话版）

状态：IN_PROGRESS

## 阶段 1：主端模型和接口

- [x] 1.1 增加共享镜像快照与 mutation 类型
  - 状态：DONE
  - 这一步到底做什么：给主端和镜像端建立同一份可版本化数据契约。
  - 做完你能看到什么：shared 包可以表达完整快照、待同步操作和同步结果。
  - 先依赖什么：无
  - 开始前先看：
    - `requirements.md` 需求 1、需求 4
    - `design.md` §3.2「数据结构」
  - 主要改哪里：
    - `packages/shared/src/library-types.ts`
    - `packages/shared/src/index.ts`
  - 这一步先不做什么：不改变现有 API 的必填字段。
  - 怎么算完成：
    1. 类型覆盖配置、文件模型、标签和 mutation。
    2. `pnpm --filter @x-file/shared typecheck` 通过。
  - 怎么验证：`pnpm --filter @x-file/shared build` 或仓库级 typecheck。
  - 对应需求：`requirements.md` 需求 1、需求 4
  - 对应设计：`design.md` §3.2

- [x] 1.2 增加主端镜像快照服务和路由
  - 状态：DONE
  - 这一步到底做什么：从现有索引导出和 TagStore 组装完整镜像快照，并提供 HTTP 接口。
  - 做完你能看到什么：主端可以被一个请求读取出可落地的 X-File 数据模型。
  - 先依赖什么：1.1
  - 开始前先看：
    - `requirements.md` 需求 1
    - `design.md` §2.1、§3.3.1
    - `apps/server/src/library/library-service.ts`
    - `apps/server/src/library/tag-service.ts`
  - 主要改哪里：
    - `apps/server/src/library/library-mirror-service.ts`
    - `apps/server/src/library/library-engine-feature.ts`
    - `apps/server/src/routes/library-routes.ts`
    - 对应测试文件
  - 这一步先不做什么：不实现镜像端离线回退和 mutation 重放。
  - 怎么算完成：
    1. 快照包含完整文档索引和标签数据。
    2. 空库、未初始化库和旧数据可正常返回。
    3. mutation ID 已在主端持久化去重，标签记录可按时间戳比较。
  - 怎么验证：`pnpm --filter @x-file/server typecheck` 与 `pnpm --filter @x-file/server test` 通过。
  - 对应需求：`requirements.md` 需求 1
  - 对应设计：`design.md` §2.2、§3.3.1

### 阶段检查

- [x] 1.3 主端模型检查点
  - 状态：DONE
  - 这一步到底做什么：确认快照契约和服务端接口已经稳定。
  - 做完你能看到什么：可以用固定 fixture 读取并比较快照。
  - 先依赖什么：1.1、1.2
  - 开始前先看：
    - `requirements.md`
    - `design.md` §3.2、§3.3
  - 主要改哪里：阶段 1 相关文件
  - 这一步先不做什么：不加前端离线逻辑。
  - 怎么算完成：
    1. 路由测试覆盖快照结构和 mutation 幂等。
    2. 快照 revision 由模型内容摘要产生。
  - 怎么验证：`pnpm --filter @x-file/server test`（41 项通过）。
  - 对应需求：`requirements.md` 需求 1
  - 对应设计：`design.md` §6.1

## 阶段 2：镜像端缓存和读写适配

- [x] 2.1 实现镜像缓存和待同步队列
  - 状态：DONE
  - 这一步到底做什么：保存快照、同步状态和标签 mutation，并支持重启恢复。
  - 做完你能看到什么：主端断开后，镜像 API 仍能读到上次同步的数据。
  - 先依赖什么：1.3
  - 开始前先看：
    - `requirements.md` 需求 2、需求 3
    - `design.md` §2.3.1、§3.1、§4.2
  - 主要改哪里：
    - `apps/web/src/runtime/mirror-cache.ts`
    - `apps/web/src/runtime/mirror-api.ts`
    - 对应测试文件
  - 这一步先不做什么：不改页面视觉和主端服务。
  - 怎么算完成：
    1. 快照和队列使用 IndexedDB 持久化，并在 IndexedDB 不可用时回退 localStorage。
    2. 文档、文件列表、标签树和标签详情可从快照适配。
  - 怎么验证：`pnpm --filter @x-file/web test -- src/runtime/mirror-api.test.ts`（2 项通过）。
  - 怎么验证：Web 单元测试和断网回退测试。
  - 对应需求：`requirements.md` 需求 2、需求 3
  - 对应设计：`design.md` §2.3.1、§4.2

- [x] 2.2 接入现有库 API 并限制镜像端写入
  - 状态：DONE
  - 这一步到底做什么：让现有 library API 在 mirror 模式下使用在线主端或离线缓存，并将标签写入转为队列。
  - 做完你能看到什么：现有资料库页面无需改调用方式即可离线浏览和排队标签操作。
  - 先依赖什么：2.1
  - 开始前先看：
    - `requirements.md` 需求 2、需求 3
    - `design.md` §3.3.3、§5.3
    - `apps/web/src/api/library.ts`
  - 主要改哪里：
    - `apps/web/src/api/library.ts`
    - `apps/web/src/api/http.ts`
    - 对应测试文件
  - 这一步先不做什么：不允许离线文件写、刷新或库配置保存。
  - 怎么算完成：
    1. mirror 断网时资料库、文档和文件模型读取回退到快照。
    2. 标签写入落本地队列，返回 `syncState`。
    3. 文件操作、刷新、备份导入和库配置写入在 mirror 模式被拒绝。
  - 怎么验证：`pnpm --filter @x-file/web typecheck` 和 4 项 mirror API 单测通过。
  - 对应需求：`requirements.md` 需求 2、需求 3
  - 对应设计：`design.md` §3.3.3、§5.3

### 阶段检查

- [x] 2.3 离线主链路检查点
  - 状态：DONE
  - 这一步到底做什么：验证“同步一次、关闭主端、继续浏览和修改标签”的主链路。
  - 做完你能看到什么：断网回放能稳定恢复快照和队列。
  - 先依赖什么：2.1、2.2
  - 开始前先看：
    - `requirements.md`
    - `design.md` §2.3、§4.2、§6.3
  - 主要改哪里：阶段 2 相关文件
  - 这一步先不做什么：不扩展正文离线缓存。
  - 怎么算完成：
    1. 无主端时文件模型和标签筛选可用。
    2. 标签操作显示待同步状态，页面提示待同步数量。
  - 怎么验证：`pnpm --filter @x-file/web test -- src/runtime/mirror-api.test.ts`（4 项通过）。
  - 对应需求：`requirements.md` 需求 2、需求 3
  - 对应设计：`design.md` §6.3

## 阶段 3：同步合并、提示和验收

- [x] 3.1 实现 mutation 重放和冲突合并
  - 状态：DONE
  - 这一步到底做什么：主端接收镜像标签操作，按时间戳和 mutation ID 合并。
  - 做完你能看到什么：恢复连接后队列自动清理，较新的记录胜出。
  - 先依赖什么：2.3
  - 开始前先看：
    - `requirements.md` 需求 4
    - `design.md` §2.3.2、§3.3.2、§6.2
  - 主要改哪里：
    - `apps/server/src/library/library-mirror-service.ts`
    - `apps/server/src/routes/library-routes.ts`
    - `apps/web/src/runtime/mirror-api.ts`
    - 对应测试文件
  - 这一步先不做什么：不处理文件操作 mutation。
  - 怎么算完成：
    1. 重复 mutation ID 通过主端持久化结果去重。
    2. 主端较新记录会覆盖镜像旧记录；删除记录以 tombstone 保留时间戳。
    3. 镜像较新记录可以写入主端，标签定义、文件标签和目录标签共用 mutation 通道。
  - 怎么验证：主端路由集成测试验证幂等、较新主端记录胜出；Web 测试验证离线创建标签后仍可将它分配给文件。
  - 对应需求：`requirements.md` 需求 4
  - 对应设计：`design.md` §2.3.2、§3.3.2、§6.2

- [ ] 3.2 增加状态提示和回归验证
  - 状态：IN_REVIEW
  - 这一步到底做什么：在现有页面显示离线缓存、待同步和冲突结果，并完成全量验证。
  - 做完你能看到什么：用户能知道当前是否在线、数据是否来自缓存以及是否还有待同步修改。
  - 先依赖什么：3.1
  - 开始前先看：
    - `requirements.md` 全部需求
    - `design.md` §4.2、§5.3、§7
    - `docs/20260609-前端开发规范.md`
  - 主要改哪里：
    - `apps/web/src/features/library/LibraryPage.tsx`
    - `apps/web/src/styles.css`
    - `apps/web/src/i18n.ts`
    - 对应测试文件
  - 这一步先不做什么：不改变主仓库既有视觉体系。
  - 怎么算完成：
    1. 状态提示使用现有全局 token 和按钮类名。
    2. mirror 有本地快照时显示离线状态、待同步数量和主端冲突提示；无快照时显示首次同步提示。
    3. 未启动开发服务器。
  - 怎么验证：Web typecheck/build 和 4 项 mirror API 测试通过；server 全量测试 163 项中 160 项通过、3 项 ONLYOFFICE 用例失败；Web 全量测试也出现视口预加载和预览用例失败并被外部信号终止，均需在最终检查前确认基线归属。
  - 对应需求：`requirements.md` 全部需求
  - 对应设计：`design.md` §5.3、§7

### 最终检查

- [ ] 3.3 最终检查点
  - 状态：TODO
  - 这一步到底做什么：核对需求、设计、代码和验证证据。
  - 做完你能看到什么：Spec 和实现状态一致，剩余限制有记录。
  - 先依赖什么：3.1、3.2
  - 开始前先看：
    - `requirements.md`
    - `design.md`
    - `tasks.md`
  - 主要改哪里：当前 Spec 全部文件
  - 这一步先不做什么：不追加正文离线缓存等新范围。
  - 怎么算完成：
    1. 所有已实现任务状态回写为 DONE。
    2. 风险和未实现范围明确记录。
  - 怎么验证：按 Spec 验收清单逐项核对。
  - 对应需求：`requirements.md` 全部需求
  - 对应设计：`design.md` 全文
