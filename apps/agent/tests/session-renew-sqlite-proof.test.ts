/**
 * Issue #177 — prova SQLite real da renovação D3 (`POST /rpc/session/new`).
 *
 * Complementa `session-renew-privacy.test.ts` (mock sequencial com
 * `transactionSync` por snapshot em memória) com o motor real
 * (`node:sqlite` + `transactionSync` via `BEGIN IMMEDIATE/COMMIT/ROLLBACK`,
 * precedente: `memory-forget-transactional.test.ts` R15):
 *
 * - RED-1: renovação concorrente A/B sobre o mesmo DB — 1 aberta por ator,
 *   tabela SDK intacta, visibility/owner/conversationId distintos.
 * - RED-2: injeção de falha no INSERT da nova sessão DEPOIS do fechamento
 *   (UPDATE) executar — `ok:false`/500 + rollback integral (a sessão de B
 *   segue aberta, bit-a-bit) + restart (nova instância sobre o mesmo DB)
 *   com history de A intacto. Falha no UPDATE ou no SELECT-open é
 *   fail-closed sem escrita prévia (cobertura, não prova de rollback).
 *   Prova ainda que o caminho de renovação NÃO depende de `persistMessages`
 *   (zero chamadas ali — stub contador, não só stub que lança — por desenho,
 *   sem mascaramento).
 * - RED-3: mensagens de A/B preparadas ANTES da renovação de B — history de
 *   A consultado imediatamente depois SEM reatribuir `agent.messages` (wipe
 *   do espelho na renovação falharia aqui); SDK (conteúdo) e espelho
 *   comparados; predicado isolado do escopo (privada de outro dono com
 *   conversationId no escopo de A é negada a A).
 *
 * Superfícies restantes (fora do caminho, documentadas no relatório):
 * - `onMessage` clearHistory/setMessages (finance-chat-agent.ts:2361-2368)
 *   é guarda do canal WS — recusa `agent.clear_forbidden`, nunca apaga.
 * - `listPastSessions`/`getSessionSummary` (sessions.ts:214-236) são
 *   legadas por-ator sem predicado D3: nenhum `src/` as chama (só
 *   `memory-sessions.test.ts`); o caminho vivo é `listVisiblePastSessions`/
 *   `getVisibleSessionSummary` via `memory/tools.ts:87,114`.
 */
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { FinanceChatAgent } from '../src/finance-chat-agent.js';
import { initializeSessionSchema } from '../src/agent-config/memory/sessions.js';
import { initializeMemorySchema } from '../src/agent-config/memory/store.js';

type Faults = {
  insertSessions?: boolean;
  updateSessions?: boolean;
  selectOpenSessions?: boolean;
};

type RealDb = {
  db: DatabaseSync;
  storage: {
    sql: { exec<T>(query: string, ...bindings: unknown[]): Iterable<T> };
    transactionSync<T>(fn: () => T): T;
  };
  queries: string[];
};

const createRealDb = (faults: Faults = {}): RealDb => {
  const db = new DatabaseSync(':memory:');
  const queries: string[] = [];
  const exec = <T>(query: string, ...bindings: unknown[]): Iterable<T> => {
    const q = query.trim().replace(/\s+/g, ' ');
    queries.push(q);
    if (faults.insertSessions && q.startsWith('INSERT INTO agent_sessions')) {
      throw new Error('fault: agent_sessions insert');
    }
    if (faults.updateSessions && q.startsWith('UPDATE agent_sessions SET ended_at')) {
      throw new Error('fault: agent_sessions update');
    }
    if (
      faults.selectOpenSessions &&
      q.startsWith('SELECT * FROM agent_sessions WHERE workspace_id = ? AND actor_id = ? AND ended_at IS NULL')
    ) {
      throw new Error('fault: agent_sessions select open');
    }
    const statement = db.prepare(query);
    if (/^\s*(SELECT|PRAGMA|WITH)/i.test(query)) {
      return statement.all(...(bindings as never[])) as T[];
    }
    statement.run(...(bindings as never[]));
    return [] as T[];
  };
  const transactionSync = <T>(fn: () => T): T => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Best-effort: o erro original é o que importa.
      }
      throw err;
    }
  };
  const storage = { sql: { exec }, transactionSync };
  initializeSessionSchema(storage.sql as never);
  initializeMemorySchema(storage.sql as never);
  db.exec(`CREATE TABLE IF NOT EXISTS cf_ai_chat_agent_messages (id TEXT PRIMARY KEY, message TEXT NOT NULL)`);
  return { db, storage, queries };
};

type UiMsg = Record<string, unknown>;

const uiMsg = (id: string, role: string, text: string, meta: Record<string, unknown> = {}): UiMsg => ({
  id,
  role,
  parts: [{ type: 'text', text }],
  metadata: {
    workspaceId: 'ws-1',
    createdAt: new Date('2026-10-16T10:00:00.000Z').toISOString(),
    ...meta,
  },
});

const seedSdkTable = (real: RealDb, messages: UiMsg[]): void => {
  for (const message of messages) {
    real.db.prepare(`INSERT INTO cf_ai_chat_agent_messages (id, message) VALUES (?, ?)`).run(
      String(message['id']),
      JSON.stringify(message),
    );
  }
};

const sdkIds = (real: RealDb): string[] =>
  (
    real.db.prepare(`SELECT id FROM cf_ai_chat_agent_messages ORDER BY id`).all() as unknown as Array<{
      id: string;
    }>
  ).map((row) => row.id);

// Conteúdo persistido integral (id + payload) — ids iguais com payload
// trocado/corrompido falham aqui, não só em `sdkIds`.
const sdkRows = (real: RealDb): Array<{ id: string; message: string }> =>
  (
    real.db.prepare(`SELECT id, message FROM cf_ai_chat_agent_messages ORDER BY id`).all() as unknown as Array<{
      id: string;
      message: string;
    }>
  ).map((row) => ({ id: row.id, message: row.message }));

const mirrorIds = (agent: { messages: UiMsg[] }): string[] =>
  agent.messages.map((m) => String(m['id']));

type TestAgent = Omit<FinanceChatAgent, 'messages'> & { messages: UiMsg[] };

const createAgent = (real: RealDb, messages: UiMsg[], env: Record<string, string> = {}): TestAgent => {
  const agent = Object.create(FinanceChatAgent.prototype) as TestAgent;
  Object.defineProperty(agent, 'ctx', { value: { storage: real.storage }, writable: true, configurable: true });
  Object.defineProperty(agent, 'env', { value: env, writable: true, configurable: true });
  agent.messages = messages;
  return agent;
};

const headersFor = (actor: string): Record<string, string> => ({
  'x-agent-actor': actor,
  'x-agent-workspace': 'ws-1',
});

const renew = (agent: TestAgent, actor: string) =>
  agent.fetch(new Request('https://agent.test/rpc/session/new', { method: 'POST', headers: headersFor(actor) }));

type SessionRow = {
  id: string;
  workspace_id: string;
  actor_id: string;
  ended_at: string | null;
  visibility: string;
  owner_actor_id: string;
  conversation_id: string;
};

const allSessions = (real: RealDb): SessionRow[] =>
  real.db.prepare(`SELECT * FROM agent_sessions`).all() as unknown as SessionRow[];

const openSessions = (real: RealDb): SessionRow[] =>
  real.db.prepare(`SELECT * FROM agent_sessions WHERE ended_at IS NULL`).all() as unknown as SessionRow[];

describe('issue #177 — prova SQLite real da renovação D3', () => {
  it('RED-1: A e B renovam em paralelo — 1 aberta por ator, SDK intacta, conversas distintas', async () => {
    const real = createRealDb();
    const messages: UiMsg[] = [
      uiMsg('m-a1', 'user', 'Saldo da conta Nubank', { actorId: 'actor-A' }),
      uiMsg('m-b1', 'user', 'Extrato do cartão', { actorId: 'actor-B' }),
    ];
    seedSdkTable(real, messages);
    const agent = createAgent(real, [...messages]);

    const [resA, resB] = await Promise.all([renew(agent, 'actor-A'), renew(agent, 'actor-B')]);
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);
    expect(((await resA.json()) as { ok: boolean }).ok).toBe(true);
    expect(((await resB.json()) as { ok: boolean }).ok).toBe(true);

    // Registry: exatamente 1 aberta por ator.
    const open = openSessions(real);
    expect(open.filter((s) => s.actor_id === 'actor-A')).toHaveLength(1);
    expect(open.filter((s) => s.actor_id === 'actor-B')).toHaveLength(1);

    // Conversas distintas com dono e visibilidade corretos.
    const convA = open.find((s) => s.actor_id === 'actor-A')!;
    const convB = open.find((s) => s.actor_id === 'actor-B')!;
    expect(convA.conversation_id).toBeTruthy();
    expect(convB.conversation_id).toBeTruthy();
    expect(convB.conversation_id).not.toBe(convA.conversation_id);
    expect(convA.owner_actor_id).toBe('actor-A');
    expect(convB.owner_actor_id).toBe('actor-B');
    expect(convA.visibility).toBe('workspace');
    expect(convB.visibility).toBe('workspace');

    // Tabela SDK intacta (CONTEÚDO, não só ids) + espelho em memória
    // preservado + nenhum DELETE nela em nenhuma renovação. Uma regressão
    // que esvaziasse `this.messages` na renovação falharia no espelho aqui
    // (o history de RED-3 cobre o conteúdo via leitura).
    expect(sdkRows(real)).toEqual(messages.map((m) => ({ id: String(m['id']), message: JSON.stringify(m) })));
    expect(mirrorIds(agent)).toEqual(['m-a1', 'm-b1']);
    expect(sdkIds(real)).toEqual(['m-a1', 'm-b1']);
    expect(real.queries.filter((q) => q.startsWith('DELETE FROM cf_ai_chat_agent_messages'))).toHaveLength(0);
  });

  it('RED-2: falha no registry mid-transação — ok:false/500, rollback integral, restart intacto', async () => {
    const faults: Faults = {};
    const real = createRealDb(faults);
    const messages: UiMsg[] = [
      uiMsg('m-a1', 'user', 'Saldo da conta Nubank', { actorId: 'actor-A' }),
      uiMsg('m-b1', 'user', 'Extrato do cartão', { actorId: 'actor-B' }),
    ];
    seedSdkTable(real, messages);
    const agent = createAgent(real, [...messages]);

    // Baseline: B renova uma vez (exercita fecha/abre com resumo — há turnos).
    const baseline = await renew(agent, 'actor-B');
    expect(baseline.status).toBe(200);
    expect(((await baseline.json()) as { ok: boolean }).ok).toBe(true);
    const sessionsBefore = allSessions(real).map((s) => ({ ...s }));
    const openBBefore = openSessions(real).find((s) => s.actor_id === 'actor-B')!.id;
    const sdkBefore = sdkRows(real);
    const memBefore = mirrorIds(agent);

    // Injeta falha no INSERT da NOVA sessão DEPOIS do fechamento (UPDATE) já
    // ter executado dentro da transação: sem rollback integral, a sessão de
    // B ficaria fechada sem sucessora e este teste falharia (falha no UPDATE
    // ou no INSERT sem sessão aberta não exercita rollback — nenhuma escrita
    // prévia para desfazer).
    faults.insertSessions = true;
    const failed = await renew(agent, 'actor-B');
    expect(failed.status).toBe(500);
    const failedBody = (await failed.json()) as { ok: boolean; code?: string };
    expect(failedBody.ok).not.toBe(true);
    expect(failedBody.code).toBe('agent.session_renew_failed');

    // Rollback integral: registry bit-a-bit igual — a sessão de B segue
    // ABERTA (mesmo id/conversa, ended_at NULL, resumo anterior intacto) —
    // SDK (conteúdo) e espelho intactos.
    expect(allSessions(real)).toEqual(sessionsBefore);
    const openBAfter = openSessions(real).find((s) => s.actor_id === 'actor-B')!;
    expect(openBAfter.id).toBe(openBBefore);
    expect(openBAfter.ended_at).toBeNull();
    expect(sdkRows(real)).toEqual(sdkBefore);
    expect(mirrorIds(agent)).toEqual(memBefore);
    faults.insertSessions = false;

    // Falha no SELECT-open também é fail-closed (503, nunca ok:true).
    faults.selectOpenSessions = true;
    const failedSelect = await agent.fetch(
      new Request('https://agent.test/rpc/history', { method: 'GET', headers: headersFor('actor-A') }),
    );
    expect(failedSelect.status).toBe(503);
    faults.selectOpenSessions = false;

    // Falha no INSERT (ator novo, sem sessão aberta) também é fail-closed:
    // 500 + nenhuma linha parcial para o ator.
    faults.insertSessions = true;
    const failedInsert = await renew(agent, 'actor-C');
    expect(failedInsert.status).toBe(500);
    expect(((await failedInsert.json()) as { ok: boolean }).ok).not.toBe(true);
    expect(allSessions(real).filter((s) => s.actor_id === 'actor-C')).toHaveLength(0);
    faults.insertSessions = false;

    // Restart: nova instância sobre o MESMO DB — history de A intacto, sem ressurgimento.
    const restarted = createAgent(
      real,
      sdkIds(real).map(
        (id) =>
          JSON.parse(
            (
              real.db.prepare(`SELECT message FROM cf_ai_chat_agent_messages WHERE id = ?`).get(id) as unknown as {
                message: string;
              }
            ).message,
          ) as UiMsg,
      ),
    );
    const historyRes = await restarted.fetch(
      new Request('https://agent.test/rpc/history', { method: 'GET', headers: headersFor('actor-A') }),
    );
    expect(historyRes.status).toBe(200);
    const history = (await historyRes.json()) as { items: Array<{ content: string }> };
    expect(history.items.some((m) => m.content.includes('Nubank'))).toBe(true);
  });

  it('RED-2b: renew não depende de persistMessages — zero chamadas (sem mascaramento)', async () => {
    const real = createRealDb();
    const messages: UiMsg[] = [uiMsg('m-a1', 'user', 'Saldo da conta Nubank', { actorId: 'actor-A' })];
    seedSdkTable(real, messages);
    const agent = createAgent(real, [...messages]);
    // Contador, não só stub que lança: se o renew CHAMAR e engolir a exceção,
    // o teste falharia em `persistCalls` mesmo com 200.
    let persistCalls = 0;
    (agent as unknown as { persistMessages: () => Promise<void> }).persistMessages = async () => {
      persistCalls++;
      throw new Error('fault: persistMessages');
    };

    const res = await renew(agent, 'actor-A');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
    expect(persistCalls).toBe(0);
    expect(openSessions(real).filter((s) => s.actor_id === 'actor-A')).toHaveLength(1);
    expect(sdkIds(real)).toEqual(['m-a1']);
  });

  it('RED-3: contexto pronto ANTES do renew de B — history de A sem recompor + predicado isolado', async () => {
    const real = createRealDb();
    const agent = createAgent(real, []);
    await renew(agent, 'actor-A');
    await renew(agent, 'actor-B');
    const convA = openSessions(real).find((s) => s.actor_id === 'actor-A')!.conversation_id;
    const convB1 = openSessions(real).find((s) => s.actor_id === 'actor-B')!.conversation_id;

    // Contexto de A/B preparado ANTES da renovação de B — nada é recomposto
    // depois: uma regressão que esvaziasse `this.messages` na renovação
    // falharia no espelho e no history de A abaixo.
    const messages: UiMsg[] = [
      uiMsg('m-a-col', 'user', 'Saldo da conta Nubank de A', {
        actorId: 'actor-A',
        visibility: 'workspace',
        ownerActorId: 'actor-A',
        conversationId: convA,
      }),
      uiMsg('m-a-legacy-prov', 'user', 'Lembrete legado de A com proveniência', { actorId: 'actor-A' }),
      // Predicado isolado do escopo: conversationId NO escopo de A, mas
      // audiência privada de OUTRO dono — o predicado nega mesmo in-scope
      // (a exclusão não depende só do conversationId diferir).
      uiMsg('m-a-scope-priv-other', 'user', 'Nota privada de B no escopo de A', {
        actorId: 'actor-B',
        visibility: 'private',
        ownerActorId: 'actor-B',
        conversationId: convA,
      }),
      uiMsg('m-b-priv-arch', 'user', 'Segredo privado de B arquivado', {
        actorId: 'actor-B',
        visibility: 'private',
        ownerActorId: 'actor-B',
        conversationId: convB1,
      }),
      uiMsg('m-b-old', 'user', 'Turno arquivado de B', {
        actorId: 'actor-B',
        visibility: 'workspace',
        ownerActorId: 'actor-B',
        conversationId: convB1,
      }),
      uiMsg('m-legacy-noprov', 'user', 'Mensagem legada sem proveniência', {}),
      uiMsg('m-ted-noprov', 'assistant', 'Resposta do TED sem dono humano', { actorId: 'ted' }),
    ];
    seedSdkTable(real, messages);
    agent.messages = [...messages];
    const sdkBefore = sdkRows(real);
    const memBefore = mirrorIds(agent);

    // B renova COM contexto (há turnos visíveis: fecha convB1 com resumo e
    // abre convB2) — SEM reatribuir `agent.messages` depois.
    const renewed = await renew(agent, 'actor-B');
    expect(renewed.status).toBe(200);
    expect(((await renewed.json()) as { ok: boolean }).ok).toBe(true);
    const convB2 = openSessions(real).find(
      (s) => s.actor_id === 'actor-B' && s.conversation_id !== convB1,
    )!.conversation_id;
    expect(convB2).not.toBe(convB1);

    // Espelho e SDK (conteúdo) intactos após a renovação — sem wipe.
    expect(mirrorIds(agent)).toEqual(memBefore);
    expect(sdkRows(real)).toEqual(sdkBefore);

    // History de A imediatamente, sem recompor contexto.
    const historyRes = await agent.fetch(
      new Request('https://agent.test/rpc/history', { method: 'GET', headers: headersFor('actor-A') }),
    );
    expect(historyRes.status).toBe(200);
    const history = (await historyRes.json()) as { items: Array<{ content: string }> };
    const contents = history.items.map((m) => m.content);
    // Visível a A: sua conversa + coletivo com proveniência (legado atribuído).
    expect(contents.some((c) => c.includes('Nubank de A'))).toBe(true);
    expect(contents.some((c) => c.includes('Lembrete legado de A'))).toBe(true);
    // Invisível a A: privado de B (arquivado), turno de outra conversa,
    // privada de outro dono MESMO in-scope (predicado, não só escopo),
    // legado sem proveniência.
    expect(contents.some((c) => c.includes('Segredo privado de B arquivado'))).toBe(false);
    expect(contents.some((c) => c.includes('Turno arquivado de B'))).toBe(false);
    expect(contents.some((c) => c.includes('Nota privada de B no escopo de A'))).toBe(false);
    expect(contents.some((c) => c.includes('sem proveniência'))).toBe(false);
    expect(contents.some((c) => c.includes('sem dono humano'))).toBe(false);

    // Turno novo legítimo na conversa nova de B (append, não recomposição —
    // a prova de não-wipe já aconteceu acima com o contexto pré-renew).
    const mBNew = uiMsg('m-b-new', 'user', 'Segredo novo de B na conversa nova', {
      actorId: 'actor-B',
      visibility: 'private',
      ownerActorId: 'actor-B',
      conversationId: convB2,
    });
    seedSdkTable(real, [mBNew]);
    agent.messages.push(mBNew);

    // Espelho: B vê seu privado na conversa nova, não o arquivado nem o de A.
    const historyB = (await (
      await agent.fetch(new Request('https://agent.test/rpc/history', { method: 'GET', headers: headersFor('actor-B') }))
    ).json()) as { items: Array<{ content: string }> };
    expect(historyB.items.some((m) => m.content.includes('Segredo novo de B'))).toBe(true);
    expect(historyB.items.some((m) => m.content.includes('Turno arquivado de B'))).toBe(false);
    expect(historyB.items.some((m) => m.content.includes('Nubank de A'))).toBe(false);
    // E A segue sem ver o privado novo de B.
    const historyA2 = (await (
      await agent.fetch(new Request('https://agent.test/rpc/history', { method: 'GET', headers: headersFor('actor-A') }))
    ).json()) as { items: Array<{ content: string }> };
    expect(historyA2.items.some((m) => m.content.includes('Segredo novo de B'))).toBe(false);
    expect(historyA2.items.some((m) => m.content.includes('Nubank de A'))).toBe(true);
  });

  it('superfície WS: onMessage recusa clearHistory/setMessages sem apagar', async () => {
    const real = createRealDb();
    const agent = createAgent(real, []);
    const sent: string[] = [];
    await agent.onMessage({ send: (s: string) => void sent.push(s) }, JSON.stringify({ type: 'clearHistory' }));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('agent.clear_forbidden');
    await agent.onMessage({ send: (s: string) => void sent.push(s) }, 'please setMessages now');
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain('agent.clear_forbidden');
  });
});
