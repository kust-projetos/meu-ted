/**
 * Issue #99 round 2 — fluxo two-step contra SQLite REAL (`node:sqlite`).
 *
 * O mock `helpers/memory-sql.ts` ignora literais em WHERE (guards como
 * `status = 'pending'` viram tautologia), então o CAS e o DDL da tabela
 * nova são validados aqui contra o parser real: DDL aplica, CAS
 * pending→confirmed elege UMA vencedora (a perdedora recebe `undefined`),
 * e o fluxo propose→confirm→executed invalida de verdade.
 */

import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  casForgetProposalStatus,
  getForgetProposal,
  initializeMemorySchema,
  listForgetCandidates,
  rememberFact,
} from '../src/agent-config/memory/store.js';
import {
  confirmForgetMemory,
  proposeForgetMemory,
} from '../src/agent-config/memory/forget-proposals.js';

type SqlShim = {
  exec<T>(query: string, ...bindings: unknown[]): Iterable<T>;
};

const createRealSql = (): { db: DatabaseSync; sql: SqlShim } => {
  const db = new DatabaseSync(':memory:');
  const sql: SqlShim = {
    exec<T>(query: string, ...bindings: unknown[]): Iterable<T> {
      const statement = db.prepare(query);
      if (/^\s*(SELECT|PRAGMA|WITH)/i.test(query)) return statement.all(...(bindings as never[])) as T[];
      statement.run(...(bindings as never[]));
      return [] as T[];
    },
  };
  return { db, sql };
};

const T0 = new Date("2026-10-06T12:00:00.000Z").getTime();
const WS = 'ws-real';
const ACTOR = 'actor-1';

describe('two-step forget em SQLite real', () => {
  it('DDL aplica e o fluxo propose→confirm→executed invalida de verdade', () => {
    const { sql } = createRealSql();
    initializeMemorySchema(sql as never);
    rememberFact(sql as never, { workspaceId: WS, actor: ACTOR, kind: 'preference', content: 'Prefere usar Nubank' });

    const p = proposeForgetMemory(sql as never, { workspaceId: WS, actorId: ACTOR, query: 'esqueça Nubank', intentionId: 'p', nowMs: T0 });
    expect(p.outcome).toBe('proposed');

    const c = confirmForgetMemory(sql as never, { workspaceId: WS, actorId: ACTOR, intentionId: 'c', nowMs: T0 });
    expect(c.outcome).toBe('executed');
    expect(listForgetCandidates(sql as never, { workspaceId: WS, actor: ACTOR })).toHaveLength(0);
    if (p.outcome === 'proposed') {
      expect(getForgetProposal(sql as never, p.proposal.id)?.status).toBe('executed');
    }
  });

  it('CAS pending→confirmed: UMA vencedora, a perdedora recebe undefined (sem duplo delete)', () => {
    const { sql } = createRealSql();
    initializeMemorySchema(sql as never);
    rememberFact(sql as never, { workspaceId: WS, actor: ACTOR, kind: 'preference', content: 'Prefere usar Nubank' });

    const p = proposeForgetMemory(sql as never, { workspaceId: WS, actorId: ACTOR, query: 'esqueça Nubank', intentionId: 'p', nowMs: T0 });
    expect(p.outcome).toBe('proposed');
    if (p.outcome !== 'proposed') throw new Error('unreachable');
    const id = p.proposal.id;
    const stamp = new Date(T0).toISOString();

    const winner = casForgetProposalStatus(sql as never, {
      id, workspaceId: WS, actorId: ACTOR, from: 'pending', to: 'confirmed', decidedAt: stamp, resultJson: '{"by":"A"}',
    });
    expect(winner?.status).toBe('confirmed');

    // Perdedora: o UPDATE afeta 0 linhas e a releitura NÃO confirma a transição.
    const loser = casForgetProposalStatus(sql as never, {
      id, workspaceId: WS, actorId: ACTOR, from: 'pending', to: 'confirmed', decidedAt: stamp, resultJson: '{"by":"B"}',
    });
    expect(loser).toBeUndefined();
    expect(getForgetProposal(sql as never, id)?.status).toBe('confirmed');

    // CAS cross-actor não move nada.
    const foreign = casForgetProposalStatus(sql as never, {
      id, workspaceId: WS, actorId: 'actor-2', from: 'confirmed', to: 'executed', decidedAt: stamp, resultJson: '{}',
    });
    expect(foreign).toBeUndefined();
    expect(getForgetProposal(sql as never, id)?.status).toBe('confirmed');
  });
});
