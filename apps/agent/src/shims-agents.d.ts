declare module "agents/ai-chat-agent" {
  export interface UIMessagePart {
    type: string;
    text?: string;
    [key: string]: unknown;
  }

  export interface UIMessageMetadata {
    actorId?: string;
    workspaceId?: string;
    createdAt?: string;
    [key: string]: unknown;
  }

  export interface UIMessage {
    id: string;
    role: "user" | "assistant" | "system";
    parts: UIMessagePart[];
    metadata?: UIMessageMetadata;
  }

  export class AIChatAgent<Env = unknown> {
    constructor(ctx: DurableObjectState, env: Env);
    /** Durable Object context: durable SQLite lives at ctx.storage.sql. */
    ctx: DurableObjectState;
    /** Agent app state (per-connection/chat data) — never carries storage. */
    state: Record<string, unknown>;
    env: Env;
    messages?: UIMessage[];
    persistMessages(messages: UIMessage[]): Promise<void> | void;
    onConnect?(connection: unknown, ctx: unknown): Promise<void>;
    onChatMessage?(msg: unknown, ...args: unknown[]): Promise<unknown>;
    onMessage(connection: unknown, message: string): Promise<void>;
    static messageConcurrency?: string;
  }
}
declare module "agents" {
  export function routeAgentRequest(request: Request, env: Record<string, unknown>): Promise<Response | null>;
  export type AgentNamespace<_T = unknown> = { idFromName(name: string): unknown; get(id: unknown): unknown };
}
declare module "ai" {
  export function streamText(...args: unknown[]): unknown;
  export function generateText(...args: unknown[]): Promise<{ text: string; usage?: unknown; finishReason?: string }>;
  export type LanguageModel = unknown;
  // Part A cognitive wiring: loosely typed so the edge shim stays small;
  // runtime semantics come from the real `ai` package (v5).
  export function tool(...args: unknown[]): unknown;
  export function jsonSchema(...args: unknown[]): unknown;
  export function stepCountIs(...args: unknown[]): unknown;
}
declare module "@cloudflare/ai-chat" {
  export type UIMessage = unknown;
}
