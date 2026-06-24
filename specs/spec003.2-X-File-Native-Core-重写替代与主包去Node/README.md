# spec003.2-X-File-Native-Core-重写替代与主包去Node

这份 Spec 只解决一件事：

**停止继续给旧 Node 数据面做过渡兼容层修补，改为直接重写 Native Core，在保持前端样式与对外契约不变的前提下，让 X-File 主包彻底具备去掉 Node runtime 的条件。**

`spec003` 解决的是前台控制面和 native bridge 起步。  
`spec003.1` 解决的是 `indexer / sqlite / export / runtime` 的渐进收口。  
`spec003.2` 的目标更直接：

1. 不再把“继续拆旧 Node 壳”当主路线
2. 直接定义并实现新的 Rust Native Core
3. 只保留对外契约，不保留旧 Node 内部执行结构
4. 最终让正式包可以删除：
   - `x-file-runtime`
   - `x-file-server`
   - `x-file-library-engine` 兼容壳

## 文档

- `requirements.md`：必须保留的对外契约与验收标准
- `design.md`：Native Core 重写边界、模块设计和迁移策略
- `tasks.md`：四阶段执行清单，按“能删掉什么 Node”来组织

## 本 Spec 的硬约束

- 不改变前端样式体系
- 不改变现有前端页面视觉与组件结构
- 不破坏现有导出产物契约
- 不破坏现有本地 bridge / local 模式返回 shape
- 只重写底层执行内核，不重做 UI
