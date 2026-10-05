/**
 * A17/F1 — the memory schema must be valid on a REAL SQLite engine.
 *
 * `references` is a RESERVED keyword of SQLite: `ALTER TABLE ... ADD COLUMN
 * references TEXT` is a syntax error. The schema initializer swallowed that
 * error, so the failure surfaced later as an INSERT against a column that does
 * not exist — the write path was broken while the mock adapters happily
 * accepted anything.
 *
 * This file runs the store against `node:sqlite` (already used by
 * `tests/orchestration/mutation-draft-sql.test.ts`, no new dependency) so the
 * DDL, the INSERT and the read-back are validated by the actual parser, and it
 * asserts that no identifier of the A17 columns is a SQLite keyword.
 */
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { createMemorySql } from './helpers/memory-sql.js';
import {
  initializeMemorySchema,
  recallMemories,
  rememberCorrection,
  rememberFact,
} from '../src/agent-config/memory/store.js';

/**
 * The SQLite keyword list (sqlite.org/lang_keywords.html). A column named after
 * one of these breaks every DDL/DML statement that uses it unquoted, so the
 * A17 columns are asserted against it.
 */
const SQLITE_KEYWORDS: ReadonlySet<string> = new Set(
  (
    'ABORT ACTION ADD AFTER ALL ALTER ALWAYS ANALYZE AND AS ASC ATTACH AUTOINCREMENT BEFORE BEGIN BETWEEN BY ' +
    'CASCADE CASE CAST CHECK COLLATE COLUMN COMMIT CONFLICT CONSTRAINT CREATE CROSS CURRENT CURRENT_DATE ' +
    'CURRENT_TIME CURRENT_TIMESTAMP DATABASE DEFAULT DEFERRABLE DEFERRED DELETE DESC DETACH DISTINCT DO DROP ' +
    'EACH ELSE END ESCAPE EXCEPT EXCLUDE EXCLUSIVE EXISTS EXPLAIN FAIL FILTER FIRST FOLLOWING FOR FOREIGN FROM ' +
    'FULL GENERATED GLOB GROUP GROUPS HAVING IF IGNORE IMMEDIATE IN INDEX INDEXED INITIALLY INNER INSERT INSTEAD ' +
    'INTERSECT INTO IS ISNULL JOIN KEY LAST LEFT LIKE LIMIT MATCH MATERIALIZED NATURAL NO NOT NOTHING NOTNULL ' +
    'NULL NULLS OF OFFSET ON OR ORDER OTHERS OUTER OVER PARTITION PLAN PRAGMA PRECEDING PRIMARY QUERY RAISE ' +
    'RANGE RECURSIVE REFERENCES REGEXP REINDEX RELEASE RENAME REPLACE RESTRICT RETURNING RIGHT ROLLBACK ROW ' +
    'ROWS SAVEPOINT SELECT SET TABLE TEMP TEMPORARY THEN TIES TO TRANSACTION TRIGGER UNBOUNDED UNION UNIQUE ' +
    'UPDATE USING VACUUM VALUES VIEW VIRTUAL WHEN WHERE WINDOW WITH WITHOUT'
  ).split(/\s+/).map((keyword) => keyword.toLowerCase()),
);

/** Every column the A17 slice adds to `agent_memory`. */
const A17_COLUMNS = ['fingerprint', 'provenance', 'catalog_references', 'invalidated_at'] as const;

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

const WS = 'ws-sqlite';
const ACTOR = 'u-1';

describe('memory schema on real SQLite (A17/F1)', () => {
  it('applies every A17 column: the ADD COLUMN statements are real SQL', () => {
    const { sql } = createRealSql();
    initializeMemorySchema(sql);

    const columns = [...sql.exec<Record<string, unknown>>(`PRAGMA table_info(agent_memory)`)].map((row) =>
      String(row.name),
    );
    for (const column of A17_COLUMNS) expect(columns).toContain(column);
    // Re-running the initializer stays idempotent (additive, no destructive migration).
    expect(() => initializeMemorySchema(sql)).not.toThrow();
  });

  it('uses only non-keyword identifiers for the A17 columns', () => {
    for (const column of A17_COLUMNS) expect(SQLITE_KEYWORDS.has(column.toLowerCase())).toBe(false);
    // The regression itself: `references` IS a keyword, which is why the column
    // is named `catalog_references`.
    expect(SQLITE_KEYWORDS.has('references')).toBe(true);
    expect(SQLITE_KEYWORDS.has('catalog_references')).toBe(false);
  });

  it('the in-repo SQL adapter refuses a keyword identifier just like a real engine', () => {
    // The mock used to accept anything, which is why the reserved-word column
    // survived the suite. It now mirrors the real parser for identifiers.
    const sql = createMemorySql();
    expect(() =>
      sql.exec('ALTER TABLE agent_memory ADD COLUMN references TEXT'),
    ).toThrowError(/syntax error/);
    expect(() =>
      sql.exec('INSERT INTO agent_memory (id, references) VALUES (?, ?)', 'a', '[]'),
    ).toThrowError(/syntax error/);
    // And the real schema applies cleanly through the same adapter.
    expect(() => initializeMemorySchema(sql)).not.toThrow();
    expect(sql.columns.get('agent_memory')!.has('catalog_references')).toBe(true);
  });

  it('writes and reads a memory carrying catalog references', () => {
    const { sql } = createRealSql();
    initializeMemorySchema(sql);

    const stored = rememberFact(sql, {
      workspaceId: WS,
      actor: ACTOR,
      kind: 'learning',
      content: 'Padaria usa a conta account_id=acc_grocery e a categoria category_id=cat_padarias',
    });
    expect(stored.stored).toBe(true);
    if (!stored.stored) throw new Error('expected the write to succeed');

    const recalled = recallMemories(sql, { workspaceId: WS, actor: ACTOR });
    expect(recalled).toHaveLength(1);
    expect(recalled[0]!.references).toEqual([
      { kind: 'account', id: 'acc_grocery' },
      { kind: 'category', id: 'cat_padarias' },
    ]);
    expect(recalled[0]!.requiresRevalidation).toBe(true);
  });

  it('keeps promotable stable across the write/read round trip (explicit and derived)', () => {
    const { sql } = createRealSql();
    initializeMemorySchema(sql);

    const explicit = rememberFact(sql, { workspaceId: WS, actor: ACTOR, content: 'Prefere resumos curtos' });
    const derived = rememberCorrection(sql, {
      workspaceId: WS,
      actor: ACTOR,
      target: 'merchant:padaria-sao-jose',
      field: 'category',
      turnFingerprint: 'turn-sqlite-1',
      content: 'Padaria São José foi corrigida para a categoria Padarias',
    });
    expect(explicit.stored).toBe(true);
    expect(derived.stored).toBe(true);
    if (!explicit.stored || !derived.stored) throw new Error('expected both writes to succeed');
    // Write-side verdict.
    expect(explicit.item.promotable).toBe(true);
    expect(derived.item.promotable).toBe(false);

    const recalled = recallMemories(sql, { workspaceId: WS, actor: ACTOR });
    expect(recalled).toHaveLength(2);
    const byContent = (needle: string) => recalled.find((item) => item.content.includes(needle))!;
    // Read-side verdict must be IDENTICAL: an explicit memory stays promotable
    // and a derived one stays non-promotable.
    expect(byContent('resumos curtos').promotable).toBe(true);
    expect(byContent('corrigida para a categoria').promotable).toBe(false);
    expect(byContent('corrigida para a categoria').kind).toBe('learning');
  });
});