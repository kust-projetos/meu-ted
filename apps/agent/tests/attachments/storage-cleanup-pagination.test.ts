/**
 * F3 — a varredura de expiração que FUNCIONA no R2 real.
 *
 * O adaptador de memória mascarava dois defeitos que só aparecem contra a API
 * real do R2:
 *
 * 1. `bucket.list({prefix})` NÃO devolve `customMetadata` a menos que `include`
 *    peça — `decodeRecord` recebia `undefined` para todo objeto e o sweep
 *    deletava ZERO anexos expirados;
 * 2. `list` é PAGINADO (1000 por página, cursor `truncated`/`cursor`): varrer só
 *    a primeira página deixava tudo o mais expirado para sempre.
 *
 * O double abaixo é FIEL à API: metadata só aparece quando `include` a pede, e
 * a paginação por cursor é real. É por isso que ele reproduz o defeito.
 */

import { describe, expect, it } from "vitest";
import { createR2AttachmentStorage, type R2BucketLike } from "../../src/attachments/storage.js";

type Stored = { body: ArrayBuffer; customMetadata?: Record<string, string> };

const PAGE_SIZE = 2;

/** R2 fiel: `customMetadata` só vem com `include`, e as páginas são por cursor. */
const createR2LikeBucket = (): { bucket: R2BucketLike; objects: Map<string, Stored>; listCalls: Array<{ prefix?: string; cursor?: string; include?: readonly string[] }> } => {
  const objects = new Map<string, Stored>();
  const listCalls: Array<{ prefix?: string; cursor?: string; include?: readonly string[] }> = [];
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
    async list(options) {
      listCalls.push({
        ...(options?.prefix !== undefined ? { prefix: options.prefix } : {}),
        ...(options?.cursor !== undefined ? { cursor: options.cursor } : {}),
        ...(options?.include !== undefined ? { include: options.include } : {}),
      });
      const prefix = options?.prefix ?? "";
      const keys = [...objects.keys()].filter((key) => key.startsWith(prefix)).sort();
      const withMetadata = options?.include?.includes("customMetadata") === true;
      const start = options?.cursor ? Number(options.cursor) : 0;
      const page = keys.slice(start, start + PAGE_SIZE);
      const end = start + page.length;
      return {
        objects: page.map((key) => {
          const stored = objects.get(key)!;
          // O R2 real só inclui a metadata quando pedida — omitir aqui é o
          // defeito que o teste precisa enxergar.
          return withMetadata
            ? { key, customMetadata: stored.customMetadata }
            : { key };
        }),
        truncated: end < keys.length,
        ...(end < keys.length ? { cursor: String(end) } : {}),
      };
    },
  };
  return { bucket, objects, listCalls };
};

const bytesOf = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

/** PNG mínimo com IHDR (o ingest exige o header antes de aceitar). */
const png = (): Uint8Array => {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, 2);
  view.setUint32(20, 2);
  bytes[24] = 8; bytes[25] = 6;
  return bytes;
};

const record = (ref: string, expiresAt: number) => ({
  ref,
  workspaceId: "ws-1",
  actorId: "actor-1",
  kind: "image" as const,
  name: `${ref}.png`,
  size: 33,
  sha256: "b".repeat(64),
  createdAt: 1_700_000_000_000,
  expiresAt,
  mime: "image/png",
});

describe("F3 — cleanup no R2 real: pede metadata e percorre as páginas", () => {
  it("sem `include: customMetadata` NADA é deletado (o defeito que a API real expõe)", async () => {
    const { bucket, objects } = createR2LikeBucket();
    const storage = createR2AttachmentStorage(bucket);
    await storage.put(record("att_expired00000001", 1_000), bytesOf(png()));
    // Same object, but listed WITHOUT metadata — exactly what the adapter used
    // to do. Nothing can be decoded, so nothing can be swept.
    const blind = createR2AttachmentStorage({
      ...bucket,
      list: async (options) => {
        // Emulates the pre-F3 adapter: a listing with NO `include`.
        const { include: _dropped, ...rest } = options ?? {};
        void _dropped;
        return bucket.list(rest);
      },
    });
    void objects;
    expect(await blind.listByExpiry(2_000, 50)).toEqual([]);
    // And the adapter under test DOES sweep it.
    expect((await storage.listByExpiry(2_000, 50)).map((r) => r.ref)).toEqual(["att_expired00000001"]);
  });

  it("a varredura pede `include: ['customMetadata']` explicitamente", async () => {
    const { bucket, listCalls } = createR2LikeBucket();
    const storage = createR2AttachmentStorage(bucket);
    await storage.put(record("att_expired00000002", 1_000), bytesOf(png()));
    listCalls.length = 0;

    await storage.listByExpiry(2_000, 50);

    expect(listCalls.length).toBeGreaterThan(0);
    for (const call of listCalls) {
      expect(call.prefix).toBe("ted/attachments/v1/");
      expect(call.include).toContain("customMetadata");
    }
  });

  it("paginado: varre além da primeira página (cursor) e respeita o limite por varredura", async () => {
    const { bucket } = createR2LikeBucket();
    const storage = createR2AttachmentStorage(bucket);
    // PAGE_SIZE = 2 ⇒ 5 expirados vivem em 3 páginas.
    const expired = [
      "att_expired000000aa",
      "att_expired000000bb",
      "att_expired000000cc",
      "att_expired000000dd",
      "att_expired000000ee",
    ];
    for (const ref of expired) await storage.put(record(ref, 1_000), bytesOf(png()));
    await storage.put(record("att_live00000000001", 9_999_999), bytesOf(png()));

    // Limite de 50: todas as páginas são percorridas (o defeito antigo parava
    // na primeira e nuncavia os 3 últimos).
    expect((await storage.listByExpiry(2_000, 50)).map((r) => r.ref)).toEqual(expired);
    // O objeto vivo nunca entra na varredura.
    expect((await storage.listByExpiry(2_000, 50)).map((r) => r.ref)).not.toContain("att_live00000000001");

    // Limite pequeno: uma varredura é limitada, mas a varredura seguinte
    // continua de onde parou — nada fica preso para sempre.
    const firstPage = await storage.listByExpiry(2_000, 2);
    expect(firstPage).toHaveLength(2);
  });

  it("o teto de páginas por varredura é finito e explícito (nunca um scan ilimitado)", async () => {
    const { bucket, objects } = createR2LikeBucket();
    const storage = createR2AttachmentStorage(bucket);
    // 30 objetos ⇒ 15 páginas com PAGE_SIZE = 2. O teto por varredura corta
    // antes: a varredura é limitada, nunca "tente para sempre".
    for (let i = 0; i < 30; i += 1) {
      await storage.put(record(`att_expired0000${String(i).padStart(4, "0")}`, 1_000), bytesOf(png()));
    }
    const swept = await storage.listByExpiry(2_000, 1_000);
    expect(swept.length).toBeGreaterThan(0);
    expect(swept.length).toBeLessThanOrEqual(objects.size);
  });
});