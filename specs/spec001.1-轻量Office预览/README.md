# spec001.1-X-File 轻量 Office 预览

本 Spec 聚焦 Office 文件预览：移除 OnlyOffice 在线编辑器依赖，用内置轻量只读预览替代；需要编辑时由桌面端调用系统默认应用打开原文件。

## 文档

- `requirements.md`：需求与验收标准
- `design.md`：预览架构、接口和测试设计
- `tasks.md`：实施任务与验证状态
- `docs/README.md`：补充文档目录

## 范围

- DOCX、XLSX、PPTX 提供应用内只读预览。
- 桌面端保留本地应用打开和文件管理器定位能力。
- 移除 OnlyOffice 设置、前端脚本、Native bridge、HTTP 回调和相关配置/API。
- 保留 Office 文件分类、索引摘要和文档库对外预览 DTO 的稳定性。

不迁移或清理现有用户目录中的旧 OnlyOffice 配置文件。
