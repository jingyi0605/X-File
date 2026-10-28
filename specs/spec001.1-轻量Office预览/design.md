# 设计文档 - spec001.1-X-File 轻量 Office 预览

状态：Draft

## 1. 概述

### 1.1 目标

- 用按需加载的轻量只读预览器覆盖 DOCX、XLSX、PPTX，并用 PDF.js 绘制 PDF 页面以适配桌面 WebView。
- 保留原始文件不变，并复用已有桌面默认应用打开能力承担编辑。
- 移除 OnlyOffice 远程脚本、设置、服务端协调和原生回调桥。

### 1.2 覆盖需求

- `requirements.md` 需求 1：轻量 Office 只读预览
- `requirements.md` 需求 2：本地应用打开
- `requirements.md` 需求 3：移除 OnlyOffice 运行链路

### 1.3 技术约束

- 桌面端：Tauri 2 + Rust；使用已注册 `open_path` 命令。
- 前端：React + TypeScript；全局视觉沿用 `apps/web/src/styles.css` 现有 token/class。
- 服务端：Fastify 兼容路径保留 library preview 的 `kind: office` 基础 DTO，不再构造编辑器 payload。
- 依赖：Office parser 仅前端按需加载；选择可在浏览器运行且支持格式需求的库，不引入完整办公套件。

## 2. 架构

### 2.1 系统结构

```text
LibraryPage / 详情预览
  -> LibraryPreview(kind=office, file path, preview resource)
  -> 按扩展名动态加载 DOCX / XLSX / PPTX / PDF renderer
  -> 安全的只读页面 DOM / 表格 / 幻灯片 / PDF Canvas 视图
  -> 桌面“使用本地应用打开” -> 现有 open_path -> OS 文件关联
```

预览资源来自服务端受控预览 URL，或 Tauri 绑定资料库内受限的原生字节读取命令。PDF 由 PDF.js 绘制当前页，不依赖桌面 WebView 原生 PDF iframe/file URL。远端/镜像通过当前 preview URL 读取；本地应用打开只在桌面且有绝对本机路径时启用。

### 2.2 模块职责

| 模块 | 职责 | 输入 | 输出 |
| --- | --- | --- | --- |
| `OfficePreview` | 按扩展名懒加载并隔离错误 | URL、文件名、打开本地应用回调 | 只读预览界面 |
| `office renderers` | 解析各格式允许展示的内容 | `ArrayBuffer` | 只读页面 DOM / 网格 / 幻灯片 |
| `LibraryPdfPreview` | 按页绘制 PDF 并导航 | PDF bytes | 当前页 Canvas |
| `LibraryPage` | 提供受控预览 URL 与桌面原路径 | `LibraryPreview`、路径 | viewer/详情渲染 |
| `open_path` | 调用操作系统文件关联 | 规范化的绝对路径 | 系统应用打开原文件 |
| library HTTP API | 返回 office/PDF kind 和可访问预览资源 | path query | LibraryPreview DTO |

### 2.3 关键流程

#### 2.3.1 打开 Office 预览

1. 前端读取 library preview；native 路径不再调用 OnlyOffice preview bridge。
2. 预览组件按 `.docx`、`.xlsx`、`.pptx`、`.pdf` 选择动态渲染模块。
3. 对资源 URL 获取二进制内容，在工作线程能力可用时不阻塞交互；显示 loading 状态。
4. 将文本、表格和幻灯片映射为只读安全 UI，并施加解析上限。
5. 失败时展示格式/文件提示以及桌面“使用本地应用打开”操作。

#### 2.3.2 编辑 Office 文件

1. 用户点击“使用本地应用打开”。
2. Web 侧确认 runtime 是 Tauri 且 `absoluteFilePath` 存在。
3. 调用 `open_path`，操作系统负责选择应用。
4. 不在 X-File 中保存 Office 内容，也不启用回调写回。

## 3. 组件和接口

### 3.1 核心组件

- `OfficePreview`：统一预览边界、加载和错误状态。
- `DocxPreview`：提取段落/标题/列表/表格的只读表示。
- `XlsxPreview`：工作表切换与有界网格展示。
- `PptxPreview`：按幻灯片顺序显示文本块与简单结构。
- `LibraryFileViewerSurface` / `LibraryDetailPreview`：传入 preview URL 和可选桌面打开回调。

### 3.2 数据结构

复用 `LibraryPreview`：`kind: "office"`、`path`、`supported`、`reason`、`size`、`updatedAt`、`previewUrl` 和 `capabilities`。移除 `onlyOffice` 字段，避免线上编辑配置进入通用文档 DTO。桌面打开回调为可选 UI capability，不进持久数据。

### 3.3 接口契约

#### 3.3.1 Office 预览资源

- 类型：HTTP resource / native file URL
- 路径或标识：现有 library `previewUrl`
- 输入：library 相对路径
- 输出：原始 Office 文件字节流；不得返回 editor config 或 callback 地址
- 校验：继续使用现有资料库根目录约束和受控链接 token
- 错误：沿用 library preview 现有错误格式

#### 3.3.2 桌面本地应用打开

- 类型：Tauri command
- 路径或标识：`open_path`
- 输入：目标文件绝对路径
- 输出：打开命令启动结果
- 校验：由现有 native command 拒绝空路径；前端仅从已解析的当前预览文件构造路径
- 错误：现有 `open_path` 错误传给预览状态反馈

## 4. 数据与状态模型

### 4.1 数据关系

Office 预览 DTO 只描述文件与预览资源；解析后的展示结构仅作为当前组件状态，不写入配置和源文件。旧 `onlyoffice-settings.json` 保留在用户数据目录中，但新版不读取它。

### 4.2 状态流转

| 状态 | 含义 | 进入条件 | 退出条件 |
| --- | --- | --- | --- |
| `loading` | 获取字节并解析 | 选中 Office 文件 | 成功或失败 |
| `ready` | 只读内容可用 | 解析成功 | 切换文件或关闭 |
| `partial` | 内容可读但有未支持元素 | 解析返回部分内容 | 切换文件或关闭 |
| `error` | 资源或格式解析失败 | 获取/解析失败 | 重试、切换文件或打开本地应用 |

## 5. 错误处理

### 5.1 错误类型

- `resource_unavailable`：preview URL 不可读或失效。
- `file_too_large`：超过配置的 parser 输入预算。
- `format_invalid`：压缩包或 XML 结构无效。
- `unsupported_feature`：复杂版式、嵌入对象、公式计算等不支持。
- `local_open_failed`：系统未能打开原始文件。

### 5.2 处理策略

1. 文件类型及大小预检后再读入内存。
2. 解析库错误只更新当前预览，不让 Promise rejection 冒泡到应用根部。
3. 允许以普通文案说明可能的版式差异；桌面环境始终提供可用的本地应用操作。
4. 服务端 Office preview 仅提供资源，不注册 OnlyOffice 路由；旧配置文件不迁移、不删除。

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

### 7.2 集成测试

- native/HTTP preview DTO 提供 office resource 且没有 OnlyOffice payload。
- Fastify full 与 sidecar-only profile 均不注册 `/api/office/onlyoffice/*`。
- 设置 UI 不加载、不呈现 OnlyOffice 配置。

### 7.3 回归测试

- Office 双击查看器布局和右侧详情预览。
- DOCX/XLSX/PPTX 桌面打开命令、Web/镜像无本地路径行为。
- 非 Office 图片/PDF/Markdown 预览不回归；PDF native 与 HTTP/mirror 来源均可读取。

### 7.4 验证映射

| 需求 | 设计章节 | 验证方式 |
| --- | --- | --- |
| 需求 1 | §2.3.1、§3.1、§5 | Office renderer 单元及组件测试 |
| 需求 2 | §2.3.2、§3.3.2 | Tauri invoke mock 测试 |
| 需求 3 | §3.2、§3.3.1、§4.1 | 类型、Fastify route、Rust command 和依赖检索 |

## 8. 风险与待确认项

### 8.1 风险

- DOCX/PPTX 的复杂布局无法由轻量 renderer 忠实还原；本功能定位为快速阅读而非打印级渲染。
- 预览 URL 和本机文件路径在 local/mirror/web 模式不同，UI 必须以可用 capability 控制打开按钮。
- 删除 OnlyOffice API 属于明确的兼容破坏；本次用户已明确选择彻底替换。

### 8.2 待确认项

- Parser 依赖和可支持上限由实现阶段根据官方文档、包体和 fixture 验证确定；若某格式无法达到最低只读预览质量，应记录限制并在 UI 提供系统打开回退。
