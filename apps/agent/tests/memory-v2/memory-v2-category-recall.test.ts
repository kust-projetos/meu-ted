import { describe, expect, it } from 'vitest';
import {
  forgetMemory,
  initializeMemorySchema,
  recallCorrectionByFingerprint,
  rememberCorrection,
  setMemoryEnabled,
} from '../../src/agent-config/memory/store.js';
import { createMemorySql } from '../helpers/memory-sql.js';

const makeStore = () => {
  const sql = createMemorySql();
  initializeMemorySchema(sql);
  return sql;
};

const save = (sql: ReturnType<typeof createMemorySql>, workspaceId: string, actor: string, target = 'uber') =>
  rememberCorrection(sql, {
    workspaceId, actor, target, field: 'category',
    content: 'Para "uber", a categoria usada é "Transporte".',
    references: [{ kind: 'category', id: 'category-1' }],
  });

const read = (sql: ReturnType<typeof createMemorySql>, workspaceId = 'ws-1', actor = 'actor-1', target = 'uber') =>
  recallCorrectionByFingerprint(sql, { workspaceId, actor, target, field: 'category' });

describe('recallCorrectionByFingerprint', () => {
  it('reads the exact correction with its reference and dedupes repeats', () => {
    const sql = makeStore();
    expect(save(sql, 'ws-1', 'actor-1').stored).toBe(true);
    expect(save(sql, 'ws-1', 'actor-1')).toMatchObject({ stored: true, deduped: true });
    expect(read(sql)).toMatchObject({ kind: 'learning', references: [{ kind: 'category', id: 'category-1' }] });
    expect(sql.rows('agent_memory')).toHaveLength(1);
  });

  it('does not return another actor or workspace memory', () => {
    const sql = makeStore();
    save(sql, 'ws-1', 'actor-1');
    expect(read(sql, 'ws-1', 'actor-2')).toBeNull();
    expect(read(sql, 'ws-2', 'actor-1')).toBeNull();
  });

  it('hides invalidated, expired and opted-out memories', () => {
    const sql = makeStore();
    const invalidated = save(sql, 'ws-1', 'actor-1');
    if (!invalidated.stored) throw new Error('expected stored correction');
    forgetMemory(sql, { workspaceId: 'ws-1', id: invalidated.item.id });
    expect(read(sql)).toBeNull();

    const expired = save(sql, 'ws-1', 'actor-1', 'taxi');
    if (!expired.stored) throw new Error('expected stored correction');
    sql.exec('UPDATE agent_memory SET expires_at = ? WHERE id = ?', '2000-01-01T00:00:00.000Z', expired.item.id);
    expect(read(sql, 'ws-1', 'actor-1', 'taxi')).toBeNull();

    setMemoryEnabled(sql, 'ws-1', false);
    expect(read(sql)).toBeNull();
  });
});
