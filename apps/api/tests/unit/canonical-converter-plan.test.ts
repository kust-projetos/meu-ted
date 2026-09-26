import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildConversionPlan,
  collectConversionPlan,
  isAuditedV023BaselineDivergence,
  LEGACY_EXPECTED_COLUMNS,
  V023_AUDITED_CURRENT_CHECKSUM,
  V023_AUDITED_HISTORICAL_CHECKSUM,
  type InventoriedRelation,
  type PlanEvidence,
  type StubPool,
} from '../../src/scripts/canonical-converter/plan.js';
import { planMigrations } from '../../src/read-models/sql/migrate.js';
import { buildCanonicalConversionPreflight } from '../../src/scripts/canonical-conversion-preflight.js';

const cleanPreflight = () =>
  buildCanonicalConversionPreflight({
    legacyAccounts: 0,
    orphanTransactions: 0,
    orphanCardPurchasesInvalid: 0,
    orphanCardPurchasesNull: 0,
    duplicateCategories: 0,
    duplicateStatements: 0,
    usersMissingEmail: 0,
    membershipsUnresolved: 0,
    invitesUnresolved: 0,
    unlinkedStatementPayments: 0,
  });

const baseEvidence = (): PlanEvidence => ({
  relations: [
    { name: 'accounts', kind: 'table' },
    { name: 'transactions', kind: 'table' },
    { name: '_migrations', kind: 'table' },
  ],
  counts: { accounts: 2, transactions: 5, _migrations: 1 },
  contentDigests: {
    accounts: 'a'.repeat(64),
    transactions: 'b'.repeat(64),
    _migrations: 'c'.repeat(64),
  },
  legacyMigrationPlan: planMigrations([], []),
  canonicalMigrationPlan: planMigrations([], []),
  nonzeroInitialBalance: 0,
  missingLegacyColumns: [],
  missingCoreTables: [],
  preflight: cleanPreflight(),
  preflightErrors: [],
});

type Route = { match: (sql: string) => boolean; rows: Array<Record<string, unknown>> };

const stubPool = (routes: Route[]): StubPool => ({
  query: async (sql: string) => {
    const route = routes.find((r) => r.match(sql));
    const rows = route?.rows ?? [];
    return { rows, rowCount: rows.length };
  },
});

const includes =
  (...needles: string[]): Route['match'] =>
  (sql: string) =>
    needles.every((n) => sql.includes(n));

const legacyRelationsRows = (): Array<Record<string, unknown>> => [
  { name: 'accounts', kind: 'r' },
  { name: 'transactions', kind: 'r' },
  { name: '_migrations', kind: 'r' },
];

const realChecksumOf = (file: string): string => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'read-models', 'sql');
  return createHash('sha256').update(readFileSync(join(dir, file), 'utf8'), 'utf8').digest('hex');
};

const signed64 = (hex16: string): bigint => {
  const u = BigInt(`0x${hex16}`);
  return u >= 1n << 63n ? u - (1n << 64n) : u;
};

/** Test mirror of the DB aggregate: COUNT + signed 64-bit SUMs of the md5 halves. */
const aggregateOf = (hashes: string[]): Record<string, unknown> => {
  let hi = 0n;
  let lo = 0n;
  for (const h of hashes) {
    hi += signed64(h.slice(0, 16));
    lo += signed64(h.slice(16, 32));
  }
  return { n: String(hashes.length), s_hi: String(hi), s_lo: String(lo) };
};

const emptyAggregate = (): Record<string, unknown> => ({ n: '0', s_hi: '0', s_lo: '0' });

const cleanStub = (): StubPool =>
  stubPool([
    // No extension-owned objects in the clean fixture (FINDING-3 probe).
    { match: includes('pg_depend'), rows: [] },
    { match: includes('pg_class'), rows: legacyRelationsRows() },
    { match: includes('initial_balance_cents'), rows: [{ count: 0 }] },
    {
      match: includes('information_schema.columns'),
      rows: LEGACY_EXPECTED_COLUMNS.map((c) => ({ table_name: c.table, column_name: c.column })),
    },
    // SOURCE-DIGEST (bounded): single-row COUNT+SUM aggregate per table.
    // Must precede the `_migrations` route: the digest SQL names the table.
    { match: includes('md5('), rows: [emptyAggregate()] },
    { match: includes('COUNT(*'), rows: [{ count: 0 }] },
    {
      match: includes('_migrations'),
      rows: [{ version: 3, name: 'V003__legacy_safe_tables.sql', checksum: realChecksumOf('V003__legacy_safe_tables.sql') }],
    },
  ]);

/**
 * SOURCE-DIGEST fixture: like cleanStub, but the per-row content hashes
 * for `transactions` are explicit. Same counts in every variant — only the
 * CONTENT differs — so any fingerprint change must come from the content
 * digest, never from counts.
 */
const planStubWithContent = (transactionsHashes: string[]): StubPool =>
  stubPool([
    { match: includes('pg_depend'), rows: [] },
    { match: includes('pg_class'), rows: legacyRelationsRows() },
    { match: includes('initial_balance_cents'), rows: [{ count: 0 }] },
    {
      match: includes('information_schema.columns'),
      rows: LEGACY_EXPECTED_COLUMNS.map((c) => ({ table_name: c.table, column_name: c.column })),
    },
    {
      match: (sql: string) => sql.includes('md5(') && sql.includes('"transactions"'),
      rows: [aggregateOf(transactionsHashes)],
    },
    { match: includes('md5('), rows: [emptyAggregate()] },
    {
      match: (sql: string) => sql.includes('COUNT(*)') && sql.includes('"transactions"'),
      rows: [{ count: transactionsHashes.length }],
    },
    { match: includes('COUNT(*'), rows: [{ count: 0 }] },
    {
      match: includes('_migrations'),
      rows: [{ version: 3, name: 'V003__legacy_safe_tables.sql', checksum: realChecksumOf('V003__legacy_safe_tables.sql') }],
    },
  ]);

describe('canonical converter plan (M1)', () => {
  it('reports ready when the legacy snapshot is clean', () => {
    const plan = buildConversionPlan(baseEvidence());
    expect(plan.ready).toBe(true);
    expect(plan.blockers).toEqual([]);
  });

  it('blocks on guarded-era migration drift', () => {
    const manifest = [{ version: 45, name: 'V045__category_tree_defaults.sql', checksum: 'real-checksum' }];
    const evidence = baseEvidence();
    evidence.canonicalMigrationPlan = planMigrations(manifest, [
      { version: 45, name: 'V045__category_tree_defaults.sql', checksum: 'tampered' },
    ]);
    const plan = buildConversionPlan(evidence);
    expect(plan.ready).toBe(false);
    expect(plan.blockers).toContainEqual(
      expect.objectContaining({ code: 'migration_drift', count: 1 }),
    );
  });

  it('blocks on pre-guard baseline drift instead of warning', () => {
    const manifest = [{ version: 8, name: 'V008__legacy_feature_tables.sql', checksum: 'real-checksum' }];
    const evidence = baseEvidence();
    evidence.legacyMigrationPlan = planMigrations(manifest, [
      { version: 8, name: 'V008__legacy_feature_tables.sql', checksum: 'edited-long-ago' },
    ]);
    const plan = buildConversionPlan(evidence);
    expect(plan.ready).toBe(false);
    expect(plan.blockers).toContainEqual(
      expect.objectContaining({ code: 'migration_baseline_drift', count: 1 }),
    );
  });

  it('blocks on unverifiable ledger rows needing checksum backfill', () => {
    const manifest = [{ version: 3, name: 'V003__legacy_safe_tables.sql', checksum: 'real-checksum' }];
    const evidence = baseEvidence();
    evidence.legacyMigrationPlan = planMigrations(manifest, [
      { version: 3, name: 'V003__legacy_safe_tables.sql', checksum: '' },
    ]);
    const plan = buildConversionPlan(evidence);
    expect(plan.ready).toBe(false);
    expect(plan.blockers).toContainEqual(
      expect.objectContaining({ code: 'migration_ledger_unverifiable', count: 1 }),
    );
  });

  it('blocks on orphan entities surfaced by the preflight', () => {
    const evidence = baseEvidence();
    evidence.preflight = buildCanonicalConversionPreflight({
      legacyAccounts: 0,
      orphanTransactions: 2,
      orphanCardPurchasesInvalid: 1,
      orphanCardPurchasesNull: 0,
      duplicateCategories: 0,
      duplicateStatements: 0,
      usersMissingEmail: 0,
      membershipsUnresolved: 0,
      invitesUnresolved: 0,
      unlinkedStatementPayments: 0,
    });
    const plan = buildConversionPlan(evidence);
    expect(plan.ready).toBe(false);
    expect(plan.blockers).toContainEqual(
      expect.objectContaining({ code: 'orphan_transactions', count: 2 }),
    );
    expect(plan.blockers).toContainEqual(
      expect.objectContaining({ code: 'orphan_card_purchases', count: 1 }),
    );
  });

  it('reports nonzero initial balances as informational now that the V058 anchor backfills them', () => {
    const evidence = baseEvidence();
    evidence.nonzeroInitialBalance = 3;
    const plan = buildConversionPlan(evidence);
    expect(plan.ready).toBe(true);
    expect(plan.blockers).toEqual([]);
    expect(plan.informational).toContainEqual(
      expect.objectContaining({ code: 'nonzero_initial_balance', count: 3 }),
    );
  });

  it('blocks on fingerprint mismatch and missing core tables', () => {
    const evidence = baseEvidence();
    evidence.missingLegacyColumns = ['accounts.is_credit_card'];
    evidence.missingCoreTables = ['statements'];
    const plan = buildConversionPlan(evidence);
    expect(plan.ready).toBe(false);
    expect(plan.blockers).toContainEqual(
      expect.objectContaining({ code: 'legacy_fingerprint_mismatch', count: 1 }),
    );
    expect(plan.blockers).toContainEqual(
      expect.objectContaining({ code: 'missing_legacy_core_table', count: 1 }),
    );
  });

  it('blocks on relations outside the known inventory', () => {
    const relations: InventoriedRelation[] = [
      { name: 'accounts', kind: 'table' },
      { name: 'shadow_malicious', kind: 'table' },
    ];
    const plan = buildConversionPlan({ ...baseEvidence(), relations, knownRelations: ['accounts'] });
    expect(plan.ready).toBe(false);
    expect(plan.blockers).toContainEqual(
      expect.objectContaining({ code: 'uninventoried_public_relation', count: 1 }),
    );
  });

  it('FIX-1: surfaces preflight SQL errors with code diagnostics instead of silent zero-counts', () => {
    // Regression: collectConversionPlan swallowed every preflight SQL
    // error into `{ count: 0 }` plus a bare `preflight_unavailable`
    // blocker, hiding the real failure (e.g. `text = uuid` on
    // memberships, missing `invited_by_user_id` on invites). The error
    // code/message must reach the blocker diagnostics and fail the plan.
    const evidence = baseEvidence();
    evidence.preflightErrors = [
      {
        query: 'membershipsUnresolved',
        code: '42883',
        message: 'operator does not exist: text = uuid',
      },
    ];
    const plan = buildConversionPlan(evidence);
    expect(plan.ready).toBe(false);
    expect(plan.blockers).toContainEqual(
      expect.objectContaining({ code: 'preflight_error', count: 1 }),
    );
    const blocker = plan.blockers.find((entry) => entry.code === 'preflight_error');
    expect(blocker?.evidence).toContain('membershipsUnresolved');
    expect(blocker?.evidence).toContain('42883');
    expect(blocker?.evidence).toContain('operator does not exist');
    expect(plan.blockers).not.toContainEqual(
      expect.objectContaining({ code: 'preflight_unavailable' }),
    );
  });

  it('FIX-2: maps an unexpected active NULL set to a blocker through the plan', () => {
    const evidence = baseEvidence();
    evidence.preflight = buildCanonicalConversionPreflight({
      legacyAccounts: 0,
      orphanTransactions: 0,
      orphanCardPurchasesInvalid: 0,
      orphanCardPurchasesNull: 48,
      duplicateCategories: 0,
      duplicateStatements: 0,
      usersMissingEmail: 0,
      membershipsUnresolved: 0,
      invitesUnresolved: 0,
      unlinkedStatementPayments: 0,
    });
    const plan = buildConversionPlan(evidence);
    expect(plan.ready).toBe(false);
    expect(plan.blockers).toContainEqual(
      expect.objectContaining({ code: 'orphan_card_purchases_unexpected_nulls', count: 48 }),
    );
  });

  it('FIX-3: pins the audited V023 current checksum to the real file hash', () => {
    expect(V023_AUDITED_CURRENT_CHECKSUM).toBe(realChecksumOf('V023__pending_operations.sql'));
  });

  it('FIX-3: only forgives the exact audited V023 set (full historical pinned 2026-09-26)', () => {
    const audited = {
      version: 23,
      kind: 'checksum' as const,
      expected: V023_AUDITED_CURRENT_CHECKSUM,
      // Full historical hash pinned from production `_migrations`
      // 2026-09-26 (original production application of V023).
      applied: V023_AUDITED_HISTORICAL_CHECKSUM,
    };
    expect(isAuditedV023BaselineDivergence(audited)).toBe(true);
    // Prefix-only lookalikes are NO LONGER accepted: the closed set is
    // exact full hashes only.
    expect(
      isAuditedV023BaselineDivergence({ ...audited, applied: `9c8cb904${'a'.repeat(56)}` }),
    ).toBe(false);
    expect(isAuditedV023BaselineDivergence({ ...audited, version: 22 })).toBe(false);
    expect(isAuditedV023BaselineDivergence({ ...audited, kind: 'name' })).toBe(false);
    expect(isAuditedV023BaselineDivergence({ ...audited, applied: 'f'.repeat(64) })).toBe(false);
    expect(isAuditedV023BaselineDivergence({ ...audited, expected: 'f'.repeat(64) })).toBe(false);
  });

  it('FIX-3: forgives the audited V023 checksum divergence without blocking', () => {
    const manifest = [
      { version: 23, name: 'V023__pending_operations.sql', checksum: V023_AUDITED_CURRENT_CHECKSUM },
    ];
    const evidence = baseEvidence();
    evidence.legacyMigrationPlan = planMigrations(manifest, [
      {
        version: 23,
        name: 'V023__pending_operations.sql',
        checksum: V023_AUDITED_HISTORICAL_CHECKSUM,
      },
    ]);
    const plan = buildConversionPlan(evidence);
    expect(plan.ready).toBe(true);
    expect(plan.blockers).not.toContainEqual(
      expect.objectContaining({ code: 'migration_baseline_drift' }),
    );
    expect(plan.informational).toContainEqual(
      expect.objectContaining({ code: 'migration_baseline_v023_audited', count: 1 }),
    );
  });

  it('FIX-3: still blocks an unaudited V023 checksum, V023 name drift, and other-version drift', () => {
    const manifest = [
      { version: 22, name: 'V022__shared_workspace_invariants.sql', checksum: 'real-checksum-v022' },
      { version: 23, name: 'V023__pending_operations.sql', checksum: V023_AUDITED_CURRENT_CHECKSUM },
    ];
    const bogus = baseEvidence();
    bogus.legacyMigrationPlan = planMigrations(manifest, [
      { version: 22, name: 'V022__shared_workspace_invariants.sql', checksum: 'real-checksum-v022' },
      { version: 23, name: 'V023__pending_operations.sql', checksum: 'f'.repeat(64) },
    ]);
    const bogusPlan = buildConversionPlan(bogus);
    expect(bogusPlan.ready).toBe(false);
    expect(bogusPlan.blockers).toContainEqual(
      expect.objectContaining({ code: 'migration_baseline_drift', evidence: expect.stringContaining('V023:checksum') }),
    );

    const renamed = baseEvidence();
    renamed.legacyMigrationPlan = planMigrations(manifest, [
      { version: 22, name: 'V022__shared_workspace_invariants.sql', checksum: 'real-checksum-v022' },
      { version: 23, name: 'V023__renamed.sql', checksum: V023_AUDITED_CURRENT_CHECKSUM },
    ]);
    // Name drift is fail-closed in every era (planMigrations routes it to
    // hard `drift`, never to baselineDrift), so V023 included must block.
    expect(buildConversionPlan(renamed).blockers).toContainEqual(
      expect.objectContaining({ code: 'migration_drift', evidence: expect.stringContaining('V023:name') }),
    );

    const other = baseEvidence();
    other.legacyMigrationPlan = planMigrations(manifest, [
      { version: 22, name: 'V022__shared_workspace_invariants.sql', checksum: 'tampered' },
      { version: 23, name: 'V023__pending_operations.sql', checksum: V023_AUDITED_CURRENT_CHECKSUM },
    ]);
    expect(buildConversionPlan(other).blockers).toContainEqual(
      expect.objectContaining({ code: 'migration_baseline_drift', evidence: expect.stringContaining('V022:checksum') }),
    );
  });

  it('FIX-4 (2026-09-26): closed checksum set accepts the pre-qualification ca412d74 ledger against the re-qualified file', () => {
    // The 2026-09-26 schema-qualification fix edits V023, so its file hash
    // moves. Ledgers that applied the pre-fix file (full ca412d74…) stay
    // forgiven against the NEW manifest hash.
    const drift = {
      version: 23,
      kind: 'checksum' as const,
      expected: realChecksumOf('V023__pending_operations.sql'),
      applied: 'ca412d7481a912ff8fa4a254a8e873d17768a018991d2dd2177e9529aa815901',
    };
    expect(isAuditedV023BaselineDivergence(drift)).toBe(true);
  });

  it('FIX-4: the re-qualified file hash itself is an accepted form; anything else for V023 stays blocked', () => {
    const current = realChecksumOf('V023__pending_operations.sql');
    expect(
      isAuditedV023BaselineDivergence({ version: 23, kind: 'checksum', expected: current, applied: current }),
    ).toBe(true);
    expect(
      isAuditedV023BaselineDivergence({ version: 23, kind: 'checksum', expected: current, applied: 'e'.repeat(64) }),
    ).toBe(false);
    // A manifest still carrying the superseded ca412d74 hash is outside the
    // closed set once the file is re-qualified: only the NEW file hash is
    // accepted on the expected side.
    expect(
      isAuditedV023BaselineDivergence({
        version: 23,
        kind: 'checksum' as const,
        expected: 'ca412d7481a912ff8fa4a254a8e873d17768a018991d2dd2177e9529aa815901',
        applied: `9c8cb904${'b'.repeat(56)}`,
      }),
    ).toBe(false);
  });

  it('FIX-4: buildConversionPlan forgives the ca412d74 ledger value as audited instead of blocking', () => {
    const manifest = [
      { version: 23, name: 'V023__pending_operations.sql', checksum: realChecksumOf('V023__pending_operations.sql') },
    ];
    const evidence = baseEvidence();
    evidence.legacyMigrationPlan = planMigrations(manifest, [
      {
        version: 23,
        name: 'V023__pending_operations.sql',
        checksum: 'ca412d7481a912ff8fa4a254a8e873d17768a018991d2dd2177e9529aa815901',
      },
    ]);
    const plan = buildConversionPlan(evidence);
    expect(plan.ready).toBe(true);
    expect(plan.blockers).not.toContainEqual(
      expect.objectContaining({ code: 'migration_baseline_drift' }),
    );
    expect(plan.informational).toContainEqual(
      expect.objectContaining({ code: 'migration_baseline_v023_audited', count: 1 }),
    );
  });

  it('collects a deterministic plan over a stubbed pool', async () => {
    const first = await collectConversionPlan(cleanStub());
    const second = await collectConversionPlan(cleanStub());
    expect(first.ready).toBe(true);
    expect(first.blockers).toEqual([]);
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(first)).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:/);
  });

  it('collects nonzero balances through the stubbed pool as informational', async () => {
    const pool = stubPool([
      { match: includes('pg_depend'), rows: [] },
      { match: includes('pg_class'), rows: legacyRelationsRows() },
      { match: includes('initial_balance_cents'), rows: [{ count: 4 }] },
      { match: includes('information_schema.columns'), rows: [] },
      { match: includes('md5('), rows: [emptyAggregate()] },
      { match: includes('COUNT(*'), rows: [{ count: 0 }] },
      { match: includes('_migrations'), rows: [] },
    ]);
    const plan = await collectConversionPlan(pool);
    expect(plan.ready).toBe(false);
    expect(plan.blockers).toContainEqual(
      expect.objectContaining({ code: 'legacy_fingerprint_mismatch' }),
    );
    expect(plan.blockers).not.toContainEqual(
      expect.objectContaining({ code: 'nonzero_initial_balance' }),
    );
    expect(plan.informational).toContainEqual(
      expect.objectContaining({ code: 'nonzero_initial_balance', count: 4 }),
    );
  });

  it('FINDING-3 RED: excludes extension-owned functions (pgcrypto) from the inventory', async () => {
    // A real legacy database carries pgcrypto (V001/V013/V053): its
    // functions (gen_random_uuid, digest, ...) live in public but belong to
    // the extension. They must not be inventoried as app functions —
    // `ALTER FUNCTION ... SET SCHEMA` refuses to move them and the
    // conversion would abort. REVIEW-R2-M2: exclusion is by OID identity,
    // so the stub carries oids alongside names.
    const pool = stubPool([
      {
        match: (sql: string) => sql.includes('pg_depend') && sql.includes('pg_proc'),
        rows: [{ oid: '111' }],
      },
      {
        match: (sql: string) => sql.includes('pg_depend'),
        rows: [],
      },
      { match: includes('pg_class'), rows: legacyRelationsRows().map((r, i) => ({ ...r, oid: String(200 + i) })) },
      {
        match: (sql: string) => sql.includes('pg_proc') && !sql.includes('pg_depend'),
        rows: [
          { oid: '111', name: 'gen_random_uuid', args: '' },
          { oid: '112', name: 'set_updated_at', args: '' },
        ],
      },
      { match: includes('initial_balance_cents'), rows: [{ count: 0 }] },
      {
        match: includes('information_schema.columns'),
        rows: LEGACY_EXPECTED_COLUMNS.map((c) => ({ table_name: c.table, column_name: c.column })),
      },
      { match: includes('COUNT(*'), rows: [{ count: 0 }] },
      {
        match: includes('_migrations'),
        rows: [{ version: 3, name: 'V003__legacy_safe_tables.sql', checksum: realChecksumOf('V003__legacy_safe_tables.sql') }],
      },
    ]);
    const { listRelations } = await import('../../src/scripts/canonical-converter/plan.js');
    const relations = await listRelations(pool, 'public');
    expect(relations.find((r) => r.name === 'gen_random_uuid')).toBeUndefined();
    expect(relations.find((r) => r.name === 'set_updated_at')).toBeDefined();
  });

  it('SOURCE-DIGEST RED: same-cardinality value change alters the fingerprint', async () => {
    // Same counts (2 transactions), different row CONTENT (e.g. a changed
    // amount_cents). The pre-fix fingerprint only covers inventory/counts/
    // ledger/preflight, so both plans hash identically and the drift is
    // invisible across public -> legacy_archive and marker reruns.
    const before = await collectConversionPlan(planStubWithContent(['a'.repeat(32), 'b'.repeat(32)]));
    const after = await collectConversionPlan(planStubWithContent(['a'.repeat(32), 'c'.repeat(32)]));
    expect(before.fingerprint).not.toBe(after.fingerprint);
  });

  it('SOURCE-DIGEST: row order does not affect the fingerprint', async () => {
    const first = await collectConversionPlan(planStubWithContent(['a'.repeat(32), 'b'.repeat(32)]));
    const second = await collectConversionPlan(planStubWithContent(['b'.repeat(32), 'a'.repeat(32)]));
    expect(first.fingerprint).toBe(second.fingerprint);
  });

  it('SOURCE-DIGEST: content digests are hashes only, never raw row data', async () => {
    const plan = await collectConversionPlan(planStubWithContent(['a'.repeat(32)]));
    const digests = plan.inventory.contentDigests ?? {};
    expect(Object.keys(digests).length).toBeGreaterThan(0);
    for (const digest of Object.values(digests)) {
      expect(digest).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(JSON.stringify(plan.inventory)).not.toContain('Orphan spend');
  });

  it('SOURCE-DIGEST: content query failure fails closed instead of planning over unknown content', async () => {
    const base = planStubWithContent(['a'.repeat(32)]);
    const pool: StubPool = {
      query: async (sql: string, params?: unknown[]) => {
        if (sql.includes('md5(')) {
          throw Object.assign(new Error('connection reset by peer'), { code: '08006' });
        }
        return base.query(sql, params);
      },
    };
    await expect(collectConversionPlan(pool)).rejects.toThrow();
  });

  it('SOURCE-DIGEST: views and sequences are not content-digested (tables only)', async () => {
    const seen: string[] = [];
    const base = planStubWithContent(['a'.repeat(32)]);
    const pool: StubPool = {
      query: async (sql: string, params?: unknown[]) => {
        seen.push(sql);
        return base.query(sql, params);
      },
    };
    const poolWithView: StubPool = {
      query: async (sql: string, params?: unknown[]) => {
        if (sql.includes('FROM pg_class')) {
          return {
            rows: [
              { name: 'accounts', kind: 'r' },
              { name: 'my_view', kind: 'v' },
              { name: 'my_seq', kind: 'S' },
            ],
            rowCount: 3,
          };
        }
        return pool.query(sql, params);
      },
    };
    await collectConversionPlan(poolWithView);
    const digested = seen.filter((sql) => sql.includes('md5('));
    expect(digested.length).toBeGreaterThan(0);
    expect(digested.some((sql) => sql.includes('"my_view"'))).toBe(false);
    expect(digested.some((sql) => sql.includes('"my_seq"'))).toBe(false);
    expect(digested.some((sql) => sql.includes('"accounts"'))).toBe(true);
  });

  it('FIX-1: collectConversionPlan records the failing preflight query with its SQL error', async () => {
    const routes: Route[] = [
      { match: includes('pg_depend'), rows: [] },
      { match: includes('pg_class'), rows: legacyRelationsRows() },
      { match: includes('initial_balance_cents'), rows: [{ count: 0 }] },
      {
        match: includes('information_schema.columns'),
        rows: LEGACY_EXPECTED_COLUMNS.map((c) => ({ table_name: c.table, column_name: c.column })),
      },
      { match: includes('md5('), rows: [emptyAggregate()] },
      { match: includes('COUNT(*'), rows: [{ count: 0 }] },
      { match: includes('_migrations'), rows: [{ version: 3, name: 'V003__legacy_safe_tables.sql', checksum: realChecksumOf('V003__legacy_safe_tables.sql') }] },
    ];
    const pool: StubPool = {
      query: async (sql: string) => {
        if (sql.includes('FROM invites')) {
          throw Object.assign(new Error('column i.invited_by_user_id does not exist'), { code: '42703' });
        }
        const route = routes.find((r) => r.match(sql));
        const rows = route?.rows ?? [];
        return { rows, rowCount: rows.length };
      },
    };
    const plan = await collectConversionPlan(pool);
    expect(plan.ready).toBe(false);
    expect(plan.blockers).toContainEqual(
      expect.objectContaining({ code: 'preflight_error', count: 1 }),
    );
    const blocker = plan.blockers.find((entry) => entry.code === 'preflight_error');
    expect(blocker?.evidence).toContain('invitesUnresolved');
    expect(blocker?.evidence).toContain('42703');
    expect(plan.inventory.preflightErrors).toHaveLength(1);
  });

  it('DIGEST-BOUNDED RED: content digest is a single-row COUNT+SUM aggregate without whole-table accumulation', async () => {
    const seen: string[] = [];
    const pool: StubPool = {
      query: async (sql: string) => {
        seen.push(sql);
        if (sql.includes('md5(')) return { rows: [emptyAggregate()], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      },
    };
    const { digestTableContent } = await import('../../src/scripts/canonical-converter/plan.js');
    const digest = await digestTableContent(pool, 'public', 'accounts');
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    const sql = seen.find((s) => s.includes('md5(')) ?? '';
    expect(sql).toContain('COUNT(*)');
    expect(sql).toContain('SUM(');
    expect(sql).toContain('md5(t::text)');
    expect(sql.toLowerCase()).not.toContain('string_agg');
    expect(sql.toLowerCase()).not.toContain('array_agg');
    // Single-row aggregate: exactly one row consumed, no per-row list.
    const res = await pool.query(seen.find((s) => s.includes('md5(')) ?? '');
    expect(res.rows).toHaveLength(1);
  });

  it('DIGEST-BOUNDED: duplicate occurrences change the digest (exact multiset, no XOR cancellation)', async () => {
    const { digestTableContent } = await import('../../src/scripts/canonical-converter/plan.js');
    const stubWith = (rows: Array<Record<string, unknown>>): StubPool => ({
      query: async () => ({ rows, rowCount: rows.length }),
    });
    const rowHash = 'a'.repeat(32);
    const single = await digestTableContent(stubWith([aggregateOf([rowHash])]), 'public', 't');
    const doubled = await digestTableContent(stubWith([aggregateOf([rowHash, rowHash])]), 'public', 't');
    expect(single).toMatch(/^[0-9a-f]{64}$/);
    expect(doubled).not.toBe(single);
  });

  it('DIGEST-BOUNDED: empty table digests deterministically as SHA-256 of "0:0:0"', async () => {
    const { digestTableContent } = await import('../../src/scripts/canonical-converter/plan.js');
    const pool: StubPool = { query: async () => ({ rows: [emptyAggregate()], rowCount: 1 }) };
    const digest = await digestTableContent(pool, 'public', 'accounts');
    expect(digest).toBe(createHash('sha256').update('0:0:0', 'utf8').digest('hex'));
  });

  it('DIGEST-BOUNDED: same aggregate values digest equally across schemas (SET SCHEMA equality)', async () => {
    const { digestTableContent } = await import('../../src/scripts/canonical-converter/plan.js');
    const agg = aggregateOf(['a'.repeat(32), 'b'.repeat(32)]);
    const pool: StubPool = { query: async () => ({ rows: [agg], rowCount: 1 }) };
    const fromPublic = await digestTableContent(pool, 'public', 'accounts');
    const fromArchive = await digestTableContent(pool, 'legacy_archive', 'accounts');
    expect(fromPublic).toBe(fromArchive);
  });

  it('DIGEST-BOUNDED: malformed aggregate fails closed', async () => {
    const { digestTableContent } = await import('../../src/scripts/canonical-converter/plan.js');
    const bad: Array<Record<string, unknown>> = [
      {},
      { n: '-1', s_hi: '0', s_lo: '0' },
      { n: '2', s_hi: 'not-a-number', s_lo: '0' },
      { n: '2', s_hi: '0', s_lo: '1.5' },
    ];
    for (const rows of bad.map((r) => [r])) {
      const pool: StubPool = { query: async () => ({ rows, rowCount: rows.length }) };
      await expect(digestTableContent(pool, 'public', 't')).rejects.toThrow();
    }
    const empty: StubPool = { query: async () => ({ rows: [], rowCount: 0 }) };
    await expect(digestTableContent(empty, 'public', 't')).rejects.toThrow();
  });
});
