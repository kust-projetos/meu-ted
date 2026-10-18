/**
 * E2E_RUNTIME_REPEAT_EACH — opt-in flake detector for the PWA/push runtime gates.
 *
 * Purpose: distinguish perennial flakes (known family: Playwright click
 * timeouts in `pwa-runtime` / `push-runtime`, historically green on rerun)
 * from deterministic failures, without touching the default CI behavior.
 *
 * Wiring (single path, no config drift):
 *   - `e2e/run-ci.sh` validates this env var in the SAME process that pins
 *     the fixture env before the Next build, then passes
 *     `--repeat-each=N` ONLY to the `pwa-runtime` and `push-runtime` gates.
 *   - `e2e/playwright.config.ts` is intentionally untouched (comment-only
 *     pointer): Playwright's `repeatEach` is top-level and would leak into
 *     the functional gates; the runner flag keeps the blast radius explicit.
 *
 * Semantics (mirrored by run-ci.sh validation — keep both in sync):
 *   - unset / "" / "0" / "1" → single run (current behavior, no flag).
 *   - integer >= 2 → each scenario runs N times in the same execution.
 *   - anything else (float, negative, non-numeric) → throw (fail-closed).
 *
 * Aggregation contract: Playwright already fails the run when ANY repetition
 * fails (CI stays red — a flake never goes green silently). The operator
 * reads WHICH repetitions failed from the output:
 *   - every rep fails → consistent FAIL (deterministic bug, fix the code);
 *   - some reps fail → FLAKE (perennial infra/timing flake, sample more);
 *   - all reps pass → stable (not a flake at this sample size).
 * `classifyRepeatOutcome` + `formatRepeatSummary` encode exactly that rule so
 * humans and tooling share one interpretation. No secrets flow through here:
 * the harness is fixture-only loopback; rep tallies carry scenario names and
 * pass/fail counts only.
 */

export const REPEAT_EACH_ENV = "E2E_RUNTIME_REPEAT_EACH";

export type RepeatOutcome = "stable-pass" | "flake" | "consistent-fail";

/**
 * Parse the raw env value. Returns the effective repetition count:
 * 1 = single run (disabled). Throws on malformed input (fail-closed).
 */
export function parseRepeatEachEnv(raw: string | undefined): number {
  if (raw === undefined || raw === "") return 1;
  if (!/^\d+$/.test(raw)) {
    throw new Error(
      `[repeat-each] invalid ${REPEAT_EACH_ENV}=${JSON.stringify(raw)} (want integer >= 0)`,
    );
  }
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) {
    throw new Error(
      `[repeat-each] invalid ${REPEAT_EACH_ENV}=${JSON.stringify(raw)} (want integer >= 0)`,
    );
  }
  return n <= 1 ? 1 : n;
}

/** Extra Playwright CLI args for the runtime gates; [] keeps current behavior. */
export function repeatEachCliArgs(reps: number): string[] {
  return reps <= 1 ? [] : [`--repeat-each=${reps}`];
}

/**
 * Classify one scenario's repetitions. `failedReps` = number of failed
 * repetitions out of `totalReps` runs of the same scenario.
 */
export function classifyRepeatOutcome(failedReps: number, totalReps: number): RepeatOutcome {
  if (totalReps <= 0) {
    throw new Error(`[repeat-each] invalid totalReps=${totalReps} (want >= 1)`);
  }
  if (!Number.isInteger(failedReps) || failedReps < 0 || failedReps > totalReps) {
    throw new Error(
      `[repeat-each] invalid failedReps=${failedReps} for totalReps=${totalReps}`,
    );
  }
  if (failedReps === 0) return "stable-pass";
  if (failedReps === totalReps) return "consistent-fail";
  return "flake";
}

/** One-line operator summary for a scenario's repetitions (no secrets). */
export function formatRepeatSummary(scenario: string, failedReps: number, totalReps: number): string {
  const outcome = classifyRepeatOutcome(failedReps, totalReps);
  const passed = totalReps - failedReps;
  return `[repeat-each] ${scenario}: ${passed}/${totalReps} passed → ${outcome.toUpperCase()}`;
}
