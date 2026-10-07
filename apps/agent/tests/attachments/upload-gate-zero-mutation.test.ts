/**
 * F1 PR-A fix (finding P2 do review REV-PRC-GOLDEN, Entrega 1) — zero-mutação
 * GLOBAL com o gate negado.
 *
 * A prova PR-C cobria zero-write de *upload* com flag OFF, mas dois deletes
 * R2 seguiam alcançáveis com o gate negando (binding presente, flag OFF):
 *   (a) limpeza de ref expirada no caminho de chat (`resolveAttachmentRef`
 *       apaga o objeto expirado mesmo com a capability desligada);
 *   (b) sweep de cleanup (`cleanupExpiredAttachments`).
 *
 * Contrato fail-closed: quando o gate PR-A nega
 * (`isAttachmentUploadAllowed === false`), NENHUMA mutação R2 executa — nem
 * `put` (já bloqueado) nem `delete` (cleanup de expirados e limpeza de ref
 * expirada passam a ser pulados; o objeto expirado aguarda a capability
 * ligada ou um janitor dedicado). Quando o gate permite, o comportamento
 * atual é preservado byte a byte (incluindo os deletes).
 *
 * Matriz (todas com binding presente):
 *   (1) chat + ref expirada + flag OFF ⇒ 0 deletes + `unavailable` honesto;
 *   (2) sweep + flag OFF ⇒ 0 deletes, expirados preservados;
 *   (3) `resolveAttachmentRef` com `allowDelete: false` ⇒ expira sem deletar;
 *   (4) preservação: gate ON + ref expirada ⇒ delete acontece como antes.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { ATTACHMENT_TTL_MS } from "../../src/attachments/types.js";
import { getAttachmentStorage } from "../../src/attachments/storage.js";
import {
  cleanupExpiredAttachments,
  ingestAttachment,
  resolveAttachmentRef,
} from "../../src/attachments/ingest.js";
import { isAttachmentUploadAllowed } from "../../src/attachments/upload-gate.js";
import { pdfBytes, pngBytes } from "./fixtures.js";
import {
  bytesOf,
  createAttachmentTestAgent,
  installRelayMock,
} from "./helpers.js";

const IDENTITY = { workspaceId: "ws-1", actorId: "actor-1" };
const GATE_OPT_IN = {
  extraEnv: { TED_ATTACHMENTS_ENABLED: "1", TED_ATTACHMENTS_COHORT: "ws-1,actor-1" },
};
const T0 = 1_700_000_000_000;

afterEach(() => {
  vi.restoreAllMocks();
});

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

const seedExpiredPdf = async (storage: NonNullable<ReturnType<typeof getAttachmentStorage>>) => {
  const uploaded = await ingestAttachment({
    storage,
    identity: { ...IDENTITY },
    kind: "pdf",
    name: "extrato.pdf",
    bytes: bytesOf(pdfBytes()),
    now: T0,
  });
  return uploaded;
};

describe("F1 PR-A fix — zero-mutação global com o gate negado (finding REV-PRC-GOLDEN P2)", () => {
  it("(1) chat com ref expirada + flag OFF ⇒ 0 deletes + 'unavailable' honesto, sem alegar processamento", async () => {
    installRelayMock();
    const { agent, bucket } = createAttachmentTestAgent();
    const env = (agent as unknown as { env: unknown }).env;
    // Escopo honesto: binding presente, flag OFF — o gate nega.
    expect(getAttachmentStorage(env)).not.toBeNull();
    expect(isAttachmentUploadAllowed(env, "ws-1", "actor-1")).toBe(false);
    const storage = getAttachmentStorage(env)!;
    const uploaded = await seedExpiredPdf(storage);
    const key = `ted/attachments/v1/${uploaded.ref}`;
    expect(bucket.objects.has(key)).toBe(true);

    let deletes = 0;
    const rawDelete = bucket.bucket.delete.bind(bucket.bucket);
    bucket.bucket.delete = async (k: string) => {
      deletes += 1;
      return rawDelete(k);
    };
    vi.spyOn(Date, "now").mockReturnValue(T0 + ATTACHMENT_TTL_MS + 1);

    const res = await agent.fetch(
      chatRequest({
        text: "Leia o extrato",
        intentionId: "intent-zero-mut-1",
        attachments: [{ type: "pdf", ref: uploaded.ref, name: "extrato.pdf" }],
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      attachmentStates?: Array<{ ref: string; state: string; detail: string }>;
    };
    expect(body.attachmentStates).toHaveLength(1);
    expect(body.attachmentStates?.[0]?.state).toBe("unavailable");
    expect(body.attachmentStates?.[0]?.detail).toBe("Não foi possível ler o anexo enviado.");
    // Zero-mutação: nenhum delete executou e o objeto segue no bucket.
    expect(deletes).toBe(0);
    expect(bucket.objects.has(key)).toBe(true);
  });

  it("(2) sweep com gate negado ⇒ 0 deletes, expirados preservados para a capability ligada ou janitor dedicado", async () => {
    const { agent, bucket } = createAttachmentTestAgent();
    const env = (agent as unknown as { env: unknown }).env;
    expect(isAttachmentUploadAllowed(env, "ws-1", "actor-1")).toBe(false);
    const storage = getAttachmentStorage(env)!;
    // Seed direto no storage (sem passar pelo ingest): o piggyback do upload
    // herdaria o gate da rota, mas aqui o alvo é o sweep isolado.
    const doomedRef = "att_0000000000000000000001";
    const liveRef = "att_0000000000000000000002";
    const record = (ref: string, expiresAt: number) => ({
      ref,
      workspaceId: "ws-1",
      actorId: "actor-1",
      kind: "image" as const,
      name: `${ref}.png`,
      size: 33,
      sha256: "b".repeat(64),
      createdAt: T0 - 10_000,
      expiresAt,
      mime: "image/png",
    });
    await storage.put(record(doomedRef, 1_000), bytesOf(pngBytes(7, 7)));
    await storage.put(record(liveRef, 9_999_999_999_999), bytesOf(pngBytes(6, 6)));
    expect(bucket.objects.size).toBe(2);

    // O mesmo gate do upload condiciona o sweep: negou ⇒ sem deletes.
    const allowDelete = isAttachmentUploadAllowed(env, "ws-1", "actor-1");
    const report = await cleanupExpiredAttachments(storage, T0, { allowDelete });
    expect(report).toEqual({ scanned: 0, deleted: 0, failed: false });
    expect(await storage.get(doomedRef)).not.toBeNull();
    expect(await storage.get(liveRef)).not.toBeNull();
    expect(bucket.objects.size).toBe(2);
  });

  it("(3) resolveAttachmentRef com allowDelete:false expira sem deletar (resposta tipada inalterada)", async () => {
    const { agent } = createAttachmentTestAgent();
    const storage = getAttachmentStorage((agent as unknown as { env: unknown }).env)!;
    const uploaded = await ingestAttachment({
      storage,
      identity: { ...IDENTITY },
      kind: "pdf",
      name: "a.pdf",
      bytes: bytesOf(pdfBytes()),
      now: T0,
    });
    await expect(
      resolveAttachmentRef({
        storage,
        identity: { ...IDENTITY },
        ref: uploaded.ref,
        expectedKind: "pdf",
        now: T0 + ATTACHMENT_TTL_MS + 1,
        allowDelete: false,
      }),
    ).rejects.toMatchObject({ code: "attachment_expired" });
    expect(await storage.get(uploaded.ref)).not.toBeNull();
  });

  it("(4) preservação: gate ON + ref expirada ⇒ o delete acontece como antes (comportamento permitido intacto)", async () => {
    installRelayMock();
    const { agent, bucket } = createAttachmentTestAgent(GATE_OPT_IN);
    const env = (agent as unknown as { env: unknown }).env;
    expect(isAttachmentUploadAllowed(env, "ws-1", "actor-1")).toBe(true);
    const storage = getAttachmentStorage(env)!;
    const uploaded = await seedExpiredPdf(storage);
    const key = `ted/attachments/v1/${uploaded.ref}`;

    let deletes = 0;
    const rawDelete = bucket.bucket.delete.bind(bucket.bucket);
    bucket.bucket.delete = async (k: string) => {
      deletes += 1;
      return rawDelete(k);
    };
    vi.spyOn(Date, "now").mockReturnValue(T0 + ATTACHMENT_TTL_MS + 1);

    const res = await agent.fetch(
      chatRequest({
        text: "Leia o extrato",
        intentionId: "intent-zero-mut-2",
        attachments: [{ type: "pdf", ref: uploaded.ref, name: "extrato.pdf" }],
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      attachmentStates?: Array<{ state: string }>;
    };
    expect(body.attachmentStates?.[0]?.state).toBe("unavailable");
    expect(deletes).toBe(1);
    expect(bucket.objects.has(key)).toBe(false);
  });
});
