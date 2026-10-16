/**
 * FIX-WS-D2-FENCE R2 — regressão dos 5 findings do REVIEW-WS-D2-FENCE.
 *
 * RED first: cada item falha contra o código atual (admissão sem lease,
 * TTL próprio da prova, upsert cego, writers sem guarda, leitura fail-open).
 * GREEN: fence module + agent corrigidos (ver commits da branch).
 */
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FinanceChatAgent } from '../src/finance-chat-agent.js';
import { initializeMemorySchema } from '../src/agent-config/memory/store.js';
import { initializeSessionSchema } from '../src/agent-config/memory/sessions.js';
import {
  assertNoActiveWorkspaceDeletionFence,
  clearWorkspaceDeletionFence,
  installWorkspaceDeletionFence,
  readWorkspaceDeletionFence,
  type WorkspaceDeletionFenceSqlLike,
} from '../src/workspace-deletion-fence.js';
import { attestWorkspaceEmpty } from '../src/workspace-deletion-attestation.js';

const WS_ID = '44444444-4444-4444-8444-444444444444';
const ACTOR = 'actor-fence-r2';
const DEVICE = 'device-fence-r2';
const VERSION = 'c'.repeat(64);
const HANDLE = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
const SECRET = 'test-only-fence-r2-secret';

const createSql = (): WorkspaceDeletionFenceSqlLike => {
  const db = new DatabaseSync(':memory:');
  const sql = {
    exec<T>(query: string, ...bindings: unknown[]): Iterable<T> {
      const statement = db.prepare(query);
      if (/^\s*SELECT/i.test(query)) return statement.all(...(bindings as never[])) as T[];
      statement.run(...(bindings as never[]));
      return [] as T[];
    },
  } as WorkspaceDeletionFenceSqlLike;
  return sql;
};

const throwingSql = (): WorkspaceDeletionFenceSqlLike =>
  ({
    exec<T>(): Iterable<T> {
      throw new Error('storage outage');
    },
  }) as WorkspaceDeletionFenceSqlLike;

type TestAgent = FinanceChatAgent & {
  messages: unknown[];
  persistMessages: (msgs: unknown[]) => Promise<void>;
};

const setupAgent = (overrides?: {
  exec?: { exec<T>(query: string, ...bindings: unknown[]): Iterable<T> };
  env?: Record<string, unknown>;
}) => {
  const db = new DatabaseSync(':memory:');
  const exec =
    overrides?.exec ??
    ({
      exec<T>(query: string, ...bindings: unknown[]): Iterable<T> {
        const statement = db.prepare(query);
        if (/^\s*SELECT/i.test(query)) return statement.all(...(bindings as never[])) as T[];
        statement.run(...(bindings as never[]));
        return [] as T[];
      },
    });
  db.prepare(`CREATE TABLE IF NOT EXISTS cf_ai_chat_agent_messages (message TEXT)`).run();
  try {
    initializeMemorySchema(exec as never);
    initializeSessionSchema(exec as never);
  } catch {
    // Outage simulado: schema nunca inicializa; o agente deve recusar fail-closed.
  }
  const agent = Object.create(FinanceChatAgent.prototype) as TestAgent;
  agent.messages = [];
  agent.persistMessages = vi.fn(async () => {});
  Object.defineProperty(agent, 'ctx', {
    value: { storage: { sql: exec } },
    writable: true,
    configurable: true,
  });
  Object.defineProperty(agent, 'env', {
    value: {
      API_ORIGIN: 'https://api.example.test',
      WORKSPACE_DELETION_HMAC_SECRET: SECRET,
      AGENT_AUTH_SERVICE_TOKEN: 'test-service-token',
      AGENT_DELEGATION_SECRET: 'test-delegation-secret',
      TED_ATTACHMENTS_BUCKET: {
        list: async () => ({ objects: [], truncated: false }),
      },
      ...(overrides?.env ?? {}),
    },
    writable: true,
    configurable: true,
  });
  return { agent, db, exec };
};

describe('R2 finding 2 — TTL: prova herda o expiresAt do fence (deadline único)', () => {
  it('attestWorkspaceEmpty com expiresAt do fence emite a prova com o MESMO deadline', async () => {
    const sql = createSql();
    initializeMemorySchema(sql as never);
    initializeSessionSchema(sql as never);
    const fence = installWorkspaceDeletionFence(sql, WS_ID, Date.now());
    const proof = await attestWorkspaceEmpty(
      {
        workspaceId: WS_ID,
        inventoryVersion: VERSION,
        deps: {
          sql: sql as never,
          countChatMessages: async () => 0,
          countAttachments: async () => ({ count: 0, truncated: false }),
        },
        secret: SECRET,
        expiresAt: fence.expiresAt,
      },
      Date.now(),
    );
    // A prova nunca sobrevive ao fence: deadline compartilhado, não relógio novo.
    expect(proof.expiresAt).toBe(fence.expiresAt);
  });
});

describe('R2 finding 3 — epoch: install preserva, release/remove condicionais', () => {
  it('R3: segunda tentativa com fence válido é RECUSADA (nunca compartilha o epoch)', () => {
    const sql = createSql();
    const now = Date.now();
    const first = installWorkspaceDeletionFence(sql, WS_ID, now);
    const error = (() => {
      try {
        installWorkspaceDeletionFence(sql, WS_ID, now + 1000);
        throw new Error('expected rejection');
      } catch (cause) {
        return cause as { code?: string; status?: number; name?: string };
      }
    })();
    expect(error.code).toBe('agent.deletion_fence_active');
    expect(error.status).toBe(409);
    // O fence de A segue intacto: a tentativa recusada não tocou na geração.
    const intact = readWorkspaceDeletionFence(sql, WS_ID, now + 1000);
    expect(intact?.epoch).toBe(first.epoch);
    expect(intact?.expiresAt).toBe(first.expiresAt);
  });

  it('clear com epoch divergente NÃO limpa fence alheio/válido; com epoch igual limpa', () => {
    const sql = createSql();
    const now = Date.now();
    const fence = installWorkspaceDeletionFence(sql, WS_ID, now);
    clearWorkspaceDeletionFence(sql, WS_ID, 'epoch-de-outra-tentativa');
    expect(readWorkspaceDeletionFence(sql, WS_ID, now)).not.toBeNull();
    clearWorkspaceDeletionFence(sql, WS_ID, fence.epoch);
    expect(readWorkspaceDeletionFence(sql, WS_ID, now)).toBeNull();
  });
});

describe('R2 finding 5 — leitura: ausente/expirado libera, erro de leitura recusa', () => {
  it('outage de leitura lança indisponível (nunca fail-open)', () => {
    const sql = throwingSql();
    const error = (() => {
      try {
        readWorkspaceDeletionFence(sql, WS_ID, Date.now());
        throw new Error('expected rejection');
      } catch (cause) {
        return cause as { code?: string; status?: number };
      }
    })();
    expect(error.code).toBe('agent.persistence_unavailable');
    expect(error.status).toBe(503);
    expect(() => assertNoActiveWorkspaceDeletionFence(sql, WS_ID, Date.now())).toThrowError();
  });

  it('writer com storage em outage recusa 503 indisponível (não escreve)', async () => {
    const { agent } = setupAgent({ exec: throwingSql() });
    const res = await agent.fetch(
      new Request('https://agent.test.local/rpc/memory/prefs', {
        method: 'POST',
        headers: {
          'x-agent-actor': ACTOR,
          'x-agent-workspace': WS_ID,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ enabled: false }),
      }),
    );
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code?: string }).code).toBe('agent.persistence_unavailable');
  });
});

describe('R2 finding 1 — admissão: lease antes do primeiro await; attest recusa sem assentamento', () => {
  it('admitido-antes/escreve-depois: drain com writer em voo estoura o limite (attest recusaria)', async () => {
    const { agent } = setupAgent();
    const release = (
      agent as unknown as { admitDeletionFenceWrite: () => () => void }
    ).admitDeletionFenceWrite();
    try {
      const drained = await (
        agent as unknown as { drainDeletionFenceTurns: (limitMs?: number) => Promise<boolean> }
      ).drainDeletionFenceTurns(20);
      expect(drained).toBe(false);
    } finally {
      release();
    }
    const settled = await (
      agent as unknown as { drainDeletionFenceTurns: (limitMs?: number) => Promise<boolean> }
    ).drainDeletionFenceTurns(1000);
    expect(settled).toBe(true);
  });

  it('upload revalida o fence APÓS ler o corpo, antes de ingerir', async () => {
    const r2Objects = new Map<string, { bytes: ArrayBuffer; customMetadata?: Record<string, string> }>();
    const r2Bucket = {
      list: async () => ({ objects: [], truncated: false }),
      put: async (key: string, bytes: ArrayBuffer) => {
        r2Objects.set(key, { bytes });
      },
      get: async () => null,
      delete: async () => {},
    };
    const { agent, exec } = setupAgent({
      env: {
        TED_ATTACHMENTS_ENABLED: '1',
        TED_ATTACHMENTS_COHORT: '*',
        TED_ATTACHMENTS_BUCKET: r2Bucket,
      },
    });
    let resolveBody!: (value: ArrayBuffer) => void;
    const bodyReady = new Promise<ArrayBuffer>((resolve) => {
      resolveBody = resolve;
    });
    const fakeRequest = {
      headers: new Headers({
        'x-agent-actor': ACTOR,
        'x-agent-workspace': WS_ID,
        'x-ted-attachment-kind': 'image',
        'x-ted-attachment-name': 'foto.png',
      }),
      arrayBuffer: () => bodyReady,
    };
    const pending = (agent as unknown as { handleAttachmentUpload: (r: unknown) => Promise<Response> }).handleAttachmentUpload(
      fakeRequest,
    );
    // Fence instalado DURANTE a leitura do corpo (após o check de admissão).
    installWorkspaceDeletionFence(exec as never, WS_ID, Date.now());
    resolveBody(new ArrayBuffer(8));
    const res = await pending;
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code?: string }).code).toBe('agent.workspace_deletion_fenced');
  });
});

describe('R2 finding 4 — writers restantes com guarda', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ attestationId: HANDLE }), { status: 201 }),
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('handleUndoDecision com fence recusa 409 fenced (nunca decide)', async () => {
    const { agent, exec } = setupAgent();
    installWorkspaceDeletionFence(exec as never, WS_ID, Date.now());
    const res = await agent.fetch(
      new Request('https://agent.test.local/rpc/undo/decision', {
        method: 'POST',
        headers: {
          'x-agent-actor': ACTOR,
          'x-agent-workspace': WS_ID,
          'x-agent-device': DEVICE,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ decision: 'cancel', requestId: 'undo-fence-1' }),
      }),
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code?: string }).code).toBe('agent.workspace_deletion_fenced');
  });

  it('handleApprovalDecision com fence recusa 409 fenced (nunca decide)', async () => {
    const { agent, exec } = setupAgent();
    installWorkspaceDeletionFence(exec as never, WS_ID, Date.now());
    const res = await (
      agent as unknown as { handleApprovalDecision: (r: Request) => Promise<Response> }
    ).handleApprovalDecision(
      new Request('https://agent.test.local/rpc/pending-operations/op-1/decision', {
        method: 'POST',
        headers: {
          'x-agent-connection-token': 'token-fence-r2',
          'x-agent-actor': ACTOR,
          'x-agent-workspace': WS_ID,
          'x-agent-device': DEVICE,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ decision: 'cancel', requestId: 'approval-fence-1' }),
      }),
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code?: string }).code).toBe('agent.workspace_deletion_fenced');
  });

  it('importLegacyHistory com fence não persiste nada (fail-closed)', async () => {
    const { agent, exec } = setupAgent();
    installWorkspaceDeletionFence(exec as never, WS_ID, Date.now());
    const persist = agent.persistMessages as unknown as ReturnType<typeof vi.fn>;
    const result = await agent.importLegacyHistory({
      workspaceId: WS_ID,
      messages: [],
      turns: [],
    } as never);
    expect(result.success).toBe(false);
    expect(String((result as { reason?: string }).reason ?? '')).toContain(
      'agent.workspace_deletion_fenced',
    );
    expect(persist).not.toHaveBeenCalled();
  });
});
