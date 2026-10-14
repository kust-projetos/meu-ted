/**
 * PR137-HARDEN round 4 P1-B — outage total no nível golden (stack real).
 *
 * Pilha 100% produção (`ConversationOrchestrator` + `routeIntent` real +
 * `MutationApiClient`/`PendingOperationCoordinator` reais) contra o backend
 * isolado: o turno 1 de confirmação sofre outage TOTAL das duas gravações
 * locais (sighting + fallback claim-path lançam) com A pendente — 0
 * executes, resposta inconclusiva. A fronteira independente (bind da API,
 * anterior às escritas locais) persistiu X@T_api: após A cancelada, B
 * proposta e store recuperado, o redelivery de X falha fechado pela regra
 * pós-outage (sighting API prévia + sighting local fresca) via vínculo API
 * — nunca confirma B. Uma intenção nova confirma B normalmente.
 */
import { describe, expect, it } from 'vitest';
import {
  ConversationOrchestrator,
  normalizeRestTurn,
} from '../../../src/orchestration/conversation-orchestrator.js';
import { MutationApiClient } from '../../../src/mutations/mutation-api-client.js';
import {
  InMemoryMutationDraftStore,
  type MutationDraftStore,
} from '../../../src/mutations/mutation-draft.js';
import { renderInconclusive } from '../../../src/responses/deterministic-responses.js';
import { IsolatedBackend } from './backend.js';

const IDENTITY = {
  actorId: 'actor-golden',
  workspaceId: 'ws-golden',
  role: 'member' as const,
  deviceId: 'golden-device-1',
};

const INITIAL = {
  accounts: [{ id: '11111111-1111-4111-8111-111111111111', name: 'Conta Corrente' }],
  categories: [{ id: '22222222-2222-4222-8222-222222222222', name: 'Alimentação' }],
};

type CapturedEvent = { type: string; fields: Record<string, unknown> };

const buildOrchestrator = (
  backend: IsolatedBackend,
  store: MutationDraftStore,
  events: CapturedEvent[],
): ConversationOrchestrator =>
  new ConversationOrchestrator({
    mutationApiClient: new MutationApiClient({ request: backend.request as never, events: () => {} }),
    draftStore: store,
    entityReader: backend.entityReader,
    evidenceProvider: backend.evidenceProvider,
    responseProvider: backend.responseProvider,
    forgetMemory: { sql: backend.memorySql },
    events: (type: string, fields: Record<string, unknown>) => {
      events.push({ type, fields });
    },
  });

const blockedReason = (events: CapturedEvent[]): unknown =>
  events.find((event) => event.type === 'mutation.blocked')?.fields['reason'];

describe('PR137-HARDEN round 4 P1-B (golden, stack real): outage total → replay usa o vínculo API', () => {
  it('redelivery pós-recuperação nunca confirma B; intenção nova confirma', async () => {
    const backend = new IsolatedBackend(INITIAL);
    const store = new InMemoryMutationDraftStore();
    const client = new MutationApiClient({ request: backend.request as never, events: () => {} });
    const identity = { workspaceId: 'ws-golden', actorId: 'actor-golden', deviceId: 'golden-device-1' };

    // Proposta A (card exibido ⇒ apresentação registrada).
    const proposed = await buildOrchestrator(backend, store, []).runTurn(
      normalizeRestTurn({ text: 'gastei 50 de carne categoria alimentação', intentionId: 'intent-p1' }, IDENTITY),
    );
    expect(proposed.mutation?.operationId).toBe('golden-op-1');

    // Outage TOTAL das escritas locais no turno de confirmação.
    const downStore = Object.assign(Object.create(Object.getPrototypeOf(store) as object), store, {
      noteConfirmationSighted: () => {
        throw new Error('injected_total_outage');
      },
      claimConfirmation: () => {
        throw new Error('injected_total_outage');
      },
      settleConfirmation: () => {
        throw new Error('injected_total_outage');
      },
    } satisfies Partial<MutationDraftStore>) as MutationDraftStore;
    const events1: CapturedEvent[] = [];
    const first = await buildOrchestrator(backend, downStore, events1).runTurn(
      normalizeRestTurn({ text: 'sim', intentionId: 'intent-x1' }, IDENTITY),
    );
    expect(blockedReason(events1)).toBe('confirmation_marker_unreadable');
    expect(first.mutation).toBeUndefined();
    expect(first.response?.text).toBe(renderInconclusive());
    expect(backend.executionsSucceeded).toBe(0);

    // A cancelada legitimamente; B proposta (card exibido ⇒ apresentada).
    await client.cancel('golden-op-1', identity);
    const proposedB = await buildOrchestrator(backend, store, []).runTurn(
      normalizeRestTurn({ text: 'gastei 30 de pão categoria alimentação', intentionId: 'intent-p2' }, IDENTITY),
    );
    expect(proposedB.mutation?.operationId).toBe('golden-op-2');

    // Store recuperado (o mesmo: apresentações preservadas, zero linhas de X
    // — a outage não persistiu nada). Redelivery de X: o vínculo API (X visto
    // antes) + sighting local fresca ⇒ pós-outage, nunca B.
    const events2: CapturedEvent[] = [];
    const redelivery = await buildOrchestrator(backend, store, events2).runTurn(
      normalizeRestTurn({ text: 'sim', intentionId: 'intent-x1' }, IDENTITY),
    );
    expect(blockedReason(events2)).toBe('confirmation_post_outage_redelivery');
    expect(redelivery.mutation).toBeUndefined();
    expect(redelivery.response?.text).toBe(renderInconclusive());
    expect(backend.executionsSucceeded).toBe(0);
    expect(backend.ops.find((op) => op.id === 'golden-op-2')?.status).toBe('proposed');

    // Intenção nova confirma B normalmente (apresentada no turno anterior).
    const fresh = await buildOrchestrator(backend, store, []).runTurn(
      normalizeRestTurn({ text: 'sim', intentionId: 'intent-fresh' }, IDENTITY),
    );
    expect(fresh.mutation?.status).toBe('succeeded');
    expect(fresh.mutation?.operationId).toBe('golden-op-2');
    expect(backend.executionsSucceeded).toBe(1);
  });
});
