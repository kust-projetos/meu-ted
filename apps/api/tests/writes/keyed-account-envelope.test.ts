/**
 * Round3 MEDIUM: envelope `{ account }` validado estruturalmente + consult do
 * vencedor sem mascarar o erro original. Tudo com pool FAKE (sem PG).
 *
 * - Replay normal / claim-race com JSON inválido → DomainError
 *   `idempotency.conflict` fail-closed (nunca SyntaxError cru, nunca replay
 *   de lixo).
 * - Own-error (mutate falhou após SELECT ausente) com envelope ilegível,
 *   incompleto, de outro household ou consult que falha → erro ORIGINAL
 *   preservado; payload divergente → conflict; envelope válido → replay.
 */
import { describe, expect, it, vi } from 'vitest';
import { runKeyedAccountMutation } from '../../src/writes/pending-idempotency.js';
import { hashPayloadV2 } from '../../src/writes/idempotency.js';
import type { PoolClient } from 'pg';

const H = 'household-1';
const OTHER_H = 'household-2';
const KEY = 'k-env';
const PAYLOAD = { name: 'Conta', kind: 'bank', initialBalanceCents: 0 };

const validAccount = (overrides: Record<string, unknown> = {}) => ({
  id: '11111111-1111-4111-8111-111111111111',
  householdId: H,
  name: 'Conta',
  kind: 'bank',
  balanceCents: 0,
  status: 'active',
  ...overrides,
});

type Scenario = {
  /** Linhas que o SELECT dentro da tx retorna (hit path) ou [] (ausente). */
  txSelectRows: Array<{ payload_hash: string; response: unknown }>;
  /** Resultado do INSERT de claim (rowCount 1 = venceu; 0 = perdeu a corrida). */
  claimRowCount: 0 | 1;
  /** Linhas que o SELECT de consult fora da tx retorna. */
  consultRows: Array<{ payload_hash: string; response: unknown } | null> | 'throw';
};

const makeFake = (scenario: Scenario, mutateImpl?: (client: PoolClient) => Promise<never>) => {
  const mutate = vi.fn(
    mutateImpl ??
      (async () => {
        throw new Error('boom-original');
      }),
  );
  const clientQuery = vi.fn(async (text: string) => {
    if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [], rowCount: 0 };
    if (text.includes('FROM idempotency_keys')) {
      return { rows: scenario.txSelectRows, rowCount: scenario.txSelectRows.length };
    }
    if (text.startsWith('INSERT INTO idempotency_keys')) {
      return { rows: [], rowCount: scenario.claimRowCount };
    }
    throw new Error(`fake: unexpected client query: ${text.slice(0, 80)}`);
  });
  const poolQuery = vi.fn(async (text: string) => {
    if (text.includes('FROM idempotency_keys')) {
      if (scenario.consultRows === 'throw') throw new Error('consult-failed');
      const rows = (scenario.consultRows as Array<{ payload_hash: string; response: unknown }>).filter(Boolean);
      return { rows, rowCount: rows.length };
    }
    throw new Error(`fake: unexpected pool query: ${text.slice(0, 80)}`);
  });
  const pool = {
    connect: vi.fn(async () => ({ query: clientQuery, release: vi.fn() })),
    query: poolQuery,
  };
  return { pool: pool as never, mutate };
};

const run = (
  fake: ReturnType<typeof makeFake>,
  overrides: { mutate?: (client: PoolClient) => Promise<never>; payload?: unknown } = {},
) =>
  runKeyedAccountMutation({
    pool: fake.pool,
    householdId: H,
    idempotencyKey: KEY,
    payload: overrides.payload ?? PAYLOAD,
    mutate: (overrides.mutate ?? fake.mutate) as never,
  });

// O hash real é calculado pelo runner; linhas fake usam o hash V2 real do
// PAYLOAD para simular match (hash desconhecido → mismatch → conflict).

const rowFor = (response: unknown, payload: unknown = PAYLOAD) => ({
  payload_hash: hashPayloadV2(payload),
  response,
});

describe('round3 MEDIUM: envelope account estrutural (fake pool)', () => {
  it('claim-race com JSON inválido → idempotency.conflict (nunca SyntaxError)', async () => {
    const fake = makeFake({
      txSelectRows: [],
      claimRowCount: 0,
      consultRows: [rowFor('{"account": {broken json')],
    });
    // mutate de sucesso: perde a corrida no INSERT (rowCount 0).
    const winner = validAccount();
    const okMutate = async () => winner as never;
    await expect(run(fake, { mutate: okMutate })).rejects.toMatchObject({ code: 'idempotency.conflict' });
  });

  it('hit path com JSON inválido → conflict e producer nunca roda', async () => {
    const fake = makeFake({
      txSelectRows: [rowFor('not-json-at-all{{{')],
      claimRowCount: 1,
      consultRows: [],
    });
    await expect(run(fake)).rejects.toMatchObject({ code: 'idempotency.conflict' });
    expect(fake.mutate).not.toHaveBeenCalled();
  });

  it.each([
    ['response null', null],
    ['envelope sem account', {}],
    ['account null', { account: null }],
    ['sem id', { account: validAccount({ id: undefined }) }],
    ['id não-uuid', { account: validAccount({ id: 'abc' }) }],
    ['outro household', { account: validAccount({ householdId: OTHER_H }) }],
    ['nome vazio', { account: validAccount({ name: '   ' }) }],
    ['kind inválido', { account: validAccount({ kind: 'crypto' }) }],
    ['balance fracionado', { account: validAccount({ balanceCents: 1.5 }) }],
    ['status inválido', { account: validAccount({ status: 'ghost' }) }],
  ])('own-error com %s conserva o erro original', async (_label, response) => {
    const fake = makeFake({ txSelectRows: [], claimRowCount: 1, consultRows: [rowFor(response)] });
    await expect(run(fake)).rejects.toThrow('boom-original');
  });

  it('own-error com consult que falha conserva o erro original', async () => {
    const fake = makeFake({ txSelectRows: [], claimRowCount: 1, consultRows: 'throw' });
    await expect(run(fake)).rejects.toThrow('boom-original');
  });

  it('own-error com payload divergente → conflict (não o erro original)', async () => {
    const fake = makeFake({
      txSelectRows: [],
      claimRowCount: 1,
      consultRows: [{ payload_hash: 'deadbeef', response: JSON.stringify({ account: validAccount() }) }],
    });
    await expect(run(fake)).rejects.toMatchObject({ code: 'idempotency.conflict' });
  });

  it('own-error com envelope válido → replay do vencedor', async () => {
    const winner = validAccount();
    const fake = makeFake({
      txSelectRows: [],
      claimRowCount: 1,
      consultRows: [rowFor({ account: winner })],
    });
    const replayed = await run(fake);
    expect(replayed.id).toBe(winner.id);
    expect(replayed.name).toBe('Conta');
  });

  it('hit path com envelope válido → replay sem rodar producer', async () => {
    const winner = validAccount();
    const fake = makeFake({
      txSelectRows: [rowFor({ account: winner })],
      claimRowCount: 1,
      consultRows: [],
    });
    const replayed = await run(fake);
    expect(replayed.id).toBe(winner.id);
    expect(fake.mutate).not.toHaveBeenCalled();
  });

  it('hit path com household divergente → conflict (fail-closed)', async () => {
    const fake = makeFake({
      txSelectRows: [rowFor({ account: validAccount({ householdId: OTHER_H }) })],
      claimRowCount: 1,
      consultRows: [],
    });
    await expect(run(fake)).rejects.toMatchObject({ code: 'idempotency.conflict' });
    expect(fake.mutate).not.toHaveBeenCalled();
  });
});
