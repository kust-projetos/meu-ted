#!/usr/bin/env node

/**
 * Agent release-identity smoke (issue #96: Cloudflare Workers version
 * propagation is eventually consistent).
 *
 * The deployed worker must report the SHA this workflow deployed
 * (`EXPECTED_SHA`), but a single GET right after deploy can still observe
 * the previous version (run 37453906796: deploy published at 11:04:31Z,
 * smoke ran ~13s later and failed on the stale SHA, production converged
 * hours later). This helper proves `merged HEAD == buildSha from /health`
 * with a BOUNDED retry instead of a single curl, without turning a genuine
 * failure green.
 *
 * Decision rules per attempt (contract cases):
 *  1. HTTP 404                       -> FAIL immediately (missing endpoint
 *     never converges via propagation).
 *  2. HTTP 3xx                       -> FAIL immediately (redirects are
 *     endpoint drift, not propagation: the attestation must prove the
 *     CANONICAL origin, so the fetch is issued with `redirect: "manual"`
 *     and any 3xx is refused without following it).
 *  3. Other status >= 400, network error, non-JSON body -> RETRY (may be
 *     transient during propagation).
 *  4. `status !== 'ready'`           -> RETRY (every version answers ready;
 *     anything else is a transitional state).
 *  5. `status === 'ready'` but `buildSha` missing/empty -> FAIL immediately
 *     (contract violation: propagation never removes the field — the
 *     previous version already carries buildSha since V4.1 Phase 9).
 *  6. `buildSha === expectedSha`     -> PASS.
 *  7. `buildSha !== expectedSha`     -> RETRY; attempts exhausted -> FAIL
 *     with the last observed buildSha.
 *
 * Backoff policy: FIXED linear delay — `baseDelayMs` between attempts, no
 * growth. Each attempt is bounded by `requestTimeoutMs` (AbortSignal covers
 * connect + headers + body read, so a hung request can never consume the
 * job's whole timeout): worst case with defaults is
 * `maxAttempts * (requestTimeoutMs + baseDelayMs)` = 8 * (5000 + 5000) =
 * ~80s plus parsing, well inside the smoke job's timeout-minutes: 10.
 * Fixed (not exponential) because the propagation window is measured in
 * seconds-to-minutes and a short uniform poll converges just as well while
 * keeping the worst case explicit and small.
 *
 * `url` is the validated Agent origin (e.g. from $AGENT_PROD_URL, already
 * pinned by validate-deploy-origins.mjs); this helper appends `/health`
 * itself. No hosts are hardcoded here — everything arrives via args.
 */

import { pathToFileURL } from "node:url";

const DEFAULT_MAX_ATTEMPTS = 8;
const DEFAULT_BASE_DELAY_MS = 5000;
const DEFAULT_REQUEST_TIMEOUT_MS = 5000;
const EXPECTED_SHA_RE = /^[0-9a-f]{40}$/;

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Pure decision function: maps one parsed `/health` payload to a verdict.
 * Separated from the retry loop so the contract is unit-testable without
 * I/O. Returns exactly one of:
 *   { verdict: 'pass' } | { verdict: 'retry', reason } | { verdict: 'fail', reason }
 */
export function evaluateHealthPayload(payload, expectedSha) {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { verdict: "retry", reason: "non-object JSON payload" };
  }
  if (payload.status !== "ready") {
    return { verdict: "retry", reason: `status is ${JSON.stringify(payload.status) ?? "missing"} (want "ready")` };
  }
  const observed = payload.buildSha;
  if (typeof observed !== "string" || observed.length === 0) {
    return { verdict: "fail", reason: "status is ready but buildSha is missing or empty (contract violation)" };
  }
  if (observed === expectedSha) {
    return { verdict: "pass" };
  }
  return { verdict: "retry", reason: `observed buildSha differs from expected (propagation pending)` };
}

function observedShaOf(payload) {
  if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
    const value = payload.buildSha;
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/**
 * Polls `<url>/health` until the release identity converges or the budget
 * runs out. Returns `{ ok, attempts, lastBuildSha?, reason? }`.
 * `fetchImpl`/`sleepImpl` are injectable so tests run instantly.
 */
export async function runAgentReleaseSmoke({
  url,
  expectedSha,
  fetchImpl = fetch,
  sleepImpl = defaultSleep,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  baseDelayMs = DEFAULT_BASE_DELAY_MS,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  log = console.error,
}) {
  const target = `${String(url).replace(/\/+$/, "")}/health`;
  let lastBuildSha;
  let lastReason = "no attempts made";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let decision;
    try {
      // `redirect: "manual"`: the attestation must prove the CANONICAL origin,
      // so any 3xx is refused without following it (redirects are endpoint
      // drift, not version propagation). `AbortSignal.timeout` bounds the WHOLE
      // attempt — connect, headers and body read — so a hung request can never
      // consume the job's timeout; an abort surfaces as a network error (retry).
      const signal = AbortSignal.timeout(requestTimeoutMs);
      const res = await fetchImpl(target, {
        redirect: "manual",
        signal,
      });
      if (res != null && typeof res.status === "number") {
        if (res.status === 404) {
          decision = { verdict: "fail", reason: "HTTP 404 from /health (endpoint missing, not propagation)" };
        } else if (res.status >= 300 && res.status < 400) {
          decision = { verdict: "fail", reason: `HTTP ${res.status} redirect from /health (endpoint drift, not propagation; location not followed)` };
        } else if (res.status >= 400) {
          decision = { verdict: "retry", reason: `HTTP ${res.status} from /health (transient)` };
        } else {
          let payload;
          try {
            payload = await res.json();
          } catch {
            // A deadline abort during the BODY read must be classified as a
            // network error (transient), not as a malformed body.
            decision = signal.aborted
              ? { verdict: "retry", reason: "request deadline exceeded while reading body (aborted)" }
              : { verdict: "retry", reason: "non-JSON body from /health (transient)" };
          }
          if (!decision) {
            decision = evaluateHealthPayload(payload, expectedSha);
            const seen = observedShaOf(payload);
            if (seen !== undefined) lastBuildSha = seen;
          }
        }
      } else {
        decision = { verdict: "retry", reason: "malformed fetch response (transient)" };
      }
    } catch (err) {
      decision = { verdict: "retry", reason: `network error: ${(err && err.message) || err}` };
    }

    const tag = decision.verdict.toUpperCase();
    const detail =
      decision.verdict === "pass"
        ? `buildSha matches expected`
        : `${decision.reason}${lastBuildSha !== undefined ? ` observed=${lastBuildSha}` : ""}`;
    log(`[agent-release-smoke] attempt ${attempt}/${maxAttempts}: ${tag} — ${detail}`);

    if (decision.verdict === "pass") {
      log(`[agent-release-smoke] PASS: deployed SHA converges to expected (attempts=${attempt})`);
      return { ok: true, attempts: attempt, lastBuildSha };
    }
    if (decision.verdict === "fail") {
      lastReason = decision.reason;
      log(`[agent-release-smoke] FAIL: ${lastReason} (attempts=${attempt})`);
      return { ok: false, attempts: attempt, lastBuildSha, reason: lastReason };
    }
    lastReason = decision.reason;
    if (attempt < maxAttempts) {
      await sleepImpl(baseDelayMs);
    }
  }

  const reason = `exhausted ${maxAttempts} attempts without convergence: ${lastReason}`;
  log(`[agent-release-smoke] FAIL: ${reason}`);
  return { ok: false, attempts: maxAttempts, lastBuildSha, reason };
}

/**
 * Parses and validates CLI args (fail-closed). Throws `Error` with a
 * message that NEVER echoes the supplied values.
 */
export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--url") out.url = argv[++i];
    else if (arg === "--expected-sha") out.expectedSha = argv[++i];
    else if (arg === "--max-attempts") out.maxAttempts = argv[++i];
    else if (arg === "--base-delay-ms") out.baseDelayMs = argv[++i];
    else if (arg === "--request-timeout-ms") out.requestTimeoutMs = argv[++i];
    else throw new Error(`invalid argument (unknown flag)`);
  }
  if (typeof out.url !== "string" || out.url.length === 0) {
    throw new Error("invalid --url: a valid absolute https URL is required (value not echoed)");
  }
  let parsed;
  try {
    parsed = new URL(out.url);
  } catch {
    throw new Error("invalid --url: must be a valid absolute https URL (value not echoed)");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("invalid --url: scheme must be https (value not echoed)");
  }
  if (typeof out.expectedSha !== "string" || !EXPECTED_SHA_RE.test(out.expectedSha)) {
    throw new Error("invalid --expected-sha: must be a 40-char lowercase hex SHA (value not echoed)");
  }
  let maxAttempts = DEFAULT_MAX_ATTEMPTS;
  if (out.maxAttempts !== undefined) {
    maxAttempts = Number(out.maxAttempts);
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
      throw new Error("invalid --max-attempts: must be a positive integer");
    }
  }
  let baseDelayMs = DEFAULT_BASE_DELAY_MS;
  if (out.baseDelayMs !== undefined) {
    baseDelayMs = Number(out.baseDelayMs);
    if (!Number.isInteger(baseDelayMs) || baseDelayMs < 0) {
      throw new Error("invalid --base-delay-ms: must be a non-negative integer");
    }
  }
  let requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS;
  if (out.requestTimeoutMs !== undefined) {
    requestTimeoutMs = Number(out.requestTimeoutMs);
    if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1) {
      throw new Error("invalid --request-timeout-ms: must be a positive integer");
    }
  }
  return { url: out.url, expectedSha: out.expectedSha, maxAttempts, baseDelayMs, requestTimeoutMs };
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`[agent-release-smoke] ${(err && err.message) || err}`);
    console.error("Usage: agent-release-smoke.mjs --url <https-origin> --expected-sha <40-hex> [--max-attempts N] [--base-delay-ms MS] [--request-timeout-ms MS]");
    process.exit(2);
  }
  const result = await runAgentReleaseSmoke({
    url: opts.url,
    expectedSha: opts.expectedSha,
    maxAttempts: opts.maxAttempts,
    baseDelayMs: opts.baseDelayMs,
    requestTimeoutMs: opts.requestTimeoutMs,
  });
  process.exit(result.ok ? 0 : 1);
}

const invokedDirectly =
  typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  await main();
}
