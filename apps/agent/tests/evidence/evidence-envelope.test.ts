import { describe, expect, it } from 'vitest';
import { collectEvidence, type EvidenceSource } from '../../src/evidence/evidence-collector.js';
import {
  createEvidenceEnvelope,
  ENTITY_RESOLUTION_OUTCOMES,
  isCurrentEvidence,
  READ_ABSENCE_REASONS,
  READ_FAILURE_REASONS,
  serializeEvidenceForPrompt,
  type EvidenceInput,
  type EvidenceItem,
} from '../../src/evidence/evidence-envelope.js';

const source: EvidenceSource = {
  ref: 'balance-current', source: 'api.balance', retrievedAt: '2026-09-13T12:00:00.000Z',
  data: { balanceCents: 12345, accountName: 'Conta principal', workspaceId: 'secret-ws' },
};

describe('T2.3 evidence envelope', () => {
  it('validates typed evidence, projects allowed fields and redacts technical identifiers', () => {
    const envelope = createEvidenceEnvelope([source], { allowedFields: ['balanceCents', 'accountName'] });
    expect(envelope.items[0]?.data).toEqual({ balanceCents: 12345, accountName: 'Conta principal' });
    expect(JSON.stringify(envelope)).not.toContain('secret-ws');
    expect(Object.isFrozen(envelope)).toBe(true);
  });

  it('represents empty results and required unavailable tools without inventing values', async () => {
    const empty = await collectEvidence({ required: false, fetch: async () => [] });
    expect(empty.items[0]?.status).toBe('empty');
    await expect(collectEvidence({ required: true, fetch: async () => { throw new Error('timeout'); } }))
      .rejects.toMatchObject({ code: 'evidence.unavailable' });
  });

  /**
   * Finding (A04/R04): an EXPLICIT status declared by the producer must survive
   * collection. Recomputing the status from `data` alone demotes a declared
   * failure to `empty` (or promotes it to usable `ok` evidence) —
   * reintroducing the absence/failure confound at the collector boundary.
   */
  describe('collectEvidence preserves an explicitly declared status', () => {
  const at = '2026-09-13T12:00:00.000Z';

  it('keeps a declared failure and its typed reason (never demoted to empty)', async () => {
    const envelope = await collectEvidence({
      required: false,
      fetch: async () => ({ ref: 'analytics', source: 'tool', retrievedAt: at, status: 'error', reason: 'forbidden', data: null }),
    });
    const item = envelope.items[0];
    expect(item?.status).toBe('error');
    expect(item?.reason).toBe('forbidden');
  });

  it('keeps a declared failure even when data is present (never promoted to ok)', async () => {
    const envelope = await collectEvidence({
      required: false,
      fetch: async () => ({ ref: 'partial', source: 'tool', retrievedAt: at, status: 'error', data: 'stale cached body' }),
    });
    const item = envelope.items[0];
    expect(item?.status).toBe('error');
    // A failed read carries no usable payload for grounding.
    expect(item?.data).toBeNull();
  });

  it('keeps a declared absence (never promoted to ok by a non-empty payload)', async () => {
    const envelope = await collectEvidence({
      required: false,
      fetch: async () => ({ ref: 'period', source: 'tool', retrievedAt: at, status: 'empty', reason: 'period_empty', data: [] }),
    });
    expect(envelope.items[0]?.status).toBe('empty');
    expect(envelope.items[0]?.reason).toBe('period_empty');
  });

  it('still infers the status from data when the producer declares none', async () => {
    const inferredEmpty = await collectEvidence({
      required: false,
      fetch: async () => ({ ref: 'e', source: 'tool', retrievedAt: at, data: null }),
    });
    expect(inferredEmpty.items[0]?.status).toBe('empty');

    const inferredOk = await collectEvidence({
      required: false,
      fetch: async () => ({ ref: 'o', source: 'tool', retrievedAt: at, data: { balanceCents: 100 } }),
    });
    expect(inferredOk.items[0]?.status).toBe('ok');
  });
});

  it('rejects oversized payloads instead of string truncating malformed JSON', () => {
    expect(() => createEvidenceEnvelope([{ ...source, data: { value: 'x'.repeat(10001) } }]))
      .toThrow('evidence.payload_too_large');
  });

  it('accepts explicitly dated snapshots as current evidence metadata', () => {
    const item: EvidenceItem = { ref: 'snapshot-1', source: 'api.balance', retrievedAt: '2026-09-13T12:00:00.000Z', status: 'ok', data: { balanceCents: 100 } };
    expect(createEvidenceEnvelope([item]).items[0]?.retrievedAt).toBe(item.retrievedAt);
    expect(isCurrentEvidence(item, Date.parse('2026-09-13T12:04:00Z'))).toBe(true);
    expect(isCurrentEvidence(item, Date.parse('2026-09-13T12:06:00Z'))).toBe(false);
    const prompt = serializeEvidenceForPrompt(createEvidenceEnvelope([item]));
    expect(prompt).not.toContain('snapshot-1');
    expect(prompt).not.toContain('api.balance');
  });
});

/**
 * A04(a) / R04 — typed SEPARATE axes on the existing envelope (never a single
 * enumeration): read absence, entity resolution and read failure each keep
 * their own vocabulary, and `reason` is sanitized by construction (closed
 * axis), so no raw exception/HTTP text can reach the prompt.
 */
describe('A04/R04 typed absence/failure axes', () => {
  const base = { ref: 'month-summary', source: 'api.month-summary', retrievedAt: '2026-09-13T12:00:00.000Z' };

  it('exposes the three axes as distinct, non-overlapping vocabularies', () => {
    expect(READ_ABSENCE_REASONS).toEqual([
      'workspace_empty', 'setup_incomplete', 'period_empty', 'category_empty', 'filter_empty', 'entity_not_found',
    ]);
    expect(READ_FAILURE_REASONS).toEqual(['retryable_error', 'permanent_error', 'forbidden', 'unavailable']);
    expect(ENTITY_RESOLUTION_OUTCOMES).toEqual(['found', 'ambiguous']);
    // A04(a): no single enumeration collapses the three axes into one enum.
    for (const outcome of ENTITY_RESOLUTION_OUTCOMES) {
      expect([...READ_ABSENCE_REASONS, ...READ_FAILURE_REASONS]).not.toContain(outcome);
    }
    expect(READ_ABSENCE_REASONS.some((reason) => (READ_FAILURE_REASONS as readonly string[]).includes(reason))).toBe(false);
  });

  it('carries a typed reason on empty and error items, and none on ok', () => {
    const envelope = createEvidenceEnvelope([
      { ...base, status: 'empty', reason: 'period_empty', data: [] },
      { ...base, ref: 'accounts', status: 'error', reason: 'forbidden', data: null },
      { ...base, ref: 'account:1', status: 'ok', data: { balanceCents: 1 } },
    ]);
    expect(envelope.items.map((item) => [item.status, 'reason' in item ? item.reason : undefined]))
      .toEqual([['empty', 'period_empty'], ['error', 'forbidden'], ['ok', undefined]]);
  });

  it('rejects a reason outside its axis so an error can never read as "nothing there"', () => {
    // Error carrying an ABSENCE reason is the "error becomes zero" failure (R04).
    // The cross-axis objects are now REJECTED BY THE TYPE (see the compile-time
    // test below), so the runtime guard is exercised through an explicit cast —
    // it stays the defense for untyped/JS callers and projected data.
    const asUntyped = (item: unknown): never => item as never;
    expect(() => createEvidenceEnvelope([asUntyped({ ...base, status: 'error', reason: 'period_empty', data: null })]))
      .toThrow('evidence.invalid');
    expect(() => createEvidenceEnvelope([asUntyped({ ...base, status: 'empty', reason: 'forbidden', data: [] })]))
      .toThrow('evidence.invalid');
    expect(() => createEvidenceEnvelope([asUntyped({ ...base, status: 'ok', reason: 'period_empty', data: [] })]))
      .toThrow('evidence.invalid');
  });

  /**
   * Finding 1 (A04/R04): the axis discrimination must hold on the PRODUCER
   * side too. `EvidenceInput` used to take an independent `status` plus a free
   * `reason`, so crossing the axes compiled without a cast and was caught only
   * at runtime. These `@ts-expect-error` markers FAIL the build if the crossing
   * ever compiles again (an unused directive is itself a tsc error).
   */
  it('type-checks: crossing the read axes on EvidenceInput does not compile', () => {
    const accept = (items: readonly EvidenceInput[]): void => { void items; };

    // Valid: each reason on its own axis, plus the inference variant.
    accept([{ ...base, status: 'error', reason: 'forbidden', data: null }]);
    accept([{ ...base, status: 'empty', reason: 'period_empty', data: [] }]);
    accept([{ ...base, status: 'ok', data: { balanceCents: 1 } }]);
    accept([{ ...base, data: { balanceCents: 1 } }]);

    // @ts-expect-error — a FAILURE item cannot carry an absence reason.
    accept([{ ...base, status: 'error', reason: 'period_empty', data: null }]);
    // @ts-expect-error — an ABSENCE item cannot carry a failure reason.
    accept([{ ...base, status: 'empty', reason: 'forbidden', data: [] }]);
    // @ts-expect-error — an `ok` item never carries a reason.
    accept([{ ...base, status: 'ok', reason: 'period_empty', data: [] }]);
    // @ts-expect-error — the inferred variant carries no reason.
    accept([{ ...base, reason: 'forbidden', data: null }]);
    // @ts-expect-error — `reason` outside the closed vocabulary.
    accept([{ ...base, status: 'error', reason: 'HTTP 403 Forbidden', data: null }]);

    expect(true).toBe(true);
  });

  it('sanitizes the reason: raw exception/HTTP text is rejected and never serialized', () => {
    const raw = 'HTTP 403 Forbidden: token sk-live-abc123 for workspace ws-1';
    expect(() => createEvidenceEnvelope([{ ...base, status: 'error', reason: raw, data: null } as never]))
      .toThrow('evidence.invalid');
    const envelope = createEvidenceEnvelope([{ ...base, status: 'error', reason: 'forbidden', data: null }]);
    for (const rendered of [JSON.stringify(envelope), serializeEvidenceForPrompt(envelope)]) {
      expect(rendered).not.toContain('sk-live-abc123');
      expect(rendered).not.toContain('ws-1');
    }
    expect(serializeEvidenceForPrompt(envelope)).toContain('forbidden');
  });

  it('states an explicit no-evidence state instead of an ambiguous empty list', () => {
    const envelope = createEvidenceEnvelope([
      { ...base, status: 'empty', reason: 'period_empty', data: [] },
      { ...base, ref: 'accounts', status: 'error', reason: 'forbidden', data: null },
    ]);
    const parsed = JSON.parse(serializeEvidenceForPrompt(envelope)) as {
      items: unknown[];
      noEvidence?: boolean;
      absences?: Array<{ status: string; reason?: string }>;
    };
    // `items: []` alone would let the model read a forbidden read as "no data".
    expect(parsed.items).toEqual([]);
    expect(parsed.noEvidence).toBe(true);
    expect(parsed.absences).toEqual([
      { status: 'empty', reason: 'period_empty' },
      { status: 'error', reason: 'forbidden' },
    ]);
  });

  it('omits noEvidence when usable evidence exists and keeps absences bounded/deduped', () => {
    const withData = createEvidenceEnvelope([
      { ...base, ref: 'account:1', status: 'ok', data: { balanceCents: 100 } },
      { ...base, ref: 'dup', status: 'empty', reason: 'period_empty', data: [] },
      { ...base, ref: 'dup-2', status: 'empty', reason: 'period_empty', data: [] },
    ]);
    const parsed = JSON.parse(serializeEvidenceForPrompt(withData)) as { noEvidence?: boolean; absences?: unknown[] };
    expect(parsed.noEvidence).toBeUndefined();
    expect(parsed.absences).toEqual([{ status: 'empty', reason: 'period_empty' }]);

    // Bounded payload: many distinct absences cannot grow the prompt unbounded.
    const many = READ_ABSENCE_REASONS.map((reason, index) => ({
      ...base, ref: `r-${index}`, status: 'empty' as const, reason, data: [],
    }));
    const serialized = serializeEvidenceForPrompt(createEvidenceEnvelope(many));
    expect(new TextEncoder().encode(serialized).byteLength).toBeLessThan(1_000);
    expect(JSON.parse(serialized).absences.length).toBeLessThanOrEqual(READ_ABSENCE_REASONS.length);
  });

  it('caps absences with priority for failures, so an error is never dropped (AC10)', () => {
    // 6 distinct absences arrive BEFORE the failure: a first-come cap would
    // spend all 4 slots on absences and silently drop `forbidden`, letting the
    // model read a forbidden read as "no data" — the exact AC10 regression the
    // explicit no-evidence state exists to prevent.
    const envelope = createEvidenceEnvelope([
      ...READ_ABSENCE_REASONS.map((reason, index) => ({ ...base, ref: `e-${index}`, status: 'empty' as const, reason, data: [] })),
      { ...base, ref: 'analytics', status: 'error', reason: 'forbidden', data: null },
    ]);
    const parsed = JSON.parse(serializeEvidenceForPrompt(envelope)) as {
      absences: Array<{ status: string; reason?: string }>;
    };
    // The failure survives the cap...
    expect(parsed.absences).toContainEqual({ status: 'error', reason: 'forbidden' });
    // ...and the cap still bounds the payload (an absence gives way instead).
    expect(parsed.absences.length).toBeLessThanOrEqual(READ_ABSENCE_REASONS.length + 1);
    expect(parsed.absences.length).toBe(4);
  });

  it('keeps the ok-item prompt representation unchanged for existing consumers', () => {
    const item: EvidenceItem = {
      ref: 'account:acc-1', source: 'api.accounts', retrievedAt: '2026-09-13T12:00:00.000Z',
      status: 'ok', data: { balanceCents: 100 },
    };
    expect(JSON.parse(serializeEvidenceForPrompt(createEvidenceEnvelope([item]))))
      .toEqual({ items: [{ retrievedAt: item.retrievedAt, data: { balanceCents: 100 } }] });
  });
});
