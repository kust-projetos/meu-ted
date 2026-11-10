import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const workflow = fs.readFileSync(".github/workflows/ci.yml", "utf8");
const pwaWorkflow = fs.readFileSync(".github/workflows/pwa-ci.yml", "utf8");

for (const job of [
  "changes:",
  "quality:",
  "functional:",
  "postgres-financial:",
  "docs-policies:",
  "agent-policy:",
  "workflows-gates:",
  "agent-manifest:",
  "api-image:",
  "release-manifest:",
  "gate:",
]) {
  test(`root CI declares ${job.slice(0, -1)} job`, () => {
    assert.match(workflow, new RegExp(`\\n  ${job}`));
  });
}

test("root CI keeps the required gate name and aggregates the new jobs", () => {
  assert.match(workflow, /name: Gate — all checks/);
  assert.match(workflow, /needs: \[changes, quality, functional/);
});

test("root CI runs lint, typecheck and build for backend workspaces", () => {
  for (const workspace of ["@pi-finance/llm-contracts", "meu-ted-api", "pi-finance-agent"]) {
    assert.match(workflow, new RegExp(`pnpm --filter ${workspace.replace(/[/@.]/g, "\\$&")} --fail-if-no-match lint`));
    assert.match(workflow, new RegExp(`pnpm --filter ${workspace.replace(/[/@.]/g, "\\$&")} --fail-if-no-match typecheck`));
  }
  for (const workspace of ["meu-ted-api", "pi-finance-agent"]) {
    assert.match(workflow, new RegExp(`pnpm --filter ${workspace.replace(/[/@.]/g, "\\$&")} --fail-if-no-match build`));
  }
});

test("root CI keeps financial integrity against disposable Postgres when the API changes", () => {
  assert.match(workflow, /if: needs\.changes\.outputs\.api == 'true'/);
  assert.match(workflow, /DATABASE_URL_TEST: postgres:\/\/test:test@localhost/);
  assert.match(workflow, /DB_TEST_MARKER:/);
  assert.match(workflow, /test:integration:all/);
  assert.match(workflow, /test:concurrency/);
  assert.match(workflow, /src\/scripts\/migrate\.ts --validate/);
});

test("root CI runs agent policies only when the agent area changes", () => {
  assert.match(workflow, /pnpm architecture:check/);
  assert.match(workflow, /pnpm capabilities:check/);
  assert.match(workflow, /pnpm write-policy:check/);
  assert.match(workflow, /needs\.changes\.outputs\.agent == 'true'/);
});

test("root CI keeps the lightweight commit-gate smoke on every PR", () => {
  assert.match(workflow, /pnpm test:skip-gate/);
  assert.match(workflow, /pnpm test:scripts/);
  assert.match(workflow, /pnpm public-safety --strict/);
});

test("root CI keeps deploy-artifact jobs on main only", () => {
  assert.match(workflow, /agent-deploy-manifest-\$\{\{ github\.sha \}\}/);
  assert.match(workflow, /sha256sum pnpm-lock\.yaml/);
  assert.match(workflow, /wrangler --version/);
  assert.match(workflow, /name: API — image digest to GHCR \(main only\)/);
  assert.match(workflow, /name: Release — consolidated manifest \(main only\)/);
  assert.match(workflow, /pwa-cloudflare-build-pwaci-/);
});

test("PWA CI owns the PWA build/test and keeps the required matrix name", () => {
  assert.equal((pwaWorkflow.match(/\n  quality:/g) ?? []).length, 1);
  assert.match(pwaWorkflow, /node-version: \[22\]/);
  assert.match(pwaWorkflow, /pnpm-version: \[10\]/);
  assert.match(pwaWorkflow, /pnpm boundary:check/);
  assert.match(pwaWorkflow, /pnpm --dir apps\/pwa typecheck/);
  assert.match(pwaWorkflow, /pwa-cloudflare-build-pwaci-\$\{\{ github\.sha \}\}/);
  assert.doesNotMatch(pwaWorkflow, /lhci autorun/);
  assert.doesNotMatch(pwaWorkflow, /scripts\/pwa-audit\.mjs/);
});

test("heavy PWA E2E is not on every pull request", () => {
  assert.match(pwaWorkflow, /run-full-e2e/);
  assert.match(pwaWorkflow, /github\.event_name == 'push' \|\| github\.event_name == 'workflow_dispatch'/);
});

test("CI is not duplicated between root and PWA workflows", () => {
  assert.doesNotMatch(workflow, /\n  pwa:/);
  assert.doesNotMatch(workflow, /\n  pwa-cloudflare:/);
  assert.doesNotMatch(workflow, /pnpm --filter pwa --fail-if-no-match/);
  assert.doesNotMatch(pwaWorkflow, /pnpm --filter meu-ted-api/);
});

test("deployment workflows gate on CI + PWA CI success and Node 22", () => {
  const pwaDeploy = fs.readFileSync(".github/workflows/pwa-deploy.yml", "utf8");
  const agentDeploy = fs.readFileSync(".github/workflows/agent-deploy.yml", "utf8");
  for (const deploy of [pwaDeploy, agentDeploy]) {
    assert.match(deploy, /workflow_run:/);
    assert.match(deploy, /workflows:\s*\["CI", "PWA CI"\]/);
    assert.match(deploy, /workflow_run\.conclusion == 'success'/);
    assert.match(deploy, /workflow_run\.head_sha/);
    assert.doesNotMatch(deploy, /workflow_dispatch:/);
    assert.match(deploy, /needs: \[gate\]/);
    assert.match(deploy, /listWorkflowRunsForRepo/);
    assert.match(deploy, /runs\.length === 0/);
    assert.match(deploy, /Deploy blocked: no /);
    assert.doesNotMatch(deploy, /\bcontinue;/);
  }
  assert.doesNotMatch(overallWorkflowNode(), /node-version: ['"]20['"]/);
});

function overallWorkflowNode() {
  return workflow + pwaWorkflow;
}

test("root CI contains no removed Bridge or Pi-extension job", () => {
  assert.doesNotMatch(workflow, /whatsapp-bridge|financial-tools|docker\/pi-stack|pi-finance-pi-stack/i);
});
