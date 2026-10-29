# Spec004.1：外部 Agent 平台与远程 MCP

状态：核心范围完成；Server 全量测试有 5 项非 Agent 失败，详见 tasks.md

本 Spec 只服务于外部 Agent 接入 X-File。X-File 不增加内置模型、聊天界面、会话运行时或供应商插件。

本阶段在已有本机 CLI 与 MCP stdio 的基础上，完善外部 Agent 的接入管理、组合检索、批量标签和任务反馈，并增加远程 MCP HTTP 服务。

- [需求](requirements.md)
- [设计](design.md)
- [任务](tasks.md)
- [补充文档](docs/README.md)

## 范围

### 本阶段包含

- API Key 和 Agent 访问策略的服务端强制执行。
- CLI、MCP stdio 和远程 MCP HTTP 共用工具目录、Schema、结果和错误契约。
- 资料库内多条件组合检索。
- 面向搜索结果集的批量标签操作。
- 批量操作的 dry-run、任务状态和结构化结果。
- 设置页、SKILL、README 和远程接入示例同步更新。

### 本阶段不包含

- X-File 内置模型、聊天窗口、会话和模型供应商管理。
- OAuth、企业身份提供商、多租户权限中心和云端 Agent 管理。
- 向量数据库、嵌入式语义搜索和自动模型推理。
- 任意系统命令执行。
- 自动替用户安装或修改第三方 Agent 配置。

远程 MCP HTTP 使用现有 HTTP 服务生命周期和主机网络设置。X-File 负责 MCP 协议、Agent API Key 鉴权和工具权限；生产环境的 TLS 由反向代理或现有 HTTPS 部署负责。
