# X-File 桌面壳

这个目录是 X-File 第一版 Tauri 2 桌面壳。它能做 TypeScript build 和 `cargo check`，也能作为后续安装包入口；第一版已实现系统托盘菜单、关闭窗口隐藏主窗口、Tauri updater 插件接入、updater 签名配置和后端子进程托管入口。真实自动更新和 Windows 实机构建还需要外部 secrets 与 runner 验证。

## 启动关系

1. Node Fastify 后端监听 `127.0.0.1:17321`，提供 `/api/*`。
2. React 前端开发服务监听 `127.0.0.1:17320`。
3. Tauri 2 窗口加载前端页面，前端调用本机后端 API。
4. 第一版 `dev` 脚本会拉起后端开发进程，并提示另开终端启动前端。
5. Tauri 启动时会按 `X_FILE_BACKEND_AUTOSTART` 自动托管后端子进程，默认命令是 `node`，优先使用打包资源里的 `x-file-server/main.js`。
6. `persistent=true` 时桌面壳会拦截关闭窗口并隐藏主窗口，进程继续保留；托盘菜单可以显示/隐藏窗口、开启/关闭常驻、启动/停止内置后端和退出应用。

## 开发启动

```bash
pnpm --filter @x-file/desktop dev
```

这个脚本只负责开发期后端进程，前端仍需另开终端：

```bash
pnpm --filter @x-file/web dev
```

如果要打开 Tauri 窗口：

```bash
pnpm --filter @x-file/desktop tauri:dev
```

## 构建校验

```bash
pnpm --filter @x-file/desktop build
```

这个命令会执行：

- `tsc -p tsconfig.json`
- `cargo check --manifest-path src-tauri/Cargo.toml`

## 打包边界

- macOS 正式打包入口是 `pnpm --filter @x-file/desktop tauri:build`。
- Windows MSI 必须在 Windows runner 上执行 `pnpm --filter @x-file/desktop tauri:build`。
- `pnpm --filter @x-file/desktop release:check` 会检查 Tauri updater 配置结构。
- 真实发布前必须执行 `node ../../scripts/check-desktop-release-secrets.mjs --platform windows --require-real-secrets`，并配置真实 updater 私钥、公钥和更新地址。Windows 代码签名证书是可选项，不影响 Tauri updater 正常验签更新。
- 当前已接入自动更新插件和 updater 签名配置，不声称已经完成真实自动更新、安装包代码签名或 Windows 实机构建验证。
- 后端托管入口仍依赖可执行的 Node 运行时；发布包必须携带 Node runtime，或者后续改成真正的 Tauri sidecar。
