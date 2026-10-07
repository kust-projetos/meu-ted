import { afterEach, describe, expect, it, vi } from "vitest";
import { ATTACHMENT_LIMITS, ATTACHMENT_TTL_MS } from "../../src/attachments/types.js";
import { getAttachmentStorage } from "../../src/attachments/storage.js";
import { ingestAttachment } from "../../src/attachments/ingest.js";
import { pdfBytes, pngBytes, scriptBytes } from "./fixtures.js";
import {
  bytesOf,
  createAttachmentTestAgent,
  installRelayMock,
  uploadRequest,
} from "./helpers.js";

const KIND_HEADER = "x-ted-attachment-kind";
const NAME_HEADER = "x-ted-attachment-name";

/**
 * F1 PR-A (issue #107): a rota de upload agora exige o gate (flag + coorte).
 * Os testes de mecânica do upload optam explicitamente (`actor-1`/`ws-1`,
 * mesma identidade do `uploadRequest`); o default-off fail-closed é pinado
 * em `upload-gate.test.ts` + no teste (4) abaixo.
 */
const GATE_OPT_IN = {
  extraEnv: { TED_ATTACHMENTS_ENABLED: "1", TED_ATTACHMENTS_COHORT: "ws-1,actor-1" },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("A13 — POST /rpc/attachments (mesmo padrão auth das rotas rpc)", () => {
  it("(1) 401 sem x-agent-actor/workspace", async () => {
    const { agent } = createAttachmentTestAgent();
    const noActor = await agent.fetch(
      new Request("https://agent.test.local/rpc/attachments", {
        method: "POST",
        headers: { "content-type": "application/octet-stream", "x-agent-workspace": "ws-1", [KIND_HEADER]: "image" },
        body: bytesOf(pngBytes(4, 4)),
      }),
    );
    expect(noActor.status).toBe(401);
    const noWorkspace = await agent.fetch(
      new Request("https://agent.test.local/rpc/attachments", {
        method: "POST",
        headers: { "content-type": "application/octet-stream", "x-agent-actor": "actor-1", [KIND_HEADER]: "image" },
        body: bytesOf(pngBytes(4, 4)),
      }),
    );
    expect(noWorkspace.status).toBe(401);
  });

  it("(2) upload válido devolve SOMENTE {ref,kind,name,size,expiresAt} — sem URL, sem bytes", async () => {
    const { agent } = createAttachmentTestAgent(GATE_OPT_IN);
    const bytes = pngBytes(10, 5);
    const res = await agent.fetch(
      uploadRequest(bytesOf(bytes), { [KIND_HEADER]: "image", [NAME_HEADER]: "comprovante.png" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["expiresAt", "kind", "name", "ref", "size"]);
    expect(body.ref).toMatch(/^att_[A-Za-z0-9_-]{16,}$/);
    expect(body.kind).toBe("image");
    expect(body.name).toBe("comprovante.png");
    expect(body.size).toBe(bytes.byteLength);
    expect(typeof body.expiresAt).toBe("number");
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("https://");
    expect(serialized).not.toContain("data:");
    expect(serialized).not.toContain("iVBOR");
  });

  it("(3) erros tipados: kind inválido, corpo vazio, MIME falso e oversized", async () => {
    const { agent } = createAttachmentTestAgent(GATE_OPT_IN);

    const badKind = await agent.fetch(uploadRequest(bytesOf(pngBytes(4, 4)), { [KIND_HEADER]: "video" }));
    expect(badKind.status).toBe(400);
    expect(((await badKind.json()) as { code: string }).code).toBe("attachment_unsupported_kind");

    const empty = await agent.fetch(uploadRequest(bytesOf(new Uint8Array(0)), { [KIND_HEADER]: "pdf" }));
    expect(empty.status).toBe(400);
    expect(((await empty.json()) as { code: string }).code).toBe("attachment_bad_request");

    // MIME falso: PDF declarado como imagem.
    const fakeMime = await agent.fetch(uploadRequest(bytesOf(pdfBytes()), { [KIND_HEADER]: "image" }));
    expect(fakeMime.status).toBe(400);
    expect(((await fakeMime.json()) as { code: string }).code).toBe("attachment_mime_mismatch");

    // Script declarado como imagem: rejeitado, nada executado.
    const script = await agent.fetch(uploadRequest(bytesOf(scriptBytes()), { [KIND_HEADER]: "image" }));
    expect(script.status).toBe(400);
    expect(((await script.json()) as { code: string }).code).toBe("attachment_mime_mismatch");

    // Oversized (header-only, 10 MB + 1).
    const oversized = new Uint8Array(ATTACHMENT_LIMITS.image.maxBytes + 1);
    oversized.set(pngBytes(4, 4).subarray(0, 33), 0);
    const tooLarge = await agent.fetch(uploadRequest(bytesOf(oversized), { [KIND_HEADER]: "image" }));
    expect(tooLarge.status).toBe(413);
    expect(((await tooLarge.json()) as { code: string }).code).toBe("attachment_too_large");
  });

  it("(4) SEM binding (capability off) a rota responde 503 attachment_storage_unavailable e não guarda nada", async () => {
    const { agent, bucket } = createAttachmentTestAgent({ withBucket: false });
    const res = await agent.fetch(
      uploadRequest(bytesOf(pngBytes(4, 4)), { [KIND_HEADER]: "image", [NAME_HEADER]: "a.png" }),
    );
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code: string }).code).toBe("attachment_storage_unavailable");
    expect(bucket.objects.size).toBe(0);
  });

  it("(5) idempotência: mesmo (workspace, actor, sha256) devolve o MESMO ref e não duplica objeto", async () => {
    const { agent, bucket } = createAttachmentTestAgent(GATE_OPT_IN);
    const bytes = bytesOf(pngBytes(6, 6));
    const first = await (await agent.fetch(uploadRequest(bytes, { [KIND_HEADER]: "image" }))).json() as { ref: string };
    const second = await (await agent.fetch(uploadRequest(bytes, { [KIND_HEADER]: "image" }))).json() as { ref: string };
    expect(second.ref).toBe(first.ref);
    expect(bucket.objects.size).toBe(1);
  });

  it("(6) o nome cru NUNCA é logado nem devolvido sem scrub (nome com PAN é redigido)", async () => {
    const { agent } = createAttachmentTestAgent(GATE_OPT_IN);
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(" ")); });
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(" ")); });
    const res = await agent.fetch(
      uploadRequest(bytesOf(pngBytes(4, 4)), { [KIND_HEADER]: "image", [NAME_HEADER]: "cartao 4111111111111111.png" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string };
    expect(body.name).not.toContain("4111111111111111");
    expect(logs.join("\n")).not.toContain("4111111111111111");
  });

  it("(7) o storage efetivo é o binding R2 opcional, com TTL de 24 h", async () => {
    const { agent, bucket } = createAttachmentTestAgent(GATE_OPT_IN);
    const now = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const res = await agent.fetch(
      uploadRequest(bytesOf(pngBytes(4, 4)), { [KIND_HEADER]: "image", [NAME_HEADER]: "a.png" }),
    );
    const body = (await res.json()) as { ref: string; expiresAt: number };
    expect(body.expiresAt).toBe(now + ATTACHMENT_TTL_MS);
    expect(bucket.objects.has(`ted/attachments/v1/${body.ref}`)).toBe(true);
  });
});

describe("A13 — /rpc/chat: referência resolvida no gateway (antes do processamento)", () => {
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

  it("(8) anexo por referência resolve e vira estado explícito 'unsupported' no turno (nunca erro 500)", async () => {
    installRelayMock();
    const { agent } = createAttachmentTestAgent();
    const storage = getAttachmentStorage((agent as unknown as { env: unknown }).env)!;
    const uploaded = await ingestAttachment({
      storage,
      identity: { workspaceId: "ws-1", actorId: "actor-1" },
      kind: "image",
      name: "comprovante.png",
      bytes: bytesOf(pngBytes(8, 8)),
    });

    const res = await agent.fetch(
      chatRequest({
        text: "Analise este comprovante",
        intentionId: "intent-ref-1",
        attachments: [{ type: "image", ref: uploaded.ref, name: "comprovante.png" }],
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      attachmentStates?: Array<{ ref: string; state: string; detail: string }>;
    };
    expect(body.status).toBe("completed");
    expect(body.attachmentStates).toHaveLength(1);
    expect(body.attachmentStates?.[0]?.ref).toBe(uploaded.ref);
    expect(body.attachmentStates?.[0]?.state).toBe("unsupported");
    expect(body.attachmentStates?.[0]?.detail).toBeTruthy();
  });

  it("(9) referência de OUTRO workspace vira estado 'unavailable' — o turno segue, sem 500 e sem vazar bytes", async () => {
    installRelayMock();
    const { agent } = createAttachmentTestAgent();
    const storage = getAttachmentStorage((agent as unknown as { env: unknown }).env)!;
    const foreign = await ingestAttachment({
      storage,
      identity: { workspaceId: "ws-2", actorId: "actor-2" },
      kind: "image",
      name: "secret.png",
      bytes: bytesOf(pngBytes(8, 8)),
    });

    const res = await agent.fetch(
      chatRequest({
        text: "Veja isto",
        intentionId: "intent-cross-1",
        attachments: [{ type: "image", ref: foreign.ref, name: "secret.png" }],
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { attachmentStates?: Array<{ state: string }> };
    expect(body.attachmentStates?.[0]?.state).toBe("unavailable");
  });

  it("(10) referência EXPIRADA vira estado explícito, não erro 500", async () => {
    installRelayMock();
    const { agent } = createAttachmentTestAgent();
    const storage = getAttachmentStorage((agent as unknown as { env: unknown }).env)!;
    const uploaded = await ingestAttachment({
      storage,
      identity: { workspaceId: "ws-1", actorId: "actor-1" },
      kind: "pdf",
      name: "extrato.pdf",
      bytes: bytesOf(pdfBytes()),
      now: 1_700_000_000_000,
    });
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000 + ATTACHMENT_TTL_MS + 1);

    const res = await agent.fetch(
      chatRequest({
        text: "Leia o extrato",
        intentionId: "intent-expired-1",
        attachments: [{ type: "pdf", ref: uploaded.ref, name: "extrato.pdf" }],
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { attachmentStates?: Array<{ state: string }> };
    expect(body.attachmentStates?.[0]?.state).toBe("unavailable");
  });

  it("(11) ref malformado não derruba o turno: estado explícito, sem 500", async () => {
    installRelayMock();
    const { agent } = createAttachmentTestAgent();
    const res = await agent.fetch(
      chatRequest({
        text: "Veja",
        intentionId: "intent-badref-1",
        attachments: [{ type: "image", ref: "../../etc/passwd" }],
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { attachmentStates?: Array<{ state: string }> };
    expect(body.attachmentStates?.[0]?.state).toBe("unavailable");
  });

  it("(12) SEM binding, uma referência não é resolvida e o estado é 'unavailable' (fail-closed)", async () => {
    installRelayMock();
    const { agent } = createAttachmentTestAgent({ withBucket: false });
    const res = await agent.fetch(
      chatRequest({
        text: "Veja",
        intentionId: "intent-nobucket-1",
        attachments: [{ type: "image", ref: "att_AAAAAAAAAAAAAAAAAAAAAA", name: "a.png" }],
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { attachmentStates?: Array<{ state: string }> };
    expect(body.attachmentStates?.[0]?.state).toBe("unavailable");
  });

  it("(13) anexo LEGADO {type,url,name} continua funcionando intocado (sem reference, sem estado)", async () => {
    installRelayMock();
    const { agent } = createAttachmentTestAgent();
    const res = await agent.fetch(
      chatRequest({
        text: "Sem anexo por referência",
        intentionId: "intent-legacy-1",
        attachments: [{ type: "image", url: "https://cdn.test/x.png", name: "x.png" }],
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { attachmentStates?: unknown };
    // O caminho legado não ganha estado novo: comportamento inalterado.
    expect(body.attachmentStates).toBeUndefined();
  });

  it("(14) bytes NUNCA atravessam o DLP: ref e nome persistem, conteúdo não", async () => {
    installRelayMock();
    const { agent, persisted } = createAttachmentTestAgent();
    const storage = getAttachmentStorage((agent as unknown as { env: unknown }).env)!;
    const uploaded = await ingestAttachment({
      storage,
      identity: { workspaceId: "ws-1", actorId: "actor-1" },
      kind: "image",
      name: "nota.png",
      bytes: bytesOf(pngBytes(8, 8)),
    });
    const res = await agent.fetch(
      chatRequest({
        text: "Analise",
        intentionId: "intent-nobytes-1",
        attachments: [{ type: "image", ref: uploaded.ref, name: "nota.png", data: "iVBORw0KGgoAAAANSUhEUg==" }],
      }),
    );
    expect(res.status).toBe(200);
    const blob = JSON.stringify({ persisted, body: await res.clone().json() });
    expect(blob).not.toContain("iVBORw0KGgo");
    expect(blob).not.toContain("AAABJRUU");
  });
});
