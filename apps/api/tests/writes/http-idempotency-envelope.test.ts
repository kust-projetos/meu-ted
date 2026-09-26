/**
 * HTTP idempotency envelope (v3) — RED phase.
 *
 * `httpIdempotencyPayload` wraps an HTTP callsite payload with a versioned
 * canonical route/method/resource/origin identity so the existing
 * `lookupOrRecord` hash covers the operation, while the raw Idempotency-Key
 * keeps its workspace uniqueness.
 */
import { describe, expect, it } from 'vitest';
import {
  createInMemoryIdempotencyStore,
  hashIdempotencyPayload,
  hashPayloadV2,
  httpIdempotencyPayload,
  legacyHashPayload,
  matchesPayloadHash,
} from '../../src/writes/idempotency.js';

describe('httpIdempotencyPayload envelope', () => {
  it('returns a JSON-safe envelope with version=3, route identity and payload', () => {
    const envelope = httpIdempotencyPayload(
      { route: 'POST /cards/purchases' },
      { amountCents: 1500 },
    );
    expect(envelope).toEqual({
      version: 3,
      route: 'POST /cards/purchases',
      payload: { amountCents: 1500 },
    });
    expect(JSON.parse(JSON.stringify(envelope))).toEqual(envelope);
  });

  it('is stable across reordered object keys (envelope + inner payload)', () => {
    const a = httpIdempotencyPayload(
      { route: 'POST /cards/purchases', origin: 'pwa' },
      { b: 2, a: { y: 1, x: 0 } },
    );
    const b = httpIdempotencyPayload(
      { origin: 'pwa', route: 'POST /cards/purchases' },
      { a: { x: 0, y: 1 }, b: 2 },
    );
    expect(hashPayloadV2(a)).toBe(hashPayloadV2(b));
  });

  it('distinct route produces a different hash', () => {
    const a = httpIdempotencyPayload({ route: 'POST /cards/purchases' }, { amountCents: 100 });
    const b = httpIdempotencyPayload({ route: 'POST /payables' }, { amountCents: 100 });
    expect(hashPayloadV2(a)).not.toBe(hashPayloadV2(b));
    expect(matchesPayloadHash(hashPayloadV2(a), b)).toBe(false);
  });

  it('distinct origin produces a different hash', () => {
    const a = httpIdempotencyPayload(
      { route: 'POST /cards/purchases', origin: 'pwa' },
      { amountCents: 100 },
    );
    const b = httpIdempotencyPayload(
      { route: 'POST /cards/purchases', origin: 'agent' },
      { amountCents: 100 },
    );
    expect(hashPayloadV2(a)).not.toBe(hashPayloadV2(b));
    expect(matchesPayloadHash(hashPayloadV2(a), b)).toBe(false);
  });

  it('legacy claims hashed over the raw payload never replay as envelope', () => {
    const raw = { amountCents: 100 };
    const envelope = httpIdempotencyPayload({ route: 'POST /cards/purchases' }, raw);
    expect(matchesPayloadHash(hashPayloadV2(raw), envelope)).toBe(false);
    expect(matchesPayloadHash(hashIdempotencyPayload(raw), envelope)).toBe(false);
    expect(matchesPayloadHash(legacyHashPayload(raw), envelope)).toBe(false);
  });

  it('v3 replay: same envelope replays through the existing store', async () => {
    const store = createInMemoryIdempotencyStore();
    const identity = { route: 'POST /cards/purchases', origin: 'pwa' };
    const first = await store.lookupOrRecord(
      'household-1',
      'key-1',
      httpIdempotencyPayload(identity, { amountCents: 100 }),
      async () => ({ ok: true as const }),
    );
    expect(first.replayed).toBe(false);
    const second = await store.lookupOrRecord(
      'household-1',
      'key-1',
      httpIdempotencyPayload(identity, { amountCents: 100 }),
      async () => ({ ok: false as const }),
    );
    expect(second.replayed).toBe(true);
    expect(second.response).toEqual({ ok: true });
  });

  it('cross-route conflict: same key + same body on a different route conflicts', async () => {
    const store = createInMemoryIdempotencyStore();
    await store.lookupOrRecord(
      'household-1',
      'key-2',
      httpIdempotencyPayload({ route: 'POST /cards/purchases' }, { amountCents: 100 }),
      async () => ({ ok: true as const }),
    );
    await expect(
      store.lookupOrRecord(
        'household-1',
        'key-2',
        httpIdempotencyPayload({ route: 'POST /payables' }, { amountCents: 100 }),
        async () => ({ ok: true as const }),
      ),
    ).rejects.toMatchObject({ code: 'idempotency.conflict' });
  });
});
