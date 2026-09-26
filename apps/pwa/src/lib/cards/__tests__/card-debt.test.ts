import { describe, expect, it } from "vitest";
import { resolveCardOutstanding } from "../card-debt";

describe("resolveCardOutstanding (ADR-018 canonical debt)", () => {
  it("RED: uses authoritative balanceCents across multi-cycle statements, not the latest statement total", () => {
    // May stmt 7000 (partially paid 4000) + June stmt 6000 open = 13000 billed,
    // 4000 paid => canonical outstanding 9000... use 9000 as server truth.
    // Latest-statement-only logic would report 6000 (wrong).
    const r = resolveCardOutstanding(
      { balanceCents: 9000, creditLimitCents: 20000, balanceSemantics: "outstanding_debt" },
      { statementFallbackCents: 6000 },
    );
    expect(r.source).toBe("authoritative");
    expect(r.outstandingCents).toBe(9000);
    expect(r.availableCents).toBe(11000);
  });

  it("RED: partial payment reduces outstanding below the statement total", () => {
    const r = resolveCardOutstanding(
      { balanceCents: 3000, creditLimitCents: 20000, balanceSemantics: "outstanding_debt" },
      { statementFallbackCents: 7000 },
    );
    expect(r.source).toBe("authoritative");
    expect(r.outstandingCents).toBe(3000);
    expect(r.availableCents).toBe(17000);
  });

  it("RED: legacy layout (negative computed balance) falls back to the statement total without inventing values", () => {
    const r = resolveCardOutstanding(
      { balanceCents: -4180, creditLimitCents: 1200000, balanceSemantics: "legacy_calculated" },
      { statementFallbackCents: 4180 },
    );
    expect(r.source).toBe("statement-fallback");
    expect(r.outstandingCents).toBe(4180);
    expect(r.availableCents).toBe(1200000 - 4180);
  });

  it("RED: zero balance with zero fallback is authoritative zero (both layouts agree)", () => {
    const r = resolveCardOutstanding(
      { balanceCents: 0, creditLimitCents: 10000, balanceSemantics: "outstanding_debt" },
      { statementFallbackCents: 0 },
    );
    expect(r.source).toBe("authoritative");
    expect(r.outstandingCents).toBe(0);
    expect(r.availableCents).toBe(10000);
  });

  it("RED: zero balance with nonzero fallback and absent semantics is NOT trusted (legacy update-shape) — falls back", () => {
    const r = resolveCardOutstanding(
      { balanceCents: 0, creditLimitCents: 10000 },
      { statementFallbackCents: 5000 },
    );
    expect(r.source).toBe("statement-fallback");
    expect(r.outstandingCents).toBe(5000);
  });

  it("Explicit: outstanding_debt zero with nonzero fallback is authoritative zero (server truth wins)", () => {
    const r = resolveCardOutstanding(
      { balanceCents: 0, creditLimitCents: 10000, balanceSemantics: "outstanding_debt" },
      { statementFallbackCents: 5000 },
    );
    expect(r.source).toBe("authoritative");
    expect(r.outstandingCents).toBe(0);
    expect(r.availableCents).toBe(10000);
  });

  it("RED: missing limit yields null available instead of a guessed number", () => {
    const r = resolveCardOutstanding(
      { balanceCents: 4000, balanceSemantics: "outstanding_debt" },
      { statementFallbackCents: 4000 },
    );
    expect(r.outstandingCents).toBe(4000);
    expect(r.availableCents).toBeNull();
  });

  it("RED explicit: legacy_calculated with positive balance always falls back, even if positive", () => {
    const r = resolveCardOutstanding(
      { balanceCents: 4000, creditLimitCents: 20000, balanceSemantics: "legacy_calculated" } as never,
      { statementFallbackCents: 1500 },
    );
    expect(r.source).toBe("statement-fallback");
    expect(r.outstandingCents).toBe(1500);
  });

  it("RED explicit: absent semantics with positive balance always falls back", () => {
    const r = resolveCardOutstanding(
      { balanceCents: 4000, creditLimitCents: 20000 },
      { statementFallbackCents: 1500 },
    );
    expect(r.source).toBe("statement-fallback");
    expect(r.outstandingCents).toBe(1500);
  });

  it("RED explicit: unknown semantics value with positive balance always falls back", () => {
    const r = resolveCardOutstanding(
      { balanceCents: 4000, creditLimitCents: 20000, balanceSemantics: "something-else" } as never,
      { statementFallbackCents: 1500 },
    );
    expect(r.source).toBe("statement-fallback");
    expect(r.outstandingCents).toBe(1500);
  });
});
