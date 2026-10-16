import { describe, expect, it } from 'vitest';
import { createAccountInTx } from '../../src/writes/postgres.js';

const WS_ID = '11111111-1111-4111-8111-111111111111';

/**
 * FIX-WS-D2-R2 item 2 (HIGH writers): TODOS os writers verificam o
 * lifecycle active DENTRO da transação do efeito. Estes testes exercem o
 * núcleo canônico (createAccountInTx); a integração em PG descartável
 * prova delete-vs-create e archive-vs-create reais e concorrentes.
 */
describe('FIX-WS-D2-R2 item 2 — guarda de lifecycle nos writers', () => {
  const fakeClient = (householdStatus: string | null, seen: string[]) => ({
    query: async (text: string) => {
      seen.push(text);
      if (text.includes('FROM households')) {
        if (householdStatus === null) return { rows: [], rowCount: 0 };
        return { rows: [{ status: householdStatus }], rowCount: 1 };
      }
      if (text.includes('INSERT INTO accounts')) {
        return {
          rows: [
            {
              id: 'acc-1',
              household_id: WS_ID,
              name: 'Conta',
              kind: 'bank',
              balance_cents: 0,
              status: 'active',
            },
          ],
          rowCount: 1,
        };
      }
      if (text.includes('FROM categories')) {
        return { rows: [{ id: 'cat-1' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  });

  it('workspace active: guarda consulta o lifecycle com lock e o efeito prossegue', async () => {
    const seen: string[] = [];
    const account = await createAccountInTx(
      fakeClient('active', seen) as never,
      WS_ID,
      { name: 'Conta', kind: 'bank', initialBalanceCents: 0 },
    );
    expect(account.id).toBe('acc-1');
    const guard = seen.find((sql) => sql.includes('FROM households'));
    expect(guard).toBeDefined();
    // Lock compartilhado: serializa contra o delete (FOR UPDATE) sem
    // serializar writers concorrentes entre si.
    expect(guard).toMatch(/FOR SHARE/);
    // A guarda roda ANTES do efeito.
    expect(seen.indexOf(guard!)).toBeLessThan(
      seen.findIndex((sql) => sql.includes('INSERT INTO accounts')),
    );
  });

  it('workspace archived: create recusa 403 sem efeito', async () => {
    const seen: string[] = [];
    await expect(
      createAccountInTx(fakeClient('archived', seen) as never, WS_ID, {
        name: 'Conta',
        kind: 'bank',
        initialBalanceCents: 0,
      }),
    ).rejects.toMatchObject({ code: 'workspace.archived', statusCode: 403 });
    expect(seen.some((sql) => sql.includes('INSERT INTO accounts'))).toBe(false);
  });

  it('workspace deleted: create recusa 410 sem efeito', async () => {
    const seen: string[] = [];
    await expect(
      createAccountInTx(fakeClient('deleted', seen) as never, WS_ID, {
        name: 'Conta',
        kind: 'bank',
        initialBalanceCents: 0,
      }),
    ).rejects.toMatchObject({ code: 'workspace.deleted', statusCode: 410 });
    expect(seen.some((sql) => sql.includes('INSERT INTO accounts'))).toBe(false);
  });
});
