# 需求文档 - spec001.1-X-File 轻量 Office 预览

状态：IN_PROGRESS

## 简介

当前 Office 预览依赖外部 OnlyOffice Document Server，并且会引入编辑器脚本、服务配置、预览文件桥和写回回调。X-File 主要需要在资料库内快速查看文件；编辑可交由用户机器上已有的办公软件。因此以小型解析器渲染只读内容，去掉在线办公服务和它的维护负担。

## 术语表

- **System**：`X-File`
- **Office 预览**：对 DOCX、XLSX、PPTX 文件进行本地只读解析和展示，不承诺与 Office 应用完全一致的版式。
- **系统应用打开**：桌面端调用现有 `open_path` 命令，让操作系统使用关联应用打开原始文件。

## 范围说明

### In Scope

- DOCX、XLSX、PPTX 的应用内只读预览。
- 文件过大、格式损坏或格式特性不支持时给出可读状态，并允许桌面端打开原文件。
- 移除 OnlyOffice 在线编辑器、配置 UI、客户端 API、服务端 API/回调及 Rust bridge。
- 保持 Office 文件索引、目录浏览、下载和桌面本地应用打开行为。
- 桌面端可选安装按平台区分的 LibreOffice 转换组件；未安装时主包不包含 Node/LibreOffice 资源。
- 已安装时 DOCX/PPTX 可通过 LibreOffice 转 PDF 并沿用 PDF.js 连续页预览；XLSX 保持原有工作表和单元格交互，不转 PDF。
- 参照 DSH 的文件预览能力，统一覆盖常用文本、代码、Markdown、HTML、图片、PDF 和 Office 文件，并为不支持的格式提供明确状态与系统应用回退。
- 用声明式格式能力契约和按格式家族组织的适配器接入 renderer；索引支持、预览支持和编辑支持是互相独立的能力。
- 主查看器、详情预览和独立窗口复用同一 renderer 路由，避免为不同入口复制格式分派。

### Out of Scope

- Office 文件在 X-File 内编辑、协作编辑或格式写回。
- 精确复刻 Microsoft Office 的分页、字体、动画、公式计算或打印布局。
- `.doc`、`.xls`、`.ppt` 等旧二进制格式的结构化预览。
- 自动删除用户数据目录中的既有 OnlyOffice 设置文件。
- 将 LibreOffice 引擎默认打入应用主包，或在未明确启用时自动下载它。
- 用 LibreOffice 转换 XLSX 并以 PDF 替代工作表视图。
- 复制 DSH 的整体页面布局、主题或组件实现；X-File 继续使用自己的全局样式和查看器布局。

## 需求

### 需求 1：提供轻量只读 Office 预览

**用户故事：** 作为资料库使用者，我希望不用连接外部办公服务就能快速查看常见 Office 文件，以便浏览流程保持简单并可离线工作。

#### 验收标准

1. WHEN 用户预览有效 DOCX THEN System SHALL 在应用内呈现文档段落及常见标题、列表、表格结构。
2. WHEN 用户预览有效 XLSX THEN System SHALL 呈现工作表选择和有界行列单元格内容，不执行公式。
3. WHEN 用户预览有效 PPTX THEN System SHALL 按顺序呈现幻灯片及可提取文本，不执行动画或嵌入脚本。
4. WHEN 文件损坏、超过资源限制或包含不支持特性 THEN System SHALL 显示可读的部分结果或错误提示，不让预览崩溃。

### 需求 2：将编辑交给系统默认应用

**用户故事：** 作为桌面用户，我希望从预览直接在本机办公软件打开原文件，以便编辑时使用完整功能。

#### 验收标准

1. WHEN 用户从 Office 预览选择“使用本地应用打开” THEN System SHALL 调用现有桌面 `open_path` 能力打开原始文件。
2. WHEN 用户在浏览器或镜像端没有原始文件本地路径 THEN System SHALL 不伪装成已打开，并清楚说明此操作仅桌面本地可用。
3. WHEN 系统应用打开失败 THEN System SHALL 保留预览并向用户呈现失败反馈。

### 需求 3：移除 OnlyOffice 运行链路

**用户故事：** 作为维护者，我希望 Office 预览不再依赖外部 OnlyOffice 服务，以便减少运行依赖、网络耦合和维护面。

#### 验收标准

1. WHEN 应用启动或预览 Office 文件 THEN System SHALL 不读取 OnlyOffice 配置、不加载远程编辑器脚本、不要求外部服务可用。
2. WHEN 用户打开设置页或 HTTP 服务 API THEN System SHALL 不再暴露 OnlyOffice 设置、状态或回调能力。
3. WHEN Office 预览成功或失败 THEN System SHALL 不经 OnlyOffice callback 写回，也不创建 OnlyOffice 专用本地 HTTP bridge。
4. WHEN 升级已有包含 OnlyOffice 配置的用户环境 THEN System SHALL 保留旧文件但忽略它，不主动删除用户数据。

### 需求 4：可选安装 Office 高保真转换器

**用户故事：** 作为桌面用户，我希望按需安装体积较大的本地转换器，以便改善 DOCX/PPTX 的分页和版式，同时不让默认安装包承担这部分体积。

#### 验收标准

1. WHEN 用户未启用转换器 THEN System SHALL 不下载、启动或依赖 Node/LibreOffice，轻量预览和本地应用打开保持可用。
2. WHEN 用户主动安装转换器 THEN System SHALL 只下载与当前 OS/架构匹配的固定版本组件，并验证固定来源的完整性后原子安装。
3. WHEN 安装进行中 THEN System SHALL 提供进度和取消；同时最多运行一个安装或转换任务，并在取消、超时或失败后清理临时文件。
4. WHEN DOCX 或 PPTX 转换预览 THEN System SHALL 使用受限 LibreOffice 转换 PDF 并以 PDF.js 连续页展示；原文件保持只读。
5. WHEN XLSX 预览 THEN System SHALL 保持只读工作表/单元格视图，保留工作表导航和单元格交互，不转为 PDF。
6. WHEN 用户卸载可选转换器 THEN System SHALL 仅删除专用安装目录，不影响文档库、配置或其他应用数据。
7. WHEN 转换组件未安装、字体缺失、转换超时或失败 THEN System SHALL 保留轻量预览及本地应用打开回退，并明确说明版式受字体/引擎影响，不保证与 Microsoft Office 像素级一致。

### 需求 5：提供 DSH 风格的统一文件预览交互

**用户故事：** 作为资料库使用者，我希望常见文件在应用内具有一致的阅读、导航和回退体验，以便不需要根据文件类型重新学习操作方式。

#### 验收标准

1. WHEN 用户预览 PDF THEN System SHALL 连续显示页面，支持按需渲染、页码状态、缩放和取消当前页面渲染。
2. WHEN 用户预览 XLSX 或 XLS THEN System SHALL 在保持只读的前提下提供工作表导航、单元格选区、复制和只读公式栏；WHEN 用户预览 CSV 或 TSV THEN System SHALL 提供只读单网格、单元格选区、复制及数据预览；XLS/XLSX 不得转成 PDF。
3. WHEN 用户预览文本、代码或 Markdown THEN System SHALL 保留现有编辑能力，并提供统一的复制、搜索、行导航、资源限制和错误回退。
4. WHEN 文件包含当前渲染器不支持的图表、图片、形状、条件格式、动画或嵌入对象 THEN System SHALL 保留可读内容并显示紧凑提示，建议使用系统应用查看完整文件。
5. WHEN 预览任务被切换、取消、超时或资源超过限制 THEN System SHALL 终止或丢弃旧任务结果，不得覆盖当前文件的预览状态。
6. WHEN 资源读取、解析或渲染失败 THEN System SHALL 使用统一错误状态，并在桌面本地文件可用时提供“本地打开”。

### 需求 6：建立可扩展且一致的预览适配架构

**用户故事：** 作为维护者，我希望格式能力和 renderer 接入方式有单一、可测试的契约，以便新增格式或修复预览时不会在 Server、Rust 和多个界面入口之间产生行为漂移。

#### 验收标准

1. WHEN 系统识别文件能力 THEN System SHALL 分别表达可索引、可预览、可编辑能力；文件图标和索引白名单不得单独推导出预览支持。
2. WHEN 新增或调整预览格式 THEN System SHALL 在声明式格式能力清单中记录扩展名、预览类别、适配器家族、能力和资源预算，并由适配器注册表选择 renderer。
3. WHEN Server 与桌面 Rust 本地预览识别同一扩展名 THEN System SHALL 通过共享契约或自动化一致性测试保证分类结果一致；允许差异时必须显式记录原因。
4. WHEN 主查看器、详情预览或独立窗口展示同一文件 THEN System SHALL 复用同一个 renderer 分派和适配器，不得退化成纯文本或直接打开原始 Office 资源来冒充应用内预览。
5. WHEN 适配器加载、切换、取消或卸载 THEN System SHALL 使用共同的 `AbortSignal`、资源预算、超时、状态和清理约定；适配器返回的数据模型不得持有 React 组件状态或跨入口 UI 引用。
6. WHEN 扩展名没有专用预览适配器或内容属于不支持的二进制格式 THEN System SHALL 返回明确的 unsupported 状态，不得把已知 Office/媒体/归档二进制误当成普通文本。
7. WHEN XLS/XLSX 解析需要 ZIP 安全检查和工作簿解析 THEN System SHALL 避免不必要的重复完整解压；若安全校验必须进行额外遍历，设计与测试 SHALL 记录其必要性和开销。

## 非功能需求

### 非功能需求 1：性能

1. 非关键路径预览解析器 SHALL 按需加载，避免把大型格式引擎加入初始页面关键路径。
2. 所有预览均须按格式限制文件体积、解压体积、页/幻灯片/工作表数量、行列数量和文本量，避免异常文件耗尽内存。
3. PDF 连续页面和表格网格 SHALL 限制活动渲染资源，不能只限制文件字节数而允许 Canvas/单元格模型无限增长。

### 非功能需求 2：可靠性

1. 解析错误 SHALL 局限于当前文件，不影响文档库列表、后续预览或桌面打开。
2. 所有预览仅操作文件副本/读取结果，不修改任何源文件。

### 非功能需求 3：可维护性

1. 格式 renderer SHALL 与 `LibraryPage` 和通用代码查看器解耦，并通过统一适配器注册表分派。
2. 若目标格式库无法满足预览所需的版式或体积约束， SHALL 使用明确限制的轻量渲染器，而不以 OnlyOffice 作为隐式回退。
3. 所有预览器 SHALL 共享资源读取、取消、超时、缓存和状态模型；格式适配器不得直接修改跨组件 UI 状态。
4. 扩展名和格式能力 SHALL 有唯一权威定义；跨语言代码不得各自维护未校验的预览扩展名副本。
5. 格式适配器按具有共同解析/渲染特征的家族组织，不得为每个扩展名复制资源生命周期和状态机，也不得用单一通用模型抹去格式本身的交互语义。
6. 预览 renderer SHALL 在退出视口、切换文件或关闭视图时释放可重建的大型资源；PDF 连续页预览需限制活动 Canvas 数量或提供等价的内存回收策略。
7. HTML 预览 SHALL 明确 iframe sandbox 权限和资源来源策略；不得因统一 renderer 而扩大未记录的脚本或本地文件访问权限。

## 成功定义

- DOCX、XLSX、PPTX 在不配置外部服务的情况下可在应用内查看。
- 桌面预览提供打开本地应用入口，调用现有 Tauri 命令。
- 主包和默认服务模式不再包含 OnlyOffice 的 UI/API/HTTP 回调/Rust bridge。
- `pnpm --filter @x-file/web build`、相关前端测试、服务端测试和 Rust 检查通过。
- XLSX 预览具备 DSH 风格的只读网格交互；PDF 具备连续页预览；常见文件类型具备统一的错误和回退状态。
- 格式能力清单、Server/Rust 分类一致性、适配器契约和三个预览入口的 renderer 复用均有自动化测试或可复现验收记录。
