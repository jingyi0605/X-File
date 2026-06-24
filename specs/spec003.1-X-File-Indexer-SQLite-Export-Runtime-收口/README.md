# spec003.1-X-File-Indexer-SQLite-Export-Runtime-收口

这份 Spec 只解决一件事：

**把决定 `x-file-runtime` 是否还能留在正式包里的核心数据面依赖盘清并开始收口，主战场就是 `indexer / sqlite / export`。**

`spec003` 解决的是前台控制面和读链路收口；  
`spec003.1` 解决的是**真正拖着完整 Node runtime 不放的重任务链路**。

当前现实很清楚：

- Tauri 桌面壳已经开始原生接管 `watcher / health / snapshot / refresh / preview / office bridge`
- 但正式包仍然要带 `x-file-runtime`
- 真正卡住 Node runtime 的不是 preview，而是：
  - `@x-file/indexer`
  - `better-sqlite3`
  - `TextIndexer`
  - `ExportBuilder`
  - `runLibraryIndexOnce`

所以这次 Spec 的重点不是再扩前台能力，而是把这条数据面链路切成可迁移的小块：

1. 先盘清 `indexer / sqlite / export` 的真实宿主和调用链
2. 先收 orchestration 和状态推进，不一口气重写全文索引算法
3. 用最小 vertical slice 缩小 Node runtime 的必要边界

## 文档

- `requirements.md`：需求和验收标准
- `design.md`：数据面收口边界、迁移策略和本轮切片
- `tasks.md`：按阶段执行的任务清单
