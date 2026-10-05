/**
 * A17 — memory provenance, learning-job side (AC26 + G06).
 *
 * These RED cases close the gap between the store contract
 * (`tests/memory-provenance.test.ts`) and the post-turn learning job: the job
 * must not promote a correction to a durable rule, must not resurrect a
 * forgotten correction, and must persist with an explicit scope.
 */
import { describe, expect, it } from 'vitest';
import { learnFromTurn } from '../../src/agent-config/memory/learn.js';
import {
  forgetMemory,
  initializeMemorySchema,
  memoryFingerprint,
  normalizeMemoryScope,
  recallMemories,
  rememberCorrection,
} from '../../src/agent-config/memory/store.js';
import { createMemorySql } from '../helpers/memory-sql.js';

const WS = 'ws-1';
const ACTOR = 'u-1';
const actorScope = () => normalizeMemoryScope({ workspaceId: WS, actor: ACTOR, shared: false });

describe('A17 provenance — learning job (AC26/G06)', () => {
  it('never promotes a repeated correction into a durable fact or preference', async () => {
    const sql = createMemorySql();
    initializeMemorySchema(sql);

    const learned = await learnFromTurn(sql, {
      workspaceId: WS,
      actorId: ACTOR,
      userText: 'Na verdade, Padaria São José é da categoria Padarias',
      assistantText: 'Corrigido, obrigado.',
      turnCount: 1,
      correction: {
        target: 'merchant:padaria-sao-jose',
        field: 'category',
        turnFingerprint: 'turn-1',
      },
      scope: actorScope(),
    });

    expect(learned).toHaveLength(1);
    expect(learned[0]!.kind).toBe('learning');
    expect(learned[0]!.promotable).toBe(false);
    // No durable rule row was created by inference alone.
    expect(
      sql.rows('agent_memory').filter((row) => row['kind'] === 'fact' || row['kind'] === 'preference'),
    ).toHaveLength(0);
  });

  it('redelivery of the same correction turn does not duplicate the learned memory', async () => {
    const sql = createMemorySql();
    initializeMemorySchema(sql);
    const turn = {
      workspaceId: WS,
      actorId: ACTOR,
      assistantText: 'Corrigido.',
      turnCount: 1,
      correction: { target: 'merchant:padaria-sao-jose', field: 'category', turnFingerprint: 'turn-1' },
      scope: actorScope(),
    };
    const first = await learnFromTurn(sql, {
      ...turn,
      userText: 'Na verdade, Padaria São José é da categoria Padarias',
    });
    const redelivered = await learnFromTurn(sql, {
      ...turn,
      userText: 'Na verdade, Padaria São José é da categoria Padarias.',
    });
    expect(first).toHaveLength(1);
    expect(redelivered).toHaveLength(0);
    expect(sql.rows('agent_memory')).toHaveLength(1);
  });

  it('does not resurrect a forgotten correction on a later due turn', async () => {
    const sql = createMemorySql();
    initializeMemorySchema(sql);
    const turn = {
      workspaceId: WS,
      actorId: ACTOR,
      assistantText: 'Corrigido.',
      correction: { target: 'merchant:padaria-sao-jose', field: 'category', turnFingerprint: 'turn-1' },
      scope: actorScope(),
    };
    const learned = await learnFromTurn(sql, {
      ...turn,
      userText: 'Na verdade, Padaria São José é da categoria Padarias',
      turnCount: 1,
    });
    expect(learned).toHaveLength(1);
    if (!learned[0]) throw new Error('expected a learned correction');

    forgetMemory(sql, { workspaceId: WS, id: learned[0].id });

    // A later due turn (the LLM extractor is due at turn 5) must not bring
    // the forgotten correction back.
    const later = await learnFromTurn(sql, {
      ...turn,
      userText: 'Na verdade, Padaria São José é da categoria Padarias',
      turnCount: 5,
      llmExtract: async () => ['Padaria São José é da categoria Padarias'],
    });
    expect(later).toHaveLength(0);
    expect(recallMemories(sql, { workspaceId: WS, actor: ACTOR, scope: actorScope() })).toHaveLength(0);
  });

  it('consults the tombstone of the forgotten fingerprint before persisting', async () => {
    const sql = createMemorySql();
    initializeMemorySchema(sql);
    const stored = rememberCorrection(sql, {
      workspaceId: WS,
      actor: ACTOR,
      turnFingerprint: 'turn-1',
      target: 'merchant:padaria-sao-jose',
      field: 'category',
      content: 'Padaria São José é da categoria Padarias',
    });
    if (!stored.stored) throw new Error('expected the correction to store');
    const fingerprint = memoryFingerprint({
      scope: actorScope(),
      target: 'merchant:padaria-sao-jose',
      field: 'category',
    });
    forgetMemory(sql, { workspaceId: WS, id: stored.item.id });

    const learned = await learnFromTurn(sql, {
      workspaceId: WS,
      actorId: ACTOR,
      userText: 'Padaria São José é da categoria Padarias',
      assistantText: 'ok',
      turnCount: 1,
      correction: { target: 'merchant:padaria-sao-jose', field: 'category', turnFingerprint: 'turn-1' },
      scope: actorScope(),
    });
    expect(learned).toHaveLength(0);
    expect(sql.rows('agent_memory').filter((row) => row['invalidated_at'] == null)).toHaveLength(0);
    // The fingerprint identity is still recorded as a tombstone.
    expect(sql.rows('agent_memory')[0]?.['fingerprint']).toBe(fingerprint);
  });
});