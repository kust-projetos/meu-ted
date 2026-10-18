/**
 * run-ci.sh E2E_RUNTIME_REPEAT_EACH wiring (behavioral, no browser, no DB).
 *
 * Contract: the runner validates E2E_RUNTIME_REPEAT_EACH fail-closed BEFORE
 * the Next build, mirroring `parseRepeatEachEnv` in repeat-each.ts —
 * unset/""/0/1 = single run (no flag); integer 2..9007199254740991 (JS safe
 * integer max) = `--repeat-each=N` ONLY on the pwa-runtime + push-runtime
 * gates; anything else (non-numeric, or beyond the safe-integer ceiling such
 * as the int64-overflow 9223372036854775808) = exit 2 with zero pnpm calls.
 *
 * Method: same fake-pnpm technique as run-ci-outputs.test.ts — the runner
 * executes in a bash where `pnpm` is an exported shell FUNCTION logging every
 * invocation; each mode asserts the runner exit code, the observed pnpm
 * calls, and (for the flag modes) which gates carry `--repeat-each=N`.
 *
 * Run: pnpm exec tsx --test e2e/support/run-ci-repeat-each.test.ts
 * (also picked up by `vitest run` via the workspace `pnpm test`).
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..", "..");
const CURRENT_RUNNER = path.join(REPO_ROOT, "apps", "pwa", "e2e", "run-ci.sh");
const COLLECTOR_CAP = 256 * 1024;
const SAFE_INT_MAX = "9007199254740991";
const INT64_OVERFLOW = "9223372036854775808";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function resolveBash(): string {
  if (process.platform === "win32") {
    const gitBash = "C:\\Program Files\\Git\\bin\\bash.exe";
    if (fs.existsSync(gitBash)) return gitBash;
  }
  return "bash";
}

/** C:\a\b → /c/a/b for MSYS bash; POSIX paths pass through. */
function toPosix(p: string): string {
  if (process.platform !== "win32") return p;
  const m = /^([A-Za-z]):[\\/]/.exec(p);
  if (!m) return p.replace(/\\/g, "/");
  return `/${m[1].toLowerCase()}${p.slice(2).replace(/\\/g, "/")}`;
}

function appendBounded(current: string, chunk: string): string {
  if (current.length >= COLLECTOR_CAP) return current;
  return current + chunk.slice(0, COLLECTOR_CAP - current.length);
}

type ProcResult = { status: number | null; stdout: string; stderr: string; timedOut: boolean };

function spawnAsync(
  cmd: string,
  args: string[],
  env: Record<string, string>,
  timeoutMs: number,
): Promise<ProcResult> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      const childEnv: Record<string, string | undefined> = { ...process.env, ...env };
      if (!("E2E_RUNTIME_REPEAT_EACH" in env)) delete childEnv.E2E_RUNTIME_REPEAT_EACH;
      child = spawn(cmd, args, { env: childEnv as Record<string, string>, windowsHide: true });
    } catch (err) {
      resolve({ status: null, stdout: "", stderr: String(err), timedOut: false });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (r: ProcResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      finish({ status: null, stdout, stderr, timedOut: true });
    }, timeoutMs);
    child.stdout?.on("data", (d) => {
      stdout = appendBounded(stdout, d.toString("utf8"));
    });
    child.stderr?.on("data", (d) => {
      stderr = appendBounded(stderr, d.toString("utf8"));
    });
    child.on("error", (err) => {
      finish({ status: null, stdout, stderr: stderr + String(err), timedOut: false });
    });
    child.on("close", (code) => {
      finish({ status: code, stdout, stderr, timedOut: false });
    });
  });
}

type Call = { args: string; htmlDir: string };

function readCalls(callLog: string): Call[] {
  if (!fs.existsSync(callLog)) return [];
  return fs
    .readFileSync(callLog, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => {
      const m = /^ARGS=(.*) \| HTMLDIR=(.*)$/.exec(l);
      return m ? { args: m[1], htmlDir: m[2] } : { args: l, htmlDir: "" };
    });
}

function projectOf(args: string): string {
  const m = /--project=([^\s]+)/.exec(args);
  return m ? m[1] : "";
}

/**
 * Run the CURRENT runner with a fake pnpm. `repeatEach === undefined` unsets
 * E2E_RUNTIME_REPEAT_EACH (even if the ambient environment defines it).
 */
async function runRunner(
  bash: string,
  scriptPosixPath: string,
  callLogNative: string,
  repeatEach: string | undefined,
): Promise<ProcResult & { calls: Call[] }> {
  const prelude = [
    `pnpm() { printf 'ARGS=%s | HTMLDIR=%s\\n' "$*" "\${PLAYWRIGHT_HTML_OUTPUT_DIR:-}" >> "$CALL_LOG"; case "$*" in *build:next:cloudflare*) return 0;; esac; return 0; }`,
    "export -f pnpm",
    `exec bash "${scriptPosixPath}"`,
  ].join("\n");
  const extraEnv: Record<string, string> = { CALL_LOG: toPosix(callLogNative) };
  if (repeatEach !== undefined) extraEnv.E2E_RUNTIME_REPEAT_EACH = repeatEach;
  const result = await spawnAsync(bash, ["-c", prelude], extraEnv, 120000);
  return { ...result, calls: readCalls(callLogNative) };
}

async function runMode(repeatEach: string | undefined) {
  const bash = resolveBash();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "run-ci-repeat-"));
  tempDirs.push(tmp);
  const callLog = path.join(tmp, "calls.log");
  fs.writeFileSync(callLog, "");
  return runRunner(bash, toPosix(CURRENT_RUNNER), callLog, repeatEach);
}

function gateCallsOf(result: { calls: Call[] }): Call[] {
  return result.calls.filter((c) => projectOf(c.args) !== "");
}

describe("run-ci.sh E2E_RUNTIME_REPEAT_EACH wiring", () => {
  it("unset: single run, no --repeat-each flag, exit 0", { timeout: 150000 }, async () => {
    const result = await runMode(undefined);
    assert.equal(result.timedOut, false);
    assert.equal(result.status, 0);
    assert.ok(result.calls.length > 0, "expected the fake pnpm to be invoked");
    for (const c of gateCallsOf(result)) {
      assert.ok(!c.args.includes("--repeat-each"), `unexpected flag in: ${c.args}`);
    }
  });

  it("=3: --repeat-each=3 only on the two runtime gates, exit 0", { timeout: 150000 }, async () => {
    const result = await runMode("3");
    assert.equal(result.timedOut, false);
    assert.equal(result.status, 0);
    const gates = gateCallsOf(result);
    assert.ok(gates.length > 0, "expected Playwright gate invocations");
    for (const c of gates) {
      const project = projectOf(c.args);
      if (project === "pwa-runtime" || project === "push-runtime") {
        assert.ok(c.args.includes("--repeat-each=3"), `missing flag in ${project}: ${c.args}`);
      } else {
        assert.ok(!c.args.includes("--repeat-each"), `leaked flag into ${project}: ${c.args}`);
      }
    }
  });

  it("=x: exit 2 with zero pnpm calls (fail-closed before the build)", { timeout: 150000 }, async () => {
    const result = await runMode("x");
    assert.equal(result.timedOut, false);
    assert.equal(result.status, 2);
    assert.deepEqual(result.calls, [], "invalid input must abort before any pnpm invocation");
    assert.match(result.stderr, /invalid E2E_RUNTIME_REPEAT_EACH/);
    assert.ok(!result.stdout.includes("building Next.js"), "must abort before the build");
  });

  it("=1: single run, no --repeat-each flag, exit 0", { timeout: 150000 }, async () => {
    const result = await runMode("1");
    assert.equal(result.timedOut, false);
    assert.equal(result.status, 0);
    assert.ok(result.calls.length > 0, "expected the fake pnpm to be invoked");
    for (const c of gateCallsOf(result)) {
      assert.ok(!c.args.includes("--repeat-each"), `unexpected flag in: ${c.args}`);
    }
  });

  it(
    "int64 overflow: exit 2 with zero pnpm calls (fail-closed, never silent single run)",
    { timeout: 150000 },
    async () => {
      const result = await runMode(INT64_OVERFLOW);
      assert.equal(result.timedOut, false);
      assert.equal(result.status, 2);
      assert.deepEqual(result.calls, [], "overflow must abort before any pnpm invocation");
      assert.match(result.stderr, /invalid E2E_RUNTIME_REPEAT_EACH/);
      assert.ok(!result.stdout.includes("building Next.js"), "must abort before the build");
    },
  );

  it(
    `safe-integer ceiling (${SAFE_INT_MAX}): exit 0 with the flag on the two runtime gates`,
    { timeout: 150000 },
    async () => {
      const result = await runMode(SAFE_INT_MAX);
      assert.equal(result.timedOut, false);
      assert.equal(result.status, 0);
      const gates = gateCallsOf(result);
      assert.ok(gates.length > 0, "expected Playwright gate invocations");
      for (const c of gates) {
        const project = projectOf(c.args);
        if (project === "pwa-runtime" || project === "push-runtime") {
          assert.ok(
            c.args.includes(`--repeat-each=${SAFE_INT_MAX}`),
            `missing flag in ${project}: ${c.args}`,
          );
        } else {
          assert.ok(!c.args.includes("--repeat-each"), `leaked flag into ${project}: ${c.args}`);
        }
      }
    },
  );
});
