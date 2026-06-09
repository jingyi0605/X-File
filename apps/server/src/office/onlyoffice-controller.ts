import type { FastifyReply, FastifyRequest } from "fastify";

import type { UpdateOnlyOfficeSettingsInput } from "@x-file/shared";

import { LibraryError } from "../library/library-errors.js";
import type { OnlyOfficeService } from "./onlyoffice-service.js";

interface OnlyOfficeCallbackParams {
  "*": string;
}

export class OnlyOfficeController {
  constructor(private readonly onlyOfficeService: OnlyOfficeService) {}

  readonly getSettings = async (_request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    reply.send(this.onlyOfficeService.getSettings());
  };

  readonly updateSettings = async (
    request: FastifyRequest<{ Body: UpdateOnlyOfficeSettingsInput }>,
    reply: FastifyReply
  ): Promise<void> => {
    reply.send(this.onlyOfficeService.updateSettings(request.body ?? {}));
  };

  readonly getStatus = async (_request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    reply.send(await this.onlyOfficeService.getStatus());
  };

  readonly handleCallback = async (
    request: FastifyRequest<{ Params: OnlyOfficeCallbackParams; Body: unknown }>,
    reply: FastifyReply
  ): Promise<void> => {
    reply.send(await this.onlyOfficeService.handleCallback(parseOnlyOfficeCallbackToken(request.params["*"]), request.body));
  };
}

function parseOnlyOfficeCallbackToken(rawTail: string | undefined): string {
  const token = decodeURIComponent(rawTail ?? "").trim();
  if (!token) {
    throw new LibraryError(401, "ONLYOFFICE_CALLBACK_TOKEN_INVALID", "ONLYOFFICE 回调 token 无效或已过期。");
  }
  return token;
}
