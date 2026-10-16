/**
 * WS-FATIA3 (D3) RED — visões privadas opt-in por flag (default coletivo).
 * - flag off bloqueia criação privada (403 tipado) e preserva existentes;
 * - privado invisível a outro ator e ao owner-não-dono; coletivo visível;
 * - renovação fecha/abre SEM apagar (tabela SDK + espelho intactos);
 * - resumos persistem com escopo de ator, nunca shared;
 * - legado sem proveniência = preservado-não-publicado.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { FinanceChatAgent } from '../src/finance-chat-agent.js';
import { persistConversationSummary } from '../src/privacy/conversation-visibility.js';
import { recallMemories, rememberFact } from '../src/agent-config/memory/store.js';
import { transformLegacyMessages } from '../src/migration/legacy-history.js';

type Row = Record<string, unknown>;

type SqlMock = {
  tables: Map<string, Row[]>;
  queries: string[];
  exec<T = Row>(query: string, ...bindings: unknown[]): Iterable<T>;
};

const createSql = (): SqlMock => {
  const tables = new Map<string, Row[]>([
    ['agent_sessions', []],
    ['agent_memory', []],
  ]);
  const queries: string[] = [];
  const mock: SqlMock = {
    tables,
    queries,
    exec<T = Row>(query: string, ...bindings: unknown[]): Iterable<T> {
      const q = query.trim().replace(/\s+/g, ' ');
      queries.push(q);
      if (q.startsWith('CREATE TABLE') || q.startsWith('CREATE INDEX')) return [] as T[];
      if (q.startsWith('ALTER TABLE')) return [] as T[];
      if (q.startsWith('SELECT epoch, expires_at FROM workspace_deletion_fence')) return [] as T[];
      if (q.startsWith('BEGIN') || q === 'COMMIT' || q === 'ROLLBACK') return [] as T[];
      if (q.startsWith('SELECT * FROM agent_sessions WHERE workspace_id = ? AND actor_id = ? AND ended_at IS NULL')) {
        const [workspaceId, actorId] = bindings;
        return tables.get('agent_sessions')!.filter(
          (r) => r['workspace_id'] === workspaceId && r['actor_id'] === actorId && r['ended_at'] == null,
        ) as T[];
      }
      if (q.startsWith('SELECT * FROM agent_sessions WHERE id = ?')) {
        return tables.get('agent_sessions')!.filter((r) => r['id'] === bindings[0]) as T[];
      }
      if (q.startsWith('SELECT * FROM agent_sessions WHERE workspace_id = ? AND ended_at IS NOT NULL')) {
        const [workspaceId] = bindings;
        return tables.get('agent_sessions')!.filter(
          (r) => r['workspace_id'] === workspaceId && r['ended_at'] != null,
        ) as T[];
      }
      if (q.startsWith('INSERT INTO agent_sessions') || q.startsWith('INSERT INTO agent_memory')) {
        const name = q.startsWith('INSERT INTO agent_sessions') ? 'agent_sessions' : 'agent_memory';
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
          } else if (token !== '' && !Number.isNaN(Number(token))) {
            row[column] = Number(token);
          } else {
            row[column] = token.replace(/^'(.*)'$/, '$1');
          }
        });
        // Defaults das colunas aditivas quando o INSERT é legado.
        if (name === 'agent_sessions' && row['visibility'] === undefined) row['visibility'] = 'workspace';
        tables.get(name)!.push(row);
        return [] as T[];
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
      if (q.startsWith('SELECT memory_enabled FROM agent_prefs')) return [] as T[];
      if (q.startsWith('SELECT * FROM agent_memory WHERE workspace_id = ?')) {
        const [workspaceId] = bindings;
        return tables.get('agent_memory')!.filter((r) => r['workspace_id'] === workspaceId) as T[];
      }
      if (q.startsWith('UPDATE agent_memory SET last_seen_at = ? WHERE id = ?')) return [] as T[];
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
    transactionSync: <T>(fn: () => T): T => {
      const snapshot = new Map<string, Row[]>();
      for (const [k, v] of sql.tables) snapshot.set(k, v.map((r) => ({ ...r })));
      try {
        return fn();
      } catch (err) {
        sql.tables.clear();
        for (const [k, v] of snapshot) sql.tables.set(k, v);
        throw err;
      }
    },
  };
  Object.defineProperty(agent, 'ctx', { value: { storage }, writable: true, configurable: true });
  Object.defineProperty(agent, 'env', { value: env, writable: true, configurable: true });
  agent.messages = [];
  return agent;
};

const seedMessages = (agent: ReturnType<typeof createAgent>) => {
  agent.messages = [
    { id: 'm-col-a', role: 'user', parts: [{ type: 'text', text: 'coletivo de A' }], metadata: { actorId: 'actor-A', workspaceId: 'ws-1', visibility: 'workspace', ownerActorId: 'actor-A', conversationId: 'c-a' } },
    { id: 'm-priv-a', role: 'user', parts: [{ type: 'text', text: 'privado de A' }], metadata: { actorId: 'actor-A', workspaceId: 'ws-1', visibility: 'private', ownerActorId: 'actor-A', conversationId: 'c-priv-a' } },
    { id: 'm-priv-b', role: 'user', parts: [{ type: 'text', text: 'privado de B' }], metadata: { actorId: 'actor-B', workspaceId: 'ws-1', visibility: 'private', ownerActorId: 'actor-B', conversationId: 'c-priv-b' } },
    { id: 'm-ted-col', role: 'assistant', parts: [{ type: 'text', text: 'resposta coletiva' }], metadata: { actorId: 'ted', workspaceId: 'ws-1', visibility: 'workspace', ownerActorId: 'actor-A', conversationId: 'c-a' } },
    { id: 'm-ted-priv', role: 'assistant', parts: [{ type: 'text', text: 'resposta privada de A' }], metadata: { actorId: 'ted', workspaceId: 'ws-1', visibility: 'private', ownerActorId: 'actor-A', conversationId: 'c-priv-a' } },
    { id: 'm-legacy-ok', role: 'user', parts: [{ type: 'text', text: 'legado com atribuicao' }], metadata: { actorId: 'actor-A', workspaceId: 'ws-1' } },
    { id: 'm-legacy-bare', role: 'user', parts: [{ type: 'text', text: 'legado sem atribuicao' }], metadata: {} },
  ];
};

const historyContents = async (agent: ReturnType<typeof createAgent>, actor: string): Promise<string[]> => {
  const res = await agent.fetch(new Request('https://agent.test/rpc/history', { method: 'GET', headers: headersFor(actor) }));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { items: Array<{ content: string }> };
  return body.items.map((item) => item.content);
};

describe('D3 — criação privada gated por flag', () => {
  let sql: SqlMock;
  beforeEach(() => {
    sql = createSql();
  });

  it('flag off: pedido privado => 403 tipado, sem converter nada', async () => {
    const agent = createAgent(sql, {});
    const res = await agent.fetch(
      new Request('https://agent.test/rpc/session/new', {
        method: 'POST',
        headers: { ...headersFor('actor-A'), 'content-type': 'application/json' },
        body: JSON.stringify({ visibility: 'private' }),
      }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('agent.private_views_disabled');
    expect(sql.tables.get('agent_sessions')!.length).toBe(0);
  });

  it('flag on: pedido privado cria conversa privada do dono; coletiva anterior preservada', async () => {
    const agent = createAgent(sql, { TED_PRIVATE_VIEWS_ENABLED: '1' });
    await agent.fetch(new Request('https://agent.test/rpc/session/new', { method: 'POST', headers: headersFor('actor-A') }));
    const privRes = await agent.fetch(
      new Request('https://agent.test/rpc/session/new', {
        method: 'POST',
        headers: { ...headersFor('actor-A'), 'content-type': 'application/json' },
        body: JSON.stringify({ visibility: 'private' }),
      }),
    );
    expect(privRes.status).toBe(200);
    const rows = sql.tables.get('agent_sessions')!;
    expect(rows.length).toBe(2);
    const openPriv = rows.find((r) => r['ended_at'] == null);
    expect(openPriv?.['visibility']).toBe('private');
    expect(openPriv?.['owner_actor_id']).toBe('actor-A');
    expect(String(openPriv?.['conversation_id'] ?? '')).not.toBe('');
    // Troca de modo não converte retroativamente: a anterior segue coletiva.
    const closed = rows.find((r) => r['ended_at'] != null);
    expect(closed?.['visibility']).toBe('workspace');
  });

  it('flag off preserva privadas existentes (sem converter para coletivo)', async () => {
    const enabled = createAgent(sql, { TED_PRIVATE_VIEWS_ENABLED: '1' });
    await enabled.fetch(
      new Request('https://agent.test/rpc/session/new', {
        method: 'POST',
        headers: { ...headersFor('actor-A'), 'content-type': 'application/json' },
        body: JSON.stringify({ visibility: 'private' }),
      }),
    );
    const disabled = createAgent(sql, {});
    await disabled.fetch(new Request('https://agent.test/rpc/session/new', { method: 'POST', headers: headersFor('actor-A') }));
    const rows = sql.tables.get('agent_sessions')!;
    const privates = rows.filter((r) => r['visibility'] === 'private');
    expect(privates.length).toBe(1);
    expect(privates[0]?.['owner_actor_id']).toBe('actor-A');
  });
});

describe('D3 — predicado no /rpc/history', () => {
  let sql: SqlMock;
  beforeEach(() => {
    sql = createSql();
  });

  it('B vê coletivo + própria privada + legado com proveniência; nunca privado de A nem legado sem atribuição', async () => {
    const agent = createAgent(sql, {});
    seedMessages(agent);
    const contents = await historyContents(agent, 'actor-B');
    expect(contents).toContain('coletivo de A');
    expect(contents).toContain('resposta coletiva');
    expect(contents).toContain('legado com atribuicao');
    expect(contents).toContain('privado de B');
    expect(contents).not.toContain('privado de A');
    expect(contents).not.toContain('resposta privada de A');
    expect(contents).not.toContain('legado sem atribuicao');
  });

  it('A vê o próprio privado; resposta ted da privada não abre acesso a B', async () => {
    const agent = createAgent(sql, {});
    seedMessages(agent);
    const contents = await historyContents(agent, 'actor-A');
    expect(contents).toContain('privado de A');
    expect(contents).toContain('resposta privada de A');
    expect(contents).not.toContain('privado de B');
  });
});

describe('D3 — renovação fecha/abre sem apagar', () => {
  let sql: SqlMock;
  beforeEach(() => {
    sql = createSql();
  });

  it('nenhum DELETE na tabela SDK; espelho intacto; registry fecha+abre', async () => {
    const agent = createAgent(sql, {});
    seedMessages(agent);
    const before = agent.messages.map((m) => m['id']).sort();
    const res = await agent.fetch(new Request('https://agent.test/rpc/session/new', { method: 'POST', headers: headersFor('actor-B') }));
    expect(res.status).toBe(200);
    expect(agent.messages.map((m) => m['id']).sort()).toEqual(before);
    expect(sql.queries.some((q) => q.startsWith('DELETE FROM cf_ai_chat_agent_messages'))).toBe(false);
    const sessions = sql.tables.get('agent_sessions')!;
    expect(sessions.filter((s) => s['actor_id'] === 'actor-B' && s['ended_at'] == null)).toHaveLength(1);
  });
});

describe('D3 — resumos nunca viram memória compartilhada', () => {
  let sql: SqlMock;
  beforeEach(() => {
    sql = createSql();
  });

  it('resumo persiste com escopo de ator; recall de outro ator exclui', async () => {
    await persistConversationSummary(
      (input) => rememberFact(sql as never, { workspaceId: input.workspaceId, actor: input.actor, kind: input.kind, content: input.content, salience: input.salience }),
      {
        workspaceId: 'ws-1',
        actorId: 'actor-A',
        summary: 'resumo privado de A',
      },
    );
    const rows = sql.tables.get('agent_memory')!;
    expect(rows.length).toBe(1);
    expect(rows[0]?.['actor']).toBe('actor-A');
    const forB = recallMemories(sql as never, { workspaceId: 'ws-1', actor: 'actor-B', query: 'resumo privado' });
    expect(forB.some((item) => item.content.includes('resumo privado de A'))).toBe(false);
    const forA = recallMemories(sql as never, { workspaceId: 'ws-1', actor: 'actor-A', query: 'resumo privado' });
    expect(forA.some((item) => item.content.includes('resumo privado de A'))).toBe(true);
  });
});

describe('D3 — legado: export classifica audiência sem publicar o preservado', () => {
  it('atribuído vira coletivo; sem atribuição vira preservado (invisível)', () => {
    const transformed = transformLegacyMessages(
      [
        { id: 'l-1', role: 'user', content_json: JSON.stringify('oi'), actor_id: 'actor-A', created_at: '2026-01-01T00:00:00Z' },
        { id: 'l-2', role: 'user', content_json: JSON.stringify('sem dono'), actor_id: '', created_at: '2026-01-01T00:00:00Z' },
      ],
      'ws-1',
      [],
    );
    const first = transformed[0]?.metadata as { visibility?: string };
    const second = transformed[1]?.metadata as { visibility?: string; ownerActorId?: string };
    expect(first.visibility).toBe('workspace');
    // Preservado-não-publicado: marcado de modo que o predicado negue a todos.
    expect(second.visibility).toBe('private');
    expect(second.ownerActorId ?? '').toBe('');
  });
});
