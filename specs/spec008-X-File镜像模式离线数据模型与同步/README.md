# Spec 008 - X-File 镜像模式离线数据模型与同步

本 Spec 解决 mirror 端依赖主端服务才能工作的架构问题，目标是让 mirror 端持有可恢复的 X-File 数据模型，并把标签修改排队到主端合并。

- `requirements.md`：需求、验收标准和范围
- `design.md`：数据模型、接口、状态和测试策略
- `tasks.md`：按阶段执行的实现清单
