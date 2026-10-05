import { describe, expect, it } from "vitest";
import {
  constantTimeEquals,
  createMemoryAttachmentStorage,
  createR2AttachmentStorage,
  getAttachmentStorage,
  type AttachmentStorage,
  type R2BucketLike,
} from "../../src/attachments/storage.js";
import { pngBytes } from "./fixtures.js";

const bytesOf = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

type Stored = { body: ArrayBuffer; customMetadata?: Record<string, string> };

/** Minimal R2 double: only the four members the adapter may touch. */
const createFakeBucket = () => {
  const objects = new Map<string, Stored>();
  const bucket: R2BucketLike = {
    async put(key, value, options) {
      objects.set(key, { body: value, customMetadata: options?.customMetadata });
    },
    async get(key) {
      const found = objects.get(key);
      if (!found) return null;
      return {
        arrayBuffer: async () => found.body,
        customMetadata: found.customMetadata,
      };
    },
    async delete(key) {
      objects.delete(key);
    },
    async list(options) {
      const prefix = options?.prefix ?? "";
      return {
        objects: [...objects.entries()]
          .filter(([key]) => key.startsWith(prefix))
          .map(([key, value]) => ({ key, customMetadata: value.customMetadata })),
        truncated: false,
      };
    },
  };
  return { bucket, objects };
};

const RECORD = {
  ref: "att_abcdefghijklmnop",
  workspaceId: "ws-1",
  actorId: "actor-1",
  kind: "image" as const,
  name: "a.png",
  size: 33,
  sha256: "a".repeat(64),
  createdAt: 1_700_000_000_000,
  expiresAt: 1_700_000_000_000 + 86_400_000,
  mime: "image/png",
};

describe("A13 — AttachmentStorage: memória (testes) e R2 (produção)", () => {
  it("round-trip em memória: put/get/delete", async () => {
    const storage = createMemoryAttachmentStorage();
    const bytes = pngBytes(4, 4);
    await storage.put(RECORD, bytesOf(bytes));
    const found = await storage.get(RECORD.ref);
    expect(found?.record.sha256).toBe(RECORD.sha256);
    expect(new Uint8Array(found!.bytes)).toEqual(bytes);
    await storage.delete(RECORD.ref);
    expect(await storage.get(RECORD.ref)).toBeNull();
  });

  it("listByExpiry filtra por expiresAt e respeita o limite", async () => {
    const storage = createMemoryAttachmentStorage();
    await storage.put({ ...RECORD, ref: "att_1111111111111111", expiresAt: 1000 }, new ArrayBuffer(1));
    await storage.put({ ...RECORD, ref: "att_2222222222222222", expiresAt: 5000 }, new ArrayBuffer(1));
    const expired = await storage.listByExpiry(2000, 10);
    expect(expired.map((r) => r.ref)).toEqual(["att_1111111111111111"]);
    expect((await storage.listByExpiry(9999, 10)).length).toBe(2);
    expect((await storage.listByExpiry(9999, 1)).length).toBe(1);
  });

  it("adapter R2 grava os metadados em customMetadata (sem bytes na chave)", async () => {
    const { bucket, objects } = createFakeBucket();
    const storage = createR2AttachmentStorage(bucket);
    const bytes = pngBytes(4, 4);
    await storage.put(RECORD, bytesOf(bytes));

    const [key, stored] = [...objects.entries()][0]!;
    expect(key).toContain(RECORD.ref);
    expect(key).not.toContain("ws-1/actor-1/raw");
    expect(stored.customMetadata?.sha256).toBe(RECORD.sha256);
    expect(JSON.stringify(stored.customMetadata)).not.toContain("data:");

    const found = await storage.get(RECORD.ref);
    expect(found?.record.kind).toBe("image");
    expect(new Uint8Array(found!.bytes)).toEqual(bytes);
  });

  it("adapter R2 devolve null para chave ausente (get é miss, não erro)", async () => {
    const { bucket } = createFakeBucket();
    const storage = createR2AttachmentStorage(bucket);
    expect(await storage.get("att_0000000000000000")).toBeNull();
  });

  it("adapter R2 listByExpiry usa o prefixo e filtra nos metadados", async () => {
    const { bucket } = createFakeBucket();
    const storage = createR2AttachmentStorage(bucket);
    await storage.put({ ...RECORD, ref: "att_3333333333333333", expiresAt: 10 }, new ArrayBuffer(1));
    await storage.put({ ...RECORD, ref: "att_4444444444444444", expiresAt: 90_000 }, new ArrayBuffer(1));
    expect((await storage.listByExpiry(1_000, 10)).map((r) => r.ref)).toEqual(["att_3333333333333333"]);
  });

  it("storage ausente ⇒ getAttachmentStorage devolve null (capacidade off, fail-closed)", () => {
    expect(getAttachmentStorage(undefined)).toBeNull();
    expect(getAttachmentStorage({})).toBeNull();
    expect(getAttachmentStorage({ TED_ATTACHMENTS_BUCKET: undefined })).toBeNull();
    // binding não-R2 é ignorado, nunca tratado como storage.
    expect(getAttachmentStorage({ TED_ATTACHMENTS_BUCKET: { nope: true } })).toBeNull();
  });

  it("binding R2 presente ⇒ getAttachmentStorage devolve o adapter", () => {
    const { bucket } = createFakeBucket();
    const resolved: AttachmentStorage | null = getAttachmentStorage({ TED_ATTACHMENTS_BUCKET: bucket });
    expect(resolved).not.toBeNull();
    expect(typeof resolved?.put).toBe("function");
  });
});

/**
 * F11 — o ref é um token derivado de HMAC, então a checagem de igualdade não
 * pode sair no primeiro byte diferente (`===` sai cedo). `constantTimeEquals`
 * percorre sempre o comprimento inteiro, e `storage.get` a usa no lugar da
 * comparação do ref: um metadado cujo `ref` diverge da chave é um MISS, nunca
 * um hit cross-identity.
 */
describe("F11 — igualdade do ref opaco em tempo constante", () => {
  it("compara corretamente conteúdo e comprimento", () => {
    expect(constantTimeEquals("", "")).toBe(true);
    expect(constantTimeEquals("att_abc", "att_abc")).toBe(true);
    expect(constantTimeEquals("att_abc", "att_abd")).toBe(false);
    // Length mismatch is also a mismatch — never a prefix match.
    expect(constantTimeEquals("att_abc", "att_abcd")).toBe(false);
    expect(constantTimeEquals("att_abc", "")).toBe(false);
    expect(constantTimeEquals("", "att_abc")).toBe(false);
  });

  it("o adapter R2 recusa um metadado cujo ref diverge da chave (miss, não hit)", async () => {
    const objects = new Map<string, Stored>();
    const bucket: R2BucketLike = {
      async put(key, value, options) {
        objects.set(key, { body: value, customMetadata: options?.customMetadata });
      },
      async get(key) {
        const found = objects.get(key);
        if (!found) return null;
        return { arrayBuffer: async () => found.body, customMetadata: found.customMetadata };
      },
      async delete(key) {
        objects.delete(key);
      },
      async list() {
        return { objects: [], truncated: false };
      },
    };
    // Stored under RECORD.ref's key, but the metadata claims a DIFFERENT ref.
    objects.set(`ted/attachments/v1/${RECORD.ref}`, {
      body: bytesOf(pngBytes(4, 4)),
      customMetadata: {
        ref: "att_ffffffffffffffff",
        workspaceId: RECORD.workspaceId,
        actorId: RECORD.actorId,
        kind: RECORD.kind,
        name: RECORD.name,
        size: String(RECORD.size),
        sha256: RECORD.sha256,
        createdAt: String(RECORD.createdAt),
        expiresAt: String(RECORD.expiresAt),
        mime: RECORD.mime,
      },
    });

    const storage = createR2AttachmentStorage(bucket);
    expect(await storage.get(RECORD.ref)).toBeNull();
  });
});
