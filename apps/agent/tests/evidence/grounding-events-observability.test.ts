import { describe, expect, it, vi } from 'vitest';
import { createGroundedResponseWithRetry } from '../../src/responses/grounded-response.js';
import type { EvidenceEnvelope } from '../../src/evidence/evidence-envelope.js';

/**
 * V1-GROUND-OBSERVABILITY (E2): the grounding lifecycle becomes observable
 * through the EXISTING sanitized event sink — grounded success, the ONE
 * correction retry's attempt/outcome/provider failure and its latency —
 * WITHOUT increasing retries or calls and WITHOUT carrying any raw financial
 * claim, figure, document text, token or new ID. Counts, enums, stage names,
 * error classes and millisecond latencies only.
 */

const envelope = (data: unknown): EvidenceEnvelope => ({
  version: '1',
  items: [{ ref: 'api', source: 'api.balance', retrievedAt: '2026-10-09T12:00:00Z', status: 'ok', data }],
});

const GROUNDED = 'Seu saldo é R$ 123,45 na Conta principal.';
const env = envelope({ balanceCents: 12345, accountName: 'Conta principal' });

const collector = () => {
  const events: Array<{ type: string; fields: Record<string, unknown> }> = [];
  return { events, sink: (type: string, fields: Record<string, unknown>) => events.push({ type, fields }) };
};

const types = (events: ReadonlyArray<{ type: string }>): string[] => events.map((event) => event.type);
const fieldsOf = (events: ReadonlyArray<{ type: string; fields: Record<string, unknown> }>, type: string): Record<string, unknown> => {
  const found = events.find((event) => event.type === type);
  if (!found) throw new Error(`missing event: ${type}`);
  return found.fields;
};

describe('V1-GROUND-OBSERVABILITY: sanitized grounding lifecycle events', () => {
  it('emits agent.grounding.validated (stage initial) on first-attempt success', async () => {
    const { events, sink } = collector();
    const result = await createGroundedResponseWithRetry(GROUNDED, env, { sink, intentionId: 'intent-ok', traceId: 'trace-ok' });
    expect(result).toMatchObject({ grounded: true, rejected: false });
    expect(events).toEqual([
      { type: 'agent.grounding.validated', fields: { intentionId: 'intent-ok', traceId: 'trace-ok', stage: 'initial' } },
    ]);
    expect(JSON.stringify(events)).not.toMatch(/123,45|Conta principal/);
  });

  it('omits the ids from the validated event when the caller supplies none', async () => {
    const { events, sink } = collector();
    await createGroundedResponseWithRetry(GROUNDED, env, { sink });
    expect(events).toEqual([{ type: 'agent.grounding.validated', fields: { stage: 'initial' } }]);
  });

  it('emits attempt + outcome(grounded) + validated around the ONE correction retry', async () => {
    const { events, sink } = collector();
    const retry = vi.fn(async () => GROUNDED);
    const result = await createGroundedResponseWithRetry('Seu saldo é R$ 999,99 na Conta principal.', env, {
      retry,
      sink,
      intentionId: 'intent-retry-ok',
      traceId: 'trace-retry-ok',
    });
    expect(retry).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ grounded: true, rejected: false });
    expect(types(events)).toEqual([
      'agent.grounding.correction_attempted',
      'agent.grounding.correction_completed',
      'agent.grounding.validated',
    ]);
    expect(fieldsOf(events, 'agent.grounding.correction_attempted').unsupportedKinds).toMatchObject({ money: 1 });
    const completed = fieldsOf(events, 'agent.grounding.correction_completed');
    expect(completed.outcome).toBe('grounded');
    expect(typeof completed.latencyMs).toBe('number');
    expect(fieldsOf(events, 'agent.grounding.validated').stage).toBe('correction_retry');
    expect(JSON.stringify(events)).not.toMatch(/999,99|123,45|Conta principal/);
  });

  it('emits attempt + outcome(rejected) + the rejected event when the retry still fails', async () => {
    const { events, sink } = collector();
    const retry = vi.fn(async () => 'Seu saldo é R$ 888,88 na Conta principal.');
    const result = await createGroundedResponseWithRetry('Seu saldo é R$ 999,99 na Conta principal.', env, {
      retry,
      sink,
      intentionId: 'intent-retry-fail',
      traceId: 'trace-retry-fail',
    });
    expect(retry).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ grounded: false, rejected: true });
    expect(types(events)).toEqual([
      'agent.grounding.correction_attempted',
      'agent.grounding.correction_completed',
      'agent.grounding.rejected',
    ]);
    expect(fieldsOf(events, 'agent.grounding.correction_completed').outcome).toBe('rejected');
    const rejected = fieldsOf(events, 'agent.grounding.rejected');
    expect(rejected.status).toBe('rejected_after_retry');
    expect(rejected.unsupportedKinds).toMatchObject({ money: 1 });
    expect(JSON.stringify(events)).not.toMatch(/999,99|888,88|123,45|Conta principal/);
  });

  it('emits outcome(empty) then the rejected event when the retry returns nothing usable', async () => {
    const { events, sink } = collector();
    const retry = vi.fn(async () => null);
    const result = await createGroundedResponseWithRetry('Seu saldo é R$ 999,99 na Conta principal.', env, {
      retry,
      sink,
      intentionId: 'intent-retry-empty',
      traceId: 'trace-retry-empty',
    });
    expect(retry).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ grounded: false, rejected: true });
    expect(types(events)).toEqual([
      'agent.grounding.correction_attempted',
      'agent.grounding.correction_completed',
      'agent.grounding.rejected',
    ]);
    expect(fieldsOf(events, 'agent.grounding.correction_completed').outcome).toBe('empty');
    expect(fieldsOf(events, 'agent.grounding.rejected').status).toBe('rejected');
  });

  it('emits a sanitized provider-failure event (error class only) when the correction provider throws', async () => {
    const { events, sink } = collector();
    const retry = vi.fn(async () => {
      throw Object.assign(new Error('agent.provider_timeout'), { code: 'agent.provider_timeout', status: 504 });
    });
    const result = await createGroundedResponseWithRetry('Seu saldo é R$ 999,99 na Conta principal.', env, {
      retry,
      sink,
      intentionId: 'intent-retry-throw',
      traceId: 'trace-retry-throw',
    });
    expect(retry).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ grounded: false, rejected: true });
    expect(types(events)).toEqual([
      'agent.grounding.correction_attempted',
      'agent.grounding.correction_failed',
      'agent.grounding.rejected',
    ]);
    const failed = fieldsOf(events, 'agent.grounding.correction_failed');
    expect(failed.errorClass).toBe('timeout');
    expect(typeof failed.latencyMs).toBe('number');
    // The raw provider message never travels in the event.
    expect(JSON.stringify(events)).not.toMatch(/agent.provider_timeout/);
    expect(JSON.stringify(events)).not.toMatch(/999,99|123,45|Conta principal/);
  });

  it('rethrows the usage-quota passthrough verbatim without a correction-failure event', async () => {
    const { events, sink } = collector();
    const retry = vi.fn(async () => {
      throw Object.assign(new Error('agent.quota_exceeded'), {
        code: 'agent.quota_exceeded',
        status: 429,
        __usageQuotaPassthrough: true,
      });
    });
    await expect(
      createGroundedResponseWithRetry('Seu saldo é R$ 999,99 na Conta principal.', env, {
        retry,
        sink,
        intentionId: 'intent-quota',
      }),
    ).rejects.toMatchObject({ code: 'agent.quota_exceeded', status: 429 });
    expect(events.filter((event) => event.type === 'agent.grounding.correction_failed')).toHaveLength(0);
  });

  it('keeps the no-retry rejection event unchanged (attempt/outcome fire only around a retry)', async () => {
    const { events, sink } = collector();
    const result = await createGroundedResponseWithRetry('Seu saldo é R$ 999,99 na Conta principal.', env, {
      sink,
      intentionId: 'intent-no-retry',
      traceId: 'trace-no-retry',
    });
    expect(result).toMatchObject({ grounded: false, rejected: true });
    expect(types(events)).toEqual(['agent.grounding.rejected']);
    expect(fieldsOf(events, 'agent.grounding.rejected').status).toBe('rejected');
  });

  it('the observational hook stays outside the event lifecycle and the retry stays exactly one', async () => {
    const { events, sink } = collector();
    const retry = vi.fn(async () => GROUNDED);
    let hookCalls = 0;
    const result = await createGroundedResponseWithRetry('Seu saldo é R$ 999,99 na Conta principal.', env, {
      retry,
      onRecoveryAttempted: () => {
        hookCalls += 1;
        throw new Error('budget.sink_unavailable');
      },
      sink,
    });
    expect(hookCalls).toBe(1);
    expect(retry).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ grounded: true, rejected: false });
    expect(types(events)).toEqual([
      'agent.grounding.correction_attempted',
      'agent.grounding.correction_completed',
      'agent.grounding.validated',
    ]);
  });
});
