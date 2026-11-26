import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import type { ModelProvider } from "../../../providers/types.js";
import type { SourcedAnswerProvider } from "../answers/service.js";

export interface PersonalChatDependencies {
  pool: Pool;
  model: ModelProvider;
  answerProvider?: SourcedAnswerProvider;
  sessionCookieName: string;
  cursorSigningSecret: string;
  rateLimitSecret: string;
  sessionCookieSecure: boolean;
  modelTimeoutMs: number;
  chatLimit: number;
  chatWindowSeconds: number;
  readLimit: number;
  readWindowSeconds: number;
  deleteLimit: number;
  deleteWindowSeconds: number;
}

export interface RouteContext {
  request: IncomingMessage;
  response: ServerResponse;
  requestId: string;
  deps: PersonalChatDependencies;
  personId?: string;
}
