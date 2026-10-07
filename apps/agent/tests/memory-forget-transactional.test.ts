/**
 * Issue #102 — closure transacional do `forget_memory` (P1+P2×2 do PR #100).
 *
 * RED: estes testes descrevem o comportamento NORMATIVO novo e FALHAM contra
 * a implementação atual (claim→delete→cascade→executed sem fronteira
 * transacional; receipt sem renewal; PK global em intention_id).
 *
 * Todos usam SQLite REAL (`node:sqlite`): o mock ignora literais em WHERE e
 * não impõe constraints, então atomicidade/UNIQUE só são prováveis aqui
 * (precedente: `memory-forget-sqlite.test.ts`).
 */

import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  FORGET_DECISION_TTL_MS,
  findForgetDecision,
  getForgetProposal,
  initializeMemorySchema,
  insertForgetProposal,
  listForgetCandidates,
  recordForgetDecision,
  rememberCorrection,
  rememberFact,
  runMemoryTransaction,
  type MemorySql,
} from '../src/agent-config/memory/store.js';
import {
  cancelForgetMemory,
  confirmForgetMemory,
  proposeForgetMemory,
} from '../src/agent-config/memory/forget-proposals.js';

type SqlShim = MemorySql & {
  exec<T>(query: string, ...bindings: unknown[]): Iterable<T>;
};

const createRealSql = (onExec?: (query: string, n: number) => void): { db: DatabaseSync; sql: SqlShim } => {
  const db = new DatabaseSync(':memory:');
  let n = 0;
  const sql = {
    exec<T>(query: string, ...bindings: unknown[]): Iterable<T> {
      n += 1;
      onExec?.(query, n);
      const statement = db.prepare(query);
      if (/^\s*(SELECT|PRAGMA|WITH)/i.test(query)) return statement.all(...(bindings as never[])) as T[];
      statement.run(...(bindings as never[]));
      return [] as T[];
    },
  } as SqlShim;
  return { db, sql };
};

const T0 = new Date('2026-10-07T12:00:00.000Z').getTime();
const WS = 'ws-tx';
const ACTOR = 'actor-1';

/** Cadeia real root → child → grandchild (cascade por provenance). */
const seedChain = (sql: SqlShim) => {
  const root = rememberFact(sql as never, {
    workspaceId: WS,
    actor: ACTOR,
    kind: 'preference',
    content: 'Prefere usar Nubank conta principal',
  });
  if (!root.stored) throw new Error('seed root failed');
  const rootId = root.item.id;
  const child = rememberCorrection(sql as never, {
    workspaceId: WS,
    actor: ACTOR,
    target: 'canal-pagamento',
    field: 'preferencia',
    content: 'Aprendeu horario de pagar contas',
    derivedFrom: { sourceId: rootId },
  });
  if (!child.stored) throw new Error('seed child failed');
  const grandchild = rememberCorrection(sql as never, {
    workspaceId: WS,
    actor: ACTOR,
    target: 'lembrete-pagamento',
    field: 'horario',
    content: 'Resumo semanal de organizacao',
    derivedFrom: { sourceId: child.item.id },
  });
  if (!grandchild.stored) throw new Error('seed grandchild failed');
  return { rootId, childId: child.item.id, grandchildId: grandchild.item.id };
};

const proposeNubank = (sql: SqlShim, intentionId: string) =>
  proposeForgetMemory(sql as never, {
    workspaceId: WS,
    actorId: ACTOR,
    query: 'esqueça Nubank',
    intentionId,
    nowMs: T0,
  });

const aliveIds = (sql: SqlShim): Set<string> =>
  new Set(listForgetCandidates(sql as never, { workspaceId: WS, actor: ACTOR }).map((m) => m.id));

describe('issue #102 — atomicidade transacional (RED)', () => {
  it('1. falha após target invalidation: ROLLBACK total, nada apagado', () => {
    let updates = 0;
    const { sql } = createRealSql((query) => {
      if (/^UPDATE agent_memory SET invalidated_at/i.test(query.trim())) {
        updates += 1;
        if (updates === 2) throw new Error('fault: cascade update');
      }
    });
    initializeMemorySchema(sql as never);
    const { rootId, childId, grandchildId } = seedChain(sql);
    const p = proposeNubank(sql, 'p-tx1');
    expect(p.outcome).toBe('proposed');

    const c = confirmForgetMemory(sql as never, {
      workspaceId: WS,
      actorId: ACTOR,
      intentionId: 'c-tx1',
      nowMs: T0,
    });
    expect(c.outcome).toBe('failed');

    const alive = aliveIds(sql);
    expect(alive.has(rootId)).toBe(true);
    expect(alive.has(childId)).toBe(true);
    expect(alive.has(grandchildId)).toBe(true);
    if (p.outcome === 'proposed') {
      // Proposta volta a estado seguro (pending) — nunca confirmed travado.
      expect(getForgetProposal(sql as never, p.proposal.id)?.status).toBe('pending');
    }
  });

  it('2. falha na transição terminal confirmed→executed: ROLLBACK total', () => {
    const { sql } = createRealSql((query) => {
      if (/^UPDATE agent_memory_forget_proposals/i.test(query.trim())) {
        // 1º UPDATE de status = claim pending→confirmed; 2º = terminal.
        (sql as unknown as { __tx?: number }).__tx = ((sql as unknown as { __tx?: number }).__tx ?? 0) + 1;
        if ((sql as unknown as { __tx?: number }).__tx === 2) throw new Error('fault: terminal transition');
      }
    });
    initializeMemorySchema(sql as never);
    const { rootId, childId, grandchildId } = seedChain(sql);
    const p = proposeNubank(sql, 'p-tx2');
    expect(p.outcome).toBe('proposed');

    const c = confirmForgetMemory(sql as never, {
      workspaceId: WS,
      actorId: ACTOR,
      intentionId: 'c-tx2',
      nowMs: T0,
    });
    expect(c.outcome).toBe('failed');

    const alive = aliveIds(sql);
    expect(alive.has(rootId)).toBe(true);
    expect(alive.has(childId)).toBe(true);
    expect(alive.has(grandchildId)).toBe(true);
    if (p.outcome === 'proposed') {
      expect(getForgetProposal(sql as never, p.proposal.id)?.status).toBe('pending');
    }
  });

  it('3. falha no receipt terminal: ROLLBACK total (nada apagado)', () => {
    const { sql } = createRealSql((query) => {
      if (/INSERT INTO agent_memory_forget_decisions/i.test(query)) throw new Error('fault: receipt insert');
    });
    initializeMemorySchema(sql as never);
    const { rootId, childId, grandchildId } = seedChain(sql);
    const p = proposeNubank(sql, 'p-tx3');
    expect(p.outcome).toBe('proposed');

    const c = confirmForgetMemory(sql as never, {
      workspaceId: WS,
      actorId: ACTOR,
      intentionId: 'c-tx3',
      nowMs: T0,
    });
    expect(c.outcome).toBe('failed');

    const alive = aliveIds(sql);
    expect(alive.has(rootId)).toBe(true);
    expect(alive.has(childId)).toBe(true);
    expect(alive.has(grandchildId)).toBe(true);
  });

  it('5. sucesso completo: alvo + descendentes invalidados, executed + receipt', () => {
    const { sql } = createRealSql();
    initializeMemorySchema(sql as never);
    const { rootId, childId, grandchildId } = seedChain(sql);
    const p = proposeNubank(sql, 'p-tx5');
    expect(p.outcome).toBe('proposed');

    const c = confirmForgetMemory(sql as never, {
      workspaceId: WS,
      actorId: ACTOR,
      intentionId: 'c-tx5',
      nowMs: T0,
    });
    expect(c.outcome).toBe('executed');

    const alive = aliveIds(sql);
    expect(alive.has(rootId)).toBe(false);
    expect(alive.has(childId)).toBe(false);
    expect(alive.has(grandchildId)).toBe(false);
    if (p.outcome === 'proposed') {
      expect(getForgetProposal(sql as never, p.proposal.id)?.status).toBe('executed');
    }
    // Recibo terminal da intenção de decisão existe (janela de replay válida).
    expect(
      findForgetDecision(
        sql as never,
        { workspaceId: WS, actorId: ACTOR, intentionId: 'c-tx5' },
        T0,
      ),
    ).toBeDefined();
  });

  it('12. replay após executed: already_done sem mutar nada', () => {
    const { sql } = createRealSql();
    initializeMemorySchema(sql as never);
    seedChain(sql);
    expect(proposeNubank(sql, 'p-r12').outcome).toBe('proposed');
    expect(
      confirmForgetMemory(sql as never, { workspaceId: WS, actorId: ACTOR, intentionId: 'c-r12', nowMs: T0 }).outcome,
    ).toBe('executed');

    const replay = confirmForgetMemory(sql as never, {
      workspaceId: WS,
      actorId: ACTOR,
      intentionId: 'c-r12',
      nowMs: T0,
    });
    expect(replay.outcome).toBe('already_done');
  });

  it('13. replay após failed: mesma intenção repete failed; nova intenção pode retry', () => {
    let failDelete = true;
    const { sql } = createRealSql((query) => {
      if (failDelete && /^UPDATE agent_memory SET invalidated_at/i.test(query.trim())) {
        throw new Error('fault: delete once');
      }
    });
    initializeMemorySchema(sql as never);
    const { rootId } = seedChain(sql);
    expect(proposeNubank(sql, 'p-r13').outcome).toBe('proposed');

    const first = confirmForgetMemory(sql as never, {
      workspaceId: WS,
      actorId: ACTOR,
      intentionId: 'c-r13',
      nowMs: T0,
    });
    expect(first.outcome).toBe('failed');
    expect(aliveIds(sql).has(rootId)).toBe(true);

    const replay = confirmForgetMemory(sql as never, {
      workspaceId: WS,
      actorId: ACTOR,
      intentionId: 'c-r13',
      nowMs: T0,
    });
    expect(replay.outcome).toBe('failed');

    failDelete = false;
    const retry = confirmForgetMemory(sql as never, {
      workspaceId: WS,
      actorId: ACTOR,
      intentionId: 'c-r13-retry',
      nowMs: T0,
    });
    expect(retry.outcome).toBe('executed');
  });

  it('11. confirmações concorrentes: uma vence, a outra observa already_done', () => {
    // Nota: o caminho executed carimba decidedAt com o relógio real, então a
    // observação do perdedor (janela de 5 min) exige nowMs real aqui.
    const now = Date.now();
    const { sql } = createRealSql();
    initializeMemorySchema(sql as never);
    seedChain(sql);
    const pp = proposeForgetMemory(sql as never, {
      workspaceId: WS,
      actorId: ACTOR,
      query: 'esqueça Nubank',
      intentionId: 'p-race',
      nowMs: now,
    });
    expect(pp.outcome).toBe('proposed');

    const a = confirmForgetMemory(sql as never, {
      workspaceId: WS,
      actorId: ACTOR,
      intentionId: 'c-race-a',
      nowMs: now,
    });
    const b = confirmForgetMemory(sql as never, {
      workspaceId: WS,
      actorId: ACTOR,
      intentionId: 'c-race-b',
      nowMs: now,
    });
    expect(a.outcome).toBe('executed');
    expect(b.outcome).toBe('already_done');
    expect(listForgetCandidates(sql as never, { workspaceId: WS, actor: ACTOR })).toHaveLength(0);
  });
});

describe('issue #102 — vínculo intenção→proposta (review P1)', () => {
  const T1 = T0 + FORGET_DECISION_TTL_MS + 60 * 60 * 1000;

  const seedInter = (sql: SqlShim) => {
    const r = rememberFact(sql as never, {
      workspaceId: WS,
      actor: ACTOR,
      kind: 'preference',
      content: 'Prefere usar Inter para viagens',
    });
    if (!r.stored) throw new Error('seed inter failed');
    return r.item.id;
  };

  it('R1. redelivery de confirm vencido NÃO opera sobre pending novo', () => {
    let faults = 1;
    const { sql } = createRealSql((query) => {
      if (faults > 0 && /^UPDATE agent_memory SET invalidated_at/i.test(query.trim())) {
        faults -= 1;
        throw new Error('fault: delete once');
      }
    });
    initializeMemorySchema(sql as never);
    const { rootId } = seedChain(sql);
    const p1 = proposeNubank(sql, 'p-bind1');
    expect(p1.outcome).toBe('proposed');
    const p1id = p1.outcome === 'proposed' ? p1.proposal.id : '';

    const first = confirmForgetMemory(sql as never, {
      workspaceId: WS,
      actorId: ACTOR,
      intentionId: 'c-bind1',
      nowMs: T0,
    });
    expect(first.outcome).toBe('failed');
    expect(aliveIds(sql).has(rootId)).toBe(true);

    // 25h depois: memória nova + proposta nova.
    const interId = seedInter(sql);
    const p2 = proposeForgetMemory(sql as never, {
      workspaceId: WS,
      actorId: ACTOR,
      query: 'esqueça Inter',
      intentionId: 'p-bind1b',
      nowMs: T1,
    });
    expect(p2.outcome).toBe('proposed');

    // Redelivery da intenção antiga: reproduz o consumo, nunca toca P2.
    const replay = confirmForgetMemory(sql as never, {
      workspaceId: WS,
      actorId: ACTOR,
      intentionId: 'c-bind1',
      nowMs: T1,
    });
    expect(replay.outcome).toBe('failed');
    expect(aliveIds(sql).has(interId)).toBe(true);
    if (p2.outcome === 'proposed') {
      expect(getForgetProposal(sql as never, p2.proposal.id)?.status).toBe('pending');
    }
    void p1id;
  });

  it('R2. redelivery de cancel vencido NÃO cancela pending novo', () => {
    const { sql } = createRealSql();
    initializeMemorySchema(sql as never);
    seedChain(sql);
    const p1 = proposeNubank(sql, 'p-bind2');
    expect(p1.outcome).toBe('proposed');
    const cancelled = cancelForgetMemory(sql as never, {
      workspaceId: WS,
      actorId: ACTOR,
      intentionId: 'c-bind2',
      nowMs: T0,
    });
    expect(cancelled.outcome).toBe('cancelled');

    const interId = seedInter(sql);
    const p2 = proposeForgetMemory(sql as never, {
      workspaceId: WS,
      actorId: ACTOR,
      query: 'esqueça Inter',
      intentionId: 'p-bind2b',
      nowMs: T1,
    });
    expect(p2.outcome).toBe('proposed');

    const replay = cancelForgetMemory(sql as never, {
      workspaceId: WS,
      actorId: ACTOR,
      intentionId: 'c-bind2',
      nowMs: T1,
    });
    expect(replay.outcome).toBe('cancelled');
    expect(aliveIds(sql).has(interId)).toBe(true);
    if (p2.outcome === 'proposed') {
      expect(getForgetProposal(sql as never, p2.proposal.id)?.status).toBe('pending');
    }
  });

  it('R3. nova intenção ("sim" novo) ainda executa o pending novo', () => {
    const { sql } = createRealSql();
    initializeMemorySchema(sql as never);
    seedChain(sql);
    expect(proposeNubank(sql, 'p-bind3').outcome).toBe('proposed');
    expect(
      confirmForgetMemory(sql as never, { workspaceId: WS, actorId: ACTOR, intentionId: 'c-bind3', nowMs: T0 }).outcome,
    ).toBe('executed');

    const interId = seedInter(sql);
    const p2 = proposeForgetMemory(sql as never, {
      workspaceId: WS,
      actorId: ACTOR,
      query: 'esqueça Inter',
      intentionId: 'p-bind3b',
      nowMs: T1,
    });
    expect(p2.outcome).toBe('proposed');
    const c2 = confirmForgetMemory(sql as never, {
      workspaceId: WS,
      actorId: ACTOR,
      intentionId: 'c-bind3b',
      nowMs: T1,
    });
    expect(c2.outcome).toBe('executed');
    expect(aliveIds(sql).has(interId)).toBe(false);
  });

  it('R4. renewal de linha pré-closure vincula: depois recusa', () => {
    // Linha antiga sem vínculo (pré-closure): primeira reuse renova (§15-A).
    let faults = 1;
    const { sql } = createRealSql((query) => {
      if (faults > 0 && /^UPDATE agent_memory SET invalidated_at/i.test(query.trim())) {
        faults -= 1;
        throw new Error('fault: delete once');
      }
    });
    initializeMemorySchema(sql as never);
    recordForgetDecision(sql as never, {
      workspaceId: WS,
      actorId: ACTOR,
      intentionId: 'c-bind4',
      outcome: 'none',
      createdAt: new Date(T0 - FORGET_DECISION_TTL_MS - 1000).toISOString(),
    });
    seedChain(sql);
    const p2 = proposeNubank(sql, 'p-bind4');
    expect(p2.outcome).toBe('proposed');
    const first = confirmForgetMemory(sql as never, {
      workspaceId: WS,
      actorId: ACTOR,
      intentionId: 'c-bind4',
      nowMs: T0,
    });
    expect(first.outcome).toBe('failed');
    const row = [
      ...sql.exec<Record<string, unknown>>(
        `SELECT * FROM agent_memory_forget_decisions WHERE intention_id = ? AND workspace_id = ? AND actor_id = ?`,
        'c-bind4',
        WS,
        ACTOR,
      ),
    ][0]!;
    expect(String(row['created_at'])).toBe(new Date(T0).toISOString());
    expect(row['proposal_id']).toBeTruthy();

    // 25h depois, pending novo: redelivery recusa (vínculo permanente).
    const T2 = T1 + FORGET_DECISION_TTL_MS;
    const interId = seedInter(sql);
    const p3 = proposeForgetMemory(sql as never, {
      workspaceId: WS,
      actorId: ACTOR,
      query: 'esqueça Inter',
      intentionId: 'p-bind4b',
      nowMs: T2,
    });
    expect(p3.outcome).toBe('proposed');
    const replay = confirmForgetMemory(sql as never, {
      workspaceId: WS,
      actorId: ACTOR,
      intentionId: 'c-bind4',
      nowMs: T2,
    });
    expect(replay.outcome).toBe('failed');
    expect(aliveIds(sql).has(interId)).toBe(true);
    void p2;
  });
});

describe('issue #102 — vínculo pré-tentativa (review rodada 2)', () => {
  const T1 = T0 + FORGET_DECISION_TTL_MS + 60 * 60 * 1000;

  const seedInter = (sql: SqlShim) => {
    const r = rememberFact(sql as never, {
      workspaceId: WS,
      actor: ACTOR,
      kind: 'preference',
      content: 'Prefere usar Inter para viagens',
    });
    if (!r.stored) throw new Error('seed inter failed');
    return r.item.id;
  };

  /** Falha SÓ em escritas da tabela de recibos (bindings + propostas OK). */
  const decisionsWriteFault = (active: { on: boolean }) => (query: string) => {
    if (!active.on) return;
    const q = query.trim();
    if (/^INSERT INTO agent_memory_forget_decisions[ (]/i.test(q)) throw new Error('fault: decisions insert');
    if (/^UPDATE agent_memory_forget_decisions /i.test(q)) throw new Error('fault: decisions update');
  };

  it('R5. falha seletiva de recibo: vínculo sobrevive, redelivery recusa P2', () => {
    const fault = { on: false };
    const { sql } = createRealSql(decisionsWriteFault(fault));
    initializeMemorySchema(sql as never);
    const { rootId } = seedChain(sql);
    const p1 = proposeNubank(sql, 'p-sel5');
    expect(p1.outcome).toBe('proposed');

    fault.on = true;
    const first = confirmForgetMemory(sql as never, {
      workspaceId: WS,
      actorId: ACTOR,
      intentionId: 'c-sel5',
      nowMs: T0,
    });
    expect(first.outcome).toBe('failed');
    expect(aliveIds(sql).has(rootId)).toBe(true);
    fault.on = false;

    const interId = seedInter(sql);
    const p2 = proposeForgetMemory(sql as never, {
      workspaceId: WS,
      actorId: ACTOR,
      query: 'esqueça Inter',
      intentionId: 'p-sel5b',
      nowMs: T1,
    });
    expect(p2.outcome).toBe('proposed');
    const replay = confirmForgetMemory(sql as never, {
      workspaceId: WS,
      actorId: ACTOR,
      intentionId: 'c-sel5',
      nowMs: T1,
    });
    expect(replay.outcome).toBe('failed');
    expect(aliveIds(sql).has(interId)).toBe(true);
    if (p2.outcome === 'proposed') {
      expect(getForgetProposal(sql as never, p2.proposal.id)?.status).toBe('pending');
    }
  });

  it('R6. confirm de proposta expirada vincula: redelivery posterior recusa P2', () => {
    const { sql } = createRealSql();
    initializeMemorySchema(sql as never);
    const { rootId } = seedChain(sql);
    const p1 = proposeNubank(sql, 'p-exp6');
    expect(p1.outcome).toBe('proposed');

    // Após o TTL (10min) mas dentro da janela de expiração recente (15min).
    const late = confirmForgetMemory(sql as never, {
      workspaceId: WS,
      actorId: ACTOR,
      intentionId: 'c-exp6',
      nowMs: T0 + 11 * 60 * 1000,
    });
    expect(late.outcome).toBe('expired');
    expect(aliveIds(sql).has(rootId)).toBe(true);

    const interId = seedInter(sql);
    const p2 = proposeForgetMemory(sql as never, {
      workspaceId: WS,
      actorId: ACTOR,
      query: 'esqueça Inter',
      intentionId: 'p-exp6b',
      nowMs: T1,
    });
    expect(p2.outcome).toBe('proposed');
    const replay = confirmForgetMemory(sql as never, {
      workspaceId: WS,
      actorId: ACTOR,
      intentionId: 'c-exp6',
      nowMs: T1,
    });
    expect(replay.outcome).toBe('expired');
    expect(aliveIds(sql).has(interId)).toBe(true);
    if (p2.outcome === 'proposed') {
      expect(getForgetProposal(sql as never, p2.proposal.id)?.status).toBe('pending');
    }
  });

  it('R7. cancel com falha seletiva de recibo: redelivery posterior não cancela P2', () => {    const fault = { on: false };
    const { sql } = createRealSql(decisionsWriteFault(fault));
    initializeMemorySchema(sql as never);
    seedChain(sql);
    const p1 = proposeNubank(sql, 'p-sel7');
    expect(p1.outcome).toBe('proposed');

    fault.on = true;
    const cancelled = cancelForgetMemory(sql as never, {
      workspaceId: WS,
      actorId: ACTOR,
      intentionId: 'c-sel7',
      nowMs: T0,
    });
    expect(cancelled.outcome).toBe('none');
    fault.on = false;
    if (p1.outcome === 'proposed') {
      expect(getForgetProposal(sql as never, p1.proposal.id)?.status).toBe('pending');
    }

    seedInter(sql);
    const p2 = proposeForgetMemory(sql as never, {
      workspaceId: WS,
      actorId: ACTOR,
      query: 'esqueça Inter',
      intentionId: 'p-sel7b',
      nowMs: T1,
    });
    expect(p2.outcome).toBe('proposed');
    const replay = cancelForgetMemory(sql as never, {
      workspaceId: WS,
      actorId: ACTOR,
      intentionId: 'c-sel7',
      nowMs: T1,
    });
    expect(replay.outcome).toBe('none');
    if (p2.outcome === 'proposed') {
      expect(getForgetProposal(sql as never, p2.proposal.id)?.status).toBe('pending');
    }
  });

  it('R8. confirm sem pending vincula sentinela: redelivery posterior recusa P2', () => {
    const { sql } = createRealSql();
    initializeMemorySchema(sql as never);
    seedChain(sql);
    const T1l = T0 + FORGET_DECISION_TTL_MS + 60 * 60 * 1000;
    const first = confirmForgetMemory(sql as never, {
      workspaceId: WS,
      actorId: ACTOR,
      intentionId: 'c-none8',
      nowMs: T0,
    });
    expect(first.outcome).toBe('none');

    const interId = seedInter(sql);
    const p2 = proposeForgetMemory(sql as never, {
      workspaceId: WS,
      actorId: ACTOR,
      query: 'esqueça Inter',
      intentionId: 'p-none8b',
      nowMs: T1l,
    });
    expect(p2.outcome).toBe('proposed');
    const replay = confirmForgetMemory(sql as never, {
      workspaceId: WS,
      actorId: ACTOR,
      intentionId: 'c-none8',
      nowMs: T1l,
    });
    expect(replay.outcome).toBe('none');
    expect(aliveIds(sql).has(interId)).toBe(true);
    if (p2.outcome === 'proposed') {
      expect(getForgetProposal(sql as never, p2.proposal.id)?.status).toBe('pending');
    }
  });

  it('R9. confirm ambíguo vincula sentinela: redelivery posterior recusa P2', () => {
    const { sql } = createRealSql();
    initializeMemorySchema(sql as never);
    const { rootId, childId } = seedChain(sql);
    const T1l = T0 + FORGET_DECISION_TTL_MS + 60 * 60 * 1000;
    const stamp = (ms: number) => new Date(ms).toISOString();
    insertForgetProposal(sql as never, {
      id: 'p-amb-a',
      workspaceId: WS,
      actorId: ACTOR,
      memoryId: rootId,
      contentHash: 'h-a',
      memoryPreview: 'preview a',
      sourceIntentionId: 'setup',
      status: 'pending',
      createdAt: stamp(T0),
      expiresAt: stamp(T0 + 10 * 60 * 1000),
    });
    insertForgetProposal(sql as never, {
      id: 'p-amb-b',
      workspaceId: WS,
      actorId: ACTOR,
      memoryId: childId,
      contentHash: 'h-b',
      memoryPreview: 'preview b',
      sourceIntentionId: 'setup',
      createdAt: stamp(T0),
      expiresAt: stamp(T0 + 10 * 60 * 1000),
      status: 'pending',
    });
    const first = confirmForgetMemory(sql as never, {
      workspaceId: WS,
      actorId: ACTOR,
      intentionId: 'c-amb9',
      nowMs: T0,
    });
    expect(first.outcome).toBe('ambiguous');

    const interId = seedInter(sql);
    const p2 = proposeForgetMemory(sql as never, {
      workspaceId: WS,
      actorId: ACTOR,
      query: 'esqueça Inter',
      intentionId: 'p-amb9b',
      nowMs: T1l,
    });
    expect(p2.outcome).toBe('proposed');
    const replay = confirmForgetMemory(sql as never, {
      workspaceId: WS,
      actorId: ACTOR,
      intentionId: 'c-amb9',
      nowMs: T1l,
    });
    expect(replay.outcome).toBe('ambiguous');
    expect(aliveIds(sql).has(interId)).toBe(true);
    if (p2.outcome === 'proposed') {
      expect(getForgetProposal(sql as never, p2.proposal.id)?.status).toBe('pending');
    }
  });

  it('R10. expiração com binding falho: recibo com proposal_id barra P2', () => {
    const fault = { on: false };
    const { sql } = createRealSql((query) => {
      if (fault.on && /^INSERT INTO agent_memory_forget_bindings/i.test(query.trim())) {
        throw new Error('fault: bindings insert');
      }
    });
    initializeMemorySchema(sql as never);
    const { rootId } = seedChain(sql);
    const T1l = T0 + FORGET_DECISION_TTL_MS + 60 * 60 * 1000;
    expect(proposeNubank(sql, 'p-exp10').outcome).toBe('proposed');

    fault.on = true;
    const late = confirmForgetMemory(sql as never, {
      workspaceId: WS,
      actorId: ACTOR,
      intentionId: 'c-exp10',
      nowMs: T0 + 11 * 60 * 1000,
    });
    expect(late.outcome).toBe('expired');
    fault.on = false;
    expect(aliveIds(sql).has(rootId)).toBe(true);

    const interId = seedInter(sql);
    const p2 = proposeForgetMemory(sql as never, {
      workspaceId: WS,
      actorId: ACTOR,
      query: 'esqueça Inter',
      intentionId: 'p-exp10b',
      nowMs: T1l,
    });
    expect(p2.outcome).toBe('proposed');
    const replay = confirmForgetMemory(sql as never, {
      workspaceId: WS,
      actorId: ACTOR,
      intentionId: 'c-exp10',
      nowMs: T1l,
    });
    expect(replay.outcome).toBe('expired');
    expect(aliveIds(sql).has(interId)).toBe(true);
    if (p2.outcome === 'proposed') {
      expect(getForgetProposal(sql as never, p2.proposal.id)?.status).toBe('pending');
    }
  });

  it('R11. cancel sem pending vincula sentinela: redelivery não cancela P2', () => {
    const { sql } = createRealSql();
    initializeMemorySchema(sql as never);
    seedChain(sql);
    const T1l = T0 + FORGET_DECISION_TTL_MS + 60 * 60 * 1000;
    const first = cancelForgetMemory(sql as never, {
      workspaceId: WS,
      actorId: ACTOR,
      intentionId: 'c-none11',
      nowMs: T0,
    });
    expect(first.outcome).toBe('none');

    seedInter(sql);
    const p2 = proposeForgetMemory(sql as never, {
      workspaceId: WS,
      actorId: ACTOR,
      query: 'esqueça Inter',
      intentionId: 'p-none11b',
      nowMs: T1l,
    });
    expect(p2.outcome).toBe('proposed');
    const replay = cancelForgetMemory(sql as never, {
      workspaceId: WS,
      actorId: ACTOR,
      intentionId: 'c-none11',
      nowMs: T1l,
    });
    expect(replay.outcome).toBe('none');
    if (p2.outcome === 'proposed') {
      expect(getForgetProposal(sql as never, p2.proposal.id)?.status).toBe('pending');
    }
  });

  it('R12. perdedora da corrida vincula ao observar: replay vencido recusa P2', () => {
    const now = Date.now();
    const { sql } = createRealSql();
    initializeMemorySchema(sql as never);
    seedChain(sql);
    const pp = proposeForgetMemory(sql as never, {
      workspaceId: WS,
      actorId: ACTOR,
      query: 'esqueça Nubank',
      intentionId: 'p-race12',
      nowMs: now,
    });
    expect(pp.outcome).toBe('proposed');
    const a = confirmForgetMemory(sql as never, {
      workspaceId: WS,
      actorId: ACTOR,
      intentionId: 'c-race12-a',
      nowMs: now,
    });
    const b = confirmForgetMemory(sql as never, {
      workspaceId: WS,
      actorId: ACTOR,
      intentionId: 'c-race12-b',
      nowMs: now,
    });
    expect(a.outcome).toBe('executed');
    expect(b.outcome).toBe('already_done');

    // 25h depois, pending novo: replay da perdedora recusa (vinculada a P1).
    const later = now + FORGET_DECISION_TTL_MS + 60 * 60 * 1000;
    const interId = seedInter(sql);
    const p2 = proposeForgetMemory(sql as never, {
      workspaceId: WS,
      actorId: ACTOR,
      query: 'esqueça Inter',
      intentionId: 'p-race12b',
      nowMs: later,
    });
    expect(p2.outcome).toBe('proposed');
    const replay = confirmForgetMemory(sql as never, {
      workspaceId: WS,
      actorId: ACTOR,
      intentionId: 'c-race12-b',
      nowMs: later,
    });
    expect(replay.outcome).toBe('already_done');
    expect(aliveIds(sql).has(interId)).toBe(true);
    if (p2.outcome === 'proposed') {
      expect(getForgetProposal(sql as never, p2.proposal.id)?.status).toBe('pending');
    }
  });

  it('R13. sentinela com binding falho: recibo vazio barra P2', () => {
    const fault = { on: false };
    const { sql } = createRealSql((query) => {
      if (fault.on && /^INSERT INTO agent_memory_forget_bindings/i.test(query.trim())) {
        throw new Error('fault: bindings insert');
      }
    });
    initializeMemorySchema(sql as never);
    seedChain(sql);
    const T1l = T0 + FORGET_DECISION_TTL_MS + 60 * 60 * 1000;
    fault.on = true;
    const first = confirmForgetMemory(sql as never, {
      workspaceId: WS,
      actorId: ACTOR,
      intentionId: 'c-none13',
      nowMs: T0,
    });
    expect(first.outcome).toBe('none');
    fault.on = false;

    const interId = seedInter(sql);
    const p2 = proposeForgetMemory(sql as never, {
      workspaceId: WS,
      actorId: ACTOR,
      query: 'esqueça Inter',
      intentionId: 'p-none13b',
      nowMs: T1l,
    });
    expect(p2.outcome).toBe('proposed');
    const replay = confirmForgetMemory(sql as never, {
      workspaceId: WS,
      actorId: ACTOR,
      intentionId: 'c-none13',
      nowMs: T1l,
    });
    expect(replay.outcome).toBe('none');
    expect(aliveIds(sql).has(interId)).toBe(true);
    if (p2.outcome === 'proposed') {
      expect(getForgetProposal(sql as never, p2.proposal.id)?.status).toBe('pending');
    }
  });

  it('R14. cancel-none com binding falho: recibo vazio barra cancel de P2', () => {
    const fault = { on: false };
    const { sql } = createRealSql((query) => {
      if (fault.on && /^INSERT INTO agent_memory_forget_bindings/i.test(query.trim())) {
        throw new Error('fault: bindings insert');
      }
    });
    initializeMemorySchema(sql as never);
    seedChain(sql);
    const T1l = T0 + FORGET_DECISION_TTL_MS + 60 * 60 * 1000;
    fault.on = true;
    const first = cancelForgetMemory(sql as never, {
      workspaceId: WS,
      actorId: ACTOR,
      intentionId: 'c-none14',
      nowMs: T0,
    });
    expect(first.outcome).toBe('none');
    fault.on = false;

    seedInter(sql);
    const p2 = proposeForgetMemory(sql as never, {
      workspaceId: WS,
      actorId: ACTOR,
      query: 'esqueça Inter',
      intentionId: 'p-none14b',
      nowMs: T1l,
    });
    expect(p2.outcome).toBe('proposed');
    const replay = cancelForgetMemory(sql as never, {
      workspaceId: WS,
      actorId: ACTOR,
      intentionId: 'c-none14',
      nowMs: T1l,
    });
    expect(replay.outcome).toBe('none');
    if (p2.outcome === 'proposed') {
      expect(getForgetProposal(sql as never, p2.proposal.id)?.status).toBe('pending');
    }
  });
});

describe('issue #102 — runMemoryTransaction (review)', () => {
  it('falha REAL de BEGIN propaga (sem fallback silencioso)', () => {
    let lock = false;
    const { sql } = createRealSql((query) => {
      if (lock && /^BEGIN/i.test(query.trim())) throw new Error('database is locked');
    });
    initializeMemorySchema(sql as never);
    lock = true;
    expect(() => runMemoryTransaction(sql as never, () => 1)).toThrow('database is locked');
  });

  it('falha de COMMIT não corrompe o depth (nesting segue protegido)', () => {
    let begins = 0;
    let failCommit = true;
    const { sql } = createRealSql((query) => {
      const q = query.trim();
      if (/^BEGIN/i.test(q)) begins += 1;
      if (failCommit && /^COMMIT/i.test(q)) throw new Error('fault: commit');
    });
    initializeMemorySchema(sql as never);
    const beginsAfterInit = begins;
    expect(() =>
      runMemoryTransaction(sql as never, () => {
        sql.exec(`INSERT INTO agent_prefs (workspace_id, memory_enabled, updated_at) VALUES (?, ?, ?)`, 'w-depth', 1, new Date(T0).toISOString());
      }),
    ).toThrow('fault: commit');
    failCommit = false;
    // Depth consistente: a interna roda direto (só os 2 BEGINs externos).
    runMemoryTransaction(sql as never, () => {
      runMemoryTransaction(sql as never, () => {
        sql.exec(`SELECT * FROM agent_prefs WHERE workspace_id = ?`, 'w-depth');
      });
    });
    expect(begins).toBe(beginsAfterInit + 2);
  });
});

describe('issue #102 — receipt renewal', () => {
  it('6. receipt expirado é renovado pela nova decisão', () => {
    const { sql } = createRealSql();
    initializeMemorySchema(sql as never);
    const old = new Date(T0 - (FORGET_DECISION_TTL_MS + 60 * 60 * 1000)).toISOString();
    recordForgetDecision(sql as never, {
      workspaceId: WS,
      actorId: ACTOR,
      intentionId: 'c-renew',
      outcome: 'none',
      createdAt: old,
    });
    // Expirado: leitura ignora.
    expect(
      findForgetDecision(sql as never, { workspaceId: WS, actorId: ACTOR, intentionId: 'c-renew' }, T0),
    ).toBeUndefined();

    seedChain(sql);
    expect(proposeNubank(sql, 'p-renew').outcome).toBe('proposed');
    const c = confirmForgetMemory(sql as never, {
      workspaceId: WS,
      actorId: ACTOR,
      intentionId: 'c-renew',
      nowMs: T0,
    });
    expect(c.outcome).toBe('executed');

    // A nova decisão ganhou janela nova: o recibo foi RENOVADO (created_at
    // novo, não o timestamp vencido) e replay dentro do TTL observa.
    const rows = [
      ...sql.exec<Record<string, unknown>>(
        `SELECT * FROM agent_memory_forget_decisions WHERE intention_id = ? AND workspace_id = ? AND actor_id = ?`,
        'c-renew',
        WS,
        ACTOR,
      ),
    ];
    expect(rows.length).toBe(1);
    expect(String(rows[0]!['created_at'])).toBe(new Date(T0).toISOString());
    // Renewal vincula: o recibo renovado carrega a proposta resolvida.
    expect(rows[0]!['proposal_id']).toBeTruthy();
    const replay = confirmForgetMemory(sql as never, {
      workspaceId: WS,
      actorId: ACTOR,
      intentionId: 'c-renew',
      nowMs: T0,
    });
    expect(replay.outcome).toBe('already_done');
  });

  it('7. receipt válido é reutilizado (redelivery não re-executa)', () => {
    const { sql } = createRealSql();
    initializeMemorySchema(sql as never);
    seedChain(sql);
    expect(proposeNubank(sql, 'p-valid').outcome).toBe('proposed');
    const c = confirmForgetMemory(sql as never, {
      workspaceId: WS,
      actorId: ACTOR,
      intentionId: 'c-valid',
      nowMs: T0,
    });
    expect(c.outcome).toBe('executed');
    const replay = confirmForgetMemory(sql as never, {
      workspaceId: WS,
      actorId: ACTOR,
      intentionId: 'c-valid',
      nowMs: T0 + 60 * 60 * 1000,
    });
    expect(replay.outcome).toBe('already_done');
  });
});

describe('issue #102 — uniqueness por actor/workspace (RED)', () => {
  it('8. mesmo intentionId entre actors: receipts independentes', () => {
    const { sql } = createRealSql();
    initializeMemorySchema(sql as never);
    const now = new Date(T0).toISOString();
    recordForgetDecision(sql as never, {
      workspaceId: WS,
      actorId: 'actor-a',
      intentionId: 'shared-x',
      outcome: 'cancelled',
      createdAt: now,
    });
    recordForgetDecision(sql as never, {
      workspaceId: WS,
      actorId: 'actor-b',
      intentionId: 'shared-x',
      outcome: 'none',
      createdAt: now,
    });
    expect(
      findForgetDecision(sql as never, { workspaceId: WS, actorId: 'actor-a', intentionId: 'shared-x' }, T0),
    ).toBe('cancelled');
    expect(
      findForgetDecision(sql as never, { workspaceId: WS, actorId: 'actor-b', intentionId: 'shared-x' }, T0),
    ).toBe('none');
  });

  it('9. mesmo intentionId entre workspaces: receipts independentes', () => {
    const { sql } = createRealSql();
    initializeMemorySchema(sql as never);
    const now = new Date(T0).toISOString();
    recordForgetDecision(sql as never, {
      workspaceId: 'w1',
      actorId: ACTOR,
      intentionId: 'shared-y',
      outcome: 'cancelled',
      createdAt: now,
    });
    recordForgetDecision(sql as never, {
      workspaceId: 'w2',
      actorId: ACTOR,
      intentionId: 'shared-y',
      outcome: 'none',
      createdAt: now,
    });
    expect(findForgetDecision(sql as never, { workspaceId: 'w1', actorId: ACTOR, intentionId: 'shared-y' }, T0)).toBe(
      'cancelled',
    );
    expect(findForgetDecision(sql as never, { workspaceId: 'w2', actorId: ACTOR, intentionId: 'shared-y' }, T0)).toBe(
      'none',
    );
  });

  it('migração preserva receipts existentes e aplica a chave composta', () => {
    const { sql } = createRealSql();
    // Schema antigo: PK global em intention_id.
    (sql as unknown as { exec: (q: string, ...b: unknown[]) => Iterable<never> }).exec(
      `CREATE TABLE agent_memory_forget_decisions (
        intention_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        actor_id TEXT NOT NULL DEFAULT '',
        outcome TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
    );
    sql.exec(
      `INSERT INTO agent_memory_forget_decisions (intention_id, workspace_id, actor_id, outcome, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      'old-1',
      WS,
      ACTOR,
      'cancelled',
      new Date(T0).toISOString(),
    );
    initializeMemorySchema(sql as never);
    // Dado preservado…
    expect(findForgetDecision(sql as never, { workspaceId: WS, actorId: ACTOR, intentionId: 'old-1' }, T0)).toBe(
      'cancelled',
    );
    // …e a chave nova aceita o mesmo intentionId em outro ator.
    recordForgetDecision(sql as never, {
      workspaceId: WS,
      actorId: 'actor-other',
      intentionId: 'old-1',
      outcome: 'none',
      createdAt: new Date(T0).toISOString(),
    });
    expect(
      findForgetDecision(sql as never, { workspaceId: WS, actorId: 'actor-other', intentionId: 'old-1' }, T0),
    ).toBe('none');
  });

  it('migração composta sem coluna ganha ADD COLUMN (defesa)', () => {
    const { sql } = createRealSql();
    // Schema composto SEM proposal_id (nenhum caminho atual o cria; defesa).
    (sql as unknown as { exec: (q: string, ...b: unknown[]) => Iterable<never> }).exec(
      `CREATE TABLE agent_memory_forget_decisions (
        workspace_id TEXT NOT NULL,
        actor_id TEXT NOT NULL DEFAULT '',
        intention_id TEXT NOT NULL,
        outcome TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, actor_id, intention_id)
      )`,
    );
    sql.exec(
      `INSERT INTO agent_memory_forget_decisions (workspace_id, actor_id, intention_id, outcome, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      WS,
      ACTOR,
      'pre-1',
      'none',
      new Date(T0).toISOString(),
    );
    initializeMemorySchema(sql as never);
    // Linha preservada e writes com vínculo funcionam após o ADD COLUMN.
    expect(findForgetDecision(sql as never, { workspaceId: WS, actorId: ACTOR, intentionId: 'pre-1' }, T0)).toBe('none');
    recordForgetDecision(sql as never, {
      workspaceId: WS,
      actorId: ACTOR,
      intentionId: 'pre-2',
      outcome: 'cancelled',
      createdAt: new Date(T0).toISOString(),
      proposalId: 'p-x',
    });
    const row = [
      ...sql.exec<Record<string, unknown>>(
        `SELECT * FROM agent_memory_forget_decisions WHERE intention_id = ? AND workspace_id = ? AND actor_id = ?`,
        'pre-2',
        WS,
        ACTOR,
      ),
    ][0]!;
    expect(String(row['proposal_id'])).toBe('p-x');
  });
});

describe('issue #102 — cancel atômico + proposta (RED)', () => {
  it('10. falha no receipt do cancel: proposta continua pending', () => {
    const { sql } = createRealSql((query) => {
      if (/INSERT INTO agent_memory_forget_decisions/i.test(query)) throw new Error('fault: cancel receipt');
    });
    initializeMemorySchema(sql as never);
    seedChain(sql);
    const p = proposeNubank(sql, 'p-cancel10');
    expect(p.outcome).toBe('proposed');

    const outcome = cancelForgetMemory(sql as never, {
      workspaceId: WS,
      actorId: ACTOR,
      intentionId: 'c-cancel10',
      nowMs: T0,
    });
    // Cancel não concluído: sem estado parcial (nem cancelled sem recibo).
    expect(outcome.outcome).toBe('none');
    if (p.outcome === 'proposed') {
      expect(getForgetProposal(sql as never, p.proposal.id)?.status).toBe('pending');
    }
  });

  it('16. dedupe de proposta por sourceIntentionId: redelivery não duplica', () => {
    const { sql } = createRealSql();
    initializeMemorySchema(sql as never);
    seedChain(sql);
    const first = proposeForgetMemory(sql as never, {
      workspaceId: WS,
      actorId: ACTOR,
      query: 'esqueça Nubank',
      intentionId: 'p-dupe',
      nowMs: T0,
    });
    const second = proposeForgetMemory(sql as never, {
      workspaceId: WS,
      actorId: ACTOR,
      query: 'esqueça Nubank',
      intentionId: 'p-dupe',
      nowMs: T0,
    });
    expect(first.outcome).toBe('proposed');
    expect(second.outcome).toBe('proposed');
    if (first.outcome === 'proposed' && second.outcome === 'proposed') {
      expect(second.proposal.id).toBe(first.proposal.id);
    }
  });
});
