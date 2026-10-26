use std::sync::Arc;

use rmcp::{
    model::{
        CallToolRequestParams, CallToolResponse, CallToolResult, Implementation,
        ListResourcesResult, ListToolsResult, PaginatedRequestParams, ReadResourceRequestParams,
        ReadResourceResponse, ReadResourceResult, Resource, ResourceContents, ServerCapabilities,
        ServerConfig,
    },
    service::RequestContext,
    ErrorData, RoleServer, ServerHandler, ServiceExt,
};
use serde_json::Value;
use tokio::sync::Mutex;

use super::{call, catalog, envelope, list_tools, ToolError, MAX_INPUT_BYTES, SKILL, SKILL_URI};

#[derive(Clone)]
struct XFileServer {
    read_only: bool,
    serial: Arc<Mutex<()>>,
}

impl ServerHandler for XFileServer {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().enable_resources().build())
            .with_server_info(Implementation::new("x-file", env!("CARGO_PKG_VERSION")))
            .with_instructions("通过 xfile_status 确认绑定资料库；读取 xfile://skills/x-file 学习工具流程。覆盖文件必须提供读取时的 version；工具不执行模型推理。")
    }

    async fn list_tools(
        &self,
        request: Option<PaginatedRequestParams>,
        _: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        reject_cursor(request)?;
        Ok(ListToolsResult::with_all_items(list_tools(self.read_only)))
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        _: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        let name = request.name.into_owned();
        if !catalog().iter().any(|d| d.tool.name == name) {
            return Err(ErrorData::invalid_params("未知 X-File 工具", None));
        }
        let input = Value::Object(request.arguments.unwrap_or_default());
        if input.to_string().len() as u64 > MAX_INPUT_BYTES {
            return Err(ErrorData::invalid_params("参数不能超过 2 MiB", None));
        }
        let _guard = self.serial.lock().await;
        let read_only = self.read_only;
        let task_name = name.clone();
        let result = tokio::task::spawn_blocking(move || call(&task_name, input, read_only))
            .await
            .unwrap_or_else(|error| {
                envelope(
                    &name,
                    Err(ToolError::new("INTERNAL_ERROR", error.to_string())),
                )
            });
        let result = if result["ok"] == true {
            CallToolResult::structured(result)
        } else {
            CallToolResult::structured_error(result)
        };
        Ok(result.into())
    }

    async fn list_resources(
        &self,
        request: Option<PaginatedRequestParams>,
        _: RequestContext<RoleServer>,
    ) -> Result<ListResourcesResult, ErrorData> {
        reject_cursor(request)?;
        Ok(ListResourcesResult::with_all_items(vec![Resource::new(
            SKILL_URI,
            "x-file-skill",
        )
        .with_mime_type("text/markdown")
        .with_description("X-File 外部 Agent 使用流程")
        .with_size(SKILL.len() as u64)]))
    }

    async fn read_resource(
        &self,
        request: ReadResourceRequestParams,
        _: RequestContext<RoleServer>,
    ) -> Result<ReadResourceResponse, ErrorData> {
        if request.uri != SKILL_URI {
            return Err(ErrorData::resource_not_found(
                "未找到资源",
                Some(serde_json::json!({"uri": request.uri})),
            ));
        }
        Ok(ReadResourceResult::new(vec![
            ResourceContents::text(SKILL, SKILL_URI).with_mime_type("text/markdown")
        ])
        .into())
    }
}

fn reject_cursor(request: Option<PaginatedRequestParams>) -> Result<(), ErrorData> {
    if request.and_then(|r| r.cursor).is_some() {
        return Err(ErrorData::invalid_params(
            "当前目录一次返回全部工具/资源，不接受 cursor",
            None,
        ));
    }
    Ok(())
}

pub async fn serve(read_only: bool) -> Result<(), ToolError> {
    super::settings::authorize()?;
    // SDK 独占 stdout；底层原生预览日志只写 stderr。
    let server = XFileServer {
        read_only,
        serial: Arc::new(Mutex::new(())),
    };
    let running = server
        .serve(rmcp::transport::stdio())
        .await
        .map_err(|error| ToolError::new("MCP_ERROR", error.to_string()))?;
    running
        .waiting()
        .await
        .map_err(|error| ToolError::new("MCP_ERROR", error.to_string()))?;
    Ok(())
}
