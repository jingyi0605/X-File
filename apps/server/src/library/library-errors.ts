export type LibraryErrorCode =
  | "LIBRARY_NOT_BOUND"
  | "LIBRARY_PATH_INVALID"
  | "LIBRARY_STORAGE_ERROR"
  | "LIBRARY_TODO"
  | "LIBRARY_TAG_NOT_FOUND"
  | "FILE_ALREADY_EXISTS"
  | "FILE_NOT_FOUND"
  | "FILE_PREVIEW_ASSET_NOT_SUPPORTED"
  | "FILE_PREVIEW_NOT_SUPPORTED"
  | "FILE_PREVIEW_TOKEN_EXPIRED"
  | "FILE_PREVIEW_TOKEN_INVALID"
  | "FILE_TOO_LARGE"
  | "FILE_VERSION_CONFLICT"
  | "BINARY_FILE_NOT_SUPPORTED"
  | "INVALID_CONTENT"
  | "INVALID_FILE_OPERATION"
  | "INVALID_INPUT"
  | "NOT_A_DIRECTORY"
  | "NOT_A_FILE"
  | "ONLYOFFICE_CALLBACK_TOKEN_INVALID"
  | "ONLYOFFICE_DISABLED"
  | "ONLYOFFICE_MISCONFIGURED";

export class LibraryError extends Error {
  readonly statusCode: number;
  readonly errorCode: LibraryErrorCode;
  readonly field?: string;

  constructor(
    statusCode: number,
    errorCode: LibraryErrorCode,
    message: string,
    field?: string
  ) {
    super(message);
    this.name = "LibraryError";
    this.statusCode = statusCode;
    this.errorCode = errorCode;
    this.field = field;
  }
}

export interface LibraryErrorResponse {
  detail: string;
  errorCode: LibraryErrorCode;
  field?: string;
  timestamp: string;
}

export function toLibraryErrorResponse(error: unknown): {
  statusCode: number;
  body: LibraryErrorResponse;
} {
  if (error instanceof LibraryError) {
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
      detail: error instanceof Error ? error.message : "文档库服务发生未知错误",
      errorCode: "LIBRARY_STORAGE_ERROR",
      timestamp: new Date().toISOString()
    }
  };
}
