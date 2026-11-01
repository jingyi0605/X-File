# 任务清单 - X-File 统一打包、版本与更新体系

状态：DONE

## 阶段 1：版本管理

- [x] 1.1 增加统一版本命令
  - `version:set`、`version:sync`、`version:check`
  - 覆盖 package、Tauri、Cargo 和 Cargo.lock
  - 支持 tag 一致性检查

- [x] 1.2 增加版本管理测试
  - 覆盖合法/非法 SemVer
  - 覆盖文件不一致和 prerelease 通道

## 阶段 2：本地打包和校验

- [x] 2.1 收口三平台打包入口
  - macOS universal
  - Windows NSIS/MSI
  - Linux AppImage/deb/rpm

- [x] 2.2 增强桌面产物验证
  - 平台产物完整性
  - updater `.sig`
  - 版本、通道和清单引用一致

## 阶段 3：GitHub 一键发布

- [x] 3.1 改造发布 workflow_dispatch
  - 输入来源 ref 和是否发布
  - 使用已提交版本创建或更新 tag/Release

- [x] 3.2 增加 Linux job 和跨平台聚合
  - 三平台原生 runner
  - stable/beta 产物规则
  - Release 只在所有平台成功后创建

- [x] 3.3 生成可镜像的发布资产
  - latest.json
  - latest-cn.json
  - release-manifest.json
  - 安装包、签名和版本校验报告

## 阶段 4：更新客户端和大陆网络兼容

- [x] 4.1 支持构建时注入国内优先 endpoint
  - stable/beta 分开配置
  - 官方 GitHub fallback

- [x] 4.2 完善更新面板和错误提示
  - 去掉待接入状态
  - 应用启动后延迟后台检查，六小时内按通道去重
  - 发现更新时显示可关闭的全局提示，并直达更新面板
  - 打开更新面板后自动执行一次手动检查
  - 保留 updater 错误明细，便于定位镜像和官方源均不可用的情况
  - 保留签名更新和重启流程

- [x] 4.3 增加更新相关测试和文档
  - endpoint 顺序
  - 清单字段
  - 国内镜像同步约定

## 最终检查

- [x] 5.1 全仓 typecheck/build/test
  - 已通过 root typecheck、Web build、desktop build、版本单测和 updater 单测；本次未运行全量 Web Vitest，未启动开发服务器。
- [x] 5.2 本地版本和桌面 preflight
- [x] 5.3 更新 Spec 状态和剩余外部配置
  - 剩余外部配置：GitHub release environment secrets、可选国内镜像 Variables、macOS/Windows 平台证书。

