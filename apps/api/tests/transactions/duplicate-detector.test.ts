import { describe, it, expect } from "vitest";
import { normalize, jaccardSimilarity, findDuplicate } from "../../src/transactions/duplicate-detector.js";

describe("duplicate-detector", () => {
  it("normalizes text removing accents and stopwords", () => {
    expect(normalize("Compra no Supermercado São Paulo")).toBe("compra supermercado sao paulo");
    expect(normalize("Pagamento de conta de luz")).toBe("pagamento conta luz");
  });

  it("computes jaccard similarity", () => {
    expect(jaccardSimilarity("mercado sao paulo", "mercado sao paulo")).toBe(1);
    expect(jaccardSimilarity("mercado sao paulo", "mercado rio")).toBeCloseTo(0.25, 1);
    expect(jaccardSimilarity("", "qualquer")).toBe(0);
  });

  it("queries the CANONICAL schema only (no legacy from_account_id/idempotency pre-query)", async () => {
    // FIX-API-DUPLICATE-CANONICAL: production (DB_SCHEMA=canonical) 500s with
    // `column "from_account_id" does not exist` — the detector must query the
    // canonical columns and must not run the legacy idempotency pre-query
    // (canonical idempotency is enforced authoritatively at write time).
    const queries: string[] = [];
    const pool: any = {
      query: async (sql: string) => {
        queries.push(sql);
        return { rows: [] };
      },
    };
    const match = await findDuplicate(pool, {
      householdId: "h1",
      kind: "expense",
      description: "nova compra",
      amountCents: 1000,
      date: "2026-08-20",
      idempotencyKey: "key-123",
      accountId: "00000000-0000-0000-0000-000000000001",
    });
    expect(match).toBeNull();
    expect(queries).toHaveLength(1);
    const sql = queries[0]!;
    // Canonical columns (aliased to the legacy match shape for consumers).
    expect(sql).toContain("account_id AS from_account_id");
    expect(sql).toContain("transfer_to_account_id AS to_account_id");
    expect(sql).toContain("(account_id = $6 OR transfer_to_account_id = $6)");
    expect(sql).toContain("household_id");
    // No legacy column usage and no legacy idempotency pre-query.
    expect(sql).not.toContain(" from_account_id =");
    expect(sql).not.toContain(" to_account_id =");
    expect(sql).not.toContain("idempotency_key");
  });

  it("finds semantic duplicate with similarity >=0.6", async () => {
    const pool: any = {
      query: async () => ({
        rows: [
          { id: "1", amount_cents: "5000", description: "Supermercado Sao Paulo", date: new Date("2026-08-20"), from_account_id: null, to_account_id: null, created_at: new Date() },
          { id: "2", amount_cents: "5000", description: "Posto de gasolina", date: new Date("2026-08-20"), from_account_id: null, to_account_id: null, created_at: new Date() },
        ],
      }),
    };
    const match = await findDuplicate(pool, {
      householdId: "h1",
      kind: "expense",
      description: "compra supermercado sao paulo",
      amountCents: 5000,
      date: "2026-08-20",
    });
    expect(match?.id).toBe("1");
    expect(match?.similarity).toBeGreaterThanOrEqual(0.6);
  });

  it("returns null when no semantic match", async () => {
    const pool: any = { query: async () => ({ rows: [] }) };
    const match = await findDuplicate(pool, {
      householdId: "h1",
      kind: "expense",
      description: "compra totalmente diferente xyz",
      amountCents: 9999,
      date: "2026-08-20",
    });
    expect(match).toBeNull();
  });
});
