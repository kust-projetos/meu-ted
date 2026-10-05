import { describe, expect, it, vi } from "vitest";
import {
  createAttachmentProcessingMemo,
  createAttachmentProcessorRegistry,
  processAttachmentOnce,
  type AttachmentProcessingMemo,
  type AttachmentProcessor,
} from "../../src/attachments/processors.js";
import { createMemoryAttachmentStorage } from "../../src/attachments/storage.js";
import { ingestAttachment } from "../../src/attachments/ingest.js";
import type { AttachmentIdentity } from "../../src/attachments/types.js";
import { pngBytes } from "./fixtures.js";

const IDENTITY: AttachmentIdentity = { workspaceId: "ws-1", actorId: "actor-1" };

const bytesOf = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

/** Fresh guard state per case: the memo is per-instance, never module-global. */
let memo: AttachmentProcessingMemo;
const freshMemo = (): AttachmentProcessingMemo => {
  memo = createAttachmentProcessingMemo();
  return memo;
};

const uploadFixture = async () => {
  const storage = createMemoryAttachmentStorage();
  const uploaded = await ingestAttachment({
    storage,
    identity: IDENTITY,
    kind: "image",
    name: "comprovante.png",
    bytes: bytesOf(pngBytes(6, 6)),
  });
  return { storage, uploaded, memo: freshMemo() };
};

describe("A13/AC21 — registry de processors por kind (V1 fail-closed)", () => {
  it("V1 registra image, pdf e audio, e TODOS são 'unsupported' (nada é fingido)", () => {
    const registry = createAttachmentProcessorRegistry();
    for (const kind of ["image", "pdf", "audio"] as const) {
      expect(registry.supports(kind)).toBe(true);
      expect(registry.isReady(kind)).toBe(false);
    }
  });

  it("processar um anexo V1 devolve estado explícito 'unsupported' — nunca vazio/sucesso", async () => {
    const { storage, uploaded, memo: guard } = await uploadFixture();
    const outcome = await processAttachmentOnce({
      storage,
      registry: createAttachmentProcessorRegistry(),
      identity: IDENTITY,
      ref: uploaded.ref,
      turnId: "turn-1",
      memo: guard,
    });
    expect(outcome.state).toBe("unsupported");
    expect(outcome.detail).toBeTruthy();
    expect(outcome.detail).toMatch(/não é processado|não suportado|ainda/i);
  });

  it("kind fora da allowlist não tem processor (registry fecha)", () => {
    const registry = createAttachmentProcessorRegistry();
    expect(registry.supports("video" as never)).toBe(false);
  });
});

describe("A13/AC21 — idempotência de reprocessamento por (anexo, turno)", () => {
  it("processor fake roda UMA vez por (anexo, turno); repetir devolve o mesmo estado memoizado", async () => {
    const { storage, uploaded, memo: guard } = await uploadFixture();
    const processor: AttachmentProcessor = vi.fn(async () => ({
      state: "processed" as const,
      detail: "ok",
    }));
    const registry = createAttachmentProcessorRegistry({ image: processor });

    const first = await processAttachmentOnce({
      storage, registry, identity: IDENTITY, ref: uploaded.ref, turnId: "turn-1", memo: guard,
    });
    const second = await processAttachmentOnce({
      storage, registry, identity: IDENTITY, ref: uploaded.ref, turnId: "turn-1", memo: guard,
    });

    expect(processor).toHaveBeenCalledTimes(1);
    expect(first.state).toBe("processed");
    expect(second.state).toBe("processed");
    expect(second.detail).toBe(first.detail);
  });

  it("turno diferente reprocessa (a guarda é por (anexo, turno), não só por anexo)", async () => {
    const { storage, uploaded, memo: guard } = await uploadFixture();
    const processor: AttachmentProcessor = vi.fn(async () => ({ state: "processed" as const, detail: "ok" }));
    const registry = createAttachmentProcessorRegistry({ image: processor });

    await processAttachmentOnce({ storage, registry, identity: IDENTITY, ref: uploaded.ref, turnId: "turn-1", memo: guard });
    await processAttachmentOnce({ storage, registry, identity: IDENTITY, ref: uploaded.ref, turnId: "turn-2", memo: guard });
    expect(processor).toHaveBeenCalledTimes(2);
  });

  it("um anexo de outro tenant não é processado (nem memoizado no escopo alheio)", async () => {
    const { storage, uploaded, memo: guard } = await uploadFixture();
    const processor: AttachmentProcessor = vi.fn(async () => ({ state: "processed" as const, detail: "ok" }));
    const registry = createAttachmentProcessorRegistry({ image: processor });

    const crossTenant = await processAttachmentOnce({
      storage,
      registry,
      identity: { workspaceId: "ws-2", actorId: "actor-1" },
      ref: uploaded.ref,
      turnId: "turn-1",
      memo: guard,
    });
    expect(crossTenant.state).toBe("unavailable");
    expect(processor).not.toHaveBeenCalled();
  });

  it("o processor recebe bytes, mas o turno NUNCA devolve bytes — só estado e metadados", async () => {
    const { storage, uploaded, memo: guard } = await uploadFixture();
    let seen: number | null = null;
    const processor: AttachmentProcessor = vi.fn(async (input) => {
      seen = input.bytes.byteLength;
      return { state: "processed" as const, detail: "ok" };
    });
    const registry = createAttachmentProcessorRegistry({ image: processor });
    const outcome = await processAttachmentOnce({
      storage, registry, identity: IDENTITY, ref: uploaded.ref, turnId: "turn-1", memo: guard,
    });
    expect(seen).toBe(33);
    expect(JSON.stringify(outcome)).not.toContain("bytes");
    // F9: `kind` joined the projection as the SERVER record's kind (the A13
    // shape was `{state, detail, ref}`; the client-declared kind is never a
    // source of truth, so it is the record's kind that travels out).
    expect(Object.keys(outcome).sort()).toEqual(["detail", "kind", "ref", "state"]);
    expect(outcome.kind).toBe("image");
  });

  it("processor que falha produz estado explícito 'failed' — nunca vazio", async () => {
    const { storage, uploaded, memo: guard } = await uploadFixture();
    const processor: AttachmentProcessor = vi.fn(async () => {
      throw new Error("exploded");
    });
    const registry = createAttachmentProcessorRegistry({ image: processor });
    const outcome = await processAttachmentOnce({
      storage, registry, identity: IDENTITY, ref: uploaded.ref, turnId: "turn-1", memo: guard,
    });
    expect(outcome.state).toBe("failed");
    expect(outcome.detail).toBeTruthy();
  });
});
