use std::fs::File;
use std::io::Read;
use std::path::Path;

use serde_json::{json, Value};

use super::{
    call, catalog, envelope, is_read_only, list_tools, mcp, ToolError, MAX_INPUT_BYTES, SKILL,
};

const HELP: &str = "\
X-File 原生 Agent 工具

  x-file-desktop cli [--data-dir PATH] [--read-only] list
  x-file-desktop cli [--data-dir PATH] [--read-only] schema TOOL
  x-file-desktop cli [--data-dir PATH] [--read-only] call TOOL [JSON | --stdin | --input-file PATH]
  x-file-desktop cli skill
  x-file-desktop mcp [--data-dir PATH] [--read-only]

list/schema/call 使用相同的 JSON Schema 和结果格式。
--data-dir 选择应用状态目录，必须是绝对路径；默认使用 X_FILE_DATA_DIR 或用户默认目录。
--read-only 同时隐藏和拒绝写工具。文件路径相对于当前绑定资料库。
调用工具和启动 MCP 前，须在设置中启用外部 Agent，并通过 X_FILE_AGENT_API_KEY 环境变量传入密钥。
list/schema/skill/help 为公开说明，无需密钥；不支持通过命令行参数传入密钥。
成功退出码为 0，业务失败为 1，参数错误为 2。
";

pub fn run_agent_cli_from_args(args: &[String]) -> i32 {
    let mcp_mode = args.get(1).is_some_and(|s| s == "mcp");
    match run(args) {
        Ok(code) => code,
        Err(error) => {
            let code = if error.code == "INVALID_ARGUMENT" {
                2
            } else {
                1
            };
            let response = envelope("cli", Err(error));
            if mcp_mode {
                eprintln!("{response}");
            } else {
                println!("{response}");
            }
            code
        }
    }
}

fn run(args: &[String]) -> Result<i32, ToolError> {
    match args.get(1).map(String::as_str) {
        Some("--help") => {
            print!("{HELP}");
            return Ok(0);
        }
        Some("--version") => {
            println!("X-File {}", env!("CARGO_PKG_VERSION"));
            return Ok(0);
        }
        _ => {}
    }
    let (read_only, rest) = options(&args[2..])?;
    if args[1] == "mcp" {
        if !rest.is_empty() {
            return Err(invalid("mcp 不接受工具调用参数"));
        }
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()?;
        runtime.block_on(mcp::serve(read_only))?;
        return Ok(0);
    }
    let command = rest.first().map(String::as_str).unwrap_or("--help");
    match command {
        "--help" | "help" if rest.len() <= 1 => print!("{HELP}"),
        "skill" if rest.len() == 1 => print!("{SKILL}"),
        "list" if rest.len() == 1 => println!(
            "{}",
            json!({
                "schemaVersion": 1, "readOnly": read_only, "tools": list_tools(read_only)
            })
        ),
        "schema" if rest.len() == 2 => {
            let definition = catalog()
                .iter()
                .find(|d| d.tool.name == rest[1] && (!read_only || is_read_only(&d.tool)))
                .ok_or_else(|| ToolError::new("TOOL_NOT_FOUND", "当前模式下未找到工具"))?;
            println!("{}", serde_json::to_string(&definition.tool)?);
        }
        "call" if rest.len() >= 2 => {
            let input = input(&rest[2..])?;
            let response = call(&rest[1], input, read_only);
            println!("{response}");
            if response["ok"] != true {
                return Ok(if response["error"]["code"] == "INVALID_ARGUMENT" {
                    2
                } else {
                    1
                });
            }
        }
        _ => return Err(invalid("未知命令或多余参数，请运行 cli --help")),
    }
    Ok(0)
}

fn options(args: &[String]) -> Result<(bool, &[String]), ToolError> {
    let mut index = 0;
    let mut read_only = false;
    while let Some(option) = args.get(index).map(String::as_str) {
        match option {
            "--read-only" => read_only = true,
            "--data-dir" => {
                index += 1;
                let path = args
                    .get(index)
                    .ok_or_else(|| invalid("--data-dir 缺少路径"))?;
                if !Path::new(path).is_absolute() {
                    return Err(invalid("--data-dir 必须是绝对路径"));
                }
                // 在创建异步运行时之前设置，整个进程的状态目录随后保持不变。
                std::env::set_var("X_FILE_DATA_DIR", path);
            }
            _ => break,
        }
        index += 1;
    }
    Ok((read_only, &args[index..]))
}

fn input(args: &[String]) -> Result<Value, ToolError> {
    let text = match args {
        [] => return Ok(json!({})),
        [option] if option == "--stdin" => bounded_read(std::io::stdin())?,
        [option, path] if option == "--input-file" => bounded_read(File::open(path)?)?,
        [json] if !json.starts_with("--") => {
            if json.len() as u64 > MAX_INPUT_BYTES {
                return Err(invalid("JSON 输入不能超过 2 MiB"));
            }
            json.clone()
        }
        _ => {
            return Err(invalid(
                "只接受一个 JSON 参数、--stdin 或 --input-file PATH",
            ))
        }
    };
    serde_json::from_str(&text).map_err(Into::into)
}

fn bounded_read(reader: impl Read) -> Result<String, ToolError> {
    let mut bytes = Vec::new();
    reader.take(MAX_INPUT_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_INPUT_BYTES {
        return Err(invalid("JSON 输入不能超过 2 MiB"));
    }
    String::from_utf8(bytes).map_err(|_| invalid("JSON 输入必须是 UTF-8"))
}

fn invalid(message: &str) -> ToolError {
    ToolError::new("INVALID_ARGUMENT", message)
}
