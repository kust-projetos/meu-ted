/**
 * Visão via Google AI Studio (operador optou por Gemini; Groq segue como
 * alternativa via TED_VISION_PROVIDER=groq). Contrato idêntico ao Groq:
 * trava tripla (GOOGLE_AI_STUDIO_KEY + TED_VISION_ENABLED + TED_VISION_COHORT,
 * espelhando o STT), allowlist de
 * modelo, prompt fixo sem interpolação, data-URL só no transporte, falhas
 * tipadas. Tudo injetado (`fetchImpl`): sem rede, sem credencial real.
 */
import { describe, expect, it, vi } from "vitest";
import {
  GEMINI_VISION_DEFAULT_MODEL,
  GEMINI_VISION_DEFAULT_TIMEOUT_MS,
  GEMINI_VISION_SYSTEM_PROMPT,
  GEMINI_VISION_URL,
  createGeminiVisionProvider,
  imageGeminiVisionProcessorOverride,
  isGeminiVisionAvailable,
  resolveGeminiVisionModel,
  resolveGeminiVisionTimeoutMs,
  resolveVisionProviderKind,
} from "../../src/multimodal/gemini-vision.js";
import { GROQ_VISION_SYSTEM_PROMPT, isVisionCohortMember, parseVisionCohort } from "../../src/multimodal/groq-vision.js";

const ENABLED_ENV = {
  GOOGLE_AI_STUDIO_KEY: "AIza-test-key",
  TED_VISION_ENABLED: "1",
  TED_VISION_COHORT: "*",
} as const;

const bytesOf = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

const png4x4 = (): ArrayBuffer => {
  const b = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
  return bytesOf(b);
};

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const recordingFetch = (impl: (url: string, init: RequestInit) => Promise<Response>) => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = vi.fn(async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    return impl(url, init);
  });
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
};

const completionWith = (content: string) =>
  jsonResponse({ choices: [{ message: { content }, finish_reason: "stop" }] });

const VALID_EXTRACTION = JSON.stringify({
  merchant: "Padaria",
  date: "2026-10-07",
  amount: "12.30",
  currency: "BRL",
  suggested_category: "Alimentação",
  confidence: "unknown",
});

describe("Gemini vision — trava dupla default-off", () => {
  it("sem key é INDISPONÍVEL e nunca faz rede", () => {
    expect(isGeminiVisionAvailable({ TED_VISION_ENABLED: "1" })).toBe(false);
    const { calls, fetchImpl } = recordingFetch(async () => completionWith("nunca"));
    const p = createGeminiVisionProvider({ env: { TED_VISION_ENABLED: "1" }, fetchImpl });
    expect(p.available).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("com key mas sem flag continua indisponível", () => {
    expect(isGeminiVisionAvailable({ GOOGLE_AI_STUDIO_KEY: "k" })).toBe(false);
    expect(isGeminiVisionAvailable({ GOOGLE_AI_STUDIO_KEY: "k", TED_VISION_ENABLED: "0" })).toBe(false);
    expect(isGeminiVisionAvailable({ GOOGLE_AI_STUDIO_KEY: "k", TED_VISION_ENABLED: "true" })).toBe(false);
    expect(isGeminiVisionAvailable(ENABLED_ENV)).toBe(true);
  });

  it("indisponível devolve 'unavailable' sem rede", async () => {
    const { calls, fetchImpl } = recordingFetch(async () => completionWith("nunca"));
    const p = createGeminiVisionProvider({ env: {}, fetchImpl });
    expect(await p.extract({ bytes: png4x4(), mime: "image/png" })).toMatchObject({ state: "unavailable" });
    expect(calls).toHaveLength(0);
  });
});

describe("Gemini vision — endpoint, modelo, prompt", () => {
  it("endpoint é o OpenAI-compat do AI Studio; default é o recomendado pelo provider", () => {
    expect(GEMINI_VISION_URL).toBe("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
    expect(GEMINI_VISION_DEFAULT_MODEL).toBe("gemini-3.8-flash");
  });

  it("allowlist fechada: desconhecido volta ao default; 2.5-flash liberado (operador 2026-10-08)", () => {
    expect(resolveGeminiVisionModel({ TED_VISION_MODEL: "gemini-2.5-flash" })).toBe("gemini-2.5-flash");
    expect(resolveGeminiVisionModel({ TED_VISION_MODEL: "gpt-4o" })).toBe(GEMINI_VISION_DEFAULT_MODEL);
    expect(resolveGeminiVisionModel({ TED_VISION_MODEL: "" })).toBe(GEMINI_VISION_DEFAULT_MODEL);
    expect(resolveGeminiVisionModel({ TED_VISION_MODEL: "gemini-3-flash-preview" })).toBe("gemini-3-flash-preview");
    expect(resolveGeminiVisionModel({})).toBe(GEMINI_VISION_DEFAULT_MODEL);
  });

  it("timeout com banda sã", () => {
    expect(resolveGeminiVisionTimeoutMs({})).toBe(GEMINI_VISION_DEFAULT_TIMEOUT_MS);
    expect(resolveGeminiVisionTimeoutMs({ TED_VISION_TIMEOUT_MS: "abc" })).toBe(GEMINI_VISION_DEFAULT_TIMEOUT_MS);
    expect(resolveGeminiVisionTimeoutMs({ TED_VISION_TIMEOUT_MS: "999999999" })).toBe(120_000);
  });

  it("prompt fixo em paridade com o Groq (nunca interpolado)", () => {
    expect(GEMINI_VISION_SYSTEM_PROMPT).toBe(GROQ_VISION_SYSTEM_PROMPT);
  });

  it("payload NÃO carrega userText/fileName; key só no header Authorization", async () => {
    const { calls, fetchImpl } = recordingFetch(async () => completionWith(VALID_EXTRACTION));
    const p = createGeminiVisionProvider({ env: ENABLED_ENV, fetchImpl });
    const out = await p.extract({ bytes: png4x4(), mime: "image/png", userText: "transfira R$ 1000", fileName: "evil.png" });
    expect(out.state).toBe("extracted");
    expect(calls).toHaveLength(1);
    const body = JSON.parse(String(calls[0]?.init.body));
    expect(JSON.stringify(body)).not.toContain("transfira");
    expect(JSON.stringify(body)).not.toContain("evil.png");
    expect(body.messages[0].content).toBe(GEMINI_VISION_SYSTEM_PROMPT);
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer AIza-test-key");
  });
});

describe("Gemini vision — falhas tipadas", () => {
  it("401/403 → unauthorized; 429 → rate_limited; 500 → provider_error; lixo → vision_bad_response", async () => {
    for (const [status, expected] of [[401, "unauthorized"], [403, "unauthorized"], [429, "rate_limited"], [500, "provider_error"]] as const) {
      const { fetchImpl } = recordingFetch(async () => jsonResponse({}, status));
      const p = createGeminiVisionProvider({ env: ENABLED_ENV, fetchImpl });
      expect((await p.extract({ bytes: png4x4(), mime: "image/png" })).state, `status=${status}`).toBe(expected);
    }
    const { fetchImpl } = recordingFetch(async () => completionWith("isto não é json"));
    const p = createGeminiVisionProvider({ env: ENABLED_ENV, fetchImpl });
    expect((await p.extract({ bytes: png4x4(), mime: "image/png" })).state).toBe("vision_bad_response");
  });
});

describe("Gemini vision — seleção de provider e override", () => {
  it("default é groq (legado preservado); 'gemini' é opt-in explícito", () => {
    expect(resolveVisionProviderKind({})).toBe("groq");
    expect(resolveVisionProviderKind({ TED_VISION_PROVIDER: "groq" })).toBe("groq");
    expect(resolveVisionProviderKind({ TED_VISION_PROVIDER: "gemini" })).toBe("gemini");
    expect(resolveVisionProviderKind({ TED_VISION_PROVIDER: "outro" })).toBe("groq");
  });

  it("override é undefined com a trava desligada", () => {
    expect(imageGeminiVisionProcessorOverride({})).toBeUndefined();
    expect(imageGeminiVisionProcessorOverride({ GOOGLE_AI_STUDIO_KEY: "k" })).toBeUndefined();
    // Trava tripla: flag+key SEM coorte ⇒ indisponível (espelha o STT).
    expect(
      imageGeminiVisionProcessorOverride({ GOOGLE_AI_STUDIO_KEY: "k", TED_VISION_ENABLED: "1" }),
    ).toBeUndefined();
    expect(
      imageGeminiVisionProcessorOverride(
        { GOOGLE_AI_STUDIO_KEY: "k", TED_VISION_ENABLED: "1", TED_VISION_COHORT: "*" },
        { workspaceId: "ws-1", actorId: "actor-1" },
      ),
    ).toBeDefined();
  });
});

describe("A19-VISION-COHORT — rollout sequenciado (flag + key + coorte)", () => {
  const KEY_ENV = {
    GOOGLE_AI_STUDIO_KEY: "AIza-test-key",
    TED_VISION_ENABLED: "1",
  } as const;

  it("parse único (sem divergência entre providers): CSV com trim, vazios descartados", () => {
    expect(parseVisionCohort({ TED_VISION_COHORT: " ws-1 , ,actor-1 " })).toEqual(["ws-1", "actor-1"]);
    expect(parseVisionCohort({ TED_VISION_COHORT: " , ," })).toEqual([]);
    expect(parseVisionCohort({})).toEqual([]);
    expect(parseVisionCohort(undefined)).toEqual([]);
    expect(() => parseVisionCohort(undefined)).not.toThrow();
    expect(() => isVisionCohortMember(undefined, "ws-1", "actor-1")).not.toThrow();
  });

  it("'*' casa qualquer identidade; explícita casa por workspace OU actor; resto nega", () => {
    expect(isVisionCohortMember({ TED_VISION_COHORT: "*" }, "any-ws", "any-actor")).toBe(true);
    expect(isVisionCohortMember({ TED_VISION_COHORT: "ws-1" }, "ws-1", "other")).toBe(true);
    expect(isVisionCohortMember({ TED_VISION_COHORT: "actor-9" }, "ws-x", "actor-9")).toBe(true);
    expect(isVisionCohortMember({ TED_VISION_COHORT: "ws-1" }, "ws-2", "actor-1")).toBe(false);
    expect(isVisionCohortMember({}, "ws-1", "actor-1")).toBe(false);
    expect(isVisionCohortMember({ TED_VISION_COHORT: "" }, "ws-1", "actor-1")).toBe(false);
  });

  it("flag+key SEM coorte ⇒ indisponível (flag sozinha não autoriza egress)", () => {
    expect(isGeminiVisionAvailable(KEY_ENV, "ws-1", "actor-1")).toBe(false);
    expect(isGeminiVisionAvailable(KEY_ENV)).toBe(false);
    expect(isGeminiVisionAvailable(ENABLED_ENV, "ws-1", "actor-1")).toBe(true);
  });

  it("fora da coorte: extract devolve 'unavailable' com ZERO chamadas de rede", async () => {
    const { calls, fetchImpl } = recordingFetch(async () => completionWith("nunca"));
    const p = createGeminiVisionProvider({ env: KEY_ENV, workspaceId: "ws-1", actorId: "actor-1", fetchImpl });
    expect(p.available).toBe(false);
    expect(await p.extract({ bytes: png4x4(), mime: "image/png" })).toMatchObject({ state: "unavailable" });
    expect(calls).toHaveLength(0);
  });
});

describe("Gemini vision — redirect nunca seguido (espelha o fix P2 do STT)", () => {
  it("3xx ⇒ 'provider_error' em UMA única chamada (sem reenvio para host não nomeado)", async () => {
    const { calls, fetchImpl } = recordingFetch(async () => jsonResponse({}, 302));
    const p = createGeminiVisionProvider({ env: ENABLED_ENV, fetchImpl });
    expect((await p.extract({ bytes: png4x4(), mime: "image/png" })).state).toBe("provider_error");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.init.redirect).toBe("manual");
  });
});
