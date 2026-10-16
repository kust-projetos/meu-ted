/**
 * FIX-P1-SESS #177 (RED): `POST /rpc/session/new` apagava GLOBALMENTE a
 * tabela SDK (`DELETE FROM cf_ai_chat_agent_messages` sem WHERE) — o ator B,
 * ao iniciar nova sessão, destruía o contexto do ator A no mesmo workspace
 * (o DO é por workspace, compartilhado pelos membros) — e engolia falha SQL
 * retornando `ok:true` mesmo assim.
 *
 * Contrato exigido:
 * - renovação de B preserva o histórico de A (registry por ator + contexto
 *   só remove linhas atribuíveis ao solicitante; linhas sem atribuição são
 *   MANTIDAS — D3 coletivo-vs-privado segue como ADR pendente, sem deletar
 *   dados reais);
 * - falha SQL no DELETE => NUNCA `ok:true` (fail-closed 500), sem ressurgimento.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { FinanceChatAgent } from '../src/finance-chat-agent.js';

type Row = Record<string, unknown>;

const msgRow = (id: string, actorId: string | undefined, text: string): Row => ({
  id,
  message: JSON.stringify({
    id,
    role: 'user',
    parts: [{ type: 'text', text }],
    ...(actorId === undefined ? {} : { metadata: { actorId, workspaceId: 'ws-1' } }),
  }),
});

type SqlMock = {
  tables: Map<string, Row[]>;
  queries: string[];
  failOnMessagesDelete: boolean;
  failOnRegistry: boolean;
  exec<T = Row>(query: string, ...bindings: unknown[]): Iterable<T>;
};

/** SQL mock com linhas SDK realistas (JSON com metadata.actorId). */
const createSql = (): SqlMock => {
  const tables = new Map<string, Row[]>([
    ['agent_sessions', []],
    ['cf_ai_chat_agent_messages', []],
  ]);
  const queries: string[] = [];
  const mock: SqlMock = {
    tables,
    queries,
    failOnMessagesDelete: false,
    failOnRegistry: false,
    exec<T = Row>(query: string, ...bindings: unknown[]): Iterable<T> {
      const q = query.trim().replace(/\s+/g, ' ');
      queries.push(q);
      if (q.startsWith('CREATE TABLE') || q.startsWith('CREATE INDEX')) {
        const name = q.match(/CREATE TABLE IF NOT EXISTS (\w+)/)?.[1];
        if (name && !tables.has(name)) tables.set(name, []);
        return [] as T[];
      }
      if (q.startsWith('DELETE FROM cf_ai_chat_agent_messages')) {
        if (mock.failOnMessagesDelete) throw new Error('SQL failure (injected)');
        const rows = tables.get('cf_ai_chat_agent_messages')!;
        // Apagão global é proibido: só remove com predicado por ator.
        if (!q.includes('WHERE')) throw new Error('unscoped messages delete is forbidden');
        const actor = bindings[0];
        tables.set(
          'cf_ai_chat_agent_messages',
          rows.filter((r) => {
            try {
              const parsed = JSON.parse(String(r['message'] ?? '{}')) as {
                metadata?: { actorId?: string };
              };
              return parsed.metadata?.actorId !== actor;
            } catch {
              return true;
            }
          }),
        );
        return [] as T[];
      }
      if (q.startsWith('INSERT INTO agent_sessions')) {
        if (mock.failOnRegistry) throw new Error('SQL failure (injected registry)');
        const [id, workspaceId, actorId, startedAt] = bindings;
        tables.get('agent_sessions')!.push({
          id, workspace_id: workspaceId, actor_id: actorId, started_at: startedAt,
          ended_at: null, message_count: 0, summary: null,
        });
        return [] as T[];
      }
      if (q.startsWith('UPDATE agent_sessions')) {
        if (mock.failOnRegistry) throw new Error('SQL failure (injected registry)');
        const [endedAt, messageCount, summary, id] = bindings;
        const row = tables.get('agent_sessions')!.find((r) => r['id'] === id);
        if (row) {
          row['ended_at'] = endedAt;
          row['message_count'] = messageCount;
          row['summary'] = summary;
        }
        return [] as T[];
      }
      if (q.startsWith('SELECT * FROM agent_sessions WHERE workspace_id = ? AND actor_id = ? AND ended_at IS NULL')) {
        if (mock.failOnRegistry) throw new Error('SQL failure (injected registry)');
        const [workspaceId, actorId] = bindings;
        return tables.get('agent_sessions')!.filter(
          (r) => r['workspace_id'] === workspaceId && r['actor_id'] === actorId && r['ended_at'] == null,
        ) as T[];
      }
      // FIX-WS-D2-FENCE R2 — `workspace_deletion_fence` é estado durável real
      // do DO (independente do registry/sessões: os flags de fault injection
      // acima não o afetam). SELECT por workspace (sem fence → []), upsert
      // por workspace_id e DELETE por workspace, condicional ao epoch.
      if (q.startsWith('SELECT epoch, expires_at FROM workspace_deletion_fence')) {
        const rows = tables.get('workspace_deletion_fence') ?? [];
        return rows.filter((r) => r['workspace_id'] === bindings[0]).map((r) => ({
          epoch: r['epoch'],
          expires_at: r['expires_at'],
        })) as T[];
      }
      if (q.startsWith('DELETE FROM workspace_deletion_fence')) {
        const rows = tables.get('workspace_deletion_fence') ?? [];
        const [workspaceId, epoch] = bindings;
        tables.set(
          'workspace_deletion_fence',
          rows.filter((r) => {
            if (r['workspace_id'] !== workspaceId) return true;
            if (bindings.length > 1 && r['epoch'] !== epoch) return true;
            return false;
          }),
        );
        return [] as T[];
      }
      if (q.startsWith('INSERT INTO workspace_deletion_fence')) {
        const [workspaceId, epoch, expiresAt] = bindings;
        const rows = tables.get('workspace_deletion_fence') ?? [];
        const existing = rows.find((r) => r['workspace_id'] === workspaceId);
        if (existing) {
          existing['epoch'] = epoch;
          existing['expires_at'] = expiresAt;
        } else {
          rows.push({ workspace_id: workspaceId, epoch, expires_at: expiresAt });
        }
        tables.set('workspace_deletion_fence', rows);
        return [] as T[];
      }
      throw new Error(`unhandled query in mock: ${q.slice(0, 90)}`);
    },
  };
  return mock;
};

const headersFor = (actor: string) => ({ 'x-agent-actor': actor, 'x-agent-workspace': 'ws-1' });

const createAgent = (sql: SqlMock) => {
  const agent = Object.create(FinanceChatAgent.prototype) as FinanceChatAgent & {
    messages: Array<Record<string, unknown>>;
  };
  // SECREVIEW-P1-SESS: `transactionSync` com snapshot/restore — replica a
  // fronteira atômica real do DO (`runMemoryTransaction` usa o primitivo
  // quando presente; sem ele, o mock degradaria para execução direta, sem
  // rollback, e o teste de atomicidade não provaria nada).
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
  Object.defineProperty(agent, 'env', { value: {}, writable: true, configurable: true });
  agent.messages = [];
  return agent;
};

const seedSharedContext = (sql: SqlMock, agent: ReturnType<typeof createAgent>) => {
  sql.tables.get('cf_ai_chat_agent_messages')!.push(
    msgRow('m-a1', 'actor-A', 'Saldo da conta Nubank'),
    msgRow('m-b1', 'actor-B', 'Extrato do cartão'),
    msgRow('m-t1', 'ted', 'Resposta do TED'),
    msgRow('m-legacy', undefined, 'Mensagem legada sem metadata'),
  );
  agent.messages = [
    { id: 'm-a1', role: 'user', parts: [{ type: 'text', text: 'Saldo da conta Nubank' }], metadata: { actorId: 'actor-A', workspaceId: 'ws-1' } },
    { id: 'm-b1', role: 'user', parts: [{ type: 'text', text: 'Extrato do cartão' }], metadata: { actorId: 'actor-B', workspaceId: 'ws-1' } },
    { id: 'm-t1', role: 'assistant', parts: [{ type: 'text', text: 'Resposta do TED' }], metadata: { actorId: 'ted', workspaceId: 'ws-1' } },
    { id: 'm-legacy', role: 'user', parts: [{ type: 'text', text: 'Mensagem legada sem metadata' }], metadata: {} },
  ];
};

describe('P1 #177 — session/new com escopo por ator', () => {
  let sql: SqlMock;
  beforeEach(() => {
    sql = createSql();
  });

  it('renovação de B preserva o histórico de A (tabela + memória)', async () => {
    const agent = createAgent(sql);
    seedSharedContext(sql, agent);
    const res = await agent.fetch(
      new Request('https://agent.test/rpc/session/new', { method: 'POST', headers: headersFor('actor-B') }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
    // Linhas de A, do TED e legadas sobrevivem; só as de B saem.
    const remaining = sql.tables.get('cf_ai_chat_agent_messages')!.map((r) => r['id']).sort();
    expect(remaining).toEqual(['m-a1', 'm-legacy', 'm-t1']);
    const memIds = agent.messages.map((m) => m['id']).sort();
    expect(memIds).toEqual(['m-a1', 'm-legacy', 'm-t1']);
  });

  it('registry: sessão de A segue aberta após renovação de B', async () => {
    const agent = createAgent(sql);
    seedSharedContext(sql, agent);
    await agent.fetch(new Request('https://agent.test/rpc/session/new', { method: 'POST', headers: headersFor('actor-A') }));
    await agent.fetch(new Request('https://agent.test/rpc/session/new', { method: 'POST', headers: headersFor('actor-B') }));
    const sessions = sql.tables.get('agent_sessions')!;
    // A renovou 1x (arquivada + fresca aberta); B renovou 1x (arquivada + fresca).
    const openA = sessions.filter((s) => s['actor_id'] === 'actor-A' && s['ended_at'] == null);
    const openB = sessions.filter((s) => s['actor_id'] === 'actor-B' && s['ended_at'] == null);
    expect(openA).toHaveLength(1);
    expect(openB).toHaveLength(1);
  });

  it('nunca apaga globalmente: nenhum DELETE sem WHERE', async () => {
    const agent = createAgent(sql);
    seedSharedContext(sql, agent);
    await agent.fetch(new Request('https://agent.test/rpc/session/new', { method: 'POST', headers: headersFor('actor-B') }));
    const deletes = sql.queries.filter((q) => q.startsWith('DELETE FROM cf_ai_chat_agent_messages'));
    expect(deletes.length).toBeGreaterThan(0);
    for (const q of deletes) expect(q).toContain('WHERE');
  });

  it('falha SQL no DELETE => nunca ok:true (fail-closed), sem ressurgimento', async () => {
    const agent = createAgent(sql);
    seedSharedContext(sql, agent);
    // B já tem sessão aberta antes da falha (a 1ª renovação remove,
    // legitimamente e com escopo, as linhas do próprio B — m-b1 sai aqui).
    await agent.fetch(new Request('https://agent.test/rpc/session/new', { method: 'POST', headers: headersFor('actor-B') }));
    const sessionsBefore = sql.tables.get('agent_sessions')!.length;
    const rowsBefore = sql.tables.get('cf_ai_chat_agent_messages')!.map((r) => r['id']).sort();
    const memBefore = agent.messages.map((m) => m['id']).sort();
    sql.failOnMessagesDelete = true;
    const res = await agent.fetch(
      new Request('https://agent.test/rpc/session/new', { method: 'POST', headers: headersFor('actor-B') }),
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).not.toBe(true);
    // Falha atômica: nada mudou em relação ao instante da falha — nem
    // registry duplicado, nem tabela/memória tocadas (sem ressurgimento).
    expect(sql.tables.get('agent_sessions')!.length).toBe(sessionsBefore);
    expect(sql.tables.get('cf_ai_chat_agent_messages')!.map((r) => r['id']).sort()).toEqual(rowsBefore);
    expect(agent.messages.map((m) => m['id']).sort()).toEqual(memBefore);
  });

  it('SECREVIEW-P1-SESS: falha no registry pós-DELETE => rollback integral (500, estado 100% preservado)', async () => {
    const agent = createAgent(sql);
    seedSharedContext(sql, agent);
    // B renova 1x (m-b1 sai com escopo, sessão B aberta) e produz um turno novo.
    await agent.fetch(new Request('https://agent.test/rpc/session/new', { method: 'POST', headers: headersFor('actor-B') }));
    const freshB = msgRow('m-b2', 'actor-B', 'Novo extrato do cartão');
    sql.tables.get('cf_ai_chat_agent_messages')!.push(freshB);
    agent.messages.push(JSON.parse(String(freshB['message'])) as Record<string, unknown>);
    const sessionsBefore = sql.tables.get('agent_sessions')!.length;
    const rowsBefore = sql.tables.get('cf_ai_chat_agent_messages')!.map((r) => r['id']).sort();
    const memBefore = agent.messages.map((m) => m['id']).sort();
    // Falha injetada no registry APÓS o DELETE com escopo (SELECT/INSERT/UPDATE).
    sql.failOnRegistry = true;
    const res = await agent.fetch(
      new Request('https://agent.test/rpc/session/new', { method: 'POST', headers: headersFor('actor-B') }),
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).not.toBe(true);
    // Tudo-ou-nada: DELETE revertido + registry intocado + espelho intacto.
    expect(sql.tables.get('agent_sessions')!.length).toBe(sessionsBefore);
    expect(sql.tables.get('cf_ai_chat_agent_messages')!.map((r) => r['id']).sort()).toEqual(rowsBefore);
    expect(agent.messages.map((m) => m['id']).sort()).toEqual(memBefore);
    // Restart do DO: nada desaparece (a mensagem nova de B sobrevive).
    const restarted = createAgent(sql);
    restarted.messages = sql.tables
      .get('cf_ai_chat_agent_messages')!
      .map((r) => JSON.parse(String(r['message']))) as unknown as typeof restarted.messages;
    expect(restarted.messages.map((m) => m['id']).sort()).toEqual(rowsBefore);
  });

  it('reinício do DO: dados de A intactos após renovação de B', async () => {
    const agent = createAgent(sql);
    seedSharedContext(sql, agent);
    await agent.fetch(new Request('https://agent.test/rpc/session/new', { method: 'POST', headers: headersFor('actor-B') }));
    // "Restart": nova instância sobre o MESMO storage durável. O construtor
    // real do SDK repopula `messages` a partir da tabela — replicado aqui.
    const restarted = createAgent(sql);
    restarted.messages = sql.tables
      .get('cf_ai_chat_agent_messages')!
      .map((r) => JSON.parse(String(r['message']))) as unknown as typeof restarted.messages;
    const historyRes = await restarted.fetch(
      new Request('https://agent.test/rpc/history', { method: 'GET', headers: headersFor('actor-A') }),
    );
    expect(historyRes.status).toBe(200);
    const history = (await historyRes.json()) as { items: Array<{ content: string }> };
    expect(history.items.some((m) => m.content.includes('Nubank'))).toBe(true);
  });
});
