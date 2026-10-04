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
