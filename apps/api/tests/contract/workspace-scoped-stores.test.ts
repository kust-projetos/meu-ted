import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createInMemoryStores } from '../../src/writes/in-memory.js';
import { createInMemoryPayableStore } from '../../src/payables/in-memory.js';

// Global administrative scheduler loaders exempt from household scoping.
// Each entry is "<relativePath>::<normalized SQL>" and must keep an inline
// justification. Current entry:
// - src/payables/postgres.ts listAllNotifications: global scheduler loader; privileged pool; no user credential; in-memory enabled filter; C5 targets user-scoped auth/data queries.
const GLOBAL_ADMIN_LOADER_ALLOWLIST: ReadonlySet<string> = new Set([
  'src/payables/postgres.ts::SELECT * FROM notification_configs WHERE enabled = true ORDER BY household_id, id',
]);

const ROOT = resolve(import.meta.dirname, '../..');
const STORE_FILES = [
  'src/auth/device-token.ts',
  'src/budgets/postgres.ts',  'src/cards/postgres.ts',
  'src/goals/postgres.ts',
  'src/payables/postgres.ts',
  'src/subscriptions/postgres.ts',
  'src/profile/postgres.ts',
  'src/read-models/postgres-store.ts',
  'src/writes/postgres.ts',
];

const IN_MEMORY_STORE_FILES = [
  'src/budgets/in-memory.ts',
  'src/cards/in-memory.ts',
  'src/goals/in-memory.ts',
  'src/payables/in-memory.ts',
  'src/profile/in-memory.ts',
  'src/subscriptions/in-memory.ts',
  'src/writes/in-memory.ts',
];

describe('store workspace scoping contract', () => {
  it('requires household_id in every SQL lookup, update, and delete', () => {
    const violations: string[] = [];

    for (const relativePath of STORE_FILES) {
      const source = readFileSync(resolve(ROOT, relativePath), 'utf8');
      for (const match of source.matchAll(/`([\s\S]*?)`/g)) {
        const sql = match[1]!.replace(/\s+/g, ' ').trim();
        if (!/^(SELECT|UPDATE|DELETE)\b/i.test(sql)) continue;
        if (!/\bWHERE\b/i.test(sql)) continue;
        // The condition arrays are initialized with household_id and then
        // extended with optional filters at runtime.
        if (/\$\{conditions\.join/i.test(sql)) {
          if (!/const conditions: string\[\] = \['(?:\w+\.)?household_id\s*=\s*\$1'/i.test(source)) violations.push(`${relativePath}: dynamic conditions lack household scope`);
          continue;
        }
        if (/\$\{whereSql\}/i.test(sql)) {
          if (!/const where: string\[\] = \['(?:\w+\.)?household_id\s*=\s*\$1'/i.test(source)) violations.push(`${relativePath}: dynamic where lacks household scope`);
          continue;
        }
        if (/\bworkspace_id\s*=/i.test(sql)) continue;
        if (GLOBAL_ADMIN_LOADER_ALLOWLIST.has(`${relativePath}::${sql}`)) continue;
        if (!/\bhousehold_id\s*=/i.test(sql)) violations.push(`${relativePath}: ${sql}`);
      }
    }

    expect(violations).toEqual([]);
  });

  it('audits every in-memory store for household-scoped paths', () => {
    for (const relativePath of IN_MEMORY_STORE_FILES) {
      const source = readFileSync(resolve(ROOT, relativePath), 'utf8');
      expect(source, relativePath).toMatch(/householdId/);
      expect(source, relativePath).not.toMatch(/\.find\(\s*\w+\s*=>\s*(?![^\n]*householdId)[^\n]*\.id\s*===/m);
      expect(source, relativePath).not.toMatch(/\.filter\(\s*\w+\s*=>\s*(?![^\n]*householdId)[^\n]*\.id\s*===/m);
    }
  });

  it('listing household A does not mutate household B payable status', async () => {
    const { state } = createInMemoryStores();
    const store = createInMemoryPayableStore(state);
    const input = { accountId: 'account', description: 'Conta', amountCents: 100, dueDate: '2000-01-01' };
    await store.createPayable('A', input);
    await store.createPayable('B', input);

    await store.listPayables('A');
    const householdB = (state as unknown as { _payables: Array<{ householdId: string; status: string }> })._payables
      .find((payable) => payable.householdId === 'B');

    expect(householdB?.status).toBe('pending');
  });
});
