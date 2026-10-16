import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { createPostgresCardStore } from '../../src/cards/postgres.js';
import { createPostgresGoalStore } from '../../src/goals/postgres.js';
import { createPostgresPayableStore } from '../../src/payables/postgres.js';

type Handler = (text: string, values?: unknown[]) => unknown;

const mockPool = (handlers: Record<string, Handler>, seen: string[] = []) => {
  const route = async (text: string, values?: unknown[]) => {
    seen.push(text);
    for (const [needle, handler] of Object.entries(handlers)) {
      if (text.includes(needle)) return handler(text, values) as never;
    }
    return { rows: [], rowCount: 0 };
  };
  const client = { query: route, release: () => undefined };
  return {
    query: route,
    connect: async () => client,
  } as unknown as Pool;
};

const WS_ID = '22222222-2222-4222-8222-222222222222';

const activeHousehold = () => ({
  rows: [{ status: 'active' }],
  rowCount: 1,
});

const orderOf = (seen: string[], needle: string): number =>
  seen.findIndex((sql) => sql.includes(needle));

/**
 * FIX-WS-D2-R3 item 2 (HIGH writers sem lock): guarda FOR SHARE + efeito
 * na MESMA transação/cliente em todos os caminhos. RED first: os quatro
 * caminhos fazem check-then-act fora de transação (sem BEGIN, sem FOR
 * SHARE) — a ordem guarda→efeito sob um único BEGIN/COMMIT falha aqui.
 */
describe('D2 — writers sob guarda transacional (FIX-WS-D2-R3 item 2)', () => {
  it('createCard: FOR SHARE + INSERT na mesma transação (BEGIN < guarda < efeito < COMMIT)', async () => {
    const seen: string[] = [];
    const pool = mockPool(
      {
        'FROM households': () => activeHousehold(),
        'INSERT INTO accounts': () => ({
          rows: [{
            id: 'card-1',
            household_id: WS_ID,
            name: 'Cartão',
            kind: 'credit_card',
            balance_cents: 0,
            status: 'active',
            credit_limit_cents: 10000,
            closing_day: 10,
            due_day: 20,
          }],
          rowCount: 1,
        }),
      },
      seen,
    );
    const card = await createPostgresCardStore(pool).createCard(WS_ID, {
      name: 'Cartão',
      creditLimitCents: 10000,
      closingDay: 10,
      dueDay: 20,
    });
    expect(card.householdId).toBe(WS_ID);
    const begin = orderOf(seen, 'BEGIN');
    const guard = orderOf(seen, 'FOR SHARE');
    const effect = orderOf(seen, 'INSERT INTO accounts');
    const commit = orderOf(seen, 'COMMIT');
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(guard).toBeGreaterThan(begin);
    expect(effect).toBeGreaterThan(guard);
    expect(commit).toBeGreaterThan(effect);
  });

  it('cancelGoal: FOR SHARE + UPDATE na mesma transação', async () => {
    const seen: string[] = [];
    const goalRow = {
      id: 'goal-1',
      household_id: WS_ID,
      name: 'Meta',
      goal_type: 'savings',
      target_amount_cents: 1000,
      current_amount_cents: 100,
      start_date: new Date('2026-01-01'),
    };
    const pool = mockPool(
      {
        'FROM households': () => activeHousehold(),
        'FROM goals': () => ({ rows: [goalRow], rowCount: 1 }),
        'UPDATE goals': () => ({ rows: [], rowCount: 1 }),
      },
      seen,
    );
    const cancelled = await createPostgresGoalStore(pool).cancelGoal(WS_ID, 'goal-1');
    expect(cancelled.status).toBe('cancelled');
    const begin = orderOf(seen, 'BEGIN');
    const guard = orderOf(seen, 'FOR SHARE');
    const effect = orderOf(seen, 'UPDATE goals');
    const commit = orderOf(seen, 'COMMIT');
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(guard).toBeGreaterThan(begin);
    expect(effect).toBeGreaterThan(guard);
    expect(commit).toBeGreaterThan(effect);
  });

  it('cancelPayable: FOR SHARE + UPDATE na mesma transação', async () => {
    const seen: string[] = [];
    const payableRow = {
      id: 'pay-1',
      household_id: WS_ID,
      account_id: 'acc-1',
      description: 'Conta',
      amount_cents: 5000,
      due_date: new Date('2026-02-01'),
      type: 'service',
      status: 'pending',
    };
    let selects = 0;
    const pool = mockPool(
      {
        'FROM households': () => activeHousehold(),
        // Pré-UPDATE: pendente; releitura pós-UPDATE: cancelada.
        'FROM accounts_payable': () => {
          selects += 1;
          return {
            rows: [{ ...payableRow, status: selects === 1 ? 'pending' : 'cancelled' }],
            rowCount: 1,
          };
        },
        'UPDATE accounts_payable': () => ({ rows: [], rowCount: 1 }),
      },
      seen,
    );
    const cancelled = await createPostgresPayableStore(pool).cancelPayable(WS_ID, 'pay-1');
    expect(cancelled.status).toBe('cancelled');
    const begin = orderOf(seen, 'BEGIN');
    const guard = orderOf(seen, 'FOR SHARE');
    const effect = orderOf(seen, 'UPDATE accounts_payable');
    const commit = orderOf(seen, 'COMMIT');
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(guard).toBeGreaterThan(begin);
    expect(effect).toBeGreaterThan(guard);
    expect(commit).toBeGreaterThan(effect);
  });

  it('configureNotification: FOR SHARE + INSERT na mesma transação', async () => {
    const seen: string[] = [];
    const notifRow = {
      id: 'notif-1',
      household_id: WS_ID,
      chat_id: 'chat-1',
      notification_type: 'due_reminder',
      enabled: true,
      days_of_week: [1, 2, 3, 4, 5],
    };
    const pool = mockPool(
      {
        'FROM households': () => activeHousehold(),
        'AND chat_id = $2': () => ({ rows: [], rowCount: 0 }),
        'INSERT INTO notification_configs': () => ({ rows: [], rowCount: 1 }),
        'WHERE id = $1': () => ({ rows: [notifRow], rowCount: 1 }),
      },
      seen,
    );
    const configured = await createPostgresPayableStore(pool).configureNotification(WS_ID, {
      chatId: 'chat-1',
      notificationType: 'due_reminder',
      enabled: true,
    });
    expect(configured.chatId).toBe('chat-1');
    const begin = orderOf(seen, 'BEGIN');
    const guard = orderOf(seen, 'FOR SHARE');
    const effect = orderOf(seen, 'INSERT INTO notification_configs');
    const commit = orderOf(seen, 'COMMIT');
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(guard).toBeGreaterThan(begin);
    expect(effect).toBeGreaterThan(guard);
    expect(commit).toBeGreaterThan(effect);
  });
});
