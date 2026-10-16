/**
 * FIX-WS-D3-R3 RED — HIGH residual do REVIEW-WS-D3-R2 (branch feat/ws-d3-private-views).
 *
 * Cenário exato: turno privado persistido → resposta perdida → renovação para
 * coletiva → redelivery com o MESMO intentionId. Sem vínculo durável, o
 * redelivery captura a audiência da sessão corrente (coletiva) e re-persiste
 * a pergunta privada como coletiva (republicação).
 *
 * Contrato exigido:
 * - vínculo durável (workspace, actor, intentionId) → audiência ANTES dos
 *   awaits do turno, em tabela/registro próprio, first-writer-wins;
 * - redelivery reutiliza o vínculo, nunca a sessão corrente;
 * - vale para a persistência de pergunta E de resposta;
 * - erro de store ⇒ fail-closed (`agent.persistence_unavailable`), nunca
 *   default coletivo silencioso.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { FinanceChatAgent } from '../src/finance-chat-agent.js';
import {
  canAccessMessage,
  stampMessageAudience,
  type ConversationAudience,
} from '../src/privacy/conversation-visibility.js';
import {
  ensureTurnAudienceBinding,
  getTurnAudienceBinding,
  initializeTurnAudienceBindingSchema,
} from '../src/privacy/turn-audience-bindings.js';

type Row = Record<string, unknown>;

type SqlMock = {
  tables: Map<string, Row[]>;
  queries: string[];
  failRegistryReads: boolean;
  exec<T = Row>(query: string, ...bindings: unknown[]): Iterable<T>;
};

const BINDING_SELECT =
  'SELECT * FROM agent_turn_audience_bindings WHERE intention_id = ? AND workspace_id = ? AND actor_id = ?';

const createSql = (): SqlMock => {
  const tables = new Map<string, Row[]>([
    ['agent_sessions', []],
    ['agent_turn_audience_bindings', []],
  ]);
  const queries: string[] = [];
  const mock: SqlMock = {
    tables,
    queries,
    failRegistryReads: false,
    exec<T = Row>(query: string, ...bindings: unknown[]): Iterable<T> {
      const q = query.trim().replace(/\s+/g, ' ');
      queries.push(q);
      if (q.startsWith('CREATE TABLE') || q.startsWith('CREATE INDEX')) return [] as T[];
      if (q.startsWith('ALTER TABLE')) return [] as T[];
      if (q.startsWith('SELECT epoch, expires_at FROM workspace_deletion_fence')) return [] as T[];
      if (q.startsWith('SELECT sql FROM sqlite_master')) return [] as T[];
      if (q.startsWith('BEGIN') || q === 'COMMIT' || q === 'ROLLBACK') return [] as T[];
      if (q.startsWith('SELECT * FROM agent_sessions WHERE workspace_id = ? AND actor_id = ? AND ended_at IS NULL')) {
        if (mock.failRegistryReads) throw new Error('SQL failure (injected registry read)');
        const [workspaceId, actorId] = bindings;
        return tables.get('agent_sessions')!.filter(
          (r) => r['workspace_id'] === workspaceId && r['actor_id'] === actorId && r['ended_at'] == null,
        ) as T[];
      }
      if (q.startsWith('UPDATE agent_sessions SET ended_at = ?')) {
        const [endedAt, messageCount, summary, id] = bindings;
        const row = tables.get('agent_sessions')!.find((r) => r['id'] === id);
        if (row) {
          row['ended_at'] = endedAt;
          row['message_count'] = messageCount;
          row['summary'] = summary;
        }
        return [] as T[];
      }
      if (q.startsWith('SELECT * FROM agent_turn_audience_bindings')) {
        if (mock.failRegistryReads) throw new Error('SQL failure (injected binding read)');
        const [intentionId, workspaceId, actorId] = bindings;
        return tables.get('agent_turn_audience_bindings')!.filter(
          (r) =>
            r['intention_id'] === intentionId &&
            r['workspace_id'] === workspaceId &&
            r['actor_id'] === actorId,
        ) as T[];
      }
      if (q.startsWith('INSERT INTO agent_turn_audience_bindings')) {
        const cols = q.slice(q.indexOf('(') + 1, q.indexOf(')')).split(',').map((c) => c.trim());
        const row: Row = {};
        cols.forEach((column, index) => {
          row[column] = bindings[index];
        });
        const store = tables.get('agent_turn_audience_bindings')!;
        if (
          store.some(
            (r) =>
              r['intention_id'] === row['intention_id'] &&
              r['workspace_id'] === row['workspace_id'] &&
              r['actor_id'] === row['actor_id'],
          )
        ) {
          throw new Error('UNIQUE constraint failed: agent_turn_audience_bindings');
        }
        store.push(row);
        return [] as T[];
      }
      if (q.startsWith('INSERT INTO agent_sessions')) {
        const cols = q.slice(q.indexOf('(') + 1, q.indexOf(')')).split(',').map((c) => c.trim());
        const valuesPart = q.slice(q.indexOf('VALUES') + 'VALUES'.length).trim();
        const tokens = valuesPart
          .slice(valuesPart.indexOf('(') + 1, valuesPart.lastIndexOf(')'))
          .split(',')
          .map((t) => t.trim());
        const row: Row = {};
        let binding = 0;
        cols.forEach((column, index) => {
          const token = tokens[index] ?? '?';
          if (token === '?') {
            row[column] = bindings[binding];
            binding += 1;
          } else if (/^NULL$/i.test(token)) {
            row[column] = null;
          } else {
            row[column] = token.replace(/^'(.*)'$/, '$1');
          }
        });
        tables.get('agent_sessions')!.push(row);
        return [] as T[];
      }
      throw new Error(`unhandled query in mock: ${q.slice(0, 100)}`);
    },
  };
  return mock;
};

const headersFor = (actor: string) => ({ 'x-agent-actor': actor, 'x-agent-workspace': 'ws-1' });

const createAgent = (sql: SqlMock, env: Record<string, string> = {}) => {
  const agent = Object.create(FinanceChatAgent.prototype) as FinanceChatAgent & {
    messages: Array<Record<string, unknown>>;
  };
  const storage = {
    sql,
    transactionSync: <T>(fn: () => T): T => fn(),
  };
  Object.defineProperty(agent, 'ctx', { value: { storage }, writable: true, configurable: true });
  Object.defineProperty(agent, 'env', { value: env, writable: true, configurable: true });
  agent.messages = [];
  return agent;
};

const boundFor = (
  agent: ReturnType<typeof createAgent>,
  workspaceId: string,
  actorId: string,
  intentionId: string,
  current: ConversationAudience,
): ConversationAudience =>
  (agent as unknown as {
    boundTurnAudienceFor(ws: string, actor: string, intention: string, cur: ConversationAudience): ConversationAudience;
  }).boundTurnAudienceFor(workspaceId, actorId, intentionId, current);

const currentFor = (
  agent: ReturnType<typeof createAgent>,
  workspaceId: string,
  actorId: string,
): ConversationAudience =>
  (agent as unknown as {
    conversationAudienceFor(ws: string, actor: string): ConversationAudience;
  }).conversationAudienceFor(workspaceId, actorId);

const privateSessionRow = (overrides: Partial<Row> = {}): Row => ({
  id: 'sess-priv-1',
  workspace_id: 'ws-1',
  actor_id: 'actor-A',
  started_at: '2026-10-15T00:00:00.000Z',
  ended_at: null,
  message_count: 0,
  summary: null,
  visibility: 'private',
  owner_actor_id: 'actor-A',
  conversation_id: 'c-priv-a',
  ...overrides,
});

describe('FIX-WS-D3-R3 — vínculo durável de audiência por intention', () => {
  let sql: SqlMock;
  beforeEach(() => {
    sql = createSql();
    initializeTurnAudienceBindingSchema(sql as never);
  });

  it('first-writer-wins: segunda escrita com audiência distinta perde', () => {
    const first: ConversationAudience = {
      workspaceId: 'ws-1',
      visibility: 'private',
      ownerActorId: 'actor-A',
      conversationId: 'c-priv-a',
    };
    const rival: ConversationAudience = {
      workspaceId: 'ws-1',
      visibility: 'workspace',
      ownerActorId: 'actor-A',
      conversationId: 'c-col',
    };
    const bound = ensureTurnAudienceBinding(sql as never, {
      workspaceId: 'ws-1',
      actorId: 'actor-A',
      intentionId: 'i-1',
      audience: first,
      createdAt: '2026-10-15T00:00:01.000Z',
    });
    expect(bound).toEqual(first);
    const second = ensureTurnAudienceBinding(sql as never, {
      workspaceId: 'ws-1',
      actorId: 'actor-A',
      intentionId: 'i-1',
      audience: rival,
      createdAt: '2026-10-15T00:00:02.000Z',
    });
    expect(second).toEqual(first);
    expect(getTurnAudienceBinding(sql as never, { workspaceId: 'ws-1', actorId: 'actor-A', intentionId: 'i-1' })).toEqual(first);
    // Uma única linha: sem republicação do vínculo.
    expect(sql.tables.get('agent_turn_audience_bindings')).toHaveLength(1);
  });

  it('vínculo é isolado por ator (mesmo intentionId não colide)', () => {
    const mine: ConversationAudience = {
      workspaceId: 'ws-1',
      visibility: 'private',
      ownerActorId: 'actor-A',
      conversationId: 'c-priv-a',
    };
    const theirs: ConversationAudience = {
      workspaceId: 'ws-1',
      visibility: 'workspace',
      ownerActorId: 'actor-B',
      conversationId: 'c-col-b',
    };
    ensureTurnAudienceBinding(sql as never, {
      workspaceId: 'ws-1',
      actorId: 'actor-A',
      intentionId: 'i-shared',
      audience: mine,
      createdAt: '2026-10-15T00:00:01.000Z',
    });
    const other = ensureTurnAudienceBinding(sql as never, {
      workspaceId: 'ws-1',
      actorId: 'actor-B',
      intentionId: 'i-shared',
      audience: theirs,
      createdAt: '2026-10-15T00:00:02.000Z',
    });
    expect(other).toEqual(theirs);
  });

  it('cenário exato: privado → coletiva → redelivery mesma intention ⇒ privada preservada, sem republicação', async () => {
    sql.tables.get('agent_sessions')!.push(privateSessionRow());
    const agent = createAgent(sql, { TED_PRIVATE_VIEWS_ENABLED: '1' });

    // 1. Turno original privado: vincula ANTES de qualquer await.
    const original = boundFor(agent, 'ws-1', 'actor-A', 'i-priv-1', currentFor(agent, 'ws-1', 'actor-A'));
    expect(original.visibility).toBe('private');
    expect(original.conversationId).toBe('c-priv-a');

    // 2. Resposta perdida; renovação para coletiva (troca de modo, sem apagar).
    const renew = await agent.fetch(
      new Request('https://agent.test/rpc/session/new', {
        method: 'POST',
        headers: { ...headersFor('actor-A'), 'content-type': 'application/json' },
        body: JSON.stringify({ visibility: 'workspace' }),
      }),
    );
    expect(renew.status).toBe(200);
    const nowCurrent = currentFor(agent, 'ws-1', 'actor-A');
    expect(nowCurrent.visibility).toBe('workspace');

    // 3. Redelivery com o MESMO intentionId: reutiliza o vínculo, nunca a sessão corrente.
    const before = sql.tables.get('agent_turn_audience_bindings')!.length;
    const redelivered = boundFor(agent, 'ws-1', 'actor-A', 'i-priv-1', nowCurrent);
    expect(redelivered.visibility).toBe('private');
    expect(redelivered.ownerActorId).toBe('actor-A');
    expect(redelivered.conversationId).toBe('c-priv-a');
    expect(sql.tables.get('agent_turn_audience_bindings')!.length).toBe(before);

    // 4. A pergunta republicada carimba o privado original: B não lê, o dono lê.
    const stamped = stampMessageAudience(
      { actorId: 'actor-A', workspaceId: 'ws-1', createdAt: '2026-10-15T00:00:03.000Z' },
      redelivered,
    );
    expect(canAccessMessage({ actorId: 'actor-B', workspaceId: 'ws-1', meta: stamped as never })).toBe(false);
    expect(canAccessMessage({ actorId: 'actor-A', workspaceId: 'ws-1', meta: stamped as never })).toBe(true);
  });

  it('fail-closed: erro de store no vínculo lança agent.persistence_unavailable', () => {
    sql.tables.get('agent_sessions')!.push(privateSessionRow());
    const agent = createAgent(sql, {});
    sql.failRegistryReads = true;
    let code: unknown;
    try {
      boundFor(
        agent,
        'ws-1',
        'actor-A',
        'i-fail-1',
        { workspaceId: 'ws-1', visibility: 'workspace', ownerActorId: 'actor-A', conversationId: 'c-col' },
      );
    } catch (err) {
      code = (err as { code?: unknown }).code;
    }
    expect(code).toBe('agent.persistence_unavailable');
  });
});
