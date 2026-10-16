/**
 * FIX-WS-D3-R2 RED — 5 findings do REVIEW-WS-D3 (branch feat/ws-d3-private-views).
 * 1. HIGH resumo cruza audiências: resumo da renovação SÓ da conversa encerrada;
 *    privada→coletiva→leitura por B nunca expõe texto privado.
 * 2. HIGH audiência muda mid-turn: audiência/conversa capturada UMA vez e
 *    vinculada ao turno inteiro (Q+A+redelivery); renovação nunca reescreve.
 * 3. HIGH falha de leitura vira coletiva: erro de registry = fail-closed 503,
 *    nunca default coletivo silencioso.
 * 4. HIGH ted como prova: 'ted'/sistema/ausente nunca é proveniência humana;
 *    sem ela, preservado-não-publicado (mensagem, sessão, legado).
 * 5. MEDIUM renovação sem separação: /rpc/history e contexto ativos SÓ da
 *    conversa aberta (+legado sem conversationId, sem apagar nada).
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { FinanceChatAgent } from '../src/finance-chat-agent.js';
import {
  canAccessMessage,
  classifyLegacyAudience,
  type MessageAudienceStamp,
} from '../src/privacy/conversation-visibility.js';
import { canAccessSessionRow, type ChatSession } from '../src/agent-config/memory/sessions.js';
import { transformLegacyMessages } from '../src/migration/legacy-history.js';
import { normalizeRestTurn } from '../src/orchestration/conversation-orchestrator.js';

type Row = Record<string, unknown>;

type SqlMock = {
  tables: Map<string, Row[]>;
  queries: string[];
  failRegistryReads: boolean;
  exec<T = Row>(query: string, ...bindings: unknown[]): Iterable<T>;
};

const createSql = (): SqlMock => {
  const tables = new Map<string, Row[]>([['agent_sessions', []]]);
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
      if (q.startsWith('BEGIN') || q === 'COMMIT' || q === 'ROLLBACK') return [] as T[];
      if (q.startsWith('SELECT * FROM agent_sessions WHERE workspace_id = ? AND actor_id = ? AND ended_at IS NULL')) {
        if (mock.failRegistryReads) throw new Error('SQL failure (injected registry read)');
        const [workspaceId, actorId] = bindings;
        return tables.get('agent_sessions')!.filter(
          (r) => r['workspace_id'] === workspaceId && r['actor_id'] === actorId && r['ended_at'] == null,
        ) as T[];
      }
      if (q.startsWith('SELECT * FROM agent_sessions WHERE id = ?')) {
        if (mock.failRegistryReads) throw new Error('SQL failure (injected registry read)');
        return tables.get('agent_sessions')!.filter((r) => r['id'] === bindings[0]) as T[];
      }
      if (q.startsWith('SELECT * FROM agent_sessions WHERE workspace_id = ? AND ended_at IS NOT NULL')) {
        if (mock.failRegistryReads) throw new Error('SQL failure (injected registry read)');
        const [workspaceId] = bindings;
        return tables.get('agent_sessions')!.filter(
          (r) => r['workspace_id'] === workspaceId && r['ended_at'] != null,
        ) as T[];
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

const openSessionRow = (overrides: Partial<Row> = {}): Row => ({
  id: 'sess-col-1',
  workspace_id: 'ws-1',
  actor_id: 'actor-A',
  started_at: '2026-10-15T00:00:00.000Z',
  ended_at: null,
  message_count: 0,
  summary: null,
  visibility: 'workspace',
  owner_actor_id: 'actor-A',
  conversation_id: 'c-col',
  ...overrides,
});

const userMsg = (id: string, text: string, meta: Record<string, unknown>) => ({
  id,
  role: 'user',
  parts: [{ type: 'text', text }],
  metadata: { workspaceId: 'ws-1', ...meta },
});

describe('R2 finding 1 — resumo SÓ da conversa encerrada', () => {
  let sql: SqlMock;
  beforeEach(() => {
    sql = createSql();
  });

  it('renovação da coletiva não resume o privado de A; B lê a coletiva sem ver o privado', async () => {
    sql.tables.get('agent_sessions')!.push(openSessionRow());
    const agent = createAgent(sql, {});
    agent.messages = [
      userMsg('m-col', 'pedido-coletivo-saldo-conta', { actorId: 'actor-A', visibility: 'workspace', ownerActorId: 'actor-A', conversationId: 'c-col' }),
      userMsg('m-priv', 'segredo-privado-xyz', { actorId: 'actor-A', visibility: 'private', ownerActorId: 'actor-A', conversationId: 'c-priv-a' }),
    ];
    const res = await agent.fetch(new Request('https://agent.test/rpc/session/new', { method: 'POST', headers: headersFor('actor-A') }));
    expect(res.status).toBe(200);
    const closed = sql.tables.get('agent_sessions')!.find((r) => r['ended_at'] != null);
    expect(closed).toBeDefined();
    const summary = String(closed?.['summary'] ?? '');
    expect(summary).toContain('pedido-coletivo-saldo-conta');
    // O privado de A (outra conversa) nunca entra no resumo da coletiva.
    expect(summary).not.toContain('segredo-privado-xyz');
  });
});

describe('R2 finding 2 — audiência capturada uma vez, turno inteiro', () => {
  it('normalizeRestTurn transporta a audiência capturada na entrada (server-side; body ignorado)', () => {
    const audience: MessageAudienceStamp = { visibility: 'private', ownerActorId: 'actor-A', conversationId: 'c-priv-a' };
    const input = normalizeRestTurn(
      { text: 'oi', intentionId: 'i-1', audience: { visibility: 'workspace', ownerActorId: 'intruso', conversationId: 'c-x' } } as never,
      { actorId: 'actor-A', workspaceId: 'ws-1', role: 'member', deviceId: null },
      { typedText: 'oi', audience },
    );
    expect((input as unknown as { audience?: unknown }).audience).toEqual(audience);
  });

  it('renovação nunca reescreve a audiência de turnos já persistidos', async () => {
    const sql = createSql();
    sql.tables.get('agent_sessions')!.push(openSessionRow());
    const agent = createAgent(sql, {});
    agent.messages = [
      userMsg('m-1', 'pergunta-c1', { actorId: 'actor-A', visibility: 'workspace', ownerActorId: 'actor-A', conversationId: 'c-col', createdAt: '2026-10-15T00:00:01.000Z' }),
    ];
    const res = await agent.fetch(new Request('https://agent.test/rpc/session/new', { method: 'POST', headers: headersFor('actor-A') }));
    expect(res.status).toBe(200);
    const stamped = agent.messages[0]?.['metadata'] as { conversationId?: unknown };
    expect(stamped.conversationId).toBe('c-col');
    const open = sql.tables.get('agent_sessions')!.find((r) => r['ended_at'] == null);
    expect(String(open?.['conversation_id'] ?? '')).not.toBe('c-col');
  });
});

describe('R2 finding 3 — erro de registry é fail-closed, nunca coletivo default', () => {
  it('conversationAudienceFor com leitura falhando lança agent.persistence_unavailable', () => {
    const sql = createSql();
    sql.failRegistryReads = true;
    const agent = createAgent(sql, {});
    let code: unknown;
    try {
      (agent as unknown as { conversationAudienceFor(ws: string, actor: string): unknown }).conversationAudienceFor('ws-1', 'actor-A');
    } catch (err) {
      code = (err as { code?: unknown }).code;
    }
    expect(code).toBe('agent.persistence_unavailable');
  });
});

describe('R2 finding 4 — ted/sistema/ausente nunca é proveniência humana', () => {
  it("mensagem legada atribuída a 'ted' = preservada-não-publicada", () => {
    expect(canAccessMessage({ actorId: 'actor-B', workspaceId: 'ws-1', meta: { workspaceId: 'ws-1', actorId: 'ted' } })).toBe(false);
    expect(canAccessMessage({ actorId: 'actor-A', workspaceId: 'ws-1', meta: { workspaceId: 'ws-1', actorId: 'assistant' } })).toBe(false);
    expect(canAccessMessage({ actorId: 'actor-A', workspaceId: 'ws-1', meta: { workspaceId: 'ws-1', actorId: '  ' } })).toBe(false);
    // Humano real segue coletivo.
    expect(canAccessMessage({ actorId: 'actor-B', workspaceId: 'ws-1', meta: { workspaceId: 'ws-1', actorId: 'actor-A' } })).toBe(true);
  });

  it("classifyLegacyAudience: 'ted'/sistema = preservado", () => {
    expect(classifyLegacyAudience({ actorId: 'ted' })).toBe('preserved-unpublished');
    expect(classifyLegacyAudience({ actorId: 'assistant' })).toBe('preserved-unpublished');
    expect(classifyLegacyAudience({ ownerActorId: 'ted' })).toBe('preserved-unpublished');
    expect(classifyLegacyAudience({ actorId: 'actor-A' })).toBe('collective-with-provenance');
  });

  it('legado migrado: assistant sem ator humano = preservado (privado sem dono)', () => {
    const out = transformLegacyMessages(
      [
        { id: 'l-a', role: 'assistant', content_json: JSON.stringify('resposta'), actor_id: '', created_at: '2026-01-01T00:00:00Z' },
        { id: 'l-b', role: 'assistant', content_json: JSON.stringify('resposta'), actor_id: 'ted', created_at: '2026-01-01T00:00:00Z' },
        { id: 'l-c', role: 'assistant', content_json: JSON.stringify('resposta'), actor_id: 'actor-A', created_at: '2026-01-01T00:00:00Z' },
      ],
      'ws-1',
      [],
    );
    const meta = (i: number) => out[i]?.metadata as { visibility?: string; ownerActorId?: string };
    expect(meta(0).visibility).toBe('private');
    expect(meta(0).ownerActorId ?? '').toBe('');
    expect(meta(1).visibility).toBe('private');
    expect(meta(1).ownerActorId ?? '').toBe('');
    // Proveniência humana verificável preserva o coletivo.
    expect(meta(2).visibility).toBe('workspace');
    expect(meta(2).ownerActorId).toBe('actor-A');
  });

  it("linha de sessão coletiva atribuída a 'ted' = invisível", () => {
    const row: ChatSession = {
      id: 's-1', workspaceId: 'ws-1', actorId: 'ted', startedAt: '2026-01-01T00:00:00Z',
      endedAt: '2026-01-02T00:00:00Z', messageCount: 1, summary: 'x',
      visibility: 'workspace', ownerActorId: 'ted', conversationId: 's-1',
    };
    expect(canAccessSessionRow('actor-A', row)).toBe(false);
  });
});

describe('R2 finding 5 — histórico ativo separado do arquivado por conversationId', () => {
  let sql: SqlMock;
  beforeEach(() => {
    sql = createSql();
  });

  it('/rpc/history serve SÓ a conversa aberta (+legado sem conversationId), sem apagar', async () => {
    sql.tables.get('agent_sessions')!.push(openSessionRow());
    const agent = createAgent(sql, {});
    agent.messages = [
      userMsg('m-active', 'turno-ativo-123', { actorId: 'actor-A', visibility: 'workspace', ownerActorId: 'actor-A', conversationId: 'c-col', createdAt: '2026-10-15T00:00:01.000Z' }),
      userMsg('m-arch', 'turno-arquivado-456', { actorId: 'actor-A', visibility: 'workspace', ownerActorId: 'actor-A', conversationId: 'c-old', createdAt: '2026-10-14T00:00:01.000Z' }),
      userMsg('m-leg', 'turno-legado-789', { actorId: 'actor-A', createdAt: '2026-10-13T00:00:01.000Z' }),
    ];
    const res = await agent.fetch(new Request('https://agent.test/rpc/history', { method: 'GET', headers: headersFor('actor-A') }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ content: string; conversationId?: string }> };
    const contents = body.items.map((i) => i.content);
    expect(contents).toContain('turno-ativo-123');
    expect(contents).toContain('turno-legado-789');
    expect(contents).not.toContain('turno-arquivado-456');
    // Separação endereçável pelo cliente.
    expect(body.items.find((i) => i.content === 'turno-ativo-123')?.conversationId).toBe('c-col');
    // Nada apagado: espelho intacto.
    expect(agent.messages.map((m) => m['id']).sort()).toEqual(['m-active', 'm-arch', 'm-leg']);
  });
});
