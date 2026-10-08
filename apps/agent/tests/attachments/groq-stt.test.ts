/**
 * A14 / R12 — Groq STT adapter (AC22), unit level.
 *
 * Everything is injected (`fetchImpl`): no network, no credential, no Worker
 * runtime. The tests pin the CONTRACT of the adapter, not the provider:
 *
 * - the request carries the bytes and NOTHING else (no `prompt`, no user file
 *   name, no financial context);
 * - the triple lock (`GROQ_API_KEY` + `TED_AUDIO_STT_ENABLED` + `TED_AUDIO_STT_COHORT`) gates the whole
 *   capability — absent either, the audio processor stays `unsupported`;
 * - every failure is a TYPED state (timeout / unauthorized / rate_limited /
 *   provider_error / bad_response), never a raw throw and never silence;
 * - there is NO automatic model fallback: a failure never reaches a second
 *   provider call with another model;
 * - the byte ceiling is enforced BEFORE the provider is ever called.
 */

import { describe, expect, it, vi } from "vitest";
import {
  AUDIO_TRANSCRIPT_MAX_CHARS,
  AUDIO_TRANSCRIPT_NOTICE,
  GROQ_STT_DEFAULT_MODEL,
  GROQ_STT_DEFAULT_TIMEOUT_MS,
  GROQ_STT_LANGUAGE,
  GROQ_STT_URL,
  composeTurnTextWithTranscript,
  createAudioSttProcessor,
  createGroqSttProvider,
  isAudioSttCohortMember,
  isGroqSttAvailable,
  parseAudioSttCohort,
  type AudioSttBudget,
} from "../../src/multimodal/groq-stt.js";
import { UNSUPPORTED_DETAIL } from "../../src/attachments/processors.js";
import { ATTACHMENT_LIMITS } from "../../src/attachments/types.js";
import { createMemoryAttachmentStorage } from "../../src/attachments/storage.js";
import { ingestAttachment } from "../../src/attachments/ingest.js";
import { createAttachmentProcessingMemo, processAttachmentOnce } from "../../src/attachments/processors.js";
import type { AttachmentIdentity } from "../../src/attachments/types.js";
import { webmBytes } from "./fixtures.js";

const IDENTITY: AttachmentIdentity = { workspaceId: "ws-1", actorId: "actor-1" };

const ENABLED_ENV = {
  GROQ_API_KEY: "gsk-test-key",
  TED_AUDIO_STT_ENABLED: "1",
  TED_AUDIO_STT_COHORT: "*",
} as const;

const bytesOf = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Records every outbound call so the assertions can inspect the FormData. */
const recordingFetch = (impl: (url: string, init: RequestInit) => Promise<Response>) => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = vi.fn(async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    return impl(url, init);
  });
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
};

const freshBudget = (): AudioSttBudget => ({ consumed: 0 });

describe("A14/AC22 — capability gate (default-off duplo)", () => {
  it("sem GROQ_API_KEY o provider é INDISPONÍVEL e nunca faz rede", () => {
    expect(isGroqSttAvailable({ TED_AUDIO_STT_ENABLED: "1" })).toBe(false);
    const { calls, fetchImpl } = recordingFetch(async () => jsonResponse({ text: "nunca chamado" }));
    const provider = createGroqSttProvider({ env: { TED_AUDIO_STT_ENABLED: "1" }, fetchImpl });
    expect(provider.available).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("com a key mas SEM TED_AUDIO_STT_ENABLED continua indisponível (trava tripla)", () => {
    expect(isGroqSttAvailable({ GROQ_API_KEY: "gsk-test-key" })).toBe(false);
    expect(isGroqSttAvailable({ GROQ_API_KEY: "gsk-test-key", TED_AUDIO_STT_ENABLED: "0" })).toBe(false);
    expect(isGroqSttAvailable(ENABLED_ENV)).toBe(true);
  });

  it("provider indisponível devolve 'unavailable' sem tocar a rede", async () => {
    const { calls, fetchImpl } = recordingFetch(async () => jsonResponse({ text: "nunca chamado" }));
    const provider = createGroqSttProvider({ env: {}, fetchImpl });
    const outcome = await provider.transcribe({ bytes: bytesOf(webmBytes()), mime: "audio/webm" });
    expect(outcome.state).toBe("unavailable");
    expect(calls).toHaveLength(0);
  });
});

describe("A14/AC22 — requisição ao provider (minimização)", () => {
  it("envia multipart com file/model/language/response_format e NUNCA prompt nem nome de arquivo", async () => {
    const { calls, fetchImpl } = recordingFetch(async () => jsonResponse({ text: "gastei 50 no mercado" }));
    const provider = createGroqSttProvider({ env: ENABLED_ENV, fetchImpl });

    const outcome = await provider.transcribe({
      bytes: bytesOf(webmBytes()),
      mime: "audio/webm",
    });

    expect(outcome.state).toBe("transcribed");
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.url).toBe(GROQ_STT_URL);
    expect(call.init.method).toBe("POST");
    const headers = call.init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer gsk-test-key");
    const form = call.init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get("model")).toBe(GROQ_STT_DEFAULT_MODEL);
    expect(form.get("language")).toBe(GROQ_STT_LANGUAGE);
    expect(form.get("response_format")).toBe("json");
    // The minimisation invariant: no prompt, no filename, no user text.
    expect(form.has("prompt")).toBe(false);
    const file = form.get("file");
    expect(file).toBeInstanceOf(Blob);
    expect((file as File).name).toBe("audio.webm");
    // The upload part is a NEUTRAL name derived from the sniffed mime: no
    // field carries the user's file name, a path or any financial context.
    for (const forbidden of ["name", "filename", "file_name", "prompt", "context"]) {
      expect(form.has(forbidden)).toBe(false);
    }
  });

  it("o modelo e o timeout saem das envs, com os defaults conservative", async () => {
    const { calls, fetchImpl } = recordingFetch(async () => jsonResponse({ text: "ok" }));
    const provider = createGroqSttProvider({
      env: { ...ENABLED_ENV, TED_AUDIO_STT_MODEL: "whisper-large-v3", TED_AUDIO_STT_TIMEOUT_MS: "1200" },
      fetchImpl,
    });
    await provider.transcribe({ bytes: bytesOf(webmBytes()), mime: "audio/ogg" });
    const form = calls[0]!.init.body as FormData;
    expect(form.get("model")).toBe("whisper-large-v3");
    expect(GROQ_STT_DEFAULT_MODEL).toBe("whisper-large-v3-turbo");
    expect(GROQ_STT_DEFAULT_TIMEOUT_MS).toBe(20_000);
    // A mime fora da extensão conhecida nunca vaza o nome do usuário.
    expect((form.get("file") as File).name).toBe("audio.ogg");
  });

  it("a chave NUNCA aparece na resposta nem em erro do adapter", async () => {
    const { fetchImpl } = recordingFetch(async () => jsonResponse({ error: "invalid api key" }, 401));
    const provider = createGroqSttProvider({ env: ENABLED_ENV, fetchImpl });
    const outcome = await provider.transcribe({ bytes: bytesOf(webmBytes()), mime: "audio/webm" });
    expect(JSON.stringify(outcome)).not.toContain("gsk-test-key");
  });
});

describe("A14/AC22 — estados de falha explícitos (AC22)", () => {
  it("timeout do provider vira estado 'timeout' tipado (abort próprio, não o do judgment)", async () => {
    const { calls, fetchImpl } = recordingFetch(
      async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          });
        }),
    );
    const provider = createGroqSttProvider({
      env: { ...ENABLED_ENV, TED_AUDIO_STT_TIMEOUT_MS: "5" },
      fetchImpl,
    });
    const outcome = await provider.transcribe({ bytes: bytesOf(webmBytes()), mime: "audio/webm" });
    expect(outcome.state).toBe("timeout");
    expect(calls).toHaveLength(1);
  });

  it("401/403 => 'unauthorized'; 429 => 'rate_limited'; 4xx/5xx => 'provider_error'", async () => {
    const cases: Array<[number, string]> = [
      [401, "unauthorized"],
      [403, "unauthorized"],
      [429, "rate_limited"],
      [400, "provider_error"],
      [500, "provider_error"],
      [503, "provider_error"],
    ];
    for (const [status, expected] of cases) {
      const { fetchImpl } = recordingFetch(async () => jsonResponse({ error: { message: "x" } }, status));
      const provider = createGroqSttProvider({ env: ENABLED_ENV, fetchImpl });
      const outcome = await provider.transcribe({ bytes: bytesOf(webmBytes()), mime: "audio/webm" });
      expect(outcome.state).toBe(expected);
    }
  });

  it("resposta malformada (sem 'text' string, ou texto vazio) => 'bad_response'", async () => {
    const bodies: unknown[] = [{}, { text: 42 }, { text: "" }, { text: "   " }, { text: null }];
    for (const body of bodies) {
      const { fetchImpl } = recordingFetch(async () => jsonResponse(body));
      const provider = createGroqSttProvider({ env: ENABLED_ENV, fetchImpl });
      const outcome = await provider.transcribe({ bytes: bytesOf(webmBytes()), mime: "audio/webm" });
      expect(outcome.state).toBe("bad_response");
    }
    // Corpo que nem é JSON.
    const notJson = createGroqSttProvider({
      env: ENABLED_ENV,
      fetchImpl: (async () => new Response("<html>gateway</html>", { status: 200 })) as unknown as typeof fetch,
    });
    expect((await notJson.transcribe({ bytes: bytesOf(webmBytes()), mime: "audio/webm" })).state).toBe("bad_response");
  });

  it("falha de rede vira 'provider_error' — nunca uma exception crua", async () => {
    const provider = createGroqSttProvider({
      env: ENABLED_ENV,
      fetchImpl: (async () => {
        throw new TypeError("network down");
      }) as unknown as typeof fetch,
    });
    await expect(
      provider.transcribe({ bytes: bytesOf(webmBytes()), mime: "audio/webm" }),
    ).resolves.toMatchObject({ state: "provider_error" });
  });

  it("nunca segue redirect: usa redirect manual e trata 307 como 'provider_error' sem segunda chamada", async () => {
    const { calls, fetchImpl } = recordingFetch(
      async () => new Response(null, { status: 307, headers: { location: "https://evil.example/steal" } }),
    );
    const provider = createGroqSttProvider({ env: ENABLED_ENV, fetchImpl });
    const outcome = await provider.transcribe({ bytes: bytesOf(webmBytes()), mime: "audio/webm" });
    expect(outcome.state).toBe("provider_error");
    // Never followed, never resent: exactly one outbound call.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init.redirect).toBe("manual");
  });

  it("redirect opaco do edge ('opaqueredirect') vira 'provider_error' sem segunda chamada", async () => {
    const opaqueRedirect = { type: "opaqueredirect", status: 0, ok: false } as unknown as Response;
    const { calls, fetchImpl } = recordingFetch(async () => opaqueRedirect);
    const provider = createGroqSttProvider({ env: ENABLED_ENV, fetchImpl });
    const outcome = await provider.transcribe({ bytes: bytesOf(webmBytes()), mime: "audio/webm" });
    expect(outcome.state).toBe("provider_error");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init.redirect).toBe("manual");
  });

  it("NÃO existe fallback de modelo: uma falha nunca vira uma segunda chamada", async () => {    const { calls, fetchImpl } = recordingFetch(async () => jsonResponse({ error: "boom" }, 500));
    const provider = createGroqSttProvider({ env: { ...ENABLED_ENV, TED_AUDIO_STT_MODEL: "whisper-large-v3" }, fetchImpl });
    const outcome = await provider.transcribe({ bytes: bytesOf(webmBytes()), mime: "audio/webm" });
    expect(outcome.state).toBe("provider_error");
    expect(calls).toHaveLength(1);
    expect((calls[0]!.init.body as FormData).get("model")).toBe("whisper-large-v3");
  });

  it("a transcrição é limitada em caracteres (nada enorme entra no prompt)", async () => {
    const { fetchImpl } = recordingFetch(async () => jsonResponse({ text: "a".repeat(50_000) }));
    const provider = createGroqSttProvider({ env: ENABLED_ENV, fetchImpl });
    const outcome = await provider.transcribe({ bytes: bytesOf(webmBytes()), mime: "audio/webm" });
    expect(outcome.state).toBe("transcribed");
    expect((outcome as { text: string }).text.length).toBeLessThanOrEqual(AUDIO_TRANSCRIPT_MAX_CHARS);
  });
});

describe("A14/AC22 — processor de áudio no registry da A13", () => {
  const uploadAudio = async () => {
    const storage = createMemoryAttachmentStorage();
    const uploaded = await ingestAttachment({
      storage,
      identity: IDENTITY,
      kind: "audio",
      name: "nota-de-voz.webm",
      bytes: bytesOf(webmBytes()),
    });
    return { storage, uploaded };
  };

  const runAudio = async (options: {
    fetchImpl: typeof fetch;
    env?: Record<string, string>;
    budget?: AudioSttBudget;
    memo?: ReturnType<typeof createAttachmentProcessingMemo>;
    turnId?: string;
  }) => {
    const { storage, uploaded } = await uploadAudio();
    const provider = createGroqSttProvider({ env: (options.env ?? ENABLED_ENV) as never, fetchImpl: options.fetchImpl });
    const processor = createAudioSttProcessor({ provider, budget: options.budget ?? freshBudget() });
    const outcome = await processAttachmentOnce({
      storage,
      registry: { supports: (kind) => kind === "audio", isReady: (kind) => kind === "audio", run: (_kind, input) => processor(input) },
      identity: IDENTITY,
      ref: uploaded.ref,
      turnId: options.turnId ?? "turn-1",
      memo: options.memo ?? createAttachmentProcessingMemo(),
    });
    return { outcome, uploaded, provider };
  };

  it("áudio válido vira estado 'processed' + transcrição (proveniência no turno)", async () => {
    const { fetchImpl } = recordingFetch(async () => jsonResponse({ text: "gastei 50 reais no mercado" }));
    const { outcome } = await runAudio({ fetchImpl });
    expect(outcome.state).toBe("processed");
    expect(outcome.transcript).toBe("gastei 50 reais no mercado");
    // A transcrição NÃO entra no `detail` (que é log/telemetria).
    expect(outcome.detail).not.toContain("50 reais");
  });

  it("provider indisponível => 'unsupported' (o fail-closed da A13), não 'failed'", async () => {
    const { fetchImpl, calls } = recordingFetch(async () => jsonResponse({ text: "nunca" }));
    const { outcome } = await runAudio({ fetchImpl, env: {} });
    expect(outcome.state).toBe("unsupported");
    expect(calls).toHaveLength(0);
  });

  it("estados tipados de falha atravessam o registry sem virar 500", async () => {
    const cases: Array<[number, string]> = [
      [401, "stt_unauthorized"],
      [429, "stt_rate_limited"],
      [500, "stt_provider_error"],
      [400, "stt_provider_error"],
    ];
    for (const [status, expected] of cases) {
      const { fetchImpl } = recordingFetch(async () => jsonResponse({ error: "x" }, status));
      const { outcome } = await runAudio({ fetchImpl });
      expect(outcome.state).toBe(expected);
      expect(outcome.detail).toBeTruthy();
      expect(outcome.transcript).toBeUndefined();
    }
  });

  it("teto de bytes é checado ANTES do provider (nenhuma chamada de rede)", async () => {
    const { calls, fetchImpl } = recordingFetch(async () => jsonResponse({ text: "nunca chamado" }));
    const provider = createGroqSttProvider({ env: ENABLED_ENV, fetchImpl });
    const processor = createAudioSttProcessor({ provider, budget: freshBudget() });
    const result = await processor({
      record: {
        ref: "att_AAAAAAAAAAAAAAAAAAAAAA",
        kind: "audio",
        name: "gigante.webm",
        size: ATTACHMENT_LIMITS.audio.maxBytes + 1,
        sha256: "0".repeat(64),
        mime: "audio/webm",
      },
      bytes: bytesOf(webmBytes()),
      identity: IDENTITY,
    });
    expect(result.state).toBe("failed");
    expect(result.detail).toMatch(/limite/i);
    expect(calls).toHaveLength(0);
  });

  it("orçamento de 1 transcrição por turno: o 2º áudio vira 'skipped_budget' explícito", async () => {
    const budget = freshBudget();
    const first = recordingFetch(async () => jsonResponse({ text: "primeiro" }));
    const second = recordingFetch(async () => jsonResponse({ text: "segundo" }));
    const a = await runAudio({ fetchImpl: first.fetchImpl, budget });
    const b = await runAudio({ fetchImpl: second.fetchImpl, budget });
    expect(a.outcome.state).toBe("processed");
    expect(b.outcome.state).toBe("skipped_budget");
    expect(second.calls).toHaveLength(0);
  });

  it("idempotência: mesmo (anexo, turno) não chama o provider duas vezes", async () => {
    const memo = createAttachmentProcessingMemo();
    const { calls, fetchImpl } = recordingFetch(async () => jsonResponse({ text: "uma vez só" }));
    const { storage, uploaded } = await uploadAudio();
    const provider = createGroqSttProvider({ env: ENABLED_ENV, fetchImpl });
    const processor = createAudioSttProcessor({ provider, budget: freshBudget() });
    const registry = { supports: (k: string) => k === "audio", isReady: (k: string) => k === "audio", run: (_k: never, input: never) => processor(input) } as never;
    for (let i = 0; i < 2; i += 1) {
      const outcome = await processAttachmentOnce({
        storage, registry, identity: IDENTITY, ref: uploaded.ref, turnId: "turn-1", memo,
      });
      expect(outcome.state).toBe("processed");
    }
    expect(calls).toHaveLength(1);
  });
});

describe("A14/AC22 — texto do turno com proveniência", () => {
  it("a transcrição entra como dado marcado (nunca instrução) e preserva o texto do usuário", () => {
    const composed = composeTurnTextWithTranscript({
      userText: "anota isso",
      transcript: "gastei 50 reais no mercado",
    });
    expect(composed).toContain("anota isso");
    expect(composed).toContain("gastei 50 reais no mercado");
    expect(composed.startsWith(AUDIO_TRANSCRIPT_NOTICE)).toBe(true);
  });

  it("sem transcrição o texto do turno é o MESMO texto do usuário (byte a byte)", () => {
    expect(composeTurnTextWithTranscript({ userText: "  olá  ", transcript: undefined })).toBe("olá");
    expect(composeTurnTextWithTranscript({ userText: "", transcript: "   ", attachmentPlaceholder: "[anexo audio]" })).toBe("[anexo audio]");
  });
});

describe("A19-STT-COHORT — rollout sequenciado (flag + coorte)", () => {
  const KEY_ENV = {
    GROQ_API_KEY: "gsk-test-key",
    TED_AUDIO_STT_ENABLED: "1",
  } as const;

  it("parse: CSV com trim, vazios descartados; ausente/não-string ⇒ [] e nunca lança", () => {
    expect(parseAudioSttCohort({ TED_AUDIO_STT_COHORT: " ws-1 , ,actor-1 " })).toEqual(["ws-1", "actor-1"]);
    expect(parseAudioSttCohort({ TED_AUDIO_STT_COHORT: " , ," })).toEqual([]);
    expect(parseAudioSttCohort({})).toEqual([]);
    expect(parseAudioSttCohort(undefined)).toEqual([]);
    expect(parseAudioSttCohort({ TED_AUDIO_STT_COHORT: 42 })).toEqual([]);
    expect(parseAudioSttCohort({ TED_AUDIO_STT_COHORT: null })).toEqual([]);
    expect(() => parseAudioSttCohort(undefined)).not.toThrow();
    expect(() => isAudioSttCohortMember(undefined, "ws-1", "actor-1")).not.toThrow();
  });

  it("'*' casa qualquer identidade; explícita casa por workspace OU actor; resto nega", () => {
    expect(isAudioSttCohortMember({ TED_AUDIO_STT_COHORT: "*" }, "any-ws", "any-actor")).toBe(true);
    expect(isAudioSttCohortMember({ TED_AUDIO_STT_COHORT: "ws-1" }, "ws-1", "other")).toBe(true);
    expect(isAudioSttCohortMember({ TED_AUDIO_STT_COHORT: "actor-9" }, "ws-x", "actor-9")).toBe(true);
    expect(isAudioSttCohortMember({ TED_AUDIO_STT_COHORT: "ws-1" }, "ws-2", "actor-1")).toBe(false);
    expect(isAudioSttCohortMember({}, "ws-1", "actor-1")).toBe(false);
    expect(isAudioSttCohortMember({ TED_AUDIO_STT_COHORT: "" }, "ws-1", "actor-1")).toBe(false);
    expect(isAudioSttCohortMember({ TED_AUDIO_STT_COHORT: " , ," }, "ws-1", "actor-1")).toBe(false);
  });

  it("flag+key SEM coorte ⇒ indisponível (flag sozinha não autoriza egress)", () => {
    expect(isGroqSttAvailable(KEY_ENV, "ws-1", "actor-1")).toBe(false);
    expect(isGroqSttAvailable(KEY_ENV)).toBe(false);
  });

  it("'*' restaura a disponibilidade geral (flag+key+curinga)", () => {
    expect(
      isGroqSttAvailable({ ...KEY_ENV, TED_AUDIO_STT_COHORT: "*" }, "ws-qualquer", "actor-qualquer"),
    ).toBe(true);
  });

  it("fora da coorte: transcribe devolve 'unavailable' com ZERO chamadas de rede", async () => {
    const { calls, fetchImpl } = recordingFetch(async () => jsonResponse({ text: "nunca chamado" }));
    const provider = createGroqSttProvider({
      env: KEY_ENV,
      workspaceId: "ws-1",
      actorId: "actor-1",
      fetchImpl,
    });
    expect(provider.available).toBe(false);
    const outcome = await provider.transcribe({ bytes: bytesOf(webmBytes()), mime: "audio/webm" });
    expect(outcome.state).toBe("unavailable");
    expect(calls).toHaveLength(0);
  });

  it("fora da coorte: processor devolve 'unsupported' (copy do fail-closed), sem egress", async () => {
    const { calls, fetchImpl } = recordingFetch(async () => jsonResponse({ text: "nunca chamado" }));
    const provider = createGroqSttProvider({
      env: KEY_ENV,
      workspaceId: "ws-1",
      actorId: "actor-1",
      fetchImpl,
    });
    const processor = createAudioSttProcessor({ provider, budget: freshBudget() });
    const result = await processor({
      record: {
        ref: "att_AAAAAAAAAAAAAAAAAAAAAA",
        kind: "audio",
        name: "nota.webm",
        size: 10,
        sha256: "0".repeat(64),
        mime: "audio/webm",
      },
      bytes: bytesOf(webmBytes()),
      identity: IDENTITY,
    });
    expect(result.state).toBe("unsupported");
    expect(result.detail).toBe(UNSUPPORTED_DETAIL);
    expect(calls).toHaveLength(0);
  });
});