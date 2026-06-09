# spec001-X-File文档库独立应用

这份 Spec 只解决一件事：

**把 CodingNS 当前文档库完整迁到 X-File，做成一个独立安装的桌面应用，同时保留 HTTP 服务能力。**

为什么先做这个：

- 文档库是高频、高 IO、高索引负载模块，继续留在 CodingNS 会拖慢代码模式和工作台。
- 文档库本身和代码工作区、Git、Terminal、代码会话没有天然绑定。
- 拆成独立应用后，CodingNS 可以停用本地文档库重任务，只通过外部入口或 HTTP API 调用 X-File。

本 Spec 第一阶段不追求重新设计产品，而是先复刻当前已验证的文档库体验和后端链路。

## 文档

- `requirements.md`：需求和验收标准
- `design.md`：架构、模块、接口和状态设计
- `tasks.md`：按阶段执行的任务清单
- `docs/20260608-当前CodingNS文档库迁移清单.md`：从 CodingNS 迁出的代码与能力边界
