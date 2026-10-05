/**
 * A17 — Memory with provenance (R16), gate G06 resolved.
 *
 * RED tests: repeated correction must not duplicate on redelivery (AC26a),
 * a persisted correction is never an auto-promoted durable rule (G06.1),
 * forgetting cascades and the learning job never resurrects (AC26b), account
 * and category references are always marked as requiring revalidation
 * (AC26c), and the read/write contract carries an explicit scope including
 * the shared workspace layer (G06.4).
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
  forgetMemory,
  initializeMemorySchema,
  isFingerprintTombstoned,
  MEMORY_SIMILARITY_THRESHOLD,
  memoryFingerprint,
  normalizeMemoryScope,
  recallMemories,
  rememberCorrection,
  renderMemoryBlock,
  textSimilarity,
  type MemoryScope,
} from '../src/agent-config/memory/store.js';
import { createMemorySql, type MemorySqlMock } from './helpers/memory-sql.js';

const WS = 'ws-1';
const ACTOR = 'u-1';

const scope = (actor: string, shared: boolean): MemoryScope =>
  normalizeMemoryScope({ workspaceId: WS, actor, shared });

const correction = (overrides: Partial<Parameters<typeof rememberCorrection>[1]> = {}) => ({
  workspaceId: WS,
  actor: ACTOR,
  turnFingerprint: 'turn-abc',
  target: 'merchant:padaria-sao-jose',
  field: 'category',
  content: 'Padaria São José foi corrigida para a categoria Padarias',
  ...overrides,
});

describe('A17 memory provenance (AC26)', () => {
  let sql: MemorySqlMock;

  beforeEach(() => {
    sql = createMemorySql();
    initializeMemorySchema(sql);
  });

  it('builds a stable fingerprint from scope+target+field, insensitive to raw wording', () => {
    const first = memoryFingerprint({
      scope: scope(ACTOR, false),
      target: 'merchant:padaria-sao-jose',
      field: 'category',
    });
    const second = memoryFingerprint({
      scope: scope(ACTOR, false),
      // Punctuation/casing noise in the target must not fork the identity.
      target: 'Merchant:  Padaria São José',
      field: 'category',
    });
    expect(second).toBe(first);
    // A different field is a different correction.
    expect(
      memoryFingerprint({ scope: scope(ACTOR, false), target: 'merchant:padaria-sao-jose', field: 'account' }),
    ).not.toBe(first);
    // A different scope is a different correction.
    expect(
      memoryFingerprint({ scope: scope('u-2', false), target: 'merchant:padaria-sao-jose', field: 'category' }),
    ).not.toBe(first);
  });

  it('AC26a: redelivery with trivial variation collapses to one effective memory', () => {
    const first = rememberCorrection(sql, correction());
    expect(first.stored).toBe(true);
    // Redelivery: same scope+target+field+turn, reworded content whose text
    // similarity is BELOW the 0.55 content-dedup threshold — only the
    // deterministic fingerprint can collapse this into one effective memory.
    const reworded = 'Merchant corrigido: padaria -> Padarias';
    expect(textSimilarity(reworded, correction().content)).toBeLessThan(MEMORY_SIMILARITY_THRESHOLD);
    const second = rememberCorrection(sql, correction({ content: reworded }));
    expect(second.stored).toBe(true);
    if (second.stored) expect(second.deduped).toBe(true);
    expect(sql.rows('agent_memory')).toHaveLength(1);
    const recalled = recallMemories(sql, { workspaceId: WS, actor: ACTOR, scope: scope(ACTOR, false) });
    expect(recalled).toHaveLength(1);
  });

  it('AC26a: redelivery without a fingerprint is still a single effective event', () => {
    const first = rememberCorrection(sql, { ...correction(), turnFingerprint: undefined });
    const second = rememberCorrection(sql, { ...correction(), turnFingerprint: undefined });
    expect(first.stored && first.deduped).toBe(false);
    expect(second.stored).toBe(true);
    expect(sql.rows('agent_memory')).toHaveLength(1);
  });

  it('G06: a persisted correction is a `learning` with provenance, never a fact/preference', () => {
    const result = rememberCorrection(sql, correction());
    expect(result.stored).toBe(true);
    if (!result.stored) return;
    expect(result.item.kind).toBe('learning');
    expect(result.item.provenance?.derivedFrom).toEqual({
      sourceId: 'correction',
      turnFingerprint: 'turn-abc',
    });
    // Auto-promotion is refused: the write path cannot produce a durable rule.
    expect(result.item.kind).not.toBe('fact');
    expect(result.item.kind).not.toBe('preference');
    expect(result.item.promotable).toBe(false);
  });

  it('AC26b: forgetting the source invalidates derived memories (cascade)', () => {
    const origin = rememberCorrection(sql, correction());
    expect(origin.stored).toBe(true);
    if (!origin.stored) return;
    const derived = rememberCorrection(
      sql,
      correction({
        turnFingerprint: 'turn-def',
        field: 'account',
        content: 'Derived: Padaria São José passa a usar a conta Grocery',
        derivedFrom: { sourceId: origin.item.id, turnFingerprint: 'turn-abc' },
      }),
    );
    expect(derived.stored).toBe(true);
    if (!derived.stored) return;
    expect(sql.rows('agent_memory')).toHaveLength(2);

    const forgotten = forgetMemory(sql, { workspaceId: WS, id: origin.item.id });
    expect(forgotten).toEqual({ invalidated: [origin.item.id], cascaded: [derived.item.id] });
  });

  it('AC26b: an invalidated derived memory is never recalled again', () => {
    const origin = rememberCorrection(sql, correction());
    if (!origin.stored) throw new Error('origin not stored');
    const derived = rememberCorrection(
      sql,
      correction({
        turnFingerprint: 'turn-def',
        field: 'account',
        content: 'Derived: Padaria São José passa a usar a conta Grocery',
        derivedFrom: { sourceId: origin.item.id, turnFingerprint: 'turn-abc' },
      }),
    );
    if (!derived.stored) throw new Error('derived not stored');

    forgetMemory(sql, { workspaceId: WS, id: origin.item.id });

    const recalled = recallMemories(sql, { workspaceId: WS, actor: ACTOR, scope: scope(ACTOR, false) });
    expect(recalled.map((item) => item.content)).toEqual([]);
  });

  it('AC26b: the forgotten fingerprint stays a tombstone the learning job can consult', () => {
    const fingerprint = memoryFingerprint({
      scope: scope(ACTOR, false),
      target: 'merchant:padaria-sao-jose',
      field: 'category',
    });
    const stored = rememberCorrection(sql, correction());
    if (!stored.stored) throw new Error('not stored');
    expect(isFingerprintTombstoned(sql, { workspaceId: WS, actor: ACTOR, fingerprint })).toBe(false);

    forgetMemory(sql, { workspaceId: WS, id: stored.item.id });
    // After forgetting, the fingerprint is a tombstone: the learning job
    // cannot resurrect the source under the same identity.
    expect(isFingerprintTombstoned(sql, { workspaceId: WS, actor: ACTOR, fingerprint })).toBe(true);
  });

  it('AC26b: a tombstoned correction is refused on redelivery (no resurrection)', () => {
    const stored = rememberCorrection(sql, correction());
    if (!stored.stored) throw new Error('not stored');
    forgetMemory(sql, { workspaceId: WS, id: stored.item.id });

    const resurrected = rememberCorrection(sql, correction());
    expect(resurrected).toMatchObject({ stored: false, reason: 'tombstoned' });
    expect(sql.rows('agent_memory').filter((row) => row['invalidated_at'] == null)).toHaveLength(0);
  });

  it('AC26c: a memory citing account_id/category_id requires revalidation', () => {
    const result = rememberCorrection(
      sql,
      correction({
        content: 'Padaria São José usa a categoria category_id=cat_padarias e a conta account_id=acc_grocery',
      }),
    );
    expect(result.stored).toBe(true);
    if (!result.stored) return;
    expect(result.item.requiresRevalidation).toBe(true);
    expect(result.item.references).toEqual([
      { kind: 'category', id: 'cat_padarias' },
      { kind: 'account', id: 'acc_grocery' },
    ]);
  });

  it('AC26c: recalled references are never presented as currently valid', () => {
    const result = rememberCorrection(
      sql,
      correction({ content: 'Padaria São José usa a categoria category_id=cat_padarias' }),
    );
    if (!result.stored) throw new Error('not stored');
    const recalled = recallMemories(sql, { workspaceId: WS, actor: ACTOR, scope: scope(ACTOR, false) });
    expect(recalled).toHaveLength(1);
    // The item carries the reference as history, flagged for revalidation.
    expect(recalled[0]!.requiresRevalidation).toBe(true);
    expect(recalled[0]!.references).toEqual([{ kind: 'category', id: 'cat_padarias' }]);
    // The injected block marks it as needing revalidation instead of asserting validity.
    const block = renderMemoryBlock(recalled)!;
    expect(block).toContain('revalidar');
    expect(block.toLowerCase()).not.toMatch(/categoria atual|conta atual|still valid|valid now/);
  });

  it('AC26c: a memory with no account/category reference needs no revalidation', () => {
    const result = rememberCorrection(sql, correction());
    if (!result.stored) throw new Error('not stored');
    expect(result.item.requiresRevalidation).toBe(false);
    expect(result.item.references).toEqual([]);
  });

  it('G06.4: the scope carries the shared workspace layer explicitly', () => {
    const normalized = normalizeMemoryScope({ workspaceId: WS, actor: ACTOR, shared: true });
    expect(normalized).toEqual({ workspaceId: WS, actor: ACTOR, layer: 'shared', includeShared: true });
    expect(normalizeMemoryScope({ workspaceId: WS, actor: ACTOR, shared: false })).toEqual({
      workspaceId: WS,
      actor: ACTOR,
      layer: 'actor',
      includeShared: false,
    });
  });

  it('G06.4: the recall default is unchanged (shared entries still included)', () => {
    rememberCorrection(sql, { ...correction(), actor: '', content: 'Shared: prefere resumos curtos' });
    const recalled = recallMemories(sql, { workspaceId: WS, actor: ACTOR });
    expect(recalled).toHaveLength(1);
    // An explicit opt-out narrows to the actor layer only.
    const narrowed = recallMemories(sql, { workspaceId: WS, actor: ACTOR, scope: scope(ACTOR, false) });
    expect(narrowed).toHaveLength(0);
  });

  it('G06.4: an actor does not see a revoked shared memory, and revocation drops shared derived', () => {
    const shared = rememberCorrection(
      sql,
      correction({ actor: '', content: 'Shared: Padaria São José é Padarias', turnFingerprint: 'turn-shared' }),
    );
    if (!shared.stored) throw new Error('shared not stored');
    const derived = rememberCorrection(
      sql,
      correction({
        actor: '',
        turnFingerprint: 'turn-shared-derived',
        field: 'account',
        // Distinct enough that the pre-existing content-similarity dedup does
        // not merge the two rows: this test is about scope + revocation.
        content: 'Fechamento do cartão sempre no dia 20 do mês',
        derivedFrom: { sourceId: shared.item.id, turnFingerprint: 'turn-shared' },
      }),
    );
    if (!derived.stored) throw new Error('shared derived not stored');

    expect(
      recallMemories(sql, { workspaceId: WS, actor: ACTOR }).map((item) => item.content),
    ).toHaveLength(2);

    forgetMemory(sql, { workspaceId: WS, id: shared.item.id });

    // Revocation of the shared source also drops its shared derived memory.
    expect(recallMemories(sql, { workspaceId: WS, actor: ACTOR })).toHaveLength(0);
  });

  it('G06.6: forbidden content never leaks through the correction path', () => {
    const card = rememberCorrection(sql, correction({ content: 'meu cartão é 5500 0000 0000 0004' }));
    expect(card).toMatchObject({ stored: false, reason: 'card_number' });
    const financial = rememberCorrection(sql, correction({ content: 'o saldo atual da conta é R$ 100' }));
    expect(financial).toMatchObject({ stored: false, reason: 'financial_state' });
    const secret = rememberCorrection(sql, correction({ content: 'a senha é password: hunter2' }));
    if (!secret.stored) throw new Error('expected scrubbed store');
    expect(secret.item.content).not.toContain('hunter2');
    expect(sql.rows('agent_memory')).toHaveLength(1);
  });
});