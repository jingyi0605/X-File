# 设计文档 - spec001.1-X-File 轻量 Office 预览

状态：IN_PROGRESS

## 1. 概述

### 1.1 目标

- 用按需加载的轻量只读预览器覆盖 DOCX、XLSX、PPTX，并用 PDF.js 绘制 PDF 页面以适配桌面 WebView。
- 保留原始文件不变，并复用已有桌面默认应用打开能力承担编辑。
- 移除 OnlyOffice 远程脚本、设置、服务端协调和原生回调桥。
- 参考 DSH 的文件类型分派、资源观察、只读表格交互和统一回退模型，提升常用文件预览的一致性。
- 以声明式格式能力清单和按文件家族组织的适配器作为唯一预览接入契约；统一主查看器、详情面板和独立窗口的 renderer 路由。
- 保留各格式自己的展示模型：表格继续是交互网格，PDF 是连续页面，HTML 是受限网页，文本/代码和 Markdown 保留各自阅读语义。

### 1.2 覆盖需求

- `requirements.md` 需求 1：轻量 Office 只读预览
- `requirements.md` 需求 2：本地应用打开
- `requirements.md` 需求 3：移除 OnlyOffice 运行链路
- `requirements.md` 需求 4–6：可选转换器、统一预览交互和适配器架构

### 1.3 技术约束

- 桌面端：Tauri 2 + Rust；使用已注册 `open_path` 命令。
- 前端：React + TypeScript；全局视觉沿用 `apps/web/src/styles.css` 现有 token/class。
- 服务端：Fastify 兼容路径保留 library preview 的 `kind: office` 基础 DTO，不再构造编辑器 payload。
- 依赖：Office parser 仅前端按需加载；选择可在浏览器运行且支持格式需求的库，不引入完整办公套件。

## 2. 架构

### 2.1 系统结构

```text
Format Capability Manifest (indexable != previewable != editable)
  -> Server / Rust classification contract tests
  -> LibraryPreview + validated PreviewSource
  -> PreviewAdapterRegistry (family adapters)
  -> shared PreviewSurface (viewer / detail / detached)
  -> format-specific read-only model and renderer
       text/code | Markdown | HTML | image | PDF.js pages
       DOCX/PPTX -> optional LibreOffice PDF, then PDF.js; browser fallback
       XLS/XLSX/CSV/TSV -> read-only spreadsheet grid, never PDF
  -> 桌面“使用本地应用打开” -> 现有 open_path -> OS 文件关联
```

格式能力清单是预览扩展名、renderer 家族、能力和预览资源预算的唯一权威定义；索引白名单仍表达资料库收录策略，不与可预览集合合并。Server 与 Rust 从同一契约读取或以自动化测试校验映射一致。图标目录只负责视觉标识。

首批能力映射如下；未列入预览集合的格式仍可按独立索引策略被收录，但不应被误送到不兼容 renderer：

| 扩展名/类别 | 预览家族 | 预览方式 | 当前能力边界 |
| --- | --- | --- | --- |
| `.md`、`.markdown`、`.mdown`、`.mkd` | Markdown | React Markdown/GFM 安全子集 | 不执行原始 HTML/脚本；解析失败时提供文本回退 |
| `.mdx` | text/code（默认） | 普通文本预览 | 只有引入并验证 MDX parser 且禁用可执行组件后，才可改列为 Markdown adapter |
| `.txt` 及明确支持的源码/配置/日志文本 | text/code | 行文本 renderer 与语言元数据 | 保留文本编辑；未知扩展名须满足安全文本探测和大小限制才能回退为文本 |
| `.html`、`.htm` | HTML | sandbox iframe / 静态呈现 | sandbox 权限和本地/外链资源策略须显式定义 |
| `.png`、`.jpg`、`.jpeg`、`.gif`、`.webp`、`.svg`、`.bmp`、`.ico` | image | 浏览器图像查看器 | `.heic` 当前不在安全可读集合，图标不代表支持预览 |
| `.pdf` | PDF | PDF.js 连续页面 | 懒渲染、页码、缩放、活动页面资源有界 |
| `.docx`、`.pptx` | Office document/presentation | 可选 LibreOffice 转 PDF + PDF.js；浏览器 renderer fallback | 只读，不承诺与 Office 像素级一致 |
| `.xls`、`.xlsx` | spreadsheet | SheetJS parser + Worker + FortuneSheet | 只读工作表和选区；不转 PDF、不重算公式 |
| `.csv`、`.tsv` | delimited text | 安全分隔符 parser + FortuneSheet | 只读网格，限制行列和字节数；不提供虚构的工作表/公式语义 |
| `.doc`、`.ppt`、`.odt`、`.ods`、`.odp`、`.wps`、`.key`、`.numbers` 及媒体/归档 | unsupported 或仅索引 | 系统应用回退 | 在声明并验证专用 adapter 前，不作为内置结构化预览承诺 |

该映射是目标契约；实现迁移期间应通过差异测试记录当前代码尚未满足的扩展名，不得将目标表误写成当前实现已全部支持。

预览资源来自服务端受控预览 URL，或 Tauri 对绑定资料库内路径执行验证后提供的原生资源读取命令。所有适配器通过 `PreviewResourceController` 获取资源，不自行拼接绕过校验的路径。远端/镜像通过受控 preview URL 读取；本地应用打开只在桌面且有绝对本机路径时启用。PDF 由 PDF.js 连续绘制页面，不依赖桌面 WebView 原生 PDF iframe/file URL。

### 2.2 模块职责

| 模块 | 职责 | 输入 | 输出 |
| --- | --- | --- | --- |
| `FormatCapabilityManifest` | 定义预览扩展名、renderer 家族、能力和资源预算；与索引策略分离 | 扩展名/类别 | 预览定义及跨端契约 |
| `PreviewAdapterRegistry` | 按 manifest 选择家族适配器并返回统一状态 | `LibraryPreview`、`PreviewSource` | adapter model / renderer |
| `PreviewSurface` | 为 viewer/detail/detached 复用相同 renderer 路由，仅接收布局模式 | preview、layout | 格式 renderer |
| `PreviewResourceController` | 读取、校验、取消、超时和短期缓存预览资源 | path、URL、AbortSignal | `Uint8Array` 或文本 |
| `OfficeAdapter` | 组织 DOCX/PPTX 转换和轻量 fallback、XLS/XLSX 网格解析 | 受控资源、格式 | Office 专属只读 model |
| `TextAdapter` | 组织纯文本和代码内容及语言元数据 | 受控文本 | 文本/代码 model |
| `MarkdownAdapter` | 解析 Markdown/GFM 并保留代码块语义 | 受控文本 | Markdown model |
| `HtmlAdapter` | 提供受限 HTML 资源与 sandbox 策略 | 受控资源 | HTML model |
| `ImageAdapter` | 校验图片资源并声明缩放能力 | 受控资源 | 图片 model |
| `LibraryPdfPreview` | 连续、懒加载绘制 PDF 页面并导航 | PDF bytes | 页面 Canvas 列表 |
| `LibraryPage` | 选择布局入口并提供 preview DTO、桌面打开 capability | `LibraryPreview`、路径 | `PreviewSurface` |
| `open_path` | 调用操作系统文件关联 | 规范化的绝对路径 | 系统应用打开原文件 |
| library HTTP/native API | 执行路径校验并返回稳定的 preview DTO/受控资源 | path query | `LibraryPreview` / resource |

### 2.3 关键流程

#### 2.3.1 打开 Office 预览

1. 入口取得稳定的 `LibraryPreview` DTO；能力由格式清单确定，不从图标、索引白名单或 MIME 猜测。
2. `PreviewSurface` 使用统一 registry 按格式家族解析适配器；viewer、detail 和 detached 采用同一路由。
3. 适配器仅通过 `PreviewSource`/资源控制器读取数据，并在适用时使用可终止 Worker。
4. 适配器返回格式专属、与 React 状态解耦的只读 model；`PreviewSurface` 统一显示 loading、partial、error 和 fallback 状态。
5. 读取与解析使用 `AbortSignal`、超时、预算和任务代次；切换/关闭后不提交旧结果，并释放 adapter/PDF 资源。
6. 失败或明确不支持时提供可理解状态；桌面本地路径可用时提供“使用本地应用打开”。

#### 2.3.2 编辑 Office 文件

1. 用户点击“使用本地应用打开”。
2. Web 侧确认 runtime 是 Tauri 且 `absoluteFilePath` 存在。
3. 调用 `open_path`，操作系统负责选择应用。
4. 不在 X-File 中保存 Office 内容，也不启用回调写回。

#### 2.3.3 XLSX 只读工作表预览

1. 受控读取 XLSX/XLS/CSV/TSV 字节，先检查文件大小、压缩包条目和矩形区域预算。
2. 解析适配器只返回工作表数据、格式化值、公式文本、初始选区和未支持内容分类，不持有 React setter、定时器或组件引用。
3. FortuneSheet 以只读模式显示网格；切换工作表保留有效初始选区，选中单元格时更新只读公式栏。
4. 复制行为从结构化单元格数据生成纯文本或表格内容，并对公式、字符串和保存结果做安全转义。
5. 图表、图片、形状和条件格式不阻塞单元格预览，使用紧凑提示说明未显示内容。

#### 2.3.4 统一预览资源生命周期

1. `PreviewResourceController` 为每个路径维护一个短期缓存键，至少包含规范路径、大小、修改时间和资源来源。
2. 新任务开始时取消旧任务；读取和解析都受超时约束，取消后不得再提交状态。
3. PDF 页面只在接近视口时渲染；页面离开视口时可以释放 Canvas 和 PDF 页面资源。
4. 转换得到的 PDF 继续使用现有 Rust 侧缓存、并发互斥、超时和取消控制。

#### 2.3.5 格式清单与适配器契约

1. 格式定义至少包含扩展名、preview kind、adapter family、可预览/编辑能力及资源预算类别；索引收录规则由独立配置表达。
2. registry 只负责选择 adapter，不执行格式解析；同一家族可承载多个扩展名，但不得把格式语义不同的预览强行归一为同一 model。
3. adapter 的 `load(source, context)` 接收受控资源、`AbortSignal` 和限额，返回格式专属 model、`ready/partial` 信息及可选 `dispose`。
4. adapter 不持有 React setter、全局 UI 状态或硬编码入口；renderer 接收 model 与布局参数。
5. Server 与 Rust 应消费同一声明式清单，或以契约测试逐项验证格式类别和资源类别相同。若选择生成代码，生成结果不可手改且有校验命令。

#### 2.3.6 多入口 renderer 复用

1. 主文件查看器、详情预览和 detached 窗口只负责选择布局，不各自维护扩展名分支。
2. detached 视图必须加载 X-File 的同一应用 renderer，保持 PDF 连续页、Office 转换/回退、表格交互和本地应用操作；不得将原始 Office 资源 URL 当作应用内预览，也不得把其字节包装成纯文本。
3. compact/detail 布局可以裁剪工具栏，但不能改变适配器选择、解析结果和安全策略。

## 3. 组件和接口

### 3.1 核心组件

- `OfficePreview`：统一预览边界、加载和错误状态。
- `FormatCapabilityManifest`：格式能力的单一权威定义，与索引扩展名白名单和文件图标分离。
- `PreviewAdapterRegistry`：按格式家族选择 parser/renderer adapter。
- `PreviewSurface`：viewer、detail、detached 共用的 renderer 路由和状态边界。
- `PreviewAdapter`：标准异步加载、取消、预算、partial/error 和 dispose 契约。
- `DocxPreview`：优先使用可选 LibreOffice PDF；否则提取段落/标题/列表/表格的只读表示。
- `XlsxPreview`：工作表切换、只读网格、选区、复制和公式栏。
- `PptxPreview`：按幻灯片顺序显示文本块与简单结构。
- `LibraryPdfPreview`：连续页、懒加载、缩放和页码导航。
- `TextPreview`：文本、Markdown、代码和 HTML 的统一资源边界、复制和搜索交互。
- `LibraryFileViewerSurface` / `LibraryDetailPreview`：传入 preview URL 和可选桌面打开回调。

适配器按格式家族划分，而不是每个扩展名一个插件；当前预期家族为 text/code、Markdown、HTML、image、PDF、Office document/presentation、spreadsheet/delimited text。不得为此引入运行时动态插件市场。

初期以应用内静态注册表实现，不引入可下载插件协议、动态代码执行或插件市场。先以共享 renderer 路由收敛现有分支，再逐步迁入 `load/dispose` 适配器边界，避免一次性重写全部 viewer。

### 3.2 数据结构

复用 `LibraryPreview`：`kind: "office"`、`path`、`supported`、`reason`、`size`、`updatedAt`、`previewUrl` 和 `capabilities`。移除 `onlyOffice` 字段，避免线上编辑配置进入通用文档 DTO。桌面打开回调为可选 UI capability，不进持久数据。

### 3.3 接口契约

#### 3.3.1 格式定义与预览适配器

概念接口（具体类型以实现为准）：

```ts
interface PreviewAdapter<Model> {
  id: string;
  family: string;
  load(
    source: PreviewSource,
    context: { signal: AbortSignal; limits: PreviewLimits },
  ): Promise<{ model: Model; quality: "ready" | "partial"; warnings: string[]; dispose?: () => void }>;
  View: React.ComponentType<{ model: Model; layout: PreviewLayout }>;
}
```

- `PreviewSource` 仅暴露通过 Server/Tauri 路径校验的读取能力，不把任意本地路径交给 Web parser。
- registry 由 manifest 中的 `adapterFamily` 选择；解析器只返回数据，不更新 React state。
- 同一 adapter 可声明多个格式扩展名；具体格式能力仍由 manifest 中每个扩展名条目声明。
- `dispose` 幂等；卸载时终止 Worker、取消 PDF task 并释放可重建的大型资源。

#### 3.3.2 格式分类一致性

- 格式清单应位于可由 monorepo `packages/shared` 消费的位置；Server 和 Web 使用同一 TypeScript 定义，Rust 使用生成结果或 `include_str!` 读取同一数据源。
- 若构建边界不适合直接共享，则保留跨端契约测试，逐项比对 server kind、native kind、可读资源白名单和已知差异。
- 索引/收录扩展名不得从 previewable 列表自动推导，反之亦然。
- `unknown`、已知二进制但无 renderer、已知可预览格式三者需有不同测试结果；不得对已知 Office 二进制静默 fallback 到纯文本。

#### 3.3.3 Office 预览资源

- 类型：受控 HTTP resource / Tauri native byte-read command
- 路径或标识：受控 `PreviewSource`（HTTP preview URL 或由 Tauri 校验后读取的资料库相对路径）
- 输入：library 相对路径
- 输出：原始 Office 文件字节流；不得返回 editor config 或 callback 地址
- 校验：继续使用现有资料库根目录约束和受控链接 token
- 错误：沿用 library preview 现有错误格式

#### 3.3.4 桌面本地应用打开

- 类型：Tauri command
- 路径或标识：`open_path`
- 输入：目标文件绝对路径
- 输出：打开命令启动结果
- 校验：由现有 native command 拒绝空路径；前端仅从已解析的当前预览文件构造路径
- 错误：现有 `open_path` 错误传给预览状态反馈

## 4. 数据与状态模型

### 4.1 数据关系

Office 预览 DTO 只描述文件与预览资源；解析后的展示结构仅作为当前组件状态，不写入配置和源文件。旧 `onlyoffice-settings.json` 保留在用户数据目录中，但新版不读取它。

预览能力由 manifest 描述；`LibraryPreview` 保持向后兼容，不把 parser model、缓存标识或 adapter 运行时状态写入 DTO。adapter model 生命周期属于单次视图实例，不跨 viewer/detail/detached 隐式共享可变状态；资源缓存仅复用不可变字节副本。

### 4.2 状态流转

| 状态 | 含义 | 进入条件 | 退出条件 |
| --- | --- | --- | --- |
| `loading` | 获取字节并解析 | 选中 Office 文件 | 成功或失败 |
| `ready` | 只读内容可用 | 解析成功 | 切换文件或关闭 |
| `partial` | 内容可读但有未支持元素 | 解析返回部分内容 | 切换文件或关闭 |
| `error` | 资源或格式解析失败 | 获取/解析失败 | 重试、切换文件或打开本地应用 |

以上状态适用于所有 adapter；unsupported 是由 manifest/格式识别判定的终态，不伪装成解析错误或普通文本预览。

## 5. 错误处理

### 5.1 错误类型

- `resource_unavailable`：preview URL 不可读或失效。
- `file_too_large`：超过配置的 parser 输入预算。
- `format_invalid`：压缩包或 XML 结构无效。
- `unsupported_feature`：复杂版式、嵌入对象、公式计算等不支持。
- `local_open_failed`：系统未能打开原始文件。
- `preview_unsupported`：格式已识别但没有安全、受支持的只读 adapter。
- `preview_cancelled` / `preview_timeout`：任务被用户取消或超出 adapter 时限。

### 5.2 处理策略

1. 文件类型及大小预检后再读入内存。
2. 解析库错误只更新当前预览，不让 Promise rejection 冒泡到应用根部。
3. 允许以普通文案说明可能的版式差异；桌面环境始终提供可用的本地应用操作。
4. 所有入口将错误和取消映射到同一状态契约；旧任务不得覆盖新文件状态。
5. HTML iframe sandbox 权限按预览所需最小化；外部资源策略和本地文件访问边界需由安全测试验证。
6. 服务端 Office preview 仅提供受控资源，不注册 OnlyOffice 路由；旧配置文件不迁移、不删除。

## 6. 正确性属性

### 6.1 源文件不变

*对于任何* 成功或失败的 Office 预览，系统都只读取字节，不执行 library 写操作，源文件内容及 mtime 不因预览而改变。

**验证需求：** 需求 1.1-1.4

### 6.2 本地打开路径一致

*对于任何* 桌面 Office 预览，“使用本地应用打开”传给 `open_path` 的路径与当前库绑定 root + 相对路径的规范结果一致。

**验证需求：** 需求 2.1-2.3

### 6.3 不依赖 OnlyOffice

*对于任何* 默认运行模式，Office 预览不得请求 OnlyOffice api.js、settings/status API 或 callback API。

**验证需求：** 需求 3.1-3.3

## 7. 测试策略

### 7.1 单元测试

- Office 格式 fixture、PDF 页绘制、资源限制、损坏文件错误、XLSX 多工作表和边界网格。
- Office preview 组件在 ready/partial/error 与 open-path 成功/失败状态下的行为。
- 格式 manifest 条目、Server/Rust 类型映射、索引/预览/编辑能力分离和 unsupported 分类的契约测试。
- adapter 契约测试：取消、超时、资源超限、partial、dispose 幂等和不提交过期结果。
- 主查看器、详情面板和 detached 使用同一 adapter/renderer 路由的集成测试。
- XLSX 工作表切换、公式栏、选区、复制、未支持内容提示和取消。
- PDF 连续页面懒加载、缩放、页码定位、取消和页面资源清理。
- 文本/代码大文件、搜索、复制、切换文件和错误回退。

### 7.2 集成测试

- native/HTTP preview DTO 提供 office resource 且没有 OnlyOffice payload。
- Fastify full 与 sidecar-only profile 均不注册 `/api/office/onlyoffice/*`。
- 设置 UI 不加载、不呈现 OnlyOffice 配置。

### 7.3 回归测试

- Office 双击查看器布局和右侧详情预览。
- DOCX/XLSX/PPTX 桌面打开命令、Web/镜像无本地路径行为。
- detached 窗口仍使用同一应用 renderer，不直接展示 Office 原始文件或纯文本 Blob。
- 非 Office 图片/PDF/Markdown 预览不回归；PDF native 与 HTTP/mirror 来源均可读取。
- HTML iframe sandbox 权限、本地资源访问和外链策略。
- PDF 大文档滚动时活动 Canvas/页面资源有界，离开活动窗口后可回收。
- XLSX 安全 ZIP 检查与 SheetJS 解析是否重复解压；保留资源防护并验证优化前后解析语义。

### 7.4 验证映射

| 需求 | 设计章节 | 验证方式 |
| --- | --- | --- |
| 需求 1 | §2.3.1、§3.1、§5 | Office renderer 单元及组件测试 |
| 需求 2 | §2.3.2、§3.3.4 | Tauri invoke mock 测试 |
| 需求 3 | §3.2、§3.3.3、§4.1 | 类型、Fastify route、Rust command 和依赖检索 |
| 需求 4 | §9 | Rust converter 单元/集成测试及桌面设置回放 |
| 需求 5 | §2.3.1–§2.3.4、§4.2、§5 | 文本/Office/PDF/网格组件测试、取消/超限回归和跨 WebView 回放 |
| 需求 6 | §2.3.5–§2.3.6、§3.3.1–§3.3.2 | manifest 契约、adapter 生命周期及三入口 renderer 集成测试 |

## 8. 风险与待确认项

### 8.1 风险

- DOCX/PPTX 的复杂布局无法由轻量 renderer 忠实还原；本功能定位为快速阅读而非打印级渲染。
- 预览 URL 和本机文件路径在 local/mirror/web 模式不同，UI 必须以可用 capability 控制打开按钮。
- 删除 OnlyOffice API 属于明确的兼容破坏；本次用户已明确选择彻底替换。
- FortuneSheet 需要验证 React 版本兼容性、只读公式栏安全性、冻结窗格绘制和包体；升级依赖时可能需要保留补丁。
- LibreOffice 转 PDF 可以提升 DOCX/PPTX 版式保真度，但受字体、平台和引擎差异影响，不能保证像素级一致。

### 8.2 待确认项

- Parser 依赖和可支持上限由实现阶段根据官方文档、包体和 fixture 验证确定；若某格式无法达到最低只读预览质量，应记录限制并在 UI 提供系统打开回退。

## 9. 可选 LibreOffice 转换器（增补）

### 9.1 分发与信任边界

- 该组件是显式可选的桌面能力，不加入默认安装包，不在网页/镜像模式下载或启动。
- 运行时固定 Node.js 官方版本与 `@deepseek-ai/libreoffice-kit`、平台引擎及依赖版本；使用提交到仓库的 lockfile 锁定 npm 完整依赖图，禁止执行依赖安装脚本。
- Node 官方发行包及 npm tarball 必须由平台/版本常量选择并校验 SHA-256/SHA-512 integrity。不得接受 UI 传入 URL、版本、包名或安装路径。
- 解包只允许进入 app-data 下的专用 staging 目录；验证包内完整性后原子切换为 active，失败不触碰上一个有效版本。卸载只能清理该专用目录。
- 转换仍由 Tauri 从绑定资料库路径重新规范化并验证扩展名、文件属性和 20 MiB 限制；前端不传绝对路径。Node 子进程使用应用私有临时目录、明确超时和输出上限，转换期间全局串行，支持取消并回收子进程/临时文件。

### 9.2 格式策略

- DOCX/PPTX 在转换器安装且用户请求高保真预览时转为 PDF bytes，复用现有 PDF.js 视图组件渲染所有连续页面；PDF 缓存键包含规范路径、大小、mtime、引擎版本，缓存设容量上限并仅存派生 PDF。
- XLSX 继续由原只读表格 renderer 展示工作表与单元格，不调用 PDF 转换。
- 未安装/转换失败时保留现有轻量渲染器、本地应用打开按钮和清晰错误提示。字体及 LibreOffice 导入行为可能造成差异，不能承诺 Office 像素级一致。

### 9.3 安装状态

设置页仅在 Tauri 桌面本地模式展示管理项，状态包括 unavailable-platform、not-installed、downloading、installing、ready、error；按钮提供安装、取消、卸载，进度事件不包含私有文件路径。并发安装/转换由 Rust 状态对象限制。
