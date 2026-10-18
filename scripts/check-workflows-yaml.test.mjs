import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "check-workflows-yaml.mjs");

// Runs the gate as a child process against an isolated directory so the
// real .github/workflows tree is never touched by fixtures.
function runGate(dir) {
  try {
    const stdout = execFileSync(process.argv[0], [SCRIPT], {
      encoding: "utf8",
      env: { ...process.env, WORKFLOWS_YAML_DIR: dir },
    });
    return { exit: 0, output: stdout };
  } catch (err) {
    const out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
    return { exit: err.status ?? 1, output: out.length > 0 ? out : String(err.message ?? err) };
  }
}

const dirsToClean = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workflows-yaml-gate-"));
  dirsToClean.push(dir);
  return dir;
}

// Exact incident vector (8c6ef48): an unquoted step `name:` containing `: `
// breaks YAML parsing, so `Gate — all checks` never materializes.
const INCIDENT_STEP = "      - name: Contracts - lint (T13 GOV-06: shared contracts covered in CI)";

function workflowWithStep(stepLine) {
  return [
    "name: CI",
    "",
    "on:",
    "  push:",
    "    branches: [main]",
    "",
    "jobs:",
    "  api:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    stepLine,
    "        run: echo hi",
    "",
  ].join("\n");
}

test("workflows-yaml gate", async (t) => {
  // Fixture teardown: every temp dir registered by makeTempDir is removed
  // after the suite, regardless of pass/fail inside the subtests.
  t.after(() => {
    for (const dir of dirsToClean) fs.rmSync(dir, { recursive: true, force: true });
  });

  await t.test("fails on the unquoted incident vector (step name with ': ')", () => {
    const dir = makeTempDir();
    const fixture = "incident-vector.yml";
    fs.writeFileSync(path.join(dir, fixture), workflowWithStep(INCIDENT_STEP));
    const result = runGate(dir);
    assert.equal(result.exit, 1, `gate must exit 1 on the incident vector, got: ${result.output}`);
    assert.match(result.output, new RegExp(fixture), "failure must cite the offending file name");
    assert.match(result.output, /parse|YAML|yaml/i, "failure must indicate a YAML parse error");
  });

  await t.test("passes on a valid workflow with quoted names containing ': '", () => {
    const dir = makeTempDir();
    const quoted = '      - name: "Contracts - lint (T13 GOV-06: shared contracts covered in CI)"';
    fs.writeFileSync(path.join(dir, "valid.yml"), workflowWithStep(quoted));
    fs.writeFileSync(path.join(dir, "extra.yaml"), workflowWithStep(quoted));
    const result = runGate(dir);
    assert.equal(result.exit, 0, `gate must exit 0 on valid workflows, got: ${result.output}`);
    assert.match(result.output, /2 workflow file\(s\) parsed/, "success must report the parsed file count");
  });

  await t.test("fails closed on an empty workflow file", () => {
    const dir = makeTempDir();
    const fixture = "empty.yml";
    fs.writeFileSync(path.join(dir, fixture), "");
    const result = runGate(dir);
    assert.equal(result.exit, 1, `gate must exit 1 on an empty file, got: ${result.output}`);
    assert.match(result.output, new RegExp(fixture), "failure must cite the empty file name");
  });

  await t.test("fails closed on a missing workflows directory", () => {
    const dir = path.join(makeTempDir(), "does-not-exist");
    const result = runGate(dir);
    assert.equal(result.exit, 1, `gate must exit 1 on a missing dir, got: ${result.output}`);
    assert.match(result.output, new RegExp("does-not-exist"), "failure must cite the missing directory");
  });
});
