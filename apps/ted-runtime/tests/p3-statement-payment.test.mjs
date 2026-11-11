// P3.6 statement-payment slice: `list_card_statements` (read) and
// `propose_statement_payment` (proposal INTENT only).
//
// Contract under test:
// - The existing local P3 opt-ins expose the read and the proposal; production
//   forces both off.
// - `list_card_statements` calls the real GET /cards/statements route with the
//   optional card filter and fails closed on shape drift.
// - `propose_statement_payment` NEVER performs HTTP and NEVER writes: it
//   records ONE intent with the exact `cards.statement.pay` tuple
//   (statementId, fromAccountId, amountCents) for the authenticated PWA/Agent
//   broker. There is no confirm/execute surface for the LLM.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  TOOL_DEFS,
  TOOL_NAMES,
  validateToolArgs,
  createToolExecutors,
} from '../src/tool-defs.mjs';
import {
  PRODUCT_TOOL_NAMES,
  P3_READ_TOOL_NAMES,
  productToolDefs,
  isP3ReadsEnabled,
  isP3WritesEnabled,
} from '../src/plugin.mjs';
import { createProposalIntentRegistry } from '../src/proposal-intents.mjs';
import { HttpFinanceTransport, isRouteAllowlisted } from '../src/transport.mjs';

const host = Object.freeze({
  label: 'a',
  token: 'secret-token-a',
  household: 'H_A',
  actorId: 'actor-a',
  deviceId: 'dev-a',
});

const STATEMENT = '11111111-1111-4111-8111-111111111111';
const BANK = '11111111-1111-4111-8111-111111111112';
const CARD = '11111111-1111-4111-8111-111111111113';

const OFF_ENV = Object.freeze({ NODE_ENV: 'test' });
const READ_ENV = Object.freeze({ TED_OPENCODE_P3_READS_ENABLED: '1', NODE_ENV: 'test' });
const WRITE_ENV = Object.freeze({ TED_OPENCODE_P3_WRITES_ENABLED: '1', NODE_ENV: 'test' });
const PROD_ENV = Object.freeze({ TED_OPENCODE_P3_WRITES_ENABLED: '1', NODE_ENV: 'production' });

const statementItem = (overrides = {}) => ({
  id: STATEMENT,
  householdId: 'H_A',
  accountId: CARD,
  cycleYearMonth: '2026-11',
  closingDate: '2026-11-15',
  dueDate: '2026-11-25',
  totalCents: 120000,
  paidCents: 35000,
  status: 'partial',
  ...overrides,
});

const validPayArgs = (overrides = {}) => ({
  statementId: STATEMENT,
  fromAccountId: BANK,
  amountCents: 85000,
  ...overrides,
});

describe('p3.6 statement payment: catalog gating', () => {
  it('default catalog excludes the P3.6 tools', () => {
    assert.equal(isP3ReadsEnabled(OFF_ENV), false);
    assert.equal(isP3WritesEnabled(OFF_ENV), false);
    assert.deepEqual(productToolDefs(OFF_ENV).map((d) => d.name).sort(), ['get_month_summary', 'list_accounts']);
  });

  it('explicit activation applies in production too (no NODE_ENV shortcut)', () => {
    assert.equal(isP3ReadsEnabled(PROD_ENV), true);
    assert.equal(isP3WritesEnabled(PROD_ENV), true);
    assert.ok(productToolDefs(PROD_ENV).some((d) => d.name === 'propose_statement_payment'));
    // Absent flags stay OFF even in production.
    assert.deepEqual(productToolDefs({ NODE_ENV: 'production' }).map((d) => d.name).sort(), ['get_month_summary', 'list_accounts']);
  });

  it('the reads opt-in exposes list_card_statements; the writes opt-in exposes both', () => {
    const reads = productToolDefs(READ_ENV).map((d) => d.name).sort();
    assert.deepEqual(reads, [...PRODUCT_TOOL_NAMES, ...P3_READ_TOOL_NAMES].sort());
    const writes = productToolDefs(WRITE_ENV).map((d) => d.name).sort();
    assert.ok(writes.includes('list_card_statements'));
    assert.ok(writes.includes('propose_statement_payment'));
    const read = productToolDefs(WRITE_ENV).find((d) => d.name === 'list_card_statements');
    const propose = productToolDefs(WRITE_ENV).find((d) => d.name === 'propose_statement_payment');
    assert.equal(read.input.type, 'object');
    assert.ok(read.output && read.output.type === 'object');
    assert.equal(propose.input.type, 'object');
    assert.ok(propose.output && propose.output.type === 'object');
    assert.deepEqual([...propose.input.required].sort(), ['amountCents', 'fromAccountId', 'statementId']);
    assert.ok(TOOL_DEFS.some((d) => d.name === 'list_card_statements'));
    assert.ok(TOOL_DEFS.some((d) => d.name === 'propose_statement_payment'));
    assert.ok(TOOL_NAMES.includes('list_card_statements'));
    assert.ok(TOOL_NAMES.includes('propose_statement_payment'));
  });
});

describe('p3.6 statement payment: argument validation', () => {
  it('accepts the exact statement-payment tuple and rejects invalid values', () => {
    assert.deepEqual(validateToolArgs('propose_statement_payment', validPayArgs()), validPayArgs());
    assert.throws(() => validateToolArgs('propose_statement_payment', {}), /statementId/);
    assert.throws(
      () => validateToolArgs('propose_statement_payment', validPayArgs({ statementId: 'nope' })),
      /statementId must be a uuid/,
    );
    assert.throws(
      () => validateToolArgs('propose_statement_payment', validPayArgs({ fromAccountId: 'nope' })),
      /fromAccountId must be a uuid/,
    );
    for (const amount of [0, -1, 12.5, '85000', Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(
        () => validateToolArgs('propose_statement_payment', validPayArgs({ amountCents: amount })),
        /amountCents must be a positive safe integer/,
        `amount ${amount}`,
      );
    }
    assert.throws(
      () => validateToolArgs('propose_statement_payment', { ...validPayArgs(), amountCents: 'total' }),
      /amountCents must be a positive safe integer/,
    );
    assert.throws(
      () => validateToolArgs('propose_statement_payment', { ...validPayArgs(), description: 'x' }),
      /unknown arg/,
    );
  });

  it('validates list_card_statements filters and keeps identity host-bound', () => {
    assert.deepEqual(validateToolArgs('list_card_statements', {}), {});
    assert.deepEqual(validateToolArgs('list_card_statements', { accountId: CARD, limit: 5 }), { accountId: CARD, limit: 5 });
    assert.throws(() => validateToolArgs('list_card_statements', { accountId: 'nope' }), /accountId must be a uuid/);
    assert.throws(() => validateToolArgs('list_card_statements', { limit: 0 }), /limit/);
    assert.throws(() => validateToolArgs('list_card_statements', { bogus: 1 }), /unknown arg/);
    for (const key of ['token', 'actorId', 'workspaceId', 'householdId', 'deviceId', 'sessionId', 'intentionId', 'idempotencyKey', 'callId']) {
      assert.throws(
        () => validateToolArgs('propose_statement_payment', { ...validPayArgs(), [key]: 'x' }),
        /forbidden key/,
        `${key} must stay host-bound`,
      );
    }
  });
});

describe('p3.6 statement payment: read transport', () => {
  it('calls GET /cards/statements with the optional card filter and returns the real shape', async () => {
    const calls = [];
    const executors = createToolExecutors(async (args) => {
      calls.push(args);
      return { statusCode: 200, body: { items: [statementItem()], total: 1 } };
    });
    const out = await executors.list_card_statements({ accountId: CARD, limit: 5 }, host, { intentionId: 'int-stmt-read' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[0].route, `/cards/statements?accountId=${CARD}&limit=5`);
    assert.deepEqual(out.items, [statementItem()]);
    assert.equal(out.total, 1);
  });

  it('fails closed on malformed statement rows (never invents amounts)', async () => {
    const bad = createToolExecutors(async () => ({
      statusCode: 200,
      body: { items: [statementItem({ totalCents: '120000' })], total: 1 },
    }));
    await assert.rejects(
      () => bad.list_card_statements({}, host, { intentionId: 'int-stmt-bad' }),
      /totalCents must be a non-negative safe integer/,
    );
    const overpaid = createToolExecutors(async () => ({
      statusCode: 200,
      body: { items: [statementItem({ paidCents: 130000 })], total: 1 },
    }));
    await assert.rejects(
      () => overpaid.list_card_statements({}, host, { intentionId: 'int-stmt-overpaid' }),
      /paidCents cannot exceed totalCents/,
    );
  });
});

describe('p3.6 statement payment: intent only, never HTTP/write', () => {
  it('records one host-bound payment intent and returns a proposal status (no transport call)', async () => {
    const registry = createProposalIntentRegistry();
    let transportCalls = 0;
    const executors = createToolExecutors(
      async () => { transportCalls += 1; throw new Error('propose must never call the finance transport'); },
      { proposalIntents: registry },
    );
    const out = await executors.propose_statement_payment(validPayArgs(), host, {
      sessionID: 'session-statement-1',
      intentionId: 'int-statement-abc',
    });
    assert.equal(transportCalls, 0, 'no HTTP from propose_statement_payment');
    assert.equal(out.status, 'proposed');
    assert.match(out.summary, /Pagamento de fatura de R\$\s?850,00/);

    const intent = registry.take('session-statement-1');
    assert.deepEqual(intent, {
      tool: 'cards.statement.pay',
      intentionId: 'int-statement-abc',
      summary: out.summary,
      normalizedArgs: { statementId: STATEMENT, fromAccountId: BANK, amountCents: 85000 },
    });
  });

  it('fails closed without the proposal registry or host-bound session', async () => {
    const executors = createToolExecutors(async () => ({ statusCode: 200, body: {} }));
    await assert.rejects(
      () => executors.propose_statement_payment(validPayArgs(), host, { sessionID: 's', intentionId: 'i' }),
      /proposal intent registry unavailable/,
    );
    const withRegistry = createToolExecutors(async () => ({ statusCode: 200, body: {} }), {
      proposalIntents: createProposalIntentRegistry(),
    });
    await assert.rejects(
      () => withRegistry.propose_statement_payment(validPayArgs(), host, { intentionId: 'i' }),
      /host-bound session context is required/,
    );
  });
});

describe('p3.6 statement payment: transport allowlist (GET only, same identity)', () => {
  it('allowlists GET /cards/statements with the contract queries, blocks writes and sub-paths', async () => {
    assert.equal(isRouteAllowlisted('/cards/statements'), true);
    assert.equal(isRouteAllowlisted(`/cards/statements?accountId=${CARD}`), true);
    assert.equal(isRouteAllowlisted('/cards/statements?status=open'), true);
    assert.equal(isRouteAllowlisted('/cards/statements?limit=5'), true);
    assert.equal(isRouteAllowlisted(`/cards/statements?accountId=${CARD}&status=open&limit=5`), true);
    assert.equal(isRouteAllowlisted('/cards/statements/123'), false);
    assert.equal(isRouteAllowlisted('/cards/statements/123/pay'), false);
    const t = new HttpFinanceTransport({
      baseUrl: 'http://127.0.0.1:9',
      fetchImpl: async () => { throw new Error('must not be called'); },
    });
    await assert.rejects(() => t.call({ route: '/cards/statements', method: 'POST', host }), /method not allowlisted/);
    await assert.rejects(() => t.call({ route: '/cards/statements', method: 'PATCH', host }), /method not allowlisted/);
    await assert.rejects(() => t.call({ route: '/cards/statements', method: 'DELETE', host }), /method not allowlisted/);
    await assert.rejects(() => t.call({ route: '/cards/statements/123/pay', method: 'POST', host }), /not allowlisted/);
  });

  it('sends host-derived headers and never Authorization', async () => {
    const seen = [];
    const fetchImpl = async (url, init) => {
      seen.push({ url, init });
      return { status: 200, json: async () => ({ items: [], total: 0 }) };
    };
    const t = new HttpFinanceTransport({ baseUrl: 'http://127.0.0.1:9', fetchImpl });
    await t.call({ route: `/cards/statements?accountId=${CARD}`, method: 'GET', host });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].init.headers['x-device-token'], 'secret-token-a');
    assert.equal(seen[0].init.headers['x-workspace-id'], 'H_A');
    assert.ok(!('authorization' in seen[0].init.headers), 'never Authorization');
  });
});
