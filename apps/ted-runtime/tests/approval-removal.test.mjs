// Approval concept is gone from the agent layer: action tool names, model-facing
// text, and the removed TED_AGENT_SELF_CONFIRM flag.
import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { TOOL_DEFS, TOOL_NAMES, PROPOSAL_TOOL_SPECS, createToolExecutors } from '../src/tool-defs.mjs';
import { createActionIntentRegistry } from '../src/action-intents.mjs';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

it('all 14 action tools are renamed and still map to the exact API ids', () => {
  const expected = {
    record_expense: 'transactions.expense.create',
    record_income: 'transactions.income.create',
    record_card_purchase: 'cards.purchase.create',
    transfer_between_accounts: 'transactions.transfer.create',
    pay_card_statement: 'cards.statement.pay',
    create_account: 'accounts.create',
    create_category: 'categories.create',
    update_transaction: 'transactions.update',
    rename_account: 'accounts.update',
    deactivate_account: 'accounts.deactivate',
    rename_category: 'categories.update',
    deactivate_category: 'categories.deactivate',
    create_payable: 'payables.create',
    pay_payable: 'payables.pay',
  };
  const specs = Object.fromEntries(Object.entries(PROPOSAL_TOOL_SPECS).map(([name, spec]) => [name, spec.tool]));
  assert.deepEqual(specs, expected);
  for (const name of Object.keys(expected)) {
    assert.ok(TOOL_NAMES.includes(name), `missing action tool ${name}`);
    assert.ok(TOOL_DEFS.some((def) => def.name === name), `missing catalog def ${name}`);
  }
  for (const name of TOOL_NAMES) {
    assert.doesNotMatch(name, /^propose_|correct_pending_proposal|cancel_pending_proposal/);
  }
  assert.ok(TOOL_NAMES.includes('undo_last_action'), 'the user-visible undo tool remains');
});

it('action tool descriptions are execution-first and contain no approval language', () => {
  for (const name of Object.keys(PROPOSAL_TOOL_SPECS)) {
    const def = TOOL_DEFS.find((d) => d.name === name);
    assert.match(def.description, /assurance=\{complete:true,ambiguousEntity:false,explicitIntent:true\}/, name);
    assert.match(def.description, /pergunte em texto e NÃO chame esta ferramenta/, name);
    assert.match(def.output.description, /recorded/, name);
    for (const forbidden of [/approve/i, /aprova/i, /proposta pendente/i, /pending proposal/i, /never creates/i, /never pays/i]) {
      assert.doesNotMatch(`${def.description} ${def.output.description}`, forbidden, `${name}: ${forbidden}`);
    }
  }
});

it('the self-confirm flag and the approval-card flow are absent from the runtime source', () => {
  for (const file of fs.readdirSync(SRC).filter((f) => f.endsWith('.mjs'))) {
    const text = fs.readFileSync(path.join(SRC, file), 'utf8');
    assert.doesNotMatch(text, /TED_AGENT_SELF_CONFIRM|isSelfConfirmEnabled|selfConfirmEnabled/, file);
  }
  const main = fs.readFileSync(path.join(SRC, 'main.mjs'), 'utf8');
  assert.doesNotMatch(main, /autoExecEnabled|autoexec-client|category-autoexec/, 'legacy autoexec removed from boot');
});

it('update_transaction is description-only (API contract does not accept category/amount/date)', async () => {
  const executors = createToolExecutors(async () => { throw new Error('no direct transport'); }, {
    actionIntents: createActionIntentRegistry(),
  });
  const host = { token: 'test-token', household: 'w', actorId: 'actor', deviceId: 'device' };
  const opts = { sessionID: 's-update', intentionId: 'int-update' };
  for (const extra of [
    { categoryId: '11111111-1111-4111-8111-111111111111' },
    { amountCents: 100 },
    { date: '2026-11-21' },
  ]) {
    await assert.rejects(
      executors.update_transaction({
        transactionId: '11111111-1111-4111-8111-111111111111',
        description: 'nova descrição',
        expectedDescription: 'descrição atual',
        ...extra,
      }, host, opts),
      (error) => error.code === 'tool.invalid_args',
    );
  }
});
