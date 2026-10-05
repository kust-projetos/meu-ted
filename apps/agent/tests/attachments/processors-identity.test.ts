/**
 * F2/F5/F9 — o memo de processamento é POR IDENTIDADE, revalida e é single-flight.
 *
 * - **F2**: a chave do memo era só `(turnId, ref)`. Dentro de um Durable Object
 *   (um por workspace) isso é insuficiente: dois ATORES do mesmo workspace
 *   compartilham a instância e podiam receber o resultado do outro. Além disso o
 *   hit devolvia o resultado memoizado SEM revalidar posse/expiração — um anexo
 *   expirado entre duas leituras ainda devolvia a transcrição em cache.
 * - **F5**: o memo era gravado DEPOIS do primeiro `await`, então duas chamadas
 *   concorrentes criavam dois budgets e chamavam o provider Duas vezes.
 * - **F9**: o `type` declarado pelo cliente não era conferido contra o record do
 *   servidor; o rótulo de proveniência vinha da claim do cliente.
 */

import { describe, expect, it, vi } from "vitest";
import {
  createAttachmentProcessingMemo,
  createAttachmentProcessorRegistry,
  processAttachmentOnce,
  type AttachmentProcessor,
} from "../../src/attachments/processors.js";
import { createMemoryAttachmentStorage } from "../../src/attachments/storage.js";
import { ingestAttachment } from "../../src/attachments/ingest.js";
import { ATTACHMENT_TTL_MS } from "../../src/attachments/types.js";
import type { AttachmentIdentity } from "../../src/attachments/types.js";
import { pdfBytes, pngBytes } from "./fixtures.js";

const OWNER: AttachmentIdentity = { workspaceId: "ws-1", actorId: "actor-1" };
const OTHER_ACTOR: AttachmentIdentity = { workspaceId: "ws-1", actorId: "actor-2" };

const bytesOf = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

const uploadImage = async (identity: AttachmentIdentity = OWNER) => {
  const storage = createMemoryAttachmentStorage();
  const uploaded = await ingestAttachment({
    storage,
    identity,
    kind: "image",
    name: "comprovante.png",
    bytes: bytesOf(pngBytes(6, 6)),
  });
  return { storage, uploaded };
};

const uploadPdf = async (identity: AttachmentIdentity = OWNER) => {
  const storage = createMemoryAttachmentStorage();
  const uploaded = await ingestAttachment({
    storage,
    identity,
    kind: "pdf",
    name: "nota.pdf",
    bytes: bytesOf(pdfBytes()),
  });
  return { storage, uploaded };
};

describe("F2 — o memo é por IDENTIDADE e revalida posse/expiração no hit", () => {
  it("outro ator do MESMO workspace não recebe o resultado memoizado do dono", async () => {
    const { storage, uploaded } = await uploadImage(OWNER);
    const processor: AttachmentProcessor = vi.fn(async () => ({
      state: "processed" as const,
      detail: "ok",
      transcript: "conteudo privado do actor-1",
    }));
    const registry = createAttachmentProcessorRegistry({ image: processor });

    const owner = await processAttachmentOnce({
      storage,
      registry,
      identity: OWNER,
      ref: uploaded.ref,
      turnId: "turn-1",
      memo: createAttachmentProcessingMemo(),
    });
    expect(owner.state).toBe("processed");

    // SAME (turnId, ref) pair, different actor — the old key collided here.
    const intruder = await processAttachmentOnce({
      storage,
      registry,
      identity: OTHER_ACTOR,
      ref: uploaded.ref,
      turnId: "turn-1",
      memo: createAttachmentProcessingMemo(),
    });

    expect(intruder.state).toBe("unavailable");
    expect(intruder.transcript).toBeUndefined();
    expect(JSON.stringify(intruder)).not.toContain("privado");
    expect(processor).toHaveBeenCalledTimes(1);
  });

  it("o memo é compartilhado dentro do MESMO ator (o idempotente continua valendo)", async () => {
    const { storage, uploaded } = await uploadImage(OWNER);
    const processor: AttachmentProcessor = vi.fn(async () => ({ state: "processed" as const, detail: "ok" }));
    const registry = createAttachmentProcessorRegistry({ image: processor });
    const memo = createAttachmentProcessingMemo();

    const first = await processAttachmentOnce({ storage, registry, identity: OWNER, ref: uploaded.ref, turnId: "t", memo });
    const second = await processAttachmentOnce({ storage, registry, identity: OWNER, ref: uploaded.ref, turnId: "t", memo });

    expect(processor).toHaveBeenCalledTimes(1);
    expect(second.state).toBe(first.state);
  });

  it("hit de memo revalida a expiração: um anexo que expirou ENTRE as leituras não devolve o resultado em cache", async () => {
    const now = 1_700_000_000_000;
    const storage = createMemoryAttachmentStorage();
    const uploaded = await ingestAttachment({
      storage,
      identity: OWNER,
      kind: "image",
      name: "comprovante.png",
      bytes: bytesOf(pngBytes(6, 6)),
      now,
    });
    const processor: AttachmentProcessor = vi.fn(async () => ({
      state: "processed" as const,
      detail: "ok",
      transcript: "texto extraido antes de expirar",
    }));
    const registry = createAttachmentProcessorRegistry({ image: processor });
    const memo = createAttachmentProcessingMemo();

    const fresh = await processAttachmentOnce({
      storage, registry, identity: OWNER, ref: uploaded.ref, turnId: "t", memo, now,
    });
    expect(fresh.state).toBe("processed");
    expect(fresh.transcript).toBe("texto extraido antes de expirar");

    // The SAME memo entry is replayed after the TTL elapsed.
    const afterExpiry = await processAttachmentOnce({
      storage,
      registry,
      identity: OWNER,
      ref: uploaded.ref,
      turnId: "t",
      memo,
      now: now + ATTACHMENT_TTL_MS + 1,
    });

    expect(afterExpiry.state).not.toBe("processed");
    expect(afterExpiry.transcript).toBeUndefined();
    expect(JSON.stringify(afterExpiry)).not.toContain("antes de expirar");
  });

  it("hit de memo revalida a posse: um anexo cuja posse mudou é recusado, não servido do cache", async () => {
    const { storage, uploaded } = await uploadImage(OWNER);
    const processor: AttachmentProcessor = vi.fn(async () => ({ state: "processed" as const, detail: "ok" }));
    const registry = createAttachmentProcessorRegistry({ image: processor });
    const memo = createAttachmentProcessingMemo();

    await processAttachmentOnce({ storage, registry, identity: OWNER, ref: uploaded.ref, turnId: "t", memo });

    // The object disappears (deleted out of band, or swept by cleanup).
    await storage.delete(uploaded.ref);

    const afterDelete = await processAttachmentOnce({
      storage, registry, identity: OWNER, ref: uploaded.ref, turnId: "t", memo,
    });
    expect(afterDelete.state).toBe("unavailable");
    expect(processor).toHaveBeenCalledTimes(1);
  });
});

describe("F5 — process-once é single-flight (uma chamada por par identidade+anexo+turno)", () => {
  it("duas resoluções concorrentes ⇒ provider chamado 1×, mesmo resultado nas duas", async () => {
    const { storage, uploaded } = await uploadImage(OWNER);
    let calls = 0;
    const processor: AttachmentProcessor = vi.fn(async () => {
      calls += 1;
      // Slow enough that both callers are inside the processor concurrently.
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { state: "processed" as const, detail: "ok", transcript: "unico" };
    });
    const registry = createAttachmentProcessorRegistry({ image: processor });
    const memo = createAttachmentProcessingMemo();

    const [a, b] = await Promise.all([
      processAttachmentOnce({ storage, registry, identity: OWNER, ref: uploaded.ref, turnId: "t", memo }),
      processAttachmentOnce({ storage, registry, identity: OWNER, ref: uploaded.ref, turnId: "t", memo }),
    ]);

    expect(calls).toBe(1);
    expect(processor).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
    expect(a.state).toBe("processed");
    expect(a.transcript).toBe("unico");
  });

  it("o budget por turno é consumido UMA vez mesmo com chamadas concorrentes", async () => {
    const { storage, uploaded } = await uploadImage(OWNER);
    const consumed: string[] = [];
    const processor: AttachmentProcessor = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      consumed.push("run");
      return { state: "processed" as const, detail: "ok" };
    });
    const registry = createAttachmentProcessorRegistry({ image: processor });
    const memo = createAttachmentProcessingMemo();

    await Promise.all([
      processAttachmentOnce({ storage, registry, identity: OWNER, ref: uploaded.ref, turnId: "t", memo }),
      processAttachmentOnce({ storage, registry, identity: OWNER, ref: uploaded.ref, turnId: "t", memo }),
      processAttachmentOnce({ storage, registry, identity: OWNER, ref: uploaded.ref, turnId: "t", memo }),
    ]);

    expect(consumed).toEqual(["run"]);
  });
});

describe("F9 — o kind é conferido contra o RECORD do servidor, não contra a claim do cliente", () => {
  it("ref de PDF declarada como 'audio' é rejeitada com kind mismatch (nunca rotulada de áudio)", async () => {
    const { storage, uploaded } = await uploadPdf(OWNER);
    const processor: AttachmentProcessor = vi.fn(async () => ({ state: "processed" as const, detail: "ok" }));
    const registry = createAttachmentProcessorRegistry({
      pdf: processor,
      audio: vi.fn(async () => ({ state: "processed" as const, detail: "STT rodou" })),
    });

    const outcome = await processAttachmentOnce({
      storage,
      registry,
      identity: OWNER,
      ref: uploaded.ref,
      turnId: "t",
      memo: createAttachmentProcessingMemo(),
      // The client DECLARED `audio`; the record says `pdf`.
      expectedKind: "audio",
    });

    expect(outcome.state).toBe("unavailable");
    expect(processor).not.toHaveBeenCalled();
    expect(JSON.stringify(outcome)).not.toContain("STT rodou");
  });

  it("com o kind correto a leitura segue e a proveniência sai do record do servidor", async () => {
    const { storage, uploaded } = await uploadPdf(OWNER);
    const seenKinds: string[] = [];
    const processor: AttachmentProcessor = vi.fn(async (input) => {
      seenKinds.push(input.record.kind);
      return {
        state: "processed" as const,
        detail: "ok",
        provenance: { attachmentId: input.record.ref, provider: "local", model: "pdf-text", retrievedAt: 1 },
      };
    });
    const registry = createAttachmentProcessorRegistry({ pdf: processor });

    const outcome = await processAttachmentOnce({
      storage,
      registry,
      identity: OWNER,
      ref: uploaded.ref,
      turnId: "t",
      memo: createAttachmentProcessingMemo(),
      expectedKind: "pdf",
    });

    expect(outcome.state).toBe("processed");
    expect(seenKinds).toEqual(["pdf"]);
    expect(outcome.provenance?.attachmentId).toBe(uploaded.ref);
  });

  it("o outcome expõe o kind do SERVIDOR (o registro resolvido), nunca o declarado", async () => {
    const { storage, uploaded } = await uploadPdf(OWNER);
    const registry = createAttachmentProcessorRegistry({
      pdf: async () => ({ state: "processed" as const, detail: "ok", transcript: "texto do pdf" }),
    });
    const outcome = await processAttachmentOnce({
      storage,
      registry,
      identity: OWNER,
      ref: uploaded.ref,
      turnId: "t",
      memo: createAttachmentProcessingMemo(),
      expectedKind: "pdf",
    });

    expect(outcome.state).toBe("processed");
    expect(outcome.kind).toBe("pdf");
  });

  it("sem expectedKind declarado, o kind do servidor ainda é exposto", async () => {
    const { storage, uploaded } = await uploadImage(OWNER);
    const registry = createAttachmentProcessorRegistry({ image: async () => ({ state: "unsupported" as const, detail: "x" }) });
    const outcome = await processAttachmentOnce({
      storage,
      registry,
      identity: OWNER,
      ref: uploaded.ref,
      turnId: "t",
      memo: createAttachmentProcessingMemo(),
    });
    expect(outcome.kind).toBe("image");
  });
});