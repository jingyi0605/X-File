# X-File Specs

这里记录 X-File 的产品和工程规格。

## 当前 Spec

- `spec004-X-File移除内置助手与外部Agent接入`
  - 移除内置 AI / 文件助手及专用运行时和打包资源。
  - 后续通过 MCP、CLI 与 SKILL 为外部 Agent 提供工具，本轮不实现完整外部工具。

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
