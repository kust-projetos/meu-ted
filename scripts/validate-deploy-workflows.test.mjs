import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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
