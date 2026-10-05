import { afterEach, describe, expect, it, vi } from "vitest";
import { uploadAttachment } from "../agent-client";
import * as agentAuth from "../agent-auth";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const pngBytes = (): Uint8Array => {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set(new TextEncoder().encode("IHDR"), 12);
  view.setUint32(16, 10);
  view.setUint32(20, 10);
  return bytes;
};

const REF = "att_AAAAAAAAAAAAAAAAAAAAAA";

describe("uploadAttachment (A13) — POST real na rota de upload do Agent", () => {
  it("envia binário + headers de kind/nome e devolve a referência opaca", async () => {
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL", "https://agent.example.test");
    vi.spyOn(agentAuth, "fetchAgentConnectionToken").mockResolvedValue("signed-token-123");

    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      capturedUrl = String(url);
      capturedInit = init;
      return new Response(
        JSON.stringify({ ref: REF, kind: "image", name: "comprovante.png", size: 33, expiresAt: 1 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const file = new File([pngBytes()], "comprovante.png", { type: "image/png" });
    const result = await uploadAttachment("ws-1", { kind: "image", file });

    expect(result).toEqual({ ref: REF, kind: "image", name: "comprovante.png", size: 33 });
    expect(capturedUrl).toBe("https://agent.example.test/agents/finance-chat-agent/ws-1/rpc/attachments");
    expect(capturedInit?.method).toBe("POST");
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers["x-ted-attachment-kind"]).toBe("image");
    expect(headers["x-ted-attachment-name"]).toBe("comprovante.png");
    expect(headers["x-agent-connection-token"]).toBe("signed-token-123");
    // O corpo é binário puro — nunca base64, nunca JSON com bytes.
    expect(capturedInit?.body).toBeInstanceOf(ArrayBuffer);
    expect(JSON.stringify(headers)).not.toContain("base64");
  });

  it("falha de upload vira estado EXPLÍCITO com o code tipado (nunca sucesso silencioso)", async () => {
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL", "https://agent.example.test");
    vi.spyOn(agentAuth, "fetchAgentConnectionToken").mockResolvedValue("signed-token-123");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ code: "attachment_mime_mismatch", message: "Não corresponde." }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    );

    const file = new File([pngBytes()], "falso.png", { type: "image/png" });
    await expect(uploadAttachment("ws-1", { kind: "image", file })).rejects.toMatchObject({
      code: "attachment_mime_mismatch",
    });
  });

  it("storage indisponível (503) propaga o code — o caller decide o estado de falha", async () => {
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL", "https://agent.example.test");
    vi.spyOn(agentAuth, "fetchAgentConnectionToken").mockResolvedValue("signed-token-123");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ code: "attachment_storage_unavailable" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      }),
    );

    const file = new File([pngBytes()], "a.png", { type: "image/png" });
    await expect(uploadAttachment("ws-1", { kind: "image", file })).rejects.toMatchObject({
      code: "attachment_storage_unavailable",
    });
  });

  it("resposta sem `ref` é rejeitada (fail-closed: nunca devolve referência inventada)", async () => {
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL", "https://agent.example.test");
    vi.spyOn(agentAuth, "fetchAgentConnectionToken").mockResolvedValue("signed-token-123");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ kind: "image", name: "a.png", size: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const file = new File([pngBytes()], "a.png", { type: "image/png" });
    await expect(uploadAttachment("ws-1", { kind: "image", file })).rejects.toMatchObject({
      code: "attachment_upload_invalid_response",
    });
  });
});
