# 需求文档 - spec001.1-X-File 轻量 Office 预览

状态：Draft

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

### Out of Scope

- Office 文件在 X-File 内编辑、协作编辑或格式写回。
- 精确复刻 Microsoft Office 的分页、字体、动画、公式计算或打印布局。
- `.doc`、`.xls`、`.ppt` 等旧二进制格式的结构化预览。
- 自动删除用户数据目录中的既有 OnlyOffice 设置文件。

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

## 非功能需求

### 非功能需求 1：性能

1. Office 预览解析 SHALL 在前端按需加载，避免把解析器加入初始页面关键路径。
2. 解析须限制文件体积、幻灯片/工作表数量、行列数量和文本量，避免异常文件耗尽内存。

### 非功能需求 2：可靠性

1. 解析错误 SHALL 局限于当前文件，不影响文档库列表、后续预览或桌面打开。
2. 所有预览仅操作文件副本/读取结果，不修改源 Office 文件。

### 非功能需求 3：可维护性

1. Office 渲染器 SHALL 与 `LibraryPage` 和通用代码查看器解耦，并按格式分派。
2. 若目标格式库无法满足预览所需的版式或体积约束， SHALL 使用明确限制的轻量渲染器，而不以 OnlyOffice 作为隐式回退。

## 成功定义

- DOCX、XLSX、PPTX 在不配置外部服务的情况下可在应用内查看。
- 桌面预览提供打开本地应用入口，调用现有 Tauri 命令。
- 主包和默认服务模式不再包含 OnlyOffice 的 UI/API/HTTP 回调/Rust bridge。
- `pnpm --filter @x-file/web build`、相关前端测试、服务端测试和 Rust 检查通过。
