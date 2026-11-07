// RED: 2xx com JSON arbitrário NÃO é dado financeiro válido (SPEC §5).
// Fixtures independentes copiadas do contrato real (accounts.ts:79,
// dashboard.ts:46-52) — não do stub interno do código. Validação é forma,
// nunca recálculo: valores passam intocados (saldo negativo preservado).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createToolExecutors, ToolError } from '../src/tool-defs.mjs';

const host = Object.freeze({ label: 'a', token: 'tok-shape', household: 'H_A', actorId: 'a', deviceId: 'd' });

const stubBody = (body) => async () => ({ statusCode: 200, body });

describe('tool 2xx shape validation (SPEC §5)', () => {
  it('accounts: aceita shape real e recusa lixo sem fabricar dados', async () => {
    const ok = createToolExecutors(stubBody({ items: [{ id: 'a1', kind: 'bank' }], total: 1 }));
    assert.deepEqual(await ok.list_accounts({}, host, { intentionId: 'i1' }), { items: [{ id: 'a1', kind: 'bank' }], total: 1 });
    const empty = createToolExecutors(stubBody({ items: [], total: 0 }));
    assert.deepEqual(await empty.list_accounts({ kind: 'bank' }, host, { intentionId: 'i2' }), { items: [], total: 0 });

    for (const [label, body] of [
      ['objeto vazio', {}],
      ['array', []],
      ['null', null],
      ['string', 'x'],
      ['items não-array', { items: 'x', total: 1 }],
      ['total não-numérico', { items: [], total: '1' }],
      ['total negativo', { items: [], total: -1 }],
      ['total não-inteiro', { items: [], total: 1.5 }],
      ['sem items', { total: 0 }],
    ]) {
      const ex = createToolExecutors(stubBody(body));
      const err = await ex.list_accounts({}, host, { intentionId: `i-${label}` }).catch((e) => e);
      assert.ok(err instanceof ToolError, `${label}: deve falhar`);
      assert.equal(err.code, 'tool.invalid_shape', `${label}: código tipado`);
      assert.ok(!JSON.stringify(err.details ?? {}).includes('tok-shape'), `${label}: sem segredo no erro`);
    }
  });

  it('month-summary: yearMonth deve ser exatamente o requisitado; cents/count inteiros, count não negativo; sem recálculo', async () => {
    const ok = createToolExecutors(stubBody({
      yearMonth: '2026-06', incomeCents: 1, expenseCents: 2, balanceCents: -1, transactionCount: 1,
    }));
    // Passa intocado: saldo negativo preservado, nada recalculado.
    assert.deepEqual(
      await ok.get_month_summary({ yearMonth: '2026-06' }, host, { intentionId: 'j1' }),
      { yearMonth: '2026-06', incomeCents: 1, expenseCents: 2, balanceCents: -1, transactionCount: 1 },
    );

    const cases = [
      ['mês trocado não vira grounding', { yearMonth: '2026-07', incomeCents: 1, expenseCents: 2, balanceCents: -1, transactionCount: 1 }, { yearMonth: '2026-06' }],
      ['mês ausente', { incomeCents: 1, expenseCents: 2, balanceCents: -1, transactionCount: 1 }, { yearMonth: '2026-06' }],
      ['cents string', { yearMonth: '2026-06', incomeCents: '1', expenseCents: 2, balanceCents: -1, transactionCount: 1 }, { yearMonth: '2026-06' }],
      ['cents não-inteiro', { yearMonth: '2026-06', incomeCents: 1.5, expenseCents: 2, balanceCents: -1, transactionCount: 1 }, { yearMonth: '2026-06' }],
      ['count negativo', { yearMonth: '2026-06', incomeCents: 1, expenseCents: 2, balanceCents: -1, transactionCount: -1 }, { yearMonth: '2026-06' }],
      ['count não-inteiro', { yearMonth: '2026-06', incomeCents: 1, expenseCents: 2, balanceCents: -1, transactionCount: 1.5 }, { yearMonth: '2026-06' }],
      ['corpo nulo', null, { yearMonth: '2026-06' }],
      ['corpo array', [], { yearMonth: '2026-06' }],
      ['corpo vazio', {}, { yearMonth: '2026-06' }],
    ];
    for (const [label, body, args] of cases) {
      const ex = createToolExecutors(stubBody(body));
      const err = await ex.get_month_summary(args, host, { intentionId: `j-${label}` }).catch((e) => e);
      assert.ok(err instanceof ToolError, `${label}: deve falhar`);
      assert.equal(err.code, 'tool.invalid_shape', `${label}: código tipado`);
    }
  });
});
