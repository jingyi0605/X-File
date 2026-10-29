# X-File Specs

这里记录 X-File 的产品和工程规格。

## 当前 Spec

- `spec007-X-File资料库备份与恢复`
  - 导出/导入资料库标签配置、收藏和索引快照；导入前校验根目录名及两层以内的目录结构，允许文件变更并在恢复后重建索引。

- `spec004.1-X-File外部Agent平台与远程MCP`
  - 在保留本机 CLI 与 MCP stdio 的基础上，完善 Agent 访问策略、组合检索、批量标签和任务反馈，并通过现有 HTTP 服务提供远程 MCP。
  - 不包含内置模型、聊天界面、OAuth、多租户、向量搜索或任意系统命令执行。

- `spec006-子标签互斥与单选管理`
  - 为父标签增加子标签多选/单选模式；统一约束手工标签、文件夹绑定与智能规则的有效标签，并兼容既有数据。

- `spec004-X-File移除内置助手与外部Agent接入`
  - 移除内置 AI / 文件助手及专用运行时和打包资源。
  - 提供 31 项原生共享工具，覆盖 CLI、MCP stdio 与可分发/内嵌 SKILL；扩展方案与验收继续记录在本 Spec。
  - 设置支持接入开关、API Key 管理、推荐配置和 SKILL 安装指引；本机 CLI/MCP 强制校验。

- `spec002-X-File内置文档引擎与集成插件化`
  - 把 X-File 的文档库重任务收进内置 sidecar，同时把 assistant / CLI 改成可选 Integration Plugin。
  - 目标是主 APP + 内置文档引擎 + 单层插件模型，不再把非核心运行时打进正式安装包。
  - 历史插件边界见 [`../docs/20260616-X-File当前插件系统能力边界说明.md`](../docs/20260616-X-File当前插件系统能力边界说明.md)；内置助手及专用插件链路由 spec004 移除。

- `spec003-X-File-Native-Library-Engine-Rust-收口`
  - 开始把桌面文档库控制面与读链路 native 化。

- `spec003.1-X-File-Indexer-SQLite-Export-Runtime-收口`
  - 围绕 `indexer / sqlite / export / runtime` 渐进收口，持续压缩 `x-file-runtime` 的必要边界。

- `spec003.2-X-File-Native-Core-重写替代与主包去Node`
  - 停止继续修补旧 Node 数据面兼容壳，改为直接重写 Rust Native Core，在保持前端样式和对外契约不变的前提下，让主包彻底具备去 Node 条件。
