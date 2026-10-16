/**
 * FIX-WS-D2-R5 — depósito server-side da prova (Agent→API direto).
 *
 * O browser recebe SÓ `{ attestationId }`: conteúdo, contagens e HMAC
 * viajam exclusivamente no corpo server-to-server para a API e nunca
 * aparecem na resposta, no erro ou em log.
 */
import { describe, expect, it, vi } from "vitest";
import { depositEmptyAttestationProof } from "../src/workspace-deletion-deposit.js";
import type { AgentEmptyProof } from "../src/workspace-deletion-attestation.js";

const PROOF: AgentEmptyProof = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  inventoryVersion: "a".repeat(64),
  counts: { sessions: 0, messages: 0, memories: 0, attachments: 0 },
  expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
  hmac: "b".repeat(64),
};

const HANDLE = "22222222-2222-4222-8222-222222222222";

const input = {
  apiOrigin: "https://api.example.test",
  serviceToken: "test-service-token",
  actorId: "actor-1",
  proof: PROOF,
};

describe("R5 — depósito server-side da prova (Agent→API)", () => {
  it("201 retorna SÓ o handle opaco; a prova viaja só no corpo server-to-server", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return new Response(JSON.stringify({ attestationId: HANDLE }), { status: 201 });
    }) as unknown as typeof fetch;

    const result = await depositEmptyAttestationProof(input, { fetchFn });
    expect(result).toEqual({ attestationId: HANDLE });
    expect(Object.keys(result)).toEqual(["attestationId"]);
    expect(capturedUrl).toBe("https://api.example.test/internal/agent/empty-attestations");
    expect(capturedInit?.method).toBe("POST");
    expect((capturedInit?.headers as Record<string, string>)["x-agent-service-token"]).toBe("test-service-token");
    // A prova COMPLETA (com HMAC) vai no corpo server-to-server…
    const sent = JSON.parse(String(capturedInit?.body)) as { actorId: string; proof: AgentEmptyProof };
    expect(sent.actorId).toBe("actor-1");
    expect(sent.proof.hmac).toBe(PROOF.hmac);
    // …mas nunca volta: nada de conteúdo/HMAC na resposta ao browser.
    expect(JSON.stringify(result)).not.toContain(PROOF.hmac);
  });

  it("usa redirect manual (nunca segue redirect para host não nomeado)", async () => {
    const fetchFn = (async () =>
      new Response(JSON.stringify({ attestationId: HANDLE }), { status: 201 })) as unknown as typeof fetch;
    let capturedInit: RequestInit | undefined;
    const capture = (async (url: string, init?: RequestInit) => {
      capturedInit = init;
      return fetchFn(url, init);
    }) as unknown as typeof fetch;
    await depositEmptyAttestationProof(input, { fetchFn: capture });
    expect(capturedInit?.redirect).toBe("manual");
  });

  it("API 409/401/500 ou rede falha viram indisponível fail-closed, sem vazar a prova", async () => {
    for (const status of [401, 403, 409, 500]) {
      const fetchFn = (async () =>
        new Response(JSON.stringify({ code: "workspace.agent_unverified" }), { status })) as unknown as typeof fetch;
      const error = await depositEmptyAttestationProof(input, { fetchFn }).then(
        () => { throw new Error("expected rejection"); },
        (cause) => cause as { code?: string; status?: number; message?: string },
      );
      expect(error.code).toBe("agent.attestation_unavailable");
      expect(error.status).toBe(409);
      expect(String(error.message)).not.toContain(PROOF.hmac);
    }
    const throwing = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    await expect(depositEmptyAttestationProof(input, { fetchFn: throwing })).rejects.toMatchObject({
      code: "agent.attestation_unavailable",
      status: 409,
    });
  });

  it("201 com corpo inesperado vira indisponível (nunca inventa handle)", async () => {
    for (const body of ['{"attestationId":"not-a-uuid"}', '{"proof":{}}', "not-json"]) {
      const fetchFn = (async () => new Response(body, { status: 201 })) as unknown as typeof fetch;
      await expect(depositEmptyAttestationProof(input, { fetchFn })).rejects.toMatchObject({
        code: "agent.attestation_unavailable",
      });
    }
  });
});
