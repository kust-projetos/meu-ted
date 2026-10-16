import { describe, expect, it, beforeEach, } from 'vitest';
import { FinanceChatAgent } from '../src/finance-chat-agent.js';
import { buildMemoryTools } from '../src/agent-config/memory/tools.js';

type Row = Record<string, unknown>;

/** In-memory SQL mock covering memory + sessions + prefs + SDK messages. */
const createSql = () => {
  const tables = new Map<string, Row[]>([
    ['agent_memory', []],
    ['agent_sessions', []],
    ['agent_prefs', []],
    ['cf_ai_chat_agent_messages', [{ id: 'seed' }]],
  ]);
  const queries: string[] = [];
  const sql = {
    queries,
    tables,
    exec<T = Row>(query: string, ...bindings: unknown[]): Iterable<T> {
      const q = query.trim().replace(/\s+/g, ' ');
      queries.push(q);
      if (q.startsWith('CREATE TABLE') || q.startsWith('CREATE INDEX')) {
        const name = q.match(/CREATE TABLE IF NOT EXISTS (\w+)/)?.[1];
        if (name && !tables.has(name)) tables.set(name, []);
        return [] as T[];
      }
      if (q.startsWith('DELETE FROM cf_ai_chat_agent_messages')) {
        // ADR-027 D3: renovação fecha/abre SEM apagar — qualquer DELETE na
        // tabela SDK é proibido (o isolamento vive no predicado de leitura).
        throw new Error('D3 forbids messages delete on renewal: close/open without erasing');
      }
      if (q.startsWith('INSERT INTO agent_memory')) {
        const [id, workspaceId, actor, kind, content, salience, createdAt, lastSeenAt, expiresAt] = bindings;
        tables.get('agent_memory')!.push({
          id, workspace_id: workspaceId, actor, kind, content, salience,
          created_at: createdAt, last_seen_at: lastSeenAt, expires_at: expiresAt,
        });
        return [] as T[];
      }
      if (q.startsWith('INSERT INTO agent_prefs')) {
        const [workspaceId, enabled, updatedAt] = bindings;
        const rows = tables.get('agent_prefs')!;
        const existing = rows.find((r) => r['workspace_id'] === workspaceId);
        if (existing) {
          existing['memory_enabled'] = enabled;
          existing['updated_at'] = updatedAt;
        } else rows.push({ workspace_id: workspaceId, memory_enabled: enabled, updated_at: updatedAt });
        return [] as T[];
      }
      if (q.startsWith('SELECT memory_enabled')) {
        return tables.get('agent_prefs')!.filter((r) => r['workspace_id'] === bindings[0]) as T[];
      }
      if (q.startsWith('SELECT * FROM agent_memory')) {
        return tables.get('agent_memory')!.filter((r) => r['workspace_id'] === bindings[0]) as T[];
      }
      if (q.startsWith('UPDATE agent_memory SET salience')) {
        const [salience, lastSeenAt, id] = bindings;
        const row = tables.get('agent_memory')!.find((r) => r['id'] === id);
        if (row) {
          row['salience'] = salience;
          row['last_seen_at'] = lastSeenAt;
        }
        return [] as T[];
      }
      if (q.startsWith('UPDATE agent_memory SET last_seen_at')) return [] as T[];
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
        const [workspaceId, actorId] = bindings;
        return tables.get('agent_sessions')!.filter(
          (r) => r['workspace_id'] === workspaceId && r['actor_id'] === actorId && r['ended_at'] == null,
        ) as T[];
      }
      // D3: listagem por workspace + predicado em código (sem limite no SQL).
      if (q.startsWith('SELECT * FROM agent_sessions WHERE workspace_id = ? AND ended_at IS NOT NULL')) {
        const [workspaceId] = bindings;
        return tables.get('agent_sessions')!.filter(
          (r) => r['workspace_id'] === workspaceId && r['ended_at'] != null,
        ) as T[];
      }
      // D3: detalhe por id + predicado em código (workspace conferido fora).
      if (q.startsWith('SELECT * FROM agent_sessions WHERE id = ?')) {
        const [id] = bindings;
        return tables.get('agent_sessions')!.filter((r) => r['id'] === id) as T[];
      }
      // FIX-WS-D2-FENCE R2 — `workspace_deletion_fence` é estado durável real
      // do DO: SELECT por workspace (sem fence → []), upsert por workspace_id
      // e DELETE por workspace, condicional ao epoch quando vinculado.
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
  return sql;
};

const headers = { 'x-agent-actor': 'actor-1', 'x-agent-workspace': 'ws-1' };

const createAgent = (sql: ReturnType<typeof createSql>) => {
  const agent = Object.create(FinanceChatAgent.prototype) as FinanceChatAgent & { messages: Array<Record<string, unknown>> };
  Object.defineProperty(agent, 'ctx', { value: { storage: { sql } }, writable: true, configurable: true });
  Object.defineProperty(agent, 'env', { value: {}, writable: true, configurable: true });
  agent.messages = [];
  return agent;
};

describe('memory model tools (Part B)', () => {
  let sql: ReturnType<typeof createSql>;
  beforeEach(() => {
    sql = createSql();
  });

  it('remember_fact stores and recall finds, workspace-scoped', async () => {
    const tools = buildMemoryTools({ sql, workspaceId: 'ws-1', actorId: 'actor-1' });
    const saved = (await (tools['remember_fact'] as { execute: (p: unknown) => Promise<unknown> }).execute({
      content: 'Conta principal é o Nubank',
    })) as { stored: boolean };
    expect(saved.stored).toBe(true);
    const recalled = (await (tools['recall'] as { execute: (p: unknown) => Promise<unknown> }).execute({
      query: 'conta principal',
    })) as { found: number; memories: Array<{ content: string }> };
    expect(recalled.found).toBe(1);
    expect(recalled.memories[0]!.content).toContain('Nubank');
    const foreign = buildMemoryTools({ sql, workspaceId: 'ws-2', actorId: 'actor-1' });
    const none = (await (foreign['recall'] as { execute: (p: unknown) => Promise<unknown> }).execute({
      query: 'conta',
    })) as { found: number };
    expect(none.found).toBe(0);
  });

  it('list/get session tools aplicam o predicado D3 (coletivo visível, sem oráculo)', async () => {
    const agent = createAgent(sql);
    const first = await agent.fetch(
      new Request('https://agent.test/rpc/session/new', { method: 'POST', headers }),
    );
    expect(first.status).toBe(200);
    const tools = buildMemoryTools({ sql, workspaceId: 'ws-1', actorId: 'actor-1' });
    // No ended sessions yet (first renew had no history).
    const listed = (await (tools['list_past_sessions'] as { execute: (p: unknown) => Promise<unknown> }).execute({})) as {
      found: number;
    };
    expect(listed.found).toBe(0);
    const missing = (await (tools['get_session_summary'] as { execute: (p: unknown) => Promise<unknown> }).execute({
      sessionId: 'nope',
    })) as { found: boolean };
    expect(missing.found).toBe(false);
  });
});

describe('POST /rpc/session/new — Nova sessão (Part B)', () => {
  let sql: ReturnType<typeof createSql>;
  beforeEach(() => {
    sql = createSql();
  });

  it('requires authenticated actor and workspace', async () => {
    const agent = createAgent(sql);
    const res = await agent.fetch(new Request('https://agent.test/rpc/session/new', { method: 'POST' }));
    expect(res.status).toBe(401);
  });

  it('archives history into the registry without erasing anything (D3 fecha/abre)', async () => {
    const agent = createAgent(sql);
    const row = (id: string, actorId: string | undefined, text: string) => ({
      id,
      message: JSON.stringify({
        id,
        role: 'user',
        parts: [{ type: 'text', text }],
        ...(actorId === undefined ? {} : { metadata: { actorId, workspaceId: 'ws-1' } }),
      }),
    });
    sql.tables.set('cf_ai_chat_agent_messages', [
      row('m-a1', 'actor-1', 'Minha conta principal é o Nubank'),
      row('m-a2', 'actor-2', 'Extrato do outro membro'),
    ]);
    agent.messages = [
      { id: 'm-a1', role: 'user', parts: [{ type: 'text', text: 'Minha conta principal é o Nubank' }], metadata: { actorId: 'actor-1', workspaceId: 'ws-1' } },
      { id: 'm-2', role: 'assistant', parts: [{ type: 'text', text: 'Anotado!' }], metadata: { actorId: 'ted', workspaceId: 'ws-1' } },
    ];
    const res = await agent.fetch(new Request('https://agent.test/rpc/session/new', { method: 'POST', headers }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      sessionId: string;
      previousSessionId: string | null;
      messageCount: number;
      summarized: boolean;
    };
    expect(body.ok).toBe(true);
    expect(body.messageCount).toBe(2);
    expect(body.summarized).toBe(true);
    // D3: renovação NÃO apaga — espelho e tabela intactos; o predicado de
    // visibilidade (não o DELETE) isola o contexto por ator na leitura.
    expect(agent.messages.map((m) => m['id'])).toEqual(['m-a1', 'm-2']);
    expect(sql.tables.get('cf_ai_chat_agent_messages')!.map((r) => r['id']).sort()).toEqual(['m-a1', 'm-a2']);
    const deletes = sql.queries.filter((q) => q.startsWith('DELETE FROM cf_ai_chat_agent_messages'));
    expect(deletes).toHaveLength(0);
    // Registry holds the archived session with its summary (plus the fresh one).
    const sessions = sql.tables.get('agent_sessions')!;
    expect(sessions).toHaveLength(2);
    const archived = sessions.find((s) => s['ended_at'] !== null);
    expect(archived!['summary']).toContain('Nubank');
    expect(archived!['message_count']).toBe(2);
  });

  it('keeps durable memories across renewal', async () => {
    const agent = createAgent(sql);
    const tools = buildMemoryTools({ sql, workspaceId: 'ws-1', actorId: 'actor-1' });
    await (tools['remember_fact'] as { execute: (p: unknown) => Promise<unknown> }).execute({
      content: 'Prefiro resumos curtos',
    });
    await agent.fetch(new Request('https://agent.test/rpc/session/new', { method: 'POST', headers }));
    const recalled = (await (tools['recall'] as { execute: (p: unknown) => Promise<unknown> }).execute({
      query: 'resumos',
    })) as { found: number };
    expect(recalled.found).toBe(1);
  });
});

describe('POST /rpc/memory/prefs — privacy toggle (Part B)', () => {
  it('defaults ON and honors opt-out', async () => {
    const sql = createSql();
    const agent = createAgent(sql);
    const off = await agent.fetch(
      new Request('https://agent.test/rpc/memory/prefs', {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      }),
    );
    expect(off.status).toBe(200);
    expect(await off.json()).toMatchObject({ ok: true, enabled: false });
    // Reload reads the persisted preference.
    const { isMemoryEnabled } = await import('../src/agent-config/memory/store.js');
    expect(isMemoryEnabled(sql, 'ws-1')).toBe(false);
  });

  it('rejects non-boolean payloads', async () => {
    const sql = createSql();
    const agent = createAgent(sql);
    const res = await agent.fetch(
      new Request('https://agent.test/rpc/memory/prefs', {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: 'yes' }),
      }),
    );
    expect(res.status).toBe(400);
  });
});
