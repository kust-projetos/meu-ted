import { describe, expect, it, vi } from 'vitest';
import type { UIMessage } from 'agents/ai-chat-agent';
import {
  computeHistoryHash,
  type LegacyFullExport,
} from '../src/migration/legacy-history.js';
import { FinanceChatAgent } from '../src/finance-chat-agent.js';

describe('Legacy History Migration into FinanceChatAgent (T4.3: import surface only)', () => {
  // T4.3 (SPEC section 11 E4): the gateway migration gate and the retired
  // message route are gone, so the worker-level fail-closed cases (2) and
  // the retired-route passthrough case (4) were retired with them. What
  // stays valid — and stays here — is the import proof: the idempotent
  // re-import (1), the structural hash (3) and the fail-safe persist
  // contract (5).

  const sampleExport: LegacyFullExport = {    version: 1,
    workspaceId: 'ws-test-123',
    turns: [
      { id: 'turn-1', actor_id: 'user-a', status: 'completed', attempts: 1, tokens_used: 10 },
      { id: 'turn-2', actor_id: 'user-b', status: 'completed', attempts: 1, tokens_used: 15 },
    ],
    messages: [
      {
        id: 'msg-1',
        actor_id: 'user-a',
        role: 'user',
        content_json: JSON.stringify('Olá TED, qual meu saldo? api_key: secret-abc123'),
        created_at: '2026-08-20T10:00:00.000Z',
      },
      {
        id: 'msg-1:assistant',
        actor_id: 'agent',
        role: 'assistant',
        content_json: JSON.stringify('Seu saldo é R$ 1.500,00.'),
        created_at: '2026-08-20T10:00:01.000Z',
      },
      {
        id: 'msg-2',
        actor_id: 'user-b',
        role: 'user',
        content_json: JSON.stringify('E as contas de amanhã?'),
        created_at: '2026-08-20T10:05:00.000Z',
      },
    ],
    hasInFlightTurns: false,
  };

  const createMockSql = () => {
    const memory = new Map<string, Array<Record<string, unknown>>>();
    const executedQueries: string[] = [];
    return {
      executedQueries,
      exec: <T = Record<string, unknown>>(query: string, ...params: unknown[]): Iterable<T> => {
        executedQueries.push(query);
        if (query.includes('CREATE TABLE')) return [] as Iterable<T>;
        if (query.includes('SELECT migration_hash')) {
          const rows = memory.get('_history_migration_marker') ?? [];
          return rows as unknown as Iterable<T>;
        }
        if (query.includes('INSERT INTO _history_migration_marker')) {
          const [workspace_id, migration_hash, imported_count] = params as [string, string, number];
          memory.set('_history_migration_marker', [{ workspace_id, migration_hash, imported_count }]);
          return [] as Iterable<T>;
        }
        return [] as Iterable<T>;
      },
    };
  };

  it('(1) FinanceChatAgent.importLegacyHistory real persists UIMessage v5 strictly with parts & server-side metadata, and GET /rpc/history sorts chronologically by metadata.createdAt even when this.messages is reversed', async () => {
    const mockSql = createMockSql();
    const persistedMessages: UIMessage[] = [];

    const agent = Object.create(FinanceChatAgent.prototype) as FinanceChatAgent & {
      messages: UIMessage[];
      persistMessages: (msgs: UIMessage[]) => Promise<void>;
    };
    agent.messages = persistedMessages;
    agent.persistMessages = vi.fn(async (msgs: UIMessage[]) => {
      persistedMessages.push(...msgs);
    });

    Object.defineProperty(agent, 'ctx', {
      value: { storage: { sql: mockSql } },
      writable: true,
      configurable: true,
    });

    const res = await agent.importLegacyHistory(sampleExport);
    expect(res.success).toBe(true);
    expect(res.importedCount).toBe(3);

    expect(persistedMessages).toHaveLength(3);
    for (const msg of persistedMessages) {
      // Must NOT have non-canonical top-level fields
      expect(msg).not.toHaveProperty('content');
      expect(msg).not.toHaveProperty('text');
      expect(msg).not.toHaveProperty('actorId');
      expect(msg).not.toHaveProperty('createdAt');
      // Must have canonical UIMessage fields
      expect(msg).toHaveProperty('id');
      expect(msg).toHaveProperty('role');
      expect(msg).toHaveProperty('parts');
      expect(msg).toHaveProperty('metadata');
      expect(msg.metadata).toHaveProperty('actorId');
      expect(msg.metadata).toHaveProperty('workspaceId');
      expect(msg.metadata).toHaveProperty('createdAt');
    }

    // Now deliberately reverse order in agent.messages to test sorting
    agent.messages = [...persistedMessages].reverse();

    const historyReq = new Request('https://agent.test.local/rpc/history', {
      method: 'GET',
      headers: {
        'x-agent-actor': 'user-a',
        'x-agent-workspace': 'ws-test-123',
      },
    });

    const historyRes = await agent.fetch(historyReq);
    expect(historyRes.status).toBe(200);
    const body = (await historyRes.json()) as { items: Array<{ id: string; createdAt?: string }> };
    expect(body.items).toHaveLength(3);
    // Chronological order verification
    expect(body.items[0]!.id).toBe('msg-1');
    expect(body.items[1]!.id).toBe('msg-1:assistant');
    expect(body.items[2]!.id).toBe('msg-2');
  });

  it('(3) structural JSON hash prevents delimiter collision in content_json values', () => {
    // Delimiter collision test: If hash used naive `${id}:${actor}:${role}:${created_at}:${content}` with ':' or '|'
    const msgA = [
      {
        id: 'msg-1:user-a',
        actor_id: 'user',
        role: 'user',
        created_at: '2026-08-20',
        content_json: 'hello',
      },
      {
        id: 'msg-2',
        actor_id: 'user-b',
        role: 'user',
        created_at: '2026-08-20',
        content_json: 'world',
      },
    ];

    const msgB = [
      {
        id: 'msg-1',
        actor_id: 'user-a:user',
        role: 'user',
        created_at: '2026-08-20',
        content_json: 'hello',
      },
      {
        id: 'msg-2',
        actor_id: 'user-b',
        role: 'user',
        created_at: '2026-08-20',
        content_json: 'world',
      },
    ];

    const hashA = computeHistoryHash(msgA);
    const hashB = computeHistoryHash(msgB);
    expect(hashA).not.toBe(hashB);
  });

  it('(5) RED: FinanceChatAgent.importLegacyHistory fails safely with error if persistMessages is absent rather than mutating in-memory array', async () => {
    const persistedMessages: UIMessage[] = [];
    const agent = Object.create(FinanceChatAgent.prototype) as FinanceChatAgent & {
      messages: UIMessage[];
    };
    agent.messages = persistedMessages;
    (agent as unknown as { persistMessages: unknown }).persistMessages = undefined;

    const res = await agent.importLegacyHistory(sampleExport);
    expect(res.success).toBe(false);
    expect(res.reason).toContain('missing_persist_callback');
    // Ensure memory messages array was not mutated as fallback
    expect(agent.messages).toHaveLength(0);
  });
});
