// Contract parity guard between the TED runtime catalog and the real API.
//
// The A0 rollback path and the OpenCode runtime intentionally keep separate
// execution loops, so this test does NOT try to unify them. It only fails when
// the runtime starts pointing at something the API does not declare:
// - every `propose_*` tool must map to an `APPROVAL_TOOL_IDS` entry;
// - every `propose_*` tool must exist in TOOL_DEFS/TOOL_NAMES;
// - every read tool must resolve to a GET route declared in route-inventory.ts.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  TOOL_DEFS,
  TOOL_NAMES,
  PROPOSAL_TOOL_SPECS,
  createToolExecutors,
} from '../src/tool-defs.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const apiSource = (relative) => fs.readFileSync(path.join(ROOT, 'apps', 'api', 'src', relative), 'utf8');

function approvalToolIds() {
  const source = apiSource(path.join('approvals', 'tool-registry.ts'));
  const block = source.match(/export const APPROVAL_TOOL_IDS = \[([\s\S]*?)\] as const;/);
  assert.ok(block, 'APPROVAL_TOOL_IDS block must exist');
  return [...block[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

function inventoryRoutes() {
  const source = apiSource(path.join('routes', 'route-inventory.ts'));
  return new Set(
    [...source.matchAll(/\{\s*id:\s*'[^']+',\s*method:\s*'([A-Z]+)',\s*path:\s*'([^']+)'/g)].map(
      (match) => `${match[1]} ${match[2]}`,
    ),
  );
}

const READ_TOOLS = {
  list_accounts: { route: '/accounts', args: {}, body: { items: [], total: 0 } },
  list_credit_cards: { route: '/cards/accounts', args: {}, body: { items: [], total: 0 } },
  list_categories: { route: '/categories', args: {}, body: { items: [], total: 0 } },
  list_recent_transactions: {
    route: '/transactions',
    args: {},
    body: { items: [], total: 0, limit: 1, offset: 0 },
  },
  spending_insights: {
    route: '/insights/spending',
    args: {},
    body: { success: true, yearMonth: '2026-11', insights: [], transactionCount: 0 },
  },
  list_card_statements: { route: '/cards/statements', args: {}, body: { items: [], total: 0 } },
  get_month_summary: {
    route: '/dashboard/month-summary',
    args: { yearMonth: '2026-11' },
    body: { yearMonth: '2026-11', incomeCents: 0, expenseCents: 0, balanceCents: 0, transactionCount: 0 },
  },
};

const HOST = Object.freeze({ token: 'host-token', household: 'H_A', actorId: 'actor-a' });

describe('runtime catalog ↔ API contract parity', () => {
  it('every propose_* tool maps to a Pending V2 approval tool', () => {
    const ids = new Set(approvalToolIds());
    for (const [name, spec] of Object.entries(PROPOSAL_TOOL_SPECS)) {
      assert.ok(ids.has(spec.tool), `${name} -> ${spec.tool} must exist in APPROVAL_TOOL_IDS`);
    }
  });

  it('every propose_* tool is declared in the runtime catalog', () => {
    for (const name of Object.keys(PROPOSAL_TOOL_SPECS)) {
      assert.ok(TOOL_NAMES.includes(name), `${name} must exist in TOOL_NAMES`);
      assert.ok(TOOL_DEFS.some((def) => def.name === name), `${name} must exist in TOOL_DEFS`);
    }
  });

  it('every read tool resolves to a GET route declared by the API', async () => {
    const routes = inventoryRoutes();
    const calls = [];
    const executors = createToolExecutors(async (input) => {
      const base = String(input.route).split('?')[0];
      const entry = Object.values(READ_TOOLS).find((candidate) => candidate.route === base);
      calls.push({ route: base, method: input.method });
      return { statusCode: 200, body: entry.body };
    });

    for (const [name, { args }] of Object.entries(READ_TOOLS)) {
      calls.length = 0;
      await executors[name](args, HOST, { intentionId: `int-${name}` });
      assert.deepEqual(calls, [{ route: READ_TOOLS[name].route, method: 'GET' }], `${name} transport call`);
      assert.ok(
        routes.has(`GET ${READ_TOOLS[name].route}`),
        `${name} -> GET ${READ_TOOLS[name].route} must exist in route-inventory.ts`,
      );
    }
  });
});
