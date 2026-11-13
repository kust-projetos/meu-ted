// SPIKE 04 oracles — frozen deterministic expectations (NO LLM, NO live).
//
// Provenance (apurado 2026-10-31, sem inference, sem custo):
//   - Fixtures: D:/projetos/pi-financeiro/apps/api/tests/fixtures/seed.ts
//     (standard seed: ACCOUNT_A1 Itaú 100000, ACCOUNT_A2 Nubank 50000,
//     ACCOUNT_B1 Bradesco 99999; TRANSACTIONS 4x A em 2026-06 + 1x B em 2026-06).
//   - Path: finance-bridge.ts (buildTestApp + real fixtures) via
//     finance-transport.mjs callFinance({route, method:'GET', host}) —
//     mesma plumbing do spike-02/03B, math NUNCA reimplementada aqui.
//   - Comando de apuração:
//       node --input-type=module -e "import('./experiments/ted-runtime/bootstrap/finance-transport.mjs').then(... callFinance /dashboard/month-summary?yearMonth=2026-06|2026-05|2025-06 + /accounts p/ HOST_A/B ...)"
//     executado na worktree experiment/ted-opencode-runtime (D:/projetos/pi-ted-runtime-spike).
//   - Saídas exatas congeladas abaixo (statusCode 200 em todos os 8 casos).
//
// Contratos:
//   - Hosts: dev-token-1 -> HOUSEHOLD_A, dev-token-2 -> HOUSEHOLD_B
//     (test-app token store; mesma convenção do spike-02.test.mjs).
//   - NENHUM segredo aqui (só valores financeiros sintéticos + UUIDs públicos
//     das fixtures). Este arquivo NUNCA decide tools por frase (sem router,
//     sem regex de frases) — apenas dados congelados + comparadores puros.

export const HOST_A = Object.freeze({
  label: 'A',
  token: 'dev-token-1',
  household: 'HOUSEHOLD_A',
  actorId: 'dev-device-1',
  deviceId: 'dev-device-1',
});

export const HOST_B = Object.freeze({
  label: 'B',
  token: 'dev-token-2',
  household: 'HOUSEHOLD_B',
  actorId: 'dev-device-2',
  deviceId: 'dev-device-2',
});

// UUIDs públicos das fixtures (seed.ts) — referência, não segredo.
export const HOUSEHOLD_IDS = Object.freeze({
  A: '00000000-0000-4000-8000-00000000000a',
  B: '00000000-0000-4000-8000-00000000000b',
});

// ---- Summaries congelados (GET /dashboard/month-summary?yearMonth=...) ----
export const SUMMARY_A_2026_06 = Object.freeze({
  yearMonth: '2026-06',
  incomeCents: 1200000,
  expenseCents: 288050,
  balanceCents: 911950,
  transactionCount: 4,
});

export const SUMMARY_A_2026_05 = Object.freeze({
  yearMonth: '2026-05',
  incomeCents: 0,
  expenseCents: 0,
  balanceCents: 0,
  transactionCount: 0,
});

export const SUMMARY_A_2025_06 = Object.freeze({
  yearMonth: '2025-06',
  incomeCents: 0,
  expenseCents: 0,
  balanceCents: 0,
  transactionCount: 0,
});

export const SUMMARY_B_2026_06 = Object.freeze({
  yearMonth: '2026-06',
  incomeCents: 0,
  expenseCents: 20000,
  balanceCents: -20000,
  transactionCount: 1,
});

export const SUMMARY_B_2026_05 = Object.freeze({
  yearMonth: '2026-05',
  incomeCents: 0,
  expenseCents: 0,
  balanceCents: 0,
  transactionCount: 0,
});

export const SUMMARY_B_2025_06 = Object.freeze({
  yearMonth: '2025-06',
  incomeCents: 0,
  expenseCents: 0,
  balanceCents: 0,
  transactionCount: 0,
});

// ---- Accounts congelados (GET /accounts) ----
export const ACCOUNTS_A = Object.freeze({
  total: 2,
  items: Object.freeze([
    Object.freeze({
      id: '11111111-1111-4111-8111-111111111111',
      householdId: HOUSEHOLD_IDS.A,
      name: 'Itaú',
      kind: 'bank',
      balanceCents: 100000,
      status: 'active',
    }),
    Object.freeze({
      id: '11111111-1111-4111-8111-111111111112',
      householdId: HOUSEHOLD_IDS.A,
      name: 'Nubank',
      kind: 'bank',
      balanceCents: 50000,
      status: 'active',
    }),
  ]),
});

export const ACCOUNTS_B = Object.freeze({
  total: 1,
  items: Object.freeze([
    Object.freeze({
      id: '11111111-1111-4111-8111-111111111113',
      householdId: HOUSEHOLD_IDS.B,
      name: 'Bradesco',
      kind: 'bank',
      balanceCents: 99999,
      status: 'active',
    }),
  ]),
});

// Mapa de acesso puro: (hostLabel, yearMonth) -> summary congelado.
const SUMMARIES = {
  'A:2026-06': SUMMARY_A_2026_06,
  'A:2026-05': SUMMARY_A_2026_05,
  'A:2025-06': SUMMARY_A_2025_06,
  'B:2026-06': SUMMARY_B_2026_06,
  'B:2026-05': SUMMARY_B_2026_05,
  'B:2025-06': SUMMARY_B_2025_06,
};

const ACCOUNTS = { A: ACCOUNTS_A, B: ACCOUNTS_B };

export function oracleSummary(hostLabel, yearMonth) {
  const hit = SUMMARIES[`${hostLabel}:${yearMonth}`];
  if (!hit) throw new Error(`no oracle for ${hostLabel}:${yearMonth}`);
  return hit;
}

export function oracleAccounts(hostLabel) {
  const hit = ACCOUNTS[hostLabel];
  if (!hit) throw new Error(`no accounts oracle for ${hostLabel}`);
  return hit;
}

// ---- Comparadores puros (sem transporte, sem regex de frases) ----
export function matchSummary(actual, expected) {
  const details = {};
  if (!actual || typeof actual !== 'object') return { ok: false, details: { shape: 'not-an-object' } };
  for (const f of ['incomeCents', 'expenseCents', 'balanceCents', 'transactionCount']) {
    if (typeof actual[f] !== 'number') return { ok: false, details: { [f]: `expected number, got ${typeof actual[f]}` } };
    details[f] = actual[f];
  }
  // Period identity: when the oracle expectation pins a yearMonth, the
  // observed body must carry the SAME period. Equal numbers from the WRONG
  // month (e.g. zeros of 2026-05 replayed for 2026-04) must mismatch.
  if (expected && typeof expected.yearMonth === 'string') {
    if (typeof actual.yearMonth !== 'string') {
      return { ok: false, details: { ...details, yearMonth: `expected yearMonth string, got ${typeof actual.yearMonth}` } };
    }
    details.yearMonth = actual.yearMonth;
    if (actual.yearMonth !== expected.yearMonth) {
      return { ok: false, details: { ...details, yearMonth: `expected ${expected.yearMonth}, got ${actual.yearMonth}` }, expected: { ...expected } };
    }
  }
  const ok =
    actual.incomeCents === expected.incomeCents &&
    actual.expenseCents === expected.expenseCents &&
    actual.balanceCents === expected.balanceCents &&
    actual.transactionCount === expected.transactionCount;
  return { ok, details, expected: { ...expected } };
}

export function matchAccounts(actual, expectedOracle, expectedHouseholdId = null) {
  const rows = Array.isArray(actual) ? actual : actual && Array.isArray(actual.items) ? actual.items : null;
  if (!rows) return { ok: false, details: { shape: 'expected array or {items:[]}' } };
  // Expected household scope: explicit param wins; otherwise the oracle's own
  // householdIds. Every returned row MUST belong to this scope (A/B
  // isolation: a cross-household row fails even with matching name/balance).
  const oracleHouseholds = [...new Set((expectedOracle.items || []).map((x) => x && x.householdId).filter(Boolean))];
  const allowedHouseholds = expectedHouseholdId ? [expectedHouseholdId] : oracleHouseholds;
  const missing = [];
  for (const exp of expectedOracle.items) {
    const hit = rows.find((r) => r && r.name === exp.name && r.balanceCents === exp.balanceCents
      && (!exp.householdId || r.householdId === exp.householdId));
    if (!hit) missing.push(`${exp.name}:${exp.balanceCents}`);
  }
  const foreignHousehold = rows.filter((r) => r && r.householdId && !allowedHouseholds.includes(r.householdId));
  const unscoped = expectedHouseholdId
    ? rows.filter((r) => r && r.householdId !== expectedHouseholdId)
    : [];
  const extraHouseholds = [...new Set(rows.map((r) => r && r.householdId).filter(Boolean))];
  return {
    ok: missing.length === 0 && rows.length === expectedOracle.items.length
      && foreignHousehold.length === 0 && unscoped.length === 0,
    details: {
      count: rows.length,
      total: actual && actual.total,
      missing,
      householdIds: extraHouseholds.slice(0, 5),
      expectedHouseholdId: expectedHouseholdId || null,
      foreignHousehold: foreignHousehold.map((r) => `${r.name}:${r.householdId}`).slice(0, 5),
    },
  };
}
