/**
 * A19 closure (Slice 1) — the Worker gateway for `POST /rpc/attachments`.
 *
 * REAL end-to-end path under test: the actual Worker default export (auth →
 * route allowlist → bounded body read → identity stamping) forwarding into a
 * REAL `FinanceChatAgent` Durable Object (binding check → ingest → R2 double).
 * Nothing is stubbed between the two hops, so a regression in either the
 * route allowlist or the per-route body ceiling fails here.
 *
 * The load-bearing cases are the size ones: the chat JSON ceiling (2 MB) must
 * NOT leak into the attachment route (the A13 contract allows 10/15 MB per
 * kind), and neither may the attachment ceiling leak into chat.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/worker.js";
import { createAgentConnectionToken } from "../../api/src/auth/agent-connection-token.js";
import { createAttachmentTestAgent, bytesOf, type FakeBucket } from "./attachments/helpers.js";
import { pdfBytes, pngBytes, wavBytesWithDuration, scriptBytes } from "./attachments/fixtures.js";

type WorkerEnv = Parameters<typeof worker.fetch>[1];

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const ALIAS_ID = "11111111-1111-4111-8111-111111111111";
const ACTOR_ID = "user-test-1";
const SECRET = "secret-for-testing-purposes-at-least-32-chars!";
const PWA_ORIGIN = "https://pwa.example";

const CHAT_LIMIT = 2 * 1024 * 1024;
/** Mirrors `ATTACHMENT_LIMITS.pdf.maxBytes` — the largest kind ceiling. */
const ATTACHMENT_CEILING = 15 * 1024 * 1024;

const uploadPath = (workspaceId = WORKSPACE_ID) =>
  `https://agent.test.local/agents/finance-chat-agent/${workspaceId}/rpc/attachments`;

/**
 * Mocks the two upstream authority endpoints the Worker uses: canonical
 * workspace resolution (returns `canonicalId` for any alias) and the
 * single-use connection-token consumption.
 */
const mockAuthUpstream = (options: { canonicalId?: string; consumed?: boolean } = {}) => {
  const canonicalId = options.canonicalId ?? WORKSPACE_ID;
  const consumed = options.consumed ?? true;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (info) => {
    const url = String(info);
    if (url.includes("/internal/workspace-alias/")) {
      return Response.json({ canonicalHouseholdId: canonicalId });
    }
    if (url.includes("/internal/agent/consume-token")) {
      // Replay is signalled by the HTTP STATUS (409), not by a body flag:
      // `consumeAgentToken` only looks at the status code.
      return consumed ? Response.json({ ok: true, consumed: true }) : new Response("replayed", { status: 409 });
    }
    // Cookie fallback (no connection token): the authority refuses the
    // membership lookup, so the Worker denies BEFORE any DO hop.
    if (url.includes("/workspaces/") && url.includes("/members")) {
      return Response.json({ code: "agent.workspace_forbidden" }, { status: 403 });
    }
    if (url.includes("/auth/get-session")) {
      return Response.json({ code: "agent.session_required" }, { status: 401 });
    }
    return new Response("unexpected upstream", { status: 500 });
  });
};

const tokenFor = async (overrides: Record<string, unknown> = {}) =>
  createAgentConnectionToken(
    { sub: ACTOR_ID, workspace: WORKSPACE_ID, role: "owner", ...overrides },
    SECRET,
  );

type Harness = {
  env: WorkerEnv;
  bucket: FakeBucket | null;
  doCalls: Request[];
};

const harness = (options: { withBucket?: boolean; consumed?: boolean; canonicalId?: string } = {}): Harness => {
  // The DO-side connection-binding check (H-07) only runs when the DO knows
  // the secret — which is the real configuration, so the harness mirrors it:
  // the Worker forwards the client token, the DO re-verifies it against the
  // stamped identity.
  const created = createAttachmentTestAgent({
    ...(options.withBucket === false ? { withBucket: false } : {}),
    extraEnv: { AGENT_CONNECTION_TOKEN_SECRET: SECRET },
  });
  const doCalls: Request[] = [];
  const env = {
    FINANCE_CHAT_AGENT: {
      idFromName: vi.fn((name: string) => ({ name }) as unknown as DurableObjectId),
      get: vi.fn(() => ({
        fetch: async (req: Request) => {
          doCalls.push(req);
          return created.agent.fetch(req);
        },
      })),
    },
    API_ORIGIN: "https://api.test.local",
    AGENT_CONNECTION_TOKEN_SECRET: SECRET,
    AGENT_AUTH_SERVICE_TOKEN: "test-auth-service-token",
    // The DO owns the binding; the Worker only passes it through (the DO's own
    // env is the one that decides the capability). Declared here for honesty.
    ...(options.withBucket === false ? {} : { TED_ATTACHMENTS_BUCKET: created.bucket.bucket }),
  } as unknown as WorkerEnv;
  return { env, bucket: created.bucket, doCalls };
};

const uploadRequest = async (options: {
  body: BodyInit;
  kind?: string;
  name?: string;
  headers?: Record<string, string>;
  token?: string | null;
  workspaceId?: string;
  withContentLength?: boolean;
}): Promise<Request> => {
  const headers = new Headers({
    "content-type": "application/octet-stream",
    origin: PWA_ORIGIN,
    ...(options.headers ?? {}),
  });
  const token = options.token === undefined ? await tokenFor() : options.token;
  if (token) headers.set("x-agent-connection-token", token);
  if (options.kind !== undefined) headers.set("x-ted-attachment-kind", options.kind);
  if (options.name !== undefined) headers.set("x-ted-attachment-name", options.name);
  const init: RequestInit & { duplex?: "half" } = { method: "POST", headers, body: options.body };
  if (!options.withContentLength && typeof options.body !== "string") {
    // Node/undici sets content-length for known-size buffers; the streamed
    // cases build their own Request to control it.
  }
  return new Request(uploadPath(options.workspaceId ?? WORKSPACE_ID), init as RequestInit);
};

/** A valid PNG header followed by `padBytes` of padding (magic bytes real). */
const largePng = (padBytes: number): ArrayBuffer => {
  const head = pngBytes(4, 4);
  const out = new Uint8Array(head.byteLength + padBytes);
  out.set(head, 0);
  return bytesOf(out);
};

const largePdf = (padBytes: number): ArrayBuffer => {
  const head = pdfBytes(1, 4);
  const out = new Uint8Array(head.byteLength + padBytes);
  out.set(head, 0);
  return bytesOf(out);
};

/**
 * A REAL WAV header whose declared `dataSize` keeps the duration at 100 s
 * (below the 120 s ceiling) while the buffer itself is as large as requested —
 * the "samples" past the header are zeroed, exactly like the A13 fixtures.
 */
const largeWav = (totalBytes: number): ArrayBuffer => {
  const at100Seconds = wavBytesWithDuration(100);
  const out = new Uint8Array(Math.max(totalBytes, at100Seconds.byteLength));
  out.set(at100Seconds, 0);
  return bytesOf(out);
};

describe("A19 slice 1: Worker attachment gateway (real Worker → real DO)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("routes an authenticated upload through the real DO and stores the record (RED was 404)", async () => {
    mockAuthUpstream();
    const { env, bucket } = harness();
    const res = await worker.fetch(
      await uploadRequest({
        body: largePng(1024),
        kind: "image",
        name: "comprovante.png",
      }),
      env,
    );

    expect(res.status).toBe(200);
    const payload = (await res.json()) as { ref: string; kind: string; size: number };
    expect(payload.kind).toBe("image");
    expect(payload.ref).toMatch(/^att_/);
    expect(bucket!.objects.size).toBe(1);
    const stored = [...bucket!.objects.values()][0]!;
    expect(stored.customMetadata?.['workspaceId']).toBe(WORKSPACE_ID);
    expect(stored.customMetadata?.['actorId']).toBe(ACTOR_ID);
  });

  it("keeps the 2 MB chat ceiling unchanged: oversized chat RPC → 413, DO never reached", async () => {
    mockAuthUpstream();
    const { env, doCalls } = harness();
    const token = await tokenFor();
    const req = new Request(
      `https://agent.test.local/agents/finance-chat-agent/${WORKSPACE_ID}/rpc/chat`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-agent-connection-token": token,
          origin: PWA_ORIGIN,
        },
        body: JSON.stringify({ text: "x".repeat(CHAT_LIMIT + 1), intentionId: "intent-oversize-1" }),
      },
    );
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual(expect.objectContaining({ code: "agent.payload_too_large" }));
    expect(doCalls).toHaveLength(0);
  });

  it("accepts a valid PNG between 2 MB and 10 MB (reaches the DO, 200)", async () => {
    mockAuthUpstream();
    const { env, doCalls } = harness();
    const body = largePng(3 * 1024 * 1024);
    expect(body.byteLength).toBeGreaterThan(CHAT_LIMIT);
    expect(body.byteLength).toBeLessThan(10 * 1024 * 1024);

    const res = await worker.fetch(
      await uploadRequest({ body, kind: "image", name: "grande.png" }),
      env,
    );
    expect(res.status).toBe(200);
    expect(doCalls).toHaveLength(1);
    expect((await res.json()) as { size: number }).toMatchObject({ size: body.byteLength });
  });

  it("accepts valid audio bytes between 2 MB and 10 MB (reaches the DO, 200)", async () => {
    mockAuthUpstream();
    const { env, doCalls } = harness();
    const body = largeWav(3 * 1024 * 1024);
    expect(body.byteLength).toBeGreaterThan(CHAT_LIMIT);

    const res = await worker.fetch(
      await uploadRequest({ body, kind: "audio", name: "audio.wav" }),
      env,
    );
    expect(res.status).toBe(200);
    expect(doCalls).toHaveLength(1);
  });

  it("accepts a valid PDF between 2 MB and 15 MB (reaches the DO, 200)", async () => {
    mockAuthUpstream();
    const { env, doCalls } = harness();
    const body = largePdf(3 * 1024 * 1024);
    expect(body.byteLength).toBeGreaterThan(CHAT_LIMIT);

    const res = await worker.fetch(
      await uploadRequest({ body, kind: "pdf", name: "extrato.pdf" }),
      env,
    );
    expect(res.status).toBe(200);
    expect(doCalls).toHaveLength(1);
  });

  it("rejects a body above the attachment ceiling with 413 from the WORKER (DO never reached)", async () => {
    mockAuthUpstream();
    const { env, doCalls } = harness();
    const body = largePdf(ATTACHMENT_CEILING + 1);
    expect(body.byteLength).toBeGreaterThan(ATTACHMENT_CEILING);

    const res = await worker.fetch(
      await uploadRequest({ body, kind: "pdf", name: "grande.pdf" }),
      env,
    );
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual(expect.objectContaining({ code: "agent.payload_too_large" }));
    expect(doCalls).toHaveLength(0);
  });

  it("enforces the hard limit on a chunked upload with NO Content-Length (mid-read 413)", async () => {
    mockAuthUpstream();
    const { env, doCalls } = harness();
    const chunk = new Uint8Array(256 * 1024);
    chunk.set(pngBytes(4, 4), 0);
    const totalChunks = Math.ceil((ATTACHMENT_CEILING + 1) / chunk.byteLength);
    let emitted = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (emitted >= totalChunks) {
          controller.close();
          return;
        }
        emitted += 1;
        controller.enqueue(chunk);
      },
    });
    const req = new Request(uploadPath(), {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-agent-connection-token": await tokenFor(),
        "x-ted-attachment-kind": "image",
        "x-ted-attachment-name": "stream.png",
        origin: PWA_ORIGIN,
      },
      body: stream,
      // @ts-expect-error duplex is required for streamed bodies outside browsers
      duplex: "half",
    });

    const res = await worker.fetch(req, env);
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual(expect.objectContaining({ code: "agent.payload_too_large" }));
    expect(doCalls).toHaveLength(0);
  });

  it("does not let an under-declared Content-Length bypass the hard limit (mid-stream abort)", async () => {
    mockAuthUpstream();
    const { env, doCalls } = harness();
    const chunk = new Uint8Array(256 * 1024);
    chunk.set(pdfBytes(1, 4), 0);
    const totalChunks = Math.ceil((ATTACHMENT_CEILING + 1) / chunk.byteLength);
    let emitted = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (emitted >= totalChunks) {
          controller.close();
          return;
        }
        emitted += 1;
        controller.enqueue(chunk);
      },
    });
    const req = new Request(uploadPath(), {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        // Lying low on purpose: the declared length passes the up-front check,
        // so only the mid-read counter can reject the body.
        "content-length": "1024",
        "x-agent-connection-token": await tokenFor(),
        "x-ted-attachment-kind": "pdf",
        "x-ted-attachment-name": "mentiroso.pdf",
        origin: PWA_ORIGIN,
      },
      body: stream,
      // @ts-expect-error duplex is required for streamed bodies outside browsers
      duplex: "half",
    });

    const res = await worker.fetch(req, env);
    expect(res.status).toBe(413);
    expect(doCalls).toHaveLength(0);
  });

  it("rejects an unauthorized upload (consumed:false) with 401 and never reaches the DO", async () => {
    mockAuthUpstream({ consumed: false });
    const { env, doCalls } = harness();
    const res = await worker.fetch(
      await uploadRequest({ body: largePng(1024), kind: "image", name: "x.png" }),
      env,
    );
    expect(res.status).toBe(401);
    expect(doCalls).toHaveLength(0);
  });

  it("rejects an upload with no connection token with 403 and never reaches the DO", async () => {
    mockAuthUpstream();
    const { env, doCalls } = harness();
    const res = await worker.fetch(
      await uploadRequest({ body: largePng(1024), kind: "image", name: "x.png", token: null }),
      env,
    );
    expect(res.status).toBe(403);
    expect(doCalls).toHaveLength(0);
  });

  it("stores an aliased request under the CANONICAL workspace identity", async () => {
    mockAuthUpstream({ canonicalId: WORKSPACE_ID });
    const { env, bucket, doCalls } = harness();
    const res = await worker.fetch(
      await uploadRequest({
        body: largePng(1024),
        kind: "image",
        name: "alias.png",
        workspaceId: ALIAS_ID,
      }),
      env,
    );
    expect(res.status).toBe(200);
    const stored = [...bucket!.objects.values()][0]!;
    expect(stored.customMetadata?.['workspaceId']).toBe(WORKSPACE_ID);
    expect(stored.customMetadata?.['workspaceId']).not.toBe(ALIAS_ID);
    // The DO is named by the canonical id too (C-05).
    expect(vi.mocked(env.FINANCE_CHAT_AGENT.idFromName).mock.calls[0]?.[0]).toBe(WORKSPACE_ID);
    expect(doCalls).toHaveLength(1);
  });

  it("keeps a nonexistent RPC route at 404", async () => {
    mockAuthUpstream();
    const { env, doCalls } = harness();
    const res = await worker.fetch(
      new Request(`https://agent.test.local/agents/finance-chat-agent/${WORKSPACE_ID}/rpc/nonexistent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-agent-connection-token": await tokenFor(), origin: PWA_ORIGIN },
        body: "{}",
      }),
      env,
    );
    expect(res.status).toBe(404);
    expect(doCalls).toHaveLength(0);
  });

  it("overrides client-sent identity headers (actor, workspace, device) with the stamped ones", async () => {
    mockAuthUpstream();
    const { env, bucket } = harness();
    const res = await worker.fetch(
      await uploadRequest({
        body: largePng(1024),
        kind: "image",
        name: "spoof.png",
        headers: {
          "x-agent-actor": "attacker",
          "x-agent-workspace": "other-ws",
          "x-agent-device": "attacker-device",
        },
        // The token carries a device, so the Worker stamps THAT device and the
        // DO-side binding check compares against it.
        token: await tokenFor({ deviceId: "device-real-1" }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const stored = [...bucket!.objects.values()][0]!;
    expect(stored.customMetadata?.['actorId']).toBe(ACTOR_ID);
    expect(stored.customMetadata?.['workspaceId']).toBe(WORKSPACE_ID);
  });

  it("answers 503 attachment_storage_unavailable when the storage binding is absent", async () => {
    mockAuthUpstream();
    const { env, doCalls } = harness({ withBucket: false });
    const res = await worker.fetch(
      await uploadRequest({ body: largePng(1024), kind: "image", name: "sem-bucket.png" }),
      env,
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual(
      expect.objectContaining({ code: "attachment_storage_unavailable" }),
    );
    // The DO WAS reached (it owns the capability switch); nothing was stored.
    expect(doCalls).toHaveLength(1);
  });

  it("answers 400 attachment_mime_mismatch when the bytes are not the declared kind", async () => {
    mockAuthUpstream();
    const { env, bucket } = harness();
    const res = await worker.fetch(
      await uploadRequest({
        body: bytesOf(scriptBytes()),
        kind: "image",
        name: "malicioso.png",
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(
      expect.objectContaining({ code: "attachment_mime_mismatch" }),
    );
    expect(bucket!.objects.size).toBe(0);
  });
});

describe("A19 slice 1: attachment headers are CORS-allowlisted", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("advertises the attachment kind/name headers on the preflight", async () => {
    const res = await worker.fetch(
      new Request(`https://agent.test.local/agents/finance-chat-agent/${WORKSPACE_ID}/rpc/attachments`, {
        method: "OPTIONS",
        headers: { origin: PWA_ORIGIN },
      }),
      {} as WorkerEnv,
    );
    expect(res.status).toBe(204);
    const allowed = (res.headers.get("access-control-allow-headers") ?? "").toLowerCase();
    expect(allowed).toContain("x-ted-attachment-kind");
    expect(allowed).toContain("x-ted-attachment-name");
  });

  it("does not spend an upstream call on a preflight", async () => {
    await worker.fetch(
      new Request(`https://agent.test.local/agents/finance-chat-agent/${WORKSPACE_ID}/rpc/attachments`, {
        method: "OPTIONS",
        headers: { origin: PWA_ORIGIN },
      }),
      {} as WorkerEnv,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});