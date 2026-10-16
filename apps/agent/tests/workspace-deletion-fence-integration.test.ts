/**
 * FIX-WS-D2-FENCE — integração handler-level (janela attest→consume).
 *
 * Prova ponta a ponta no DO (fetch real, SQLite real descartável):
 * attest-empty 200 mantém o fence e todo caminho de escrita recusa 409
 * `agent.workspace_deletion_fenced`; não-vazio/expirado libera.
 */
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FinanceChatAgent } from '../src/finance-chat-agent.js';
import { initializeMemorySchema } from '../src/agent-config/memory/store.js';
import { initializeSessionSchema, currentSession } from '../src/agent-config/memory/sessions.js';
import { readWorkspaceDeletionFence, ensureWorkspaceDeletionFenceSchema } from '../src/workspace-deletion-fence.js';

const HMAC_SECRET = 'test-only-workspace-deletion-hmac-secret';
const SERVICE_TOKEN = 'test-service-token';
const WS_ID = '33333333-3333-4333-8333-333333333333';
const ACTOR = 'actor-fence';
const VERSION = 'b'.repeat(64);
const HANDLE = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

type TestAgent = FinanceChatAgent & {
  messages: unknown[];
  persistMessages: (msgs: unknown[]) => Promise<void>;
};

const createDbExec = (db: DatabaseSync) => ({
  exec<T>(query: string, ...bindings: unknown[]): Iterable<T> {
    const statement = db.prepare(query);
    if (/^\s*SELECT/i.test(query)) return statement.all(...(bindings as never[])) as T[];
    statement.run(...(bindings as never[]));
    return [] as T[];
  },
});

const setupAgent = () => {
  const db = new DatabaseSync(':memory:');
  const exec = createDbExec(db);
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
      WORKSPACE_DELETION_HMAC_SECRET: HMAC_SECRET,
      AGENT_AUTH_SERVICE_TOKEN: SERVICE_TOKEN,
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

describe('FENCE integração — attest→write recusado, delete dentro da janela', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ attestationId: HANDLE }), { status: 201 }),
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('attest 200 → chat/upload/prefs/session recusam 409 fenced; fence segue ativo', async () => {
    const { agent, exec } = setupAgent();
    const attest = await agent.fetch(
      new Request(`https://agent.test.local/rpc/workspace/${WS_ID}/attest-empty`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ inventoryVersion: VERSION }),
      }),
    );
    expect(attest.status).toBe(200);
    expect(((await attest.json()) as { attestationId?: string }).attestationId).toBe(HANDLE);

    // Delete consumiria dentro da janela: o fence segue ATIVO após o depósito.
    const fence = readWorkspaceDeletionFence(exec as never, WS_ID, Date.now());
    expect(fence).not.toBeNull();
    expect(Date.parse(fence!.expiresAt)).toBeGreaterThan(Date.now());

    // Todo caminho de escrita recusa fail-closed com erro tipado.
    const chat = await agent.fetch(
      new Request('https://agent.test.local/rpc/chat', {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'saldo da conta', intentionId: 'intent-fence-1' }),
      }),
    );
    expect(chat.status).toBe(409);
    expect(((await chat.json()) as { code?: string }).code).toBe('agent.workspace_deletion_fenced');

    const upload = await agent.fetch(
      new Request('https://agent.test.local/rpc/attachments', {
        method: 'POST',
        headers: { ...headers, 'x-attachment-kind': 'image', 'x-attachment-name': 'novo.png' },
        body: 'bytes',
      }),
    );
    expect(upload.status).toBe(409);
    expect(((await upload.json()) as { code?: string }).code).toBe('agent.workspace_deletion_fenced');

    const prefs = await agent.fetch(
      new Request('https://agent.test.local/rpc/memory/prefs', {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      }),
    );
    expect(prefs.status).toBe(409);
    expect(((await prefs.json()) as { code?: string }).code).toBe('agent.workspace_deletion_fenced');

    const sessionNew = await agent.fetch(
      new Request('https://agent.test.local/rpc/session/new', { method: 'POST', headers }),
    );
    expect(sessionNew.status).toBe(409);
    expect(((await sessionNew.json()) as { code?: string }).code).toBe('agent.workspace_deletion_fenced');

    // Perna SDK também recusa (nunca escreve).
    await expect(
      agent.onChatMessage({ text: 'saldo', intentionId: 'intent-fence-sdk', actorId: ACTOR, workspaceId: WS_ID }),
    ).rejects.toMatchObject({ code: 'agent.workspace_deletion_fenced' });
  });

  it('attest não-vazio → 409 sem assinar E fence limpo (escritas livres)', async () => {
    const { agent, exec } = setupAgent();
    currentSession(exec as never, WS_ID, ACTOR);
    const attest = await agent.fetch(
      new Request(`https://agent.test.local/rpc/workspace/${WS_ID}/attest-empty`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ inventoryVersion: VERSION }),
      }),
    );
    expect(attest.status).toBe(409);
    expect(((await attest.json()) as { code?: string }).code).toBe('agent.workspace_not_empty');
    // Sem handle não há delete: o fence foi LIMPO e a escrita segue livre.
    expect(readWorkspaceDeletionFence(exec as never, WS_ID, Date.now())).toBeNull();
    const prefs = await agent.fetch(
      new Request('https://agent.test.local/rpc/memory/prefs', {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      }),
    );
    expect(prefs.status).toBe(200);
  });

  it('fence expirado libera escrita (fail-open; API recusa handle expirado)', async () => {
    const { agent, db, exec } = setupAgent();
    ensureWorkspaceDeletionFenceSchema(exec as never);
    db.prepare(
      `INSERT INTO workspace_deletion_fence (workspace_id, epoch, expires_at) VALUES (?, ?, ?)`,
    ).run(WS_ID, 'epoch-expirado', new Date(Date.now() - 60_000).toISOString());
    const prefs = await agent.fetch(
      new Request('https://agent.test.local/rpc/memory/prefs', {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      }),
    );
    expect(prefs.status).toBe(200);
  });

  it('dreno: attest aguarda assentamento da fila antes do snapshot', async () => {
    const { agent } = setupAgent();
    const order: string[] = [];
    const inFlight = (async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 15));
      order.push('turn');
    })();
    (agent as unknown as { chatQueue: Promise<unknown> }).chatQueue = inFlight;
    await (agent as unknown as { drainDeletionFenceTurns: (limitMs?: number) => Promise<void> }).drainDeletionFenceTurns();
    order.push('snapshot');
    await inFlight;
    // O snapshot só correu depois do assentamento do turno em voo.
    expect(order).toEqual(['turn', 'snapshot']);
  });
});
