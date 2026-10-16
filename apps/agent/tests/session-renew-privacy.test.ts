/**
 * ADR-027 D3 (supersede FIX-P1-SESS #177): `POST /rpc/session/new` fecha a
 * sessão aberta (arquivando resumo) e abre uma NOVA conversa — SEM APAGAR
 * nada (nem a tabela SDK, nem o espelho em memória, nem memórias duráveis).
 * O isolamento por ator que o #177 fazia via DELETE com escopo agora vive no
 * predicado de visibilidade D3 (leitura, detalhe, busca, WS, export, anexos,
 * resumos, caches, contexto LLM) — ver `workspace-d3-private-views.test.ts`.
 *
 * Contrato exigido:
 * - renovação de B preserva 100% do histórico (tabela + memória + registry
 *   dos demais);
 * - nenhum DELETE na tabela SDK em nenhuma renovação;
 * - falha SQL no registry => NUNCA `ok:true` (fail-closed 500), rollback
 *   integral via `runMemoryTransaction`, sem ressurgimento.
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
    failOnRegistry: false,
    exec<T = Row>(query: string, ...bindings: unknown[]): Iterable<T> {
      const q = query.trim().replace(/\s+/g, ' ');
      queries.push(q);
      if (q.startsWith('CREATE TABLE') || q.startsWith('CREATE INDEX')) {
        const name = q.match(/CREATE TABLE IF NOT EXISTS (\w+)/)?.[1];
        if (name && !tables.has(name)) tables.set(name, []);
        return [] as T[];
      }
      if (q.startsWith('ALTER TABLE')) return [] as T[];
      if (q.startsWith('DELETE FROM cf_ai_chat_agent_messages')) {
        throw new Error('D3 forbids messages delete on renewal: close/open without erasing');
      }
      if (q.startsWith('INSERT INTO agent_sessions')) {
        if (mock.failOnRegistry) throw new Error('SQL failure (injected registry)');
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
        tables.get('agent_sessions')!.push(row);
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

describe('D3 — session/new fecha/abre sem apagar', () => {
  let sql: SqlMock;
  beforeEach(() => {
    sql = createSql();
  });

  it('renovação de B preserva 100% do histórico (tabela + memória)', async () => {
    const agent = createAgent(sql);
    seedSharedContext(sql, agent);
    const res = await agent.fetch(
      new Request('https://agent.test/rpc/session/new', { method: 'POST', headers: headersFor('actor-B') }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
    // D3: NADA é apagado — nem linhas do solicitante, nem de outros, nem legadas.
    const remaining = sql.tables.get('cf_ai_chat_agent_messages')!.map((r) => r['id']).sort();
    expect(remaining).toEqual(['m-a1', 'm-b1', 'm-legacy', 'm-t1']);
    const memIds = agent.messages.map((m) => m['id']).sort();
    expect(memIds).toEqual(['m-a1', 'm-b1', 'm-legacy', 'm-t1']);
  });

  it('registry: sessão de A segue aberta após renovação de B', async () => {
    const agent = createAgent(sql);
    seedSharedContext(sql, agent);
    await agent.fetch(new Request('https://agent.test/rpc/session/new', { method: 'POST', headers: headersFor('actor-A') }));
    await agent.fetch(new Request('https://agent.test/rpc/session/new', { method: 'POST', headers: headersFor('actor-B') }));
    const sessions = sql.tables.get('agent_sessions')!;
    // A renovou 1x (fresca aberta, sem resumo: espelho vazio); B idem.
    const openA = sessions.filter((s) => s['actor_id'] === 'actor-A' && s['ended_at'] == null);
    const openB = sessions.filter((s) => s['actor_id'] === 'actor-B' && s['ended_at'] == null);
    expect(openA).toHaveLength(1);
    expect(openB).toHaveLength(1);
  });

  it('nunca apaga: nenhum DELETE na tabela SDK em nenhuma renovação', async () => {
    const agent = createAgent(sql);
    seedSharedContext(sql, agent);
    await agent.fetch(new Request('https://agent.test/rpc/session/new', { method: 'POST', headers: headersFor('actor-B') }));
    const deletes = sql.queries.filter((q) => q.startsWith('DELETE FROM cf_ai_chat_agent_messages'));
    expect(deletes).toHaveLength(0);
  });

  it('falha SQL no registry => nunca ok:true (fail-closed), rollback integral', async () => {
    const agent = createAgent(sql);
    seedSharedContext(sql, agent);
    await agent.fetch(new Request('https://agent.test/rpc/session/new', { method: 'POST', headers: headersFor('actor-B') }));
    const sessionsBefore = sql.tables.get('agent_sessions')!.length;
    const rowsBefore = sql.tables.get('cf_ai_chat_agent_messages')!.map((r) => r['id']).sort();
    const memBefore = agent.messages.map((m) => m['id']).sort();
    sql.failOnRegistry = true;
    const res = await agent.fetch(
      new Request('https://agent.test/rpc/session/new', { method: 'POST', headers: headersFor('actor-B') }),
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).not.toBe(true);
    // Falha atômica: registry intocado, tabela e memória intactas.
    expect(sql.tables.get('agent_sessions')!.length).toBe(sessionsBefore);
    expect(sql.tables.get('cf_ai_chat_agent_messages')!.map((r) => r['id']).sort()).toEqual(rowsBefore);
    expect(agent.messages.map((m) => m['id']).sort()).toEqual(memBefore);
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
