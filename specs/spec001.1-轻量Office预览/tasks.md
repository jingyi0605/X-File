# 任务清单 - spec001.1-X-File 轻量 Office 预览

状态：IN_PROGRESS

## 状态说明

- `TODO`：还没开始
- `IN_PROGRESS`：正在做
- `BLOCKED`：被外部问题卡住
- `DONE`：完成并验证

## 阶段 1：建立轻量只读预览

- [x] 1.1 增加懒加载的 Office 格式预览组件
  - 状态：DONE
  - 完成结果：新增 `fflate` 驱动的按需加载 DOCX/XLSX 只读解析器，并在反馈后将 PPTX 升级为 `@aiden0z/pptx-renderer` 完整幻灯片渲染；压缩文件、解压大小、ZIP 条目、工作表、页数与文字数量均有限制。
  - 这一步到底做什么：基于验证过的轻量 parser，为 DOCX、XLSX、PPTX 提供分格式只读 UI、资源上限和局部错误处理。
  - 做完你能看到什么：三类文件可从应用内阅读，XLSX 可切工作表，PPTX 可逐页查看。
  - 先依赖什么：无
  - 开始前先看：`requirements.md` 需求 1；`design.md` §2.3.1、§3.1、§5
  - 主要改哪里：`apps/web/src/features/library/`、`apps/web/package.json`、`pnpm-lock.yaml`
  - 这一步先不做什么：不做 Office 编辑、回写或版式完全还原。
  - 怎么算完成：解析器按需加载；三格式 fixture 和异常/边界测试通过。
  - 怎么验证：Office renderer 的定向 Vitest 测试和 web typecheck。
  - 对应需求：需求 1
  - 对应设计：§2.3.1、§3.1、§5、§6.1

- [x] 1.2 将预览与本地应用打开接入现有详情/查看器
  - 状态：DONE
  - 完成结果：详情和全屏查看器均接入 OfficePreview；仅桌面本地资料库且有本机路径时调用 `open_path`，失败保留预览并反馈。浏览器和镜像模式不会展示或尝试本地打开。
  - 这一步到底做什么：替换 OnlyOffice viewer 显示分支，给桌面有本地绝对路径时显示打开按钮，并报告打开失败。
  - 做完你能看到什么：详情预览和全屏查看器都可阅读 Office；桌面点击后交给系统应用。
  - 先依赖什么：1.1
  - 开始前先看：`requirements.md` 需求 1、2；`design.md` §2.3、§3.3.2
  - 主要改哪里：`apps/web/src/features/library/LibraryPage.tsx`、`apps/web/src/features/library/LibraryFileCodeViewer.tsx`、测试和全局样式。
  - 这一步先不做什么：不创建专门的编辑器或转换副本。
  - 怎么算完成：打开按钮调用 `open_path`；Web/无绝对路径时不展示不可用操作；读取失败时预览仍可恢复。
  - 怎么验证：Office 组件和 `LibraryPreviewMigration` 定向测试。
  - 对应需求：需求 1、2
  - 对应设计：§2.3.1、§2.3.2、§3.1、§3.3.2

## 阶段 2：移除 OnlyOffice 服务与设置

- [x] 2.1 统一 Office preview DTO 和服务端资源响应
  - 状态：DONE
  - 完成结果：shared DTO 不再包含 `onlyOffice`；Server full profile 为 office 文件返回签名资源 URL，集成测试验证可读取原始字节流。
  - 这一步到底做什么：移除 `onlyOffice` DTO 和 controller payload 构造；保留 `kind: office` 的文件流预览及路径安全。
  - 做完你能看到什么：HTTP/native library preview 返回稳定简洁的 Office 资源信息。
  - 先依赖什么：1.1
  - 开始前先看：`requirements.md` 需求 3；`design.md` §3.2、§3.3.1、§4.1
  - 主要改哪里：`packages/shared/src/library-types.ts`、`apps/server/src/library/`、`apps/desktop/src-tauri/src/lib.rs`
  - 这一步先不做什么：不改变普通文件、图片、PDF 的 preview resource 策略。
  - 怎么算完成：DTO 不包含 OnlyOffice payload；Server full profile 对 office 返回 resource URL。
  - 怎么验证：服务端 preview tests、Rust native preview tests。
  - 对应需求：需求 1、3
  - 对应设计：§3.2、§3.3.1、§4.1、§6.3

- [x] 2.2 移除 OnlyOffice UI、API、服务端 routes 与原生 bridge
  - 状态：DONE
  - 完成结果：移除设置 UI/API/i18n、服务端 service/controller/routes/store、Rust callback bridge 与 settings commands、Agent 工具契约；工具数量同步为 28。旧用户配置文件保留且不读取、不删除。回归测试确认旧 API 返回 404。
  - 这一步到底做什么：清理设置页和 i18n、Web API/native bridge、Fastify routes/service/store，以及 Rust commands/tiny_http callback bridge。
  - 做完你能看到什么：设置不再出现 OnlyOffice；默认服务无 OnlyOffice routes；桌面预览不启动专用端口。
  - 先依赖什么：1.2、2.1
  - 开始前先看：`requirements.md` 需求 3；`design.md` §4.1、§5
  - 主要改哪里：`apps/web/src/features/settings/`、`apps/web/src/api/`、`apps/server/src/office/`、`apps/server/src/routes/`、`apps/desktop/src-tauri/src/lib.rs`、共享类型和测试。
  - 这一步先不做什么：不删除既有用户目录的 `onlyoffice-settings.json`。
  - 怎么算完成：生产代码无 OnlyOffice 使用路径；API route 回归测试确认不存在；已有配置文件 untouched。
  - 怎么验证：Web/server 测试、`cargo check`、精确 `rg` 检索。
  - 对应需求：需求 3
  - 对应设计：§3.2、§4.1、§6.3

## 阶段 3：回归与验收

- [x] 3.1 运行跨层验证并更新 Spec
  - 状态：DONE
  - 这一步到底做什么：执行前端、服务端和 Rust 检查，核对三个格式及本地打开路径。
  - 做完你能看到什么：每条验收标准都能链接到测试或实际构建结果。
  - 先依赖什么：2.2
  - 开始前先看：`requirements.md`、`design.md`、`tasks.md`
  - 主要改哪里：本 Spec 与相关回归测试。
  - 这一步先不做什么：不启动开发服务器，不发布或提交。
  - 怎么算完成：Office 定向测试、构建和 Rust 检查通过；全量 Server 既有测试失败及工具缺失限制已记录，未验证项和已知版式限制写明。
  - 怎么验证：`pnpm --filter @x-file/web build`、相关 Vitest、`pnpm --filter @x-file/server test`、`cargo check`。
  - 对应需求：全部需求
  - 对应设计：§7、§8

### 验证记录

- 后续问题修复（2026-10-27）：DOCX 改用 `docx-preview` 页面 DOM 渲染，XLSX 改用 `@e965/xlsx` 解析工作表/共享字符串/显示格式，PDF 改为按页 PDF.js Canvas 预览；桌面 PDF 通过 `native_read_preview_resource` 读取，继续限制在绑定资料库、PDF/Office 扩展名白名单与 20 MiB。三种 parser 按需分包，原生 PDF iframe/file URL 不再使用。
- 本轮通过：Office renderer Vitest（8 项）、LibraryPreviewMigration Vitest（8 项）、独立 `vite build`、`git diff --check`；构建产物确认 DOCX/XLSX/PDF 与 PDF worker 均独立分包。
- 本轮受阻：`pnpm --filter @x-file/web typecheck`（也是 web build 中的前置步骤）被并行修改的 `LibraryTagTreeMigration.test.tsx:181,184-185` 三处 `this` 隐式 any 阻断；未修改该非预览测试文件。独立 `vite build` 已通过。
- 本轮未通过：`cargo check --lib` 报错在现有标签目录统计 `apps/desktop/src-tauri/src/lib.rs:4525`（`segment.to_owned()` 的类型不匹配），与本轮预览资源命令无关；未修改并行工作区的标签实现。
- 本轮代理：macOS 系统代理和 shell 均为 `127.0.0.1:7897`；仓库配置中没有旧端口 `127.0.0.1:7890`。
- 通过：`pnpm --filter @x-file/web typecheck`、`pnpm --filter @x-file/web build`、Office 与 LibraryPreviewMigration Vitest（14 项）、SettingsPage Vitest（13 项）、Server typecheck/build、Office 路由集成测试（2 项）、`cargo check --lib`、`cargo test --lib`（76 项）、Agent CLI/MCP 测试（8 项）。
- 未通过：全量 Server 测试有 3 项 `library-index-e2e` 增量搜索桶稳定性断言失败，失败涉及并行工作区的标签摘要/索引改动，Office 路由测试通过；本轮未改动索引实现。
- 未执行：`cargo fmt --check`，当前 Rust stable toolchain 未安装 `rustfmt` 组件。
- 已知限制：DOCX 是结构化只读视图，不保证精确分页；PPTX 使用浏览器 HTML/SVG 幻灯片渲染，复杂 Office 专有效果/动画仍可能有差异；XLSX 不计算公式，仅显示存储值。超出资源上限或损坏文件提供本地打开回退。
