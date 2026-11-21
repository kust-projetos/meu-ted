// P1 RED: read-only tool contract — list_accounts + get_month_summary (P2
// default) plus the optional P3 list_categories and the P3 proposal INTENTS
// (record_expense + record_income). No confirm/execute/PG bridge in this slice.
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
import { PRODUCT_TOOL_NAMES, P3_READ_TOOL_NAMES, P3_WRITE_TOOL_NAMES } from '../src/plugin.mjs';
import { undoActionRegistry } from '../src/undo-actions.mjs';

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

describe('ted-runtime tool catalogue (read-only + proposal intent)', () => {
  it('knows the P2 reads, the optional P3 reads and the proposal intent (no confirm/execute)', () => {
    assert.deepEqual([...TOOL_NAMES].sort(), [...PRODUCT_TOOL_NAMES, ...P3_READ_TOOL_NAMES, ...P3_WRITE_TOOL_NAMES, 'recall_category_preference'].sort());
    assert.equal(TOOL_DEFS.length, TOOL_NAMES.length);
    for (const def of TOOL_DEFS) {
      assert.ok(def.input && typeof def.input === 'object', `${def.name} needs input schema`);
      assert.ok(def.output && typeof def.output === 'object', `${def.name} needs output schema (native 2.2.4 requirement)`);
    }
    for (const name of ['confirm_expense', 'execute_expense', 'confirm', 'execute']) {
      assert.throws(() => validateToolArgs(name, {}), /unknown tool/);
    }
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

  it('undo_last_action is P3-write gated and only records an intent', async () => {
    assert.ok(P3_WRITE_TOOL_NAMES.includes('undo_last_action'));
    const executors=createToolExecutors(stubTransport({}),{undoActions:undoActionRegistry});
    const result=await executors.undo_last_action({}, {...host,conversationId:'conv-a'}, {intentionId:'msg-undo',sessionID:'runtime-undo'});
    assert.deepEqual(result,{status:'recorded'});
    assert.deepEqual(undoActionRegistry.take('runtime-undo'),{
      action:'undo',intentionId:'msg-undo',conversationId:'conv-a',workspaceId:host.household,actorId:host.actorId,deviceId:host.deviceId,
    });
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
