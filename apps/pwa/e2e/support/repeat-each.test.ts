/**
 * E2E_RUNTIME_REPEAT_EACH helper contract (node:test style, same as
 * e2e/support/matrix.test.ts).
 *
 * Run: pnpm exec tsx --test e2e/support/repeat-each.test.ts
 * (also picked up by `vitest run` via the workspace `pnpm test`).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyRepeatOutcome,
  formatRepeatSummary,
  parseRepeatEachEnv,
  repeatEachCliArgs,
} from "./repeat-each.ts";

describe("parseRepeatEachEnv", () => {
  it("treats unset/empty/0/1 as a single run (current behavior untouched)", () => {
    assert.equal(parseRepeatEachEnv(undefined), 1);
    assert.equal(parseRepeatEachEnv(""), 1);
    assert.equal(parseRepeatEachEnv("0"), 1);
    assert.equal(parseRepeatEachEnv("1"), 1);
  });

  it("accepts integers >= 2 as repetition counts", () => {
    assert.equal(parseRepeatEachEnv("2"), 2);
    assert.equal(parseRepeatEachEnv("10"), 10);
  });

  it("rejects malformed values fail-closed", () => {
    for (const bad of ["x", "2.5", "-3", " 3", "3 ", "0x10", "1e2", "NaN"]) {
      assert.throws(() => parseRepeatEachEnv(bad), /invalid E2E_RUNTIME_REPEAT_EACH/);
    }
  });
});

describe("repeatEachCliArgs", () => {
  it("emits no flag for a single run (baseline untouched)", () => {
    assert.deepEqual(repeatEachCliArgs(1), []);
  });

  it("emits --repeat-each only when repeating", () => {
    assert.deepEqual(repeatEachCliArgs(10), ["--repeat-each=10"]);
  });
});

describe("classifyRepeatOutcome", () => {
  it("stable-pass when every rep passes", () => {
    assert.equal(classifyRepeatOutcome(0, 10), "stable-pass");
  });

  it("consistent-fail when every rep fails", () => {
    assert.equal(classifyRepeatOutcome(10, 10), "consistent-fail");
  });

  it("flake when only some reps fail", () => {
    assert.equal(classifyRepeatOutcome(1, 10), "flake");
    assert.equal(classifyRepeatOutcome(9, 10), "flake");
  });

  it("rejects out-of-range tallies fail-closed", () => {
    assert.throws(() => classifyRepeatOutcome(-1, 10), /invalid failedReps/);
    assert.throws(() => classifyRepeatOutcome(11, 10), /invalid failedReps/);
    assert.throws(() => classifyRepeatOutcome(0, 0), /invalid totalReps/);
  });
});

describe("formatRepeatSummary", () => {
  it("reports scenario, pass count and classification", () => {
    assert.equal(
      formatRepeatSummary("[PWA-01] offline shell", 1, 10),
      "[repeat-each] [PWA-01] offline shell: 9/10 passed → FLAKE",
    );
    assert.equal(
      formatRepeatSummary("[PWA-01] offline shell", 0, 10),
      "[repeat-each] [PWA-01] offline shell: 10/10 passed → STABLE-PASS",
    );
    assert.equal(
      formatRepeatSummary("[PWA-01] offline shell", 10, 10),
      "[repeat-each] [PWA-01] offline shell: 0/10 passed → CONSISTENT-FAIL",
    );
  });
});
