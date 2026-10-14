/**
 * A14 / R12 — áudio no TURNO (AC22), nível de gateway.
 *
 * O que estes testes provam, do maior risco ao menor:
 *
 * - **nunca autoexecução**: um turno só com áudio (sem texto) chega no máximo a
 *   proposta/draft com a confirmação vigente; nenhum POST de escrita sai. A
 *   garantia é ESTRUTURAL: o texto composto carrega o aviso de proveniência
 *   como primeiro token, e `isAutoExecutionEligible` (o gate real do
 *   autoexecute) exige um imperativo mutacional no INÍCIO do texto — logo um
 *   turno com transcrição é sempre inelegível, com ou sem número mal transcrito;
 * - um número/negação mal transcritos seguem o fluxo de confirmação existente
 *   (candidato ⇒ proposta manual), nunca uma escrita direta;
 * - timeout do STT degrada para `failed` com motivo e o texto do usuário segue
 *   intacto no turno;
 * - bytes (e base64 de bytes) nunca aparecem em log, evento ou resposta.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AUDIO_TRANSCRIPT_NOTICE,
  composeTurnTextWithTranscript,
} from "../../src/multimodal/groq-stt.js";
import { getAttachmentStorage } from "../../src/attachments/storage.js";
import { ingestAttachment } from "../../src/attachments/ingest.js";
import { interpretMutationUtterance } from "../../src/mutations/semantic-interpretation.js";
import {
  ConversationOrchestrator,
  normalizeRestTurn,
} from "../../src/orchestration/conversation-orchestrator.js";
import { InMemoryMutationDraftStore } from "../../src/mutations/mutation-draft.js";
import { isAutoExecutionEligible } from "../../src/safety/auto-execution.js";
import { bytesOf, createAttachmentTestAgent, installRelayMock } from "./helpers.js";

const IDENTITY = { workspaceId: "ws-1", actorId: "actor-1" };

/** Bytes de áudio com um marcador legível: se vazar, o teste grita. */
const SECRET_MARKER = "MARKER-BYTES-NUNCA-EM-LOG";
const audioBytes = (): Uint8Array => {
  const bytes = new Uint8Array(96);
  bytes.set([0x1a, 0x45, 0xdf, 0xa3], 0);
  bytes.set(new TextEncoder().encode("webm"), 32);
  bytes.set(new TextEncoder().encode(SECRET_MARKER), 64);
  return bytes;
};

/** Intercepts only the Groq host; everything else keeps the relay mock. */
const installFetchMock = (groq: (init: RequestInit) => Promise<Response>) => {
  installRelayMock();
  const previous = globalThis.fetch;
  const groqCalls: RequestInit[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    if (String(input).includes("api.groq.com")) {
      groqCalls.push(init);
      return groq(init);
    }
    return previous(input, init);
  }) as unknown as typeof fetch;
  return { groqCalls };
};

const transcriptResponse = (text: string) =>
  new Response(JSON.stringify({ text }), { status: 200, headers: { "content-type": "application/json" } });

const chatRequest = (body: unknown, headers: Record<string, string> = {}): Request =>
  new Request("https://agent.test.local/rpc/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-agent-actor": "actor-1",
      "x-agent-workspace": "ws-1",
      ...headers,
    },
    body: JSON.stringify(body),
  });

const uploadAudioRef = async (agent: unknown): Promise<string> => {
  const storage = getAttachmentStorage((agent as { env: unknown }).env)!;
  const uploaded = await ingestAttachment({
    storage,
    identity: IDENTITY,
    kind: "audio",
    name: "nota-de-voz.webm",
    bytes: bytesOf(audioBytes()),
  });
  return uploaded.ref;
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("A14/AC22 — turn text com proveniência (dado, nunca instrução)", () => {
  it("o aviso de proveniência abre o texto e a transcrição entra junto do texto do usuário", async () => {
    const { groqCalls } = installFetchMock(async () => transcriptResponse("qual o meu saldo hoje?"));
    const { agent, persisted } = createAttachmentTestAgent({
      extraEnv: { GROQ_API_KEY: "gsk-test-key", TED_AUDIO_STT_ENABLED: "1", TED_AUDIO_STT_COHORT: "*" },
    });
    const ref = await uploadAudioRef(agent);

    const res = await agent.fetch(
      chatRequest({
        text: "olá",
        intentionId: "intent-stt-1",
        attachments: [{ type: "audio", ref, name: "nota-de-voz.webm" }],
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      attachmentStates?: Array<{ ref: string; state: string; detail: string }>;
    };
    expect(body.status).toBe("completed");
    expect(body.attachmentStates?.[0]?.state).toBe("processed");
    // O estado do turno é metadado: a transcrição NÃO é ecoada na resposta.
    expect(JSON.stringify(body)).not.toContain("saldo hoje");

    const persistedText = JSON.stringify(persisted);
    expect(persistedText).toContain("olá");
    expect(persistedText).toContain("qual o meu saldo hoje?");
    expect(persistedText).toContain(AUDIO_TRANSCRIPT_NOTICE);
    expect(groqCalls).toHaveLength(1);
  });

  it("timeout do STT: estado 'failed' explícito e o texto do usuário é preservado", async () => {
    installFetchMock(
      async () =>
        new Promise<Response>((_resolve, reject) => {
          setTimeout(() => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), 5);
        }),
    );
    const { agent, persisted } = createAttachmentTestAgent({
      extraEnv: { GROQ_API_KEY: "gsk-test-key", TED_AUDIO_STT_ENABLED: "1", TED_AUDIO_STT_COHORT: "*", TED_AUDIO_STT_TIMEOUT_MS: "1" },
    });
    const ref = await uploadAudioRef(agent);

    const res = await agent.fetch(
      chatRequest({
        text: "qual o meu saldo hoje?",
        intentionId: "intent-stt-timeout",
        attachments: [{ type: "audio", ref, name: "nota-de-voz.webm" }],
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { attachmentStates?: Array<{ state: string; detail: string }> };
    expect(body.attachmentStates?.[0]?.state).toBe("failed");
    expect(body.attachmentStates?.[0]?.detail).toBeTruthy();
    // A entrada textual do usuário acompanha e é processada normalmente.
    expect(JSON.stringify(persisted)).toContain("qual o meu saldo hoje?");
  });

  it("sem as duas envs o áudio continua 'unsupported' e nenhuma requisição sai (byte a byte igual à A13)", async () => {
    const { groqCalls } = installFetchMock(async () => transcriptResponse("nunca chamado"));
    const { agent, persisted } = createAttachmentTestAgent();
    const ref = await uploadAudioRef(agent);

    const res = await agent.fetch(
      chatRequest({
        text: "anota isso",
        intentionId: "intent-stt-off",
        attachments: [{ type: "audio", ref, name: "nota-de-voz.webm" }],
      }),
    );

    const body = (await res.json()) as { attachmentStates?: Array<{ state: string }> };
    expect(body.attachmentStates?.[0]?.state).toBe("unsupported");
    expect(groqCalls).toHaveLength(0);
    expect(JSON.stringify(persisted)).not.toContain("nunca chamado");
  });

  it("bytes e base64 de bytes NUNCA aparecem em log, evento ou resposta", async () => {
    installFetchMock(async () => transcriptResponse("gastei 50 reais no mercado"));
    const logs: string[] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logs.push(args.map((value) => (typeof value === "string" ? value : JSON.stringify(value))).join(" "));
      });
    }
    const { agent, persisted } = createAttachmentTestAgent({
      extraEnv: { GROQ_API_KEY: "gsk-test-key", TED_AUDIO_STT_ENABLED: "1", TED_AUDIO_STT_COHORT: "*" },
    });
    const ref = await uploadAudioRef(agent);

    const res = await agent.fetch(
      chatRequest({
        text: "anota isso",
        intentionId: "intent-stt-bytes",
        attachments: [{ type: "audio", ref, name: "nota-de-voz.webm" }],
      }),
    );

    const raw = bytesOf(audioBytes());
    const base64 = Buffer.from(new Uint8Array(raw)).toString("base64");
    const everything = JSON.stringify({ logs, persisted, body: await res.clone().json() });
    expect(everything).not.toContain(SECRET_MARKER);
    expect(everything).not.toContain(base64);
    expect(everything).not.toContain("nota-de-voz.webm");
  });
});

describe("A14/AC22 — nunca autoexecução (AC22 §5)", () => {
  it("turno SÓ com áudio: nenhuma escrita direta, no máximo proposta com a confirmação vigente", async () => {
    const apiCalls: string[] = [];
    const groqCalls: RequestInit[] = [];
    installRelayMock();
    const previous = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input);
      if (url.includes("api.groq.com")) {
        groqCalls.push(init);
        return transcriptResponse("gastei 50 reais no mercado");
      }
      if (url.includes("api.test.local")) apiCalls.push(`${init.method ?? "GET"} ${url}`);
      return previous(input, init);
    }) as unknown as typeof fetch;

    const { agent } = createAttachmentTestAgent({
      extraEnv: { GROQ_API_KEY: "gsk-test-key", TED_AUDIO_STT_ENABLED: "1", TED_AUDIO_STT_COHORT: "*" },
    });
    // A factory do cliente ELEVADO é a porta de entrada do autoexecute: se ela
    // não é nem construída, o fast path é estruturalmente inalcançável.
    const elevated = vi.fn(() => undefined);
    (agent as unknown as { elevatedMutationApiClientForTurn: typeof elevated }).elevatedMutationApiClientForTurn =
      elevated;

    const ref = await uploadAudioRef(agent);

    const res = await agent.fetch(
      chatRequest({
        text: "",
        intentionId: "intent-stt-audio-only",
        attachments: [{ type: "audio", ref, name: "nota-de-voz.webm" }],
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("completed");
    expect(groqCalls).toHaveLength(1);
    // Nenhum cliente elevado (⇒ nenhum autoexecute) e nenhuma escrita financeira.
    expect(elevated).not.toHaveBeenCalled();
    expect(apiCalls.filter((call) => /execute|confirm/i.test(call))).toEqual([]);
  });

  // The one utterance shape that BOTH parses as a mutation candidate AND passes
// the autoexecute eligibility gate (`hasExplicitMutationIntent` requires a
// leading imperative). If it were typed by hand it would autoexecute, so it is
// the honest adversarial probe for a mistranscribed audio. Same text the
// existing autoexecute suite characterizes; the plan is injected (as there) so
// the pair isolates the ELIGIBILITY GATE and nothing else.
const AUTOEXECUTABLE_UTTERANCE = "Registre R$ 35 de almoço no Nubank na categoria Almoço";

it("no nível do orquestrador, o MESMO texto transcrito nunca autoriza/executa — o digitado sim", async () => {
    // The autoexecute fast path lives in the orchestrator. This drives it with
    // an ELEVATED client present, so "no write" cannot be explained by a
    // missing transport: it is the eligibility gate refusing.
    const elevatedAuthorize = vi.fn(async () => ({ operationId: "op-1", attestation: "att" }));
    const elevatedExecute = vi.fn(async () => ({ operationId: "op-1", status: "succeeded" as const }));
    const client = {
      propose: vi.fn(async () => ({
        id: "op-1",
        existing: false,
        operation: { id: "op-1", status: "proposed", expiresAt: 0 },
        summary: "almoço",
      })),
      duplicateSuspectedStrict: vi.fn(async () => false),
      authorize: elevatedAuthorize,
      executeAuthorized: elevatedExecute,
      listActive: vi.fn(async () => ({ items: [], total: 0 })),
    };
    const run = async (text: string) => {
      const orchestrator = new ConversationOrchestrator({
        draftStore: new InMemoryMutationDraftStore(),
        plan: () => ({
          version: "2" as const,
          mode: "mutation-proposal" as const,
          domain: "transactions" as const,
          skillNames: [],
          requestedOperations: [{ name: "transactions.expense.create", kind: "mutation" as const }],
          missingFields: [],
          ambiguity: null,
          confidence: 1,
        }),
        mutationApiClient: client as never,
        autoExecutionClient: () => client as never,
        entityReader: {
          listAccounts: async () => [{ id: "00000000-0000-4000-8000-000000000001", name: "Nubank" }],
          listCategories: async () => [{ id: "00000000-0000-4000-8000-000000000011", name: "Almoço" }],
        },
      });
      return orchestrator.runTurn(
        normalizeRestTurn({ text, intentionId: `intent-${Math.random().toString(36).slice(2, 8)}` }, {
          actorId: "actor-1",
          workspaceId: "ws-1",
          role: "member",
          deviceId: "device-1",
        }),
      );
    };

    // Digitado pelo usuário, no imperativo: o fast path é alcançável.
    await run(AUTOEXECUTABLE_UTTERANCE);
    expect(elevatedAuthorize).toHaveBeenCalled();

    // O MESMO conteúdo vindo de transcrição: nada de autorização nem execução.
    elevatedAuthorize.mockClear();
    const transcribed = await run(
      composeTurnTextWithTranscript({ userText: "", transcript: AUTOEXECUTABLE_UTTERANCE }),
    );
    expect(elevatedAuthorize).not.toHaveBeenCalled();
    expect(elevatedExecute).not.toHaveBeenCalled();
    expect(transcribed.policy?.authorizationMode).toBe("manual");
    expect(transcribed.mutation?.status).toBe("proposed");
  });

  it("o gate real de autoexecução rejeita QUALQUER turno com transcrição, mesmo com imperativo + valor", () => {
    const composed = composeTurnTextWithTranscript({
      userText: "",
      transcript: "registre 500 reais no mercado",
    });
    expect(
      isAutoExecutionEligible({
        tool: "transactions.expense.create",
        missingFields: [],
        ambiguity: null,
        latestActorText: composed,
        attachments: [],
      }),
    ).toBe(false);
  });

  it("número/negação mal transcritos seguem o fluxo existente: candidato para proposta manual, nunca escrita", () => {
    const valorErrado = composeTurnTextWithTranscript({ userText: "", transcript: "gastei 5.000 reais no mercado" });
    const interpretacao = interpretMutationUtterance(valorErrado);
    expect(interpretacao.status).toBe("candidate");
    expect(interpretacao.status === "candidate" && interpretacao.parsed.amountCents).toBe(500_000);

    const negacao = composeTurnTextWithTranscript({ userText: "", transcript: "não gastei 50 reais no mercado" });
    const negada = interpretMutationUtterance(negacao);
    // A negação transcrita é tratada como negação (o flow de confirmação existente),
    // nunca como uma despesa silenciosa.
    expect(negada.status).not.toBe("candidate");
    expect(
      isAutoExecutionEligible({
        tool: "transactions.expense.create",
        missingFields: [],
        ambiguity: null,
        latestActorText: negacao,
        attachments: [],
      }),
    ).toBe(false);
  });
});