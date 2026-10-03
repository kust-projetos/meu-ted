import { describe, expect, it, beforeEach } from 'vitest';
import {
  deriveIdempotencyKey,
  remember,
  recall,
  clearMemoryLedger,
  initializeIntentionLedgerSchema,
} from '../src/tools/intention-ledger.js';

describe('Intention Tool Ledger (Task 6)', () => {
  beforeEach(() => {
    clearMemoryLedger();
  });

  it('derives deterministic idempotency key from composite tuple', () => {
    const key1 = deriveIdempotencyKey('ws-1', 'intent-1', 'call-1');
    const key2 = deriveIdempotencyKey('ws-1', 'intent-1', 'call-1');
    const keyDifferent = deriveIdempotencyKey('ws-1', 'intent-1', 'call-2');

    expect(key1).toBe(key2);
    expect(key1).toHaveLength(64);
    expect(key1).not.toBe(keyDifferent);
  });

  it('remembers and recalls tool idempotency keys in memory', () => {
    const key = deriveIdempotencyKey('ws-1', 'intent-1', 'call-1');
    remember('ws-1', 'intent-1', 'call-1', key, { success: true });

    const recalled = recall('ws-1', 'intent-1', 'call-1');
    expect(recalled).toEqual({
      key,
      outcome: { success: true },
    });

    expect(recall('ws-1', 'intent-1', 'call-other')).toBeUndefined();
  });

  it('supports SQLite schema and operations', () => {
    const executed: string[] = [];
    const mockSql = {
      exec: (query: string) => {
        executed.push(query);
        return [];
      },
    };

    initializeIntentionLedgerSchema(mockSql);
    expect(executed[0]).toContain('CREATE TABLE IF NOT EXISTS intention_tool_ledger');

    remember('ws-1', 'intent-1', 'call-1', 'idem-key', { id: 'acc-1' }, mockSql);
    expect(executed.some((q) => q.includes('INSERT INTO intention_tool_ledger'))).toBe(true);
  });
});

/**
 * A02 (R02/AC05/AC06/AC07) — the ledger is the server-side dedup by identity.
 * The report of a "message that disappears" is a HYPOTHESIS (SPEC §2.1/F13):
 * these tests pin that the ledger NEVER dedups by content — only by the
 * composite (workspace, intentionId, toolCallId) — and that a redelivery of
 * the same intention collapses to a single durable entry (one effect).
 */
describe('Intention Tool Ledger — identity, never text (A02/R02)', () => {
  /**
   * Faithful in-memory stand-in for the DO's SQLite surface. It reproduces the
   * EXACT semantics of `src/tools/intention-ledger.ts`:
   *   PRIMARY KEY (workspace_id, intention_id, tool_call_id)
   *   ON CONFLICT (...) DO UPDATE SET outcome_json = excluded.outcome_json
   * — i.e. a conflict keeps the row's ORIGINAL `idempotency_key` (only the
   * outcome is rewritten) and the row identity is the 3-column TUPLE, never an
   * ambiguous string concatenation.
   */
  const durableSql = () => {
    const rows = new Map<string, { idempotency_key: string; outcome_json: string | null }>();
    // Unambiguous tuple encoding: a plain `${a}:${b}` concatenation would alias
    // ('a:b','c') with ('a','b:c') into the same row.
    const rowKey = (workspace: string, intentionId: string, toolCallId: string): string =>
      JSON.stringify([workspace, intentionId, toolCallId]);
    return {
      rows,
      exec: <T = Record<string, unknown>>(query: string, ...params: unknown[]): Iterable<T> => {
        if (query.includes('INSERT INTO intention_tool_ledger')) {
          const [workspace, intentionId, toolCallId, key, outcome] = params as [
            string,
            string,
            string,
            string,
            string | null,
          ];
          const composite = rowKey(workspace, intentionId, toolCallId);
          const existing = rows.get(composite);
          rows.set(composite, {
            // DO UPDATE SET outcome_json — the key is NOT in the update list.
            idempotency_key: existing ? existing.idempotency_key : key,
            outcome_json: outcome,
          });
          return [] as unknown as Iterable<T>;
        }
        if (query.includes('SELECT idempotency_key')) {
          const [workspace, intentionId, toolCallId] = params as [string, string, string];
          const row = rows.get(rowKey(workspace, intentionId, toolCallId));
          return (row ? [row] : []) as unknown as Iterable<T>;
        }
        return [] as unknown as Iterable<T>;
      },
    };
  };

  beforeEach(() => {
    clearMemoryLedger();
  });

  it('AC05: redelivering the same intentionId keeps ONE durable entry (one effect)', () => {
    const sql = durableSql();
    const key = deriveIdempotencyKey('ws-1', 'msg-A', 'call-1');

    remember('ws-1', 'msg-A', 'call-1', key, { attempt: 1 }, sql);
    remember('ws-1', 'msg-A', 'call-1', key, { attempt: 2 }, sql);

    expect(sql.rows.size).toBe(1);
    expect(recall('ws-1', 'msg-A', 'call-1', sql)).toEqual({
      key,
      outcome: { attempt: 2 },
    });
  });

  it('AC06: identical content under distinct intentionIds keeps DISTINCT durable entries', () => {
    const sql = durableSql();
    const first = deriveIdempotencyKey('ws-1', 'msg-A', 'call-1');
    const second = deriveIdempotencyKey('ws-1', 'msg-B', 'call-1');

    remember('ws-1', 'msg-A', 'call-1', first, { amountCents: 5000 }, sql);
    remember('ws-1', 'msg-B', 'call-1', second, { amountCents: 5000 }, sql);

    expect(sql.rows.size).toBe(2);
    expect(recall('ws-1', 'msg-A', 'call-1', sql)?.key).toBe(first);
    expect(recall('ws-1', 'msg-B', 'call-1', sql)?.key).toBe(second);
  });

  it('AC07: the same intentionId in another workspace is a DIFFERENT entry (scope is part of identity)', () => {
    const sql = durableSql();
    remember('ws-1', 'msg-A', 'call-1', 'key-ws1', { ok: true }, sql);
    remember('ws-2', 'msg-A', 'call-1', 'key-ws2', { ok: true }, sql);

    expect(sql.rows.size).toBe(2);
    expect(recall('ws-1', 'msg-A', 'call-1', sql)?.key).toBe('key-ws1');
    expect(recall('ws-2', 'msg-A', 'call-1', sql)?.key).toBe('key-ws2');
  });

  it('conflito com chave DIFERENTE preserva a chave original (ON CONFLICT só atualiza outcome_json)', () => {
    const sql = durableSql();
    const original = deriveIdempotencyKey('ws-1', 'msg-A', 'call-1');

    remember('ws-1', 'msg-A', 'call-1', original, { attempt: 1 }, sql);
    // Redelivery com uma chave derivada DIFERENTE: o upsert real
    // (ON CONFLICT ... DO UPDATE SET outcome_json) preserva a
    // idempotency_key ORIGINAL da linha — a chave faz parte da identidade e
    // nunca é reescrita.
    remember('ws-1', 'msg-A', 'call-1', 'chave-diferenta', { attempt: 2 }, sql);

    expect(sql.rows.size).toBe(1);
    expect(recall('ws-1', 'msg-A', 'call-1', sql)).toEqual({
      key: original,
      outcome: { attempt: 2 },
    });
  });

  it('a chave da linha é a TUPLA (workspace, intention, toolCall) — sem ambiguidade por concatenação', () => {
    const sql = durableSql();
    // Concatenações ingênuas colidem: ('a:b','c') e ('a','b:c') viram a MESMA
    // string. A tupla real não.
    remember('a:b', 'c', 'call-1', 'key-1', { ok: true }, sql);
    remember('a', 'b:c', 'call-1', 'key-2', { ok: true }, sql);

    expect(sql.rows.size).toBe(2);
    expect(recall('a:b', 'c', 'call-1', sql)?.key).toBe('key-1');
    expect(recall('a', 'b:c', 'call-1', sql)?.key).toBe('key-2');
  });

  it('the derived key is a pure function of the composite identity (content never enters)', () => {
    // Same identity → same key (retry/redelivery dedup); any identity change →
    // different key. The message text is not part of the input at all.
    expect(deriveIdempotencyKey('ws-1', 'msg-A', 'call-1')).toBe(deriveIdempotencyKey('ws-1', 'msg-A', 'call-1'));
    expect(deriveIdempotencyKey('ws-1', 'msg-A', 'call-1')).not.toBe(deriveIdempotencyKey('ws-1', 'msg-B', 'call-1'));
    expect(deriveIdempotencyKey('ws-1', 'msg-A', 'call-1')).not.toBe(deriveIdempotencyKey('ws-2', 'msg-A', 'call-1'));
    expect(deriveIdempotencyKey('ws-1', 'msg-A', 'call-1')).not.toBe(deriveIdempotencyKey('ws-1', 'msg-A', 'call-2'));
  });
});
