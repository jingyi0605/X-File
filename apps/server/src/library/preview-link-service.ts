import crypto from "node:crypto";

import { LibraryError } from "./library-errors.js";
import { detectPreviewKind, resolvePreviewContentType } from "./file-preview.js";
import type { LibraryService } from "./library-service.js";

const LIBRARY_PREVIEW_TOKEN_TTL_MS = 2 * 60 * 60 * 1000;

interface LibraryPreviewTokenPayload {
  libraryId: string;
  expiresAt: number;
  previewPath?: string;
}

export interface LibraryPreviewLinkResult {
  previewPath: string;
  previewUrl: string;
  expiresAt: string;
}

export interface PublicLibraryPreviewResult {
  libraryId: string;
  absolutePath: string;
  relativePath: string;
  contentType: string;
}

export class LibraryPreviewLinkService {
  constructor(
    private readonly libraryService: LibraryService,
    private readonly signingSecret: string
  ) {}

  createLink(requestedPath: string): LibraryPreviewLinkResult {
    const resolved = this.libraryService.resolveLibraryPath(requestedPath, {
      mustExist: true,
      kind: "file"
    });
    const previewKind = detectPreviewKind(resolved.relativePath);

    if (previewKind !== "html" && previewKind !== "image" && previewKind !== "pdf") {
      throw new LibraryError(
        400,
        "FILE_PREVIEW_NOT_SUPPORTED",
        "当前只支持为 HTML、图片和 PDF 生成受控预览链接",
        "path"
      );
    }

    return this.createSignedLink(resolved.binding.libraryId, resolved.relativePath);
  }

  createOnlyOfficeLink(requestedPath: string): LibraryPreviewLinkResult {
    const resolved = this.libraryService.resolveLibraryPath(requestedPath, {
      mustExist: true,
      kind: "file"
    });
    const previewKind = detectPreviewKind(resolved.relativePath);

    if (previewKind !== "office") {
      throw new LibraryError(
        400,
        "FILE_PREVIEW_NOT_SUPPORTED",
        "当前只支持为 Office 文件生成 ONLYOFFICE 受控链接",
        "path"
      );
    }

    return this.createSignedLink(resolved.binding.libraryId, resolved.relativePath);
  }

  resolvePublicFile(token: string, requestedPath: string): PublicLibraryPreviewResult {
    const payload = this.verifyToken(token);
    const resolved = this.libraryService.resolveLibraryPath(requestedPath, {
      mustExist: true,
      kind: "file"
    });
    const contentType = resolvePreviewContentType(resolved.relativePath);

    if (resolved.binding.libraryId !== payload.libraryId || resolved.relativePath !== payload.previewPath) {
      throw buildInvalidPreviewTokenError();
    }

    if (!contentType) {
      throw new LibraryError(
        400,
        "FILE_PREVIEW_ASSET_NOT_SUPPORTED",
        "当前预览链接不支持加载这种文件类型",
        "path"
      );
    }

    return {
      libraryId: payload.libraryId,
      absolutePath: resolved.absolutePath,
      relativePath: resolved.relativePath,
      contentType
    };
  }

  private createSignedLink(libraryId: string, relativePath: string): LibraryPreviewLinkResult {
    const expiresAt = Date.now() + LIBRARY_PREVIEW_TOKEN_TTL_MS;
    const token = this.createToken({
      libraryId,
      expiresAt,
      previewPath: relativePath
    });

    return {
      previewPath: buildLibraryPublicPreviewPath(token, relativePath),
      previewUrl: "",
      expiresAt: new Date(expiresAt).toISOString()
    };
  }

  private createToken(payload: LibraryPreviewTokenPayload): string {
    const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const signature = this.sign(encodedPayload);
    return `${encodedPayload}.${signature}`;
  }

  private verifyToken(token: string): LibraryPreviewTokenPayload {
    const [encodedPayload, signature] = token.split(".");

    if (!encodedPayload || !signature) {
      throw buildInvalidPreviewTokenError();
    }

    const expectedSignature = this.sign(encodedPayload);
    if (!safeCompare(signature, expectedSignature)) {
      throw buildInvalidPreviewTokenError();
    }

    let payload: LibraryPreviewTokenPayload;
    try {
      payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as LibraryPreviewTokenPayload;
    } catch {
      throw buildInvalidPreviewTokenError();
    }

    if (!payload.libraryId || typeof payload.expiresAt !== "number" || !payload.previewPath) {
      throw buildInvalidPreviewTokenError();
    }

    if (payload.expiresAt <= Date.now()) {
      throw new LibraryError(401, "FILE_PREVIEW_TOKEN_EXPIRED", "预览链接已经过期，请重新打开文件预览");
    }

    return payload;
  }

  private sign(encodedPayload: string): string {
    return crypto
      .createHmac("sha256", this.signingSecret)
      .update(encodedPayload)
      .digest("base64url");
  }
}

export function buildLibraryPublicPreviewPath(token: string, relativePath: string): string {
  return `/preview/library-files/${encodeURIComponent(token)}/${encodeRelativePath(relativePath)}`;
}

function encodeRelativePath(relativePath: string): string {
  return relativePath
    .replace(/\\/g, "/")
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function safeCompare(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.byteLength !== rightBuffer.byteLength) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function buildInvalidPreviewTokenError(): LibraryError {
  return new LibraryError(401, "FILE_PREVIEW_TOKEN_INVALID", "预览链接无效，请重新打开文件预览");
}
