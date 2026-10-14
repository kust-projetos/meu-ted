/**
 * PR137-HARDEN round 4 P2 — rollback comportamental (além do estrutural).
 *
 * O hardening (status `reserved`/`succeeded`/`inconclusive`, sentinelas
 * unbound, sighting, apresentação, CAS imutável) é aditivo sobre o schema da
 * base `7d6283e` (Fase 1: `rememberConfirmation` com `ON CONFLICT DO UPDATE`
 * — rebind silencioso A→B). Um rollback do código novo sobre linhas novas
 * precisa degradar ao residual pré-hardening SEM crash e SEM corrupção —
 * nunca um modo de falha novo — e o código novo sobre linhas antigas precisa
 * seguir legível (default `succeeded`, o único estado pré-hardening).
 *
 * - BACKWARD (leitor antigo × linhas novas): as queries EXATAS do código
 *   pré-hardening (extraídas de `7d6283e`, citadas abaixo) executadas sobre
 *   linhas `reserved`/`inconclusive`/sentinela: sem throw, PK íntegra —
 *   ESTRUTURALMENTE o pior caso é o residual antigo (replay/rebind permitido).
 *   SEMANTICAMENTE há um modo de falha NOVO: o mapeamento antigo ignora
 *   `status`, então reserva/inconclusiva com operation_id vinculado lê como
 *   replay de sucesso (FALSO-SUCESSO) — provado em `ROLLBACK-DANGER` abaixo.
 *   Por isso o rollback operacional é BLOQUEADO sem dreno
 *   (`scripts/check-confirmation-rollback.mjs`);
 * - FORWARD (código novo × linhas antigas): tabela criada com o DDL antigo
 *   (sem a coluna `status`) + linha legada (pós-sucesso): `initialize…`
 *   adiciona a coluna por compat, o binding lê como `succeeded` e o fluxo
 *   novo opera normalmente.
 */
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  initializeMutationDraftSchema,
  SqlMutationDraftStore,
} from '../../src/mutations/mutation-draft.js';

type SqlShim = {
  exec<T>(query: string, ...bindings: unknown[]): Iterable<T>;
};

const createSql = (): { db: DatabaseSync; sql: SqlShim } => {
  const db = new DatabaseSync(':memory:');
  const sql: SqlShim = {
    exec<T>(query: string, ...bindings: unknown[]): Iterable<T> {
      const statement = db.prepare(query);
      if (/^\s*(SELECT|PRAGMA|WITH)/i.test(query) || /\bRETURNING\b/i.test(query)) {
        return statement.all(...(bindings as never[])) as T[];
      }
      statement.run(...(bindings as never[]));
      return [] as T[];
    },
  };
  initializeMutationDraftSchema(sql);
  return { db, sql };
};

const CTX = { workspaceId: 'ws-rollback', actorId: 'actor-rollback', deviceId: 'device-rollback' } as const;
const NOW = Date.parse('2026-10-11T12:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * Queries EXATAS do leitor/escritor pré-hardening (base `7d6283e`,
 * `apps/agent/src/mutations/mutation-draft.ts` — `SqlMutationDraftStore`):
 * - escrita: `INSERT INTO mutation_confirmations (workspace_id, actor_id,
 *   device_id, intention_id, operation_id, receipt_json, created_at,
 *   expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (workspace_id,
 *   actor_id, device_id, intention_id) DO UPDATE SET operation_id =
 *   excluded.operation_id, receipt_json = excluded.receipt_json, created_at
 *   = excluded.created_at, expires_at = excluded.expires_at`;
 * - leitura: `SELECT * FROM mutation_confirmations WHERE workspace_id = ?
 *   AND actor_id = ? AND device_id = ? AND intention_id = ?` (mapeada sem o
 *   campo `status`, que não existia);
 * - higiene: `DELETE FROM mutation_confirmations WHERE expires_at <= ?`.
 */
const LEGACY_INSERT =
  `INSERT INTO mutation_confirmations (workspace_id, actor_id, device_id, intention_id, operation_id, ` +
  `receipt_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ` +
  `ON CONFLICT (workspace_id, actor_id, device_id, intention_id) ` +
  `DO UPDATE SET operation_id = excluded.operation_id, receipt_json = excluded.receipt_json, ` +
  `created_at = excluded.created_at, expires_at = excluded.expires_at`;
const LEGACY_SELECT =
  `SELECT * FROM mutation_confirmations WHERE workspace_id = ? AND actor_id = ? AND device_id = ? AND intention_id = ?`;

describe('PR137-HARDEN round 4 P2: rollback comportamental', () => {
  it('BACKWARD: leitor/escritor pré-hardening sobre linhas novas — sem crash/corrupção, pior caso = residual antigo', async () => {
    const { sql } = createSql();
    const store = new SqlMutationDraftStore(sql);
    // Linhas novas: sentinela unbound reserved, reserva vinculada (A),
    // sentinela terminal inconclusive, sucesso com recibo.
    expect(store.noteConfirmationSighted!(CTX, 'intent-sentinel', NOW).fresh).toBe(true);
    expect(
      store.claimConfirmation!({ ctx: CTX, intentionId: 'intent-A', operationId: 'op-A', receiptJson: null, status: 'reserved', nowMs: NOW }),
    ).toBe('claimed');
    expect(store.noteConfirmationSighted!(CTX, 'intent-dead', NOW).fresh).toBe(true);
    expect(
      store.settleConfirmation!({ ctx: CTX, intentionId: 'intent-dead', operationId: '', status: 'inconclusive', receiptJson: null, nowMs: NOW }),
    ).toBe(true);

    // Leitura legada sobre cada linha nova: sem throw, linhas legíveis (o
    // mapeamento antigo ignora `status` — exatamente o residual
    // pré-hardening: uma reserva passa por binding replayável).
    for (const intentionId of ['intent-sentinel', 'intent-A', 'intent-dead']) {
      const rows = [...sql.exec<Record<string, unknown>>(LEGACY_SELECT, CTX.workspaceId, CTX.actorId, CTX.deviceId, intentionId)];
      expect(rows).toHaveLength(1);
      expect(String(rows[0]?.intention_id)).toBe(intentionId);
    }

    // Escrita legada (rebind A→B) sobre a reserva vinculada: sem throw, UMA
    // linha (PK íntegra), rebound para B — o residual antigo documentado
    // (é exatamente o rebind silencioso que o hardening remove), e as demais
    // linhas intocadas (sem corrupção cruzada).
    sql.exec(
      LEGACY_INSERT,
      CTX.workspaceId, CTX.actorId, CTX.deviceId, 'intent-A', 'op-B', null, iso(NOW + 1_000), iso(NOW + 86_400_000),
    );
    const rebound = [...sql.exec<Record<string, unknown>>(LEGACY_SELECT, CTX.workspaceId, CTX.actorId, CTX.deviceId, 'intent-A')];
    expect(rebound).toHaveLength(1);
    expect(rebound[0]).toMatchObject({ operation_id: 'op-B' });
    const others = [...sql.exec<Record<string, unknown>>(`SELECT intention_id AS intentionId, operation_id AS operationId FROM mutation_confirmations`)];
    expect(others).toHaveLength(3);
    expect(others).toContainEqual({ intentionId: 'intent-sentinel', operationId: '' });
    expect(others).toContainEqual({ intentionId: 'intent-dead', operationId: '' });

    // A tabela de apresentações (só existe no novo) é ignorada pelo leitor
    // antigo: nenhuma query legada a referencia, nenhum erro.
    store.noteConfirmationPresentation?.({ ctx: CTX, operationIds: ['op-A'], nowMs: NOW });
    const presented = [...sql.exec<Record<string, unknown>>(`SELECT * FROM mutation_confirmation_presentations`)];
    expect(presented).toHaveLength(1);
  });

  it('ROLLBACK-DANGER: leitor antigo sobre reserva/inconclusiva lê como replay de sucesso (FALSO-SUCESSO novo) — rollback exige dreno', async () => {
    // No pré-hardening todo binding foi escrito estritamente pós-sucesso, então
    // "linha existe ⇒ replaya sucesso" era correto. Sobre linhas NOVAS a mesma
    // leitura é um FALSO-SUCESSO: `reserved` (nada executou) e `inconclusive`
    // (terminal sem prova) têm operation_id vinculado e o mapeamento antigo
    // ignora `status` (a coluna nem existia). Este teste PROVA o misread com
    // as queries verbatim acima — não é o "residual antigo" (rebind), é um
    // modo de falha NOVO introduzido pelo rollback. Por isso
    // `scripts/check-confirmation-rollback.mjs` BLOQUEIA o rollback com
    // reservas/pendências não drenadas (ver CHANGELOG/runbook).
    const { sql } = createSql();
    const store = new SqlMutationDraftStore(sql);
    expect(
      store.claimConfirmation!({ ctx: CTX, intentionId: 'intent-A', operationId: 'op-A', receiptJson: null, status: 'reserved', nowMs: NOW }),
    ).toBe('claimed');
    expect(
      store.claimConfirmation!({ ctx: CTX, intentionId: 'intent-B', operationId: 'op-B', receiptJson: null, status: 'reserved', nowMs: NOW }),
    ).toBe('claimed');
    expect(
      store.settleConfirmation!({ ctx: CTX, intentionId: 'intent-B', operationId: 'op-B', status: 'inconclusive', receiptJson: null, nowMs: NOW }),
    ).toBe(true);

    // Mapeamento fiel ao leitor pré-hardening: SELECT verbatim + leitura sem
    // `status` (a coluna não existia) — linha com operation_id ⇒ replay.
    const legacyWouldReplaySuccess = (intentionId: string): boolean => {
      const rows = [...sql.exec<Record<string, unknown>>(LEGACY_SELECT, CTX.workspaceId, CTX.actorId, CTX.deviceId, intentionId)];
      const row = rows[0];
      if (!row) return false;
      return String(row.operation_id ?? '') !== '';
    };
    // Reserva que NUNCA executou e terminal sem prova: o leitor antigo
    // replayaria ambas como sucesso — SUCESSO FALSO.
    expect(legacyWouldReplaySuccess('intent-A')).toBe(true);
    expect(legacyWouldReplaySuccess('intent-B')).toBe(true);
    // E a escrita legada ainda rebindaria a reserva por cima (residual antigo
    // somado ao novo): sem throw, sem corrupção de PK — só semântica errada.
    sql.exec(LEGACY_INSERT, CTX.workspaceId, CTX.actorId, CTX.deviceId, 'intent-A', 'op-EVIL', null, iso(NOW), iso(NOW + 86_400_000));
    const rebound = [...sql.exec<Record<string, unknown>>(LEGACY_SELECT, CTX.workspaceId, CTX.actorId, CTX.deviceId, 'intent-A')];
    expect(rebound[0]).toMatchObject({ operation_id: 'op-EVIL' });
  });

  it('FORWARD: código novo sobre tabela/linhas antigas (sem coluna `status`) — compat + default `succeeded`', async () => {
    const db = new DatabaseSync(':memory:');
    const sql: SqlShim = {
      exec<T>(query: string, ...bindings: unknown[]): Iterable<T> {
        const statement = db.prepare(query);
        if (/^\s*(SELECT|PRAGMA|WITH)/i.test(query) || /\bRETURNING\b/i.test(query)) {
          return statement.all(...(bindings as never[])) as T[];
        }
        statement.run(...(bindings as never[]));
        return [] as T[];
      },
    };
    // DDL ANTIGO verbatim (base `7d6283e`): sem a coluna `status`.
    sql.exec(`
      CREATE TABLE IF NOT EXISTS mutation_confirmations (
        workspace_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        device_id TEXT NOT NULL DEFAULT '',
        intention_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        receipt_json TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, actor_id, device_id, intention_id)
      );
    `);
    // Linha legada: escrita estritamente pós-sucesso (único estado possível).
    sql.exec(
      LEGACY_INSERT,
      CTX.workspaceId, CTX.actorId, CTX.deviceId, 'intent-old', 'op-old', null, iso(NOW - 60_000), iso(NOW + 86_400_000),
    );

    // O init novo adiciona `status` por compat (default `succeeded`) sem
    // tocar a linha; o binding lê como `succeeded` e opera normalmente.
    initializeMutationDraftSchema(sql);
    const store = new SqlMutationDraftStore(sql);
    const found = store.findConfirmation!(CTX, 'intent-old', NOW);
    expect(found).toMatchObject({ operationId: 'op-old', status: 'succeeded' });
    // Sighting nova no mesmo banco funciona (fresca), sem colidir com a legada.
    expect(store.noteConfirmationSighted!(CTX, 'intent-new', NOW).fresh).toBe(true);
    expect(
      store.claimConfirmation!({ ctx: CTX, intentionId: 'intent-new', operationId: 'op-new', receiptJson: null, status: 'reserved', nowMs: NOW }),
    ).toBe('claimed');
  });
});
