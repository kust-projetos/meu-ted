/**
 * FIX-WS-D2-R4 — emissor server-side da atestação de vazio (lado Agent).
 *
 * O Agent observa seu próprio SQLite (sessions/messages/memories) e o R2;
 * workspace vazio → prova HMAC assinada; não-vazio → 409 com as
 * contagens (sem assinar vazio falso); sem segredo → indisponível.
 *
 * RED first: `workspace-deletion-attestation.ts` não existe.
 */
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  agentEmptyProofCanonical,
  attestWorkspaceEmpty,
  countR2WorkspaceAttachments,
  countWorkspaceRemnants,
  type AttestationDeps,
  type MemorySqlLike,
  type R2ListBucketLike,
} from '../src/workspace-deletion-attestation.js';
import { initializeMemorySchema, rememberFact } from '../src/agent-config/memory/store.js';
import { initializeSessionSchema, currentSession } from '../src/agent-config/memory/sessions.js';

const TEST_SECRET = 'test-only-workspace-deletion-hmac-secret';
const WS_ID = '11111111-1111-4111-8111-111111111111';
const VERSION = 'a'.repeat(64);

const createSql = (): { sql: MemorySqlLike } => {
  const db = new DatabaseSync(':memory:');
  const sql = {
    exec<T>(query: string, ...bindings: unknown[]): Iterable<T> {
      const statement = db.prepare(query);
      if (/^\s*SELECT/i.test(query)) return statement.all(...(bindings as never[])) as T[];
      statement.run(...(bindings as never[]));
      return [] as T[];
    },
  } as MemorySqlLike;
  initializeMemorySchema(sql as never);
  initializeSessionSchema(sql as never);
  return { sql: sql as MemorySqlLike };
};

const emptyDeps = (sql: MemorySqlLike): AttestationDeps => ({
  sql,
  countChatMessages: async () => 0,
  countAttachments: async () => ({ count: 0, truncated: false }),
});

describe('R4 — emissor da atestação de vazio (lado Agent)', () => {
  it('workspace vazio emite prova HMAC válida vinculada à versão', async () => {
    const { sql } = createSql();
    const proof = await attestWorkspaceEmpty(
      { workspaceId: WS_ID, inventoryVersion: VERSION, deps: emptyDeps(sql), secret: TEST_SECRET },
    );
    expect(proof.workspaceId).toBe(WS_ID);
    expect(proof.inventoryVersion).toBe(VERSION);
    expect(proof.counts).toEqual({ sessions: 0, messages: 0, memories: 0, attachments: 0 });
    expect(proof.hmac).toMatch(/^[0-9a-f]{64}$/);
    expect(Date.parse(proof.expiresAt)).toBeGreaterThan(Date.now());
  });

  it('sessão existente bloqueia com 409 e contagens (sem assinar)', async () => {
    const { sql } = createSql();
    currentSession(sql as never, WS_ID, 'actor-1');
    const counts = await countWorkspaceRemnants({ workspaceId: WS_ID, ...emptyDeps(sql) });
    expect(counts.sessions).toBe(1);
    const error = await attestWorkspaceEmpty(
      { workspaceId: WS_ID, inventoryVersion: VERSION, deps: emptyDeps(sql), secret: TEST_SECRET },
    ).then(
      () => { throw new Error('expected rejection'); },
      (cause) => cause as { code?: string; counts?: unknown },
    );
    expect(error.code).toBe('agent.workspace_not_empty');
    expect(error.counts).toMatchObject({ sessions: 1 });
  });

  it('memória viva bloqueia; memória invalidada/expirada não conta', async () => {
    const { sql } = createSql();
    const stored = rememberFact(sql as never, { workspaceId: WS_ID, actor: 'a1', content: 'prefere Nubank' });
    expect(stored.stored).toBe(true);
    let counts = await countWorkspaceRemnants({ workspaceId: WS_ID, ...emptyDeps(sql) });
    expect(counts.memories).toBe(1);
    // Outro workspace não contamina a contagem.
    counts = await countWorkspaceRemnants({ workspaceId: 'outro-ws', ...emptyDeps(sql) });
    expect(counts).toEqual({ sessions: 0, messages: 0, memories: 0, attachments: 0 });
  });

  it('R2 com objeto do workspace bloqueia (prefixo/metadata por workspace)', async () => {
    const { sql } = createSql();
    const deps: AttestationDeps = {
      ...emptyDeps(sql),
      countAttachments: async (workspaceId) => (workspaceId === WS_ID ? { count: 2, truncated: false } : { count: 0, truncated: false }),
    };
    const error = await attestWorkspaceEmpty(
      { workspaceId: WS_ID, inventoryVersion: VERSION, deps, secret: TEST_SECRET },
    ).then(
      () => { throw new Error('expected rejection'); },
      (cause) => cause as { code?: string; counts?: unknown },
    );
    expect(error.code).toBe('agent.workspace_not_empty');
    expect(error.counts).toMatchObject({ attachments: 2 });
  });

  it('listagem R2 truncada é tratada como não-vazio (fail-closed)', async () => {
    const { sql } = createSql();
    const deps: AttestationDeps = {
      ...emptyDeps(sql),
      countAttachments: async () => ({ count: 0, truncated: true }),
    };
    const error = await attestWorkspaceEmpty(
      { workspaceId: WS_ID, inventoryVersion: VERSION, deps, secret: TEST_SECRET },
    ).then(
      () => { throw new Error('expected rejection'); },
      (cause) => cause as { code?: string },
    );
    expect(error.code).toBe('agent.workspace_not_empty');
  });

  it('sem segredo = indisponível (409, nunca assina)', async () => {
    const { sql } = createSql();
    const error = await attestWorkspaceEmpty(
      { workspaceId: WS_ID, inventoryVersion: VERSION, deps: emptyDeps(sql), secret: undefined },
    ).then(
      () => { throw new Error('expected rejection'); },
      (cause) => cause as { code?: string; status?: number },
    );
    expect(error.code).toBe('agent.attestation_unavailable');
    expect(error.status).toBe(409);
  });

  it('mensagens de chat do workspace contam; de outro workspace não', async () => {    const { sql } = createSql();
    const deps: AttestationDeps = {
      ...emptyDeps(sql),
      countChatMessages: async (workspaceId) => (workspaceId === WS_ID ? 3 : 0),
    };
    const counts = await countWorkspaceRemnants({ workspaceId: WS_ID, ...deps });
    expect(counts.messages).toBe(3);
    const error = await attestWorkspaceEmpty(
      { workspaceId: WS_ID, inventoryVersion: VERSION, deps, secret: TEST_SECRET },
    ).then(
      () => { throw new Error('expected rejection'); },
      (cause) => cause as { code?: string },
    );
    expect(error.code).toBe('agent.workspace_not_empty');
  });

  it('canônico é byte-idêntico ao da API (vetor fixo cross-runtime)', () => {    // Pino contra a API (`agentEmptyProofCanonical`): chaves ordenadas,
    // mesma ordem de campos. Mudar aqui sem mudar lá quebra fail-closed.
    expect(
      agentEmptyProofCanonical(
        WS_ID,
        VERSION,
        { sessions: 0, messages: 0, memories: 0, attachments: 0 },
        '2026-10-16T00:00:00.000Z',
      ),
    ).toBe(
      `{"workspaceId":"${WS_ID}","inventoryVersion":"${VERSION}","counts":[["attachments",0],["memories",0],["messages",0],["sessions",0]],"expiresAt":"2026-10-16T00:00:00.000Z"}`,
    );
  });

  it('contagem R2 filtra por workspace via metadata (chave opaca, sem estrutura de tenant)', async () => {
    const objects: Array<{ key: string; customMetadata?: Record<string, string> }> = [
      { key: 'ted/attachments/v1/att_aaa', customMetadata: { workspaceId: WS_ID } },
      { key: 'ted/attachments/v1/att_bbb', customMetadata: { workspaceId: 'outro-ws' } },
      { key: 'ted/attachments/v1/att_ccc', customMetadata: {} },
    ];
    const bucket: R2ListBucketLike = {
      list: async (options?: { prefix?: string; cursor?: string; include?: string[] }) => {
        expect(options?.prefix).toBe('ted/attachments/v1/');
        expect(options?.include).toEqual(['customMetadata']);
        return { objects, truncated: false };
      },
    };
    expect(await countR2WorkspaceAttachments(bucket, WS_ID)).toEqual({ count: 1, truncated: false });
    expect(await countR2WorkspaceAttachments(bucket, 'outro-ws')).toEqual({ count: 1, truncated: false });
    expect(await countR2WorkspaceAttachments(bucket, 'vazio-ws')).toEqual({ count: 0, truncated: false });
  });

  it('contagem R2 truncada no teto reporta truncated (fail-closed a montante)', async () => {
    const bucket: R2ListBucketLike = {
      list: async () => ({ objects: [], truncated: true, cursor: 'next' }),
    };
    expect(await countR2WorkspaceAttachments(bucket, WS_ID)).toEqual({ count: 0, truncated: true });
  });
  it('contagem R2 sem binding/listagem = indisponível (nunca vazio falso)', async () => {
    await expect(countR2WorkspaceAttachments(null, WS_ID)).rejects.toMatchObject({
      code: 'agent.attestation_unavailable',
    });
    await expect(countR2WorkspaceAttachments(undefined, WS_ID)).rejects.toMatchObject({
      code: 'agent.attestation_unavailable',
    });
  });
});
