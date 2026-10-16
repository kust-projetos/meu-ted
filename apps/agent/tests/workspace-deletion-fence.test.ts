/**
 * FIX-WS-D2-FENCE — fence durável de exclusão (lado Agent).
 *
 * Fecha a janela attest→consume por construção: o attest instala o fence
 * ANTES do snapshot; writers verificam o fence e recusam fail-closed;
 * fence expirado libera (fail-open seguro: a API recusa handle expirado).
 *
 * RED first: `src/workspace-deletion-fence.ts` não existe.
 */
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import {
  WORKSPACE_DELETION_FENCE_TTL_MS,
  ensureWorkspaceDeletionFenceSchema,
  installWorkspaceDeletionFence,
  readWorkspaceDeletionFence,
  clearWorkspaceDeletionFence,
  assertNoActiveWorkspaceDeletionFence,
  type WorkspaceDeletionFenceSqlLike,
} from '../src/workspace-deletion-fence.js';

const WS_ID = '22222222-2222-4222-8222-222222222222';

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
  ensureWorkspaceDeletionFenceSchema(sql);
  return sql;
};

describe('FENCE — fence durável de exclusão', () => {
  it('expiração curta nomeada (5min)', () => {
    expect(WORKSPACE_DELETION_FENCE_TTL_MS).toBe(5 * 60 * 1000);
  });

  it('sem fence → escrita liberada (null)', () => {
    const sql = createSql();
    expect(readWorkspaceDeletionFence(sql, WS_ID, Date.now())).toBeNull();
    expect(() =>
      assertNoActiveWorkspaceDeletionFence(sql, WS_ID, Date.now()),
    ).not.toThrow();
  });

  it('atdf→write: fence instalado recusa escrita fail-closed com erro tipado', () => {
    const sql = createSql();
    const now = Date.now();
    const fence = installWorkspaceDeletionFence(sql, WS_ID, now);
    expect(fence.epoch).toMatch(/^[0-9a-f-]{36}$/i);
    expect(Date.parse(fence.expiresAt)).toBeGreaterThan(now);
    const active = readWorkspaceDeletionFence(sql, WS_ID, now);
    expect(active?.epoch).toBe(fence.epoch);
    const error = (() => {
      try {
        assertNoActiveWorkspaceDeletionFence(sql, WS_ID, now);
        throw new Error('expected rejection');
      } catch (cause) {
        return cause as { code?: string; status?: number };
      }
    })();
    expect(error.code).toBe('agent.workspace_deletion_fenced');
    expect(error.status).toBe(409);
  });

  it('expiração libera (fail-open) e remove a linha', () => {
    const sql = createSql();
    const now = Date.now();
    installWorkspaceDeletionFence(sql, WS_ID, now);
    const after = now + WORKSPACE_DELETION_FENCE_TTL_MS + 1000;
    expect(readWorkspaceDeletionFence(sql, WS_ID, after)).toBeNull();
    expect(() =>
      assertNoActiveWorkspaceDeletionFence(sql, WS_ID, after),
    ).not.toThrow();
    // Linha expirada foi removida: reinstalar parte do zero.
    const fresh = installWorkspaceDeletionFence(sql, WS_ID, after);
    expect(Date.parse(fresh.expiresAt)).toBeGreaterThan(after);
  });

  it('fence é por workspace (outro workspace livre)', () => {
    const sql = createSql();
    const now = Date.now();
    installWorkspaceDeletionFence(sql, WS_ID, now);
    expect(readWorkspaceDeletionFence(sql, 'outro-ws', now)).toBeNull();
    expect(() =>
      assertNoActiveWorkspaceDeletionFence(sql, 'outro-ws', now),
    ).not.toThrow();
  });

  it('clear remove o fence (delete consumiu / attest não-vazio)', () => {
    const sql = createSql();
    const now = Date.now();
    installWorkspaceDeletionFence(sql, WS_ID, now);
    clearWorkspaceDeletionFence(sql, WS_ID);
    expect(readWorkspaceDeletionFence(sql, WS_ID, now)).toBeNull();
  });

  it('turno em voo drenado antes do snapshot: drain aguarda assentamento', async () => {
    let settled = false;
    const inFlight = (async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      settled = true;
    })();
    // O drain do attest aguarda a fila atual (assentamento), limitado.
    const queue: Promise<unknown> = inFlight;
    const drained = await Promise.race([
      queue.then(() => 'settled' as const),
      new Promise<'timeout'>(() => {}),
    ]);
    await inFlight;
    expect(settled).toBe(true);
    expect(drained).toBe('settled');
    vi.useRealTimers();
  });
});
