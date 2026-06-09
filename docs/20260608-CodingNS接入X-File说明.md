# 20260608-CodingNS接入X-File说明

这份说明给 CodingNS 后续接入 X-File 用。第一版只承诺本机 HTTP API，不承诺公网访问、远程认证、自动更新和签名。

## 服务地址

X-File HTTP 服务默认监听：

```text
http://127.0.0.1:17321
```

第一版只允许绑定 `127.0.0.1`。这是故意的，文档库是本机文件服务，不能随手暴露到公网网卡。

## 健康检查

```text
GET /api/health
```

返回：

```json
{
  "ok": true,
  "app": "X-File",
  "version": "0.1.0"
}
```

CodingNS 可以用这个接口判断 X-File 后端是否正在运行。

## 集成状态

```text
GET /api/integration/status
```

返回 X-File 是否可用、HTTP 服务状态和文档库快照摘要。重点字段：

- `ok`：X-File 集成入口是否响应。
- `httpServer.enabled`：用户是否启用本机 HTTP 服务。
- `httpServer.running`：当前 HTTP 服务是否运行。
- `httpServer.host` / `httpServer.port`：监听地址和端口。
- `library.available`：是否已经绑定并启用文档库。
- `library.rootDir`：当前资料库根目录。
- `library.indexState`：索引状态，例如 `fresh`、`stale`、`queued`、`running`、`failed`。
- `library.documentCount`：当前快照里的文档数量。
- `library.lastError`：最近错误摘要。

如果 X-File 没启动，CodingNS 会收到连接失败。调用方应该提示用户启动 X-File，而不是自己恢复 CodingNS 的重扫描任务。

## HTTP 服务状态

读取状态：

```text
GET /api/server/state
```

保存配置：

```text
PUT /api/server/state
```

请求体示例：

```json
{
  "enabled": true,
  "host": "127.0.0.1",
  "port": 17321,
  "persistent": true
}
```

第一版保存的是用户配置和运行态摘要，不在保存配置时主动拉起长期 dev server。

## 常驻后端策略

```text
GET /api/server/state
```

规则很简单：

- `persistent=true` 且 HTTP 服务启用时，`persistentPolicy.keepBackendOnWindowClose=true`。
- 用户明确退出应用时，必须停止 HTTP 服务。
- 第一版 Tauri 侧提供可读策略，并实现关闭窗口隐藏主窗口、系统托盘菜单和后端子进程托管入口。
- `persistentPolicy.implementedByDesktopShell=true` 表示桌面壳会处理关闭窗口常驻；开机自启、真实签名安装包和 Windows 实机构建仍需后续验证。

## 稳定 API

CodingNS 后续优先依赖这些路径：

- `GET /api/health`
- `GET /api/integration/status`
- `GET /api/server/state`
- `GET /api/library/snapshot`
- `GET /api/library/documents`
- `GET /api/library/files`
- `GET /api/library/preview`
- `GET /api/library/download`

不要依赖内部存储文件路径，也不要调用 X-File 的开发脚本来判断服务状态。
