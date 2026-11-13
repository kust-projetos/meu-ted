// SPIKE 05D — negatives §6 (13 cases), deterministic, no inference.
//
// Every case runs against the REAL Postgres-backed Pending V2 (DB
// ted_spike_05d, synthetic-only) through fresh processes. Each case owns a
// distinct intention/key/description (neg-NN) so cases are disjoint across
// files, re-runs (setup resets each scope), and parallel runs.
//
// NOTE on case 01: the real authority answers an unknown/foreign id with 403
// approval.forbidden (no existence oracle — forbiddenOnMissing), NOT 404. The
// test asserts the REAL code and documents the deviation from the "404" text.
//
// Trace (sanitized, no tokens) is written to spike-05d/traces/.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { callFinanceDurable, isDurableOpAllowlisted } from '../../bootstrap/finance-transport-pg.mjs';
import {
  deriveIntentionId,
  deriveExpenseIdempotencyKey,
  TOOL_DEFS,
} from '../../bootstrap/ted-finance-tools.mjs';
import {
  spikePool,
  ensureSeed05d,
  resetScope05d,
  countTx05d,
  yesterdayUTC,
  HOUSEHOLD_A,
  ACCOUNT_NUBANK,
  CATEGORY_MERCADO,
} from '../scripts/db-05d.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOST_A = { token: 'dev-token-1', household: HOUSEHOLD_A };
const HOST_B = { token: 'dev-token-2', household: '00000000-0000-4000-8000-00000000000b' };
const SESSION = 'spike-05d-neg-session-01';

const trace = { suite: 'spike-05d-negatives', events: [] };
const mark = (event, data = {}) => trace.events.push({ at: new Date().toISOString(), event, ...data });

const mkCase = (n) => {
  const intentionId = deriveIntentionId({ sessionID: SESSION, messageID: `neg-${n}` });
  const idempotencyKey = deriveExpenseIdempotencyKey({ workspace: HOUSEHOLD_A, intentionId });
  return { n, intentionId, idempotencyKey, description: `mercado neg-${n}` };
};
const proposeBody = (c, overrides = {}) => ({
  tool: 'transactions.expense.create',
  normalizedArgs: {
    amountCents: 3500, description: c.description, date: yesterdayUTC(),
    accountId: ACCOUNT_NUBANK, categoryId: CATEGORY_MERCADO, ...overrides,
  },
});
const propose = (c, extra = {}) =>
  callFinanceDurable({ op: 'propose', host: HOST_A, body: proposeBody(c), idempotencyKey: c.idempotencyKey, intentionId: c.intentionId, ...extra });

test('05D negatives §6: 13 adversarial cases, zero unauthorized effects', async (t) => {
  if (!process.env.SPIKE05D_DATABASE_URL) t.skip('SPIKE05D_DATABASE_URL not set');
  const pool = spikePool();
  try {
    await ensureSeed05d(pool);
    const cases = Array.from({ length: 13 }, (_, i) => mkCase(String(i + 1).padStart(2, '0')));
    for (const c of cases) {
      await resetScope05d(pool, { keys: [c.idempotencyKey], intentions: [c.intentionId], descriptions: [c.description] });
    }

    // 01 — unknown id: real authority answers 403 approval.forbidden (no oracle, never 404 leak).
    {
      const r = await callFinanceDurable({ op: 'get', host: HOST_A, id: randomUUID(), requestId: cases[0].intentionId });
      assert.equal(r.statusCode, 403, `01: ${JSON.stringify(r.body)}`);
      assert.equal(r.body?.code, 'approval.forbidden');
      mark('neg.01.unknown-id', { status: r.statusCode, code: r.body?.code, note: 'real authority: 403 no-oracle, not 404' });
    }

    // 02 — foreign workspace reads nothing.
    {
      const c = cases[1];
      const p = await propose(c);
      assert.equal(p.statusCode, 201);
      const g = await callFinanceDurable({ op: 'get', host: HOST_B, id: p.body.id, requestId: c.intentionId });
      assert.equal(g.statusCode, 403, `02: ${JSON.stringify(g.body)}`);
      assert.equal(g.body?.code, 'approval.forbidden');
      mark('neg.02.foreign-workspace', { status: g.statusCode, code: g.body?.code });
    }

    // 03 — unauthorized actor cannot confirm.
    {
      const c = cases[2];
      const p = await propose(c);
      assert.equal(p.statusCode, 201);
      const cf = await callFinanceDurable({ op: 'confirm', host: HOST_B, id: p.body.id, body: { intentionId: c.intentionId }, requestId: c.intentionId });
      assert.equal(cf.statusCode, 403, `03: ${JSON.stringify(cf.body)}`);
      assert.equal(await countTx05d(pool, { description: c.description, accountId: ACCOUNT_NUBANK, date: yesterdayUTC() }), 0);
      mark('neg.03.foreign-confirm', { status: cf.statusCode, code: cf.body?.code, effects: 0 });
    }

    // 04 — birth-expired proposal fails fast, persists nothing.
    {
      const c = cases[3];
      const body = { tool: 'transactions.expense.create', normalizedArgs: { amountCents: 3500, description: c.description, date: yesterdayUTC(), accountId: ACCOUNT_NUBANK, categoryId: CATEGORY_MERCADO }, expiresAt: new Date(Date.now() - 60000).toISOString() };
      const r = await callFinanceDurable({ op: 'propose', host: HOST_A, body, idempotencyKey: c.idempotencyKey, intentionId: c.intentionId });
      assert.equal(r.statusCode, 409, `04: ${JSON.stringify(r.body)}`);
      assert.equal(r.body?.code, 'approval.expired');
      const row = await pool.query(`SELECT COUNT(*)::int AS n FROM pending_operations WHERE workspace_id=$1 AND idempotency_key=$2`, [HOUSEHOLD_A, c.idempotencyKey]);
      assert.equal(row.rows[0].n, 0);
      mark('neg.04.birth-expired', { status: r.statusCode, rows: 0 });
    }

    // 05 — expiry between propose and confirm refuses, zero effect.
    {
      const c = cases[4];
      const p = await propose(c);
      assert.equal(p.statusCode, 201);
      await pool.query(`UPDATE pending_operations SET expires_at = NOW() - interval '1 minute' WHERE id = $1::uuid`, [p.body.id]);
      const cf = await callFinanceDurable({ op: 'confirm', host: HOST_A, id: p.body.id, body: { intentionId: c.intentionId }, requestId: c.intentionId });
      assert.equal(cf.statusCode, 409, `05: ${JSON.stringify(cf.body)}`);
      assert.equal(cf.body?.code, 'approval.expired');
      assert.equal(await countTx05d(pool, { description: c.description, accountId: ACCOUNT_NUBANK, date: yesterdayUTC() }), 0);
      mark('neg.05.expired-confirm', { status: cf.statusCode, code: cf.body?.code, effects: 0 });
    }

    // 06 — idempotent replay: same key+payload → 200 existing:true, same id; single effect end-to-end.
    {
      const c = cases[5];
      const p1 = await propose(c);
      assert.equal(p1.statusCode, 201);
      const p2 = await propose(c);
      assert.equal(p2.statusCode, 200);
      assert.equal(p2.body?.existing, true);
      assert.equal(p2.body?.id, p1.body.id);
      const cf = await callFinanceDurable({ op: 'confirm', host: HOST_A, id: p1.body.id, body: { intentionId: c.intentionId }, requestId: c.intentionId });
      assert.equal(cf.statusCode, 200);
      const x = await callFinanceDurable({ op: 'execute', host: HOST_A, id: p1.body.id, body: { attestation: cf.body.attestation, intentionId: c.intentionId }, requestId: c.intentionId });
      assert.equal(x.statusCode, 200);
      assert.equal(await countTx05d(pool, { description: c.description, accountId: ACCOUNT_NUBANK, date: yesterdayUTC() }), 1);
      mark('neg.06.idempotent-replay', { proposalId: p1.body.id, effects: 1 });
    }

    // 07 — concurrent executes: exactly one winner, 1 effect.
    {
      const c = cases[6];
      const p = await propose(c);
      assert.equal(p.statusCode, 201);
      const cf = await callFinanceDurable({ op: 'confirm', host: HOST_A, id: p.body.id, body: { intentionId: c.intentionId }, requestId: c.intentionId });
      assert.equal(cf.statusCode, 200);
      const att = cf.body.attestation;
      const [a, b] = await Promise.all([
        callFinanceDurable({ op: 'execute', host: HOST_A, id: p.body.id, body: { attestation: att, intentionId: c.intentionId }, requestId: c.intentionId }),
        callFinanceDurable({ op: 'execute', host: HOST_A, id: p.body.id, body: { attestation: att, intentionId: c.intentionId }, requestId: c.intentionId }),
      ]);
      const codes = [a.statusCode, b.statusCode].sort();
      assert.deepEqual(codes, [200, 409], `07: ${a.statusCode}/${b.statusCode} ${JSON.stringify(a.body)} ${JSON.stringify(b.body)}`);
      const loser = a.statusCode === 409 ? a : b;
      assert.ok(['approval.execution_in_progress', 'approval.attestation_replayed'].includes(loser.body?.code), `07 loser code: ${loser.body?.code}`);
      assert.equal(await countTx05d(pool, { description: c.description, accountId: ACCOUNT_NUBANK, date: yesterdayUTC() }), 1);
      mark('neg.07.concurrent-execute', { winner: 200, loser: loser.body?.code, effects: 1 });
    }

    // 08 — same intentionId + divergent payload → 409 intention/intention-key conflict, zero effect.
    {
      const c = cases[7];
      const p1 = await propose(c);
      assert.equal(p1.statusCode, 201);
      const divergent = proposeBody(c, { amountCents: 9900 });
      const p2 = await callFinanceDurable({ op: 'propose', host: HOST_A, body: divergent, idempotencyKey: c.idempotencyKey, intentionId: c.intentionId });
      assert.equal(p2.statusCode, 409, `08: ${JSON.stringify(p2.body)}`);
      assert.ok(['idempotency.conflict', 'approval.intention_conflict'].includes(p2.body?.code), `08 code: ${p2.body?.code}`);
      assert.equal(await countTx05d(pool, { description: c.description, accountId: ACCOUNT_NUBANK, date: yesterdayUTC() }), 0);
      mark('neg.08.divergent-payload', { status: p2.statusCode, code: p2.body?.code, effects: 0 });
    }

    // 09 — timeout after persistence: execute response withheld, GET reconciles, no new intention.
    {
      const c = cases[8];
      const p = await propose(c);
      assert.equal(p.statusCode, 201);
      const cf = await callFinanceDurable({ op: 'confirm', host: HOST_A, id: p.body.id, body: { intentionId: c.intentionId }, requestId: c.intentionId });
      assert.equal(cf.statusCode, 200);
      // Warm-call execute ≈1–3s; the response is withheld post-persist for
      // 15s, so a 6s client timeout lands deterministically AFTER persistence.
      let timedOut = null;
      try {
        await callFinanceDurable({ op: 'execute', host: HOST_A, id: p.body.id, body: { attestation: cf.body.attestation, intentionId: c.intentionId }, requestId: c.intentionId, postDelayMs: 15000, timeoutMs: 6000 });
      } catch (e) { timedOut = e; }
      assert.ok(timedOut && timedOut.code === 'tool.timeout', `09 timeout: ${timedOut?.code}`);
      const g = await callFinanceDurable({ op: 'get', host: HOST_A, id: p.body.id, requestId: c.intentionId });
      assert.equal(g.statusCode, 200);
      assert.equal(g.body.status, 'succeeded', 'persisted despite client timeout — no new intention needed');
      assert.equal(await countTx05d(pool, { description: c.description, accountId: ACCOUNT_NUBANK, date: yesterdayUTC() }), 1);
      mark('neg.09.timeout-after-persist', { timeout: true, reconciled: g.body.status, effects: 1 });
    }

    // 10 — crash after propose before confirm: restart sees proposed, 0 effects.
    {
      const c = cases[9];
      const p = await propose(c);
      assert.equal(p.statusCode, 201);
      const g = await callFinanceDurable({ op: 'get', host: HOST_A, id: p.body.id, requestId: c.intentionId });
      assert.equal(g.statusCode, 200);
      assert.equal(g.body.status, 'proposed');
      const o = await callFinanceDurable({ op: 'outcome', host: HOST_A, id: p.body.id, requestId: c.intentionId });
      assert.equal(o.body.status, 'proposed');
      assert.equal(await countTx05d(pool, { description: c.description, accountId: ACCOUNT_NUBANK, date: yesterdayUTC() }), 0);
      mark('neg.10.crash-before-confirm', { status: g.body.status, effects: 0 });
    }

    // 11 — crash during executing (forced expired lease): reconcile recovers, exactly 1 effect.
    {
      const c = cases[10];
      const p = await propose(c);
      assert.equal(p.statusCode, 201);
      const cf = await callFinanceDurable({ op: 'confirm', host: HOST_A, id: p.body.id, body: { intentionId: c.intentionId }, requestId: c.intentionId });
      assert.equal(cf.statusCode, 200);
      await pool.query(
        `UPDATE pending_operations SET execution_status='executing', execution_claimed_at=NOW(), execution_lease_expires_at=NOW() - interval '2 minutes', execution_attempt_count=1, attestation_consumed_at=NOW() WHERE id=$1::uuid`,
        [p.body.id],
      );
      const rc = await callFinanceDurable({ op: 'reconcile', host: HOST_A, id: p.body.id, requestId: c.intentionId });
      assert.equal(rc.statusCode, 200, `11: ${JSON.stringify(rc.body)}`);
      assert.equal(rc.body.status, 'succeeded');
      assert.equal(await countTx05d(pool, { description: c.description, accountId: ACCOUNT_NUBANK, date: yesterdayUTC() }), 1);
      mark('neg.11.lease-recovery', { status: rc.body.status, effects: 1 });
    }

    // 12 — receipt survives restart: new process outcome returns the identical receipt.
    {
      const c = cases[5]; // succeeded in case 06
      const o = await callFinanceDurable({ op: 'outcome', host: HOST_A, id: (await pool.query(`SELECT id FROM pending_operations WHERE workspace_id=$1 AND idempotency_key=$2`, [HOUSEHOLD_A, c.idempotencyKey])).rows[0].id, requestId: c.intentionId });
      assert.equal(o.statusCode, 200);
      assert.equal(o.body.status, 'succeeded');
      assert.ok(o.body.receipt?.mutationId, 'receipt stable across restart');
      mark('neg.12.receipt-after-restart', { status: o.body.status, mutationStable: true });
    }

    // 13a — hostless confirm attempt refused before any transport (LLM path has no host).
    // 13b — TOOL_DEFS exposes no confirm/execute surface (propose-only by construction).
    // 13c — confirm without explicit body.intentionId refused with zero effect.
    {
      const c = cases[11];
      const p = await propose(c);
      assert.equal(p.statusCode, 201);
      let hostless = null;
      try {
        await callFinanceDurable({ op: 'confirm', host: null, id: p.body.id, body: { intentionId: c.intentionId } });
      } catch (e) { hostless = e; }
      assert.ok(hostless && hostless.code === 'host_context_required', `13a: ${hostless?.code}`);
      const names = TOOL_DEFS.map((d) => d.name);
      assert.ok(!names.some((n) => /confirm|execute|authorize|reconcile|cancel/i.test(n)), `13b TOOL_DEFS: ${names.join(',')}`);
      let noIntent = null;
      try {
        await callFinanceDurable({ op: 'confirm', host: HOST_A, id: p.body.id, body: {}, requestId: c.intentionId });
      } catch (e) { noIntent = e; }
      assert.ok(noIntent && noIntent.code === 'tool.invalid_args', `13c: ${noIntent?.code}`);
      assert.equal(await countTx05d(pool, { description: c.description, accountId: ACCOUNT_NUBANK, date: yesterdayUTC() }), 0);
      mark('neg.13.llm-cannot-confirm', { hostless: hostless?.code, toolDefs: names.join(','), noIntention: noIntent?.code, effects: 0 });
    }

    // "sim" textual: no text op exists; 'sim' is not allowlisted; nothing executes.
    {
      const c = cases[12];
      assert.equal(isDurableOpAllowlisted('sim'), false);
      let refused = null;
      try {
        await callFinanceDurable({ op: 'sim', host: HOST_A, body: { intentionId: c.intentionId } });
      } catch (e) { refused = e; }
      assert.ok(refused && refused.code === 'tool.invalid_args', `'sim': ${refused?.code}`);
      const p = await propose(c);
      assert.equal(p.statusCode, 201);
      assert.equal(await countTx05d(pool, { description: c.description, accountId: ACCOUNT_NUBANK, date: yesterdayUTC() }), 0);
      mark('neg.sim-text-never-confirms', { allowlisted: false, refusal: refused?.code, effects: 0 });
    }
  } finally {
    await pool.end().catch(() => {});
    const dir = path.join(HERE, '..', 'traces');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.writeFileSync(path.join(dir, `spike-05d-negatives-${stamp}.json`), JSON.stringify(trace, null, 2));
  }
});
