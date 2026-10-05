/**
 * Shared harness for the A13 RPC tests.
 *
 * Builds a prototype-only `FinanceChatAgent` (same shape the existing REST
 * contract tests use) plus an in-memory R2 double, so the upload route and
 * the chat reference resolution can be exercised without a Worker runtime,
 * without network and without touching wrangler.jsonc.
 */

import { vi } from "vitest";
import type { UIMessage } from "agents/ai-chat-agent";
import { FinanceChatAgent } from "../../src/finance-chat-agent.js";
import type { R2BucketLike } from "../../src/attachments/storage.js";
import { attachRelayUsageStorage } from "../helpers/relay-usage-storage.js";

export type FakeBucket = {
  bucket: R2BucketLike;
  objects: Map<string, { body: ArrayBuffer; customMetadata?: Record<string, string> }>;
};

/** R2's real page size is 1000; small here so pagination is actually exercised. */
const LIST_PAGE_SIZE = 2;

export const createFakeBucket = (): FakeBucket => {
  const objects = new Map<string, { body: ArrayBuffer; customMetadata?: Record<string, string> }>();
  const bucket: R2BucketLike = {
    async put(key, value, options) {
      objects.set(key, { body: value, customMetadata: options?.customMetadata });
    },
    async get(key) {
      const found = objects.get(key);
      if (!found) return null;
      return { arrayBuffer: async () => found.body, customMetadata: found.customMetadata };
    },
    async delete(key) {
      objects.delete(key);
    },
    async list(options) {
      const prefix = options?.prefix ?? "";
      // F3: faithful to the real R2 API — `customMetadata` is returned ONLY when
      // `include` asks for it, and the listing is paginated by cursor. A fake
      // that always returned metadata would have hidden the broken cleanup.
      const withMetadata = options?.include?.includes("customMetadata") === true;
      const keys = [...objects.keys()].filter((key) => key.startsWith(prefix)).sort();
      const start = options?.cursor ? Number(options.cursor) : 0;
      const page = keys.slice(start, start + LIST_PAGE_SIZE);
      const end = start + page.length;
      return {
        objects: page.map((key) => {
          const stored = objects.get(key)!;
          return withMetadata ? { key, customMetadata: stored.customMetadata } : { key };
        }),
        truncated: end < keys.length,
        ...(end < keys.length ? { cursor: String(end) } : {}),
      };
    },
  };
  return { bucket, objects };
};

export type AttachmentTestAgent = {
  agent: FinanceChatAgent;
  persisted: UIMessage[];
  bucket: FakeBucket;
  /** Present only with `withKvStorage: true` — the fake DO KV the checkpoint uses. */
  kv?: Map<string, unknown>;
};

export const createAttachmentTestAgent = (
  options: { withBucket?: boolean; withKvStorage?: boolean; extraEnv?: Record<string, string> } = {},
): AttachmentTestAgent => {
  const persisted: UIMessage[] = [];
  const agent = Object.create(FinanceChatAgent.prototype) as FinanceChatAgent & {
    messages: UIMessage[];
    persistMessages: (msgs: UIMessage[]) => Promise<void>;
  };
  agent.messages = persisted;
  agent.persistMessages = vi.fn(async (msgs: UIMessage[]) => {
    persisted.push(...msgs);
  });
  // A19: `withKvStorage` turns `state.storage` into a Map-backed fake of the DO
  // KV surface (`get`/`put`/`delete`) the attachment cleanup checkpoint uses.
  const kv = new Map<string, unknown>();
  const stateStorage = options.withKvStorage === true
    ? {
        get: async (key: string) => kv.get(key),
        put: async (key: string, value: unknown) => {
          kv.set(key, value);
        },
        delete: async (key: string) => {
          kv.delete(key);
        },
      }
    : {};
  Object.defineProperty(agent, "state", { value: { storage: stateStorage }, writable: true, configurable: true });
  attachRelayUsageStorage(agent);

  const bucket = createFakeBucket();
  Object.defineProperty(agent, "env", {
    value: {
      API_ORIGIN: "https://api.test.local",
      AGENT_CONFIG_TOKEN: "config-test-token",
      ...(options.withBucket === false ? {} : { TED_ATTACHMENTS_BUCKET: bucket.bucket }),
      // A14: the double-lock envs (GROQ_API_KEY + TED_AUDIO_STT_ENABLED) are
      // opt-in per test, exactly as in the Worker env.
      ...(options.extraEnv ?? {}),
    },
    writable: true,
    configurable: true,
  });

  (agent as unknown as { resolveIntentionSnapshot: () => Promise<unknown> }).resolveIntentionSnapshot = async () => ({
    intention_id: "intent-test-1",
    version: 1,
    provider_id: "opencode-zen",
    model_id: "opencode-zen:zen-free-model",
    protocol: "chat-completions",
    rollout_percentage: 100,
    security_epoch: 1,
    fallback_provider_id: null,
    fallback_model_id: null,
    model_name: "zen-free-model",
    fallback_model_name: null,
    created_at: new Date().toISOString(),
  });

  return { agent, persisted, bucket, ...(options.withKvStorage === true ? { kv } : {}) };
};

/**
 * Serves the authority snapshot (H-14 — the turn is fail-closed without it)
 * and a claim-free relay answer. The snapshot shape is the real
 * `internalSnapshotSchema` contract, so the harness cannot drift into a
 * configuration that the production parser would reject.
 */
export const installRelayMock = (answer = "Resposta sem alegações financeiras."): void => {
  globalThis.fetch = (async (info: unknown) => {
    const url = String(info);
    if (url.includes("/internal/agent/llm-config")) {
      return Response.json({
        runtime: {
          singleton: "active",
          version: 3,
          securityEpoch: 1,
          activeProviderId: "opencode-zen",
          activeModelId: "opencode-zen:zen-1",
          activeProtocol: "chat-completions",
          activeRolloutPercentage: 100,
          activeRolloutMode: "all",
          fallbackProviderId: null,
          fallbackModelId: null,
          updatedBy: null,
        },
        activeProvider: null,
        activeModel: null,
        fallbackProvider: null,
        fallbackModel: null,
        activeDisabled: false,
        fallbackDisabled: false,
      });
    }
    return Response.json({ text: answer, providerAttempted: true });
  }) as unknown as typeof fetch;
};

export const uploadRequest = (
  body: ArrayBuffer,
  headers: Record<string, string> = {},
): Request =>
  new Request("https://agent.test.local/rpc/attachments", {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      "x-agent-actor": "actor-1",
      "x-agent-workspace": "ws-1",
      ...headers,
    },
    body,
  });

export const bytesOf = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
