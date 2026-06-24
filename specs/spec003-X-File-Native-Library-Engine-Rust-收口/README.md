# spec003-X-File-Native-Library-Engine-Rust-收口

这份 Spec 只解决一件事：

**继续把 X-File 内置文档引擎从“Node sidecar 托管”收口到“native sidecar / Rust / Tauri commands 控制面”，优先砍掉正式包里完整 Node runtime 这一刀。**

这次不允许回头把 assistant、CLI 或通用后端重新塞回主包。

当前现实很清楚：

- `x-file-server` 已经从正式包移除。
- 正式 Tauri resources 现在只剩 `x-file-library-engine` 和 `x-file-runtime`。
- 其中最肥的一块是 `x-file-runtime`，约 `105M`，本质上是完整 Node runtime。

所以这次 Spec 的重点不是写漂亮架构图，而是继续收口运行边界：

1. 把适合先收口的控制面能力迁到 Rust / Tauri commands。
2. 保持文档库核心仍是内置能力，不破坏现有 Integration Plugin 边界。
3. 就算一轮还不能完全删掉 Node，也必须把下一刀最值钱的 native vertical slice 真正落代码。

## 文档

- `requirements.md`：需求和验收标准
- `design.md`：迁移边界、阶段策略和本轮切片
- `tasks.md`：按阶段执行的任务清单
