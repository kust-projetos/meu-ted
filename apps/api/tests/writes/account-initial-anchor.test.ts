/**
 * Account initial-balance anchor (V058) — canonical writer contract.
 *
 * RED-first: createAccountInTx INSERTs balance_cents but omits
 * initial_balance_cents, so the PG DEFAULT 0 anchors every nonzero
 * opening balance at zero and reconciliation reports false drift.
 * Expected: a single INSERT in the same tx persists
 * balance_cents == initial_balance_cents == input.initialBalanceCents
 * for bank/cash (positive / zero / negative); credit_card keeps the
 * current contract (negative rejected); updateAccount never rewrites
 * the anchor.
 *
 * Fake-pool unit test (no live PG): the fake simulates the PG column
 * DEFAULT 0 when the INSERT omits the anchor, and records the exact
 * SQL so the test captures the real writer contract, not a mirror.
 */
import { describe, expect, it, vi } from 'vitest';
import { createPostgresWriteStore } from '../../src/writes/postgres.js';

const H = '00000000-0000-4000-8000-00000000a1c7';

type Recorded = { text: string; values: unknown[] };

const makeFakePool = () => {
  const recorded: Recorded[] = [];
  const client = {
    query: vi.fn(async (text: string, values: unknown[] = []) => {
      recorded.push({ text, values });
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') {
        return { rows: [], rowCount: 0 };
      }
      if (text.startsWith('INSERT INTO accounts')) {
        // Simulate PG DEFAULT 0 for the anchor when the writer omits it.
        const balance = values[3] as number;
        const anchor = values.length >= 5 ? (values[4] as number) : 0;
        return {
          rows: [{
            id: 'acc-1',
            household_id: values[0],
            name: values[1],
            kind: values[2],
            balance_cents: balance,
            initial_balance_cents: anchor,
            status: 'active',
          }],
          rowCount: 1,
        };
      }
      if (text.includes('FROM categories')) {
        // Pretend a default category already exists → no applyDefaultsInTx.
        return { rows: [{ '1': 1 }], rowCount: 1 };
      }
      if (text.startsWith('SELECT id, household_id, name, kind, balance_cents, status')) {
        return {
          rows: [{
            id: values[0],
            household_id: values[1],
            name: 'A',
            kind: 'bank',
            balance_cents: 1000,
            status: 'active',
          }],
          rowCount: 1,
        };
      }
      if (text.startsWith('UPDATE accounts')) {
        const row = {
          id: values[0],
          household_id: values[1],
          name: 'Renamed',
          kind: 'bank',
          balance_cents: 1000,
          status: 'active',
        };
        return { rows: [row], rowCount: 1 };
      }
      throw new Error(`unexpected query: ${text.slice(0, 80)}`);
    }),
    release: vi.fn(),
  };
  const pool = { connect: vi.fn(async () => client), query: client.query };
  return { pool: pool as never, recorded };
};

const insertFor = (recorded: Recorded[]) =>
  recorded.filter((q) => q.text.startsWith('INSERT INTO accounts'));

describe('account initial-balance anchor (V058, fake pool)', () => {
  it.each([
    { kind: 'bank', initialBalanceCents: 10_000 },
    { kind: 'bank', initialBalanceCents: 0 },
    { kind: 'bank', initialBalanceCents: -50_00 },
    { kind: 'cash', initialBalanceCents: 5_000 },
    { kind: 'cash', initialBalanceCents: -1 },
  ])('persists balance and anchor equally in one INSERT: $kind $initialBalanceCents', async ({ kind, initialBalanceCents }) => {
    const { pool, recorded } = makeFakePool();
    const writes = createPostgresWriteStore({ pool });
    await writes.createAccount(H, { name: 'A', kind: kind as 'bank' | 'cash', initialBalanceCents });

    const inserts = insertFor(recorded);
    expect(inserts).toHaveLength(1);
    const sql = inserts[0]!.text;
    expect(sql).toMatch(/initial_balance_cents/);
    expect(sql).toMatch(/balance_cents/);
    // Same INSERT / same tx: balance value and anchor value both equal input.
    expect(inserts[0]!.values[3]).toBe(initialBalanceCents);
    expect(inserts[0]!.values).toContain(initialBalanceCents);
    const anchorAt = inserts[0]!.values.indexOf(initialBalanceCents, 4);
    expect(anchorAt).toBeGreaterThanOrEqual(4);
    expect(inserts[0]!.values[3]).toBe(inserts[0]!.values[anchorAt]);
  });

  it('credit_card with negative initial balance is still rejected', async () => {
    const { pool, recorded } = makeFakePool();
    const writes = createPostgresWriteStore({ pool });
    await expect(
      writes.createAccount(H, { name: 'Card', kind: 'credit_card' as never, initialBalanceCents: -1 }),
    ).rejects.toMatchObject({ code: 'validation.invalid', statusCode: 400 });
    expect(insertFor(recorded)).toHaveLength(0);
  });

  it('updateAccount never rewrites the anchor', async () => {
    const { pool, recorded } = makeFakePool();
    const writes = createPostgresWriteStore({ pool });
    await writes.updateAccount(H, 'acc-1', { name: 'Renamed' });
    const updates = recorded.filter((q) => q.text.startsWith('UPDATE accounts'));
    expect(updates).toHaveLength(1);
    const setClause = updates[0]!.text.split('RETURNING')[0]!;
    expect(setClause).not.toMatch(/initial_balance_cents/);
    expect(setClause).not.toMatch(/balance_cents\s*=/);
  });
});
