import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { normalizeWranglerVersion, verifyDeployManifest } from "./validate-deploy-manifest.mjs";
import { decideDeployDedupe } from "./deploy-dedupe.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");

// Structural safety gate for DEBT2-CODER-SMOKE-URL-FIX (security review
// MEDIUM): GitHub `vars.*` contexts must never be interpolated into `run:`
// script text, and every smoke curl must run after the pinned deploy-origin
// validation. Textual on purpose — the repo has no YAML parser dependency.

function readWorkflow(name) {
  return readFileSync(join(ROOT, ".github", "workflows", name), "utf8");
}

// All `run:` script bodies: block scalars (`run: |` / `run: >`) plus
// single-line `run:` commands.
function runScripts(source) {
  const scripts = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const block = /^(\s*)run:\s*[|>]\s*$/.exec(lines[i]);
    if (block) {
      const base = block[1].length;
      const body = [];
      let j = i + 1;
      while (j < lines.length && (lines[j].trim() === "" || lines[j].search(/\S/) > base)) {
        body.push(lines[j]);
        j++;
      }
      scripts.push(body.join("\n"));
      continue;
    }
    const single = /^\s*run:\s*(?![|>])(.+)$/.exec(lines[i]);
    if (single) scripts.push(single[1]);
  }
  return scripts;
}

function smokeRegion(source) {
  const idx = source.indexOf("\n  smoke:");
  assert.ok(idx !== -1, "smoke job missing");
  return source.slice(idx);
}

// Index of the first smoke `curl` invocation line (comments excluded).
function firstCurlIndex(region) {
  const lines = region.split("\n");
  let offset = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("#") && /(^|[;&|]\s*|\s+)curl\s/.test(trimmed)) {
      return offset + line.indexOf("curl");
    }
    offset += line.length + 1;
  }
  return -1;
}

for (const file of ["pwa-deploy.yml", "agent-deploy.yml"]) {
  test(`${file}: no vars.* context inside run: script text`, () => {
    const source = readWorkflow(file);
    for (const script of runScripts(source)) {
      assert.ok(!script.includes("vars."), `vars.* interpolated into run: text:\n${script}`);
    }
  });
}

test("pwa-deploy.yml: smoke validates the PWA origin before any curl", () => {
  const smoke = smokeRegion(readWorkflow("pwa-deploy.yml"));
  assert.ok(
    smoke.includes("validate-deploy-origins.mjs --name PWA_PROD_URL --expect pwa --env-file"),
    "smoke must validate PWA_PROD_URL via the helper",
  );
  const validateAt = smoke.indexOf("--name PWA_PROD_URL");
  const firstCurl = firstCurlIndex(smoke);
  assert.ok(firstCurl !== -1, "expected a curl in smoke");
  assert.ok(validateAt < firstCurl, "validation must precede the first smoke curl");
});

test("agent-deploy.yml: smoke validates the Agent origin before any curl", () => {
  const smoke = smokeRegion(readWorkflow("agent-deploy.yml"));
  assert.ok(
    smoke.includes("validate-deploy-origins.mjs --name AGENT_PROD_URL --expect agent --env-file"),
    "smoke must validate AGENT_PROD_URL via the helper",
  );
  const validateAt = smoke.indexOf("--name AGENT_PROD_URL");
  const firstCurl = firstCurlIndex(smoke);
  assert.ok(firstCurl !== -1, "expected a curl in smoke");
  assert.ok(validateAt < firstCurl, "validation must precede the first smoke curl");
});

test("smoke curls use only the quoted canonical env values", () => {
  const pwa = smokeRegion(readWorkflow("pwa-deploy.yml"));
  for (const line of pwa.split("\n")) {
    if (line.includes("curl") && line.includes("PWA_PROD_URL")) {
      assert.ok(line.includes('"$PWA_PROD_URL'), `unquoted PWA_PROD_URL in smoke curl: ${line.trim()}`);
    }
  }
  const agent = smokeRegion(readWorkflow("agent-deploy.yml"));
  for (const line of agent.split("\n")) {
    if (line.includes("curl") && line.includes("AGENT_PROD_URL")) {
      assert.ok(line.includes('"$AGENT_PROD_URL'), `unquoted AGENT_PROD_URL in smoke curl: ${line.trim()}`);
    }
  }
});

test("agent-deploy.yml: release identity uses the bounded propagation-retry helper (issue #96)", () => {
  const smoke = smokeRegion(readWorkflow("agent-deploy.yml"));
  assert.ok(
    smoke.includes('node scripts/agent-release-smoke.mjs --url "$AGENT_PROD_URL" --expected-sha "$EXPECTED_SHA"'),
    "release-identity step must call agent-release-smoke.mjs with the quoted canonical env values",
  );
  assert.ok(
    !smoke.includes('grep -q "\\"buildSha\\"'),
    "single-curl buildSha grep must be gone (false failure on eventual propagation)",
  );
});

// ─── T11a FATIA 1: manifest identity from the SAME installation ──────────────
// The attestation must compare the lockfile hash and the normalized Wrangler
// version of the SAME installation used by build/deploy — not a global
// install, not a presence-only check. Whitespace divergence in the version
// string is legitimate normalization (PASS); every other divergence blocks.

const GOOD_SHA = "a".repeat(40);
const GOOD_HASH = "b".repeat(64);
const GOOD_WRANGLER = "3.114.0";

function goodManifest(overrides = {}) {
  return {
    sha: GOOD_SHA,
    workflow: "CI",
    runId: "123456789",
    lockfileHash: GOOD_HASH,
    wranglerVersion: GOOD_WRANGLER,
    ...overrides,
  };
}

function goodExpected(overrides = {}) {
  return {
    sha: GOOD_SHA,
    workflow: "CI",
    runId: "123456789",
    lockfileHash: GOOD_HASH,
    wranglerVersion: GOOD_WRANGLER,
    ...overrides,
  };
}

test("normalizeWranglerVersion trims whitespace but preserves the version", () => {
  assert.equal(normalizeWranglerVersion("  3.114.0\n"), "3.114.0");
  assert.equal(normalizeWranglerVersion("3.114.0"), "3.114.0");
  // Blank input carries no identity: null (never ""), so callers fail closed.
  assert.equal(normalizeWranglerVersion(""), null);
  assert.equal(normalizeWranglerVersion("   \n "), null);
});

// T11a review remediation (FINDING 1 P1): strict identity — SOMENTE string,
// prefixos decorativos conhecidos, semver completa ancorada, sem texto residual.
test("normalizeWranglerVersion accepts only strings (non-string ⇒ null)", () => {
  for (const bad of [["3.114.0"], { version: "3.114.0" }, 31140, null, undefined, true]) {
    assert.equal(normalizeWranglerVersion(bad), null, `non-string ${JSON.stringify(bad)} must be null`);
  }
});

test("normalizeWranglerVersion normalizes known decorative prefixes only", () => {
  // Positivas reais: literal "wrangler" + colapso de whitespace + emoji de nuvem.
  assert.equal(normalizeWranglerVersion("wrangler 3.114.0"), "3.114.0");
  assert.equal(normalizeWranglerVersion("wrangler  3.114.0"), "3.114.0");
  assert.equal(normalizeWranglerVersion("  wrangler\t3.114.0\n"), "3.114.0");
  assert.equal(normalizeWranglerVersion("Wrangler 3.114.0"), "3.114.0");
  assert.equal(normalizeWranglerVersion("⛅️ wrangler 3.114.0"), "3.114.0");
  assert.equal(normalizeWranglerVersion("☁️ wrangler  3.114.0"), "3.114.0");
  // Prerelease/build extras permitidos via regex canônica.
  assert.equal(normalizeWranglerVersion("wrangler 3.114.0-beta.1"), "3.114.0-beta.1");
  assert.equal(normalizeWranglerVersion("3.114.0+build.5"), "3.114.0+build.5");
});

test("normalizeWranglerVersion requires a complete X.Y.Z semver (no short forms)", () => {
  // INTENÇÃO DOCUMENTADA: somente três componentes + cauda semver opcional.
  // "3.114" (sem patch) é rejeitado; prefixo "v" também (não é semver canônica,
  // o wrangler real nunca o emite — fail-closed em vez de adivinhar).
  for (const bad of ["wrangler 3.114", "3.114", "3", "v3.114.0", "wrangler v3.114.0", "3.114.0.1"]) {
    assert.equal(normalizeWranglerVersion(bad), null, `${JSON.stringify(bad)} must be null`);
  }
});

test("normalizeWranglerVersion rejects any residual text (never skips to first semver)", () => {
  for (const bad of [
    "wranlg 3.114.0",
    "ERROR not wrangler 3.114.0 failed",
    "3.114.0 extra",
    "not 3.114.0",
    "wrangler 3.114.0 failed",
    "version 3.114.0",
  ]) {
    assert.equal(normalizeWranglerVersion(bad), null, `${JSON.stringify(bad)} must be null`);
  }
});

// T11a review remediation round 2 (R2-1 P1): generic non-alphanumeric prefix
// stripping is FORBIDDEN — only the explicit allowlist normalizes.
test("normalizeWranglerVersion rejects generic prefixes and unknown emoji (R2-1 allowlist)", () => {
  for (const bad of ["-3.114.0", "!!! 3.114.0", "🚨 wrangler 3.114.0"]) {
    assert.equal(normalizeWranglerVersion(bad), null, `${JSON.stringify(bad)} must be null`);
  }
});

test("verifyDeployManifest blocks generic-prefix wranglerVersion (R2-1)", () => {
  const result = verifyDeployManifest(goodManifest({ wranglerVersion: "-3.114.0" }), goodExpected());
  assert.equal(result.ok, false, `"-3.114.0" must block, got ${result.reason}`);
});

// T11a review remediation round 2 (R2-2 P2): canonical strict semver — no
// leading zeros, no empty prerelease identifiers, no leading-zero numerics.
test("normalizeWranglerVersion enforces strict semver (R2-2)", () => {
  for (const bad of ["01.114.5", "3.01.0", "3.114.01", "3.114.0-beta..1", "3.114.0-01"]) {
    assert.equal(normalizeWranglerVersion(bad), null, `${JSON.stringify(bad)} must be null`);
  }
  for (const good of ["3.114.0", "3.114.0-beta.1", "3.114.0+build.2", "0.0.0", "10.20.30"]) {
    assert.ok(normalizeWranglerVersion(good) !== null, `${JSON.stringify(good)} must normalize`);
  }
});

test("verifyDeployManifest blocks non-string wranglerVersion (fail-closed)", () => {
  for (const bad of [["3.114.0"], { version: "3.114.0" }, 31140, null]) {
    const result = verifyDeployManifest(goodManifest({ wranglerVersion: bad }), goodExpected());
    assert.equal(result.ok, false, `non-string wranglerVersion ${JSON.stringify(bad)} must block`);
  }
});

test("verifyDeployManifest accepts the exact same-installation identity", () => {
  assert.deepEqual(verifyDeployManifest(goodManifest(), goodExpected()), { ok: true, reason: "identity-match" });
});

test("verifyDeployManifest passes legitimate whitespace divergence in wranglerVersion", () => {
  const result = verifyDeployManifest(goodManifest({ wranglerVersion: "  3.114.0\n" }), goodExpected());
  assert.equal(result.ok, true, `whitespace-only divergence must normalize, got ${result.reason}`);
});

for (const field of ["sha", "workflow", "runId", "lockfileHash", "wranglerVersion"]) {
  test(`verifyDeployManifest blocks a manifest missing ${field}`, () => {
    const manifest = goodManifest();
    delete manifest[field];
    const result = verifyDeployManifest(manifest, goodExpected());
    assert.equal(result.ok, false, `missing ${field} must block attestation`);
  });
}

test("verifyDeployManifest blocks divergent lockfileHash", () => {
  const result = verifyDeployManifest(goodManifest({ lockfileHash: "c".repeat(64) }), goodExpected());
  assert.equal(result.ok, false);
  assert.match(result.reason, /lockfile-hash/);
});

test("verifyDeployManifest blocks malformed lockfileHash (short / non-hex)", () => {
  for (const bad of ["abc123", "B".repeat(64), "", "zz".repeat(32)]) {
    const result = verifyDeployManifest(goodManifest({ lockfileHash: bad }), goodExpected());
    assert.equal(result.ok, false, `malformed lockfileHash ${JSON.stringify(bad)} must block`);
  }
});

test("verifyDeployManifest blocks divergent wranglerVersion", () => {
  const result = verifyDeployManifest(goodManifest({ wranglerVersion: "3.115.0" }), goodExpected());
  assert.equal(result.ok, false);
  assert.match(result.reason, /wrangler-version/);
});

test("verifyDeployManifest blocks sha mismatch", () => {
  const result = verifyDeployManifest(goodManifest({ sha: "d".repeat(40) }), goodExpected());
  assert.equal(result.ok, false);
  assert.match(result.reason, /sha/);
});

test("verifyDeployManifest blocks a manifest from the wrong workflow source", () => {
  const result = verifyDeployManifest(goodManifest({ workflow: "PWA CI" }), goodExpected());
  assert.equal(result.ok, false);
  assert.match(result.reason, /workflow/);
});

test("verifyDeployManifest blocks runId mismatch against the resolved CI run", () => {
  const result = verifyDeployManifest(goodManifest({ runId: "999" }), goodExpected());
  assert.equal(result.ok, false);
  assert.match(result.reason, /run-id/);
});

// ─── T11a FATIA 2: delimited dedupe of the workflow_run pair ────────────────
// CI and PWA CI completions each fire the deploy workflows (known
// workflow_run race). A prior ATTESTED for a SHA is NEVER enough on its own:
// dedupe requires the same manifest sigil plus live checks performed NOW
// (gate + freshness + manifest re-verification). "Green without a deploy that
// actually ran" is NOT an attestation, so there is no automatic skip in the
// workflows — this policy is the only safe future condition, proven here.

const CURRENT = {
  sha: GOOD_SHA,
  lockfileHash: GOOD_HASH,
  wranglerVersion: GOOD_WRANGLER,
  environment: "production",
  target: "agent",
};
const PRIOR_ATTESTED = {
  attestation: "ATTESTED",
  sha: GOOD_SHA,
  lockfileHash: GOOD_HASH,
  wranglerVersion: GOOD_WRANGLER,
  environment: "production",
  target: "agent",
};
const LIVE_OK = { gateSuccess: true, deployReady: true, mainMatchesSha: true, manifestVerified: true };

test("dedupe: no prior attestation (both CI events flaked) never dedupes", () => {
  for (const previous of [null, undefined, { attestation: "NOT-ATTESTED", reason: "deploy-failure" }]) {
    const result = decideDeployDedupe({ current: { ...CURRENT }, previous, live: { ...LIVE_OK } });
    assert.equal(result.dedupe, false, "without a prior ATTESTED this event must run fully");
  }
});

test("dedupe: prior failure after an earlier success never dedupes", () => {
  const previous = { ...PRIOR_ATTESTED, attestation: "NOT-ATTESTED", reason: "smoke-failure" };
  const result = decideDeployDedupe({ current: { ...CURRENT }, previous, live: { ...LIVE_OK } });
  assert.equal(result.dedupe, false);
});

test("dedupe: prior ATTESTED for a different SHA never dedupes", () => {
  const previous = { ...PRIOR_ATTESTED, sha: "e".repeat(40) };
  const result = decideDeployDedupe({ current: { ...CURRENT }, previous, live: { ...LIVE_OK } });
  assert.equal(result.dedupe, false);
  assert.match(result.reason, /sha/);
});

test("dedupe: same SHA but changed lockfile hash never dedupes", () => {
  const previous = { ...PRIOR_ATTESTED, lockfileHash: "c".repeat(64) };
  const result = decideDeployDedupe({ current: { ...CURRENT }, previous, live: { ...LIVE_OK } });
  assert.equal(result.dedupe, false);
  assert.match(result.reason, /manifest/);
});

test("dedupe: same SHA but different Wrangler identity never dedupes", () => {
  const previous = { ...PRIOR_ATTESTED, wranglerVersion: "3.115.0" };
  const result = decideDeployDedupe({ current: { ...CURRENT }, previous, live: { ...LIVE_OK } });
  assert.equal(result.dedupe, false);
  assert.match(result.reason, /identity/);
});

test("dedupe: other CI still running (gate not ready now) never dedupes", () => {
  const live = { ...LIVE_OK, deployReady: false };
  const result = decideDeployDedupe({ current: { ...CURRENT }, previous: { ...PRIOR_ATTESTED }, live });
  assert.equal(result.dedupe, false);
  assert.match(result.reason, /gate/);
});

test("dedupe: main moved between the two events never dedupes", () => {
  const live = { ...LIVE_OK, mainMatchesSha: false };
  const result = decideDeployDedupe({ current: { ...CURRENT }, previous: { ...PRIOR_ATTESTED }, live });
  assert.equal(result.dedupe, false);
  assert.match(result.reason, /main/);
});

test("dedupe: manifest not re-verified live now never dedupes", () => {
  const live = { ...LIVE_OK, manifestVerified: false };
  const result = decideDeployDedupe({ current: { ...CURRENT }, previous: { ...PRIOR_ATTESTED }, live });
  assert.equal(result.dedupe, false);
});

test("dedupe: rerun with the same sigil and all live checks passes dedupe", () => {
  const result = decideDeployDedupe({ current: { ...CURRENT }, previous: { ...PRIOR_ATTESTED }, live: { ...LIVE_OK } });
  assert.equal(result.dedupe, true);
});

test("dedupe: whitespace-normalized Wrangler equality still dedupes", () => {
  const previous = { ...PRIOR_ATTESTED, wranglerVersion: "  3.114.0\n" };
  const result = decideDeployDedupe({ current: { ...CURRENT }, previous, live: { ...LIVE_OK } });
  assert.equal(result.dedupe, true);
});

// T11a review remediation (FINDING 2 P2): environment + target integram a
// identidade — divergentes ou ausentes de qualquer lado ⇒ dedupe:false.
test("dedupe: divergent environment (stage vs production) never dedupes", () => {
  const previous = { ...PRIOR_ATTESTED, environment: "stage" };
  const result = decideDeployDedupe({
    current: { ...CURRENT, environment: "production" },
    previous,
    live: { ...LIVE_OK },
  });
  assert.equal(result.dedupe, false);
  assert.match(result.reason, /environment/);
});

test("dedupe: divergent target never dedupes", () => {
  const previous = { ...PRIOR_ATTESTED, target: "pwa" };
  const result = decideDeployDedupe({
    current: { ...CURRENT, target: "agent" },
    previous,
    live: { ...LIVE_OK },
  });
  assert.equal(result.dedupe, false);
  assert.match(result.reason, /target/);
});

test("dedupe: missing environment/target on either side never dedupes (fail-closed)", () => {
  const cases = [
    [{ ...CURRENT, environment: undefined }, { ...PRIOR_ATTESTED }],
    [{ ...CURRENT }, { ...PRIOR_ATTESTED, environment: undefined }],
    [{ ...CURRENT, target: undefined }, { ...PRIOR_ATTESTED }],
    [{ ...CURRENT }, { ...PRIOR_ATTESTED, target: undefined }],
  ];
  for (const [current, previous] of cases) {
    const result = decideDeployDedupe({ current, previous, live: { ...LIVE_OK } });
    assert.equal(result.dedupe, false, "absent environment/target must fail closed");
  }
});

// ─── T11a structural: triggers, permissions, gates, wiring ──────────────────

function deployRegion(source) {
  const idx = source.indexOf("\n  deploy:");
  assert.ok(idx !== -1, "deploy job missing");
  return source.slice(idx);
}

function attestRegion(source) {
  const idx = source.indexOf("\n  attest:");
  assert.ok(idx !== -1, "attest job missing");
  return source.slice(idx);
}

for (const file of ["pwa-deploy.yml", "agent-deploy.yml"]) {
  test(`${file}: workflow_run triggers preserved (no removal, no reorder, no dispatch)`, () => {
    const source = readWorkflow(file);
    assert.ok(source.includes('workflows: ["CI", "PWA CI"]'), "both CI sources must stay wired");
    assert.ok(source.includes("types: [completed]"), "completed trigger must stay");
    assert.ok(source.includes("branches: [main]"), "main branch filter must stay");
    assert.ok(!source.includes("workflow_dispatch"), "no manual dispatch bypass");
  });

  test(`${file}: permissions not expanded (deploy read-only, attest none)`, () => {
    const deploy = deployRegion(readWorkflow(file));
    assert.ok(deploy.includes("contents: read"), "deploy keeps contents: read");
    assert.ok(deploy.includes("actions: read"), "deploy keeps actions: read");
    assert.ok(!deploy.includes("contents: write"), "deploy must not gain write");
    assert.ok(attestRegion(readWorkflow(file)).includes("contents: none"), "attest stays contents: none");
  });

  test(`${file}: fork/event/freshness gates preserved`, () => {
    const source = readWorkflow(file);
    assert.ok(source.includes("head_repository"), "same-repository origin check must stay");
    assert.ok(source.includes("event == 'push'"), "push-event gate must stay");
    assert.ok(source.includes("Reject stale deployment"), "freshness gate must stay");
    assert.ok(source.includes("Deploy blocked: stale SHA"), "stale SHA must fail closed");
  });

  test(`${file}: no automatic dedupe-skip bypasses deploy`, () => {
    const deploy = deployRegion(readWorkflow(file));
    assert.ok(deploy.includes("needs: [gate]"), "deploy stays gate-driven");
    assert.ok(!deploy.toLowerCase().includes("dedupe"), "no unproven second-event skip");
  });

  test(`${file}: attest still requires this run's deploy+smoke (green alone is not a release)`, () => {
    const attest = attestRegion(readWorkflow(file));
    assert.ok(attest.includes("deploy-smoke-pass"), "ATTESTED only on deploy+smoke pass");
    assert.ok(attest.includes("NOT-ATTESTED"), "negative attestation preserved");
  });
}

test("agent-deploy.yml: manifest verified against the same installation via helper (T11a FATIA 1)", () => {
  const source = readWorkflow("agent-deploy.yml");
  assert.ok(source.includes("sha256sum pnpm-lock.yaml"), "local lockfile hash from the deploy checkout");
  assert.ok(
    source.includes("exec wrangler --version"),
    "local Wrangler from the same pnpm installation used by the deploy",
  );
  assert.ok(
    source.includes("node scripts/validate-deploy-manifest.mjs --manifest"),
    "verification must call the manifest helper",
  );
  assert.ok(source.includes("--lockfile-hash"), "helper receives the local lockfile hash");
  assert.ok(source.includes("--wrangler-version"), "helper receives the local Wrangler version");
  assert.ok(
    !source.includes("manifest missing lockfileHash"),
    "legacy inline presence-only check is replaced by the helper",
  );
});

test("ci.yml: agent manifest producer pins SHA, source, run, lockfile hash and Wrangler version", () => {
  const ci = readWorkflow("ci.yml");
  assert.ok(ci.includes("agent-deploy-manifest-${{ github.sha }}"), "manifest artifact pinned per SHA");
  assert.ok(ci.includes("sha256sum pnpm-lock.yaml"), "producer hashes the lockfile");
  assert.ok(ci.includes("wrangler --version"), "producer records the installing Wrangler");
  for (const field of ["sha:", "workflow:", "runId:", "lockfileHash:", "wranglerVersion:"]) {
    assert.ok(ci.includes(field), `producer must carry manifest field ${field}`);
  }
});

test("pwa-deploy.yml: deploys the SHA-pinned tested tarball without rebuild", () => {
  const source = readWorkflow("pwa-deploy.yml");
  assert.ok(
    source.includes("pwa-cloudflare-build-${{ steps.artifact-run.outputs.source }}-${{ github.event.workflow_run.head_sha }}"),
    "tested artifact resolved per deployed SHA",
  );
  assert.ok(source.includes("EXPECTED_SHA"), "build-info smoke pins the deployed SHA");
});
