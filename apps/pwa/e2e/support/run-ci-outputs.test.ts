// @vitest-environment node
/**
 * run-ci.sh per-gate outputs (behavioral, no browser, no DB).
 *
 * Contract: each of the 4 Playwright gates writes to its own
 * `--output=test-results/<project>` dir and its own
 * `PLAYWRIGHT_HTML_OUTPUT_DIR=test-results/report-<project>` dir, so a
 * later gate never overwrites an earlier gate's traces (the historical
 * single `test-results/` default clobbered pwa-runtime/push evidence under
 * the desktop run). The workflow uploads `apps/pwa/test-results/` whole,
 * so the per-gate subtrees ride the existing artifact untouched.
 *
 * Method: same as run-ci-failure.test.ts — the runner executes in a bash
 * where `pnpm` is an exported shell FUNCTION that logs every invocation
 * (args + observed PLAYWRIGHT_HTML_OUTPUT_DIR) and succeeds; the tests
 * assert on the observed invocations and the runner exit code. A second
 * mode fails the FIRST gate to pin fail-first-keeps-RESULT=1.
 */

import { describe, expect, it, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..", "..");
const CURRENT_RUNNER = path.join(REPO_ROOT, "apps", "pwa", "e2e", "run-ci.sh");
const GATE_FAILURE_CODE = 3;
const COLLECTOR_CAP = 256 * 1024;

const EXPECTED_PROJECTS = [
  "functional-mobile",
  "pwa-runtime",
  "push-runtime",
  "functional-desktop",
] as const;

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
      child = spawn(cmd, args, { env: { ...process.env, ...env }, windowsHide: true });
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

function outputOf(args: string): string {
  const m = /--output=([^\s]+)/.exec(args);
  return m ? m[1] : "";
}

function projectOf(args: string): string {
  const m = /--project=([^\s]+)/.exec(args);
  return m ? m[1] : "";
}

/**
 * Run the CURRENT runner with a fake pnpm.
 * mode "all-pass": every gate succeeds.
 * mode "fail-first-gate": the functional-mobile gate fails (exit 3), rest succeed.
 */
async function runRunner(
  bash: string,
  scriptPosixPath: string,
  callLogNative: string,
  mode: "all-pass" | "fail-first-gate",
): Promise<ProcResult & { calls: Call[] }> {
  const failFirst =
    mode === "fail-first-gate"
      ? `case "$*" in *--project=functional-mobile*) return ${GATE_FAILURE_CODE};; esac;`
      : "";
  const prelude = [
    `pnpm() { printf 'ARGS=%s | HTMLDIR=%s\\n' "$*" "\${PLAYWRIGHT_HTML_OUTPUT_DIR:-}" >> "$CALL_LOG"; case "$*" in *build:next:cloudflare*) return 0;; esac; ${failFirst} return 0; }`,
    "export -f pnpm",
    `exec bash "${scriptPosixPath}"`,
  ].join("\n");
  const result = await spawnAsync(bash, ["-c", prelude], { CALL_LOG: toPosix(callLogNative) }, 120000);
  return { ...result, calls: readCalls(callLogNative) };
}

describe("run-ci.sh per-gate outputs", () => {
  it(
    "all-pass: 4 gates invoke playwright with 4 unique --output + html dirs",
    { timeout: 150000 },
    async () => {
      const bash = resolveBash();
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "run-ci-outputs-"));
      tempDirs.push(tmp);
      const callLog = path.join(tmp, "calls.log");
      fs.writeFileSync(callLog, "");

      const result = await runRunner(bash, toPosix(CURRENT_RUNNER), callLog, "all-pass");

      expect(result.timedOut).toBe(false);
      expect(result.status).toBe(0);
      const gateCalls = result.calls.filter((c) => projectOf(c.args) !== "");
      expect(gateCalls.map((c) => projectOf(c.args)).sort()).toEqual([...EXPECTED_PROJECTS].sort());

      const outputs = gateCalls.map((c) => outputOf(c.args));
      expect(outputs.every((o) => o.length > 0)).toBe(true);
      expect(new Set(outputs).size).toBe(EXPECTED_PROJECTS.length);
      for (const c of gateCalls) {
        // Output lives under the uploaded test-results/ subtree and names
        // its own gate (no shared default dir, no cross-gate clobber).
        expect(outputOf(c.args)).toContain(projectOf(c.args));
        expect(outputOf(c.args).replace(/\\/g, "/")).toMatch(/(^|\/)test-results\//);
      }

      const htmlDirs = gateCalls.map((c) => c.htmlDir);
      expect(htmlDirs.every((h) => h.length > 0)).toBe(true);
      expect(new Set(htmlDirs).size).toBe(EXPECTED_PROJECTS.length);
    },
  );

  it(
    "fail-first-gate: first gate failure keeps RESULT=1 at exit",
    { timeout: 150000 },
    async () => {
      const bash = resolveBash();
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "run-ci-outputs-fail-"));
      tempDirs.push(tmp);
      const callLog = path.join(tmp, "calls.log");
      fs.writeFileSync(callLog, "");

      const result = await runRunner(bash, toPosix(CURRENT_RUNNER), callLog, "fail-first-gate");

      expect(result.timedOut).toBe(false);
      const gateCalls = result.calls.filter((c) => projectOf(c.args) !== "");
      expect(gateCalls.length).toBeGreaterThan(0);
      expect(projectOf(gateCalls[0]!.args)).toBe("functional-mobile");
      // The first failure is never masked by later gates: exit stays 1.
      expect(result.status).toBe(1);
    },
  );
});
