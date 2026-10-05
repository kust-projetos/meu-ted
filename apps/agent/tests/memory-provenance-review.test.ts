/**
 * A17 review fixes (F2/F3) — correction identity, dedup boundaries and the
 * `promotable` round trip.
 *
 * F2: the fingerprint is `scope|target|field` and carries NO turn/content, so a
 * second correction about the same target+field used to only bump salience and
 * keep the STALE text (a correction aging into a falsehood). The desired
 * semantics are:
 *   (a) same turn (or equivalent content) = idempotent no-op, still deduped
 *       (AC26a preserved);
 *   (b) a NEW turn about the same target+field REPLACES the effective memory:
 *       one row, still `learning`, with new content/provenance/timestamp.
 * The text-similarity dedup must not collapse a correction into a memory of a
 * different kind, must not match invalidated rows, and must record the link on
 * the surviving row when it does collapse.
 *
 * F3: `promotable` used to be read as "the provenance string is empty", while
 * the write path always persists `JSON.stringify({})` for an explicit memory —
 * so a fact written as promotable came back non-promotable. It is now derived
 * from the EFFECTIVE presence of `provenance.derivedFrom`.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
  forgetMemory,
  initializeMemorySchema,
  MEMORY_SIMILARITY_THRESHOLD,
  recallMemories,
  rememberCorrection,
  rememberFact,
  textSimilarity,
} from '../src/agent-config/memory/store.js';
import { createMemorySql, type MemorySqlMock } from './helpers/memory-sql.js';

const WS = 'ws-1';
const ACTOR = 'u-1';

const correction = (overrides: Partial<Parameters<typeof rememberCorrection>[1]> = {}) => ({
  workspaceId: WS,
  actor: ACTOR,
  target: 'merchant:padaria-sao-jose',
  field: 'category',
  turnFingerprint: 'turn-abc',
  content: 'Padaria São José foi corrigida para a categoria Padarias',
  ...overrides,
});

describe('A17/F2 a new correction about the same target replaces the effective memory', () => {
  let sql: MemorySqlMock;

  beforeEach(() => {
    sql = createMemorySql();
    initializeMemorySchema(sql);
  });

  it('(a) redelivery of the SAME turn stays an idempotent deduped no-op (AC26a)', () => {
    const first = rememberCorrection(sql, correction());
    expect(first.stored).toBe(true);

    const redelivered = rememberCorrection(
      sql,
      correction({ content: 'Corrigido: padaria -> Padarias (mesmo turno)' }),
    );
    expect(redelivered.stored).toBe(true);
    if (!redelivered.stored) throw new Error('expected storage');
    expect(redelivered.deduped).toBe(true);
    expect(sql.rows('agent_memory')).toHaveLength(1);
    // Same turn, so the effective content is untouched.
    const recalled = recallMemories(sql, { workspaceId: WS, actor: ACTOR });
    expect(recalled[0]!.content).toBe('Padaria São José foi corrigida para a categoria Padarias');
  });

  it('(b) a NEW turn with different content wins: same single row, fresh text', () => {
    const first = rememberCorrection(sql, correction());
    if (!first.stored) throw new Error('expected storage');

    const later = rememberCorrection(
      sql,
      correction({
        turnFingerprint: 'turn-xyz',
        content: 'Padaria São José agora é da categoria Cafés',
      }),
    );
    expect(later.stored).toBe(true);
    if (!later.stored) throw new Error('expected storage');
    // One effective row, and it is the NEW correction (not the stale text).
    expect(sql.rows('agent_memory')).toHaveLength(1);
    const recalled = recallMemories(sql, { workspaceId: WS, actor: ACTOR });
    expect(recalled).toHaveLength(1);
    expect(recalled[0]!.content).toBe('Padaria São José agora é da categoria Cafés');
    // Still a derived learning: a correction never becomes a durable rule.
    expect(recalled[0]!.kind).toBe('learning');
    expect(recalled[0]!.promotable).toBe(false);
    // Provenance/timestamp moved with the content.
    expect(recalled[0]!.provenance?.derivedFrom?.turnFingerprint).toBe('turn-xyz');
  });

  it('(b) a new turn with similar-but-different content also wins', () => {
    rememberCorrection(sql, correction());
    const later = rememberCorrection(
      sql,
      correction({
        turnFingerprint: 'turn-xyz',
        content: 'Padaria São José foi corrigida para a categoria Cafés e bolo',
      }),
    );
    if (!later.stored) throw new Error('expected storage');
    expect(sql.rows('agent_memory')).toHaveLength(1);
    const recalled = recallMemories(sql, { workspaceId: WS, actor: ACTOR });
    expect(textSimilarity(recalled[0]!.content, correction().content)).toBeGreaterThanOrEqual(
      MEMORY_SIMILARITY_THRESHOLD,
    );
    expect(recalled[0]!.content).toBe('Padaria São José foi corrigida para a categoria Cafés e bolo');
  });

  it('text dedup never collapses a correction into a memory of another kind', () => {
    // An old durable preference that talks about the same merchant.
    const preference = rememberFact(sql, {
      workspaceId: WS,
      actor: ACTOR,
      kind: 'preference',
      content: 'Padaria São José foi corrigida para a categoria Padarias',
      salience: 0.9,
    });
    if (!preference.stored) throw new Error('expected the preference to store');

    const correctionResult = rememberCorrection(sql, correction());
    if (!correctionResult.stored) throw new Error('expected the correction to store');
    // Both rows survive: a derived learning is not a durable preference.
    expect(sql.rows('agent_memory')).toHaveLength(2);
    expect(correctionResult.deduped).toBe(false);
    const kinds = recallMemories(sql, { workspaceId: WS, actor: ACTOR }).map((item) => item.kind);
    expect(kinds.sort()).toEqual(['learning', 'preference']);
  });

  it('text dedup never matches an invalidated (forgotten) row', () => {
    const first = rememberCorrection(sql, correction());
    if (!first.stored) throw new Error('expected storage');
    forgetMemory(sql, { workspaceId: WS, id: first.item.id });
    expect(recallMemories(sql, { workspaceId: WS, actor: ACTOR })).toHaveLength(0);

    // Same identity redelivery is refused (tombstone), not resurrected.
    expect(rememberCorrection(sql, correction())).toMatchObject({ stored: false, reason: 'tombstoned' });
  });

  it('when a correction genuinely collapses into a same-kind row, the link is recorded', () => {
    // A plain learning row with no fingerprint and no provenance, written by the
    // heuristic path: text-identical to the correction that follows.
    const prior = rememberFact(sql, {
      workspaceId: WS,
      actor: ACTOR,
      kind: 'learning',
      content: 'Padaria São José usa a categoria Padarias no lançamento',
      salience: 0.5,
    });
    if (!prior.stored) throw new Error('expected the prior learning to store');

    const collapsed = rememberCorrection(
      sql,
      correction({ content: 'Padaria São José usa a categoria Padarias no lançamento' }),
    );
    expect(collapsed.stored).toBe(true);
    if (!collapsed.stored) throw new Error('expected storage');
    expect(collapsed.deduped).toBe(true);
    expect(sql.rows('agent_memory')).toHaveLength(1);

    // The surviving row now carries the correction identity and provenance, so a
    // later forget/tombstone on that fingerprint reaches it.
    const recalled = recallMemories(sql, { workspaceId: WS, actor: ACTOR });
    expect(recalled).toHaveLength(1);
    expect(recalled[0]!.fingerprint).toBe(collapsed.item.fingerprint);
    expect(recalled[0]!.provenance?.derivedFrom?.sourceId).toBe('correction');
    expect(recalled[0]!.promotable).toBe(false);
  });
});

describe('A17/F3 promotable survives the write/read round trip', () => {
  let sql: MemorySqlMock;

  beforeEach(() => {
    sql = createMemorySql();
    initializeMemorySchema(sql);
  });

  it('an explicit memory is promotable before AND after the round trip', () => {
    const written = rememberFact(sql, {
      workspaceId: WS,
      actor: ACTOR,
      kind: 'fact',
      content: 'Conta principal é o Nubank',
    });
    if (!written.stored) throw new Error('expected storage');
    expect(written.item.promotable).toBe(true);
    const recalled = recallMemories(sql, { workspaceId: WS, actor: ACTOR });
    expect(recalled[0]!.promotable).toBe(true);
  });

  it('an explicitly DERIVED memory stays non-promotable after the round trip', () => {
    const written = rememberCorrection(sql, correction());
    if (!written.stored) throw new Error('expected storage');
    expect(written.item.promotable).toBe(false);
    const recalled = recallMemories(sql, { workspaceId: WS, actor: ACTOR });
    expect(recalled[0]!.promotable).toBe(false);
  });

  it('an unparseable provenance column is treated as NOT derived (fail-open to explicit)', () => {
    rememberFact(sql, { workspaceId: WS, actor: ACTOR, content: 'Prefere resumos curtos' });
    sql.rows('agent_memory')[0]!['provenance'] = '{not json';
    const recalled = recallMemories(sql, { workspaceId: WS, actor: ACTOR });
    expect(recalled).toHaveLength(1);
    expect(recalled[0]!.promotable).toBe(true);
  });
});