// P1 RED: read-only tool contract — list_accounts + get_month_summary (P2
// default) plus the optional P3 list_categories (opt-in only, never propose).
// No propose_expense / confirm / execute / PG bridge in this slice.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  TOOL_DEFS,
  TOOL_NAMES,
  validateToolArgs,
  deriveIntentionId,
  createToolExecutors,
  ToolError,
} from '../src/tool-defs.mjs';

const host = Object.freeze({
  label: 'a',
  token: 'token-a',
  household: 'HOUSEHOLD_A',
  actorId: 'actor-a',
  deviceId: 'device-a',
});

function stubTransport(cases) {
  return async ({ route, method, host: h }) => {
    assert.ok(h && h.token === host.token, 'host-bound token must travel per call');
    const hit = cases[`${method} ${route}`];
    assert.ok(hit, `unexpected route: ${method} ${route}`);
    return hit;
  };
}

describe('ted-runtime tool catalogue (read-only)', () => {
  it('knows the P2 reads plus the optional P3 category read (never proposal/write tools)', () => {
    assert.deepEqual([...TOOL_NAMES].sort(), ['get_month_summary', 'list_accounts', 'list_categories']);
    assert.equal(TOOL_DEFS.length, 3);
    for (const def of TOOL_DEFS) {
      assert.ok(def.input && typeof def.input === 'object', `${def.name} needs input schema`);
      assert.ok(def.output && typeof def.output === 'object', `${def.name} needs output schema (native 2.2.4 requirement)`);
    }
    assert.throws(() => validateToolArgs('propose_expense', {}), /unknown tool/);
  });

  it('rejects identity keys in args (host-bound, never tool args)', () => {
    for (const key of ['token', 'actorId', 'workspaceId', 'householdId', 'deviceId', 'sessionId', 'intentionId', 'idempotencyKey', 'callId']) {
      assert.throws(() => validateToolArgs('list_accounts', { [key]: 'x' }), /forbidden key/);
    }
  });

  it('requires stable intentionId in opts (CallID is correlation only)', async () => {
    const executors = createToolExecutors(stubTransport({}));
    await assert.rejects(
      () => executors.list_accounts({}, host, {}),
      /stable intentionId is required/,
    );
  });

  it('refuses hostless execution fail-closed', async () => {
    const executors = createToolExecutors(stubTransport({}));
    await assert.rejects(
      () => executors.list_accounts({}, null, { intentionId: 'int-x' }),
      /host-bound context is required/,
    );
  });

  it('derives stable intention per session+message, ignoring CallID', () => {
    const a = deriveIntentionId({ sessionID: 'ses_1', messageID: 'm1' });
    const b = deriveIntentionId({ sessionID: 'ses_1', messageID: 'm1', callID: 'call-other' });
    const c = deriveIntentionId({ sessionID: 'ses_1', messageID: 'm2' });
    assert.equal(a, b);
    assert.notEqual(a, c);
    assert.match(a, /^int-[0-9a-f]{32}$/);
  });

  it('reads list_accounts through the transport (no fabricated totals)', async () => {
    const body = { items: [{ id: 'a1' }], total: 1 };
    const executors = createToolExecutors(stubTransport({ 'GET /accounts': { statusCode: 200, body } }));
    const out = await executors.list_accounts({}, host, { intentionId: 'int-1' });
    assert.deepEqual(out, body);
  });

  it('reads get_month_summary and maps upstream errors to typed codes (never empty data)', async () => {
    const ok = { yearMonth: '2026-06', incomeCents: 100, expenseCents: 40, balanceCents: 60, transactionCount: 2 };
    const executors = createToolExecutors(
      stubTransport({ 'GET /dashboard/month-summary?yearMonth=2026-06': { statusCode: 200, body: ok } }),
    );
    const out = await executors.get_month_summary({ yearMonth: '2026-06' }, host, { intentionId: 'int-2' });
    assert.deepEqual(out, ok);

    const forbidden = createToolExecutors(stubTransport({ 'GET /accounts': { statusCode: 403, body: { error: 'nope' } } }));
    const err = await forbidden.list_accounts({}, host, { intentionId: 'int-3' }).catch((e) => e);
    assert.ok(err instanceof ToolError);
    assert.equal(err.code, 'tool.forbidden');
  });
});
