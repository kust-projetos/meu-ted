/**
 * P2 — Executable contract of the first PWA read-only vertical slice.
 *
 * Characterization tests only: they pin observable A0 behavior the P2 adapter
 * must preserve. Not executed in this environment (no node_modules; install
 * attempted and timed out), so nothing here is proven green. Server-side enforcement
 * (membership revalidation, ADR-027 visibility predicate) is out of scope of
 * these mocks; titles and assertions below cover client-observable wire
 * behavior only, and server rules appear here solely as listed obligations.
 *
 * Slice independent of P1: no import from the OpenCode runtime and no
 * reference to an interface that does not exist yet. Everything below is
 * checkable against the current A0 code:
 *
 * - Identity (apps/agent/src/index.ts:5-69): signed connection token,
 *   canonical workspace, single-use consumption with membership
 *   revalidation, claims-derived device; cookie fallback (:72-108); proxy
 *   only forwards. Headers are never identity; consumption is never
 *   duplicated across both runtimes; `CallID` never becomes a financial
 *   `intentionId`.
 * - TedChat.tsx:1016-1070: late response dropped whole after workspace
 *   switch/logout (stale scope), `loadHistory` after success. Backend B will
 *   need coherent history + per-conversation pin — POST/DTO alone is not
 *   enough (see BLOCKED note at the end).
 * - Current `sendAgentMessage` exposes no `AbortSignal`: no end-to-end
 *   cancellation claim without test + implementation (see BLOCKED note).
  * - The gateway-only proxy is same-origin; the client sends its device
  *   connection token only to the authenticated proxy endpoint.
 * - SPEC section 7.7: PWA `messageId` travels as `intentionId`; retries reuse
 *   the same id; ADR-027 D3: collective default, private only via explicit
 *   opt-in.
 *
 * The BLOCKED comment at the end records the pending work that requires the
 * P1 interface (future module `@/lib/ted/opencode-runtime-adapter`, still
 * nonexistent — no import of it here, no scaffold invented).
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  sendAgentMessage,
  renewAgentSession,
  composeChatSend,
  isAnchorSupersededByHistory,
  isTurnAnswerConvergedByIdentity,
} from "@/lib/api/agent-client";

vi.mock("@/lib/api/agent-auth", () => ({
  fetchAgentConnectionToken: vi.fn(async () => "test-conn-token"),
  clearAgentConnectionTokenCache: vi.fn(),
  trackAgentConnection: vi.fn(() => ({
    signal: new AbortController().signal,
    release: () => undefined,
  })),
}));

type CapturedCall = { url: string; init: RequestInit };

const realFetch = globalThis.fetch;
let calls: CapturedCall[] = [];
let queued: Array<{ body: unknown; status: number }> = [];
let fetchMock: ReturnType<typeof vi.fn>;

function mockFetchOnce(body: unknown, status = 200): void {
  queued.push({ body, status });
}

function lastCall(): CapturedCall {
  const call = calls[calls.length - 1];
  if (!call) throw new Error("nenhuma chamada fetch capturada");
  return call;
}

function bodyJson(call: CapturedCall): Record<string, unknown> {
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Typed rejection capture. Resolves with the thrown error; FAILS if the call
// resolves, so a success can never be mistaken for the expected rejection.
type CapturedError = Error & { status?: number; code?: string };
async function rejectionOf(promise: Promise<unknown>): Promise<CapturedError> {
  try {
    await promise;
  } catch (e) {
    return e as CapturedError;
  }
  throw new Error("expected the call to reject, but it resolved");
}

// Never on the browser wire: secrets, runtime handles, native session, or attestation.
const FORBIDDEN_WIRE_KEYS = [
  "runtime",
  "runtimeSessionId",
  "opencode",
  "callId",
  "callID",
  "attestation",
  "token",
  "deviceId",
] as const;

beforeEach(() => {
  calls = [];
  queued = [];
  fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = queued.shift();
    if (next) {
      return new Response(
        typeof next.body === "string" ? next.body : JSON.stringify(next.body),
        { status: next.status, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({}), { status: 500 });
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  sessionStorage.clear();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  sessionStorage.clear();
});

describe("P2 contrato — sendAgentMessage preserva o fio A0", () => {
  it("POST no proxy same-origin com workspace no path e headers de escopo", async () => {
    mockFetchOnce({ turnId: "t-1", status: "completed", output: "Olá" });
    await sendAgentMessage("ws-1", "oi", { messageId: "msg-1" });
    const call = lastCall();
    expect(call.url).toBe("/api/agent/agents/finance-chat-agent/ws-1/rpc/chat");
    expect(call.init.method).toBe("POST");
    expect(call.init.credentials).toBe("include");
    const headers = call.init.headers as Record<string, string>;
    expect(headers["X-Workspace-Id"]).toBe("ws-1");
    expect(headers["x-agent-connection-token"]).toBe("test-conn-token");
  });

  it("corpo leva somente {text, intentionId} — messageId vira intentionId", async () => {
    mockFetchOnce({ turnId: "t-2", status: "completed", output: "ok" });
    await sendAgentMessage("ws-1", "Quais contas eu tenho?", { messageId: "msg-abc" });
    const payload = bodyJson(lastCall());
    expect(payload.text).toBe("Quais contas eu tenho?");
    expect(payload.intentionId).toBe("msg-abc");
    for (const key of FORBIDDEN_WIRE_KEYS) expect(payload).not.toHaveProperty(key);
  });

  it("sem messageId, gera identidade nova a cada envio (nunca dedup por texto)", async () => {
    mockFetchOnce({ turnId: "t-3", status: "completed", output: "a" });
    await sendAgentMessage("ws-1", "Bom dia");
    const first = bodyJson(lastCall()).intentionId;
    mockFetchOnce({ turnId: "t-4", status: "completed", output: "b" });
    await sendAgentMessage("ws-1", "Bom dia");
    const second = bodyJson(lastCall()).intentionId;
    expect(String(first)).toMatch(UUID_RE);
    expect(String(second)).toMatch(UUID_RE);
    expect(first).not.toBe(second);
  });

  it("retry com o mesmo messageId reenvia o mesmo intentionId (identidade estável no fio; efeito único é server-side)", async () => {
    mockFetchOnce({ turnId: "t-5", status: "completed", output: "a" });
    await sendAgentMessage("ws-1", "texto", { messageId: "retry-1" });
    const first = bodyJson(lastCall()).intentionId;
    mockFetchOnce({ turnId: "t-6", status: "completed", output: "b" });
    await sendAgentMessage("ws-1", "texto", { messageId: "retry-1" });
    expect(bodyJson(lastCall()).intentionId).toBe(first);
  });

  it("401 sem code do servidor vira auth.session_required com status (fail-closed, sem mascarar)", async () => {
    mockFetchOnce({ message: "sessão exigida" }, 401);
    const err = await rejectionOf(sendAgentMessage("ws-1", "oi", { messageId: "m-401" }));
    expect(err.status).toBe(401);
    expect(err.code).toBe("auth.session_required");
  });

  it("403 sem code do servidor vira auth.workspace_forbidden com status (mapeamento client-side, sem mascarar)", async () => {
    mockFetchOnce({ message: "proibido" }, 403);
    const err = await rejectionOf(sendAgentMessage("ws-1", "oi", { messageId: "m-403" }));
    expect(err.status).toBe(403);
    expect(err.code).toBe("auth.workspace_forbidden");
  });

  it("code do servidor atravessa intacto para a UX distinguir o estado", async () => {
    // token_replayed triggers exactly 1 single-use retry: two responses queued.
    mockFetchOnce({ code: "agent.token_replayed", message: "replay" }, 401);
    mockFetchOnce({ code: "agent.token_replayed", message: "replay" }, 401);
    const err = await rejectionOf(sendAgentMessage("ws-1", "oi", { messageId: "m-code" }));
    expect(err.code).toBe("agent.token_replayed");
    expect(calls.length).toBe(2);
  });

  it("200 sem output e sem decisão estruturada não inventa sucesso (sem output, sem card)", async () => {
    mockFetchOnce({ turnId: "t-empty", status: "completed" });
    const turn = await sendAgentMessage("ws-1", "oi", { messageId: "m-empty" });
    expect(turn.output).toBeUndefined();
    expect(turn.undoProposal).toBeUndefined();
  });
});

describe("P2 contrato — sinais de sessão/visibilidade no cliente (regras ADR-027 D3 vivem no servidor)", () => {
  it("renovação sem opts envia corpo vazio e não afirma visibilidade (default coletivo é server-side, fora do alcance deste mock)", async () => {
    mockFetchOnce({ ok: true, sessionId: "s-1", previousSessionId: null, messageCount: 0, summarized: false });
    const renewal = await renewAgentSession("ws-1");
    expect(bodyJson(lastCall())).toEqual({});
    expect(renewal.sessionId).toBe("s-1");
    expect(renewal.visibility).toBeUndefined();
  });

  it("cliente envia visibility:'private' só com opt-in explícito (gate é server-side, fora do mock)", async () => {
    mockFetchOnce({
      ok: true,
      sessionId: "s-2",
      previousSessionId: "s-1",
      messageCount: 3,
      summarized: false,
      visibility: "private",
      privateViewsEnabled: true,
    });
    const renewal = await renewAgentSession("ws-1", { visibility: "private" });
    expect(bodyJson(lastCall())).toEqual({ visibility: "private" });
    expect(renewal.visibility).toBe("private");
  });

  it("resposta com visibilidade desconhecida é rejeitada no parse (fail-closed no cliente)", async () => {
    mockFetchOnce({ ok: true, sessionId: "s-3", previousSessionId: null, messageCount: 0, summarized: false, visibility: "secret" });
    await expect(renewAgentSession("ws-1")).rejects.toThrow();
  });
});

describe("P2 contrato — identidade/dedup SPEC §7.7 (puro, sem rede)", () => {
  it("composeChatSend preserva messageId explícito e gera uuid caso contrário", () => {
    expect(composeChatSend("texto", { messageId: "fixo-1" }).messageId).toBe("fixo-1");
    expect(composeChatSend("texto").messageId).toMatch(UUID_RE);
  });

  it("resposta do turno só converge por identidade (texto igual sem intentionId não confirma)", () => {
    const history = [{ isOwn: false, content: "saldo R$ 10", intentionId: "outro-id" }];
    expect(isTurnAnswerConvergedByIdentity("saldo R$ 10", "envio-1", history)).toBe(false);
    expect(
      isTurnAnswerConvergedByIdentity("saldo R$ 10", "envio-1", [
        ...history,
        { isOwn: false, content: "saldo R$ 10", intentionId: "envio-1" },
      ]),
    ).toBe(true);
  });

  it("âncora com identidade divergente conhecida prova outro envio (nunca suprime)", () => {
    const anchor = { content: "Bom dia", createdAt: new Date(1000).toISOString(), messageId: "send-A" };
    const history = [
      { isOwn: true, content: "Bom dia", createdAt: new Date(2000).toISOString(), intentionId: "send-B" },
    ];
    expect(isAnchorSupersededByHistory(anchor, history)).toBe(false);
  });

  it("âncora é superada pelo próprio envio persistido (mesma identidade)", () => {
    const anchor = { content: "Bom dia", createdAt: new Date(1000).toISOString(), messageId: "send-A" };
    const history = [
      { isOwn: true, content: "Bom dia", createdAt: new Date(500).toISOString(), intentionId: "send-A" },
    ];
    expect(isAnchorSupersededByHistory(anchor, history)).toBe(true);
  });
});

/**
 * BLOCKED — pending work that requires the P1 interface (future module
 * `@/lib/ted/opencode-runtime-adapter`, still nonexistent; no import of it
 * here, no scaffold invented, no test placeholders — this note only).
 * Do not activate without: versioned P1 bootstrap, allowlist facade, A/B
 * session with re-bind, owner/visibility metadata, and a gateway resolving
 * actor/workspace/device server-side. Backend B needs coherent history + a
 * per-conversation pin (TedChat 1016-1070: stale-scope discard + loadHistory)
 * — POST/DTO alone does not prove READ_SLICE. End-to-end cancellation
 * requires AbortSignal in sendAgentMessage (absent today) + test +
 * implementation.
 * Future tests (to write once the P1 interface exists): flag off by default
 * preserving A0; per-conversation pin with no two runtimes in the same
 * message; READ_SLICE ("Quais contas eu tenho e quanto gastei em junho de
 * 2026?" -> two real tools -> DTO -> render); two identities with denials
 * and visibility; 401/403 with no empty data; AbortSignal cancellation;
 * dedup by messageId/intentionId and restart without re-execution.
 */
