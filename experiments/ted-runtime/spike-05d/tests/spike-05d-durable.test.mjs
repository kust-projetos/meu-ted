// SPIKE 05D — durable Pending V2 proof (§5 1-10), deterministic, no inference.
//
// Each callFinanceDurable call is a FRESH OS process + fresh pg pool against
// DB ted_spike_05d (synthetic-only). Cross-call identity of the proposal id,
// status transitions, receipt and ledger counts therefore prove DURABLE
// (Postgres) persistence — the restart proof the in-memory bridge cannot give.
//
// Flow: propose (stable intentionId + ted-<sha> key → 201) → GET same id →
// new-process GET (D03) → confirm (authorized synthetic identity + intentionId
// → confirmed + attestation) → execute (attestation → succeeded) → direct-SQL
// verification (exactly 1 transaction for the intention; canonical receipt
// operationId==proposalId, entity.id==transactionId, 3500/Nubank/Mercado/
// yesterday-dynamic) → replay confirm/execute (no 2nd effect) → outcome.
//
// Re-runnable: setup resets this test's scope (own key/intention/description).
// Trace (sanitized, no tokens) is written to spike-05d/traces/.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { callFinanceDurable } from '../../bootstrap/finance-transport-pg.mjs';
import {
  deriveIntentionId,
  deriveExpenseIdempotencyKey,
} from '../../bootstrap/ted-finance-tools.mjs';
import {
  spikePool,
  ensureSeed05d,
  resetScope05d,
  countTx05d,
  getTx05d,
  getPending05d,
  yesterdayUTC,
  HOUSEHOLD_A,
  ACCOUNT_NUBANK,
  CATEGORY_MERCADO,
} from '../scripts/db-05d.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOST = { token: 'dev-token-1', household: HOUSEHOLD_A };
const SESSION = 'spike-05d-durable-session-01';
const MESSAGE = 'spike-05d-msg-01';
const DESCRIPTION = 'mercado';

const trace = { suite: 'spike-05d-durable', events: [], restartMarkers: 0 };
const mark = (event, data = {}) => trace.events.push({ at: new Date().toISOString(), event, ...data });
const restart = (label) => { trace.restartMarkers += 1; mark('process.restart', { label, marker: trace.restartMarkers }); };

test('05D durable §5: propose→confirm→execute persists across processes, exactly 1 effect', async (t) => {
  if (!process.env.SPIKE05D_DATABASE_URL) t.skip('SPIKE05D_DATABASE_URL not set');
  const pool = spikePool();
  try {
    await ensureSeed05d(pool);
    const intentionId = deriveIntentionId({ sessionID: SESSION, messageID: MESSAGE });
    assert.match(intentionId, /^int-[0-9a-f]{32}$/);
    const idempotencyKey = deriveExpenseIdempotencyKey({ workspace: HOUSEHOLD_A, intentionId });
    assert.match(idempotencyKey, /^ted-[0-9a-f]{32}$/);
    const date = yesterdayUTC();
    mark('intention.derived', { intentionId, idempotencyKey, date });
    await resetScope05d(pool, { keys: [idempotencyKey], intentions: [intentionId], descriptions: [DESCRIPTION] });

    const proposeBody = {
      tool: 'transactions.expense.create',
      normalizedArgs: { amountCents: 3500, description: DESCRIPTION, date, accountId: ACCOUNT_NUBANK, categoryId: CATEGORY_MERCADO },
    };

    // (a) propose → 201 proposed
    const p1 = await callFinanceDurable({ op: 'propose', host: HOST, body: proposeBody, idempotencyKey, intentionId });
    assert.equal(p1.statusCode, 201, `propose status: ${JSON.stringify(p1.body)}`);
    const proposalId = p1.body.id;
    assert.match(proposalId, /^[0-9a-f-]{36}$/);
    assert.equal(p1.body.status, 'proposed');
    assert.equal(p1.body.existing, false);
    mark('propose.201', { proposalId });

    // (b) GET same id (new process by construction)
    restart('get-same-process');
    const g1 = await callFinanceDurable({ op: 'get', host: HOST, id: proposalId, requestId: intentionId });
    assert.equal(g1.statusCode, 200);
    assert.equal(g1.body.id, proposalId);
    assert.equal(g1.body.status, 'proposed');
    mark('get.same', { proposalId, status: g1.body.status });

    // (c-d) new process GET → same id (D03 durability)
    restart('D03-restart');
    const g2 = await callFinanceDurable({ op: 'get', host: HOST, id: proposalId, requestId: intentionId });
    assert.equal(g2.statusCode, 200);
    assert.equal(g2.body.id, proposalId);
    assert.equal(g2.body.status, 'proposed');
    mark('get.restart', { proposalId, status: g2.body.status });

    // (e) confirm with authorized synthetic identity + intentionId
    restart('confirm');
    const c1 = await callFinanceDurable({
      op: 'confirm', host: HOST, id: proposalId,
      body: { intentionId }, requestId: intentionId,
    });
    assert.equal(c1.statusCode, 200, `confirm status: ${JSON.stringify(c1.body)}`);
    assert.equal(c1.body.status, 'confirmed');
    assert.ok(typeof c1.body.attestation === 'string' && c1.body.attestation.length >= 32, 'attestation issued');
    const attestation = c1.body.attestation;
    mark('confirm.confirmed', { proposalId, attestationLength: attestation.length });

    // (f) execute via attestation → succeeded
    restart('execute');
    const x1 = await callFinanceDurable({
      op: 'execute', host: HOST, id: proposalId,
      body: { attestation, intentionId }, requestId: intentionId,
    });
    assert.equal(x1.statusCode, 200, `execute status: ${JSON.stringify(x1.body)}`);
    assert.equal(x1.body.status, 'succeeded');
    mark('execute.succeeded', { proposalId });

    // (g) direct-SQL verification: exactly 1 transaction for the intention
    const n = await countTx05d(pool, { description: DESCRIPTION, accountId: ACCOUNT_NUBANK, date });
    assert.equal(n, 1, `exactly 1 transaction for the intention, got ${n}`);
    const receipt = x1.body.execution?.receipt;
    assert.ok(receipt, 'canonical receipt present');
    assert.equal(receipt.operationId, proposalId, 'receipt.operationId == proposalId');
    assert.ok(receipt.entity?.id, 'receipt.entity.id present');
    assert.equal(receipt.status, 'succeeded');
    const tx = await getTx05d(pool, receipt.entity.id);
    assert.ok(tx, 'receipt entity exists in ledger');
    assert.equal(Number(tx.amount_cents), 3500);
    assert.equal(tx.account_id, ACCOUNT_NUBANK);
    assert.equal(tx.category_id, CATEGORY_MERCADO);
    const txDate = tx.date instanceof Date ? tx.date.toISOString().slice(0, 10) : String(tx.date).slice(0, 10);
    assert.equal(txDate, date);
    assert.equal(tx.kind, 'expense');
    const row = await getPending05d(pool, proposalId);
    assert.equal(row?.execution_status, 'succeeded');
    mark('sql.verified', { transactionId: receipt.entity.id, mutationId: receipt.mutationId, txCount: n });

    // (h) replay confirm + execute → no 2nd effect
    restart('replay');
    // SPEC §9/H-03: re-emit applies to `confirmed` (unconsumed attestation).
    // After `succeeded`, confirm is refused (409 not_pending, zero effect).
    const c2 = await callFinanceDurable({
      op: 'confirm', host: HOST, id: proposalId,
      body: { intentionId }, requestId: intentionId,
    });
    assert.equal(c2.statusCode, 409);
    assert.equal(c2.body?.code, 'approval.not_pending');
    const x2 = await callFinanceDurable({
      op: 'execute', host: HOST, id: proposalId,
      body: { attestation, intentionId }, requestId: intentionId,
    });
    assert.ok([403, 409].includes(x2.statusCode), `replay execute refused, got ${x2.statusCode}: ${JSON.stringify(x2.body)}`);
    const n2 = await countTx05d(pool, { description: DESCRIPTION, accountId: ACCOUNT_NUBANK, date });
    assert.equal(n2, 1, `still exactly 1 transaction after replay, got ${n2}`);
    mark('replay.no-second-effect', { replayStatus: x2.statusCode, code: x2.body?.code, txCount: n2 });

    // (i) GET outcome → succeeded + same receipt
    restart('outcome');
    const o1 = await callFinanceDurable({ op: 'outcome', host: HOST, id: proposalId, requestId: intentionId });
    assert.equal(o1.statusCode, 200);
    assert.equal(o1.body.status, 'succeeded');
    assert.equal(o1.body.receipt?.operationId, proposalId);
    assert.equal(o1.body.receipt?.entity?.id, receipt.entity.id);
    assert.equal(o1.body.receipt?.mutationId, receipt.mutationId);
    mark('outcome.succeeded', { proposalId, receiptStable: true });
  } finally {
    await pool.end().catch(() => {});
    const dir = path.join(HERE, '..', 'traces');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.writeFileSync(path.join(dir, `spike-05d-durable-${stamp}.json`), JSON.stringify(trace, null, 2));
  }
});
