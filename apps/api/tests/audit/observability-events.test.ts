import { describe, expect, it } from 'vitest';
import {
  OBSERVABILITY_EVENT_TYPES,
  buildObservabilityEvent,
} from '../../src/audit/events.js';

describe('V4 observability contract (SPEC §24)', () => {
  it('exposes the 11 canonical event types (8 from SPEC §24 + 3 ADR-026 authorization events)', () => {
    expect([...OBSERVABILITY_EVENT_TYPES].sort()).toEqual(
      [
        'agent.workspace.legacy_access',
        'audit-undo.replay',
        'auth.request.legacy_bearer_used',
        'csp.violation',
        'device.tokens.legacy_active',
        'mic.error',
        'mutation.authorization.evaluated',
        'mutation.autoauthorized',
        'mutation.autoexecute.blocked',
        'mutation.reconcile.enqueued',
        'offline.locked',
      ].sort(),
    );
  });

  it('accepts sanitized payloads for the ADR-026 authorization events', () => {
    expect(
      buildObservabilityEvent('mutation.authorization.evaluated', {
        tool: 'transactions.expense.create',
        risk: 'low',
        decision: 'auto_execute',
        reason: 'explicit_low_risk',
      }),
    ).toMatchObject({ eventType: 'mutation.authorization.evaluated' });
    expect(
      buildObservabilityEvent('mutation.autoauthorized', {
        tool: 'transactions.income.create',
        risk: 'low',
        decision: 'auto_execute',
        reason: 'explicit_low_risk',
      }),
    ).toMatchObject({ eventType: 'mutation.autoauthorized' });
    expect(
      buildObservabilityEvent('mutation.autoexecute.blocked', {
        tool: 'transactions.expense.create',
        risk: 'high',
        decision: 'require_confirmation',
        reason: 'high_value',
      }),
    ).toMatchObject({ eventType: 'mutation.autoexecute.blocked' });
  });

  it('accepts a clean payload for each audit_logs-backed counter', () => {
    expect(
      buildObservabilityEvent('auth.request.legacy_bearer_used', {
        workspaceId: '00000000-0000-4000-8000-0000000000a1',
      }),
    ).toMatchObject({ eventType: 'auth.request.legacy_bearer_used' });
    expect(
      buildObservabilityEvent('audit-undo.replay', {
        workspaceId: '00000000-0000-4000-8000-0000000000a1',
      }),
    ).toMatchObject({ eventType: 'audit-undo.replay' });
    expect(
      buildObservabilityEvent('mutation.reconcile.enqueued', {
        workspaceId: '00000000-0000-4000-8000-0000000000a1',
        operationId: '00000000-0000-4000-8000-0000000000b2',
        reason: 'replay-after-restart',
      }),
    ).toMatchObject({ eventType: 'mutation.reconcile.enqueued' });
  });

  it('reduces blockedURL to its host without query or path', () => {
    const event = buildObservabilityEvent('csp.violation', {
      effectiveDirective: 'connect-src',
      blockedURL: 'https://api.synkroo.com.br/v1/accounts?token=abc&next=/x',
      disposition: 'enforce',
      statusCode: 200,
    });
    expect(event.payload).toMatchObject({
      effectiveDirective: 'connect-src',
      blockedHost: 'api.synkroo.com.br',
    });
    expect(JSON.stringify(event.payload)).not.toContain('token=abc');
    expect(JSON.stringify(event.payload)).not.toContain('/v1/accounts');
  });

  it('rejects a password anywhere in the payload', () => {
    expect(() =>
      buildObservabilityEvent('mic.error', {
        reason: 'denied',
        capability: 'on',
        password: 'supersecret',
      }),
    ).toThrow(/password/i);
  });

  it('rejects JWT-shaped bearer strings', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c';
    // Smuggled through the allowlisted dimension: privacy scans values first.
    expect(() =>
      buildObservabilityEvent('audit-undo.replay', {
        workspaceId: jwt,
      }),
    ).toThrow(/token/i);
  });

  it('rejects Bearer-scheme credential strings', () => {
    expect(() =>
      buildObservabilityEvent('audit-undo.replay', {
        workspaceId: 'Bearer abcdefgh12345678',
      }),
    ).toThrow(/token|bearer|credential/i);
  });

  it('rejects raw device tokens by key', () => {
    expect(() =>
      buildObservabilityEvent('device.tokens.legacy_active', {
        legacyCount: 3,
        deviceToken: 'tok_abcdef1234567890',
      }),
    ).toThrow(/device token/i);
  });

  it('rejects raw cookie values by key', () => {
    expect(() =>
      buildObservabilityEvent('auth.request.legacy_bearer_used', {
        workspaceId: '00000000-0000-4000-8000-0000000000a1',
        cookie: 'session=abc123; Path=/; HttpOnly',
      }),
    ).toThrow(/cookie/i);
    expect(() =>
      buildObservabilityEvent('auth.request.legacy_bearer_used', {
        workspaceId: '00000000-0000-4000-8000-0000000000a1',
        'set-cookie': 'session=abc123; Path=/; HttpOnly',
      }),
    ).toThrow(/cookie/i);
  });

  it('rejects attestation material', () => {
    expect(() =>
      buildObservabilityEvent('mutation.reconcile.enqueued', {
        workspaceId: '00000000-0000-4000-8000-0000000000a1',
        operationId: '00000000-0000-4000-8000-0000000000b2',
        reason: 'replay-after-restart',
        attestation: { hash: 'deadbeef' },
      }),
    ).toThrow(/attestation/i);
  });

  it('rejects a complete financial payload', () => {
    expect(() =>
      buildObservabilityEvent('audit-undo.replay', {
        workspaceId: '00000000-0000-4000-8000-0000000000a1',
        transaction: { amount: 1999, description: 'Mercado' },
      }),
    ).toThrow(/financial/i);
  });

  it('requires workspaceId where the audit_logs table demands it', () => {
    expect(() => buildObservabilityEvent('auth.request.legacy_bearer_used', {})).toThrow(
      /workspaceId/i,
    );
    expect(() => buildObservabilityEvent('audit-undo.replay', {})).toThrow(/workspaceId/i);
    expect(() =>
      buildObservabilityEvent('mutation.reconcile.enqueued', {
        operationId: '00000000-0000-4000-8000-0000000000b2',
        reason: 'replay-after-restart',
      }),
    ).toThrow(/workspaceId/i);
  });

  it('requires offline.locked dimensions (offlineSubjectId + age band)', () => {
    expect(() => buildObservabilityEvent('offline.locked', {})).toThrow(/offlineSubjectId/i);
    expect(() =>
      buildObservabilityEvent('offline.locked', {
        offlineSubjectId: '00000000-0000-4000-8000-0000000000a1',
      }),
    ).toThrow(/ageBand/i);
    expect(
      buildObservabilityEvent('offline.locked', {
        offlineSubjectId: '00000000-0000-4000-8000-0000000000a1',
        ageBand: '1-7d',
      }),
    ).toMatchObject({ eventType: 'offline.locked' });
  });

  it('requires mic.error reason code and capability flag', () => {
    expect(() => buildObservabilityEvent('mic.error', { reason: 'denied' })).toThrow(
      /capability/i,
    );
    expect(() =>
      buildObservabilityEvent('mic.error', { reason: 'exploded', capability: 'on' }),
    ).toThrow(/reason/i);
    expect(
      buildObservabilityEvent('mic.error', { reason: 'denied', capability: 'on' }),
    ).toMatchObject({ eventType: 'mic.error' });
  });

  it('requires mutation.reconcile.enqueued operationId and reason', () => {
    expect(() =>
      buildObservabilityEvent('mutation.reconcile.enqueued', {
        workspaceId: '00000000-0000-4000-8000-0000000000a1',
        reason: 'replay-after-restart',
      }),
    ).toThrow(/operationId/i);
  });
});

describe('FIX-F1 offline.locked strict dimensions (review Fase 1)', () => {
  const SUBJECT = '00000000-0000-4000-8000-0000000000a1';

  it('accepts a UUID subject with a closed age band', () => {
    expect(
      buildObservabilityEvent('offline.locked', {
        offlineSubjectId: SUBJECT,
        ageBand: '1-7d',
      }),
    ).toMatchObject({ eventType: 'offline.locked' });
  });

  it('rejects a non-UUID offlineSubjectId', () => {
    expect(() =>
      buildObservabilityEvent('offline.locked', {
        offlineSubjectId: 'subject-1',
        ageBand: '1-7d',
      }),
    ).toThrow(/offlineSubjectId/i);
  });

  it('rejects an ageBand outside the closed enum', () => {
    expect(() =>
      buildObservabilityEvent('offline.locked', {
        offlineSubjectId: SUBJECT,
        ageBand: 'over-24h',
      }),
    ).toThrow(/ageBand/i);
  });
});

describe('V4 observability adversarial privacy (FIX-F0, SPEC §24)', () => {
  const WS = '00000000-0000-4000-8000-0000000000a1';
  const OP = '00000000-0000-4000-8000-0000000000b2';

  it('rejects amount+description split across distinct nesting levels', () => {
    expect(() =>
      buildObservabilityEvent('audit-undo.replay', {
        workspaceId: WS,
        left: { nested: { amount: 1999 } },
        right: { deeper: { still: { description: 'Mercado' } } },
      }),
    ).toThrow(/financial/i);
  });

  it('rejects amount+description split across arrays and objects', () => {
    expect(() =>
      buildObservabilityEvent('audit-undo.replay', {
        workspaceId: WS,
        items: [{ pricing: { amountCents: 500 } }],
        notes: ['plain', { text: { description: 'Padaria' } }],
      }),
    ).toThrow(/financial/i);
  });

  it('rejects mixed-case forbidden keys (PaSs_WoRd, Set_Cookie, X-Device-Token)', () => {
    expect(() =>
      buildObservabilityEvent('mic.error', {
        reason: 'denied',
        capability: 'on',
        'PaSs_WoRd': 'supersecret',
      }),
    ).toThrow(/password/i);
    expect(() =>
      buildObservabilityEvent('auth.request.legacy_bearer_used', {
        workspaceId: WS,
        'Set_Cookie': 'session=abc123; Path=/; HttpOnly',
      }),
    ).toThrow(/cookie/i);
    expect(() =>
      buildObservabilityEvent('offline.locked', {
        offlineSubjectId: '00000000-0000-4000-8000-0000000000a1',
        ageBand: '1-7d',
        'X-Device-Token': 'tok_abcdef1234567890',
      }),
    ).toThrow(/token/i);
  });

  it('rejects a raw cookie without Set-Cookie attributes under a neutral key', () => {
    expect(() =>
      buildObservabilityEvent('audit-undo.replay', {
        workspaceId: WS,
        context: 'session=abc123',
      }),
    ).toThrow(/cookie|session/i);
  });

  it('rejects objects with toJSON (non-plain serialization smuggling)', () => {
    const sneaky = {
      reason: 'denied',
      toJSON: () => ({ password: 'supersecret' }),
    };
    expect(() =>
      buildObservabilityEvent('mic.error', {
        reason: 'denied',
        capability: 'on',
        meta: sneaky,
      }),
    ).toThrow(/privacy|toJSON|non-plain|plain/i);
  });

  it('rejects class instances (non-plain objects)', () => {
    class Holder {
      constructor(public value = 'x') {}
    }
    expect(() =>
      buildObservabilityEvent('mic.error', {
        reason: 'denied',
        capability: 'on',
        meta: new Holder() as unknown as Record<string, unknown>,
      }),
    ).toThrow(/privacy|non-plain|plain/i);
  });

  it('rejects cyclic payloads instead of recursing forever', () => {
    const cyclic: Record<string, unknown> = { reason: 'denied', capability: 'on' };
    cyclic['self'] = cyclic;
    expect(() => buildObservabilityEvent('mic.error', cyclic)).toThrow(/privacy|cycl/i);
  });

  it('rejects unknown fields per event (strict allowlist)', () => {
    expect(() =>
      buildObservabilityEvent('mic.error', {
        reason: 'denied',
        capability: 'on',
        provesNothing: 'hello',
      }),
    ).toThrow(/unknown|allowlist|not allowed/i);
    expect(() =>
      buildObservabilityEvent('offline.locked', {
        offlineSubjectId: '00000000-0000-4000-8000-0000000000a1',
        ageBand: '1-7d',
        session: 'abc',
      }),
    ).toThrow(/unknown|allowlist|not allowed|session|cookie/i);
    expect(() =>
      buildObservabilityEvent('mutation.reconcile.enqueued', {
        workspaceId: WS,
        operationId: OP,
        reason: 'replay-after-restart',
        extra: { nested: 'object' },
      }),
    ).toThrow(/unknown|allowlist|not allowed/i);
  });

  it('rejects Bearer credential values in any nested field', () => {
    expect(() =>
      buildObservabilityEvent('audit-undo.replay', {
        workspaceId: WS,
        context: { deep: { note: 'Bearer abcdefgh12345678' } },
      }),
    ).toThrow(/bearer|credential|token/i);
  });

  it('rejects JWT-shaped strings nested inside arrays', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c';
    expect(() =>
      buildObservabilityEvent('audit-undo.replay', {
        workspaceId: WS,
        hints: ['first', { second: [jwt] }],
      }),
    ).toThrow(/token/i);
  });

  it('rejects non-JSON values (functions, undefined, symbols)', () => {
    expect(() =>
      buildObservabilityEvent('mic.error', {
        reason: 'denied',
        capability: 'on',
        callback: (() => {}) as unknown as string,
      }),
    ).toThrow(/privacy|json|function/i);
    expect(() =>
      buildObservabilityEvent('mic.error', {
        reason: 'denied',
        capability: 'on',
        missing: undefined as unknown as string,
      }),
    ).toThrow(/privacy|json|undefined/i);
  });
});
