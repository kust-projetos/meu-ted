import assert from "node:assert/strict";
import test from "node:test";

import { classifyFiles, selectCommands } from "./check-changed-areas.mjs";

test("docs-only diff runs only documentation gates", () => {
  const areas = classifyFiles(["docs/reports/2026-11-07-simplificacao-gates.md"]);
  assert.equal(areas.docs, true);
  assert.equal(areas.api, false);
  assert.equal(areas["ted-runtime"], false);
  assert.deepEqual(selectCommands(areas), ["pnpm docs:lint"]);
});

test("ted-runtime diff runs the retained write-policy gate", () => {
  const areas = classifyFiles(["apps/ted-runtime/src/live-model.json"]);
  assert.equal(areas["ted-runtime"], true);
  assert.deepEqual(selectCommands(areas), ["pnpm write-policy:check"]);
});

test("retired apps/agent paths do not select a workspace gate", () => {
  const areas = classifyFiles(["apps/agent/src/finance-chat-agent.ts"]);
  assert.equal(areas["ted-runtime"], false);
  assert.deepEqual(selectCommands(areas), []);
});

test("workflow diff runs pin and YAML gates", () => {
  const areas = classifyFiles([".github/workflows/ci.yml"]);
  assert.equal(areas.workflows, true);
  assert.deepEqual(selectCommands(areas), ["pnpm action-pins:check", "pnpm workflows-yaml:check"]);
});

test("test-only diff runs the skip gate", () => {
  const areas = classifyFiles(["apps/api/tests/approvals/pending-v2-contract.test.ts"]);
  assert.equal(areas.tests, true);
  assert.equal(selectCommands(areas).includes("pnpm test:skip-gate"), true);
});

test("unrelated diff selects no gate", () => {
  const areas = classifyFiles(["apps/api/src/lib/dashboard.ts"]);
  assert.deepEqual(selectCommands(areas), []);
});

test("API route and PWA write-surface changes select the write-policy gate", () => {
  for (const file of ["apps/api/src/routes/accounts.ts", "apps/pwa/src/lib/state/commands.ts", "docs/architecture/write-mutator-policy.md"]) {
    assert.ok(selectCommands(classifyFiles([file])).includes("pnpm write-policy:check"), file);
  }
});
