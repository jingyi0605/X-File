import fs from "node:fs";

import type { FastifyReply, FastifyRequest } from "fastify";
import type { LibraryPreview } from "@x-file/shared";

import type {
  LibraryOperationInput,
  LibraryService,
  ListLibraryDocumentsInput,
  ListLibraryFilesInput,
  PreviewLibraryFileInput,
  RefreshLibraryInput,
  SaveLibraryBindingInput,
  UpdateLibraryFavoritesInput
} from "./library-service.js";
import type { LibraryConfigService } from "./library-config-service.js";
import { toLibraryErrorResponse } from "./library-errors.js";
import type { LibraryPreviewLinkService } from "./preview-link-service.js";
import type { OnlyOfficeService } from "../office/onlyoffice-service.js";

export class LibraryController {
  constructor(
    private readonly libraryService: LibraryService,
    private readonly previewLinkService: LibraryPreviewLinkService,
    private readonly onlyOfficeService: OnlyOfficeService,
    private readonly libraryConfigService?: LibraryConfigService
  ) {}

  readonly getBinding = async (_request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    reply.send(this.libraryService.getBinding());
  };

  readonly saveBinding = async (
    request: FastifyRequest<{ Body: SaveLibraryBindingInput }>,
    reply: FastifyReply
  ): Promise<void> => {
    reply.send(this.libraryService.saveBinding(request.body ?? {}));
  };

  readonly getConfig = async (_request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    reply.send(this.requireConfigService().getConfig());
  };

  readonly saveConfig = async (
    request: FastifyRequest<{ Body: import("@x-file/shared").SaveLibraryConfigInput }>,
    reply: FastifyReply
  ): Promise<void> => {
    reply.send(this.requireConfigService().saveConfig(request.body ?? {}));
  };

  readonly getSnapshot = async (_request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    reply.send(this.libraryService.getSnapshot());
  };

  readonly listDocuments = async (
    request: FastifyRequest<{ Querystring: LibraryDocumentsQuery }>,
    reply: FastifyReply
  ): Promise<void> => {
    reply.send(this.libraryService.listDocuments(parseDocumentsQuery(request.query)));
  };

  readonly listFiles = async (
    request: FastifyRequest<{ Querystring: LibraryFilesQuery }>,
    reply: FastifyReply
  ): Promise<void> => {
    reply.send(this.libraryService.listFiles(parseFilesQuery(request.query)));
  };

  readonly previewFile = async (
    request: FastifyRequest<{ Querystring: LibraryPreviewQuery }>,
    reply: FastifyReply
  ): Promise<void> => {
    const filePath = request.query.path ?? "";
    const preview = this.libraryService.previewFile(parsePreviewQuery(request.query));

    if (preview.supported && (preview.kind === "html" || preview.kind === "image" || preview.kind === "pdf")) {
      const previewLink = this.previewLinkService.createLink(filePath);
      preview.previewPath = previewLink.previewPath;
      preview.previewUrl = buildAbsolutePreviewUrl(request, previewLink.previewPath);
    }

    if (preview.supported && preview.kind === "office") {
      preview.onlyOffice = this.onlyOfficeService.buildLibraryPreview({
        filePath,
        version: preview.version,
        editable: true,
        displayMode: normalizeOnlyOfficeDisplayMode(request.query.displayMode)
      });
      preview.previewUrl = preview.onlyOffice.documentUrl;
    }

    reply.send(preview);
  };

  readonly downloadFile = async (
    request: FastifyRequest<{ Querystring: LibraryPreviewQuery }>,
    reply: FastifyReply
  ): Promise<void> => {
    reply.send(this.libraryService.downloadFile(parsePreviewQuery(request.query)));
  };

  readonly operateFile = async (
    request: FastifyRequest<{ Body: LibraryOperationInput }>,
    reply: FastifyReply
  ): Promise<void> => {
    reply.send(this.libraryService.operateFile(request.body ?? {}));
  };

  readonly requestRefresh = async (
    request: FastifyRequest<{ Body: RefreshLibraryInput }>,
    reply: FastifyReply
  ): Promise<void> => {
    reply.send(this.libraryService.requestRefresh(request.body ?? {}));
  };

  readonly updateFavorites = async (
    request: FastifyRequest<{ Body: UpdateLibraryFavoritesInput }>,
    reply: FastifyReply
  ): Promise<void> => {
    reply.send(this.libraryService.updateFavorites(request.body ?? {}));
  };

  readonly servePublicPreview = async (
    request: FastifyRequest<{ Params: PublicPreviewParams }>,
    reply: FastifyReply
  ): Promise<void> => {
    try {
      const file = this.previewLinkService.resolvePublicFile(
        decodeURIComponent(request.params.token),
        decodeRelativePath(request.params["*"])
      );
      reply.header("content-type", file.contentType);
      reply.header("cache-control", "private, max-age=60");
      reply.send(fs.createReadStream(file.absolutePath));
    } catch (error) {
      const response = toLibraryErrorResponse(error);
      reply.code(response.statusCode).send(response.body);
    }
  };

  private requireConfigService(): LibraryConfigService {
    if (!this.libraryConfigService) {
      throw new Error("LibraryConfigService 未接入");
    }
    return this.libraryConfigService;
  }
}

interface LibraryDocumentsQuery {
  browseMode?: string;
  selectedFolderPath?: string;
  selectedTagPath?: string;
  selectedTagPaths?: string;
  selectedFavoriteId?: string;
  keyword?: string;
  offset?: string;
  limit?: string;
}

interface LibraryFilesQuery {
  path?: string;
  limit?: string;
}

interface LibraryPreviewQuery {
  path?: string;
  displayMode?: string;
}

interface PublicPreviewParams {
  token: string;
  "*": string;
}

function parseDocumentsQuery(query: LibraryDocumentsQuery): ListLibraryDocumentsInput {
  return {
    browseMode: query.browseMode === "tag" ? "tag" : "folder",
    selectedFolderPath: query.selectedFolderPath?.trim() ?? null,
    selectedTagPath: query.selectedTagPath?.trim() ?? null,
    selectedTagPaths: query.selectedTagPaths
      ?.split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0) ?? null,
    selectedFavoriteId: query.selectedFavoriteId?.trim() ?? null,
    keyword: query.keyword?.trim() ?? null,
    offset: query.offset ? Number(query.offset) : undefined,
    limit: query.limit ? Number(query.limit) : undefined
  };
}

function parseFilesQuery(query: LibraryFilesQuery): ListLibraryFilesInput {
  return {
    path: query.path?.trim() ?? null,
    limit: query.limit ? Number(query.limit) : undefined
  };
}

function parsePreviewQuery(query: LibraryPreviewQuery): PreviewLibraryFileInput {
  return {
    path: query.path?.trim() ?? null,
    displayMode: query.displayMode?.trim() ?? null
  };
}

function normalizeOnlyOfficeDisplayMode(value: string | undefined): "default" | "reading" {
  return value === "reading" ? "reading" : "default";
}

function buildAbsolutePreviewUrl(request: FastifyRequest, previewPath: string): string {
  const host = request.headers.host ?? "127.0.0.1";
  const protocol = request.headers["x-forwarded-proto"];
  const resolvedProtocol = typeof protocol === "string" && protocol.trim()
    ? protocol.split(",")[0]?.trim() || "http"
    : "http";
  return `${resolvedProtocol}://${host}${previewPath}`;
}

function decodeRelativePath(value: string | undefined): string {
  return (value ?? "")
    .split("/")
    .map((segment) => decodeURIComponent(segment))
    .join("/");
}
