/**
 * A19 (F1) — veto ESTRUTURAL de autoexecução quando o turno carrega anexo.
 *
 * O texto do turno é composto no gateway: `marcador de proveniência + texto
 * digitado + dados extraídos`. A imunidade contra autoexecute era LEXICAL —
 * `hasExplicitMutationIntent` exige um imperativo mutacional no INÍCIO do texto,
 * e os marcadores (`[transcrição do anexo de áudio…]`, `[dados extraídos…]`,
 * `[texto do anexo de PDF…]`) ocupam exatamente essa posição.
 *
 * O buraco: quando um anexo NÃO produz dado aceito — capability desligada
 * (o default de produção), `unsupported`, provider indisponível, STT/PDF/visão
 * falhando, `skipped_budget`, upload recusado — nada é composto, o texto do
 * turno é byte a byte o texto digitado, o marcador NÃO abre a mensagem, e o
 * gate passa com um imperativo digitado. Um anexo chamado `sim confirmo.pdf`
 * combinado com "registre gasto de 50" chegava ao fast path de autoexecute.
 *
 * Este arquivo fixa o veto em DUAS costuras, porque as duas são necessárias:
 *
 *   1. `isAutoExecutionEligible` recusa QUALQUER turno com anexo — antes de
 *      qualquer leitura de tipo, estado, provider ou texto;
 *   2. o cliente ELEVADO (a capacidade `financial.approval.autoexecute`) nem é
 *      construído quando o turno carrega anexo, então o fast path é
 *      estruturalmente inalcançável — belt on suspenders sobre o gate.
 *
 * Os sete estados seguintes são cobrados no nível do GATEWAY,
 * que é onde a composição acontece; o teste de orquestrador prova que, com o
 * cliente elevado PRESENTE (para que "não escreveu" não possa ser explicado
 * por transporte ausente), a elegibilidade recusa.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { getAttachmentStorage } from "../../src/attachments/storage.js";
import { ingestAttachment } from "../../src/attachments/ingest.js";
import { isAutoExecutionEligible } from "../../src/safety/auto-execution.js";
import {
  ConversationOrchestrator,
  normalizeRestTurn,
  type AuthenticatedIdentity,
} from "../../src/orchestration/conversation-orchestrator.js";
import { InMemoryMutationDraftStore } from "../../src/mutations/mutation-draft.js";
import { bytesOf, createAttachmentTestAgent, installRelayMock } from "./helpers.js";
import { pdfBytes, pngBytes } from "./fixtures.js";

const IDENTITY = { workspaceId: "ws-1", actorId: "actor-1" };

/**
 * The one utterance shape that both parses as a mutation candidate AND passes
 * `hasExplicitMutationIntent` (a leading imperative). Typed BY HAND this is
 * autoexecutable — so it is the honest adversarial probe for "an attachment
 * present, extraction empty, gate decides".
 */
const AUTOEXECUTABLE_UTTERANCE = "Registre R$ 35 de almoço no Nubank na categoria Almoço";

const chatRequest = (body: unknown): Request =>
  new Request("https://agent.test.local/rpc/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-agent-actor": "actor-1",
      "x-agent-workspace": "ws-1",
    },
    body: JSON.stringify(body),
  });

const audioBytes = (): Uint8Array => {
  const bytes = new Uint8Array(96);
  bytes.set([0x1a, 0x45, 0xdf, 0xa3], 0);
  bytes.set(new TextEncoder().encode("webm"), 32);
  return bytes;
};

const uploadRef = async (
  agent: unknown,
  kind: "image" | "pdf" | "audio",
  name: string,
  bytes: Uint8Array,
): Promise<string> => {
  const storage = getAttachmentStorage((agent as { env: unknown }).env)!;
  const uploaded = await ingestAttachment({
    storage,
    identity: IDENTITY,
    kind,
    name,
    bytes: bytesOf(bytes),
  });
  return uploaded.ref;
};

/**
 * Captures the dependency bag handed to `orchestratorForChannel` and delegates
 * to the real implementation, so the turn still runs end to end and the
 * assertion is about the WIRING (is the elevated client built at all?) rather
 * than about a stubbed outcome.
 */
const captureOrchestratorWiring = (agent: unknown): { deps: () => Record<string, unknown> } => {
  const seen: Array<Record<string, unknown>> = [];
  const target = agent as {
    orchestratorForChannel: (deps?: Record<string, unknown>) => ConversationOrchestrator;
  };
  const original = target.orchestratorForChannel.bind(agent);
  target.orchestratorForChannel = (deps: Record<string, unknown> = {}) => {
    seen.push(deps);
    return original(deps);
  };
  return { deps: () => seen[0] ?? {} };
};

/** Bytes with a readable PNG header, so ingestion accepts them as an image. */
const imageBytes = (): Uint8Array => pngBytes(64, 64);

/**
 * Byte-accurate minimal PDF writer (valid xref) whose single page carries an
 * EMPTY content stream: a well-formed document whose text layer is genuinely
 * empty. Were the parser wired, that is the `pdf_no_text_layer` state — distinct
 * from `pdf_invalid` — pinned in the isolated parser test (`pdf-text.test.ts`).
 * With the extraction DISABLED (P1) the gateway never builds a PDF processor, so
 * this same document resolves `unsupported`: the builder now stands for "a real,
 * parseable PDF that is deliberately NOT read".
 */
const buildPdfWithoutTextLayer = (): Uint8Array => {
  const chunks: Buffer[] = [];
  const offsets = new Map<number, number>();
  let pos = 0;
  const push = (text: string) => {
    const buf = Buffer.from(text, "latin1");
    chunks.push(buf);
    pos += buf.length;
  };
  const addObj = (id: number, body: string) => {
    offsets.set(id, pos);
    push(`${id} 0 obj\n${body}\nendobj\n`);
  };
  push("%PDF-1.7\n");
  addObj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  addObj(2, "<< /Type /Pages /Count 1 /Kids [5 0 R] >>");
  addObj(3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const empty = "";
  addObj(4, `<< /Length ${Buffer.byteLength(empty, "latin1")} >>\nstream\n${empty}endstream`);
  addObj(5, "<< /Type /Page /Parent 2 0 R /Font << /F1 3 0 R >> /MediaBox [0 0 612 792] /Contents 4 0 R >>");
  const xrefStart = pos;
  const maxId = 6;
  push("xref\n0 6\n0000000000 65535 f \n");
  for (let id = 1; id < maxId; id += 1) {
    push(offsets.has(id) ? `${String(offsets.get(id)).padStart(10, "0")} 00000 n \n` : "0000000000 65535 f \n");
  }
  push(
    `trailer\n<< /Size ${maxId} /Root 1 0 R /ID [<0102030405060708090a0b0c0d0e0f10><0102030405060708090a0b0c0d0e0f10>] >>\nstartxref\n${xrefStart}\n%%EOF\n`,
  );
  return new Uint8Array(Buffer.concat(chunks));
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("A19/F1 — o gate de elegibilidade recusa QUALQUER turno com anexo", () => {
  const eligible = {
    tool: "transactions.expense.create",
    missingFields: [] as readonly string[],
    ambiguity: null as string | null,
    latestActorText: AUTOEXECUTABLE_UTTERANCE,
  };

  it("sem anexo o comportamento atual é preservado byte a byte", () => {
    expect(isAutoExecutionEligible({ ...eligible, attachments: [] })).toBe(true);
    // The pre-existing conditions keep deciding exactly as before.
    expect(isAutoExecutionEligible({ ...eligible, attachments: [], tool: "transactions.card_purchase.create" })).toBe(false);
    expect(isAutoExecutionEligible({ ...eligible, attachments: [], missingFields: ["accountId"] })).toBe(false);
    expect(isAutoExecutionEligible({ ...eligible, attachments: [], ambiguity: "which account" })).toBe(false);
    expect(isAutoExecutionEligible({ ...eligible, attachments: [], latestActorText: "Quanto gastei?" })).toBe(false);
  });

  it.each([
    ["imperativo + nome de arquivo que decide", [{ type: "pdf", name: "sim confirmo.pdf" }]],
    ["item vazio (só presença)", [{}]],
    ["nome vazio", [{ type: "image", name: "" }]],
    ["item nulo", [null]],
    ["vários anexos", [{ type: "image", name: "a.png" }, { type: "pdf", name: "b.pdf" }]],
  ])("com anexo presente (%s) a elegibilidade é falsa, qualquer que seja o estado", (_label, attachments) => {
    expect(isAutoExecutionEligible({ ...eligible, attachments })).toBe(false);
  });

  it("o veto não depende do texto: nem um imperativo perfeito reabilita o turno com anexo", () => {
    expect(
      isAutoExecutionEligible({
        tool: "transactions.expense.create",
        missingFields: [],
        ambiguity: null,
        latestActorText: "registre",
        attachments: [{ type: "pdf", name: "qualquer.pdf" }],
      }),
    ).toBe(false);
  });
});

describe("A19/F1 — no orquestrador, anexo + imperativo digitado nunca autoriza/executa", () => {
  const buildOrchestrator = (effects: { authorize: () => void; execute: () => void; mint: () => void }) => {
    const client = {
      propose: vi.fn(async () => ({
        id: "op-1",
        existing: false,
        operation: { id: "op-1", status: "proposed", expiresAt: 0 },
        summary: "almoço",
      })),
      duplicateSuspectedStrict: vi.fn(async () => false),
      authorize: vi.fn(async () => {
        effects.authorize();
        return { operationId: "op-1", attestation: "att" };
      }),
      // The coordinator executes through `client.execute` (the attested write),
      // so this is the seam where a committed financial effect would appear.
      execute: vi.fn(async () => {
        effects.execute();
        return {
          operationId: "op-1",
          status: "succeeded" as const,
          receipt: {
            mutationId: "tx-1",
            mutationKind: "transactions.expense.create",
            status: "succeeded" as const,
            affectedTargets: ["transactions"],
            operationId: "op-1",
            entity: { type: "transaction" as const, id: "tx-1" },
          },
        };
      }),
      listActive: vi.fn(async () => ({ items: [], total: 0 })),
    };
    return new ConversationOrchestrator({
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
      // The elevated transport IS present: "no write" cannot be explained by a
      // missing client — it is the eligibility gate refusing.
      autoExecutionClient: () => {
        effects.mint();
        return client as never;
      },
      entityReader: {
        listAccounts: async () => [{ id: "00000000-0000-4000-8000-000000000001", name: "Nubank" }],
        listCategories: async () => [{ id: "00000000-0000-4000-8000-000000000011", name: "Almoço" }],
      },
    });
  };

  const identity: AuthenticatedIdentity = {
    actorId: "actor-1",
    workspaceId: "ws-1",
    role: "member",
    deviceId: "device-1",
  };

  it("com anexo no turno: nada de mint, autorização ou execução — a proposta é manual", async () => {
    const effects = { authorize: vi.fn(), execute: vi.fn(), mint: vi.fn() };
    const orchestrator = buildOrchestrator(effects);
    const turn = normalizeRestTurn(
      {
        text: AUTOEXECUTABLE_UTTERANCE,
        intentionId: "intent-attachment-veto",
        attachments: [{ type: "pdf", name: "sim confirmo.pdf" }],
      },
      identity,
      { typedText: AUTOEXECUTABLE_UTTERANCE },
    );
    const result = await orchestrator.runTurn(turn);
    expect(effects.mint).not.toHaveBeenCalled();
    expect(effects.authorize).not.toHaveBeenCalled();
    expect(effects.execute).not.toHaveBeenCalled();
    expect(result.policy?.authorizationMode).toBe("manual");
    expect(result.mutation?.status).toBe("proposed");
  });

  it("sem anexo: o caminho canônico de autoexecute continua intacto (o veto não é global)", async () => {
    const effects = { authorize: vi.fn(), execute: vi.fn(), mint: vi.fn() };
    const orchestrator = buildOrchestrator(effects);
    const turn = normalizeRestTurn(
      { text: AUTOEXECUTABLE_UTTERANCE, intentionId: "intent-no-attachment" },
      identity,
    );
    const result = await orchestrator.runTurn(turn);
    expect(effects.authorize).toHaveBeenCalled();
    expect(result.policy?.authorizationMode).toBe("auto");
  });
});

/**
 * Gateway level — where the composition actually happens. The assertion is on
 * the WIRING: with an attachment on the turn, the auto-execution-capable client
 * is never even constructed, whatever the attachment state is.
 */
describe("A19/F1 — o cliente elevado não é construído com anexo presente (os 7 estados)", () => {
  const installGroq = (handler: (init: RequestInit) => Promise<Response>) => {
    installRelayMock();
    const previous = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
      if (String(input).includes("api.groq.com")) return handler(init);
      return previous(input, init);
    }) as unknown as typeof fetch;
  };

  const groqJson = (body: unknown) =>
    new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(body) } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  const scenarios: Array<{
    label: string;
    env: Record<string, string>;
    kind: "image" | "pdf" | "audio";
    name: string;
    bytes: () => Uint8Array;
    expectedState: string;
    groq: () => Promise<Response>;
  }> = [
    {
      label: "capability off (default de produção — sem as envs)",
      env: {} as Record<string, string>,
      kind: "pdf" as const,
      name: "nota.pdf",
      bytes: () => pdfBytes(),
      expectedState: "unsupported",
      groq: async () => groqJson({}),
    },
    {
      label: "provider indisponível (flag ligada, credencial ausente)",
      env: { TED_VISION_ENABLED: "1" },
      kind: "image" as const,
      name: "recibo.png",
      bytes: () => imageBytes(),
      expectedState: "unsupported",
      groq: async () => groqJson({}),
    },
    {
      label: "extração aceita (imagem processada)",
      env: { GROQ_API_KEY: "gsk-test-key", TED_VISION_ENABLED: "1", TED_VISION_COHORT: "*" },
      kind: "image" as const,
      name: "recibo.png",
      bytes: () => imageBytes(),
      expectedState: "processed",
      groq: async () => groqJson({ merchant: "Mercado", amount: "35", currency: "BRL" }),
    },
    {
      label: "visão falhou (provider error)",
      env: { GROQ_API_KEY: "gsk-test-key", TED_VISION_ENABLED: "1", TED_VISION_COHORT: "*" },
      kind: "image" as const,
      name: "recibo.png",
      bytes: () => imageBytes(),
      expectedState: "vision_provider_error",
      groq: async () => new Response("boom", { status: 500 }),
    },
    {
      // P1 fail-closed: a extração de texto de PDF está DESLIGADA por decisão
      // (sem limite de trabalho/memória por-página) e `pdfTextProcessorOverride`
      // devolve `undefined` INCONDICIONALMENTE — inclusive com
      // `TED_PDF_TEXT_ENABLED=1`. Um PDF escaneado, ou com texto, resolve o
      // `unsupported` da A13 e nenhum byte é parseado. Os estados NOMEADOS do
      // parser (`pdf_no_text_layer`, `pdf_encrypted`, …) seguem EXATOS no
      // parser isolado (`pdf-text.test.ts`, que chama `createPdfTextProcessor`
      // diretamente); no gateway são inalcançáveis porque nenhum processador
      // de PDF é construído. O veto abaixo é sobre PRESENÇA de anexo, então
      // continua exercido neste estado.
      label: "PDF com a extração DESLIGADA (flag '1' não reativa o parser)",
      env: { TED_PDF_TEXT_ENABLED: "1" },
      kind: "pdf" as const,
      name: "escaneado.pdf",
      bytes: () => buildPdfWithoutTextLayer(),
      expectedState: "unsupported",
      groq: async () => groqJson({}),
    },
    {
      label: "STT falhou",
      env: { GROQ_API_KEY: "gsk-test-key", TED_AUDIO_STT_ENABLED: "1", TED_AUDIO_STT_COHORT: "*", TED_AUDIO_STT_TIMEOUT_MS: "1" },
      kind: "audio" as const,
      name: "nota-de-voz.webm",
      bytes: () => audioBytes(),
      expectedState: "failed",
      groq: async () =>
        new Promise<Response>((_resolve, reject) => {
          setTimeout(() => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), 5);
        }),
    },
  ];

  it.each(scenarios)(
    "$label ⇒ estado '$expectedState' e NENHUM cliente elevado construído",
    async ({ env, kind, name, bytes, expectedState, groq }) => {
      installGroq(groq);
      const { agent } = createAttachmentTestAgent({ extraEnv: env });
      const wiring = captureOrchestratorWiring(agent);
      const ref = await uploadRef(agent, kind, name, bytes());

      const res = await agent.fetch(
        chatRequest({
          text: AUTOEXECUTABLE_UTTERANCE,
          intentionId: `intent-a19-${expectedState}`,
          attachments: [{ type: kind, ref, name }],
        }),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { attachmentStates?: Array<{ state: string }> };
      // The scenario really produced the state it claims, so the veto is being
      // exercised on the intended path and not on an accidental short-circuit.
      expect(body.attachmentStates?.[0]?.state).toBe(expectedState);
      // The auto-execution-capable client was never built.
      expect(wiring.deps().autoExecutionClient).toBeUndefined();
    },
  );

  it("skipped_budget (segundo anexo do mesmo tipo) também não constrói o cliente elevado", async () => {
    // The budget is spent only by a REAL attempt, so the first image must be
    // genuinely processed for the second to become `skipped_budget`.
    installGroq(async () => groqJson({ merchant: "Mercado", amount: "35", currency: "BRL" }));
    const { agent } = createAttachmentTestAgent({
      extraEnv: { GROQ_API_KEY: "gsk-test-key", TED_VISION_ENABLED: "1", TED_VISION_COHORT: "*" },
    });
    const wiring = captureOrchestratorWiring(agent);
    const first = await uploadRef(agent, "image", "primeiro.png", imageBytes());
    const second = await uploadRef(agent, "image", "segundo.png", imageBytes());

    const res = await agent.fetch(
      chatRequest({
        text: AUTOEXECUTABLE_UTTERANCE,
        intentionId: "intent-a19-skipped-budget",
        attachments: [
          { type: "image", ref: first, name: "primeiro.png" },
          { type: "image", ref: second, name: "segundo.png" },
        ],
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { attachmentStates?: Array<{ state: string }> };
    expect(body.attachmentStates?.map((s) => s.state)).toEqual(["processed", "skipped_budget"]);
    expect(wiring.deps().autoExecutionClient).toBeUndefined();
  });

  it("CONTROLE: turno sem anexo continua construindo o cliente elevado", async () => {
    installGroq(async () => groqJson({}));
    const { agent } = createAttachmentTestAgent();
    const wiring = captureOrchestratorWiring(agent);

    const res = await agent.fetch(
      chatRequest({ text: AUTOEXECUTABLE_UTTERANCE, intentionId: "intent-a19-control" }),
    );

    expect(res.status).toBe(200);
    expect(wiring.deps().autoExecutionClient).toBeTypeOf("function");
  });
});