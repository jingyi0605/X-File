# spec002-X-File内置文档引擎与集成插件化

这份 Spec 只解决一件事：

**把 X-File 当前随包 Node 后端改造成“主 APP + 内置文档引擎 sidecar”，并把 assistant / CLI 能力从安装包里彻底拆掉，改成运行后可安装的 Integration Plugin。**

为什么现在必须做这个：

- 当前桌面包把完整 Node runtime 和后端依赖一起塞进安装程序，体积和发布复杂度都过高。
- 文档库真正需要随 APP 交付的核心能力，其实只有索引、SQLite、watcher、export 这条本地引擎链路。
- assistant / codex / claude 不是文档库主链路，它们依赖本机 CLI、登录态和会话桥接，不应该继续强绑在安装包里。
- 如果不先把边界切干净，后续无论是压体积、稳定跨平台、还是演进插件系统，都会越做越乱。

本 Spec 不追求一次性重写所有后端，而是先完成两件关键收缩：

1. 文档库重活改为主 APP 内置 sidecar 承担，并继续作为安装包内置能力交付。
2. assistant / CLI 改成单层 Integration Plugin，可在应用运行后安装和更新，但不进入正式安装程序。

## 文档

- `requirements.md`：需求和验收标准
- `design.md`：架构、边界、插件模型和迁移设计
- `tasks.md`：按阶段执行的任务清单
- [`../../docs/20260616-X-File当前插件系统能力边界说明.md`](../../docs/20260616-X-File当前插件系统能力边界说明.md)：当前单层插件系统的能力边界基线，重点说明 assistant runtime 已迁到哪里、哪些还残留在宿主、后续扩展不能破坏哪些硬约束
