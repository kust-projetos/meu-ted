/**
 * A08 / R08 — FIX 4 (tester #1): o reader de PRODUÇÃO precisa estar escopado.
 *
 * Sem escopo, `isOutOfScope` nunca compara nada: uma linha que reporta outro
 * workspace passaria como utilizável, seria resolvida e ainda nomeada ao
 * usuário. A equivalência que autoriza ligar o escopo é provável em código —
 * `input.workspaceId` é literalmente o valor que viaja no claim `workspace` do
 * token delegado (`finance-chat-agent.ts` → `delegated-token.ts`), que a API
 * transforma em `ctx.householdId` (`routes/index.ts`: `householdId: claims.workspace`)
 * e usa como filtro SQL (`WHERE household_id = $1`), devolvendo a MESMA coluna
 * na linha. Logo `row.householdId === input.workspaceId` por construção.
 */
import { describe, expect, it } from 'vitest';
import { FinanceChatAgent } from '../../src/finance-chat-agent.js';
import { createRequestEntityReader, resolveMutationEntities, type EntityReader, type EntitySummary } from '../../src/mutations/entity-resolver.js';

const SCOPE = 'workspace-authenticated';
const FOREIGN = 'workspace-other';
const ACCOUNT = '00000000-0000-4000-8000-000000000001';

type AgentInternals = {
  entityReaderForTurn: (input: unknown) => Promise<EntityReader>;
  mintReadToken: (input: unknown) => Promise<string | undefined>;
};

/** Raw API row shape (what `GET /accounts` actually returns). */
type RawRow = { id: string; name: string; householdId: string };

const rows = (...items: RawRow[]): EntitySummary[] =>
  items as unknown as EntitySummary[];

const agentWithEnv = (env: Record<string, string>) => {
  const agent = Object.create(FinanceChatAgent.prototype) as FinanceChatAgent;
  Object.defineProperty(agent, 'env', { value: env, writable: true, configurable: true });
  return agent as unknown as AgentInternals;
};

const turnInput = { intentionId: 'intent-scope', actorId: 'actor', workspaceId: SCOPE, role: 'member' as const, text: 'Gastei R$ 50 no mercado', channel: 'pwa-rest' as const };

describe('A08 entity reader scope wiring in production (R08)', () => {
  it('RED: o reader de produção nasce escopado no workspace do turno (o leitor sem escopo é o contraexemplo)', async () => {
    const agent = agentWithEnv({ API_ORIGIN: 'https://api.test.local', AGENT_DELEGATION_SECRET: 'scope-test-secret' });
    // O contraexemplo: um reader SEM escopo aceita a linha estrangeira.
    const unscoped = createRequestEntityReader(async () => ({ items: [{ id: ACCOUNT, name: 'Nubank PJ', householdId: FOREIGN }] }));
    expect(unscoped.scope).toBeUndefined();
    const foreignRow = rows({ id: ACCOUNT, name: 'Nubank PJ', householdId: FOREIGN });
    const unscopedResult = await resolveMutationEntities(
      { kind: 'expense', amountCents: 5000, description: 'carne', date: '2026-09-14', categoryQuery: 'carne' },
      'gastei 50 de carne no Nubank PJ categoria carne',
      { ...unscoped, listAccounts: async () => foreignRow, listCategories: async () => rows({ id: '00000000-0000-4000-8000-000000000014', name: 'Carne', householdId: SCOPE }) },
    );
    // Sem escopo, a linha estrangeira vira a conta resolvida — o defeito.
    expect(unscopedResult.complete).toBe(true);

    // O reader REAL de produção deve carregar o escopo do turno.
    const reader = await agent.entityReaderForTurn(turnInput);
    expect(reader.scope?.workspaceId).toBe(SCOPE);
  });

  it('RED: com o reader de produção escopado, a linha estrangeira é rejeitada e a legítima resolve', async () => {
    const agent = agentWithEnv({ API_ORIGIN: 'https://api.test.local', AGENT_DELEGATION_SECRET: 'scope-test-secret' });
    const reader = await agent.entityReaderForTurn(turnInput);
    const scoped = {
      ...reader,
      listAccounts: async () => rows(
        { id: ACCOUNT, name: 'Nubank PJ', householdId: FOREIGN },
        { id: '00000000-0000-4000-8000-000000000002', name: 'Itaú', householdId: SCOPE },
      ),
      listCategories: async () => rows({ id: '00000000-0000-4000-8000-000000000014', name: 'Carne', householdId: SCOPE }),
    };
    const result = await resolveMutationEntities(
      { kind: 'expense', amountCents: 5000, description: 'carne', date: '2026-09-14', categoryQuery: 'carne' },
      'gastei 50 de carne no Nubank PJ categoria carne',
      scoped,
      { confirmed: { accountId: ACCOUNT } },
    );
    // A linha do outro workspace nunca é resolvida NEM nomeada ao usuário.
    expect(result.trace.account.homonyms).not.toContain('Nubank PJ');
    expect(result.complete).toBe(true);
    if (result.complete) expect(result.accountId).not.toBe(ACCOUNT);
  });

  it('o escopo do reader é exatamente o claim workspace do token delegado', async () => {
    const agent = agentWithEnv({ API_ORIGIN: 'https://api.test.local', AGENT_DELEGATION_SECRET: 'scope-test-secret' });
    const reader = await agent.entityReaderForTurn(turnInput);
    // A equivalência usada para ligar o escopo: o reader carrega o MESMO
    // `workspaceId` que o token leva como claim `workspace`.
    expect(reader.scope?.workspaceId).toBe(turnInput.workspaceId);
    const token = await agent.mintReadToken(turnInput);
    expect(token).toBeTruthy();
  });

  it('sem token de delegação o reader continua escopado e não lança (escopo não depende do segredo)', async () => {
    const agent = agentWithEnv({ API_ORIGIN: 'https://api.test.local' });
    const reader = await agent.entityReaderForTurn(turnInput);
    // O escopo defensivo vem do workspace do turno, não da capacidade de
    // mintar token: sem segredo a autoridade real some, a checagem local
    // continua ativa e a construção do reader nunca lança.
    expect(reader.scope?.workspaceId).toBe(SCOPE);
    expect(typeof reader.listAccounts).toBe('function');
    expect(typeof reader.listCategories).toBe('function');
  });
});