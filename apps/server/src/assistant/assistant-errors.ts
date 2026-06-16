// 文档助手错误类型与统一错误响应，照搬 library-errors 的模式，
// 让 assistant-routes 的 wrap 能用同一套 try/catch + 错误体返回。

export type AssistantErrorCode =
  | "LIBRARY_NOT_BOUND"
  | "ASSISTANT_SESSION_NOT_FOUND"
  | "ASSISTANT_PROVIDER_NOT_SUPPORTED"
  | "ASSISTANT_PROVIDER_UNAVAILABLE"
  | "ASSISTANT_RUN_IN_PROGRESS"
  | "ASSISTANT_INVALID_INPUT"
  | "ASSISTANT_RUNTIME_ERROR";

export class AssistantError extends Error {
  readonly statusCode: number;
  readonly errorCode: AssistantErrorCode;
  readonly field?: string;

  constructor(
    statusCode: number,
    errorCode: AssistantErrorCode,
    message: string,
    field?: string
  ) {
    super(message);
    this.name = "AssistantError";
    this.statusCode = statusCode;
    this.errorCode = errorCode;
    this.field = field;
  }
}

export interface AssistantErrorResponse {
  detail: string;
  errorCode: AssistantErrorCode;
  field?: string;
  timestamp: string;
}

export function toAssistantErrorResponse(error: unknown): {
  statusCode: number;
  body: AssistantErrorResponse;
} {
  if (error instanceof AssistantError) {
    return {
      statusCode: error.statusCode,
      body: {
        detail: error.message,
        errorCode: error.errorCode,
        field: error.field,
        timestamp: new Date().toISOString()
      }
    };
  }

  return {
    statusCode: 500,
    body: {
      detail: error instanceof Error ? error.message : "文档助手服务发生未知错误",
      errorCode: "ASSISTANT_RUNTIME_ERROR",
      timestamp: new Date().toISOString()
    }
  };
}
