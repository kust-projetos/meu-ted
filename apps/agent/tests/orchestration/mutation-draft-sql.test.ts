/**
 * INV-09 remediation: MutationDraft persistence against a REAL SQLite
 * database (node:sqlite, same adapter shape as the DO storage shim and the
 * existing agent-privacy-sqlite tests).
 *
 * Covers: fresh schema init → create draft → persist with `last_question` →
 * load → CAS active→proposing → consumed; plus the "old schema" simulation
 * (table created WITHOUT the column, as on pre-fix DOs) → idempotent
 * migration applies → persist works and legacy rows survive.
 */
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  buildDraftRecord,
  CONFIRMATION_PRESENTATION_RETENTION_MS,
  CONFIRMATION_TTL_MS,
  initializeMutationDraftSchema,
  InMemoryMutationDraftStore,
  SqlMutationDraftStore,
  validateConfirmationReceipt,
} from '../../src/mutations/mutation-draft.js';
import { createRelayUsageStorage } from '../helpers/relay-usage-storage.js';

type SqlShim = {
  exec<T>(query: string, ...bindings: unknown[]): Iterable<T>;
};

const createSql = (): { db: DatabaseSync; sql: SqlShim } => {
  const db = new DatabaseSync(':memory:');
  const sql: SqlShim = {
    exec<T>(query: string, ...bindings: unknown[]): Iterable<T> {
      const statement = db.prepare(query);
      // `RETURNING` is the driver-native success verdict (the same shape the DO
      // SQLite handle exposes through `SqlStorage.exec`), so a conditional
      // UPDATE reports its affected row exactly like a SELECT does.
      if (/^\s*(SELECT|PRAGMA|WITH)/i.test(query) || /\bRETURNING\b/i.test(query)) {
        return statement.all(...(bindings as never[])) as T[];
      }
      statement.run(...(bindings as never[]));
      return [] as T[];
    },
  };
  return { db, sql };
};

const draftInput = (intentionId: string, question: string) => ({
  workspaceId: 'ws-1',
  actorId: 'actor-1',
  deviceId: null,
  intentionId,
  tool: 'transactions.expense.create' as const,
  resolvedArgs: {
    kind: 'expense' as const,
    amountCents: 5000,
    description: 'mercado',
    date: '2026-09-14',
  },
  missingFields: ['accountId'] as readonly string[],
  question,
});

const ctx = { workspaceId: 'ws-1', actorId: 'actor-1', deviceId: null };

describe('SqlMutationDraftStore on real SQLite (INV-09)', () => {
  it('fresh init → persist with last_question → load → CAS → consumed', () => {
    const { sql } = createSql();
    initializeMutationDraftSchema(sql);
    const columns = [
      ...sql.exec<Record<string, unknown>>(`PRAGMA table_info(mutation_drafts)`),
    ].map((row) => String(row.name));
    expect(columns).toContain('last_question');

    const store = new SqlMutationDraftStore(sql);
    const record = buildDraftRecord(draftInput('intent-1', 'Qual conta usar?'));
    expect(store.getOrCreate(record)).toMatchObject({ created: true });

    const loaded = store.get(record.draftId);
    expect(loaded?.lastQuestion).toBe('Qual conta usar?');
    expect(loaded?.status).toBe('active');

    const updated = store.update(record.draftId, { lastQuestion: 'Nubank ou Itaú?' });
    expect(updated?.lastQuestion).toBe('Nubank ou Itaú?');

    const cas = store.cas(record.draftId, 'active', 'proposing');
    expect(cas.ok).toBe(true);

    const consumed = store.update(record.draftId, { status: 'consumed' });
    expect(consumed?.status).toBe('consumed');
    expect(store.get(record.draftId)?.status).toBe('consumed');

    // Schema init is idempotent — re-running never throws or wipes rows.
    initializeMutationDraftSchema(sql);
    expect(store.get(record.draftId)?.lastQuestion).toBe('Nubank ou Itaú?');
  });

  it('old schema without the column → migration applies → persist works, legacy rows survive', () => {
    const { sql } = createSql();
    // Simulate a pre-fix DO: table created WITHOUT `last_question`.
    sql.exec(`
      CREATE TABLE mutation_drafts (
        draft_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        device_id TEXT,
        conversation_id TEXT,
        tool TEXT NOT NULL,
        resolved_args_json TEXT NOT NULL,
        missing_fields_json TEXT NOT NULL,
        proposal_idempotency_key TEXT NOT NULL,
        proposal_id TEXT,
        propose_outcome TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        discard_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        last_intention_id TEXT NOT NULL
      );
    `);
    sql.exec(
      `INSERT INTO mutation_drafts (draft_id, workspace_id, actor_id, tool, resolved_args_json, missing_fields_json, proposal_idempotency_key, status, created_at, updated_at, expires_at, last_intention_id)
       VALUES ('legacy-1', 'ws-1', 'actor-1', 'transactions.expense.create', '{}', '[]', 'key-legacy', 'active', '2026-09-14T00:00:00.000Z', '2026-09-14T00:00:00.000Z', '2999-01-01T00:00:00.000Z', 'intent-legacy')`,
    );

    // Before the fix this persist threw a SQLite "no such column" error.
    initializeMutationDraftSchema(sql);
    const store = new SqlMutationDraftStore(sql);

    const legacy = store.get('legacy-1');
    expect(legacy?.draftId).toBe('legacy-1');
    expect(legacy?.lastQuestion).toBe('');

    const record = buildDraftRecord(draftInput('intent-new', 'Primeira pergunta?'));
    expect(store.getOrCreate(record).created).toBe(true);
    expect(store.get(record.draftId)?.lastQuestion).toBe('Primeira pergunta?');

    // Legacy rows stay queryable in the same context.
    expect(store.listActive(ctx, Date.now()).map((draft) => draft.draftId).sort()).toEqual([
      'legacy-1',
      record.draftId,
    ].sort());
  });
});

/**
 * A07/R07 — the additive goal metadata (goalId/revision/originMessages/
 * relations/fieldProvenance) against REAL SQLite, using the same
 * `ensureColumn` migration mold as `last_question`.
 */
describe('SqlMutationDraftStore — A07 goal metadata', () => {
  it('fresh init creates every goal-metadata column', () => {
    const { sql } = createSql();
    initializeMutationDraftSchema(sql);
    const columns = [
      ...sql.exec<Record<string, unknown>>(`PRAGMA table_info(mutation_drafts)`),
    ].map((row) => String(row.name));
    for (const column of [
      'goal_id',
      'revision',
      'origin_messages_json',
      'relations_json',
      'field_provenance_json',
    ]) {
      expect(columns).toContain(column);
    }
  });

  it('old schema without the metadata columns → migration applies → roundtrip', () => {
    const { sql } = createSql();
    // Simulate a pre-A07 DO: no goal/revision/origin/relations/provenance.
    sql.exec(`
      CREATE TABLE mutation_drafts (
        draft_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        device_id TEXT,
        conversation_id TEXT,
        tool TEXT NOT NULL,
        resolved_args_json TEXT NOT NULL,
        missing_fields_json TEXT NOT NULL,
        proposal_idempotency_key TEXT NOT NULL,
        proposal_id TEXT,
        propose_outcome TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        discard_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        last_intention_id TEXT NOT NULL,
        last_question TEXT NOT NULL DEFAULT ''
      );
    `);
    sql.exec(
      `INSERT INTO mutation_drafts (draft_id, workspace_id, actor_id, tool, resolved_args_json, missing_fields_json, proposal_idempotency_key, status, created_at, updated_at, expires_at, last_intention_id)
       VALUES ('legacy-1', 'ws-1', 'actor-1', 'transactions.expense.create', '{}', '[]', 'key-legacy', 'active', '2026-09-14T00:00:00.000Z', '2026-09-14T00:00:00.000Z', '2999-01-01T00:00:00.000Z', 'intent-legacy')`,
    );

    // Before the fix this persist threw "no such column: goal_id".
    initializeMutationDraftSchema(sql);
    const store = new SqlMutationDraftStore(sql);

    // Legacy row: goalId is derived from draft_id, revision starts at 0.
    const legacy = store.get('legacy-1')!;
    expect(legacy.goalId).toBe('legacy-1');
    expect(legacy.revision).toBe(0);
    expect(legacy.originMessages).toEqual([]);
    expect(legacy.relations).toEqual([]);
    expect(legacy.fieldProvenance).toBeUndefined();

    const record = buildDraftRecord({
      ...draftInput('intent-a07', 'Qual conta usar?'),
      fieldProvenance: {
        amountCents: { source: 'token', raw: '50', value: 5000 },
        date: { source: 'implicit', raw: '', value: '2026-09-14', timeZone: 'America/Sao_Paulo' },
      },
    });
    expect(store.getOrCreate(record).created).toBe(true);

    const loaded = store.get(record.draftId)!;
    expect(loaded.goalId).toBe(record.draftId);
    expect(loaded.revision).toBe(0);
    expect(loaded.originMessages).toEqual(['intent-a07']);
    expect(loaded.relations).toEqual(['new_intent']);
    expect(loaded.fieldProvenance).toEqual({
      amountCents: { source: 'token', raw: '50', value: 5000 },
      date: { source: 'implicit', raw: '', value: '2026-09-14', timeZone: 'America/Sao_Paulo' },
    });

    const updated = store.update(record.draftId, {
      originMessages: ['intent-a07', 'intent-a07b'],
      relations: ['new_intent', 'continuation'],
    })!;
    expect(updated.revision).toBe(1);
    // Roundtrip through real SQL, not the in-memory object.
    expect(store.get(record.draftId)).toMatchObject({
      revision: 1,
      originMessages: ['intent-a07', 'intent-a07b'],
      relations: ['new_intent', 'continuation'],
      goalId: record.draftId,
    });

    const cas = store.cas(record.draftId, 'active', 'proposing');
    expect(cas.ok).toBe(true);
    expect(cas.ok && cas.record.revision).toBe(2);

    // Schema init stays idempotent — re-running never throws or wipes rows.
    initializeMutationDraftSchema(sql);
    expect(store.get(record.draftId)?.relations).toEqual(['new_intent', 'continuation']);
  });

  it('update with a stale expectedRevision does NOT write (anti-corruption)', () => {
    const { sql } = createSql();
    initializeMutationDraftSchema(sql);
    const store = new SqlMutationDraftStore(sql);
    const record = buildDraftRecord(draftInput('intent-guard', 'Qual conta usar?'));
    store.getOrCreate(record);

    const first = store.update(record.draftId, { lastQuestion: 'primeira' }, { expectedRevision: 0 })!;
    expect(first.revision).toBe(1);

    // Revision 0 is now stale: nothing may be written over the fresher record.
    const stale = store.update(record.draftId, { lastQuestion: 'segunda' }, { expectedRevision: 0 });
    expect(stale).toBeUndefined();
    const reloaded = store.get(record.draftId)!;
    expect(reloaded.lastQuestion).toBe('primeira');
    expect(reloaded.revision).toBe(1);
  });

  it('expiry and consumed writes also advance the revision monotonically', () => {
    const { sql } = createSql();
    initializeMutationDraftSchema(sql);
    const store = new SqlMutationDraftStore(sql);
    const now = Date.parse('2026-09-14T00:00:00.000Z');
    const seed = buildDraftRecord({ ...draftInput('intent-rev', 'q'), ttlMs: 1, nowMs: now - 10_000 });
    store.getOrCreate(seed);
    expect(store.get(seed.draftId)?.revision).toBe(0);

    store.expireStale(ctx, now);
    const expired = store.get(seed.draftId)!;
    expect(expired.status).toBe('expired');
    expect(expired.revision).toBe(1);

    // A terminal draft still accepts the terminal write it owns, at +1.
    const terminal = store.update(seed.draftId, { status: 'consumed', proposalId: 'pending-1' })!;
    expect(terminal.revision).toBe(2);
    expect(store.get(seed.draftId)?.revision).toBe(2);
  });

  it('a corrupt metadata cell degrades to empty, never to a fabricated entry', () => {
    const { sql } = createSql();
    initializeMutationDraftSchema(sql);
    const record = buildDraftRecord(draftInput('intent-corrupt', 'q'));
    const store = new SqlMutationDraftStore(sql);
    store.getOrCreate(record);
    sql.exec(`UPDATE mutation_drafts SET relations_json = ?, origin_messages_json = ? WHERE draft_id = ?`, 'not-json', '{}', record.draftId);
    const loaded = store.get(record.draftId)!;
    expect(loaded.relations).toEqual([]);
    expect(loaded.originMessages).toEqual([]);
    // Unknown relation values are filtered out even from valid JSON.
    sql.exec(`UPDATE mutation_drafts SET relations_json = ? WHERE draft_id = ?`, '["new_intent","drop_table"]', record.draftId);
    expect(store.get(record.draftId)?.relations).toEqual(['new_intent']);
  });
});

/**
 * A07/RR — rodada de correção do review da fatia A07, contra SQLite real.
 *
 * - FIX 3: o sucesso do UPDATE protegido é decidido pelo PRÓPRIO statement
 *   (`AND revision = ? RETURNING *`), nunca por uma releitura posterior;
 * - FIX 1: um patch que toca a resolução só entra num draft `active`;
 * - FIX 6: parse endurecido + os invariantes promovidos (P8/P10).
 */
describe('SqlMutationDraftStore — A07/RR', () => {
  const seedActive = (sql: SqlShim, intentionId: string) => {
    const store = new SqlMutationDraftStore(sql);
    const record = buildDraftRecord(draftInput(intentionId, 'Qual conta usar?'));
    store.getOrCreate(record);
    return { store, record };
  };

  it('FIX 3: the guarded UPDATE decides success itself — a concurrent write in the re-read window is a refusal', () => {
    const { sql } = createSql();
    initializeMutationDraftSchema(sql);
    const { record } = seedActive(sql, 'intent-rr-race');

    // Two concurrent writes surround the statement: the first moves the row so
    // the guard misses; the second lands EXACTLY the next revision, which is
    // what a post-write re-read would see and could mistake for success.
    const racing: SqlShim = {
      exec<T>(query: string, ...bindings: unknown[]): Iterable<T> {
        if (/^\s*UPDATE mutation_drafts/i.test(query) && /AND revision = \?/.test(query)) {
          sql.exec(
            `UPDATE mutation_drafts SET last_question = ?, revision = ? WHERE draft_id = ?`,
            'concorrente-1',
            1,
            record.draftId,
          );
          // Our own statement matched nothing: the storage engine returns no row.
          sql.exec(
            `UPDATE mutation_drafts SET last_question = ?, revision = ? WHERE draft_id = ?`,
            'concorrente-2',
            1,
            record.draftId,
          );
          return [] as T[];
        }
        return sql.exec<T>(query, ...bindings);
      },
    };

    const written = new SqlMutationDraftStore(racing).update(
      record.draftId,
      { lastQuestion: 'meu' },
      { expectedRevision: 0 },
    );
    // A refusal, never a phantom success built from someone else's row.
    expect(written).toBeUndefined();
    const persisted = new SqlMutationDraftStore(sql).get(record.draftId)!;
    expect(persisted.lastQuestion).toBe('concorrente-2');
    expect(persisted.revision).toBe(1);
  });

  it('FIX 3: an unguarded write still succeeds and reports the persisted row', () => {
    const { sql } = createSql();
    initializeMutationDraftSchema(sql);
    const { store, record } = seedActive(sql, 'intent-rr-plain');
    const updated = store.update(record.draftId, { lastQuestion: 'Nubank ou Itaú?' })!;
    expect(updated.lastQuestion).toBe('Nubank ou Itaú?');
    expect(updated.revision).toBe(1);
    expect(store.get(record.draftId)?.lastQuestion).toBe('Nubank ou Itaú?');
  });

  it('FIX 1: a resolution patch is refused unless the draft is still active', () => {
    const { sql } = createSql();
    initializeMutationDraftSchema(sql);
    const { store, record } = seedActive(sql, 'intent-rr-status');
    const resolved = {
      resolvedArgs: {
        ...record.resolvedArgs,
        accountId: '00000000-0000-4000-8000-000000000001',
      },
      missingFields: [] as readonly string[],
    };
    expect(store.update(record.draftId, resolved, { expectedRevision: 0 })?.missingFields).toEqual([]);
    // The propose transition is owned by `cas`, never by a resolution patch.
    expect(store.cas(record.draftId, 'active', 'proposing').ok).toBe(true);

    const frozen = { ...store.get(record.draftId)!.resolvedArgs };
    for (const status of ['proposing', 'consumed', 'discarded', 'expired', 'replaced'] as const) {
      store.update(record.draftId, { status });
      const at = store.get(record.draftId)!;
      expect(at.status).toBe(status);
      expect(
        store.update(record.draftId, { ...resolved, resolvedArgs: { ...at.resolvedArgs, amountCents: 99999 } }),
      ).toBeUndefined();
      expect(store.update(record.draftId, { missingFields: ['categoryId'] })).toBeUndefined();
      const after = store.get(record.draftId)!;
      expect(after.resolvedArgs).toEqual(frozen);
      expect(after.missingFields).toEqual([]);
    }
  });

  it('FIX 6: a corrupt field_provenance_json degrades to absence, never to a crash', () => {
    const { sql } = createSql();
    initializeMutationDraftSchema(sql);
    const { store, record } = seedActive(sql, 'intent-rr-provenance');
    store.update(record.draftId, {
      fieldProvenance: { amountCents: { source: 'token', raw: '50', value: 5000 } },
    });
    expect(store.get(record.draftId)?.fieldProvenance?.amountCents?.value).toBe(5000);
    sql.exec(
      `UPDATE mutation_drafts SET field_provenance_json = ? WHERE draft_id = ?`,
      '{"amountCents":',
      record.draftId,
    );
    const loaded = store.get(record.draftId)!;
    expect(loaded.fieldProvenance).toBeUndefined();
    // The financial payload itself is untouched by the corrupt metadata cell.
    expect(loaded.resolvedArgs.amountCents).toBe(5000);
    expect(loaded.status).toBe('active');
  });

  it('FIX 6/P8: conversation_id stays NULL through a complete chain (nothing writes it)', () => {
    const { sql } = createSql();
    initializeMutationDraftSchema(sql);
    const { store, record } = seedActive(sql, 'intent-rr-chain');
    store.update(record.draftId, { lastQuestion: 'segunda' }, { expectedRevision: 0 });
    expect(store.cas(record.draftId, 'active', 'proposing').ok).toBe(true);
    store.update(record.draftId, { status: 'consumed', proposalId: 'pending-1' });
    const rows = [
      ...sql.exec<{ conversation_id: unknown }>(
        `SELECT conversation_id FROM mutation_drafts WHERE draft_id = ?`,
        record.draftId,
      ),
    ];
    expect(rows).toEqual([{ conversation_id: null }]);
  });

  it('FIX 6/P10: a stale resolution write is refused and the SQL row is untouched', () => {
    const { sql } = createSql();
    initializeMutationDraftSchema(sql);
    const { store, record } = seedActive(sql, 'intent-rr-guard');
    const fresh = store.update(
      record.draftId,
      {
        resolvedArgs: { ...record.resolvedArgs, accountId: '00000000-0000-4000-8000-000000000001' },
        missingFields: [],
      },
      { expectedRevision: 0 },
    )!;
    expect(fresh.revision).toBe(1);
    expect(
      store.update(
        record.draftId,
        { resolvedArgs: { ...fresh.resolvedArgs, amountCents: 99999 }, missingFields: [] },
        { expectedRevision: 0 },
      ),
    ).toBeUndefined();
    const [row] = [
      ...sql.exec<{ resolved_args_json: string; revision: number; missing_fields_json: string }>(
        `SELECT resolved_args_json, revision, missing_fields_json FROM mutation_drafts WHERE draft_id = ?`,
        record.draftId,
      ),
    ];
    expect(JSON.parse(row!.resolved_args_json)).toMatchObject({ amountCents: 5000 });
    expect(JSON.parse(row!.missing_fields_json)).toEqual([]);
    expect(Number(row!.revision)).toBe(1);
  });
});

describe('SqlMutationDraftStore confirmation binding on real SQLite (PR137-SEC-FIX Fase 1 A)', () => {
  const NOW = Date.parse('2026-10-11T12:00:00.000Z');
  const RECEIPT = '{"operationId":"pending-A","entity":{"type":"transaction","id":"tx-A"}}';
  const confirmCtx = { workspaceId: 'ws-1', actorId: 'actor-1', deviceId: 'device-1' };

  const remember = (
    store: SqlMutationDraftStore,
    overrides: Partial<{ ctx: typeof confirmCtx; intentionId: string; operationId: string; receiptJson: string | null; nowMs: number; ttlMs: number }> = {},
  ) =>
    store.rememberConfirmation!({
      ctx: overrides.ctx ?? confirmCtx,
      intentionId: overrides.intentionId ?? 'intent-confirm-A',
      operationId: overrides.operationId ?? 'pending-A',
      receiptJson: overrides.receiptJson !== undefined ? overrides.receiptJson : RECEIPT,
      nowMs: overrides.nowMs ?? NOW,
      ...(overrides.ttlMs !== undefined ? { ttlMs: overrides.ttlMs } : {}),
    });

  it('init creates mutation_confirmations; remember → find round-trips the binding', () => {
    const { sql } = createSql();
    initializeMutationDraftSchema(sql);
    const tables = [...sql.exec<Record<string, unknown>>(`SELECT name FROM sqlite_master WHERE type = 'table'`)].map((row) => String(row.name));
    expect(tables).toContain('mutation_confirmations');
    const store = new SqlMutationDraftStore(sql);
    expect(store.findConfirmation!(confirmCtx, 'intent-confirm-A', NOW)).toBeUndefined();
    remember(store);
    expect(store.findConfirmation!(confirmCtx, 'intent-confirm-A', NOW)).toMatchObject({
      workspaceId: 'ws-1',
      actorId: 'actor-1',
      deviceId: 'device-1',
      intentionId: 'intent-confirm-A',
      operationId: 'pending-A',
      receiptJson: RECEIPT,
    });
  });

  it('a marker never crosses an identity leg (workspace, actor, device)', () => {
    const { sql } = createSql();
    initializeMutationDraftSchema(sql);
    const store = new SqlMutationDraftStore(sql);
    remember(store);
    expect(store.findConfirmation!({ workspaceId: 'ws-2', actorId: 'actor-1', deviceId: 'device-1' }, 'intent-confirm-A', NOW)).toBeUndefined();
    expect(store.findConfirmation!({ workspaceId: 'ws-1', actorId: 'actor-2', deviceId: 'device-1' }, 'intent-confirm-A', NOW)).toBeUndefined();
    expect(store.findConfirmation!({ workspaceId: 'ws-1', actorId: 'actor-1', deviceId: 'device-2' }, 'intent-confirm-A', NOW)).toBeUndefined();
    expect(store.findConfirmation!({ workspaceId: 'ws-1', actorId: 'actor-1', deviceId: null }, 'intent-confirm-A', NOW)).toBeUndefined();
    // Owner still reads its own marker.
    expect(store.findConfirmation!(confirmCtx, 'intent-confirm-A', NOW)?.operationId).toBe('pending-A');
  });

  it('expired marker persists as a TOMBSTONE (binding never pruned; only the receipt is stripped)', () => {
    const { sql } = createSql();
    initializeMutationDraftSchema(sql);
    const store = new SqlMutationDraftStore(sql);
    remember(store, { ttlMs: 60_000 });
    // Past the 24h-style receipt TTL the binding is still found — it no
    // longer proves success, but it must keep blocking a divergent claim.
    const tombstone = store.findConfirmation!(confirmCtx, 'intent-confirm-A', NOW + 60_001);
    expect(tombstone?.operationId).toBe('pending-A');
    expect(tombstone?.status).toBe('succeeded');
    const rows = [...sql.exec<Record<string, unknown>>(`SELECT * FROM mutation_confirmations`)];
    expect(rows).toHaveLength(1);
    // Review fix P1-3 (policy a): even tombstones past the 30-day retention
    // are NEVER deleted — retention hygiene strips only the bulky receipt
    // cell. The binding keeps blocking a divergent confirmation forever
    // (one minimal row per intention, bounded by business volume).
    const ancient = NOW + 60_001 + 31 * 24 * 60 * 60_000;
    store.claimConfirmation!({
      ctx: confirmCtx,
      intentionId: 'intent-other',
      operationId: 'pending-other',
      receiptJson: null,
      status: 'reserved',
      nowMs: ancient,
    });
    // The ancient binding still blocks: divergent re-claim is rejected and
    // the row survives with its receipt stripped.
    expect(
      store.claimConfirmation!({
        ctx: confirmCtx,
        intentionId: 'intent-confirm-A',
        operationId: 'pending-evil',
        receiptJson: null,
        status: 'reserved',
        nowMs: ancient,
      }),
    ).toBe('divergent');
    expect(store.findConfirmation!(confirmCtx, 'intent-confirm-A', ancient)).toMatchObject({
      operationId: 'pending-A',
      receiptJson: null,
    });
    expect(store.findConfirmation!(confirmCtx, 'intent-other', ancient)?.operationId).toBe('pending-other');
  });

  it('re-claim with a DIVERGENT operationId is rejected, never overwritten (immutability)', () => {
    const { sql } = createSql();
    initializeMutationDraftSchema(sql);
    const store = new SqlMutationDraftStore(sql);
    expect(
      store.claimConfirmation!({
        ctx: confirmCtx,
        intentionId: 'intent-confirm-A',
        operationId: 'pending-A',
        receiptJson: null,
        status: 'reserved',
        nowMs: NOW,
      }),
    ).toBe('claimed');
    // Identical re-claim is idempotent.
    expect(
      store.claimConfirmation!({
        ctx: confirmCtx,
        intentionId: 'intent-confirm-A',
        operationId: 'pending-A',
        receiptJson: null,
        status: 'reserved',
        nowMs: NOW + 1,
      }),
    ).toBe('identical');
    // Divergent re-claim (the pre-hardening A→B overwrite) is rejected.
    expect(
      store.claimConfirmation!({
        ctx: confirmCtx,
        intentionId: 'intent-confirm-A',
        operationId: 'pending-B',
        receiptJson: null,
        status: 'reserved',
        nowMs: NOW + 2,
      }),
    ).toBe('divergent');
    expect(store.findConfirmation!(confirmCtx, 'intent-confirm-A', NOW + 2)?.operationId).toBe('pending-A');
    const rows = [...sql.exec<Record<string, unknown>>(`SELECT * FROM mutation_confirmations`)];
    expect(rows).toHaveLength(1);
    // Legacy post-success write honors the same immutable contract.
    remember(store, { operationId: 'pending-A2', nowMs: NOW + 3 });
    expect(store.findConfirmation!(confirmCtx, 'intent-confirm-A', NOW + 3)?.operationId).toBe('pending-A');
  });

  it('reserve → settle lifecycle: only reserved rows transition, terminal rows are immutable', () => {
    const { sql } = createSql();
    initializeMutationDraftSchema(sql);
    const store = new SqlMutationDraftStore(sql);
    store.claimConfirmation!({
      ctx: confirmCtx,
      intentionId: 'intent-settle',
      operationId: 'pending-A',
      receiptJson: null,
      status: 'reserved',
      nowMs: NOW,
    });
    expect(store.findConfirmation!(confirmCtx, 'intent-settle', NOW)?.status).toBe('reserved');
    // Foreign operationId settles nothing.
    expect(
      store.settleConfirmation!({
        ctx: confirmCtx,
        intentionId: 'intent-settle',
        operationId: 'pending-B',
        status: 'succeeded',
        receiptJson: RECEIPT,
        nowMs: NOW + 1,
      }),
    ).toBe(false);
    expect(
      store.settleConfirmation!({
        ctx: confirmCtx,
        intentionId: 'intent-settle',
        operationId: 'pending-A',
        status: 'succeeded',
        receiptJson: RECEIPT,
        nowMs: NOW + 1,
      }),
    ).toBe(true);
    expect(store.findConfirmation!(confirmCtx, 'intent-settle', NOW + 1)).toMatchObject({
      operationId: 'pending-A',
      status: 'succeeded',
      receiptJson: RECEIPT,
    });
    // Terminal rows never transition again.
    expect(
      store.settleConfirmation!({
        ctx: confirmCtx,
        intentionId: 'intent-settle',
        operationId: 'pending-A',
        status: 'inconclusive',
        receiptJson: null,
        nowMs: NOW + 2,
      }),
    ).toBe(false);
    expect(store.findConfirmation!(confirmCtx, 'intent-settle', NOW + 2)?.status).toBe('succeeded');
  });

  it('pre-hardening rows without the status column read as succeeded (rollback compat)', () => {
    const { sql } = createSql();
    // Simulate a pre-hardening DO: confirmations table WITHOUT `status`
    // (full legacy drafts table so the context index builds).
    sql.exec(`
      CREATE TABLE mutation_drafts (
        draft_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        device_id TEXT,
        conversation_id TEXT,
        tool TEXT NOT NULL,
        resolved_args_json TEXT NOT NULL,
        missing_fields_json TEXT NOT NULL,
        proposal_idempotency_key TEXT NOT NULL,
        proposal_id TEXT,
        propose_outcome TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        discard_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        last_intention_id TEXT NOT NULL,
        last_question TEXT NOT NULL DEFAULT '',
        goal_id TEXT,
        revision INTEGER NOT NULL DEFAULT 0,
        origin_messages_json TEXT NOT NULL DEFAULT '[]',
        relations_json TEXT NOT NULL DEFAULT '[]',
        field_provenance_json TEXT
      );
    `);
    sql.exec(`
      CREATE TABLE mutation_confirmations (
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
    sql.exec(
      `INSERT INTO mutation_confirmations (workspace_id, actor_id, device_id, intention_id, operation_id, receipt_json, created_at, expires_at)
       VALUES ('ws-1', 'actor-1', 'device-1', 'intent-legacy', 'pending-legacy', ?, '2026-10-11T12:00:00.000Z', '2026-10-12T12:00:00.000Z')`,
      RECEIPT,
    );
    initializeMutationDraftSchema(sql);
    const store = new SqlMutationDraftStore(sql);
    // The migration backfills the column; the legacy row reads as the only
    // state it could ever have been in (written strictly post-success).
    expect(store.findConfirmation!(confirmCtx, 'intent-legacy', NOW)?.status).toBe('succeeded');
    expect(store.findConfirmation!(confirmCtx, 'intent-legacy', NOW)?.operationId).toBe('pending-legacy');
    // And the immutable contract already guards it against rebinding.
    expect(
      store.claimConfirmation!({
        ctx: confirmCtx,
        intentionId: 'intent-legacy',
        operationId: 'pending-evil',
        receiptJson: null,
        status: 'reserved',
        nowMs: NOW,
      }),
    ).toBe('divergent');
  });

  it('pre-fix DO without the table: init creates it and the binding works', () => {
    const { sql } = createSql();
    // Simulate a pre-fix DO: the FULL legacy mutation_drafts table exists
    // (all pre-fix columns, so the context index builds), but there is no
    // mutation_confirmations table yet.
    sql.exec(`
      CREATE TABLE mutation_drafts (
        draft_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        device_id TEXT,
        conversation_id TEXT,
        tool TEXT NOT NULL,
        resolved_args_json TEXT NOT NULL,
        missing_fields_json TEXT NOT NULL,
        proposal_idempotency_key TEXT NOT NULL,
        proposal_id TEXT,
        propose_outcome TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        discard_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        last_intention_id TEXT NOT NULL,
        last_question TEXT NOT NULL DEFAULT '',
        goal_id TEXT,
        revision INTEGER NOT NULL DEFAULT 0,
        origin_messages_json TEXT NOT NULL DEFAULT '[]',
        relations_json TEXT NOT NULL DEFAULT '[]',
        field_provenance_json TEXT
      );
    `);
    initializeMutationDraftSchema(sql);
    const store = new SqlMutationDraftStore(sql);
    remember(store);
    expect(store.findConfirmation!(confirmCtx, 'intent-confirm-A', NOW)?.operationId).toBe('pending-A');
  });

  it('round 3 P2-C: double do relay produz a mesma linha que o SQLite real (sighting 7-bindings + claim + temporal)', () => {
    // A INSERT da sighting leva 7 bindings com `receipt_json = NULL` e
    // `status = 'reserved'` como LITERAIS SQL; o double lia 8 posições
    // (timestamp virava receipt, expiry virava createdAt, expires_at
    // undefined). A mesma sequência de statements roda nos dois shims e as
    // linhas resultantes são comparadas campo a campo, incluindo o caso
    // temporal (createdAt da sighting é a âncora do fence).
    const { sql: realSql } = createSql();
    initializeMutationDraftSchema(realSql);
    const relay = createRelayUsageStorage();
    const real = new SqlMutationDraftStore(realSql);
    const doubled = new SqlMutationDraftStore({ exec: relay.exec });

    const realSighting = real.noteConfirmationSighted!(confirmCtx, 'intent-double', NOW);
    const relaySighting = doubled.noteConfirmationSighted!(confirmCtx, 'intent-double', NOW);
    expect(realSighting.fresh).toBe(true);
    expect(relaySighting.fresh).toBe(true);
    // Paridade total da linha, não só das colunas "interessantes".
    expect(relaySighting.record).toEqual(realSighting.record);
    expect(relaySighting.record).toMatchObject({
      operationId: '',
      receiptJson: null,
      status: 'reserved',
      createdAt: new Date(NOW).toISOString(),
      expiresAt: new Date(NOW + CONFIRMATION_TTL_MS).toISOString(),
    });
    // Leitura crua do double: created_at/expires_at/receipt nas colunas
    // certas (é exatamente aqui que o double antigo trocava tudo).
    const rawRelay = [
      ...relay.exec<Record<string, unknown>>(
        `SELECT * FROM mutation_confirmations WHERE workspace_id = ? AND actor_id = ? AND device_id = ? AND intention_id = ?`,
        'ws-1',
        'actor-1',
        'device-1',
        'intent-double',
      ),
    ];
    expect(rawRelay).toHaveLength(1);
    expect(rawRelay[0]).toMatchObject({
      operation_id: '',
      receipt_json: null,
      created_at: new Date(NOW).toISOString(),
      expires_at: new Date(NOW + CONFIRMATION_TTL_MS).toISOString(),
      status: 'reserved',
    });

    // Claim (adoção da sentinela) também é idêntico nos dois shims.
    expect(real.claimConfirmation!({ ctx: confirmCtx, intentionId: 'intent-double', operationId: 'pending-A', receiptJson: null, status: 'reserved', nowMs: NOW + 1 })).toBe('claimed');
    expect(doubled.claimConfirmation!({ ctx: confirmCtx, intentionId: 'intent-double', operationId: 'pending-A', receiptJson: null, status: 'reserved', nowMs: NOW + 1 })).toBe('claimed');
    expect(doubled.findConfirmation!(confirmCtx, 'intent-double', NOW + 1)).toEqual(
      real.findConfirmation!(confirmCtx, 'intent-double', NOW + 1),
    );
    // A âncora temporal sobrevive igual nos dois: createdAt preservado da
    // sighting após a adoção.
    expect(doubled.findConfirmation!(confirmCtx, 'intent-double', NOW + 1)).toMatchObject({
      operationId: 'pending-A',
      createdAt: new Date(NOW).toISOString(),
    });
  });

  it('round 3 rollback-reverso: binário antigo sobre schema novo não quebra; proteção degradada ao pré-hardening, nunca pior', () => {
    // Binário antigo = pré-hardening (pós-SEC-FIX): escreve
    // mutation_confirmations SEM a coluna `status`, nunca referencia a
    // coluna nova, e ignora a tabela quando ela não lhe diz respeito. Sobre
    // o schema novo isso tem de funcionar (colunas aditivas com DEFAULT,
    // sem NOT NULL sem default, sem rename/drop; nenhum SELECT * quebrável
    // do lado antigo), com a proteção degradada exatamente ao residual
    // pré-hardening (fail-open legado) — nunca a um estado pior (linha
    // corrompida, exceção no caminho de leitura, ou rebinding silencioso).
    // Recomendação operacional: bloquear rollback incompatível ou reaplicar
    // o hardening antes de confirmar qualquer operação.
    const { sql } = createSql();
    initializeMutationDraftSchema(sql);
    // Statement legado: INSERT explícito sem `status`.
    sql.exec(
      `INSERT INTO mutation_confirmations (workspace_id, actor_id, device_id, intention_id, operation_id, receipt_json, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      'ws-1',
      'actor-1',
      'device-1',
      'intent-legacy',
      'pending-A',
      RECEIPT,
      new Date(NOW).toISOString(),
      new Date(NOW + CONFIRMATION_TTL_MS).toISOString(),
    );
    const store = new SqlMutationDraftStore(sql);
    // O DEFAULT preenche a coluna nova; a linha legada lê como o único
    // estado que ela poderia ter sido (succeeded pós-sucesso).
    expect(store.findConfirmation!(confirmCtx, 'intent-legacy', NOW)).toMatchObject({
      operationId: 'pending-A',
      status: 'succeeded',
      receiptJson: RECEIPT,
    });
    // UPDATE legado (sem predicados de status) e SELECT * legado funcionam.
    sql.exec(`UPDATE mutation_confirmations SET receipt_json = NULL WHERE intention_id = ?`, 'intent-legacy');
    expect([...sql.exec(`SELECT * FROM mutation_confirmations`)]).toHaveLength(1);
    expect(store.findConfirmation!(confirmCtx, 'intent-legacy', NOW)?.receiptJson).toBeNull();
    // Código novo sobre linha legada: contrato imutável já vale —
    // divergent rejeitado, nunca rebinding.
    expect(
      store.claimConfirmation!({ ctx: confirmCtx, intentionId: 'intent-legacy', operationId: 'pending-evil', receiptJson: null, status: 'reserved', nowMs: NOW }),
    ).toBe('divergent');
    // Evidência estrutural da aditividade: `status` é NOT NULL *com*
    // DEFAULT (INSERT legado seguro) e nada foi renomeado/removido — as
    // colunas que o binário antigo conhece seguem todas presentes.
    const columns = [...sql.exec<Record<string, unknown>>(`PRAGMA table_info(mutation_confirmations)`)].map((row) => String(row.name));
    for (const legacy of ['workspace_id', 'actor_id', 'device_id', 'intention_id', 'operation_id', 'receipt_json', 'created_at', 'expires_at']) {
      expect(columns).toContain(legacy);
    }
    const statusInfo = [...sql.exec<Record<string, unknown>>(`PRAGMA table_info(mutation_confirmations)`)].find((row) => String(row.name) === 'status');
    expect(statusInfo).toBeTruthy();
    expect(String(statusInfo?.dflt_value ?? '')).toContain('succeeded');
  });
});

describe('ROUND5-3: prune de apresentações na retenção de 30d (SQL + InMemory)', () => {
  // O horizonte é 30d (`CONFIRMATION_PRESENTATION_RETENTION_MS`): a linha
  // expira em presentedAt+30d e o prune apaga quando `expires_at <= agora`.
  // O código pré-round-5 comparava `expires_at <= agora-30d` (horizonte
  // efetivo de 60d): estes testes FALHAM nele (a linha vencida sobrevive).
  const DAY = 24 * 60 * 60_000;
  const T0 = Date.parse('2026-10-11T12:00:00.000Z');
  const pruneCtx = { workspaceId: 'ws-1', actorId: 'actor-1', deviceId: 'device-1' } as const;

  it('SQL: linha vencida há exatamente 30d é podada; linha com 1ms de vida restante sobrevive', () => {
    const { sql } = createSql();
    initializeMutationDraftSchema(sql);
    const store = new SqlMutationDraftStore(sql);
    expect(CONFIRMATION_PRESENTATION_RETENTION_MS).toBe(30 * DAY);
    store.noteConfirmationPresentation!({ ctx: pruneCtx, operationIds: ['op-old'], nowMs: T0 });
    // Em T0+30d-1ms a linha velha ainda é válida: só dispara a higiene.
    store.noteConfirmationPresentation!({ ctx: pruneCtx, operationIds: ['op-fresh'], nowMs: T0 + 30 * DAY - 1 });
    expect(store.findConfirmationPresentation!(pruneCtx, 'op-old')?.operationId).toBe('op-old');
    expect(store.listConfirmationPresentations!(pruneCtx)).toEqual(expect.arrayContaining(['op-old', 'op-fresh']));
    // Em T0+30d a linha velha venceu (expiresAt == agora, `<=` poda).
    store.noteConfirmationPresentation!({ ctx: pruneCtx, operationIds: ['op-trigger'], nowMs: T0 + 30 * DAY });
    expect(store.findConfirmationPresentation!(pruneCtx, 'op-old')).toBeUndefined();
    expect(store.listConfirmationPresentations!(pruneCtx)).toEqual(expect.arrayContaining(['op-fresh', 'op-trigger']));
    expect(store.listConfirmationPresentations!(pruneCtx)).not.toContain('op-old');
  });

  it('InMemory: mesma fronteira de 30d', () => {
    const store = new InMemoryMutationDraftStore();
    const mctx = { workspaceId: 'ws-1', actorId: 'actor-1', deviceId: 'device-1' } as const;
    expect(CONFIRMATION_PRESENTATION_RETENTION_MS).toBe(30 * DAY);
    store.noteConfirmationPresentation({ ctx: mctx, operationIds: ['op-old'], nowMs: T0 });
    store.noteConfirmationPresentation({ ctx: mctx, operationIds: ['op-fresh'], nowMs: T0 + 30 * DAY - 1 });
    expect(store.findConfirmationPresentation(mctx, 'op-old')?.operationId).toBe('op-old');
    store.noteConfirmationPresentation({ ctx: mctx, operationIds: ['op-trigger'], nowMs: T0 + 30 * DAY });
    expect(store.findConfirmationPresentation(mctx, 'op-old')).toBeUndefined();
    expect(store.listConfirmationPresentations(mctx)).toEqual(expect.arrayContaining(['op-fresh', 'op-trigger']));
    expect(store.listConfirmationPresentations(mctx)).not.toContain('op-old');
  });
});


describe('validateConfirmationReceipt (PR137-HARDEN criterion 6, P2-6 canonical schema)', () => {
  const OP = 'pending-A';
  const valid = JSON.stringify({
    operationId: OP,
    mutationId: 'mut-A',
    mutationKind: 'transactions.expense.create',
    status: 'succeeded',
    affectedTargets: ['transactions'],
    entity: { type: 'transaction', id: 'tx-A' },
  });

  it('null receipt is absent (binding stays the authority, replay unexpired only)', () => {
    expect(validateConfirmationReceipt(null, OP)).toEqual({ kind: 'absent' });
  });

  it('canonical receipt for the bound operation is valid', () => {
    expect(validateConfirmationReceipt(valid, OP).kind).toBe('valid');
  });

  it('legacy shape without status is INCOMPLETE (reconciles, never replays success)', () => {
    // Review fix P2-6: pre-hardening doubles/rows carry no status (nor the
    // canonical mutationKind/affectedTargets). The weak shape is not proof —
    // the caller must reconcile via the API listing.
    expect(
      validateConfirmationReceipt(JSON.stringify({ operationId: OP, mutationId: 'mut-A' }), OP),
    ).toEqual({ kind: 'invalid', reason: 'incomplete' });
    expect(
      validateConfirmationReceipt(JSON.stringify({ operationId: OP, entity: { type: 'transaction', id: 'tx-A' } }), OP),
    ).toEqual({ kind: 'invalid', reason: 'incomplete' });
  });

  it('schema violations are incomplete (wrong status value, bad kind, extra keys)', () => {
    const base = { operationId: OP, mutationId: 'mut-A', mutationKind: 'transactions.expense.create', affectedTargets: ['transactions'] };
    expect(validateConfirmationReceipt(JSON.stringify({ ...base, status: 'failed' }), OP)).toEqual({
      kind: 'invalid',
      reason: 'incomplete',
    });
    expect(validateConfirmationReceipt(JSON.stringify({ ...base, status: 'succeeded', mutationKind: 'nope' }), OP)).toEqual({
      kind: 'invalid',
      reason: 'incomplete',
    });
    expect(validateConfirmationReceipt(JSON.stringify({ ...base, status: 'succeeded', forged: true }), OP)).toEqual({
      kind: 'invalid',
      reason: 'incomplete',
    });
  });

  it('unparseable or non-object receipts are corrupt', () => {
    expect(validateConfirmationReceipt('{oops', OP)).toEqual({ kind: 'invalid', reason: 'corrupt' });
    expect(validateConfirmationReceipt('123', OP)).toEqual({ kind: 'invalid', reason: 'corrupt' });
    expect(validateConfirmationReceipt('[1,2]', OP)).toEqual({ kind: 'invalid', reason: 'corrupt' });
    expect(validateConfirmationReceipt('null', OP)).toEqual({ kind: 'invalid', reason: 'corrupt' });
  });

  it('missing or different operationId is divergent', () => {
    expect(validateConfirmationReceipt(JSON.stringify({ mutationId: 'mut-X' }), OP)).toEqual({
      kind: 'invalid',
      reason: 'divergent',
    });
    expect(validateConfirmationReceipt(JSON.stringify({ operationId: 'pending-B' }), OP)).toEqual({
      kind: 'invalid',
      reason: 'divergent',
    });
  });

  it('explicit non-succeeded status is incomplete (never a false success)', () => {
    expect(
      validateConfirmationReceipt(JSON.stringify({ operationId: OP, status: 'failed' }), OP),
    ).toEqual({ kind: 'invalid', reason: 'incomplete' });
  });
});

describe('noteConfirmationSighted + sentinel adoption on real SQLite (review P1-2/P1-4)', () => {
  const NOW = Date.parse('2026-10-11T12:00:00.000Z');
  const confirmCtx = { workspaceId: 'ws-1', actorId: 'actor-1', deviceId: 'device-1' };

  it('first sighting creates an unbound sentinel (fresh); second sighting replays it (stale, first-seen kept)', () => {
    const { sql } = createSql();
    initializeMutationDraftSchema(sql);
    const store = new SqlMutationDraftStore(sql);
    const first = store.noteConfirmationSighted!(confirmCtx, 'intent-X', NOW);
    expect(first.fresh).toBe(true);
    expect(first.record.operationId).toBe('');
    expect(first.record.status).toBe('reserved');
    expect(Date.parse(first.record.createdAt)).toBe(NOW);
    const second = store.noteConfirmationSighted!(confirmCtx, 'intent-X', NOW + 5_000);
    expect(second.fresh).toBe(false);
    expect(second.record.operationId).toBe('');
    // First-seen instant is preserved, not overwritten by the redelivery.
    expect(Date.parse(second.record.createdAt)).toBe(NOW);
  });

  it('claim adopts the sentinel (CAS): first adopter wins, loser sees identical/divergent', () => {
    const { sql } = createSql();
    initializeMutationDraftSchema(sql);
    const store = new SqlMutationDraftStore(sql);
    expect(store.noteConfirmationSighted!(confirmCtx, 'intent-X', NOW).fresh).toBe(true);
    expect(
      store.claimConfirmation!({ ctx: confirmCtx, intentionId: 'intent-X', operationId: 'op-A', receiptJson: null, status: 'reserved', nowMs: NOW + 1 }),
    ).toBe('claimed');
    const bound = store.findConfirmation!(confirmCtx, 'intent-X', NOW + 1);
    expect(bound?.operationId).toBe('op-A');
    // First-seen survives the adoption (temporal check keeps the original instant).
    expect(Date.parse(bound?.createdAt ?? '')).toBe(NOW);
    expect(
      store.claimConfirmation!({ ctx: confirmCtx, intentionId: 'intent-X', operationId: 'op-A', receiptJson: null, status: 'reserved', nowMs: NOW + 2 }),
    ).toBe('identical');
    expect(
      store.claimConfirmation!({ ctx: confirmCtx, intentionId: 'intent-X', operationId: 'op-B', receiptJson: null, status: 'reserved', nowMs: NOW + 3 }),
    ).toBe('divergent');
  });

  it('sentinel settles to inconclusive and keeps blocking (P1-2: no-target outcome is durable)', () => {
    const { sql } = createSql();
    initializeMutationDraftSchema(sql);
    const store = new SqlMutationDraftStore(sql);
    store.noteConfirmationSighted!(confirmCtx, 'intent-X', NOW);
    expect(
      store.settleConfirmation!({ ctx: confirmCtx, intentionId: 'intent-X', operationId: '', status: 'inconclusive', receiptJson: null, nowMs: NOW }),
    ).toBe(true);
    expect(store.findConfirmation!(confirmCtx, 'intent-X', NOW)).toMatchObject({ operationId: '', status: 'inconclusive' });
    // A later claim for B is divergent against the sentinel — never adopted.
    expect(
      store.claimConfirmation!({ ctx: confirmCtx, intentionId: 'intent-X', operationId: 'op-B', receiptJson: null, status: 'reserved', nowMs: NOW + 1 }),
    ).toBe('divergent');
  });
});