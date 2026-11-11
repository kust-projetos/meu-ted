// V1 completion — conversational accounts-payable tools.
//
// Reads: list_payables / payable_reminders (covered in v1-financial-reads).
// Writes: propose_payable_create / propose_payable_pay are INTENT-ONLY and map
// to the new Pending V2 tools `payables.create` / `payables.pay`. The pay
// intent carries the authoritative-read display snapshot; payableId is the
// only execution key.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { TOOL_DEFS, validateToolArgs, createToolExecutors, ToolError } from '../src/tool-defs.mjs';
import { productToolDefs } from '../src/plugin.mjs';
import { createProposalIntentRegistry } from '../src/proposal-intents.mjs';

const host = Object.freeze({
  label: 'a',
  token: 'secret-token-a',
  household: 'H_A',
  actorId: 'actor-a',
  deviceId: 'dev-a',
});
const WRITE_ENV = Object.freeze({ TED_OPENCODE_P3_WRITES_ENABLED: '1' });
const PAYABLE = '11111111-1111-4111-8111-111111111111';
const ACCOUNT = '22222222-2222-4222-8222-222222222222';
const CATEGORY = '33333333-3333-4333-8333-333333333333';

describe('v1 payable proposals: catalog and validation', () => {
  it('exposes both proposals only under the writes opt-in', () => {
    const names = productToolDefs(WRITE_ENV).map((d) => d.name);
    for (const name of ['propose_payable_create', 'propose_payable_pay']) {
      assert.ok(names.includes(name));
      assert.ok(TOOL_DEFS.some((d) => d.name === name));
    }
    assert.ok(!productToolDefs({}).some((d) => d.name.startsWith('propose_payable')));
  });

  it('create validates the payable tuple and optional category', () => {
    const valid = { accountId: ACCOUNT, description: 'Aluguel', amountCents: 150000, dueDate: '2026-12-05' };
    assert.deepEqual(validateToolArgs('propose_payable_create', valid), valid);
    assert.deepEqual(validateToolArgs('propose_payable_create', { ...valid, categoryId: CATEGORY }), { ...valid, categoryId: CATEGORY });
    assert.throws(() => validateToolArgs('propose_payable_create', { ...valid, amountCents: 0 }), /amountCents/);
    assert.throws(() => validateToolArgs('propose_payable_create', { ...valid, dueDate: '05/12/2026' }), /dueDate/);
    assert.throws(() => validateToolArgs('propose_payable_create', { ...valid, accountId: 'x' }), /accountId must be a uuid/);
    assert.throws(() => validateToolArgs('propose_payable_create', { ...valid, categoryId: 'x' }), /categoryId must be a uuid/);
  });

  it('pay requires the authoritative display snapshot plus the payable id', () => {
    const valid = {
      payableId: PAYABLE,
      description: 'Aluguel',
      amountCents: 150000,
      dueDate: '2026-12-05',
      accountId: ACCOUNT,
    };
    assert.deepEqual(validateToolArgs('propose_payable_pay', valid), valid);
    assert.throws(() => validateToolArgs('propose_payable_pay', { ...valid, amountCents: -1 }), /amountCents/);
    assert.throws(() => validateToolArgs('propose_payable_pay', { ...valid, payableId: 'x' }), /payableId must be a uuid/);
    assert.throws(() => validateToolArgs('propose_payable_pay', { ...valid, description: '  ' }), /description/);
    assert.throws(() => validateToolArgs('propose_payable_pay', { ...valid, dueDate: undefined }), /dueDate/);
    assert.throws(() => validateToolArgs('propose_payable_pay', { ...valid, bogus: 1 }), /unknown arg/);
  });
});

describe('v1 payable proposals: intent only', () => {
  it('records exact normalized args and never calls the transport', async () => {
    const registry = createProposalIntentRegistry();
    let calls = 0;
    const executors = createToolExecutors(async () => { calls += 1; throw new Error('no'); }, { proposalIntents: registry });
    const opts = { intentionId: 'int-pay', sessionID: 'ses-pay' };

    const createOut = await executors.propose_payable_create(
      { accountId: ACCOUNT, description: ' Aluguel ', amountCents: 150000, dueDate: '2026-12-05', categoryId: CATEGORY },
      host,
      opts,
    );
    assert.equal(createOut.status, 'proposed');
    let intent = registry.take('ses-pay');
    assert.equal(intent.tool, 'payables.create');
    assert.deepEqual(intent.normalizedArgs, { accountId: ACCOUNT, description: 'Aluguel', amountCents: 150000, dueDate: '2026-12-05', categoryId: CATEGORY });

    const payOut = await executors.propose_payable_pay(
      { payableId: PAYABLE, description: 'Aluguel', amountCents: 150000, dueDate: '2026-12-05', accountId: ACCOUNT, paidDate: '2026-12-06' },
      host,
      opts,
    );
    assert.equal(payOut.status, 'proposed');
    intent = registry.take('ses-pay');
    assert.equal(intent.tool, 'payables.pay');
    assert.deepEqual(intent.normalizedArgs, {
      payableId: PAYABLE,
      description: 'Aluguel',
      amountCents: 150000,
      dueDate: '2026-12-05',
      accountId: ACCOUNT,
      paidDate: '2026-12-06',
    });
    assert.equal(calls, 0);
  });

  it('fails closed without the registry', async () => {
    const executors = createToolExecutors(async () => ({ statusCode: 200, body: {} }), {});
    await assert.rejects(
      () => executors.propose_payable_create({ accountId: ACCOUNT, description: 'X', amountCents: 1, dueDate: '2026-12-05' }, host, { intentionId: 'i', sessionID: 's' }),
      (err) => err instanceof ToolError && err.code === 'tool.unavailable',
    );
  });
});
