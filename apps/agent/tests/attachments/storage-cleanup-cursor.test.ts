/**
 * A19 — o cursor de varredura do cleanup de anexos (a inanição determinística).
 *
 * O sweep de TTL só era disparado por upload, andava no máximo
 * `ATTACHMENT_CLEANUP_MAX_PAGES` (10) páginas e mantinha o cursor numa VARIÁVEL
 * LOCAL que morria com a chamada. Consequência: toda varredura recomeçava no
 * prefixo, então com mais de 10 páginas de objetos VIVOS antes dos expirados os
 * expirados NUNCA eram alcançados — um vazamento determinístico, não uma
 * corrida.
 *
 * O que este arquivo fixa:
 *   - o cursor da última página consumida é persistido entre varreduras;
 *   - ao alcançar o FIM da listagem o checkpoint é LIMPO (a próxima recomeça no
 *     prefixo — wrap-around), então nada é pulado para sempre;
 *   - um cursor INVÁLIDO (o R2 pode rejeitar um token velho) não quebra o
 *     upload: a varredura recomeça no prefixo;
 *   - um delete que falha no meio não esconde os outros e não perde o cursor;
 *   - o DO persiste o cursor no KV e o apaga no wrap.
 *
 * O double de bucket é FIEL ao R2 em dois pontos que importam: a metadata só
 * vem com `include: ['customMetadata']` e a paginação é por token de
 * CONTINUAÇÃO (a última chave da página), não por offset. Um cursor por offset
 * mudaria de valor quando a varredura apaga objetos, e o teste mediria um
 * artefato do double em vez do comportamento real.
 */

import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_CLEANUP_MAX_PAGES,
  ATTACHMENT_KEY_PREFIX,
  createR2AttachmentStorage,
  getAttachmentStorage,
  type AttachmentStorage,
  type R2BucketLike,
} from "../../src/attachments/storage.js";
import { cleanupExpiredAttachments } from "../../src/attachments/ingest.js";
import { pngBytes } from "./fixtures.js";
import { bytesOf, createAttachmentTestAgent, uploadRequest } from "./helpers.js";

const KIND_HEADER = "x-ted-attachment-kind";

/** Mirrors the production key; GREEN imports the constant instead. */
const CURSOR_KEY = "ted.attachments.cleanup.cursor";

/** R2's real page size is 1000; 2 here so pagination is genuinely exercised. */
const PAGE_SIZE = 2;

const NOW = 1_700_000_000_000;
/** Far future: a LIVE object must never be a sweep candidate. */
const LIVE_EXPIRY = 9_999_999_999_999;
/** Long past: an EXPIRED object. */
const PAST_EXPIRY = 1_000;

type Stored = { body: ArrayBuffer; customMetadata?: Record<string, string> };
type ListCall = { prefix?: string; cursor?: string; include?: readonly string[] };

const record = (ref: string, expiresAt: number) => ({
  ref,
  workspaceId: "ws-1",
  actorId: "actor-1",
  kind: "image" as const,
  name: `${ref}.png`,
  size: 33,
  sha256: "b".repeat(64),
  createdAt: NOW - 10_000,
  expiresAt,
  mime: "image/png",
});

/**
 * R2 double: metadata only with `include`, pagination by CONTINUATION token
 * (the last key of the page). `throwOnFirstCursor` emulates a stale token being
 * rejected by the real API.
 */
const createR2LikeBucket = (options: { throwOnFirstCursor?: boolean } = {}): {
  bucket: R2BucketLike;
  objects: Map<string, Stored>;
  listCalls: ListCall[];
} => {
  const objects = new Map<string, Stored>();
  const listCalls: ListCall[] = [];
  let rejected = false;
  const bucket: R2BucketLike = {
    async put(key, value, putOptions) {
      objects.set(key, { body: value, customMetadata: putOptions?.customMetadata });
    },
    async get(key) {
      const found = objects.get(key);
      if (!found) return null;
      return { arrayBuffer: async () => found.body, customMetadata: found.customMetadata };
    },
    async delete(key) {
      objects.delete(key);
    },
    async list(listOptions) {
      listCalls.push({
        ...(listOptions?.prefix !== undefined ? { prefix: listOptions.prefix } : {}),
        ...(listOptions?.cursor !== undefined ? { cursor: listOptions.cursor } : {}),
        ...(listOptions?.include !== undefined ? { include: listOptions.include } : {}),
      });
      const cursor = listOptions?.cursor;
      if (options.throwOnFirstCursor === true && cursor !== undefined && !rejected) {
        rejected = true;
        throw new Error("invalid continuation token");
      }
      const prefix = listOptions?.prefix ?? "";
      const withMetadata = listOptions?.include?.includes("customMetadata") === true;
      const keys = [...objects.keys()].filter((key) => key.startsWith(prefix)).sort();
      const after = cursor === undefined ? 0 : keys.findIndex((key) => key > cursor);
      const start = after === -1 ? keys.length : after;
      const page = keys.slice(start, start + PAGE_SIZE);
      const end = start + page.length;
      const truncated = end < keys.length;
      return {
        objects: page.map((key) => {
          const stored = objects.get(key)!;
          return withMetadata ? { key, customMetadata: stored.customMetadata } : { key };
        }),
        truncated,
        // R2 returns the continuation token for the page it just served.
        ...(truncated ? { cursor: page[page.length - 1]! } : {}),
      };
    },
  };
  return { bucket, objects, listCalls };
};

/**
 * Seeds `live` LIVE objects followed by `expired` EXPIRED ones in KEY ORDER.
 * The `0live`/`1expi` naming is load-bearing: sorted lexicographically the live
 * keys come FIRST, so the expired ones sit behind exactly the page ceiling.
 */
const seed = async (
  storage: AttachmentStorage,
  counts: { live: number; expired: number },
): Promise<{ live: string[]; expired: string[] }> => {
  const live: string[] = [];
  const expired: string[] = [];
  for (let i = 0; i < counts.live; i += 1) {
    const ref = `att_0live${String(i).padStart(6, "0")}`;
    live.push(ref);
    await storage.put(record(ref, LIVE_EXPIRY), bytesOf(pngBytes(2, 2)));
  }
  for (let i = 0; i < counts.expired; i += 1) {
    const ref = `att_1expi${String(i).padStart(6, "0")}`;
    expired.push(ref);
    await storage.put(record(ref, PAST_EXPIRY), bytesOf(pngBytes(2, 2)));
  }
  return { live, expired };
};

/** The starvation shape: live pages fill the ceiling, expired live behind them. */
const starvationCounts = { live: PAGE_SIZE * ATTACHMENT_CLEANUP_MAX_PAGES, expired: 4 };

/** In-memory checkpoint double: the three methods the sweep may call. */
const createCheckpoint = (initial?: string) => {
  let cursor: string | undefined = initial;
  return {
    checkpoint: {
      get: async () => cursor,
      put: async (next: string) => {
        cursor = next;
      },
      clear: async () => {
        cursor = undefined;
      },
    },
    read: () => cursor,
  };
};

const remaining = (objects: Map<string, Stored>, refs: string[]): string[] =>
  refs.filter((ref) => objects.has(`${ATTACHMENT_KEY_PREFIX}${ref}`));

describe("A19 — cursor de varredura: a inanição determinística dos expirados", () => {
  it("(1) SEM checkpoint a varredura recomeça no prefixo e NUNCA alcança os expirados (o defeito)", async () => {
    const { bucket, objects, listCalls } = createR2LikeBucket();
    const storage = createR2AttachmentStorage(bucket);
    const { expired } = await seed(storage, starvationCounts);

    // Documenta o comportamento legado: duas varreduras, zero expostos, porque
    // as 10 primeiras páginas são todas vivas e o cursor morre na chamada.
    const first = await cleanupExpiredAttachments(storage, NOW);
    const second = await cleanupExpiredAttachments(storage, NOW);
    expect(first).toEqual({ scanned: 0, deleted: 0, failed: false });
    expect(second).toEqual({ scanned: 0, deleted: 0, failed: false });
    expect(remaining(objects, expired)).toHaveLength(expired.length);
    // Toda chamada volta ao prefixo: nenhum cursor atravessa a chamada.
    expect(listCalls[0]?.cursor).toBeUndefined();
    expect(listCalls[ATTACHMENT_CLEANUP_MAX_PAGES]?.cursor).toBeUndefined();
  });

  it("(2) COM checkpoint: sweep 1 persiste o cursor e sweep 2 ALCANÇA os expirados", async () => {
    const { bucket, objects, listCalls } = createR2LikeBucket();
    const storage = createR2AttachmentStorage(bucket);
    const { expired } = await seed(storage, starvationCounts);
    const { checkpoint, read } = createCheckpoint();

    // Sweep 1: o teto de páginas corta ANTES da página 11 — nada é apagado, mas
    // a posição é preservada.
    const first = await cleanupExpiredAttachments(storage, NOW, { checkpoint });
    expect(first).toEqual({ scanned: 0, deleted: 0, failed: false });
    expect(typeof read()).toBe("string");
    // As 10 páginas do teto foram consumidas e o próximo sweep começa depois.
    expect(listCalls).toHaveLength(ATTACHMENT_CLEANUP_MAX_PAGES);
    expect(listCalls[0]?.cursor).toBeUndefined();

    // Sweep 2: retoma de onde parou e varre o resto da listagem.
    const second = await cleanupExpiredAttachments(storage, NOW, { checkpoint });
    expect(second.deleted).toBe(expired.length);
    expect(second.failed).toBe(false);
    expect(remaining(objects, expired)).toEqual([]);
  });

  it("(3) wrap-around: ao alcançar o FIM da listagem o checkpoint é LIMPO e a próxima recomeça no prefixo", async () => {
    const { bucket, objects, listCalls } = createR2LikeBucket();
    const storage = createR2AttachmentStorage(bucket);
    await seed(storage, starvationCounts);
    const { checkpoint, read } = createCheckpoint();

    await cleanupExpiredAttachments(storage, NOW, { checkpoint });
    expect(typeof read()).toBe("string");
    // O sweep que fecha a listagem limpa o checkpoint (nada pendente).
    await cleanupExpiredAttachments(storage, NOW, { checkpoint });
    expect(read()).toBeUndefined();

    listCalls.length = 0;
    await cleanupExpiredAttachments(storage, NOW, { checkpoint });
    expect(listCalls[0]?.cursor).toBeUndefined();
  });

  it("(4) crash safety: um delete que falha no meio não esconde os outros e não perde o cursor", async () => {
    const { bucket, objects } = createR2LikeBucket();
    const storage = createR2AttachmentStorage(bucket);
    const { expired } = await seed(storage, starvationCounts);
    const straggler = expired[0]!;
    let failedOnce = false;
    const flaky: AttachmentStorage = {
      ...storage,
      delete: async (ref) => {
        if (ref === straggler && !failedOnce) {
          failedOnce = true;
          throw new Error("r2 delete down");
        }
        await storage.delete(ref);
      },
    };
    const { checkpoint, read } = createCheckpoint();

    // Sweep 1: trunca no teto e persiste o cursor.
    const first = await cleanupExpiredAttachments(flaky, NOW, { checkpoint });
    expect(first).toEqual({ scanned: 0, deleted: 0, failed: false });
    expect(typeof read()).toBe("string");

    // Sweep 2: acha todos, mas um delete falha — os outros são apagados e o
    // sweep resolve mesmo assim (nunca lança).
    const second = await cleanupExpiredAttachments(flaky, NOW, { checkpoint });
    expect(second.scanned).toBe(expired.length);
    expect(second.deleted).toBe(expired.length - 1);
    expect(second.failed).toBe(false);
    expect(remaining(objects, expired)).toEqual([straggler]);

    // Sweep 3: o que sobrou NÃO foi perdido — é reencontrado e apagado.
    const third = await cleanupExpiredAttachments(flaky, NOW, { checkpoint });
    expect(third.deleted).toBe(1);
    expect(remaining(objects, expired)).toEqual([]);
  });

  it("(5) cursor INVÁLIDO: o sweep recomeça no prefixo, não quebra e não quebra o upload", async () => {
    const { bucket, objects, listCalls } = createR2LikeBucket({ throwOnFirstCursor: true });
    const storage = createR2AttachmentStorage(bucket);
    const { expired } = await seed(storage, { live: 2, expired: 4 });
    // Checkpoint velho (o R2 pode rejeitar um token antigo).
    const { checkpoint, read } = createCheckpoint("ted/attachments/v1/stale-token");

    const report = await cleanupExpiredAttachments(storage, NOW, { checkpoint });

    expect(report.failed).toBe(false);
    expect(report.deleted).toBe(expired.length);
    expect(remaining(objects, expired)).toEqual([]);
    // 1 chamada lançada (token velho rejeitado) + 3 páginas de paginação a
    // partir do prefixo (6 objetos / PAGE_SIZE 2), e o wrap limpou o
    // checkpoint velho.
    expect(listCalls).toHaveLength(4);
    expect(listCalls[0]?.cursor).toBe("ted/attachments/v1/stale-token");
    expect(listCalls[1]?.cursor).toBeUndefined();
    expect(read()).toBeUndefined();
  });

  it("(6) checkpoint indisponível (sem KV no DO) mantém o comportamento legado intacto", async () => {
    const { bucket, objects } = createR2LikeBucket();
    const storage = createR2AttachmentStorage(bucket);
    const { expired } = await seed(storage, { live: 2, expired: 4 });
    // Sem `options`: exatamente a chamada de antes, mesmo resultado de antes.
    const report = await cleanupExpiredAttachments(storage, NOW);
    expect(report).toEqual({ scanned: expired.length, deleted: expired.length, failed: false });
    expect(remaining(objects, expired)).toEqual([]);
  });
});

describe("A19 — o DO persiste o cursor do sweep e o apaga no wrap", () => {
  it("(7) upload persiste o cursor truncado; o upload seguinte conclui e limpa", async () => {
    const { agent, bucket, kv } = createAttachmentTestAgent({ withKvStorage: true });
    if (!kv) throw new Error("withKvStorage: true must return the kv map");
    const objects = bucket.objects;
    const storage = getAttachmentStorage((agent as unknown as { env: unknown }).env)!;
    const { expired } = await seed(storage, starvationCounts);

    // Upload 1: dispara o sweep piggyback; o teto corta antes dos expirados,
    // então o DO tem de guardar ONDE parou.
    const first = await agent.fetch(
      uploadRequest(bytesOf(pngBytes(4, 4)), { [KIND_HEADER]: "image", "x-ted-attachment-name": "a.png" }),
    );
    expect(first.status).toBe(200);
    expect(typeof kv.get(CURSOR_KEY)).toBe("string");
    expect(remaining(objects, expired)).toHaveLength(expired.length);

    // Upload 2 (bytes distintos — sha256 diferente, senão o ingest curto-
    // circuita no hit idempotente e nem varre): retoma o cursor, apaga os
    // expirados e limpa o checkpoint ao fechar a listagem.
    const second = await agent.fetch(
      uploadRequest(bytesOf(pngBytes(8, 8)), { [KIND_HEADER]: "image", "x-ted-attachment-name": "b.png" }),
    );
    expect(second.status).toBe(200);
    expect(remaining(objects, expired)).toEqual([]);
    expect(kv.has(CURSOR_KEY)).toBe(false);
  });
});