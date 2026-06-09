import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type {
  LibraryOnlyOfficePreview,
  OnlyOfficeSettings,
  OnlyOfficeStatus,
  UpdateOnlyOfficeSettingsInput
} from "@x-file/shared";

import { LibraryError } from "../library/library-errors.js";
import type { LibraryService } from "../library/library-service.js";
import type { LibraryPreviewLinkService } from "../library/preview-link-service.js";
import type {
  OnlyOfficeSettingRecord,
  OnlyOfficeSettingsStore
} from "../storage/onlyoffice-settings-store.js";

const CALLBACK_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const STATUS_CHECK_TIMEOUT_MS = 5000;
const CALLBACK_DOWNLOAD_TIMEOUT_MS = 20000;

type OnlyOfficeDisplayMode = "default" | "reading";

interface OnlyOfficeResolvedSetting {
  enabled: boolean;
  serverUrl: string | null;
  publicBaseUrl: string | null;
  callbackBaseUrl: string | null;
  effectiveCallbackBaseUrl: string | null;
  userDisplayName: string | null;
  userAvatarUrl: string | null;
  jwtSecret: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

interface OnlyOfficeCallbackTokenPayload {
  libraryId: string;
  filePath: string;
  expiresAt: number;
}

interface OnlyOfficeCallbackBody {
  status?: unknown;
  url?: unknown;
}

interface OnlyOfficeConfigData {
  documentType: "word" | "cell" | "slide";
  fileType: string;
  title: string;
  key: string;
  documentUrl: string;
  callbackUrl: string;
  editable: boolean;
  displayMode: OnlyOfficeDisplayMode;
}

interface OnlyOfficeEditorUser {
  id: string;
  name: string;
  image?: string;
}

export class OnlyOfficeService {
  constructor(
    private readonly store: OnlyOfficeSettingsStore,
    private readonly libraryPreviewLinkService: Pick<LibraryPreviewLinkService, "createOnlyOfficeLink">,
    private readonly libraryService: LibraryService,
    private readonly signingSecret: string
  ) {}

  getSettings(): OnlyOfficeSettings {
    return toSettingsView(this.readResolvedSetting());
  }

  updateSettings(input: UpdateOnlyOfficeSettingsInput): OnlyOfficeSettings {
    const current = this.readResolvedSetting();
    const nextEnabled = input.enabled ?? current.enabled;
    const nextServerUrl = input.serverUrl !== undefined
      ? normalizeOptionalAbsoluteUrl(input.serverUrl, "serverUrl")
      : current.serverUrl;
    const nextPublicBaseUrl = input.publicBaseUrl !== undefined
      ? normalizeOptionalAbsoluteUrl(input.publicBaseUrl, "publicBaseUrl")
      : current.publicBaseUrl;
    const nextCallbackBaseUrl = input.callbackBaseUrl !== undefined
      ? normalizeOptionalAbsoluteUrl(input.callbackBaseUrl, "callbackBaseUrl")
      : current.callbackBaseUrl;
    const nextUserDisplayName = input.userDisplayName !== undefined
      ? normalizeOptionalUserName(input.userDisplayName, "userDisplayName")
      : current.userDisplayName;
    const nextUserAvatarUrl = input.userAvatarUrl !== undefined
      ? normalizeOptionalAbsoluteUrl(input.userAvatarUrl, "userAvatarUrl")
      : current.userAvatarUrl;

    let nextJwtSecret = current.jwtSecret;
    if (input.clearJwtSecret) {
      nextJwtSecret = null;
    }
    if (input.jwtSecret !== undefined) {
      const normalizedSecret = normalizeOptionalText(input.jwtSecret);
      if (normalizedSecret) {
        nextJwtSecret = normalizedSecret;
      } else if (!input.clearJwtSecret) {
        nextJwtSecret = current.jwtSecret;
      }
    }

    if (nextEnabled) {
      if (!nextServerUrl) {
        throw buildFieldError("serverUrl", "启用 ONLYOFFICE 前必须填写服务地址");
      }
      if (!nextPublicBaseUrl) {
        throw buildFieldError("publicBaseUrl", "启用 ONLYOFFICE 前必须填写 X-File 对外地址");
      }
    }

    const timestamp = new Date().toISOString();
    const record: OnlyOfficeSettingRecord = {
      enabled: nextEnabled,
      serverUrl: nextServerUrl,
      publicBaseUrl: nextPublicBaseUrl,
      callbackBaseUrl: nextCallbackBaseUrl,
      userDisplayName: nextUserDisplayName,
      userAvatarUrl: nextUserAvatarUrl,
      jwtSecret: nextJwtSecret,
      createdAt: current.createdAt ?? timestamp,
      updatedAt: timestamp
    };

    this.store.write(record);
    return this.getSettings();
  }

  async getStatus(): Promise<OnlyOfficeStatus> {
    const setting = this.readResolvedSetting();
    const checkedAt = new Date().toISOString();

    if (!setting.enabled) {
      return {
        state: "disabled",
        summary: "当前未启用 ONLYOFFICE 集成。",
        checkedAt,
        checks: [
          {
            key: "enabled",
            label: "启用状态",
            status: "skip",
            detail: "开关未打开，X-File 会继续保持当前默认预览行为。"
          }
        ]
      };
    }

    const checks: OnlyOfficeStatus["checks"] = [];
    if (!setting.serverUrl) {
      checks.push({
        key: "serverUrl",
        label: "ONLYOFFICE 服务地址",
        status: "fail",
        detail: "缺少 ONLYOFFICE 服务地址。"
      });
    } else {
      checks.push({
        key: "serverUrl",
        label: "ONLYOFFICE 服务地址",
        status: "pass",
        detail: setting.serverUrl
      });
    }

    if (!setting.publicBaseUrl) {
      checks.push({
        key: "publicBaseUrl",
        label: "X-File 对外地址",
        status: "fail",
        detail: "缺少 X-File 对外地址，ONLYOFFICE 将无法拉取文件。"
      });
    } else {
      checks.push({
        key: "publicBaseUrl",
        label: "X-File 对外地址",
        status: "pass",
        detail: setting.publicBaseUrl
      });
    }

    if (!setting.serverUrl || !setting.publicBaseUrl) {
      return {
        state: "misconfigured",
        summary: "配置还没填完整，先把服务地址和 X-File 对外地址补齐。",
        checkedAt,
        checks
      };
    }

    const healthCheckUrl = new URL("/healthcheck", ensureTrailingSlash(setting.serverUrl)).toString();
    const apiScriptUrl = new URL("/web-apps/apps/api/documents/api.js", ensureTrailingSlash(setting.serverUrl)).toString();
    const healthCheck = await probeTextEndpoint(healthCheckUrl);
    checks.push({
      key: "healthcheck",
      label: "ONLYOFFICE healthcheck",
      status: healthCheck.ok ? "pass" : "fail",
      detail: healthCheck.detail
    });
    const scriptCheck = await probeTextEndpoint(apiScriptUrl);
    checks.push({
      key: "apiScript",
      label: "ONLYOFFICE api.js",
      status: scriptCheck.ok ? "pass" : "fail",
      detail: scriptCheck.detail
    });

    const callbackBaseUrl = setting.effectiveCallbackBaseUrl;
    if (!callbackBaseUrl) {
      checks.push({
        key: "callbackBaseUrl",
        label: "回调地址",
        status: "fail",
        detail: "缺少回调地址，ONLYOFFICE 保存后无法回写。"
      });
      return {
        state: "misconfigured",
        summary: "回调地址还没配好，ONLYOFFICE 不能正常保存。",
        checkedAt,
        checks
      };
    }

    const loopbackRisk = detectLoopbackMismatch(setting.serverUrl, callbackBaseUrl);
    checks.push({
      key: "callbackReachability",
      label: "回调地址可达性",
      status: loopbackRisk ? "warn" : "pass",
      detail: loopbackRisk ?? `当前回调基地址为 ${callbackBaseUrl}`
    });

    if (!healthCheck.ok || !scriptCheck.ok) {
      return {
        state: "error",
        summary: "ONLYOFFICE 服务现在不可用，先确认服务是否真的启动。",
        checkedAt,
        checks
      };
    }

    if (loopbackRisk) {
      return {
        state: "warning",
        summary: "ONLYOFFICE 服务可访问，但当前回调地址看起来只适合同机环境。",
        checkedAt,
        checks
      };
    }

    return {
      state: "ready",
      summary: "ONLYOFFICE 服务和回调地址都已通过基础检查，可以启用 Office 预览。",
      checkedAt,
      checks
    };
  }

  buildLibraryPreview(input: {
    filePath: string;
    version: string | null;
    editable?: boolean;
    displayMode?: OnlyOfficeDisplayMode;
  }): LibraryOnlyOfficePreview {
    const setting = this.requireEnabledSetting();
    const fileLink = this.libraryPreviewLinkService.createOnlyOfficeLink(input.filePath);
    const binding = this.libraryService.getBinding();
    if (!binding) {
      throw new LibraryError(400, "LIBRARY_NOT_BOUND", "请先绑定文档库根目录");
    }
    return this.buildPreviewPayload({
      setting,
      libraryId: binding.libraryId,
      editorUserId: "local",
      editorUserName: "X-File",
      filePath: input.filePath,
      version: input.version,
      editable: input.editable ?? true,
      displayMode: input.displayMode ?? "default",
      documentUrl: new URL(fileLink.previewPath, ensureTrailingSlash(setting.publicBaseUrl!)).toString()
    });
  }

  async handleCallback(callbackToken: string, body: unknown): Promise<{ error: 0 | 1 }> {
    const payload = this.verifyCallbackToken(callbackToken);
    const callbackBody = normalizeCallbackBody(body);

    if (!shouldPersistCallbackStatus(callbackBody.status)) {
      return { error: 0 };
    }

    const downloadUrl = normalizeOptionalText(callbackBody.url);
    if (!downloadUrl) {
      return { error: 1 };
    }

    const response = await fetch(downloadUrl, {
      signal: AbortSignal.timeout(CALLBACK_DOWNLOAD_TIMEOUT_MS)
    });
    if (!response.ok) {
      return { error: 1 };
    }

    const fileBuffer = Buffer.from(await response.arrayBuffer());
    try {
      const resolved = this.libraryService.resolveLibraryPath(payload.filePath, {
        mustExist: true,
        kind: "file"
      });
      if (resolved.binding.libraryId !== payload.libraryId) {
        return { error: 1 };
      }
      fs.writeFileSync(resolved.absolutePath, fileBuffer);
      this.libraryService.notifyFileChanged("onlyoffice_callback", resolved.relativePath);
    } catch {
      return { error: 1 };
    }

    return { error: 0 };
  }

  private buildPreviewPayload(input: {
    setting: OnlyOfficeResolvedSetting;
    libraryId: string;
    editorUserId: string;
    editorUserName: string;
    filePath: string;
    version: string | null;
    editable: boolean;
    displayMode: OnlyOfficeDisplayMode;
    documentUrl: string;
  }): LibraryOnlyOfficePreview {
    const callbackToken = this.createCallbackToken({
      libraryId: input.libraryId,
      filePath: input.filePath,
      expiresAt: Date.now() + CALLBACK_TOKEN_TTL_MS
    });
    const callbackUrl = new URL(
      `/api/office/onlyoffice/callback/${encodeURIComponent(callbackToken)}`,
      ensureTrailingSlash(input.setting.effectiveCallbackBaseUrl!)
    ).toString();
    const configData = buildOnlyOfficeConfigData({
      filePath: input.filePath,
      version: input.version,
      documentUrl: input.documentUrl,
      callbackUrl,
      editable: input.editable,
      displayMode: input.displayMode
    });
    const editorUser = buildOnlyOfficeEditorUser({
      userId: input.editorUserId,
      username: input.editorUserName,
      overrideDisplayName: input.setting.userDisplayName,
      overrideAvatarUrl: input.setting.userAvatarUrl
    });
    const editorConfig = buildOnlyOfficeEditorConfig(configData, editorUser, input.setting.jwtSecret);

    return {
      apiScriptUrl: new URL("/web-apps/apps/api/documents/api.js", ensureTrailingSlash(input.setting.serverUrl!)).toString(),
      editorMode: input.displayMode === "reading" || !input.editable ? "view" : "edit",
      documentUrl: input.documentUrl,
      callbackUrl,
      editorConfig
    };
  }

  private requireEnabledSetting(): OnlyOfficeResolvedSetting {
    const setting = this.readResolvedSetting();

    if (!setting.enabled) {
      throw new LibraryError(400, "ONLYOFFICE_DISABLED", "当前还没有启用 ONLYOFFICE 集成。");
    }

    if (!setting.serverUrl || !setting.publicBaseUrl || !setting.effectiveCallbackBaseUrl) {
      throw new LibraryError(400, "ONLYOFFICE_MISCONFIGURED", "ONLYOFFICE 配置还没填完整，请先补齐服务地址和对外地址。");
    }

    return setting;
  }

  private readResolvedSetting(): OnlyOfficeResolvedSetting {
    const record = this.store.read();

    return {
      enabled: record?.enabled ?? false,
      serverUrl: record?.serverUrl ?? null,
      publicBaseUrl: record?.publicBaseUrl ?? null,
      callbackBaseUrl: record?.callbackBaseUrl ?? null,
      effectiveCallbackBaseUrl: record?.callbackBaseUrl ?? record?.publicBaseUrl ?? null,
      userDisplayName: record?.userDisplayName ?? null,
      userAvatarUrl: record?.userAvatarUrl ?? null,
      jwtSecret: record?.jwtSecret ?? null,
      createdAt: record?.createdAt ?? null,
      updatedAt: record?.updatedAt ?? null
    };
  }

  private createCallbackToken(payload: OnlyOfficeCallbackTokenPayload): string {
    const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const signature = signHmac(encodedPayload, this.signingSecret);
    return `${encodedPayload}.${signature}`;
  }

  private verifyCallbackToken(token: string): OnlyOfficeCallbackTokenPayload {
    const [encodedPayload, signature] = token.split(".");

    if (!encodedPayload || !signature) {
      throw buildInvalidCallbackTokenError();
    }

    let payload: OnlyOfficeCallbackTokenPayload;
    try {
      payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as OnlyOfficeCallbackTokenPayload;
    } catch {
      throw buildInvalidCallbackTokenError();
    }

    const expectedSignature = signHmac(encodedPayload, this.signingSecret);
    if (!safeCompare(signature, expectedSignature)) {
      throw buildInvalidCallbackTokenError();
    }

    if (!payload.libraryId || !payload.filePath || payload.expiresAt <= Date.now()) {
      throw buildInvalidCallbackTokenError();
    }

    return payload;
  }
}

function toSettingsView(setting: OnlyOfficeResolvedSetting): OnlyOfficeSettings {
  return {
    enabled: setting.enabled,
    serverUrl: setting.serverUrl,
    publicBaseUrl: setting.publicBaseUrl,
    callbackBaseUrl: setting.callbackBaseUrl,
    userDisplayName: setting.userDisplayName,
    userAvatarUrl: setting.userAvatarUrl,
    jwtSecretConfigured: Boolean(setting.jwtSecret),
    updatedAt: setting.updatedAt
  };
}

function buildOnlyOfficeConfigData(input: {
  filePath: string;
  version: string | null;
  documentUrl: string;
  callbackUrl: string;
  editable: boolean;
  displayMode: OnlyOfficeDisplayMode;
}): OnlyOfficeConfigData {
  const extension = path.extname(input.filePath).toLowerCase();
  const fileType = extension.replace(/^\./, "");
  const documentType = resolveOnlyOfficeDocumentType(fileType);
  const title = path.basename(input.filePath);
  const key = crypto
    .createHash("sha256")
    .update(`${input.filePath}:${input.version ?? "unknown"}`)
    .digest("hex")
    .slice(0, 48);

  return {
    documentType,
    fileType,
    title,
    key,
    documentUrl: input.documentUrl,
    callbackUrl: input.callbackUrl,
    editable: input.editable,
    displayMode: input.displayMode
  };
}

function buildOnlyOfficeEditorConfig(
  input: OnlyOfficeConfigData,
  user: OnlyOfficeEditorUser,
  jwtSecret: string | null
): Record<string, unknown> {
  const readingMode = input.displayMode === "reading";
  const baseConfig: Record<string, unknown> = {
    documentType: input.documentType,
    type: readingMode ? "embedded" : "desktop",
    width: "100%",
    height: "100%",
    document: {
      fileType: input.fileType,
      key: input.key,
      title: input.title,
      url: input.documentUrl,
      permissions: {
        edit: readingMode ? false : input.editable,
        review: readingMode ? false : input.editable,
        comment: readingMode ? false : input.editable,
        download: true,
        print: true,
        copy: true
      }
    },
    editorConfig: {
      callbackUrl: input.callbackUrl,
      mode: readingMode || !input.editable ? "view" : "edit",
      lang: "zh-CN",
      user,
      coEditing: readingMode
        ? {
            mode: "strict",
            change: false
          }
        : undefined,
      customization: {
        autosave: true,
        forcesave: true,
        compactToolbar: false,
        features: {
          spellcheck: false
        },
        anonymous: {
          request: false
        }
      }
    }
  };

  if (!jwtSecret) {
    return baseConfig;
  }

  return {
    ...baseConfig,
    token: signJwt(baseConfig, jwtSecret)
  };
}

function resolveOnlyOfficeDocumentType(fileType: string): "word" | "cell" | "slide" {
  switch (fileType) {
    case "xls":
    case "xlsx":
      return "cell";
    case "ppt":
    case "pptx":
      return "slide";
    case "doc":
    case "docx":
    default:
      return "word";
  }
}

function normalizeCallbackBody(body: unknown): OnlyOfficeCallbackBody {
  if (typeof body !== "object" || body === null) {
    return {};
  }

  return body as OnlyOfficeCallbackBody;
}

function shouldPersistCallbackStatus(status: unknown): boolean {
  return status === 2 || status === 6;
}

async function probeTextEndpoint(url: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(STATUS_CHECK_TIMEOUT_MS)
    });

    if (!response.ok) {
      return {
        ok: false,
        detail: `${url} 返回 ${response.status}`
      };
    }

    const text = (await response.text()).trim();
    return {
      ok: true,
      detail: text ? `${url} 可访问：${text.slice(0, 80)}` : `${url} 可访问`
    };
  } catch (error) {
    return {
      ok: false,
      detail: `${url} 访问失败：${error instanceof Error ? error.message : "未知错误"}`
    };
  }
}

function detectLoopbackMismatch(serverUrl: string, callbackBaseUrl: string): string | null {
  try {
    const serverHost = new URL(serverUrl).hostname;
    const callbackHost = new URL(callbackBaseUrl).hostname;

    if (!isLoopbackHost(serverHost) && isLoopbackHost(callbackHost)) {
      return "当前 ONLYOFFICE 服务不是本机地址，但回调地址仍然是 localhost/127.0.0.1，外部部署通常打不回来。";
    }
  } catch {
    return "当前地址格式不完整，无法判断回调可达性。";
  }

  return null;
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function ensureTrailingSlash(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
}

function normalizeOptionalAbsoluteUrl(value: string | null | undefined, field: string): string | null {
  const normalized = normalizeOptionalText(value);
  if (!normalized) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw buildFieldError(field, `${field} 必须是完整的绝对地址`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw buildFieldError(field, `${field} 只支持 http 或 https`);
  }

  parsed.hash = "";
  return parsed.toString().replace(/\/+$/, "");
}

function normalizeOptionalUserName(value: string | null | undefined, field: string): string | null {
  const normalized = normalizeOptionalText(value);
  if (!normalized) {
    return null;
  }

  return normalized.slice(0, 128);
}

function buildOnlyOfficeEditorUser(input: {
  userId: string;
  username: string;
  overrideDisplayName: string | null;
  overrideAvatarUrl: string | null;
}): OnlyOfficeEditorUser {
  const resolvedId = input.userId.trim().slice(0, 128);
  const resolvedName = (input.overrideDisplayName ?? input.username).trim().slice(0, 128) || resolvedId;
  const user: OnlyOfficeEditorUser = {
    id: resolvedId,
    name: resolvedName
  };

  if (input.overrideAvatarUrl) {
    user.image = input.overrideAvatarUrl;
  }

  return user;
}

function normalizeOptionalText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function buildFieldError(field: string, detail: string): LibraryError {
  return new LibraryError(400, "INVALID_INPUT", detail, field);
}

function buildInvalidCallbackTokenError(): LibraryError {
  return new LibraryError(401, "ONLYOFFICE_CALLBACK_TOKEN_INVALID", "ONLYOFFICE 回调 token 无效或已过期。");
}

function safeCompare(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.byteLength !== rightBuffer.byteLength) {
    return false;
  }
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function signHmac(encodedPayload: string, secret: string): string {
  return crypto
    .createHmac("sha256", secret)
    .update(encodedPayload)
    .digest("base64url");
}

function signJwt(payload: Record<string, unknown>, secret: string): string {
  const header = { alg: "HS256", typ: "JWT" };
  const encodedHeader = Buffer.from(JSON.stringify(header), "utf8").toString("base64url");
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = crypto
    .createHmac("sha256", secret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest("base64url");
  return `${encodedHeader}.${encodedPayload}.${signature}`;
}
