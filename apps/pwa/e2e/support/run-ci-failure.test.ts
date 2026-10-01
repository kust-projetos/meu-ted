// @vitest-environment node
/**
 * run-ci.sh failure propagation (behavioral, no browser, no DB).
 *
 * Historical bug (main@096c4e6): `trap cleanup EXIT INT TERM` with
 * `exit "$RESULT"` (RESULT still 0 when `set -e` aborts on a failed build)
 * masked build failures as exit 0. The current runner has no trap and lets
 * the build's exit code propagate.
 *
 * Method: the runner executes in a bash where `pnpm` is a shell FUNCTION
 * (exported via `export -f`, so it shadows any PATH lookup on every
 * platform with zero PATH games) that fails the build with exit 42 and
 * logs every invocation; `curl` is stubbed healthy so the historical
 * pre-start path reaches its build step deterministically. The test asserts
 * the runner's exit code and that Playwright was never invoked.
 *
 * No git-history dependency: an earlier revision of this file proved the
 * 096c4e6 trap-masking against real `git show` output; that proof is
 * collected and this permanent test only pins the current contract, so it
 * also passes on shallow CI checkouts.
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
const BUILD_FAILURE_CODE = 42;
const COLLECTOR_CAP = 256 * 1024;

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

function readCalls(callLog: string): string[] {
  if (!fs.existsSync(callLog)) return [];
  return fs
    .readFileSync(callLog, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

async function runRunner(
  bash: string,
  scriptPosixPath: string,
  callLogNative: string,
): Promise<ProcResult & { calls: string[] }> {
  const prelude = [
    `pnpm() { printf '%s\\n' "$*" >> "$CALL_LOG"; case "$*" in *build:next:cloudflare*) return ${BUILD_FAILURE_CODE};; *) return 0;; esac; }`,
    "curl() { return 0; }",
    "export -f pnpm curl",
    `exec bash "${scriptPosixPath}"`,
  ].join("\n");
  const result = await spawnAsync(
    bash,
    ["-c", prelude],
    { CALL_LOG: toPosix(callLogNative) },
    60000,
  );
  return { ...result, calls: readCalls(callLogNative) };
}

describe("run-ci.sh failure propagation", () => {
  it(
    "current runner propagates the build failure (exit 42) with zero playwright calls",
    { timeout: 90000 },
    async () => {
      const bash = resolveBash();
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "run-ci-current-"));
      tempDirs.push(tmp);
      const callLog = path.join(tmp, "calls.log");
      fs.writeFileSync(callLog, "");

      const result = await runRunner(bash, toPosix(CURRENT_RUNNER), callLog);

      expect(result.timedOut).toBe(false);
      // Build dependency first: the very first pnpm call is the Next build —
      // no E2E gate runs without a successful build.
      expect(result.calls.length).toBeGreaterThan(0);
      expect(result.calls[0]).toContain("build:next:cloudflare");
      expect(result.calls.filter((c) => /(^|\s)playwright(\s|$)/.test(c))).toEqual([]);
      expect(result.status).toBe(BUILD_FAILURE_CODE);
    },
  );
});
