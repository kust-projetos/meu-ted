/**
 * Delimited dedupe policy for the deploy workflow_run pair (T11a FATIA 2).
 *
 * CI and PWA CI completions each fire agent-deploy/pwa-deploy (known
 * workflow_run race), so two events routinely evaluate the same SHA. A prior
 * ATTESTED for a SHA is NEVER enough on its own: "green without a deploy
 * that actually ran" is NOT an attestation.
 *
 * This module is the ONLY safe dedupe condition, proven by unit tests. The
 * workflows intentionally contain NO automatic skip today (structural tests
 * assert no `dedupe` logic bypasses any deploy): any future second-event
 * skip must satisfy `decideDeployDedupe(...) === { dedupe: true }`, i.e. the
 * same manifest sigil (SHA + lockfile hash + normalized Wrangler) PLUS live
 * checks performed NOW — gate success, deploy readiness, freshness
 * (main still equals the candidate SHA), and a manifest re-verification in
 * this run. Every other scenario (both events flaked, one still running, a
 * later failure of the first, rerun with drift, main moved between events,
 * prior attestation from another SHA/manifest/instance) returns
 * `{ dedupe: false }` and the event must run the full gate → deploy → smoke.
 *
 * Kill switch deliberation stays OUT of scope: there is no flag here that
 * disables triggers or skips events.
 */

import { normalizeWranglerVersion } from "./validate-deploy-manifest.mjs";

/**
 * Decides whether the current deploy event may be deduplicated against a
 * prior attestation. Inputs:
 * - `current`: `{ sha, lockfileHash, wranglerVersion }` of THIS event.
 * - `previous`: prior attestation record or null/undefined —
 *   `{ attestation, sha, lockfileHash, wranglerVersion }`.
 * - `live`: liveness checks performed NOW —
 *   `{ gateSuccess, deployReady, mainMatchesSha, manifestVerified }`.
 * Returns `{ dedupe: boolean, reason: string }` (reason names the rule only).
 */
export function decideDeployDedupe({ current, previous, live } = {}) {
  if (!previous || previous.attestation !== "ATTESTED") {
    return { dedupe: false, reason: "no-prior-attestation" };
  }
  if (!current || typeof current.sha !== "string" || current.sha === "") {
    return { dedupe: false, reason: "current-sha-missing" };
  }
  if (previous.sha !== current.sha) {
    return { dedupe: false, reason: "sha-changed" };
  }
  if (
    typeof previous.lockfileHash !== "string" ||
    previous.lockfileHash === "" ||
    previous.lockfileHash !== current.lockfileHash
  ) {
    return { dedupe: false, reason: "manifest-changed" };
  }
  const previousWrangler = normalizeWranglerVersion(previous.wranglerVersion);
  const currentWrangler = normalizeWranglerVersion(current?.wranglerVersion);
  if (previousWrangler === "" || currentWrangler === "" || previousWrangler !== currentWrangler) {
    return { dedupe: false, reason: "identity-changed" };
  }
  if (!live || live.gateSuccess !== true || live.deployReady !== true) {
    return { dedupe: false, reason: "gate-not-ready-now" };
  }
  if (live.mainMatchesSha !== true) {
    return { dedupe: false, reason: "main-moved" };
  }
  if (live.manifestVerified !== true) {
    return { dedupe: false, reason: "no-live-verification" };
  }
  return { dedupe: true, reason: "duplicate-event-same-sigil-live-verified" };
}
