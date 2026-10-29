# 任务清单 - spec001.1-X-File 轻量 Office 预览

状态：IN_PROGRESS

## 状态说明

- `TODO`：还没开始
- `IN_PROGRESS`：正在做
- `BLOCKED`：被外部问题卡住
- `DONE`：完成并验证

## 阶段 1：建立轻量只读预览

- [x] 1.1 增加懒加载的 Office 格式预览组件
  - 状态：DONE
  - 完成结果：新增 `fflate` 驱动的按需加载 DOCX/XLSX 只读解析器，并在反馈后将 PPTX 升级为 `@aiden0z/pptx-renderer` 完整幻灯片渲染；压缩文件、解压大小、ZIP 条目、工作表、页数与文字数量均有限制。
  - 这一步到底做什么：基于验证过的轻量 parser，为 DOCX、XLSX、PPTX 提供分格式只读 UI、资源上限和局部错误处理。
  - 做完你能看到什么：三类文件可从应用内阅读，XLSX 可切工作表，PPTX 可逐页查看。
  - 先依赖什么：无
  - 开始前先看：`requirements.md` 需求 1；`design.md` §2.3.1、§3.1、§5
  - 主要改哪里：`apps/web/src/features/library/`、`apps/web/package.json`、`pnpm-lock.yaml`
  - 这一步先不做什么：不做 Office 编辑、回写或版式完全还原。
  - 怎么算完成：解析器按需加载；三格式 fixture 和异常/边界测试通过。
  - 怎么验证：Office renderer 的定向 Vitest 测试和 web typecheck。
  - 对应需求：需求 1
  - 对应设计：§2.3.1、§3.1、§5、§6.1

- [x] 1.2 将预览与本地应用打开接入现有详情/查看器
  - 状态：DONE
  - 完成结果：详情和全屏查看器均接入 OfficePreview；仅桌面本地资料库且有本机路径时调用 `open_path`，失败保留预览并反馈。浏览器和镜像模式不会展示或尝试本地打开。
  - 这一步到底做什么：替换 OnlyOffice viewer 显示分支，给桌面有本地绝对路径时显示打开按钮，并报告打开失败。
  - 做完你能看到什么：详情预览和全屏查看器都可阅读 Office；桌面点击后交给系统应用。
  - 先依赖什么：1.1
  - 开始前先看：`requirements.md` 需求 1、2；`design.md` §2.3、§3.3.4
  - 主要改哪里：`apps/web/src/features/library/LibraryPage.tsx`、`apps/web/src/features/library/LibraryFileCodeViewer.tsx`、测试和全局样式。
  - 这一步先不做什么：不创建专门的编辑器或转换副本。
  - 怎么算完成：打开按钮调用 `open_path`；Web/无绝对路径时不展示不可用操作；读取失败时预览仍可恢复。
  - 怎么验证：Office 组件和 `LibraryPreviewMigration` 定向测试。
  - 对应需求：需求 1、2
  - 对应设计：§2.3.1、§2.3.2、§3.1、§3.3.4

## 阶段 2：移除 OnlyOffice 服务与设置

- [x] 2.1 统一 Office preview DTO 和服务端资源响应
  - 状态：DONE
  - 完成结果：shared DTO 不再包含 `onlyOffice`；Server full profile 为 office 文件返回签名资源 URL，集成测试验证可读取原始字节流。
  - 这一步到底做什么：移除 `onlyOffice` DTO 和 controller payload 构造；保留 `kind: office` 的文件流预览及路径安全。
  - 做完你能看到什么：HTTP/native library preview 返回稳定简洁的 Office 资源信息。
  - 先依赖什么：1.1
  - 开始前先看：`requirements.md` 需求 3；`design.md` §3.2、§3.3.3、§4.1
  - 主要改哪里：`packages/shared/src/library-types.ts`、`apps/server/src/library/`、`apps/desktop/src-tauri/src/lib.rs`
  - 这一步先不做什么：不改变普通文件、图片、PDF 的 preview resource 策略。
  - 怎么算完成：DTO 不包含 OnlyOffice payload；Server full profile 对 office 返回 resource URL。
  - 怎么验证：服务端 preview tests、Rust native preview tests。
  - 对应需求：需求 1、3
  - 对应设计：§3.2、§3.3.3、§4.1、§6.3

- [x] 2.2 移除 OnlyOffice UI、API、服务端 routes 与原生 bridge
  - 状态：DONE
  - 完成结果：移除设置 UI/API/i18n、服务端 service/controller/routes/store、Rust callback bridge 与 settings commands、Agent 工具契约；工具数量同步为 28。旧用户配置文件保留且不读取、不删除。回归测试确认旧 API 返回 404。
  - 这一步到底做什么：清理设置页和 i18n、Web API/native bridge、Fastify routes/service/store，以及 Rust commands/tiny_http callback bridge。
  - 做完你能看到什么：设置不再出现 OnlyOffice；默认服务无 OnlyOffice routes；桌面预览不启动专用端口。
  - 先依赖什么：1.2、2.1
  - 开始前先看：`requirements.md` 需求 3；`design.md` §4.1、§5
  - 主要改哪里：`apps/web/src/features/settings/`、`apps/web/src/api/`、`apps/server/src/office/`、`apps/server/src/routes/`、`apps/desktop/src-tauri/src/lib.rs`、共享类型和测试。
  - 这一步先不做什么：不删除既有用户目录的 `onlyoffice-settings.json`。
  - 怎么算完成：生产代码无 OnlyOffice 使用路径；API route 回归测试确认不存在；已有配置文件 untouched。
  - 怎么验证：Web/server 测试、`cargo check`、精确 `rg` 检索。
  - 对应需求：需求 3
  - 对应设计：§3.2、§4.1、§6.3

## 阶段 3：回归与验收

- [x] 3.1 运行跨层验证并更新 Spec
  - 状态：DONE
  - 这一步到底做什么：执行前端、服务端和 Rust 检查，核对三个格式及本地打开路径。
  - 做完你能看到什么：每条验收标准都能链接到测试或实际构建结果。
  - 先依赖什么：2.2
  - 开始前先看：`requirements.md`、`design.md`、`tasks.md`
  - 主要改哪里：本 Spec 与相关回归测试。
  - 这一步先不做什么：不启动开发服务器，不发布或提交。
  - 怎么算完成：Office 定向测试、构建和 Rust 检查通过；全量 Server 既有测试失败及工具缺失限制已记录，未验证项和已知版式限制写明。
  - 怎么验证：`pnpm --filter @x-file/web build`、相关 Vitest、`pnpm --filter @x-file/server test`、`cargo check`。
  - 对应需求：全部需求
  - 对应设计：§7、§8

### 验证记录

- 后续问题修复（2026-10-27）：DOCX 改用 `docx-preview` 页面 DOM 渲染，XLSX 改用 `@e965/xlsx` 解析工作表/共享字符串/显示格式，PDF 改为按页 PDF.js Canvas 预览；桌面 PDF 通过 `native_read_preview_resource` 读取，继续限制在绑定资料库、PDF/Office 扩展名白名单与 20 MiB。三种 parser 按需分包，原生 PDF iframe/file URL 不再使用。
- 本轮通过：Office renderer Vitest（8 项）、LibraryPreviewMigration Vitest（8 项）、独立 `vite build`、`git diff --check`；构建产物确认 DOCX/XLSX/PDF 与 PDF worker 均独立分包。
- 本轮受阻：`pnpm --filter @x-file/web typecheck`（也是 web build 中的前置步骤）被并行修改的 `LibraryTagTreeMigration.test.tsx:181,184-185` 三处 `this` 隐式 any 阻断；未修改该非预览测试文件。独立 `vite build` 已通过。
- 本轮未通过：`cargo check --lib` 报错在现有标签目录统计 `apps/desktop/src-tauri/src/lib.rs:4525`（`segment.to_owned()` 的类型不匹配），与本轮预览资源命令无关；未修改并行工作区的标签实现。
- 本轮代理：macOS 系统代理和 shell 均为 `127.0.0.1:7897`；仓库配置中没有旧端口 `127.0.0.1:7890`。
- 通过：`pnpm --filter @x-file/web typecheck`、`pnpm --filter @x-file/web build`、Office 与 LibraryPreviewMigration Vitest（14 项）、SettingsPage Vitest（13 项）、Server typecheck/build、Office 路由集成测试（2 项）、`cargo check --lib`、`cargo test --lib`（76 项）、Agent CLI/MCP 测试（8 项）。
- 未通过：全量 Server 测试有 3 项 `library-index-e2e` 增量搜索桶稳定性断言失败，失败涉及并行工作区的标签摘要/索引改动，Office 路由测试通过；本轮未改动索引实现。
- 未执行：`cargo fmt --check`，当前 Rust stable toolchain 未安装 `rustfmt` 组件。
- 已知限制：DOCX 是结构化只读视图，不保证精确分页；PPTX 使用浏览器 HTML/SVG 幻灯片渲染，复杂 Office 专有效果/动画仍可能有差异；XLSX 不计算公式，仅显示存储值。超出资源上限或损坏文件提供本地打开回退。

## 阶段 4：可选 LibreOffice 转换器

- [x] 4.1 固定平台资源与依赖完整性
  - 生成并提交最小 npm lockfile，固定 Kit、平台引擎和全部传递依赖；记录 Node 官方包 SHA-256 与 npm tarball integrity。
  - 明确支持的 OS/架构；不支持的平台只显示说明，不尝试通用下载。
- [x] 4.2 增加受控安装生命周期
  - Tauri 管理状态、下载/解包进度、取消、原子激活、卸载及失败清理。
  - 只用 Rust 常量构造来源和版本；限制下载/解包体积并防 zip-slip/path traversal；安装文件置于专用 app-data 子目录。
- [x] 4.3 增加 DOCX/PPTX 转换命令
  - Rust 重验资料库绑定、相对路径、扩展名、20 MiB 输入预算；Rust 管理转换互斥、超时、取消和 PDF 缓存。
  - 通过固定 Node runtime/helper 调用 Kit，将 PDF bytes 返回前端；XLSX 不走转换。
- [x] 4.4 接入设置和连续 PDF.js 预览
  - 桌面本地设置提供安装/进度/取消/卸载；未安装时现有预览保持正常。
  - DOCX/PPTX 在组件已安装时优先展示转换 PDF 的全部连续页面，失败回退当前 renderer；保留本地应用打开。
- [x] 4.5 安全与跨层验收
  - 覆盖固定清单、篡改/超限包拒绝、路径穿越、并发、取消、超时、缓存失效、路径越界、三种格式分流和 UI 状态。
  - 已完成离线 Rust 测试、前端定向测试、Web 构建和本机 Kit DOCX smoke test；完整首次安装包量/展开空间仍需在真实安装按钮回放时记录，像素一致性不作为承诺。

### 阶段 4 验证记录（2026-10-29）

- 通过：`cargo check --lib`。
- 通过：`cargo test --lib office_converter`（10 项），覆盖锁文件篡改、来源/integrity、路径穿越、输入限制、并发 guard、缓存/PDF 校验和 npm tar 解包。
- 通过：`pnpm --filter @x-file/web typecheck`、Office/Settings 定向 Vitest（21 项）、`pnpm --filter @x-file/web build`、`git diff --check`。
- 通过：六个平台 lockfile 均可被 `npm ci --omit=optional --ignore-scripts --dry-run` 解析；跨平台本机校验使用了 npm 的 `--force` 仅模拟目标平台，不执行实际安装。
- 通过：本机 macOS ARM64 使用已安装 Kit 执行 DOCX -> PDF smoke test，返回 `backend=native`、`pageCount=1`，转换脚本输出 PDF 可读。
- 未执行：完整桌面安装按钮回放、Windows/Linux 实机分发和 PPTX fixture smoke test；这些需要对应平台/真实打包环境。

## 阶段 5：DSH 风格统一文件预览

- [x] 5.1 建立统一预览资源生命周期
  - 状态：DONE
  - 这一步到底做什么：抽出共享的读取、缓存、取消、超时和资源预算模型，避免每个 renderer 自己维护一套异步状态。
  - 做完你能看到什么：切换文件或关闭预览后，旧任务不会覆盖当前文件；重复打开同一资源可复用短期缓存。
  - 先依赖什么：阶段 1、阶段 3
  - 开始前先看：
    - `requirements.md` 需求 5
    - `design.md` §2.2、§2.3.4
    - `apps/server/src/library/file-preview.ts`
  - 主要改哪里：
    - `apps/web/src/features/library/`
    - `apps/web/src/runtime/native-library-bridge.ts`
    - `apps/web/src/features/library/__tests__/`
  - 这一步先不做什么：不改变文件格式解析器和不新增服务端 API。
  - 怎么算完成：
    1. 读取任务支持 AbortSignal、超时和有界缓存。
    2. 切换路径、取消和解析失败均有稳定状态，不产生未处理 rejection。
  - 怎么验证：
    - `PreviewResourceController.test.ts`（8 项）
    - renderer 与 Office/PDF 定向 Vitest（15 项）
    - web typecheck 和 build
  - 对应需求：需求 5、非功能需求 1–3
  - 对应设计：§2.2、§2.3.4、§4.2、§5

- [ ] 5.2 将 XLSX 预览升级为 DSH 风格只读网格
  - 状态：IN_PROGRESS
  - 这一步到底做什么：用 FortuneSheet 或兼容的真实网格替换当前 HTML table，并接入工作表、选区、复制、公式栏和未支持内容提示。
  - 做完你能看到什么：XLSX 可像电子表格一样滚动和选择单元格，公式显示原始公式与保存值，不进入编辑状态。
  - 先依赖什么：5.1
  - 开始前先看：
    - `requirements.md` 需求 4、需求 5
    - `design.md` §2.3.3、§3.2
    - `docs/20261029-DSH文件预览能力对照.md`
  - 主要改哪里：
    - `apps/web/package.json`
    - `apps/web/src/features/library/office-preview-content.tsx`
    - `apps/web/src/features/library/`
    - `apps/web/src/styles.css`
    - `apps/web/src/features/library/__tests__/OfficePreview.test.tsx`
  - 这一步先不做什么：不把 XLSX 转 PDF，不实现单元格编辑、公式重算或图表编辑。
  - 当前完成：
    1. 保留工作表切换、只读选区、复制和公式栏。
    2. 公式、前导零和保存结果不被重新计算或隐式改写。
    3. 图表、图片、形状和条件格式不会阻塞可读单元格。
    4. FortuneSheet 只在 XLSX 预览使用时动态加载，DOCX/PPTX/PDF 不增加表格引擎关键路径。
    5. CSV/TSV 已切换到同一只读网格，保留前导零和逗号字段的字面值。
    6. XLS/XLSX 解析已迁移到可终止的 module Worker；测试环境和不支持 Worker 的 WebView 使用受控主线程回退。
  - 剩余工作：
    1. 补充真实 FortuneSheet 浏览器回放和键盘选区验证。
    2. 评估 Worker 在目标桌面 WebView 的真实取消、超时和内存表现。
  - 怎么验证：
    - XLSX fixture 和组件测试
    - web typecheck、build
    - 手工回放工作表切换、键盘方向键和复制
  - 对应需求：需求 5 验收 5.2；需求 6 验收 6.5
  - 对应设计：§2.3.3、§3.1、§8.2

- [ ] 5.3 将 PDF 预览升级为连续页面
  - 状态：IN_PROGRESS
  - 这一步到底做什么：把普通 PDF 和 LibreOffice 转换 PDF 统一到连续页面 renderer，支持懒加载、页码、缩放和取消。
  - 做完你能看到什么：PDF 可以连续滚动阅读，不需要逐页点击翻页；大 PDF 只渲染视口附近的页面。
  - 先依赖什么：5.1
  - 开始前先看：
    - `requirements.md` 需求 5
    - `design.md` §2.2、§3.1、§2.3.4
    - `apps/web/src/features/library/LibraryPdfPreview.tsx`
  - 主要改哪里：
    - `apps/web/src/features/library/LibraryPdfPreview.tsx`
    - `apps/web/src/features/library/OfficeConvertedPdfPreview.tsx`
    - `apps/web/src/styles.css`
    - `apps/web/src/features/library/__tests__/OfficePreview.test.tsx`
  - 这一步先不做什么：不引入 PDF 编辑、批注或服务端转码。
  - 当前完成：
    1. 普通 PDF 与 Office 转换 PDF 使用同一套连续页面行为。
    2. 页面渲染受视口和像素预算约束，切换文件时能取消。
    3. 已加入页码定位、适应宽度和固定倍率缩放；页面离开活动区或卸载时会取消渲染、清空 Canvas 尺寸并清理 PDF 页面引用。
  - 剩余工作：
    1. 补充真实大页数 PDF 回放和不同平台 WebView 的滚动/缩放检查。
    2. 在实机回放中确认高分辨率/超长文档的活动 Canvas 数量和内存回收情况。
  - 怎么验证：
    - PDF.js mock 测试
    - web typecheck、build
    - 大页数和取消回放
  - 对应需求：需求 5 验收 5.1、5.5
  - 对应设计：§2.3.4、§3.1、§7

- [ ] 5.4 统一文本、代码和其他格式的预览状态
  - 状态：IN_PROGRESS
  - 这一步到底做什么：将文本、代码、Markdown、HTML、图片、Office、PDF 和 unsupported 状态统一到共享工具栏、复制/搜索、资源限制、错误和本地应用回退模型。
  - 做完你能看到什么：不同格式的预览操作位置和错误反馈一致，无法渲染的格式有明确说明和下一步操作。
  - 先依赖什么：5.1、5.2、5.3
  - 开始前先看：
    - `requirements.md` 需求 5
    - `design.md` §3.1、§5
    - `docs/20261029-DSH文件预览能力对照.md`
  - 主要改哪里：
    - `apps/web/src/features/library/LibraryPage.tsx`
    - `apps/web/src/features/library/LibraryFileCodeViewer.tsx`
    - `apps/web/src/features/library/OfficePreview.tsx`
    - `apps/web/src/styles.css`
    - `apps/web/src/i18n.ts`
  - 这一步先不做什么：不移除现有文本/Markdown/HTML 编辑能力，不复制 DSH 的页面布局。
  - 怎么算完成：
    1. 常见文件类型均有 loading、ready、partial、error 和 fallback 状态。
    2. 现有编辑、桌面本地打开和受控路径校验行为保持不变。
    3. 文本、代码和 Markdown 已增加统一搜索入口、命中计数和上一处/下一处定位。
  - 剩余工作：
    1. 统一图片/PDF/Office 工具栏的状态样式。
    2. 补充 detached 窗口跨入口实际回放；目前只有 renderer registry 与资源读取测试。
  - 怎么验证：
    - 相关组件与迁移测试
    - web typecheck、build
    - 人工检查桌面、Web 和镜像模式
  - 对应需求：需求 5 验收 5.3、5.4、5.6
  - 对应设计：§2.2、§2.3.1、§3.1、§4、§5
  - 当前完成：主查看器、详情面板和 detached 窗口已共用 renderer registry；代码与 Markdown 共用搜索控件，并已添加搜索组件测试。
  - 剩余工作：图片、PDF 和 Office 的工具栏/状态外观尚未收敛；各入口的实机一致性仍需验证。

- [ ] 5.5 建立格式能力清单和跨端分类契约
  - 状态：IN_PROGRESS
  - 这一步到底做什么：集中声明各扩展名是否可索引、可预览、可编辑、属于哪个 renderer 家族以及使用哪类资源预算，并验证 Server 与 Rust 本地分类一致。
  - 做完你能看到什么：`.mdx`、旧版 Office、HEIC、媒体和归档等边界有明确、可测试的能力结论；图标和索引允许列表不再暗示预览支持。
  - 先依赖什么：5.4
  - 开始前先看：
    - `requirements.md` 需求 6
    - `design.md` §2.1、§2.3.5、§3.3.2
    - `apps/server/src/library/file-preview.ts`
    - `apps/desktop/src-tauri/src/lib.rs`、`native_index.rs`
    - `apps/web/src/features/library/document-visual.ts`
  - 主要改哪里：
    - `packages/shared/src/` 或所选格式清单位置
    - `apps/server/src/library/`
    - `apps/desktop/src-tauri/src/`
    - `apps/web/src/features/library/`
    - 跨端契约测试
  - 这一步先不做什么：不把资料库索引白名单与预览清单合并，不因文件图标存在就新增 renderer。
  - 怎么算完成：
    1. 每个受支持扩展名都有 kind、adapter family、能力和资源预算定义。
    2. Server/Rust 分类差异由共享数据或自动化契约测试覆盖；已知差异需具名并有理由。
    3. 已知二进制但无 renderer 的格式进入明确 unsupported，不会静默当普通文本解析。
  - 怎么验证：
    - manifest 单元测试和 Server/Rust 映射契约测试
    - 索引、图标、预览集合差异报告
    - Web typecheck、Server 测试和 `cargo test`
  - 对应需求：需求 6 验收 6.1–6.3、6.6
  - 对应设计：§2.1、§2.3.5、§3.3.2
  - 当前完成：共享 JSON manifest 已供 TypeScript Server/Web 和 Rust 使用，Server/Rust 分类及预算读取已接入；测试覆盖扩展名唯一性、`.mdx`、CSV、XLSX 和旧 Office 等边界。
  - 差异核对：索引默认集合仍独立于预览 manifest；`.doc`/`.ppt` 可出现在默认索引配置但预览明确 unsupported，`.mdx` 有 Markdown 图标但按普通文本预览，`.heic` 有图片图标但不支持预览；代码、媒体和归档图标也不表示默认索引或 renderer 支持。
  - 当前验证：新增 `pnpm report:preview-capabilities` 输出索引、视觉图标和预览集合差异；报告确认 `.doc`/`.ppt` 是索引但 unsupported，`.heic` 及媒体/归档是图标但 unsupported，`.mdx` 是图标但按 text-code 预览。
  - 剩余工作：把报告纳入发布前校验并补 Rust 默认索引集合的机器可读输出；索引白名单依需求保持独立，不能将一致性误解为合并。

- [ ] 5.6 统一多入口 renderer 路由并定义适配器生命周期
  - 状态：IN_PROGRESS
  - 这一步到底做什么：让主查看器、详情预览和 detached 窗口通过一个静态 registry 选择同一格式适配器；统一 load、取消、错误、partial 和 dispose 契约。
  - 做完你能看到什么：同一个文件在不同入口使用相同 renderer；切换或关闭预览不会遗留 Worker、PDF 任务或旧状态。
  - 先依赖什么：5.1、5.2、5.3、5.5
  - 开始前先看：
    - `requirements.md` 需求 6
    - `design.md` §2.3.5–§2.3.6、§3.3.1
    - `apps/web/src/features/library/LibraryPage.tsx`
    - `apps/web/src/features/library/OfficePreview.tsx`
  - 主要改哪里：
    - `apps/web/src/features/library/`
    - `apps/web/src/features/library/__tests__/`
    - `apps/web/src/styles.css`
  - 这一步先不做什么：不创建运行时可下载插件系统，不强迫不同格式共用同一种 parser model。
  - 怎么算完成：
    1. 主 viewer、详情和 detached 不再复制格式分支，且 detached 不退化成原始 Office URL 或纯文本 Blob。
    2. adapter 接收受控 PreviewSource、AbortSignal 和预算，返回与 React 状态解耦的格式专属 model。
    3. `dispose` 可重复调用且能清理 Worker/PDF 等资源；过期任务不能提交状态。
  - 怎么验证：
    - registry 与 adapter 生命周期单元测试
    - 三种入口对相同 fixture 的 renderer 集成测试
    - 取消、超时、切换文件、关闭和错误回退测试
  - 对应需求：需求 5、需求 6 验收 6.2、6.4、6.5
  - 对应设计：§2.3.5–§2.3.6、§3.3.1
  - 当前完成：主查看器、详情和 detached 窗口共用 renderer registry；detached 入口通过应用路由重新获取预览，不再将原始 Office URL 或文本 Blob 当作预览。图片、PDF、Office document 和 spreadsheet 已通过静态 resource adapter 统一执行 `load(source, signal, limits)`，renderer 接收本次加载的只读字节模型，卸载时幂等清理。
  - 当前补充：text-code、Markdown、HTML 和 delimited text 也已通过内存模型 adapter 进入同一 `load/dispose` registry；多入口仍共享同一 registry，紧凑视图只裁剪展示层，不改变格式选择。
  - 剩余工作：补齐三入口真实集成/取消回放，确认 detached 窗口在实际 Tauri WebView 中与详情入口保持相同生命周期。

- [ ] 5.7 收口预览资源、安全与性能边界
  - 状态：IN_PROGRESS
  - 这一步到底做什么：基于当前 renderer 检查并修复跨端类别漂移、XLSX 重复解压、HTML iframe 权限和大 PDF 页面资源不回收等已知问题。
  - 做完你能看到什么：格式识别不会误导入不安全 renderer；解析成本和页面内存有可解释上限；HTML sandbox 权限经验证。
  - 先依赖什么：5.5、5.6
  - 开始前先看：
    - `requirements.md` 需求 6、非功能需求 1–3
    - `design.md` §2.3.4、§3.3.2、§5、§7
    - `apps/web/src/features/library/xlsx-preview-parser.ts`
    - `apps/web/src/features/library/PdfContinuousPreview.tsx`
    - `apps/web/src/features/library/LibraryPage.tsx`
  - 主要改哪里：
    - Server/Rust 格式分类与资源限制实现
    - `apps/web/src/features/library/`
    - `apps/web/src/styles.css`
    - 对应安全和性能测试
  - 这一步先不做什么：不移除必要的 ZIP 防护、不放宽路径校验或文件预算，也不承诺与 Microsoft Office 像素级一致。
  - 怎么算完成：
    1. XLSX ZIP 安全检查与工作簿解析不做不必要的重复完整解压，或有测试证据说明额外扫描不可避免且开销有界。
    2. PDF 连续预览活动 Canvas/页面资源有界，缩放和滚动不会裁切页面内容。
    3. HTML iframe sandbox、外部资源和本地文件访问策略符合最小权限并有回归测试。
    4. 资源大小、超时、缓存键和取消行为跨 HTTP/native 路径一致或差异已记录。
  - 怎么验证：
    - ZIP bomb、超限和 XLSX fixture 性能/语义测试
    - 大页数 PDF 的 Canvas 数量与滚动/缩放回放
    - HTML iframe 安全测试
    - Server/Rust/Web 对照测试
  - 对应需求：需求 5、需求 6 验收 6.3、6.5、6.7
  - 对应设计：§2.3.4、§3.3.2、§5、§7
  - 当前完成：XLSX 增加流式 ZIP 解压总量预检后再由 SheetJS 构造工作簿；PDF 页面离开活动区/卸载时取消任务、清空 Canvas 并销毁文档代理；HTML iframe 的 sandbox、无 referrer 与 HTTP(S) 外链限制有组件测试；缓存键纳入文件大小和修改时间，native 读取槽位保持到不可中止的原生命令真正结束。
  - 当前补充：详情预览和 detached preview 的 flex 高度链已明确传递可用 viewport 高度；DOCX 详情页使用容器宽度自适应，预览内容在面板内部滚动，不再由文档内容撑开窗口。
  - 剩余工作：验证 ZIP bomb/损坏包资源成本和语义；确认不同传输层超时/取消的实际边界（Tauri 原生命令无法中止已启动的同步文件读取）；执行 WebView HTML 安全与 PDF 活动 Canvas 回放。

### 阶段 5 检查

- [ ] 5.8 统一文件预览最终验收
  - 状态：IN_PROGRESS
  - 这一步到底做什么：对照 DSH 能力清单逐项验证，不把“样式相似”当成预览能力完成。
  - 做完你能看到什么：XLSX、PDF、Office、文本、代码和不支持格式的能力边界有实际证据。
  - 先依赖什么：5.1、5.2、5.3、5.4、5.5、5.6、5.7
  - 开始前先看：
    - `requirements.md`
    - `design.md`
    - `docs/20261029-DSH文件预览能力对照.md`
  - 主要改哪里：当前 Spec、测试和验收记录。
  - 这一步先不做什么：不追加新的文件格式或在线编辑能力。
  - 怎么算完成：
    1. 所有已实现能力都有测试或人工回放记录。
    2. 已知限制、跨平台差异和包体影响已记录。
  - 怎么验证：
    - 前端测试、构建和差异检查
    - 桌面资源/包体检查
    - 真实 Office/PDF/XLSX fixture 回放
  - 对应需求：需求 1–6
  - 对应设计：§7、§8
  - 当前完成：已完成自动化契约、构建、资源生命周期和包体初步记录；最终验收仍缺真实 Tauri/WebView 回放和真实复杂 DOCX/XLSX/PDF fixture 的视觉证据。
  - 剩余工作：完成桌面窗口、FortuneSheet 键盘/复制/冻结窗格、大 PDF 滚动缩放、中文字体和可选转换器首次安装回放，并把结果补入本节。

### 阶段 5 既有验证记录（本轮开始前，2026-10-29）

- 已完成统一预览资源读取控制器：HTTP/native 受控读取、20 MiB 上限、20 秒超时、AbortSignal、短期缓存和隔离字节副本。
- 已完成 XLSX 第一版 FortuneSheet 只读网格接入：工作表切换、只读选区回调、公式栏、选区复制、单元格可访问摘要和未支持内容提示；网格不接收公式字段，公式只用于公式栏，避免浏览器重新计算保存结果。
- 已补充旧版 `.xls`：服务端和 Tauri native resource 允许读取，前端复用同一只读工作表 renderer，LibreOffice 转换器仍只处理 DOCX/PPTX。
- 已补充 CSV/TSV：资料库文本内容在预览模式下进入只读 FortuneSheet 网格，保留引号字段和前导零。
- 已新增 `xlsx-preview.worker.ts`：XLS/XLSX 解析默认在 module Worker 中执行，Worker 不可用时回退到受控主线程解析。
- 文本、代码和 Markdown 已增加搜索、命中数、上一处/下一处和滚动定位控件。
- 已完成普通 PDF 与 LibreOffice 转换 PDF 的连续页面组件合并：页码定位、懒加载、适应宽度、固定倍率缩放和当前渲染任务取消；Canvas 离开活动窗口后的回收尚未实现。
- 当前架构差距：Server、Rust 和视觉/索引列表仍分别维护扩展名；主 viewer 与详情各自分派 renderer；detached 仍可能展示纯文本 Blob 或原始资源 URL；这些问题尚未由统一 manifest/registry 收敛。
- 性能与安全待验证：XLSX 当前先由 `fflate.unzipSync` 检查 ZIP，再由 SheetJS 解析；PDF 页面滚出后仍保留已挂载 Canvas；主 HTML iframe 没有 sandbox 属性。具体修复与行为验收列入 5.7。
- 通过：`PreviewResourceController.test.ts`（3 项）、Office/PDF 定向测试（12 项，含 XLS）、`pnpm --filter @x-file/web typecheck`、`pnpm --filter @x-file/web build`、server typecheck、`cargo check --lib`。
- 单独执行的 `LibraryPreviewMigration.test.tsx` 在当前机器被测试进程以退出码 143 终止，未形成新的通过结论；Office、资源控制器和构建验证不受影响。
- 当前未完成：真实 FortuneSheet 浏览器回放、Worker 在目标 WebView 的实机取消/超时验证、跨平台大 PDF 滚动/缩放与资源回收回放，以及阶段 5.5–5.8 的架构收口。

### 阶段 5 本轮验证记录（2026-10-29）

- 通过：预览资源控制器、renderer 和 Office/PDF 定向 Vitest（23 项）；覆盖并发上限、排队取消、超时、缓存过期/版本失效、HTML sandbox、图片 Blob URL 清理、PDF 卸载 Canvas 回收及文本/Markdown 搜索控件。
- 通过：预览资源控制器、统一 renderer、Office/PDF 定向 Vitest（26 项）；新增资源 adapter 加载/释放、DOCX 版心选项和可选 LibreOffice 自动转换回归覆盖。
- 通过：`pnpm --filter @x-file/web typecheck`、`pnpm --filter @x-file/web build`；构建警告显示 PPTX renderer 与 SheetJS 仍形成较大的独立 chunk，未在本轮调整依赖或包拆分策略。
- 通过：`pnpm --filter @x-file/server typecheck`、预览能力/资料库服务/路由定向测试（20 项）。
- 通过：Rust `cargo test --lib preview_capabilities`（2 项）、`cargo test --lib office_converter`（10 项）、`cargo check --lib`。
- 通过：`node scripts/report-preview-capabilities.mjs`；当前报告明确列出 2 个“索引但不支持预览”扩展名和 23 个“有视觉图标但不支持预览”扩展名。
- 记录：本轮 Web build 输出目录约 9.6 MiB；PPTX renderer 最大 chunk 约 1.31 MiB、PDF worker 约 1.00 MiB、XLSX worker 约 369 KiB；可选转换器随包仅包含约 100 KiB 的脚本/lockfile，Node/Kit 仍按需下载，未计入最终安装包体积。
- 未执行：`cargo fmt --check`，当前 stable Rust toolchain 未安装 `rustfmt`；真实 Tauri detached 窗口、FortuneSheet 键盘交互、各平台 PDF WebView 回放以及完整打包体积验证仍未完成。

### DOCX 预览优化记录（2026-10-29）

- DOCX 轻量渲染仍保留 `docx-preview`，但关闭其固定页面宽高约束，由 X-File 外层容器控制可用宽度，避免窄详情面板把整页压缩成居中细栏。
- 文档页改为宽度自适应、保留文档纸张背景、阴影、内边距、字体和表格宽度约束；表格单元格允许长文本换行。
- 本机已安装可选 LibreOffice 转换器时，DOCX/PPTX 会自动优先走 PDF.js 连续页面；转换失败回退轻量 DOCX/PPTX renderer，并保留本地应用打开。
- 全部预览家族已接入静态 adapter registry：资源型格式返回受控字节模型，text-code/Markdown/HTML/delimited text 返回内存模型；统一执行 `load(source, signal, limits)` 和幂等 `dispose`。
- 详情面板和全屏查看器现在沿 viewport 高度链布局，DOCX/PDF/表格/HTML 内容在预览面板内部滚动；DOCX 版心宽度自适应窗口，避免页面内容横向裁切。
- DOCX 纸张使用独立的文档页文字/背景 token，不继承深色工作台的浅色文字，避免暗色主题下白纸上的正文变成低对比度。
- 通过：Office/PDF/资源控制器/统一 renderer/detached 定向 Vitest（27 项）、Web typecheck、Web build、`git diff --check`。
- 未完成：真实 DOCX 复杂样式、分页、中文字体和不同平台 WebView 的视觉回放；这些仍需使用真实文档 fixture 检查，轻量 renderer 不承诺与 Microsoft Word 像素级一致。
