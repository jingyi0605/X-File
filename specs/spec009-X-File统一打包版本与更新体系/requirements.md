# 需求文档 - X-File 统一打包、版本与更新体系

状态：DONE

## 简介

当前 X-File 已经具备部分 Tauri updater 和 GitHub Actions 能力，但发布入口、版本同步、平台产物和更新源仍然分散。发布人员需要手工修改版本、同步多个文件、创建 tag，并且更新客户端固定访问 GitHub，导致中国大陆网络环境下的更新可靠性不足。

本 Spec 建立单一版本来源、统一发布工作流、跨平台原生 runner 构建、Tauri updater 签名校验和可配置的镜像优先更新源。

## 术语

- **版本真源**：仓库根目录 `VERSION` 文件。
- **stable 通道**：不带 prerelease 后缀的正式版本。
- **beta 通道**：带 prerelease 后缀的预发布版本。
- **更新清单**：Tauri updater 使用的 `latest.json`。
- **镜像源**：由维护者配置的国内 HTTPS CDN、对象存储或反向代理地址。
- **官方源**：GitHub Releases 对应版本和通道地址。

## 范围

### In Scope

- GitHub Actions 手动触发的一键版本发布。
- macOS universal、Windows x86_64、Linux x86_64 的原生 runner 打包。
- updater 安装包签名、更新清单签名字段和产物完整性校验。
- `VERSION` 到 package、Tauri、Cargo 和 Cargo.lock 的统一同步。
- 版本格式、tag、配置和产物版本一致性检查。
- stable/beta 双通道更新。
- 国内镜像更新源优先、官方 GitHub 源回退。
- 发布前检查、CI 校验和本地可复现命令。

### Out of Scope

- 在本次改造中购买或创建具体的国内 CDN、对象存储或域名。
- Windows Authenticode 证书申请和 SmartScreen 信任建立。
- macOS Developer ID 证书申请。
- 自动修改应用业务功能和资料库数据模型。
- 在没有凭据的情况下向第三方镜像服务上传文件。

## 需求

### 需求 1：一键跨平台打包

1. WHEN 维护者从 GitHub Actions 手动触发发布 THEN System SHALL 使用已提交的 `VERSION` 和 prerelease 状态，并自动完成三平台构建、产物校验、签名和 Release 资产上传。
2. WHEN 发布版本为 stable THEN System SHALL 生成 macOS universal DMG、Windows NSIS/MSI 和 Linux AppImage/deb/rpm 中声明的正式产物。
3. WHEN 发布版本为 beta THEN System SHALL 生成 macOS universal DMG、Windows NSIS 和 Linux AppImage/deb/rpm 中声明的预发布产物，并标记 prerelease。
4. WHEN 任一平台构建、签名或产物校验失败 THEN System SHALL 阻止发布 Release。
5. WHEN workflow 由 tag 触发 THEN System SHALL 要求 tag 版本与 `VERSION` 一致。

### 需求 2：安全产物

1. WHEN 生成 updater 产物 THEN System SHALL 使用 Tauri updater 私钥签名，并在发布前验证对应 `.sig` 文件存在。
2. WHEN 生成更新清单 THEN System SHALL 只引用实际上传的安装包和对应签名，并校验平台、版本和 URL 完整。
3. WHEN 发布流程启用正式模式 THEN System SHALL 检查 updater 私钥、公钥和签名配置一致。
4. WHEN 发布流程处理 secrets THEN System SHALL 不把私钥、密码或证书写入日志、产物清单或普通仓库文件。

### 需求 3：版本检查与更新

1. WHEN 修改产品版本 THEN System SHALL 只要求维护者修改 `VERSION` 或通过统一版本命令修改，并能同步所有受管理文件。
2. WHEN 执行版本检查 THEN System SHALL 检查 SemVer、package、Tauri、Cargo、Cargo.lock 和 tag 一致性。
3. WHEN 客户端检查更新 THEN System SHALL 按 stable/beta 通道解析版本，并显示当前版本、最新版本、发布时间、更新说明和下载状态。
4. WHEN 客户端下载更新 THEN System SHALL 使用签名校验后的 updater 产物，并支持进度、失败提示和安装重启。
5. WHEN 客户端更新地址不可用 THEN System SHALL 尝试下一个配置的更新源，并给出可诊断的网络错误。

### 需求 4：中国大陆网络兼容

1. WHEN 客户端在中国大陆网络环境运行 THEN System SHALL 支持配置国内 HTTPS 镜像作为首选更新源。
2. WHEN 国内镜像不可用 THEN System SHALL 保留官方 GitHub 更新源作为回退，不降低签名校验要求。
3. WHEN 发布新版本 THEN System SHALL 生成可直接同步到镜像源的清单和安装包资产。
4. WHEN 镜像配置为空 THEN System SHALL 回退到官方源，现有安装包仍能检查更新。
5. WHEN 更新源配置改变 THEN System SHALL 只改变清单和下载地址，不改变 updater 公钥和签名策略。

## 成功定义

- 维护者通过一次手动 workflow dispatch 可以得到三平台正式产物和 Release 资产。
- 版本不一致、缺少签名、缺少平台产物或清单引用不存在的文件时，发布被阻断。
- stable 和 beta 客户端都能检查、下载并安装签名更新。
- 国内镜像配置存在时，客户端优先使用镜像；镜像失败时自动回退官方源。
- 本地维护者可以用统一命令设置、同步和验证版本。

