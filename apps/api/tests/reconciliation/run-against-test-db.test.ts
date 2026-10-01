import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createPool } from "../../src/db/pool.js";
import { requireTestDatabase } from "../../src/db/db-guard.js";
import { runMigrations } from "../../src/read-models/sql/migrate.js";
import {
  buildReconciliationQueries,
  isSelectOnly,
} from "../../src/scripts/reconciliation/sql.js";
import type { SchemaLayout } from "../../src/scripts/reconciliation/sql.js";
import {
  parseArgs,
  probeSchemaLayout,
  runReconciliation,
} from "../../src/scripts/reconciliation/run.js";

const DB_URL = process.env.DATABASE_URL_TEST;
const ENABLED = Boolean(DB_URL && process.env.DB_TEST_MARKER);
const itIfDatabase = ENABLED ? it : it.skip;
let pool: Pool | undefined;

const LAYOUTS: SchemaLayout[] = ["canonical", "legacy"];

describe("reconciliation SQL safety (no database needed)", () => {
  it("emits single SELECT-only statements for every check and layout", () => {
    for (const layout of LAYOUTS) {
      for (const scoped of [false, true]) {
        const queries = buildReconciliationQueries(
          layout,
          scoped ? { householdId: randomUUID() } : {},
        );
        for (const [check, query] of Object.entries(queries)) {
          expect(
            isSelectOnly(query.text),
            `${layout}/${check} must be SELECT-only`,
          ).toBe(true);
        }
      }
    }
  });

  it("projects account kind on accounts_balance for both layouts", () => {
    for (const layout of LAYOUTS) {
      for (const scoped of [false, true]) {
        const queries = buildReconciliationQueries(
          layout,
          scoped ? { householdId: randomUUID() } : {},
        );
        expect(
          queries.accounts_balance.text,
          `${layout} accounts_balance must project account kind`,
        ).toMatch(/account_kind/);
        expect(
          isSelectOnly(queries.accounts_balance.text),
          `${layout} accounts_balance must stay SELECT-only`,
        ).toBe(true);
      }
    }
  });

  it("projects the V058 anchor on canonical accounts_balance (legacy keeps its own)", () => {
    const canonical = buildReconciliationQueries("canonical", {}).accounts_balance.text;
    expect(canonical).toMatch(/a\.initial_balance_cents AS initial_cents/);
    expect(canonical).not.toMatch(/NULL::bigint AS initial_cents/);
    expect(canonical).toMatch(/GROUP BY a\.id, a\.household_id, a\.kind, a\.balance_cents, a\.initial_balance_cents/);
    const legacy = buildReconciliationQueries("legacy", {}).accounts_balance.text;
    expect(legacy).toMatch(/a\.initial_balance_cents AS initial_cents/);
    expect(isSelectOnly(canonical)).toBe(true);
  });

  it("types the household scope parameter and binds it exactly once per check (legacy dup_idempotency regression)", () => {
    // Regression (F2 2026-09-26): legacy --household runs failed with
    // `could not determine data type of parameter $1`. dupIdempotency pushed
    // the household id twice while the legacy text referenced only $2,
    // leaving $1 unbound and untyped. Every scoped check must bind exactly
    // one value, and the idempotency scope predicates must carry an explicit
    // cast (uuid for the legacy column, text for the canonical scope alias).
    const householdId = randomUUID();
    for (const layout of LAYOUTS) {
      const queries = buildReconciliationQueries(layout, { householdId });
      for (const [check, query] of Object.entries(queries)) {
        expect(query.values, `${layout}/${check} must bind the scope exactly once`).toHaveLength(1);
        expect(query.values[0], `${layout}/${check} scope value`).toBe(householdId);
      }
    }
    const legacy = buildReconciliationQueries("legacy", { householdId }).dup_idempotency;
    expect(legacy.text).toMatch(/WHERE household_id = \$1::uuid/);
    expect(legacy.text).not.toMatch(/\$2/);
    const canonical = buildReconciliationQueries("canonical", { householdId }).dup_idempotency;
    expect(canonical.text).toMatch(/WHERE scope = \$1::text/);
    expect(canonical.text).not.toMatch(/\$2/);
  });

  it("rejects multi-statement and write payloads", () => {
    expect(isSelectOnly("SELECT 1; SELECT 2")).toBe(false);
    expect(isSelectOnly("SELECT 1; DROP TABLE accounts")).toBe(false);
    expect(isSelectOnly("UPDATE accounts SET balance_cents = 0")).toBe(false);
    expect(isSelectOnly("SELECT 1")).toBe(true);
  });

  it("parses CLI args and rejects invalid values", () => {
    expect(parseArgs([])).toEqual({
      schema: "auto",
      format: "json",
      failOnDrift: false,
      provenance: "historical",
    });
    expect(
      parseArgs([
        "--schema=legacy",
        "--format=text",
        "--fail-on-drift",
        "--household=h1",
      ]),
    ).toEqual({
      schema: "legacy",
      format: "text",
      failOnDrift: true,
      householdId: "h1",
      provenance: "historical",
    });
    expect(parseArgs(["--provenance=fresh"])).toMatchObject({
      provenance: "fresh",
    });
    expect(() => parseArgs(["--schema=nope"])).toThrow();
    expect(() => parseArgs(["--provenance=nope"])).toThrow();
    expect(() => parseArgs(["--bogus"])).toThrow();
  });
});

describe("reconciliation against the test database", () => {
  beforeAll(async () => {
    if (!DB_URL) return;
    pool = createPool({ connectionString: DB_URL, max: 4 });
    await requireTestDatabase(pool, "migrate");
    await runMigrations(pool);
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
  });

  itIfDatabase(
    "probes the canonical layout and returns a zero-drift report shape",
    async () => {
      const db = pool!;
      const layout = await probeSchemaLayout(
        async (text) => (await db.query(text)).rows,
      );
      expect(layout).toBe("canonical");

      const householdId = randomUUID();
      // households.kind='personal' requires owner_user_id (V021) and
      // 'shared' requires it too (V022): seed an owner first
      // (postgres-payable-double-pay.test.ts pattern) and create shared.
      const ownerId = randomUUID();
      await db.query(`INSERT INTO users (id, email, name, status) VALUES ($1, $2, 'Recon Owner', 'active')`, [
        ownerId,
        `recon-${householdId}@example.test`,
      ]);
      await db.query(`INSERT INTO households (id, name, kind, owner_user_id) VALUES ($1, $2, 'shared', $3)`, [
        householdId,
        'Recon H',
        ownerId,
      ]);
      try {
        // V058 anchor: the canonical derivation is initial + movements, so a
        // stored balance without movements must be anchored to stay green.
        const account = await db.query(
          `INSERT INTO accounts (id, household_id, name, kind, balance_cents, initial_balance_cents, status)
          VALUES (gen_random_uuid(), $1, 'Cash', 'cash', 10000, 10000, 'active') RETURNING id`,
          [householdId],
        );
        const accountId = account.rows[0]!["id"] as string;
        await db.query(
          `INSERT INTO statements (id, household_id, account_id, cycle_year_month, closing_date, due_date, total_cents, paid_cents, status)
         VALUES (gen_random_uuid(), $1, $2, '2026-09', '2026-09-15', '2026-09-25', 0, 0, 'open')`,
          [householdId, accountId],
        );
        await db.query(
          `INSERT INTO goals (id, household_id, name, goal_type, target_amount_cents, current_amount_cents, start_date, status)
         VALUES (gen_random_uuid(), $1, 'Reserve', 'emergency_fund', 50000, 0, '2026-09-01', 'active')`,
          [householdId],
        );

        const report = await runReconciliation(db, "canonical", householdId);
        expect(report.schema).toBe("canonical");
        expect(report.householdScope).toBe(householdId);
        expect(report.checks).toHaveLength(7);
        expect(report.checks.map((c) => c.check).sort()).toEqual(
          [
            "accounts_balance",
            "card_purchase",
            "duplicates",
            "goal_contribution",
            "payable_payment",
            "statement_payment",
            "statement_total",
          ].sort(),
        );
        expect(report.totals.drifted).toBe(0);
        expect(JSON.parse(JSON.stringify(report))).toEqual(report);
      } finally {
        await db
          .query(`DELETE FROM card_purchases WHERE household_id = $1`, [
            householdId,
          ])
          .catch(() => undefined);
        await db
          .query(`DELETE FROM transactions WHERE household_id = $1`, [
            householdId,
          ])
          .catch(() => undefined);
        await db
          .query(`DELETE FROM statements WHERE household_id = $1`, [
            householdId,
          ])
          .catch(() => undefined);
        await db
          .query(`DELETE FROM accounts_payable WHERE household_id = $1`, [
            householdId,
          ])
          .catch(() => undefined);
        await db
          .query(
            `DELETE FROM goal_contributions WHERE goal_id IN (SELECT id FROM goals WHERE household_id = $1)`,
            [householdId],
          )
          .catch(() => undefined);
        await db
          .query(`DELETE FROM goals WHERE household_id = $1`, [householdId])
          .catch(() => undefined);
        await db
          .query(`DELETE FROM recurring_purchases WHERE household_id = $1`, [
            householdId,
          ])
          .catch(() => undefined);
        await db
          .query(`DELETE FROM categories WHERE household_id = $1`, [
            householdId,
          ])
          .catch(() => undefined);
        await db
          .query(`DELETE FROM accounts WHERE household_id = $1`, [householdId])
          .catch(() => undefined);
        await db
          .query(`DELETE FROM memberships WHERE household_id = $1`, [householdId])
          .catch(() => undefined);
        await db
          .query(`DELETE FROM households WHERE id = $1`, [householdId])
          .catch(() => undefined);
        await db.query(`DELETE FROM users WHERE id = $1`, [ownerId]).catch(() => undefined);
      }
    },
    30_000,
  );
});
