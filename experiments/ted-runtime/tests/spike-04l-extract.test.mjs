// SPIKE 04L regression: response extraction + zero-arg validation (deterministic, no inference).
//
// Root causes proven on live wire evidence (J06L/J07AL/J07BL sessions):
// (1) message.list arrives NEWEST-first with role-less rows; lastAssistantText
//     collected in wire order and returned the last item = the OLDEST prose,
//     usually the user question (R vacuum in every live trace). Fix: sort
//     chronologically by time.created (stable for timestamp-less rows) and
//     skip wire user-prompt rows ({text, type:'user'}).
// (2) codemode metadata toolCalls omit input/args for zero-arg invocations
//     (model ran tools.list_accounts({}) — code string proves {}; metadata
//     has no input field); checkAllCallsArgs failed "args must be an object".
//     Fix: absent input validates as empty args; required-field checks still
//     enforced (get_month_summary without yearMonth still fails).
// No phrase logic, no router, no regex over code in either fix.
//
// Run from: experiments/ted-runtime/bootstrap
//   node --test ../tests/spike-04l-extract.test.mjs
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BOOT = path.join(HERE, '..', 'bootstrap');

process.env.TED_HOME_ROOT = process.env.TED_HOME_ROOT || path.join(HERE, '..');

const JUNE_ANSWER = 'Em **junho de 2026** você gastou **R$ 2.880,50**. Receitas R$ 12.000,00, saldo R$ 9.119,50. Foram **4 transações**.';
const MAY_ANSWER = '**Maio/2026** — nenhum lançamento: receitas R$ 0,00, despesas R$ 0,00, 0 lançamentos.';

// Wire order: newest-first, role-less rows, time.created ascending in time.
function wireTwoTurn() {
  return [
    { id: 'm9', time: { created: 900 }, type: 'idle', outcome: 'succeeded' },
    {
      id: 'm8', time: { created: 800 }, type: 'assistant',
      content: [{ type: 'text', text: MAY_ANSWER }],
    },
    { id: 'm7', time: { created: 700 }, type: 'assistant', content: [{ type: 'reasoning', text: 'Get May 2026 summary.' }] },
    { id: 'm6', time: { created: 600 }, text: 'E em maio?', type: 'user' },
    { id: 'm5', time: { created: 500 }, type: 'idle', outcome: 'succeeded' },
    {
      id: 'm4', time: { created: 400 }, type: 'assistant',
      content: [{ type: 'text', text: JUNE_ANSWER }],
    },
    { id: 'm3', time: { created: 300 }, type: 'assistant', content: [{ type: 'reasoning', text: 'Call June summary.' }] },
    { id: 'm2', time: { created: 200 }, text: 'Quanto gastei em junho de 2026?', type: 'user' },
    { id: 'm1', time: { created: 100 }, type: 'agent-switched', agent: 'ted' },
  ];
}

describe('spike-04L extraction fixes (deterministic, no live)', () => {
  let turn03b;
  let journey04;
  before(async () => {
    turn03b = await import(pathToFileURL(path.join(BOOT, 'run-03b-turn.mjs')).href);
    journey04 = await import(pathToFileURL(path.join(BOOT, 'run-04-journey.mjs')).href);
  });

  it('(04L-1) newest-first wire messages yield the LATEST answer, never the question', () => {
    const got = turn03b.lastAssistantText(wireTwoTurn());
    assert.equal(got, MAY_ANSWER, 'must return the May answer (latest), not June, not the question');
    assert.ok(!got.includes('Quanto gastei'), 'question text must never surface as the answer');
  });

  it('(04L-2) single-turn wire session yields its answer (J06L shape)', () => {
    const single = [
      { id: 'a3', time: { created: 300 }, type: 'idle', outcome: 'succeeded' },
      { id: 'a2', time: { created: 200 }, type: 'assistant', content: [{ type: 'text', text: 'Você tem 2 contas: Itaú R$ 1.000,00 e Nubank R$ 500,00.' }] },
      { id: 'a1', time: { created: 100 }, text: 'Quais contas eu tenho?', type: 'user' },
    ];
    assert.match(turn03b.lastAssistantText(single), /Itaú/, 'assistant answer found, user question skipped');
  });

  it('(04L-3) legacy timestamp-less oldest-first shape still resolves (T3 contract)', () => {
    const legacy = [
      { parts: [{ type: 'text', text: 'TED, quais contas eu tenho?' }] },
      { parts: [{ type: 'reasoning', text: 'call tools' }] },
      { parts: [{ type: 'text', text: 'Você tem 2 contas: Itaú e Nubank.' }] },
    ];
    assert.match(turn03b.lastAssistantText(legacy), /Itaú/);
  });

  it('(04L-4) user-only wire shape yields empty (never the question)', () => {
    assert.equal(turn03b.lastAssistantText([{ role: 'user', parts: [{ type: 'text', text: 'hello' }] }]), '');
    assert.equal(turn03b.lastAssistantText([{ id: 'u', time: { created: 5 }, text: 'E em maio?', type: 'user' }]), '');
  });

  it('(04L-7) mixed timestamps: recent answer without timestamp beats older timestamped row (review P2)', () => {
    const mixed = [
      { id: 'new', type: 'assistant', content: [{ type: 'text', text: 'Resposta recente sem timestamp.' }] },
      { id: 'old', time: { created: 100 }, type: 'assistant', content: [{ type: 'text', text: 'Resposta antiga com timestamp.' }] },
    ];
    assert.equal(turn03b.lastAssistantText(mixed), 'Resposta recente sem timestamp.');
  });

  it('(04L-5) absent metadata input validates as empty args for list_accounts only', () => {
    const zeroArg = journey04.checkAllCallsArgs([{ name: 'list_accounts', args: undefined }], {});
    assert.equal(zeroArg.ok, true, `zero-arg list_accounts must validate: ${JSON.stringify(zeroArg.reasons)}`);
    const missingRequired = journey04.checkAllCallsArgs([{ name: 'get_month_summary', args: undefined }], {});
    assert.equal(missingRequired.ok, false, 'get_month_summary without yearMonth must still fail');
    assert.match(JSON.stringify(missingRequired.reasons), /yearMonth/);
  });

  it('(04L-6) yearMonth drift still mismatches (no leniency added)', () => {
    const drift = journey04.checkAllCallsArgs(
      [{ name: 'get_month_summary', args: { yearMonth: '2026-06' } }],
      { expectSummaryYearMonth: '2026-05' },
    );
    assert.equal(drift.ok, false);
    assert.match(JSON.stringify(drift.reasons), /2026-05/);
  });
});
