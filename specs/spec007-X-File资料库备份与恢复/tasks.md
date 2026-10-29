# 任务清单：资料库备份与恢复

状态说明：`TODO` 未开始，`IN_PROGRESS` 正在执行，`DONE` 已验证完成。

## 阶段 1：数据契约与目录指纹

- [x] 1.1 确认主执行路径、标签/收藏存储和索引快照边界
  - 状态：DONE
  - 结果：正式桌面主路径在 Rust Native Core；标签与收藏在用户数据存储；索引 catalog 和 runtime 快照位于资料库 `.ai-index`。文件内容不属于备份。
- [x] 1.2 定义并测试版本化备份 DTO 与浅层目录指纹
  - 状态：DONE
  - 验收：比较根目录名称和深度 1、2 的相对目录集合；忽略生成状态目录、不跟随符号链接。
  - 结果：共享/Native/HTTP 使用版本 1 契约；浅层指纹比较根目录名和两层目录；文件名/内容不比较。
  - 验证：HTTP 单测覆盖内部目录排除、深度、文件改动接受及目录改动拒绝；Native 单测覆盖符号链接和目录差异。

## 阶段 2：原生/服务端导入导出

- [x] 2.1 实现 Native Core 导出、校验、恢复及刷新调度
  - 状态：DONE
  - 验收：不匹配/无效输入不写数据；成功 remap 当前 binding 并安排全量刷新。
  - 结果：Native 备份保留快照、标签、收藏，导入时重映射当前资料库；全量扫描后按已恢复规则重算标签。
  - 验证：`cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml --lib` 通过；Native 4 项定向单测通过。
- [x] 2.2 接入兼容 HTTP service 和 routes
  - 状态：DONE
  - 验收：备份契约和 Native 一致，路由测试覆盖成功与目录不匹配。
  - 结果：提供 `/api/library/backup` GET/POST；检查失败在任何写入前返回，成功请求索引刷新并由任务回调重算标签。
  - 验证：Server typecheck 和 4 项备份/路由测试通过。

## 阶段 3：前端与最终验收

- [x] 3.1 资料库设置导入/导出 UI 与中英文文案
  - 状态：DONE
  - 验收：本地桌面模式可操作；镜像/非桌面隐藏；复用全局组件和类名。
  - 结果：设置页提供 JSON 下载/选择导入、基于 DesktopModal 的覆盖确认、错误反馈；只在本地桌面模式显示。
  - 验证：SettingsPage 15 项测试通过，含导出、确认/取消导入和镜像模式隐藏。
- [x] 3.2 定向测试、类型检查、构建和工作区复核
  - 状态：DONE
  - 验收：记录实际命令结果，不启动服务，保留本次以外工作区修改。
  - 结果：导入成功后队列全量索引；索引完成时复用标签重算任务。旧机器的运行状态不导入。
  - 验证：Server typecheck 与 4 项测试通过；Web typecheck 与 SettingsPage 15 项测试通过；Web production build 通过；Rust cargo check 与 4 项 Native 备份测试通过；`git diff --check` 通过。未启动服务。
  - 已知提示：Web build 保留现有 Tauri 动态导入与大 chunk 警告。
