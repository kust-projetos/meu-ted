/**
 * FIX-WS-D2-FENCE R3 — regressão do HIGH residual do REVIEW-WS-D2-FENCE-R2.
 *
 * Tentativas concorrentes compartilhavam o epoch: B reutilizava o epoch de
 * A; se B falhasse, limpava o fence de A cujo handle seguia válido → a
 * janela reabria. R3: nova tentativa de attest com geração ATIVA é RECUSADA
 * fail-closed (409 `agent.deletion_fence_active`) em vez de compartilhar o
 * epoch; cada attest bem-sucedido é dono exclusivo da sua geração; cleanup
 * SEMPRE condicional ao epoch próprio.
 *
 * Cadeia: A sucede (200) → B é recusada (409 active, fence de A intacto) →
 * writer recusado (409 fenced) → após expiração, nova tentativa funciona.
 */
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FinanceChatAgent } from '../src/finance-chat-agent.js';
import { initializeMemorySchema } from '../src/agent-config/memory/store.js';
import { initializeSessionSchema } from '../src/agent-config/memory/sessions.js';
import {
  WORKSPACE_DELETION_FENCE_TTL_MS,
  clearWorkspaceDeletionFence,
  installWorkspaceDeletionFence,
  readWorkspaceDeletionFence,
  type WorkspaceDeletionFenceSqlLike,
} from '../src/workspace-deletion-fence.js';

const WS_ID = '55555555-5555-4555-8555-555555555555';
const ACTOR = 'actor-fence-r3';
const VERSION = 'd'.repeat(64);
const HANDLE_A = 'cccccccc-dddd-4eee-8fff-000000000001';

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

type TestAgent = FinanceChatAgent & {
  messages: unknown[];
  persistMessages: (msgs: unknown[]) => Promise<void>;
};

const setupAgent = () => {
  const db = new DatabaseSync(':memory:');
  const exec = {
    exec<T>(query: string, ...bindings: unknown[]): Iterable<T> {
      const statement = db.prepare(query);
      if (/^\s*SELECT/i.test(query)) return statement.all(...(bindings as never[])) as T[];
      statement.run(...(bindings as never[]));
      return [] as T[];
    },
  };
  db.prepare(`CREATE TABLE IF NOT EXISTS cf_ai_chat_agent_messages (message TEXT)`).run();
  initializeMemorySchema(exec as never);
  initializeSessionSchema(exec as never);
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
      WORKSPACE_DELETION_HMAC_SECRET: 'test-only-fence-r3-secret',
      AGENT_AUTH_SERVICE_TOKEN: 'test-service-token',
      TED_ATTACHMENTS_BUCKET: {
        list: async () => ({ objects: [], truncated: false }),
      },
    },
    writable: true,
    configurable: true,
  });
  return { agent, db, exec };
};

const headers = {
  'x-agent-actor': ACTOR,
  'x-agent-workspace': WS_ID,
};

const attest = (agent: TestAgent) =>
  agent.fetch(
    new Request(`https://agent.test.local/rpc/workspace/${WS_ID}/attest-empty`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ inventoryVersion: VERSION }),
    }),
  );

describe('R3 — geração exclusiva: B recusada nunca limpa o fence de A', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ attestationId: HANDLE_A }), { status: 201 }),
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('A sucede → B recusada 409 active → fence de A intacto → writer recusado', async () => {
    const { agent, exec } = setupAgent();

    const resA = await attest(agent);
    expect(resA.status).toBe(200);
    expect(((await resA.json()) as { attestationId?: string }).attestationId).toBe(HANDLE_A);
    const fenceA = readWorkspaceDeletionFence(exec as never, WS_ID, Date.now());
    expect(fenceA).not.toBeNull();

    // B: nova tentativa com geração ATIVA é recusada fail-closed — sem
    // compartilhar o epoch, sem limpar nada.
    const resB = await attest(agent);
    expect(resB.status).toBe(409);
    expect(((await resB.json()) as { code?: string }).code).toBe('agent.deletion_fence_active');

    // O fence de A segue intacto (mesma geração): a falha de B não reabriu
    // a janela do handle válido de A.
    const intact = readWorkspaceDeletionFence(exec as never, WS_ID, Date.now());
    expect(intact?.epoch).toBe(fenceA!.epoch);
    expect(intact?.expiresAt).toBe(fenceA!.expiresAt);

    // Writer segue recusado pela geração de A.
    const prefs = await agent.fetch(
      new Request('https://agent.test.local/rpc/memory/prefs', {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      }),
    );
    expect(prefs.status).toBe(409);
    expect(((await prefs.json()) as { code?: string }).code).toBe('agent.workspace_deletion_fenced');
  });

  it('após expiração, nova tentativa instala geração nova e funciona', async () => {
    const { agent, db, exec } = setupAgent();

    const resA = await attest(agent);
    expect(resA.status).toBe(200);
    const fenceA = readWorkspaceDeletionFence(exec as never, WS_ID, Date.now());
    expect(fenceA).not.toBeNull();

    // Expira a geração de A diretamente no storage descartável.
    db.prepare(`UPDATE workspace_deletion_fence SET expires_at = ? WHERE workspace_id = ?`).run(
      new Date(Date.now() - 60_000).toISOString(),
      WS_ID,
    );

    const resC = await attest(agent);
    expect(resC.status).toBe(200);
    const fenceC = readWorkspaceDeletionFence(exec as never, WS_ID, Date.now());
    expect(fenceC).not.toBeNull();
    expect(fenceC!.epoch).not.toBe(fenceA!.epoch);
  });
});

describe('R3 — unidade: install recusa, clear sempre condicional', () => {
  it('install com fence válido lança active (409) e preserva a geração', () => {
    const sql = createSql();
    const now = Date.now();
    const first = installWorkspaceDeletionFence(sql, WS_ID, now);
    const error = (() => {
      try {
        installWorkspaceDeletionFence(sql, WS_ID, now + 1000);
        throw new Error('expected rejection');
      } catch (cause) {
        return cause as { code?: string; status?: number };
      }
    })();
    expect(error.code).toBe('agent.deletion_fence_active');
    expect(error.status).toBe(409);
    const intact = readWorkspaceDeletionFence(sql, WS_ID, now + 1000);
    expect(intact?.epoch).toBe(first.epoch);
  });

  it('clear com epoch divergente não limpa; com epoch próprio limpa', () => {
    const sql = createSql();
    const now = Date.now();
    const fence = installWorkspaceDeletionFence(sql, WS_ID, now);
    clearWorkspaceDeletionFence(sql, WS_ID, 'epoch-de-outra-tentativa');
    expect(readWorkspaceDeletionFence(sql, WS_ID, now)?.epoch).toBe(fence.epoch);
    clearWorkspaceDeletionFence(sql, WS_ID, fence.epoch);
    expect(readWorkspaceDeletionFence(sql, WS_ID, now)).toBeNull();
  });

  it('expiração libera nova geração (TTL nomeado de 5min)', () => {
    expect(WORKSPACE_DELETION_FENCE_TTL_MS).toBe(5 * 60 * 1000);
    const sql = createSql();
    const now = Date.now();
    const first = installWorkspaceDeletionFence(sql, WS_ID, now);
    const after = now + WORKSPACE_DELETION_FENCE_TTL_MS + 1000;
    expect(readWorkspaceDeletionFence(sql, WS_ID, after)).toBeNull();
    const fresh = installWorkspaceDeletionFence(sql, WS_ID, after);
    expect(fresh.epoch).not.toBe(first.epoch);
  });
});
