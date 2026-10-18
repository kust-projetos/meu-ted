#!/usr/bin/env node

/**
 * Deploy-manifest identity verification (T11a FATIA 1).
 *
 * The Agent deploy attestation must compare the lockfile hash and the
 * normalized Wrangler version of the SAME installation used by build/deploy —
 * not a global install, not a presence-only check. The CI agent job records
 * both values into `agent-deploy-manifest-<sha>`; the deploy job recomputes
 * both from its own checkout/installation and calls this helper, which fails
 * closed (non-zero exit) on ANY divergence except legitimate whitespace in
 * the Wrangler version string (normalized, not bypassed).
 *
 * Preserved manifest provenance: source workflow (`CI`), CI run id, and the
 * deployed SHA. Fork/event/freshness gates stay in the workflow YAML and are
 * locked by structural tests — this helper never relaxes them.
 *
 * Error messages name the violated rule only; they NEVER echo manifest or
 * expected values (no hash/version leak into logs, no log-injection via
 * crafted values).
 */

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * Normalizes a `wrangler --version` capture for comparison. Trims surrounding
 * whitespace, collapses internal runs, and extracts the first semver-like
 * token when the capture carries a prefix (e.g. `wrangler 3.114.0`).
 * Returns "" for blank input. Case-insensitive by construction.
 */
export function normalizeWranglerVersion(raw) {
  const collapsed = String(raw ?? "").trim().replace(/\s+/g, " ");
  if (collapsed === "") return "";
  const match = collapsed.match(/\d+\.\d+\.\d+[^\s]*/);
  return (match ? match[0] : collapsed).toLowerCase();
}

/**
 * Verifies a parsed deploy manifest against the expected same-installation
 * identity. Returns `{ ok: true, reason: "identity-match" }` or
 * `{ ok: false, reason }` where reason names the violated rule only.
 * Expected shape: `{ sha, workflow, runId, lockfileHash, wranglerVersion }`.
 * `expected.runId` is compared when provided (the deploy job passes the
 * manifest-run it downloaded the artifact from); omit it only when the
 * caller cannot know the run.
 */
export function verifyDeployManifest(manifest, expected = {}) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return { ok: false, reason: "manifest-not-an-object" };
  }
  if (typeof expected.sha !== "string" || expected.sha === "") {
    return { ok: false, reason: "expected-sha-missing" };
  }
  if (manifest.sha !== expected.sha) {
    return { ok: false, reason: "sha-mismatch" };
  }
  const expectedWorkflow = expected.workflow ?? "CI";
  if (manifest.workflow !== expectedWorkflow) {
    return { ok: false, reason: "workflow-mismatch" };
  }
  if (typeof manifest.runId !== "string" || manifest.runId.trim() === "") {
    return { ok: false, reason: "run-id-missing" };
  }
  if (expected.runId != null && expected.runId !== "" && manifest.runId !== expected.runId) {
    return { ok: false, reason: "run-id-mismatch" };
  }
  if (typeof manifest.lockfileHash !== "string" || !/^[0-9a-f]{64}$/.test(manifest.lockfileHash)) {
    return { ok: false, reason: "lockfile-hash-invalid" };
  }
  if (manifest.lockfileHash !== expected.lockfileHash) {
    return { ok: false, reason: "lockfile-hash-mismatch" };
  }
  const manifestWrangler = normalizeWranglerVersion(manifest.wranglerVersion);
  const expectedWrangler = normalizeWranglerVersion(expected.wranglerVersion);
  if (manifestWrangler === "" || expectedWrangler === "") {
    return { ok: false, reason: "wrangler-version-missing" };
  }
  if (manifestWrangler !== expectedWrangler) {
    return { ok: false, reason: "wrangler-version-mismatch" };
  }
  return { ok: true, reason: "identity-match" };
}

function parseArgs(argv) {
  const out = { workflow: "CI" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--manifest") out.manifest = argv[++i];
    else if (argv[i] === "--sha") out.sha = argv[++i];
    else if (argv[i] === "--lockfile-hash") out.lockfileHash = argv[++i];
    else if (argv[i] === "--wrangler-version") out.wranglerVersion = argv[++i];
    else if (argv[i] === "--workflow") out.workflow = argv[++i];
    else if (argv[i] === "--run-id") out.runId = argv[++i];
    else {
      console.error(`Fatal: unknown argument ${argv[i]}`);
      process.exit(2);
    }
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.manifest || !args.sha || !args.lockfileHash || args.wranglerVersion === undefined) {
    console.error(
      "Usage: validate-deploy-manifest.mjs --manifest <path> --sha <40hex> --lockfile-hash <64hex> --wrangler-version <v> [--workflow CI] [--run-id <id>]",
    );
    process.exit(2);
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(args.manifest, "utf8"));
  } catch {
    console.error("Fatal: manifest-unreadable (not found or invalid JSON)");
    process.exit(1);
  }
  const result = verifyDeployManifest(manifest, {
    sha: args.sha,
    workflow: args.workflow,
    runId: args.runId,
    lockfileHash: args.lockfileHash,
    wranglerVersion: args.wranglerVersion,
  });
  if (!result.ok) {
    console.error(`Deploy blocked: manifest identity verification failed (${result.reason})`);
    process.exit(1);
  }
  console.log(`manifest identity verified for ${args.sha} (lockfile + wrangler match this installation)`);
}

const invokedDirectly =
  typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main();
