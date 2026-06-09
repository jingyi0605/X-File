import type { FastifyReply, FastifyRequest } from "fastify";

import type {
  CreateTagInput,
  EnsureTagInput,
  ListTagsInput,
  SaveDocumentTagsInput,
  SaveFolderTagsInput,
  UpdateTagInput,
  TagService
} from "./tag-service.js";

export class TagController {
  constructor(private readonly tagService: TagService) {}

  readonly listTags = async (
    request: FastifyRequest<{ Querystring: { includeDisabled?: string } }>,
    reply: FastifyReply
  ): Promise<void> => {
    const input: ListTagsInput = {
      includeDisabled: request.query.includeDisabled === "true"
    };
    reply.send(this.tagService.listTags(input));
  };

  readonly createTag = async (
    request: FastifyRequest<{ Body: CreateTagInput }>,
    reply: FastifyReply
  ): Promise<void> => {
    reply.send(this.tagService.createTag(request.body ?? {}));
  };

  readonly ensureTag = async (
    request: FastifyRequest<{ Body: EnsureTagInput }>,
    reply: FastifyReply
  ): Promise<void> => {
    reply.send(this.tagService.ensureTag(request.body ?? {}));
  };

  readonly getTagDetail = async (
    request: FastifyRequest<{ Params: { tagId: string } }>,
    reply: FastifyReply
  ): Promise<void> => {
    reply.send(this.tagService.getTagDetail(request.params.tagId));
  };

  readonly updateTag = async (
    request: FastifyRequest<{ Params: { tagId: string }; Body: UpdateTagInput }>,
    reply: FastifyReply
  ): Promise<void> => {
    reply.send(this.tagService.updateTag(request.params.tagId, request.body ?? {}));
  };

  readonly deleteTag = async (
    request: FastifyRequest<{ Params: { tagId: string } }>,
    reply: FastifyReply
  ): Promise<void> => {
    reply.send(this.tagService.deleteTag(request.params.tagId));
  };

  readonly getDocumentTagDetails = async (
    request: FastifyRequest<{ Params: { documentId: string } }>,
    reply: FastifyReply
  ): Promise<void> => {
    reply.send(this.tagService.getDocumentTagDetails(request.params.documentId));
  };

  readonly saveDocumentTags = async (
    request: FastifyRequest<{ Params: { documentId: string }; Body: SaveDocumentTagsInput }>,
    reply: FastifyReply
  ): Promise<void> => {
    reply.send(this.tagService.saveDocumentTags(request.params.documentId, request.body ?? {}));
  };

  readonly getFolderTagDetails = async (
    request: FastifyRequest<{ Querystring: { folderPath?: string } }>,
    reply: FastifyReply
  ): Promise<void> => {
    reply.send(this.tagService.getFolderTagDetails(request.query.folderPath ?? ""));
  };

  readonly saveFolderTags = async (
    request: FastifyRequest<{ Body: SaveFolderTagsInput }>,
    reply: FastifyReply
  ): Promise<void> => {
    reply.send(this.tagService.saveFolderTags(request.body ?? {}));
  };
}
