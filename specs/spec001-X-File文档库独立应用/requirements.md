# 需求文档 - spec001-X-File文档库独立应用

状态：Draft

## 简介

X-File 要从 CodingNS 中拆出文档库能力，成为一个独立安装、独立运行、独立承担扫描和索引压力的桌面应用。

当前 CodingNS 里的文档库已经有完整主链路：

- 绑定资料库根目录
- 扫描真实文件
- 展示目录、文档、标签、收藏
- 文件预览、下载和基础文件操作
- 外部文件变更后自动刷新
- 索引状态、失败状态和调试信息

问题也很明确：文档库属于高频、高 IO、高索引负载模块，继续和 CodingNS 的代码模式共用一个 Host，会影响整体性能。X-File 要接管这部分重活，让 CodingNS 以后只作为外部调用方，而不是继续自己扫描和索引文档。

第一版目标不是重做一个“更漂亮的新产品”，而是先把 CodingNS 当前文档库完整复刻出来，并改成独立应用该有的结构。

## 术语表

- **System**：`X-File`
- **文档库**：用户选择的资料根目录，以及该目录下的文档、目录、标签、收藏、索引和预览能力。
- **索引服务**：负责扫描文件、解析文本、生成标签、生成导出快照和搜索数据的后端能力。
- **桌面应用**：用户通过 macOS 或 Windows 安装后启动的应用程序。
- **内置 HTTP 服务**：X-File 应用内可启用的本机 HTTP 服务器，用于给本应用前端、CodingNS 或其他本机工具访问文档库数据。
- **常驻后端**：HTTP 服务启用后，即使前端窗口关闭，也能按用户设置继续运行，直到用户关闭服务或退出应用。
- **迁移复刻**：保留当前 CodingNS 文档库的用户体验和后端行为，但不照搬 CodingNS 的工作区、事务模式、Teable、代码会话等耦合结构。

## 范围说明

### In Scope

- 建立 X-File 独立桌面应用的技术骨架。
- 复刻 CodingNS 当前文档库的前端页面、组件、状态、样式和 i18n 文案。
- 复刻 CodingNS 当前文档库的后端逻辑，包括绑定、配置、快照、文档列表、目录文件、预览、下载、文件操作、刷新、收藏、标签。
- 复刻索引服务能力，包括扫描、解析、SQLite 存储、导出快照、标签推断、自动刷新、dirty watcher、热目录缓存和状态观测。
- 支持用户在应用内启用、关闭和查看 HTTP 服务状态。
- 支持 macOS 和 Windows 安装使用。
- 为 CodingNS 后续停用本地文档库重任务预留外部 API 和 deep link。

### Out of Scope

- 不把 CodingNS 的代码模式、Git、Terminal、工作区会话、插件运行时搬进 X-File。
- 不把事务模式整体搬进 X-File。
- 不把 Teable、Butler、轻量事务会话作为第一版必做。
- 不在第一版重做全文搜索和语义搜索的新产品形态；先复刻现有搜索和索引链路。
- 不做云同步、多用户协作、远程账户体系。
- 不把 CodingNS 当前耦合结构原样复制到新仓库。

## 需求

### 需求 1：系统必须作为独立桌面应用运行

**用户故事：** 作为使用者，我希望 X-File 是一个可以单独安装和启动的应用，而不是必须依赖 CodingNS 才能打开文档库。

#### 验收标准

1. WHEN 用户在 macOS 或 Windows 安装 X-File THEN System SHALL 能独立启动，不要求 CodingNS 同时运行。
2. WHEN 用户打开 X-File THEN System SHALL 显示文档库主界面，而不是 CodingNS 的代码工作台或事务工作台。
3. WHEN 应用首次启动且还没有配置文档库根目录 THEN System SHALL 提示用户选择或填写资料库路径。
4. WHEN 用户关闭前端窗口但选择保持服务运行 THEN System SHALL 根据设置保留常驻后端。

### 需求 2：系统必须完整复刻当前文档库前端体验

**用户故事：** 作为已经使用过 CodingNS 文档库的人，我希望迁到 X-File 后页面布局、交互和状态提示保持一致，迁移成本最低。

#### 验收标准

1. WHEN 用户进入文档库 THEN System SHALL 提供与 CodingNS 当前移动文档库页面一致的浏览、收藏、标签、详情布局。
2. WHEN 用户浏览目录 THEN System SHALL 支持网格/列表展示、排序、面包屑、加载更多、空态和刷新入口。
3. WHEN 用户切换收藏或标签 THEN System SHALL 让列表和详情跟随切换。
4. WHEN 后端处于未绑定、加载中、失败、刷新中、排队中、过期等状态 THEN System SHALL 用清楚的页面状态告诉用户当前发生了什么。
5. WHEN 复刻页面文案 THEN System SHALL 使用统一 i18n 字典，不允许在组件里硬编码展示文字。

### 需求 3：系统必须完整复刻当前文档库后端主链路

**用户故事：** 作为使用者，我希望 X-File 读取的是本地真实文档，而不是迁移后的占位数据。

#### 验收标准

1. WHEN 用户绑定文档库根目录 THEN System SHALL 保存绑定配置，并在下次启动后自动恢复。
2. WHEN 用户读取文档库快照 THEN System SHALL 返回绑定、索引状态、标签、收藏、目录、文档数量和最近错误。
3. WHEN 用户读取文档列表 THEN System SHALL 支持目录模式、标签模式、收藏模式、关键词、分页和标签 facet 统计。
4. WHEN 用户读取目录文件 THEN System SHALL 返回当前目录下的文件和文件夹，并带必要的预览能力信息。
5. WHEN 用户预览、下载、删除、移动、复制、新建目录、新建文件或写入文件 THEN System SHALL 复刻 CodingNS 当前文档库的安全校验和结果结构。

### 需求 4：系统必须把索引重活留在 X-File 自己的后端里

**用户故事：** 作为 CodingNS 使用者，我希望文档库扫描、索引、标签重算这些重活不再拖慢 CodingNS。

#### 验收标准

1. WHEN X-File 执行全量扫描、增量刷新、标签重算或导出刷新 THEN System SHALL 在 X-File 后端调度执行，不依赖 CodingNS Host。
2. WHEN 同一个资料库同一种索引任务已经在运行 THEN System SHALL 去重，不并发跑第二份等价重活。
3. WHEN 不同资料库触发重任务 THEN System SHALL 按资料库根目录隔离，避免一个资料库卡住拖死另一个资料库。
4. WHEN 前端只是读取列表或快照 THEN System SHALL 优先读取最近快照、热目录缓存或轻量状态，不在读接口里顺手重扫整库。
5. WHEN watcher 收到外部文件变化 THEN System SHALL 只打脏标记并调度后台刷新，不在 watcher 回调里同步做重活。

### 需求 5：系统必须支持启用 HTTP 服务并常驻后端

**用户故事：** 作为需要和 CodingNS 或脚本联动的人，我希望 X-File 能启用本机 HTTP 服务，并在我允许时常驻。

#### 验收标准

1. WHEN 用户在设置里启用 HTTP 服务 THEN System SHALL 启动本机 HTTP 服务，并显示监听地址、端口、状态和最近错误。
2. WHEN HTTP 服务已经启用 THEN System SHALL 支持应用前端和外部本机客户端访问文档库 API。
3. WHEN 用户关闭 HTTP 服务 THEN System SHALL 停止监听端口，并明确显示已关闭。
4. WHEN 端口被占用或启动失败 THEN System SHALL 给出可读错误，并允许用户改端口后重试。
5. WHEN 用户选择常驻后端 THEN System SHALL 在前端窗口关闭后继续运行 HTTP 服务，直到用户退出应用或关闭常驻。

### 需求 6：系统必须提供稳定的索引状态和恢复能力

**用户故事：** 作为使用者，我希望看到文档库现在是新鲜、过期、排队、运行、失败还是等待恢复，而不是只看到一个不动的列表。

#### 验收标准

1. WHEN 索引任务开始、完成、失败、超时或进入冷却 THEN System SHALL 更新文档库状态。
2. WHEN 任务排队过久 THEN System SHALL 进入 `queue_timeout` 状态，而不是无限显示“刷新中”。
3. WHEN watcher 漏事件 THEN System SHALL 通过轻量对账和周期巡检发现漂移，并提交修复动作。
4. WHEN 索引产物缺失或损坏 THEN System SHALL 尝试自动重建，并保留最近一次可读结果。
5. WHEN 用户查看状态 THEN System SHALL 能看到最近请求、开始、完成、失败时间，以及必要的错误摘要和阻塞原因。

### 需求 7：系统必须为 CodingNS 停用本地文档库预留集成入口

**用户故事：** 作为维护者，我希望 CodingNS 后续能停用自身文档库重任务，只把 X-File 当成外部文档库服务。

#### 验收标准

1. WHEN CodingNS 需要打开文档库 THEN System SHALL 提供 deep link 或本机 HTTP API 入口。
2. WHEN CodingNS 需要读取文档、标签、收藏或状态 THEN System SHALL 能通过 HTTP API 获取结构化结果。
3. WHEN X-File 未运行或 HTTP 服务未启用 THEN System SHALL 返回可诊断错误，方便 CodingNS 提示用户启动 X-File。
4. WHEN API 后续演进 THEN System SHALL 保持第一版接口兼容，不轻易破坏 CodingNS 集成。

## 非功能需求

### 非功能需求 1：性能

1. WHEN 资料库包含大量文件 THEN System SHALL 把重扫描、重解析、重 SQLite 操作放到后台执行，不阻塞前端主交互。
2. WHEN 用户切换目录 THEN System SHALL 优先返回快照或热目录结果，必要时异步补新。
3. WHEN 外部文件高频变化 THEN System SHALL 合并脏标记，避免每个文件事件都触发一次全量刷新。

### 非功能需求 2：可靠性

1. WHEN 索引失败 THEN System SHALL 保留最近一次可读结果，并把失败原因单独暴露。
2. WHEN 后端崩溃或应用重启 THEN System SHALL 能恢复已有文档库绑定和最近索引状态。
3. WHEN HTTP 服务常驻 THEN System SHALL 有明确启动、停止、端口冲突和异常退出处理。

### 非功能需求 3：可维护性

1. WHEN 后续新增搜索、语义索引或更多文件操作 THEN System SHALL 复用当前文档库模块边界，不把代码模式或事务模式概念引进来。
2. WHEN 新增后台任务 THEN System SHALL 继续遵守“读接口纯读、刷新入口显式、watcher 只打脏标记、同类任务去重”的规则。
3. WHEN 从 CodingNS 迁移代码 THEN System SHALL 先解除工作区、事务模式、Teable、Butler 耦合，再落到 X-File 的独立模型里。

## 成功定义

- X-File 可以在 macOS 和 Windows 作为独立应用启动。
- 用户能绑定本地资料库路径，并看到真实目录、文档、标签、收藏和详情。
- 文档库扫描、索引、标签、自动刷新全部在 X-File 后端运行。
- X-File 可以启用本机 HTTP 服务，并按设置常驻。
- CodingNS 可以逐步停用自身文档库重任务，只通过 X-File 的外部入口访问文档库。
