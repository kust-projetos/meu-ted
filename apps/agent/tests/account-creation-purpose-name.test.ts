/**
 * account-creation-purpose-name — RED tests for the purpose-as-name bug:
 * "Crie uma conta para pagar o aluguel" extracted name "pagar o aluguel"
 * (the purpose clause survived stripping because only "para" is a filler
 * word). A purpose is never a name: the turn must ask for the name instead,
 * while explicit names, balances and kinds keep working and a confirmation
 * never proposes without a name.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  accountMissingFields,
  accountQuestion,
  extractAccountName,
  isConfirmCreateText,
  parseAccountCreation,
} from '../src/mutations/account-creation.js';
import {
  ConversationOrchestrator,
  normalizeRestTurn,
  type AuthenticatedIdentity,
} from '../src/orchestration/conversation-orchestrator.js';
import { MutationApiClient } from '../src/mutations/mutation-api-client.js';
import { InMemoryMutationDraftStore } from '../src/mutations/mutation-draft.js';

describe('account-creation-purpose-name: purpose is never a name', () => {
  it('(1) RED-core: "Crie uma conta para pagar o aluguel" yields no name', () => {
    expect(extractAccountName('Crie uma conta para pagar o aluguel')).toBeUndefined();
  });

  it('(2) "pra" variant yields no name either', () => {
    expect(extractAccountName('Cria uma conta pra pagar o aluguel')).toBeUndefined();
  });

  it('(3) fresh parse still signals creation but misses the name and asks for it', () => {
    const parsed = parseAccountCreation('Crie uma conta para pagar o aluguel');
    expect(parsed.isCreation).toBe(true);
    expect(parsed.name).toBeUndefined();
    const missing = accountMissingFields({
      ...(parsed.name ? { name: parsed.name } : {}),
      ...(parsed.accountKind ? { accountKind: parsed.accountKind } : {}),
      ...(parsed.initialBalanceCents !== undefined
        ? { initialBalanceCents: parsed.initialBalanceCents }
        : {}),
    });
    expect(missing).toContain('name');
    expect(accountQuestion(missing, parsed.name)).toBe(
      'Vamos criar a conta. Me diga o nome da conta e o saldo inicial (por exemplo: "Nubank, saldo 145").',
    );
  });

  it('(4) balance fills without the bad name: saldo 500 kept, name asked, no silent proposal', () => {
    const parsed = parseAccountCreation('Crie uma conta para pagar o aluguel com saldo 500');
    expect(parsed.name).toBeUndefined();
    expect(parsed.initialBalanceCents).toBe(50000);
    expect(parsed.balanceExplicit).toBe(true);
    const missing = accountMissingFields({
      ...(parsed.name ? { name: parsed.name } : {}),
      ...(parsed.accountKind ? { accountKind: parsed.accountKind } : {}),
      ...(parsed.initialBalanceCents !== undefined
        ? { initialBalanceCents: parsed.initialBalanceCents }
        : {}),
    });
    expect(missing).toContain('name');
    expect(missing.length).toBeGreaterThan(0);
  });

  it('(5) kind fills without the bad name: "do tipo bank" kept, name still asked', () => {
    const parsed = parseAccountCreation(
      'Crie uma conta para pagar o aluguel do tipo bank com saldo 500',
    );
    expect(parsed.name).toBeUndefined();
    expect(parsed.accountKind).toBe('bank');
    expect(parsed.initialBalanceCents).toBe(50000);
    const missing = accountMissingFields({
      ...(parsed.name ? { name: parsed.name } : {}),
      ...(parsed.accountKind ? { accountKind: parsed.accountKind } : {}),
      ...(parsed.initialBalanceCents !== undefined
        ? { initialBalanceCents: parsed.initialBalanceCents }
        : {}),
    });
    expect(missing).toEqual(['name']);
    expect(accountQuestion(missing, parsed.name)).toBe('Qual o nome da conta?');
  });

  it('(6) confirmation never carries a name: "pode criar" proposes nothing', () => {
    expect(isConfirmCreateText('pode criar')).toBe(true);
    expect(extractAccountName('pode criar')).toBeUndefined();
  });
});

describe('account-creation-purpose-name: legitimate names preserved', () => {
  it('(7) name before the purpose is AMBIGUOUS: never truncate to "Reserva", ask instead', () => {
    expect(extractAccountName('Crie uma conta Reserva para pagar o aluguel')).toBeUndefined();
    const parsed = parseAccountCreation('Crie uma conta Reserva para pagar o aluguel');
    expect(parsed.name).toBeUndefined();
    const missing = accountMissingFields({
      ...(parsed.accountKind ? { accountKind: parsed.accountKind } : {}),
      ...(parsed.initialBalanceCents !== undefined
        ? { initialBalanceCents: parsed.initialBalanceCents }
        : {}),
    });
    expect(missing).toContain('name');
  });

  it('(8) plain explicit names still work: Nubank / Banco do Brasil / Reserva 3', () => {
    expect(extractAccountName('criar conta Nubank com saldo 145')).toBe('Nubank');
    expect(extractAccountName('criar conta Banco do Brasil com saldo 100')).toBe('Banco do Brasil');
    expect(extractAccountName('criar conta Reserva 3 com saldo 100')).toBe('Reserva 3');
  });

  it('(9) quoted purpose-like text is an explicit name and wins', () => {
    const parsed = parseAccountCreation('criar conta "pagar o aluguel" com saldo 100');
    expect(parsed.name).toBe('pagar o aluguel');
    expect(parsed.initialBalanceCents).toBe(10000);
  });

  it('(10) "chamada" purpose-like text is an explicit name and wins', () => {
    const parsed = parseAccountCreation('crie conta chamada pagar o aluguel com saldo 100');
    expect(parsed.name).toBe('pagar o aluguel');
    expect(parsed.initialBalanceCents).toBe(10000);
  });
});

describe('account-creation-purpose-name: reviewer — never truncate para/pra names', () => {
  it('(11) RED-reviewer: "Crie uma conta Cofre para Viagens" yields NO name (never "Cofre")', () => {
    expect(extractAccountName('Crie uma conta Cofre para Viagens')).toBeUndefined();
    const parsed = parseAccountCreation('Crie uma conta Cofre para Viagens');
    expect(parsed.isCreation).toBe(true);
    expect(parsed.name).toBeUndefined();
    const missing = accountMissingFields({
      ...(parsed.accountKind ? { accountKind: parsed.accountKind } : {}),
      ...(parsed.initialBalanceCents !== undefined
        ? { initialBalanceCents: parsed.initialBalanceCents }
        : {}),
    });
    expect(missing).toContain('name');
    expect(accountQuestion(missing, parsed.name)).toMatch(/nome/i);
  });

  it('(12) "pra" variant with a name-like head is also ambiguous: ask, never truncate', () => {
    expect(extractAccountName('Cria uma conta Cofre pra Viagens')).toBeUndefined();
  });

  it('(13) quoted "Cofre para Viagens" is explicit and survives intact', () => {
    const parsed = parseAccountCreation('criar conta "Cofre para Viagens" com saldo 100');
    expect(parsed.name).toBe('Cofre para Viagens');
    expect(parsed.initialBalanceCents).toBe(10000);
  });
});

describe('account-creation-purpose-name: reviewer round 2 — kind/balance before para', () => {
  it('(16) "Crie uma conta corrente para pagar o aluguel": kind fills, name NEVER fills', () => {
    const parsed = parseAccountCreation('Crie uma conta corrente para pagar o aluguel');
    expect(parsed.isCreation).toBe(true);
    expect(parsed.name).toBeUndefined();
    expect(parsed.accountKind).toBe('bank');
  });

  it('(17) "Crie uma conta com saldo 500 para pagar o aluguel": balance fills, name NEVER fills', () => {
    const parsed = parseAccountCreation('Crie uma conta com saldo 500 para pagar o aluguel');
    expect(parsed.name).toBeUndefined();
    expect(parsed.initialBalanceCents).toBe(50000);
    expect(parsed.balanceExplicit).toBe(true);
  });

  it('(18) "Crie uma conta do tipo bank para pagar o aluguel": kind fills, name NEVER fills', () => {
    const parsed = parseAccountCreation('Crie uma conta do tipo bank para pagar o aluguel');
    expect(parsed.name).toBeUndefined();
    expect(parsed.accountKind).toBe('bank');
  });

  it('(19) saldo+kindo before para: both fill, name stays missing so nothing proposes', () => {
    const parsed = parseAccountCreation('Crie uma conta com saldo 500 do tipo bank para pagar o aluguel');
    expect(parsed.name).toBeUndefined();
    expect(parsed.initialBalanceCents).toBe(50000);
    expect(parsed.accountKind).toBe('bank');
    const missing = accountMissingFields({
      ...(parsed.accountKind ? { accountKind: parsed.accountKind } : {}),
      ...(parsed.initialBalanceCents !== undefined
        ? { initialBalanceCents: parsed.initialBalanceCents }
        : {}),
    });
    expect(missing).toEqual(['name']);
  });

  it('(20) explicit quoted kind-word survives a trailing purpose: "Conta Corrente"', () => {
    const parsed = parseAccountCreation('criar conta "Conta Corrente" para pagar o aluguel');
    expect(parsed.name).toBe('Conta Corrente');
  });

  it('(21) follow-up WITHOUT the conta noun still never names the purpose', () => {
    expect(extractAccountName('corrente para pagar o aluguel')).toBeUndefined();
  });

  it('(22) follow-up "Nubank para pagar o aluguel" is ambiguous: ask, never keep "Nubank"', () => {
    expect(extractAccountName('Nubank para pagar o aluguel')).toBeUndefined();
  });
});

describe('account-creation-purpose-name: integration — nameless draft + confirmation never proposes', () => {
  const identity: AuthenticatedIdentity = {
    actorId: 'actor-purpose',
    workspaceId: 'workspace-purpose',
    role: 'member',
    deviceId: 'device-purpose',
  };
  const ctx = { workspaceId: identity.workspaceId, actorId: identity.actorId, deviceId: identity.deviceId ?? null };

  const harness = (nowMs: number) => {
    let now = nowMs;
    const store = new InMemoryMutationDraftStore();
    const calls: Array<{ method: string; path: string; options: unknown }> = [];
    const request = vi.fn().mockImplementation(async (method: string, path: string, options: unknown) => {
      calls.push({ method, path, options });
      if (method === 'POST' && path === '/pending-operations/v2/propose') {
        const body = (options as { body?: Record<string, unknown> }).body ?? {};
        return {
          id: 'op-purpose-1',
          existing: false,
          summary: body.summary ?? 'Conta',
          operation: { id: 'op-purpose-1', expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() },
        };
      }
      if (method === 'GET' && path === '/pending-operations/v2/active') return { items: [], total: 0 };
      throw new Error(`unexpected ${method} ${path}`);
    });
    const orchestrator = new ConversationOrchestrator({
      mutationApiClient: new MutationApiClient({ request }),
      entityReader: { listAccounts: async () => [], listCategories: async () => [] },
      draftStore: store,
      draftNow: () => now,
      responseProvider: vi.fn(async () => 'invented by model'),
      evidenceProvider: vi.fn(async () => ({
        version: '1' as const,
        items: [
          {
            ref: 'test',
            source: 'api.test',
            retrievedAt: new Date().toISOString(),
            status: 'empty' as const,
            data: [],
            reason: 'setup_incomplete' as const,
          },
        ],
      })) as never,
      events: () => undefined,
    });
    return { store, request, calls, orchestrator };
  };

  const T0 = Date.parse('2026-10-21T12:00:00Z');

  it('(14) fresh "Crie uma conta para pagar o aluguel" opens a NAMELESS draft and asks, never proposes', async () => {
    const h = harness(T0);
    const r = await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'Crie uma conta para pagar o aluguel', intentionId: 'purpose-t1' }, identity),
    );
    expect(h.request).not.toHaveBeenCalled();
    const actives = h.store.listActive(ctx, T0 + 1000);
    expect(actives).toHaveLength(1);
    expect(actives[0]!.tool).toBe('accounts.create');
    expect(actives[0]!.resolvedArgs.accountName).toBeUndefined();
    expect(actives[0]!.missingFields).toContain('name');
    expect(r.response?.text).toMatch(/nome/i);
    expect(r.mutation).toBeUndefined();
  });

  it('(15) "pode criar" on the nameless draft still proposes NOTHING and re-asks the name', async () => {
    const h = harness(T0);
    await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'Crie uma conta para pagar o aluguel', intentionId: 'purpose-c-t1' }, identity),
    );
    const r = await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'pode criar', intentionId: 'purpose-c-t2' }, identity),
    );
    expect(h.calls.filter((c) => c.path === '/pending-operations/v2/propose')).toHaveLength(0);
    expect(r.mutation).toBeUndefined();
    const actives = h.store.listActive(ctx, T0 + 2000);
    expect(actives).toHaveLength(1);
    expect(actives[0]!.resolvedArgs.accountName).toBeUndefined();
    expect(actives[0]!.missingFields).toContain('name');
    expect(r.response?.text).toMatch(/nome/i);
  });

  it('(23) draft "conta corrente para pagar o aluguel": kind bank fills, name asked, nothing proposes', async () => {
    const h = harness(T0);
    const r = await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'Crie uma conta corrente para pagar o aluguel', intentionId: 'purpose-k-t1' }, identity),
    );
    expect(h.request).not.toHaveBeenCalled();
    expect(r.mutation).toBeUndefined();
    const actives = h.store.listActive(ctx, T0 + 1000);
    expect(actives).toHaveLength(1);
    expect(actives[0]!.resolvedArgs.accountName).toBeUndefined();
    expect(actives[0]!.resolvedArgs.accountKind).toBe('bank');
    expect(actives[0]!.missingFields).toContain('name');
    expect(r.response?.text).toMatch(/nome/i);
  });

  it('(24) draft "com saldo 500 para pagar o aluguel": balance fills, name asked, nothing proposes', async () => {
    const h = harness(T0);
    const r = await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'Crie uma conta com saldo 500 para pagar o aluguel', intentionId: 'purpose-b-t1' }, identity),
    );
    expect(h.request).not.toHaveBeenCalled();
    expect(r.mutation).toBeUndefined();
    const actives = h.store.listActive(ctx, T0 + 1000);
    expect(actives).toHaveLength(1);
    expect(actives[0]!.resolvedArgs.accountName).toBeUndefined();
    expect(actives[0]!.resolvedArgs.initialBalanceCents).toBe(50000);
    expect(actives[0]!.missingFields).toContain('name');
    expect(r.response?.text).toMatch(/nome/i);
  });

  it('(25) turno1 nameless → turno2 "corrente para pagar o aluguel": name stays missing, kind fills, zero propose', async () => {
    const h = harness(T0);
    await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'Crie uma conta para pagar o aluguel', intentionId: 'purpose-f-t1' }, identity),
    );
    const r = await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'corrente para pagar o aluguel', intentionId: 'purpose-f-t2' }, identity),
    );
    // Draft asserts: still nameless; the legitimate kind marker fills bank.
    const actives = h.store.listActive(ctx, T0 + 2000);
    expect(actives).toHaveLength(1);
    expect(actives[0]!.tool).toBe('accounts.create');
    expect(actives[0]!.resolvedArgs.accountName).toBeUndefined();
    expect(actives[0]!.resolvedArgs.accountKind).toBe('bank');
    expect(actives[0]!.missingFields).toContain('name');
    // Call asserts: no transport call at all, no mutation, name re-asked.
    expect(h.request).not.toHaveBeenCalled();
    expect(h.calls.filter((c) => c.path === '/pending-operations/v2/propose')).toHaveLength(0);
    expect(r.mutation).toBeUndefined();
    expect(r.response?.text).toMatch(/nome/i);
  });

  it('(26) turno1 one-slot-missing → turno2 "Nubank para pagar o aluguel": still nameless, zero propose', async () => {
    const h = harness(T0);
    await h.orchestrator.runTurn(
      normalizeRestTurn(
        { text: 'Crie uma conta com saldo 500 do tipo bank para pagar o aluguel', intentionId: 'purpose-g-t1' },
        identity,
      ),
    );
    const before = h.store.listActive(ctx, T0 + 1000);
    expect(before).toHaveLength(1);
    expect([...before[0]!.missingFields]).toEqual(['name']);
    const r = await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'Nubank para pagar o aluguel', intentionId: 'purpose-g-t2' }, identity),
    );
    // Draft asserts: the ambiguous follow-up contributes no name.
    const actives = h.store.listActive(ctx, T0 + 2000);
    expect(actives).toHaveLength(1);
    expect(actives[0]!.resolvedArgs.accountName).toBeUndefined();
    expect(actives[0]!.resolvedArgs.initialBalanceCents).toBe(50000);
    expect(actives[0]!.resolvedArgs.accountKind).toBe('bank');
    expect(actives[0]!.missingFields).toContain('name');
    // Call asserts: nothing proposed despite a single missing slot.
    expect(h.calls.filter((c) => c.path === '/pending-operations/v2/propose')).toHaveLength(0);
    expect(r.mutation).toBeUndefined();
    expect(r.response?.text).toMatch(/nome/i);
  });
});
