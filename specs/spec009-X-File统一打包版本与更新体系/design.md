# 设计文档 - X-File 统一打包、版本与更新体系

## 1. 总体架构

发布链路由三个层次组成：

1. `VERSION` 和 `scripts/version.mjs` 管理版本生命周期。
2. `scripts/package-desktop.sh` 和 `scripts/package-all-platforms.sh` 负责本地可复现打包。
3. `.github/workflows/desktop-release.yml` 负责原生 runner 构建、聚合、签名校验、Release 发布和更新清单生成。

GitHub Actions 使用 macOS、Windows、Linux 三个原生 runner。平台 job 只上传经过校验的 artifact，publish job 在所有平台成功后生成 Release。

## 2. 版本模型

`VERSION` 是唯一真源，接受：

```text
MAJOR.MINOR.PATCH
MAJOR.MINOR.PATCH-prerelease
```

统一命令：

```bash
pnpm version:set -- 0.2.0-beta.1
pnpm version:sync
pnpm version:check
```

`version:set` 只写入 `VERSION` 并执行同步；`version:sync` 保留为幂等同步命令；`version:check` 检查所有受管理文件和可选 tag。

发布时：

- stable：tag 为 `v0.2.0`，Release 为正式版。
- beta：tag 为 `v0.2.0-beta.1`，Release 为 prerelease，并更新 `beta-latest` 清单指针。

手动 workflow dispatch 使用已提交版本，接收构建来源 `ref` 和是否创建 Release；发布 tag 触发仍然支持从已提交版本重复发布或重跑。版本变更通过 `version:set` 提交后再触发发布，避免 CI 在没有人工审核的情况下修改主分支。

## 3. 平台产物

| 平台 | runner | 安装包 | updater 产物 |
| --- | --- | --- | --- |
| macOS | `macos-latest` | universal DMG | `.app.tar.gz` + `.sig` |
| Windows | `windows-latest` | NSIS；stable 额外 MSI | NSIS `.exe` + `.sig` |
| Linux | `ubuntu-latest` | AppImage、deb、rpm | AppImage + `.sig` |

Linux 产物用于下载和人工安装；自动更新优先使用 AppImage updater 产物。更新清单会显式列出 macOS universal、Windows x86_64 和 Linux x86_64。

## 4. 更新源

更新源以完整清单 URL 表达，避免在客户端拼接不一致的路径：

- stable 官方源：GitHub `releases/latest/download/latest.json`
- beta 官方源：GitHub `releases/download/beta-latest/latest.json`
- stable/beta 国内源：通过构建时环境变量注入完整 HTTPS URL

客户端运行时为每个通道建立有序 endpoint 列表：

1. 国内源（如果构建时配置）。
2. 官方 GitHub 源。

所有源返回相同的 Tauri updater 清单格式。清单中的下载 URL 可以指向国内 CDN 或官方 Release；无论 URL 来源如何，安装前仍由 Tauri 使用内置公钥验签。

发布 job 同时输出 `latest.json`、`latest-cn.json` 和 `release-manifest.json` 到聚合资产目录。`latest.json` 使用 GitHub 官方资产 URL，`latest-cn.json` 使用国内资产基础地址生成；镜像服务同步国内清单、安装包和 `.sig` 文件即可，不需要修改清单内容。

## 5. 安全边界

- updater 私钥只存在于 GitHub environment secret。
- updater 公钥进入应用配置，并由 `version:check` 和发布前检查校验。
- 任何 endpoint 必须使用 HTTPS。
- 清单只能引用构建 job 上传的文件。
- 发布 job 在所有平台 artifact 齐全且签名文件存在后才上传 Release。
- 镜像是传输路径，不是信任根；公钥和签名校验保持不变。

## 6. 失败和回退

- 版本不合法或文件不一致：在版本检查阶段失败。
- 平台构建失败：publish job 不运行。
- 国内源请求失败：Tauri updater 尝试官方源。
- 所有源请求失败：前端显示更新检查失败，并保留查看发布页入口。
- 清单缺少某个平台或签名：发布 job 失败，不生成可用 Release 指针。

## 7. 验证策略

- Node 单元测试验证 SemVer、版本同步目标、tag 校验和清单生成。
- `pnpm version:check` 验证当前工作区。
- `pnpm verify:desktop -- --mode preflight` 验证 updater 配置和资源边界。
- 各原生 runner 执行平台产物检查。
- Rust `cargo check --locked` 验证 updater endpoint 代码。
- Web typecheck/build 验证更新面板和本地化文案。

